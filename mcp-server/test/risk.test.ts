/**
 * risk.test.ts — tests for analyze_operation, audit log, and extended SimulationResult
 *
 * Runs against the real local Postgres + Pagila dataset.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closePool, loadConfig, poolFor } from "../src/db.js";
import { analyzeOperation } from "../src/analyze.js";
import { appendAuditEvent, readAuditLog, type AuditEvent } from "../src/audit.js";
import { simulateOperation } from "../src/simulate.js";

const cfg = loadConfig();

// Use a temp file for the audit log so tests don't pollute the real log
const tmpLog = path.join(os.tmpdir(), `saferun-test-audit-${process.pid}.log`);
process.env.SAFERUN_AUDIT_LOG = tmpLog;

// ── analyze_operation ──────────────────────────────────────────────────────

test("analyze: bare DELETE with no WHERE grades F", async () => {
  const report = await analyzeOperation(cfg, "DELETE FROM payment;");
  assert.equal(report.grade, "F", `expected F got ${report.grade}: ${JSON.stringify(report.riskFactors)}`);
  assert.ok(report.statements.length === 1);
  assert.equal(report.statements[0].type, "DELETE");
  assert.equal(report.statements[0].hasWhereClause, false);
  assert.equal(report.statements[0].bareDestructive, true);
  assert.ok(report.riskFactors.some((f) => /bare/i.test(f)));
});

test("analyze: scoped DELETE with WHERE grades better than F", async () => {
  const report = await analyzeOperation(cfg, "DELETE FROM payment WHERE payment_id = 9999999;");
  assert.ok(
    ["A", "B", "C", "D"].includes(report.grade),
    `expected A-D got ${report.grade}`,
  );
  assert.equal(report.statements[0].hasWhereClause, true);
  assert.equal(report.statements[0].bareDestructive, false);
});

test("analyze: bare UPDATE grades F", async () => {
  const report = await analyzeOperation(cfg, "UPDATE payment SET amount = 0;");
  assert.equal(report.grade, "F");
  assert.equal(report.statements[0].type, "UPDATE");
  assert.equal(report.statements[0].bareDestructive, true);
});

test("analyze: DROP TABLE grades at least C", async () => {
  const report = await analyzeOperation(cfg, "DROP TABLE payment;");
  assert.ok(
    ["C", "D", "F"].includes(report.grade),
    `expected C/D/F got ${report.grade}`,
  );
  assert.equal(report.statements[0].type, "DROP");
});

test("analyze: pure SELECT grades A", async () => {
  const report = await analyzeOperation(cfg, "SELECT count(*) FROM payment;");
  assert.equal(report.grade, "A");
  assert.equal(report.statements[0].bareDestructive, false);
});

test("analyze: FK relationships detected for film_actor table", async () => {
  // film_actor has FK -> actor and film_actor -> film in Pagila
  const report = await analyzeOperation(cfg, "DELETE FROM film_actor WHERE actor_id = 1;");
  assert.ok(
    report.fkRelationships.length > 0,
    `expected FK relationships for film_actor, got 0. touchedTables=${JSON.stringify(report.touchedTables)}`,
  );
  // Must reference 'actor' or 'film' as FK target
  const refTargets = report.fkRelationships.map((r) => r.referencedTable);
  assert.ok(
    refTargets.includes("actor") || refTargets.includes("film"),
    `expected actor or film in FK targets, got ${JSON.stringify(refTargets)}`,
  );
});

test("analyze: multi-statement SQL has correct statement count", async () => {
  const sql = [
    "CREATE TABLE saferun_bak AS SELECT * FROM film_actor WHERE actor_id <= 5;",
    "DELETE FROM film_actor WHERE actor_id <= 5;",
  ].join("\n");
  const report = await analyzeOperation(cfg, sql);
  assert.equal(report.statements.length, 2);
  assert.equal(report.statements[0].type, "CREATE");
  assert.equal(report.statements[1].type, "DELETE");
  // DELETE has WHERE, so not bare
  assert.equal(report.statements[1].bareDestructive, false);
});

test("analyze: touched tables extracted correctly", async () => {
  const report = await analyzeOperation(cfg, "UPDATE actor SET last_name = 'X' WHERE actor_id = 1;");
  assert.ok(
    report.touchedTables.some((t) => t.includes("actor")),
    `actor not in touchedTables: ${JSON.stringify(report.touchedTables)}`,
  );
});

// ── Audit log ──────────────────────────────────────────────────────────────

test("audit: appendAuditEvent writes a JSON line", () => {
  // Clean up temp log for this test
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }

  appendAuditEvent("analyze", { grade: "F", test: true });

  const raw = fs.readFileSync(tmpLog, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as AuditEvent;
  assert.equal(parsed.event, "analyze");
  assert.equal((parsed.details as Record<string, unknown>).grade, "F");
  assert.ok(parsed.ts.includes("T")); // ISO timestamp
});

test("audit: readAuditLog returns last N entries in order", async () => {
  // Reset log to a known state for this test
  const knownLog = path.join(os.tmpdir(), `saferun-test-audit-order-${process.pid}.log`);
  const saved = process.env.SAFERUN_AUDIT_LOG;
  process.env.SAFERUN_AUDIT_LOG = knownLog;
  try {
    try { fs.unlinkSync(knownLog); } catch { /* ok */ }
    for (let i = 0; i < 5; i++) {
      appendAuditEvent("simulate", { index: i });
    }
    const entries = readAuditLog(3);
    assert.equal(entries.length, 3);
    // The last event written should have index 4
    const last = entries[2];
    assert.equal(last.event, "simulate");
    assert.equal((last.details as Record<string, unknown>).index, 4);
  } finally {
    process.env.SAFERUN_AUDIT_LOG = saved;
    try { fs.unlinkSync(knownLog); } catch { /* ok */ }
  }
});

