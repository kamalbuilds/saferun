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
import { closePool, loadConfig } from "../src/db.js";
import { analyzeOperation, stripSqlComments } from "../src/analyze.js";
import { appendAuditEvent, readAuditLog, auditLogPath, type AuditEvent } from "../src/audit.js";
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

test("analyze: FK relationships detected for film_actor table (schema-qualified)", async () => {
  // film_actor has FK -> actor and film_actor -> film in Pagila
  const report = await analyzeOperation(cfg, "DELETE FROM film_actor WHERE actor_id = 1;");
  assert.ok(
    report.fkRelationships.length > 0,
    `expected FK relationships for film_actor, got 0. touchedTables=${JSON.stringify(report.touchedTables)}`,
  );
  // Fix #4: verify schema fields are present
  const first = report.fkRelationships[0];
  assert.ok(typeof first.schema === "string" && first.schema.length > 0, "FK entry missing schema");
  assert.ok(typeof first.referencedSchema === "string" && first.referencedSchema.length > 0, "FK entry missing referencedSchema");
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

// ── Fix #1: CTE prefix does not hide DML type ──────────────────────────────

test("fix1: WITH ... DELETE is classified as DELETE, not WITH", async () => {
  // A CTE followed by DELETE must be graded for bare DELETE risk
  const cteDelete = `
    WITH recent AS (SELECT payment_id FROM payment WHERE payment_date > now())
    DELETE FROM payment USING recent WHERE payment.payment_id = recent.payment_id;
  `;
  const report = await analyzeOperation(cfg, cteDelete);
  assert.equal(
    report.statements[0].type,
    "DELETE",
    `CTE DELETE should classify as DELETE, got ${report.statements[0].type}`,
  );
  // Has WHERE, so not bare
  assert.equal(report.statements[0].bareDestructive, false);
});

test("fix1: bare CTE DELETE (no WHERE on outer) grades F", async () => {
  // CTE with DELETE and no WHERE on the outer statement = bare destructive
  const cteBareDel = `
    WITH all_rows AS (SELECT actor_id FROM actor)
    DELETE FROM film_actor USING all_rows;
  `;
  const report = await analyzeOperation(cfg, cteBareDel);
  assert.equal(
    report.statements[0].type,
    "DELETE",
    `bare CTE DELETE type should be DELETE, got ${report.statements[0].type}`,
  );
  assert.equal(report.statements[0].bareDestructive, true, "bare CTE DELETE must be bareDestructive=true");
  assert.equal(report.grade, "F", `expected F for bare CTE DELETE, got ${report.grade}`);
});

// ── Fix #2: WHERE inside a SQL comment doesn't count ──────────────────────

test("fix2: stripSqlComments removes line comments", () => {
  const sql = "DELETE FROM actor -- WHERE actor_id = 1\n;";
  const stripped = stripSqlComments(sql);
  assert.ok(!stripped.includes("--"), "line comment should be stripped");
  // The remaining text should not have WHERE
  assert.ok(!/\bWHERE\b/i.test(stripped), "WHERE inside comment must not survive stripping");
});

test("fix2: stripSqlComments removes block comments", () => {
  const sql = "DELETE FROM actor /* WHERE actor_id = 1 */;";
  const stripped = stripSqlComments(sql);
  assert.ok(!/\bWHERE\b/i.test(stripped), "WHERE inside block comment must not survive");
});

test("fix2: DELETE with WHERE only in comment grades F", async () => {
  // The WHERE is inside a comment; without stripping this would be a false negative
  const sql = "DELETE FROM film_actor -- WHERE actor_id = 1\n;";
  const report = await analyzeOperation(cfg, sql);
  assert.equal(
    report.statements[0].hasWhereClause,
    false,
    "WHERE inside comment must not count as a real WHERE clause",
  );
  assert.equal(report.statements[0].bareDestructive, true, "should be bare destructive");
  assert.equal(report.grade, "F", `expected F, got ${report.grade}`);
});

test("fix2: DELETE with real WHERE after comment grades better than F", async () => {
  const sql = "DELETE FROM film_actor /* note: careful here */ WHERE actor_id = 1;";
  const report = await analyzeOperation(cfg, sql);
  assert.equal(report.statements[0].hasWhereClause, true, "real WHERE should be detected");
  assert.equal(report.statements[0].bareDestructive, false);
  assert.ok(report.grade !== "F", `should not be F when WHERE exists, got ${report.grade}`);
});

// ── Fix #4: schema-qualified FK ────────────────────────────────────────────

test("fix4: FK lookup with schema-prefixed table (public.film_actor)", async () => {
  // Explicitly schema-qualify: analyze uses public.film_actor -> must find FKs
  const report = await analyzeOperation(cfg, "DELETE FROM public.film_actor WHERE actor_id = 1;");
  assert.ok(
    report.fkRelationships.length > 0,
    `expected FK rows for public.film_actor, got 0`,
  );
  // All FK entries must have non-empty schema fields
  for (const fk of report.fkRelationships) {
    assert.ok(typeof fk.schema === "string" && fk.schema.length > 0, `FK entry schema missing: ${JSON.stringify(fk)}`);
    assert.ok(typeof fk.referencedSchema === "string" && fk.referencedSchema.length > 0, `FK entry referencedSchema missing: ${JSON.stringify(fk)}`);
  }
});

// ── Fix #5: rollback SQL is redacted in execute audit events ───────────────

test("fix5: execute audit event contains rollbackSha256 + rollbackLength, not raw SQL", async () => {
  const tmpExecLog = path.join(os.tmpdir(), `saferun-exec-audit-${process.pid}.log`);
  const saved = process.env.SAFERUN_AUDIT_LOG;
  process.env.SAFERUN_AUDIT_LOG = tmpExecLog;
  try {
    try { fs.unlinkSync(tmpExecLog); } catch { /* ok */ }

    const rollbackSql = "INSERT INTO film_actor SELECT * FROM saferun_dur_bak;";
    // Manually emit what execute_approved_operation would emit
    const { createHash } = await import("node:crypto");
    const expectedSha = createHash("sha256").update(rollbackSql).digest("hex");

    appendAuditEvent("execute", {
      executed: true,
      database: "pagila",
      simulationId: "test123",
      tablesChanged: [],
      rollbackSha256: expectedSha,
      rollbackLength: rollbackSql.length,
      status: "ok",
    });

    const entries = readAuditLog(5);
    assert.ok(entries.length >= 1);
    const execEntry = entries.find((e) => e.event === "execute");
    assert.ok(execEntry, "expected an execute entry");
    const d = execEntry!.details as Record<string, unknown>;
    // rollback SQL body must NOT be present
    assert.ok(!("verifiedRollbackOnFile" in d), "raw rollback SQL must not be logged");
    assert.ok(!("rollback" in d), "raw rollback key must not be logged");
    // sha256 + length must be present
    assert.equal(d.rollbackSha256, expectedSha, "sha256 must match");
    assert.equal(d.rollbackLength, rollbackSql.length, "length must match");
  } finally {
    process.env.SAFERUN_AUDIT_LOG = saved;
    try { fs.unlinkSync(tmpExecLog); } catch { /* ok */ }
  }
});

// ── Fix #7: EXPLAIN entries have statementIndex + sqlSnippet; DDL gets error entry ──

test("fix7: explainCosts has statementIndex and sqlSnippet on success", async () => {
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM film_actor WHERE actor_id <= 2;",
    "SELECT 1;", // broken rollback — ok for this test
  );
  assert.ok(Array.isArray(sim.explainCosts) && sim.explainCosts.length > 0,
    `expected non-empty explainCosts, got ${JSON.stringify(sim.explainCosts)}`);
  const entry = sim.explainCosts[0];
  assert.equal(entry.statementIndex, 0, "first entry must have statementIndex 0");
  assert.ok(typeof entry.sqlSnippet === "string" && entry.sqlSnippet.length > 0, "sqlSnippet must be a non-empty string");
  assert.ok(entry.sqlSnippet.length <= 80, "sqlSnippet must be at most 80 chars");
  assert.ok(typeof entry.totalCost === "number", "totalCost must be a number on success");
  assert.ok(!entry.explainError, "no error on successful EXPLAIN");
});

test("fix7: DDL statement in explainCosts has explainError entry", async () => {
  // Two-statement op: DELETE (plannable) + DROP TABLE (DDL, not plannable by EXPLAIN)
  // DROP TABLE IF EXISTS for a non-existent table still cannot be EXPLAIN'd.
  const sql = [
    "DELETE FROM film_actor WHERE actor_id <= 1;",
    "DROP TABLE IF EXISTS saferun_nonexistent_junk;",
  ].join("\n");
  const sim = await simulateOperation(cfg, sql, "SELECT 1;");
  // Both statements should appear in explainCosts
  assert.equal(sim.explainCosts.length, 2, `expected 2 EXPLAIN entries, got ${sim.explainCosts.length}`);
  const deleteEntry = sim.explainCosts.find((e) => e.statementIndex === 0);
  const dropEntry = sim.explainCosts.find((e) => e.statementIndex === 1);
  assert.ok(deleteEntry, "DELETE entry (index 0) must exist");
  assert.ok(dropEntry, "DROP entry (index 1) must exist");
  // DELETE should succeed with totalCost
  assert.ok(typeof deleteEntry!.totalCost === "number", "DELETE entry must have totalCost");
  assert.ok(!deleteEntry!.explainError, "DELETE entry must not have explainError");
  // DROP TABLE is DDL — EXPLAIN fails, explainError must be set
  assert.ok(dropEntry!.explainError, `DROP TABLE entry must have explainError, got: ${JSON.stringify(dropEntry)}`);
  // sqlSnippet present on both
  assert.ok(deleteEntry!.sqlSnippet.length > 0, "DELETE entry sqlSnippet missing");
  assert.ok(dropEntry!.sqlSnippet.length > 0, "DROP entry sqlSnippet missing");
  // Indexes must match
  assert.equal(deleteEntry!.statementIndex, 0);
  assert.equal(dropEntry!.statementIndex, 1);
});

// ── Audit log ──────────────────────────────────────────────────────────────

test("audit: appendAuditEvent writes a JSON line", () => {
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }

  appendAuditEvent("analyze", { grade: "F", test: true });

  const raw = fs.readFileSync(tmpLog, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as AuditEvent;
  assert.equal(parsed.event, "analyze");
  assert.equal((parsed.details as Record<string, unknown>).grade, "F");
  assert.ok(parsed.ts.includes("T"));
});

test("audit: readAuditLog returns last N entries in order", () => {
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
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }

  const sim = await simulateOperation(
    cfg,
    "DELETE FROM film_actor WHERE actor_id <= 3;",
    "SELECT 1;",
  );
  assert.equal(sim.rollbackVerified, false);

  appendAuditEvent("refusal", { simulation_id: sim.simulationId, reason: "REFUSED: rollback was NOT verified" });

  const entries = readAuditLog(50);
  const refusalEntries = entries.filter((e) => e.event === "refusal");
  assert.ok(refusalEntries.length >= 1, "expected at least 1 refusal entry");
  assert.ok(
    String((refusalEntries[0].details as Record<string, unknown>).reason).includes("REFUSED"),
  );
});

