import { randomUUID } from "node:crypto";
import {
  type DbConfig,
  type FingerprintDiff,
  closePool,
  diffFingerprints,
  fingerprintDatabase,
  poolFor,
  quoteIdent,
} from "./db.js";

export interface ExplainNode {
  /** Zero-based index of this statement in the operation SQL. */
  statementIndex: number;
  /** First 80 characters of the source SQL for this statement. */
  sqlSnippet: string;
  /** Estimated total cost from EXPLAIN (FORMAT JSON). Absent on error. */
  totalCost?: number;
  /** Raw top-level Plan node from Postgres EXPLAIN JSON. Absent on error. */
  plan?: unknown;
  /** Set when EXPLAIN could not be run for this statement (e.g. DDL). */
  explainError?: string;
}

export interface SimulationResult {
  simulationId: string;
  cloneDb: string;
  operation: string;
  rollback: string;
  operationOk: boolean;
  operationError?: string;
  impact: FingerprintDiff[];
  totalRowsDeleted: number;
  totalRowsAdded: number;
  tablesChanged: number;
  rollbackOk: boolean;
  rollbackError?: string;
  /** True only when rollback restored every table checksum to pre-operation state. */
  rollbackVerified: boolean;
  rollbackResidue: FingerprintDiff[];
  /** Wall-clock milliseconds the operation took in the clone (0 if it errored). */
  operationDurationMs: number;
  /** Wall-clock milliseconds the rollback took in the clone (0 if not run or errored). */
  rollbackDurationMs: number;
  /** EXPLAIN (FORMAT JSON) cost estimates for each statement in the operation, captured before execution. */
  explainCosts: ExplainNode[];
}

const simulations = new Map<string, SimulationResult>();

export function getSimulation(id: string): SimulationResult | undefined {
  return simulations.get(id);
}

/**
 * The production execution gate. Returns a refusal reason, or null when the
 * simulation proves the operation is safe to execute (operation succeeded in
 * the clone AND the rollback was verified to restore row content).
 * This is the security boundary: prompts cannot bypass it.
 */
export function refusalReason(sim: SimulationResult | undefined, id: string): string | null {
  if (!sim) {
    return `REFUSED: no simulation with id ${id}. Run simulate_operation first.`;
  }
  if (!sim.operationOk) {
    return `REFUSED: operation failed in sandbox: ${sim.operationError}`;
  }
  if (!sim.rollbackVerified) {
    return `REFUSED: rollback was NOT verified in the sandbox. Residue: ${JSON.stringify(sim.rollbackResidue)}. Fix the rollback and re-simulate.`;
  }
  return null;
}

/**
 * Run EXPLAIN (FORMAT JSON) for each semicolon-separated statement in the SQL.
 * Skips statements that EXPLAIN cannot handle (DDL that creates objects, etc.)
 * without throwing. Read-only transaction.
 */
async function captureExplainCosts(
  cfg: DbConfig,
  cloneDb: string,
  sql: string,
): Promise<ExplainNode[]> {
  const clone = poolFor(cfg, cloneDb);
  const results: ExplainNode[] = [];

  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let statementIndex = 0; statementIndex < stmts.length; statementIndex++) {
    const stmt = stmts[statementIndex];
    const sqlSnippet = stmt.slice(0, 80);
    // Each EXPLAIN runs in its own short-lived transaction so BEGIN is always
    // available and a DDL failure doesn't taint subsequent statements.
    const client = await clone.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${stmt}`);
      await client.query("ROLLBACK");
      const plan = (res.rows[0] as { "QUERY PLAN": unknown[] })["QUERY PLAN"];
      const planNode = Array.isArray(plan) ? (plan[0] as Record<string, unknown>) : {};
      const innerPlan = (planNode["Plan"] as Record<string, unknown> | undefined) ?? {};
      const totalCost = Number(innerPlan["Total Cost"] ?? 0);
      results.push({ statementIndex, sqlSnippet, totalCost, plan: planNode });
    } catch (err) {
      // EXPLAIN failed (e.g. DDL CREATE TABLE) — record the error, don't drop
      await client.query("ROLLBACK").catch(() => {});
      results.push({ statementIndex, sqlSnippet, explainError: String(err) });
    } finally {
      client.release();
    }
  }

  return results;
}

/**
 * Clone the production database (CREATE DATABASE ... TEMPLATE), execute the
 * destructive operation inside the clone, measure real impact, then execute
 * the proposed rollback in the same clone and verify it restores every table
 * checksum. Nothing here touches the production database.
 */
export async function simulateOperation(
  cfg: DbConfig,
  operation: string,
  rollback: string,
): Promise<SimulationResult> {
  const simulationId = randomUUID().slice(0, 8);
  const cloneDb = `saferun_sim_${simulationId}`;

  // Template clone requires no active connections on the template.
  await closePool(cfg.productionDb);
  const admin = poolFor(cfg, "postgres");
  await admin.query(
    `CREATE DATABASE ${quoteIdent(cloneDb)} TEMPLATE ${quoteIdent(cfg.productionDb)}`,
  );

  const result: SimulationResult = {
    simulationId,
    cloneDb,
    operation,
    rollback,
    operationOk: false,
    impact: [],
    totalRowsDeleted: 0,
    totalRowsAdded: 0,
    tablesChanged: 0,
    rollbackOk: false,
    rollbackVerified: false,
    rollbackResidue: [],
    operationDurationMs: 0,
    rollbackDurationMs: 0,
    explainCosts: [],
  };

  try {
    // Capture EXPLAIN costs before running the operation
    result.explainCosts = await captureExplainCosts(cfg, cloneDb, operation);

    const before = await fingerprintDatabase(cfg, cloneDb);
    const clone = poolFor(cfg, cloneDb);

    const opStart = Date.now();
    try {
      await clone.query(operation);
      result.operationOk = true;
    } catch (err) {
      result.operationError = String(err);
    }
    result.operationDurationMs = Date.now() - opStart;

    if (result.operationOk) {
      const afterOp = await fingerprintDatabase(cfg, cloneDb);
      result.impact = diffFingerprints(before, afterOp).filter((d) => d.changed);
      result.totalRowsDeleted = result.impact
        .filter((d) => d.rowDelta < 0)
        .reduce((s, d) => s - d.rowDelta, 0);
      result.totalRowsAdded = result.impact
        .filter((d) => d.rowDelta > 0)
        .reduce((s, d) => s + d.rowDelta, 0);
      result.tablesChanged = result.impact.length;

      const rbStart = Date.now();
      try {
        await clone.query(rollback);
        result.rollbackOk = true;
      } catch (err) {
        result.rollbackError = String(err);
      }
      result.rollbackDurationMs = Date.now() - rbStart;

      if (result.rollbackOk) {
        const afterRollback = await fingerprintDatabase(cfg, cloneDb);
        result.rollbackResidue = diffFingerprints(before, afterRollback).filter(
          (d) => d.changed,
        );
        result.rollbackVerified = result.rollbackResidue.length === 0;
      }
    }
  } finally {
    await closePool(cloneDb);
    // Terminate any remaining connections (e.g. from a failed EXPLAIN) so the
    // DROP DATABASE doesn't get "other sessions are using the database".
    await admin
      .query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [cloneDb],
      )
      .catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(cloneDb)}`).catch(() => {
      /* clone cleanup is best-effort; leftover clones are harmless */
    });
  }

  simulations.set(simulationId, result);
  return result;
}
