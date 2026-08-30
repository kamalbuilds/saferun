# Raw session evidence

Unedited Server-Sent-Events streams captured from the TrueForge API during
real SafeRun sessions against the live Pagila database.

- `turn2.sse` — investigation: skill load in Daytona sandbox, MCP tool
  discovery, read-only queries, FK cascade mapping, ask-user question
- `turn4.sse` — two simulate_operation runs: first rollback imperfect, agent
  fixed it, second verified (`rollbackVerified: true`), blast-radius report
- `turn5.sse` — TrueForge `tool.approval_required` pause on
  execute_approved_operation
- `turn6.sse` — human approval, production execution receipt, post-execution
  fingerprint

Each file is a stream of JSON events (`data:` lines). Grep for
`rollbackVerified`, `tool.approval_required`, or `executed` to jump to the
interesting moments.
