import { createHash } from "node:crypto";
import {
  type DbConfig,
  type TableFingerprint,
  fingerprintDatabase,
  poolFor,
} from "./db.js";
import { analyzeOperation } from "./analyze.js";
import { type SimulationResult, getSimulation, refusalReason } from "./simulate.js";

/** sha256 hex of a string — used to redact SQL bodies in audit events. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Code-level grade-F gate (S5). The rollback gate in `refusalReason` is
 * unbypassable by prompting; this makes the grade-F refusal symmetric. A bare
 * `DELETE FROM payment` with a working backup/restore rollback verifies fine,
 * so without this gate only skill text stood between a jailbroken model and
 * wiping a table. Callers must pass an explicit `override_grade_f: true` to
 * proceed; the override is recorded in the audit log.
 */
export async function gradeRefusal(
  cfg: DbConfig,
  sim: SimulationResult,
  overrideGradeF: boolean,
): Promise<{ grade: string; refusal: string | null }> {
  const report = await analyzeOperation(cfg, sim.operation);
  if (report.grade === "F" && !overrideGradeF) {
    return {
      grade: report.grade,
      refusal:
        `REFUSED: static risk analysis graded this operation F (highest risk). ` +
        `Risk factors: ${report.riskFactors.join("; ")}. ` +
        `Narrow the operation with a WHERE clause, or re-invoke with override_grade_f: true to accept the risk explicitly.`,
    };
  }
  return { grade: report.grade, refusal: null };
}

/**
 * Tables the drift gate compares. Excludes tables the operation itself creates
 * (backup tables), which have an "absent" baseline and legitimately do not
 * exist in production yet.
 */
export function driftCheckedTables(sim: SimulationResult): string[] {
  return sim.impact.filter((i) => i.before.checksum !== "absent").map((i) => i.table);
}

/**
 * Drift gate (S6). The verified rollback was proven against a clone taken at
 * simulation time. If any table the simulation actually impacted has changed in
 * production since, that proof no longer describes the database being written
 * to. Compares only the impacted tables — unrelated write traffic elsewhere in
 * the database must not block an approved operation.
 */
export function driftRefusal(
  sim: SimulationResult,
  productionNow: TableFingerprint[],
): string | null {
  const now = new Map(productionNow.map((f) => [f.table, f]));
  const drifted: string[] = [];
  for (const impacted of sim.impact) {
    // Tables the operation itself creates (e.g. a backup table) show up in the
    // impact list with an "absent" baseline. They do not exist in production
    // yet by design, so their absence is not drift.
    if (impacted.before.checksum === "absent") continue;
    const current = now.get(impacted.table);
    if (!current) {
      drifted.push(`${impacted.table} (missing in production)`);
      continue;
    }
    if (current.checksum !== impacted.before.checksum) {
      drifted.push(
        `${impacted.table} (${impacted.before.rowCount} rows at simulation, ${current.rowCount} now)`,
      );
    }
  }
  if (drifted.length === 0) return null;
  return (
    `REFUSED: production drifted since simulation ${sim.simulationId}, re-simulate. ` +
    `Changed since the simulation baseline: ${drifted.join(", ")}.`
  );
}

export interface ExecuteOutcome {
  refusal?: string;
  /** Grade from the static analyzer, present whenever the analyzer ran. */
  grade?: string;
  /** True when the grade-F gate was explicitly overridden by the caller. */
  gradeFOverridden?: boolean;
  payload?: {
    executed: true;
    database: string;
    simulationId: string;
    grade: string;
    gradeFOverridden: boolean;
    driftChecked: string[];
    tablesChanged: string[];
    rollbackSha256: string;
    rollbackLength: number;
  };
}

/**
 * The only path that writes to production. Three code-level gates, in order:
 * 1. simulation exists, operation succeeded, rollback verified (`refusalReason`)
 * 2. static risk grade is not F unless explicitly overridden (`gradeRefusal`)
 * 3. impacted tables still match the simulation baseline (`driftRefusal`)
 */
export async function executeApprovedOperation(
  cfg: DbConfig,
  simulationId: string,
  opts: { overrideGradeF?: boolean } = {},
): Promise<ExecuteOutcome> {
  const sim = getSimulation(simulationId);
  const gateRefusal = refusalReason(sim, simulationId);
  if (gateRefusal) return { refusal: gateRefusal };

  const overrideGradeF = opts.overrideGradeF === true;
  const { grade, refusal: gradeF } = await gradeRefusal(cfg, sim!, overrideGradeF);
  if (gradeF) return { refusal: gradeF, grade };

  const before = await fingerprintDatabase(cfg, cfg.productionDb);
  const drift = driftRefusal(sim!, before);
  if (drift) return { refusal: drift, grade };

  const pool = poolFor(cfg, cfg.productionDb);
  await pool.query(sim!.operation);
  const after = await fingerprintDatabase(cfg, cfg.productionDb);
  const changed = after.filter(
    (a) => before.find((b) => b.table === a.table)?.checksum !== a.checksum,
  );

  return {
    grade,
    gradeFOverridden: overrideGradeF && grade === "F",
    payload: {
      executed: true,
      database: cfg.productionDb,
      simulationId,
      grade,
      gradeFOverridden: overrideGradeF && grade === "F",
      driftChecked: driftCheckedTables(sim!),
      tablesChanged: changed.map((c) => c.table),
      // Redact full rollback SQL — expose sha256 + length only
      rollbackSha256: sha256(sim!.rollback),
      rollbackLength: sim!.rollback.length,
    },
  };
}
