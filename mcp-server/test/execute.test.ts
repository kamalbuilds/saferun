import assert from "node:assert/strict";
import { test } from "node:test";
import { closePool, fingerprintDatabase, loadConfig, poolFor, quoteIdent } from "../src/db.js";
import { simulateOperation } from "../src/simulate.js";
import {
  driftCheckedTables,
  driftRefusal,
  executeApprovedOperation,
} from "../src/execute.js";

// executeApprovedOperation is the only path that writes to production, so these
// tests point `productionDb` at a scratch database they create themselves. The
// real Pagila dataset is never mutated.

const base = loadConfig();
const EXEC_DB = "saferun_exec_test";
const cfg = { ...base, productionDb: EXEC_DB };

async function resetExecDb(): Promise<void> {
  const admin = poolFor(base, "postgres");
  await closePool(EXEC_DB);
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [EXEC_DB],
    )
    .catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(EXEC_DB)}`);
  await admin.query(`CREATE DATABASE ${quoteIdent(EXEC_DB)}`);
  const pool = poolFor(cfg, EXEC_DB);
  await pool.query(`CREATE TABLE widget (id int primary key, label text)`);
  await pool.query(
    `INSERT INTO widget SELECT g, 'w' || g FROM generate_series(1, 20) g`,
  );
}

const BACKUP_DELETE_ALL = `CREATE TABLE widget_bak AS SELECT * FROM widget;
   DELETE FROM widget;`;
const RESTORE_ALL = `INSERT INTO widget SELECT * FROM widget_bak;
   DROP TABLE widget_bak;`;

const BACKUP_DELETE_NARROW = `CREATE TABLE widget_bak AS SELECT * FROM widget WHERE id <= 5;
   DELETE FROM widget WHERE id <= 5;`;
const RESTORE_NARROW = `INSERT INTO widget SELECT * FROM widget_bak;
   DROP TABLE widget_bak;`;

test("S5: grade-F operation is refused at code level even with a verified rollback", async () => {
  await resetExecDb();
  const sim = await simulateOperation(cfg, BACKUP_DELETE_ALL, RESTORE_ALL);
  assert.equal(sim.operationOk, true, sim.operationError);
  assert.equal(sim.rollbackVerified, true, JSON.stringify(sim.rollbackResidue));

  const outcome = await executeApprovedOperation(cfg, sim.simulationId);
  assert.equal(outcome.grade, "F");
  assert.match(outcome.refusal ?? "", /REFUSED: static risk analysis graded this operation F/);
  assert.equal(outcome.payload, undefined);

  // production must be untouched by a refusal
  const fps = await fingerprintDatabase(cfg, EXEC_DB);
  assert.equal(fps.find((f) => f.table === "public.widget")?.rowCount, 20);
});

test("S5: explicit override_grade_f executes and records the override", async () => {
  await resetExecDb();
  const sim = await simulateOperation(cfg, BACKUP_DELETE_ALL, RESTORE_ALL);
  const outcome = await executeApprovedOperation(cfg, sim.simulationId, {
    overrideGradeF: true,
  });
  assert.equal(outcome.refusal, undefined);
  assert.equal(outcome.payload?.grade, "F");
  assert.equal(outcome.payload?.gradeFOverridden, true);

  const fps = await fingerprintDatabase(cfg, EXEC_DB);
  assert.equal(fps.find((f) => f.table === "public.widget")?.rowCount, 0);
});

test("S6: production drift in an impacted table refuses execution", async () => {
  await resetExecDb();
  const sim = await simulateOperation(cfg, BACKUP_DELETE_NARROW, RESTORE_NARROW);
  assert.equal(sim.rollbackVerified, true, JSON.stringify(sim.rollbackResidue));
  assert.ok(
    sim.impact.some((i) => i.table === "public.widget"),
    "widget must be an impacted table",
  );

  // someone else writes to the impacted table between simulate and execute
  await poolFor(cfg, EXEC_DB).query(`UPDATE widget SET label = 'drifted' WHERE id = 19`);

  const outcome = await executeApprovedOperation(cfg, sim.simulationId);
  assert.match(
    outcome.refusal ?? "",
    new RegExp(`REFUSED: production drifted since simulation ${sim.simulationId}, re-simulate`),
  );

  // refusal must not delete anything
  const fps = await fingerprintDatabase(cfg, EXEC_DB);
  assert.equal(fps.find((f) => f.table === "public.widget")?.rowCount, 20);
});

test("S6: untouched production executes normally through both new gates", async () => {
  await resetExecDb();
  const sim = await simulateOperation(cfg, BACKUP_DELETE_NARROW, RESTORE_NARROW);
  const outcome = await executeApprovedOperation(cfg, sim.simulationId);
  assert.equal(outcome.refusal, undefined, outcome.refusal);
  assert.equal(outcome.payload?.executed, true);
  assert.equal(outcome.payload?.gradeFOverridden, false);
  assert.deepEqual(outcome.payload?.driftChecked, ["public.widget"]);
  assert.match(outcome.payload?.rollbackSha256 ?? "", /^[0-9a-f]{64}$/);

  const fps = await fingerprintDatabase(cfg, EXEC_DB);
  assert.equal(fps.find((f) => f.table === "public.widget")?.rowCount, 15);
});

test("S6: drift check ignores tables the simulation never impacted", () => {
  const sim = {
    simulationId: "abc123",
    impact: [
      {
        table: "public.widget",
        before: { rowCount: 20, checksum: "aaa" },
        after: { rowCount: 15, checksum: "bbb" },
        rowDelta: -5,
        changed: true,
      },
      // a backup table the operation creates: absent baseline, must be skipped
      {
        table: "public.widget_bak",
        before: { rowCount: 0, checksum: "absent" },
        after: { rowCount: 5, checksum: "ccc" },
        rowDelta: 5,
        changed: true,
      },
    ],
  } as never as Parameters<typeof driftRefusal>[0];

  const unrelatedChanged = [
    { table: "public.widget", rowCount: 20, checksum: "aaa" },
    { table: "public.other", rowCount: 99, checksum: "changed-since" },
  ];
  assert.equal(driftRefusal(sim, unrelatedChanged), null);
  assert.deepEqual(driftCheckedTables(sim), ["public.widget"]);

  // the created-table exemption must not swallow a real impacted-table change
  const impactedChanged = [
    { table: "public.widget", rowCount: 21, checksum: "zzz" },
  ];
  assert.match(driftRefusal(sim, impactedChanged) ?? "", /production drifted since simulation abc123/);
  assert.match(driftRefusal(sim, []) ?? "", /public\.widget \(missing in production\)/);
  assert.doesNotMatch(driftRefusal(sim, []) ?? "", /widget_bak/);
});

test.after(async () => {
  await closePool(EXEC_DB);
  const admin = poolFor(base, "postgres");
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [EXEC_DB],
    )
    .catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(EXEC_DB)}`).catch(() => {});
  await closePool("postgres");
  await closePool(base.productionDb);
});
