=== SAFERUN SUBMISSION (kamalbuilds) ===

BLOG LINK:
https://github.com/kamalbuilds/saferun/blob/main/demo/BLOG-POST.md

DEPLOYED LINK:
(leave blank - runs locally against your own Postgres by design)

YOUTUBE VIDEO:
<paste after upload; file is demo/saferun-demo.mp4, mirror https://files.catbox.moe/x308e9.mp4>

WHAT DOES YOUR PROJECT DO?
SafeRun is a database guardian agent. In July 2025 an AI coding agent deleted a
production database, ignored an instruction to stop, and claimed the data was
unrecoverable. SafeRun is the layer that was missing. Give it any destructive
request (DELETE, UPDATE, DROP, a migration) and instead of obeying it: grades the
SQL statically (A-F, missing WHERE, foreign-key map), clones the production
database, executes the operation inside the clone, measures the exact blast radius
per table with row counts and content checksums, writes the rollback, executes the
rollback in the same clone, and verifies every table returns to its pre-operation
state. Only then does it present the report and stop at a human approval gate.
The execute tool refuses at code level any simulation whose rollback was not
verified, whose SQL grades F, or whose production tables drifted since the
simulation, so a jailbroken or prompt-injected model cannot talk its way past it.
It is for anyone letting agents touch a real database: platform teams, DBAs,
and every developer who has typed DELETE without a WHERE at 2am.

HOW DID YOU USE TRUEFORGE?
TrueForge is the runtime, not a wrapper around it. Every harness feature is load
bearing: a custom MCP server (saferun-db) exposes inspect_database,
run_readonly_query, analyze_operation, simulate_operation, get_audit_log and
execute_approved_operation, with deferred tool discovery so schemas load on demand.
A git-backed SKILL.md holds the dangerous-ops protocol the agent loads from GitHub.
The Daytona sandbox stages SQL and analysis. TrueForge's native approval list holds
execute_approved_operation, so the run pauses with tool.approval_required until a
human allows it. Ask-user questions resolve scope ambiguity before anything is
simulated. Dynamic subagents fan out read-only per-table verification (a real run
spawned two subagent threads; the raw SSE is committed at
docs/evidence/turn-v2-subagents.sse). Persistent sessions carried one investigation
across a mid-turn model outage and resumed exactly where it stopped. Generative UI
is enabled for the blast-radius card. Nothing is mocked: real Postgres 17, real
Pagila data, real clones, real Daytona sandboxes, raw session logs in docs/evidence.

HOW DID YOU USE QODO?
Every substantive change went through a pull request reviewed by Qodo before merge,
five merged PRs in total. Qodo did not just lint: it found a security bug (the audit
log returned full rollback SQL to any MCP session, now a sha256 and length), two
real bypasses of the risk analyzer (a CTE prologue or a SQL comment made a bare
DELETE classify as safe), failures escaping the audit trail, schema-ambiguous
foreign-key lookups, unbounded synchronous audit reads, and CI seeding that
swallowed SQL errors so tests could pass against a half-loaded database. Each fix
landed with a red-and-green test, then a follow-up Qodo review confirmed it, and one
stale finding was dismissed in-thread with the reason. The trail is in the PR history.

MOST USEFUL TRUEFORGE FEATURE:
The approval gate combined with MCP tool annotations. Putting one tool on
require_approval_for_tools turned "the agent should ask first" from a prompt
instruction into runtime behaviour I did not have to build, and it composes with my
own code-level refusals to give two independent layers: the harness can stop the
call, and the tool can refuse the call. Defense in depth for free. Second place goes
to skills: watching the agent cat SKILL.md inside its sandbox and then follow the
protocol step by step is what made the architecture click.

WHERE DID YOU GET STUCK / DX IMPROVEMENTS:
Two places. First, turn input shapes: the discriminator values (user.message,
user.tool_approval, user.tool_response) are only discoverable from the OpenAPI
schema, and my first attempts failed with a validation error that named the
discriminator but not the valid example. A copy-pasteable example per input type in
the docs would have saved twenty minutes. Second, correlating a pending approval
back to its tool call: required_actions gives you tool_call_id, but the tool name
and arguments have to be reassembled from streamed model.message.delta chunks where
only the first chunk carries the id. A resolved tool_call summary on the pending
action would remove a lot of client code. Smaller ones: sessions returning a
newest-first array while turns return the tip differently cost me a bug, and it
would help if generative UI emitted a distinct event type so you can grep evidence
for it.

QODO RATING: 5

MOST USEFUL / FRUSTRATING PART OF QODO:
Most useful: it reads the whole repository, not the diff. It flagged that my CI
seeded Pagila without ON_ERROR_STOP by connecting that to the fixture assertions in
a different file and concluding the tests could pass against a partially seeded
database. No diff-only reviewer finds that. It also flagged that my README claimed
"byte-identical restore" while the code compares row-content checksums, which is a
claim-versus-code check I did not expect. Frustrating: review latency of a couple of
minutes per round breaks flow during a one-day hackathon, and it re-reported one
cross-PR finding (tests do not exist) that was only true because the test suite sat
in a sibling PR. What I would change: an explicit dependency between PRs, and a
lighter incremental re-review that only re-checks the changed hunks.

WHICH PR STOOD OUT:
https://github.com/kamalbuilds/saferun/pull/3 (Static risk analyzer, EXPLAIN costs,
audit log). Qodo returned seven findings and the two that mattered were security and
correctness, not style: the audit tool leaking complete rollback SQL to any MCP
session, and the analyzer trusting the first SQL token so that "WITH x AS (...)
DELETE FROM payment" or a commented-out WHERE clause dodged the bare-DELETE penalty
that the whole grading system rests on. That is a guard that would have shipped
looking correct and been worthless in exactly the case it existed for.
