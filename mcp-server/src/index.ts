import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fingerprintDatabase, loadConfig, poolFor } from "./db.js";
import { simulateOperation } from "./simulate.js";
import { analyzeOperation } from "./analyze.js";
import { executeApprovedOperation } from "./execute.js";
import { appendAuditEvent, readAuditLog } from "./audit.js";

const cfg = loadConfig();

function buildServer(): McpServer {
  const server = new McpServer({ name: "saferun", version: "0.3.0" });

  server.registerTool(
    "inspect_database",
    {
      title: "Inspect production database",
      description:
        "List every table in the production database with exact row counts and a content checksum. Read-only.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const fingerprints = await fingerprintDatabase(cfg, cfg.productionDb);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ database: cfg.productionDb, tables: fingerprints }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "run_readonly_query",
    {
      title: "Run read-only SQL",
      description:
        "Run a read-only SQL query (SELECT/WITH/EXPLAIN/SHOW) against the production database. Any write is rejected by a read-only transaction.",
      annotations: { readOnlyHint: true },
      inputSchema: { sql: z.string().describe("Read-only SQL statement") },
    },
    async ({ sql }) => {
      const pool = poolFor(cfg, cfg.productionDb);
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const res = await client.query(sql);
        await client.query("COMMIT");
        const rows = Array.isArray(res.rows) ? res.rows.slice(0, 200) : [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ rowCount: res.rowCount, rows }, null, 2),
            },
          ],
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        return {
          content: [{ type: "text", text: `Query rejected: ${String(err)}` }],
          isError: true,
        };
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    "analyze_operation",
    {
      title: "Static risk analysis of SQL",
      description:
        "Without executing anything, return a static risk report for a SQL string: statement types, tables referenced, whether a WHERE clause is present per statement (bare DELETE/UPDATE = critical), FK relationships of touched tables (queried from information_schema in a read-only transaction), and an overall risk grade A–F. CTEs and SQL comments are handled correctly.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        sql: z.string().describe("The SQL to analyse (one or more statements)"),
      },
    },
    async ({ sql }) => {
      // Fix #3: audit errors too, not just successes
      try {
        const report = await analyzeOperation(cfg, sql);
        appendAuditEvent("analyze", {
          grade: report.grade,
          touchedTables: report.touchedTables,
          riskFactors: report.riskFactors,
          statementCount: report.statements.length,
          status: "ok",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      } catch (err) {
        appendAuditEvent("analyze", { status: "error", error: String(err) });
        return {
          content: [{ type: "text", text: `Analysis failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "simulate_operation",
    {
      title: "Simulate destructive operation with verified rollback",
      description:
        "Clone the production database, execute the destructive SQL inside the clone, measure the exact blast radius (rows deleted/changed per table), then execute the proposed rollback SQL in the clone and verify it restores every table checksum. Never touches production. Returns a simulation id required by execute_approved_operation. Includes wall-clock durations and EXPLAIN cost estimates.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        operation: z.string().describe("The destructive SQL to test"),
        rollback: z
          .string()
          .describe("The rollback SQL that should undo the operation"),
      },
    },
    // Fix #3: audit failures too
    async ({ operation, rollback }) => {
      try {
        const result = await simulateOperation(cfg, operation, rollback);
        appendAuditEvent("simulate", {
          simulationId: result.simulationId,
          operationOk: result.operationOk,
          rollbackVerified: result.rollbackVerified,
          tablesChanged: result.tablesChanged,
          totalRowsDeleted: result.totalRowsDeleted,
          operationDurationMs: result.operationDurationMs,
          rollbackDurationMs: result.rollbackDurationMs,
          operationError: result.operationError,
          status: "ok",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        appendAuditEvent("simulate", { status: "error", error: String(err) });
        return {
          content: [{ type: "text", text: `Simulation failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "execute_approved_operation",
    {
      title: "Execute operation on PRODUCTION",
      description:
        "Execute a previously simulated operation against the real production database. Refuses to run unless the simulation exists, the operation succeeded in the sandbox, the rollback was VERIFIED to restore the data, the static risk grade is not F (unless override_grade_f is passed), and the tables the simulation impacted have not drifted in production since the simulation ran. This is the only tool that writes to production.",
      annotations: { destructiveHint: true, readOnlyHint: false },
      inputSchema: {
        simulation_id: z
          .string()
          .describe("Simulation id returned by simulate_operation"),
        override_grade_f: z
          .boolean()
          .optional()
          .describe(
            "Explicitly accept an operation the static analyzer graded F (highest risk). Defaults to false; the override is recorded in the audit log.",
          ),
      },
    },
    // Fix #3: audit failures; fix #5: redact rollback SQL body
    // S5/S6: grade-F and drift gates live in executeApprovedOperation (code-level)
    async ({ simulation_id, override_grade_f }) => {
      try {
        const outcome = await executeApprovedOperation(cfg, simulation_id, {
          overrideGradeF: override_grade_f === true,
        });
        if (outcome.refusal) {
          appendAuditEvent("refusal", {
            simulation_id,
            reason: outcome.refusal,
            grade: outcome.grade,
            status: "refused",
          });
          return {
            content: [{ type: "text", text: outcome.refusal }],
            isError: true,
          };
        }
        appendAuditEvent("execute", { ...outcome.payload, status: "ok" });
        return {
          content: [
            { type: "text", text: JSON.stringify(outcome.payload, null, 2) },
          ],
        };
      } catch (err) {
        appendAuditEvent("execute", {
          simulation_id,
          status: "error",
          error: String(err),
        });
        return {
          content: [{ type: "text", text: `Execution failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Read audit log",
      description:
        "Return the last 50 SafeRun audit events (simulate, execute, refusal, analyze) from the append-only audit log. Read-only. Rollback SQL bodies are redacted; only sha256 and length are stored.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max entries to return (default 50, max 200)"),
      },
    },
    async ({ limit }) => {
      const entries = readAuditLog(limit ?? 50);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: entries.length, entries }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) transports.delete(transport.sessionId);
    };
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("missing session");
    return;
  }
  await transport.handleRequest(req, res);
});

const port = Number(process.env.SAFERUN_MCP_PORT ?? 8931);
app.listen(port, "127.0.0.1", () => {
  console.log(
    `saferun-mcp listening on http://127.0.0.1:${port}/mcp (production db: ${cfg.productionDb})`,
  );
});
