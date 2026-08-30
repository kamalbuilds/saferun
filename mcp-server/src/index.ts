import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fingerprintDatabase, loadConfig, poolFor } from "./db.js";
import { getSimulation, refusalReason, simulateOperation } from "./simulate.js";

const cfg = loadConfig();

function buildServer(): McpServer {
  const server = new McpServer({ name: "saferun", version: "0.1.0" });

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
    "simulate_operation",
    {
      title: "Simulate destructive operation with verified rollback",
      description:
        "Clone the production database, execute the destructive SQL inside the clone, measure the exact blast radius (rows deleted/changed per table), then execute the proposed rollback SQL in the clone and verify it restores every table checksum. Never touches production. Returns a simulation id required by execute_approved_operation.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        operation: z.string().describe("The destructive SQL to test"),
        rollback: z
          .string()
          .describe("The rollback SQL that should undo the operation"),
      },
    },
    async ({ operation, rollback }) => {
      const result = await simulateOperation(cfg, operation, rollback);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "execute_approved_operation",
    {
      title: "Execute operation on PRODUCTION",
      description:
        "Execute a previously simulated operation against the real production database. Refuses to run unless the simulation exists, the operation succeeded in the sandbox, and the rollback was VERIFIED to restore the data. This is the only tool that writes to production.",
      annotations: { destructiveHint: true, readOnlyHint: false },
      inputSchema: {
        simulation_id: z
          .string()
          .describe("Simulation id returned by simulate_operation"),
      },
    },
    async ({ simulation_id }) => {
      const sim = getSimulation(simulation_id);
      const refusal = refusalReason(sim, simulation_id);
      if (refusal) {
        return {
          content: [{ type: "text", text: refusal }],
          isError: true,
        };
      }
      const pool = poolFor(cfg, cfg.productionDb);
      const before = await fingerprintDatabase(cfg, cfg.productionDb);
      await pool.query(sim!.operation);
      const after = await fingerprintDatabase(cfg, cfg.productionDb);
      const changed = after.filter(
        (a) => before.find((b) => b.table === a.table)?.checksum !== a.checksum,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                executed: true,
                database: cfg.productionDb,
                simulationId: simulation_id,
                tablesChanged: changed.map((c) => c.table),
                verifiedRollbackOnFile: sim!.rollback,
              },
              null,
              2,
            ),
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
