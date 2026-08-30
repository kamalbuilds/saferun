# SafeRun 3-minute demo script

## Scene 1: The problem (0:00–0:25)
Show README top. Narrate: "July 2025. An AI agent deleted a production
database with 1,200 executives' records, ignored 'stop', claimed the data was
unrecoverable. The missing layer between a model and the things it can break
is the agent harness. SafeRun is that layer for databases, built on TrueForge."

## Scene 2: The ask (0:25–0:45)
TrueForge UI, saferun agent session. Show prompt:
"Delete all payments from inactive customers in the production database."
Point at: real Postgres (Pagila, 16,049 payments), no mocks.

## Scene 3: The protocol fires (0:45–1:40)
Scroll the session showing (all real, logged):
- Agent loads the git-backed `dangerous-ops` skill in a Daytona sandbox
- Discovers saferun-db MCP tools
- Read-only investigation: row counts, FK cascade map
- ask_user_question: "which definition of inactive?": human-in-the-loop
- simulate_operation: clones production, runs the DELETE in the clone,
  measures 810 payments across 6 partitioned tables
- First rollback imperfect -> agent fixes it -> re-simulates ->
  **rollbackVerified: true**

## Scene 4: The money shot (1:40–2:20)
Blast-radius report on screen. Read the key line:
"I already executed your undo in a clone of production. Every table checksum
restored. Here is the proof."
Then: TrueForge's native approval gate: execute_approved_operation pauses,
tool.approval_required. Click Allow.
Production executes. 16,049 -> 15,644 payments. Verified rollback SQL on file.

## Scene 5: Defense in depth (2:20–2:50)
Show mcp-server/src/index.ts REFUSED branch: the execute tool itself refuses
unverified simulations: the safety is not in the prompt, a jailbroken model
cannot bypass it. Show 7/7 tests green (red path + green path + prod isolation).

## Scene 6: Close (2:50–3:00)
"MCP tools, skills, sandbox, approvals, ask-user, persistent sessions -
every harness feature load-bearing. SafeRun: agents you can hand the keys to."