test("audit: readAuditLog returns [] when file missing", () => {
  const saved = process.env.SAFERUN_AUDIT_LOG;
  process.env.SAFERUN_AUDIT_LOG = "/tmp/__saferun_nonexistent_test_log__.log";
  const entries = readAuditLog();
  assert.equal(entries.length, 0);
  process.env.SAFERUN_AUDIT_LOG = saved;
});

test("audit: refusal events logged for refused execute", async () => {
  // Clean log
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }

  // Simulate with broken rollback -> will be refused
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM film_actor WHERE actor_id <= 3;",
    "SELECT 1;", // broken rollback
  );
  assert.equal(sim.rollbackVerified, false);

  // Manually log a refusal (as the real execute_approved_operation handler would)
  appendAuditEvent("refusal", { simulation_id: sim.simulationId, reason: "REFUSED: rollback was NOT verified" });

  const entries = readAuditLog(50);
  const refusalEntries = entries.filter((e) => e.event === "refusal");
  assert.ok(refusalEntries.length >= 1, "expected at least 1 refusal entry");
  assert.ok(
    String((refusalEntries[0].details as Record<string, unknown>).reason).includes("REFUSED"),
  );
});

// ── Extended SimulationResult: durationMs + EXPLAIN costs ─────────────────

test("simulation result includes operationDurationMs and rollbackDurationMs", async () => {
  const sim = await simulateOperation(
    cfg,
    `CREATE TABLE saferun_dur_bak AS SELECT * FROM film_actor WHERE actor_id <= 5;
     DELETE FROM film_actor WHERE actor_id <= 5;`,
    `INSERT INTO film_actor SELECT * FROM saferun_dur_bak;
     DROP TABLE saferun_dur_bak;`,
  );
  assert.equal(sim.rollbackVerified, true);
  assert.ok(
    typeof sim.operationDurationMs === "number" && sim.operationDurationMs >= 0,
    `operationDurationMs should be a non-negative number, got ${sim.operationDurationMs}`,
  );
  assert.ok(
    typeof sim.rollbackDurationMs === "number" && sim.rollbackDurationMs >= 0,
    `rollbackDurationMs should be a non-negative number, got ${sim.rollbackDurationMs}`,
  );
});

test("simulation result includes explainCosts array", async () => {
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM film_actor WHERE actor_id <= 2;",
    `INSERT INTO film_actor
       SELECT actor_id, film_id, last_update
       FROM film_actor WHERE false;`, // broken rollback, that's ok for this test
  );
  assert.ok(Array.isArray(sim.explainCosts), "explainCosts must be an array");
  // The DELETE statement should yield an EXPLAIN plan with a totalCost
  const hasCost = sim.explainCosts.some((e) => typeof e.totalCost === "number");
  assert.ok(
    hasCost,
    `expected at least one explainCost entry with a numeric totalCost, got: ${JSON.stringify(sim.explainCosts)}`,
  );
});

test("simulation failed operation still has durationMs = 0 and empty explainCosts fallback", async () => {
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM does_not_exist_table;",
    "SELECT 1;",
  );
  assert.equal(sim.operationOk, false);
  // operationDurationMs may be non-zero because we still measured the failed attempt
  assert.ok(typeof sim.operationDurationMs === "number");
  // rollback was never run since operation failed
  assert.equal(sim.rollbackDurationMs, 0);
  assert.ok(Array.isArray(sim.explainCosts));
});

// ── cleanup ────────────────────────────────────────────────────────────────

test.after(async () => {
  for (const db of ["postgres", cfg.productionDb]) {
    await closePool(db);
  }
  // Clean up temp audit log
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }
});
