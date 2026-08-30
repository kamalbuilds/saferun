import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffFingerprints,
  fingerprintDatabase,
  loadConfig,
  poolFor,
  quoteIdent,
} from "../src/db.js";
import { getSimulation, simulateOperation } from "../src/simulate.js";

// These tests run against the real local Postgres + Pagila dataset.
// They never write to the production database: simulation happens in clones.

const cfg = loadConfig();

test("fingerprintDatabase returns every user table with counts and checksums", async () => {
  const fps = await fingerprintDatabase(cfg, cfg.productionDb);
  assert.ok(fps.length >= 10, `expected >=10 tables, got ${fps.length}`);
  const payment = fps.find((f) => f.table === "public.payment");
  assert.ok(payment, "public.payment missing");
  assert.ok(payment.rowCount > 0, "payment table must not be empty");
  assert.match(payment.checksum, /^[0-9a-f]{32}$/);
});

test("diffFingerprints flags dropped and added tables", () => {
  const before = [
    { table: "a", rowCount: 5, checksum: "x" },
    { table: "b", rowCount: 2, checksum: "y" },
  ];
  const after = [
    { table: "a", rowCount: 3, checksum: "z" },
    { table: "c", rowCount: 1, checksum: "w" },
  ];
  const diff = diffFingerprints(before, after);
  const a = diff.find((d) => d.table === "a");
  const b = diff.find((d) => d.table === "b");
  const c = diff.find((d) => d.table === "c");
  assert.equal(a?.rowDelta, -2);
  assert.equal(b?.after.checksum, "dropped");
  assert.equal(c?.before.checksum, "absent");
});

test("quoteIdent escapes embedded quotes", () => {
  assert.equal(quoteIdent(`we"ird`), `"we""ird"`);
});

test("simulation with a broken rollback is NOT verified and execution is refused", async () => {
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM film_actor WHERE actor_id <= 5;",
    "SELECT 1;", // does not restore anything
  );
  assert.equal(sim.operationOk, true, sim.operationError);
  assert.ok(sim.totalRowsDeleted >= 5);
  assert.equal(sim.rollbackVerified, false);
  assert.ok(sim.rollbackResidue.length > 0, "residue must name the damaged table");
  assert.ok(getSimulation(sim.simulationId), "simulation must be retrievable");
});

test("simulation with a correct rollback verifies byte-identical restore", async () => {
  const good = await simulateOperation(
    cfg,
    `CREATE TABLE saferun_bak_fa AS SELECT * FROM film_actor WHERE actor_id <= 5;
     DELETE FROM film_actor WHERE actor_id <= 5;`,
    `INSERT INTO film_actor SELECT * FROM saferun_bak_fa;
     DROP TABLE saferun_bak_fa;`,
  );
  assert.equal(good.operationOk, true);
  assert.ok(good.totalRowsDeleted > 0);
  assert.equal(good.rollbackVerified, true, JSON.stringify(good.rollbackResidue));
  assert.equal(good.rollbackResidue.length, 0);
});

test("simulation never mutates the production database", async () => {
  const before = await fingerprintDatabase(cfg, cfg.productionDb);
  await simulateOperation(cfg, "DELETE FROM rental;", "SELECT 1;");
  const after = await fingerprintDatabase(cfg, cfg.productionDb);
  assert.deepEqual(after, before, "production fingerprints changed during simulation");
});

test("cleanup: no leftover simulation clones", async () => {
  const admin = poolFor(cfg, "postgres");
  const res = await admin.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'saferun_sim_%'",
  );
  assert.equal(res.rows.length, 0, `leftover clones: ${JSON.stringify(res.rows)}`);
});
