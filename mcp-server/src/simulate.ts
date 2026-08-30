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
  };

  try {
    const before = await fingerprintDatabase(cfg, cloneDb);
    const clone = poolFor(cfg, cloneDb);

    try {
      await clone.query(operation);
      result.operationOk = true;
    } catch (err) {
      result.operationError = String(err);
    }

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

      try {
        await clone.query(rollback);
        result.rollbackOk = true;
      } catch (err) {
        result.rollbackError = String(err);
      }

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
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(cloneDb)}`).catch(() => {
      /* clone cleanup is best-effort; leftover clones are harmless */
    });
  }

  simulations.set(simulationId, result);
  return result;
}
