# Submission form answers (paste-ready)

## Project name
SafeRun

## One-liner
The agent that would have stopped the Replit database wipe: it executes your
destructive SQL in a clone of production, proves the rollback restores every
row, and only touches production after TrueForge's human approval gate.

## Repo
https://github.com/kamalbuilds/saferun

## Demo video
demo/saferun-demo.mp4 in the repo (or YouTube link if uploaded)

## What it does / how it uses TrueForge (short write-up)
SafeRun is a database guardian agent built on TrueForge. Give it any
destructive request (DELETE, UPDATE, DROP, migration) and it follows a
git-backed skill protocol instead of obeying blindly:

1. Investigates production through read-only MCP tools (row counts, FK
   cascade mapping). In our demo it discovered that deleting 90 rental rows
   was secretly a 180-row operation because payment partitions reference
   rentals: hidden blast radius surfaced before anything ran.
2. Asks the human to resolve scope ambiguity (TrueForge ask-user questions).
3. Clones the production database and executes the operation in the clone,
   measuring exact per-table damage via row counts and content checksums.
4. Writes the rollback, executes it in the same clone, and verifies every
   table returns to its pre-operation state. Not "are you sure?" but "I
   already tested your undo. Here is the proof."
5. Stops at TrueForge's native approval gate. Only an explicit human Allow
   lets execute_approved_operation run, and that tool refuses at code level
   any simulation whose rollback was not verified. The safety boundary is
   unpromptable: a jailbroken model cannot skip it.

TrueForge features used, all load-bearing: custom MCP server (4 tools,
deferred discovery), git-backed SKILL.md, Daytona sandbox, human approvals,
ask-user questions, persistent sessions (survived a mid-turn model outage and
resumed), subagents enabled for parallel investigation.

No mocks: real Postgres 17 + Pagila (16k payments), real DB clones, real
Daytona sandboxes. Raw TrueForge SSE session logs are committed under
docs/evidence/. An 8-test suite runs against the live database and covers the
red path (broken rollback -> execution refused), the green path (verified
restore), and production isolation.

## AI use disclosure
AI coding assistants (Claude-based agent) were used throughout development.
All code was reviewed, tested against a live database, and is fully
understood and explainable by the participant. Code review ran through Qodo
on every substantive PR.

## Blog post
demo/BLOG-POST.md in the repo (publish link: TBD)
