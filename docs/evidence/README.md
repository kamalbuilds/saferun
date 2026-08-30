# Raw session evidence

Unedited Server-Sent-Events streams captured from the TrueForge API during
real SafeRun sessions against the live Pagila database.

## Flagship run (the one in the demo video)

Session `01m19dsedw3t7b9ygp1bjexcc3`, simulation `d777e8a9`, 810 payments.

- `turn2.sse` — investigation: skill load in Daytona sandbox, MCP tool
  discovery, read-only queries, FK cascade mapping, ask-user question
- `turn4.sse` — two simulate_operation runs: first rollback imperfect, agent
  fixed it, second verified (`rollbackVerified: true`), blast-radius report
- `turn5.sse` — TrueForge `tool.approval_required` pause on
  execute_approved_operation
- `turn6.sse` — human approval, production execution receipt, post-execution
  fingerprint

## Alternate session: subagent fan-out

- `turn-v2-subagents.sse` — a later investigation turn (store 2 / 2020 scope)
  wide enough to trigger the subagent fan-out. Contains two `create_sub_agent`
  calls and two `thread.created` events for the dynamic read-only subagents
  `count-rentals-2020-store2` and `count-payments-2020-store2`, each returning
  its own verified counts in a `thread.done` payload (7,992 store-2 payments
  across five 2020 partitions; 97 store-2 2020 rentals). Grep for
  `thread.created` and `create_sub_agent`.

Each file is a stream of JSON events (`data:` lines). Grep for
`rollbackVerified`, `tool.approval_required`, or `executed` to jump to the
interesting moments.