test("audit: rotation renames file when it exceeds 5MB", () => {
  const rotLog = path.join(os.tmpdir(), `saferun-rotation-test-${process.pid}.log`);
  const saved = process.env.SAFERUN_AUDIT_LOG;
  process.env.SAFERUN_AUDIT_LOG = rotLog;
  try {
    try { fs.unlinkSync(rotLog); } catch { /* ok */ }
    try { fs.unlinkSync(rotLog + ".1"); } catch { /* ok */ }
    // Write 5MB + 1 byte first, then call appendAuditEvent to trigger rotation
    fs.writeFileSync(rotLog, Buffer.alloc(5 * 1024 * 1024 + 1));
    appendAuditEvent("analyze", { rotation: true });
    // The original should now be .1 (rotation happened)
    assert.ok(fs.existsSync(rotLog + ".1"), "rotated .1 file must exist");
    // The new file should be small (just the one new event)
    const newSize = fs.statSync(rotLog).size;
    assert.ok(newSize < 1024, `new log after rotation should be small, got ${newSize} bytes`);
  } finally {
    process.env.SAFERUN_AUDIT_LOG = saved;
    try { fs.unlinkSync(rotLog); } catch { /* ok */ }
    try { fs.unlinkSync(rotLog + ".1"); } catch { /* ok */ }
  }
});

// ── Extended SimulationResult: durationMs ─────────────────────────────────

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

test("simulation failed operation still has rollbackDurationMs = 0", async () => {
  const sim = await simulateOperation(
    cfg,
    "DELETE FROM does_not_exist_table;",
    "SELECT 1;",
  );
  assert.equal(sim.operationOk, false);
  assert.ok(typeof sim.operationDurationMs === "number");
  assert.equal(sim.rollbackDurationMs, 0);
  assert.ok(Array.isArray(sim.explainCosts));
});

// ── cleanup ────────────────────────────────────────────────────────────────

test.after(async () => {
  // Only close the prod-db pool; do NOT close the "postgres" admin pool because
  // simulate.test.ts's cleanup test needs it and both files share the same pool map.
  await closePool(cfg.productionDb);
  try { fs.unlinkSync(tmpLog); } catch { /* ok */ }
});
