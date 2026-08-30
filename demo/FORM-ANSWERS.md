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
https://files.catbox.moe/x308e9.mp4 (113s; also `demo/saferun-demo.mp4` in the repo)

## What it does / how it uses TrueForge (short write-up)
SafeRun is a database guardian agent built on TrueForge. Give it any
destructive request (DELETE, UPDATE, DROP, migration) and it follows a
git-backed skill protocol instead of obeying blindly:

1. Investigates production through read-only MCP tools (row counts, FK
   cascade mapping). In the flagship demo (the run in the video: session
   `01m19dsedw3t7b9ygp1bjexcc3`, simulation `d777e8a9`) it surfaced that the
   requested cleanup was really an **810-payment** operation, because payment
   partitions reference the targeted rentals: hidden blast radius surfaced
   before anything ran.
2. Asks the human to resolve scope ambiguity (TrueForge ask-user questions).
3. Clones the production database and executes the operation in the clone,
   measuring exact per-table damage via row counts and content checksums.
4. Writes the rollback, executes it in the same clone, and verifies every
   table returns to its pre-operation state. Not "are you sure?" but "I
   already tested your undo. Here is the proof."
5. Stops at TrueForge's native approval gate. Only an explicit human Allow
   lets execute_approved_operation run, and that tool refuses at code level
   any simulation whose rollback was not verified, any operation the static
   analyzer grades F (unless override_grade_f is passed explicitly), and any
   execution whose impacted tables drifted in production since the
   simulation. The safety boundary is unpromptable: a jailbroken model cannot
   skip it.

TrueForge features used: custom MCP server (6 tools, deferred discovery),
git-backed SKILL.md, Daytona sandbox, human approvals, ask-user questions,
persistent sessions (survived a mid-turn model outage and resumed), and
subagent fan-out for wide investigations (two `create_sub_agent` threads in
`docs/evidence/turn-v2-subagents.sse`). Generative UI is enabled as the
rendering path for the approval card; the committed evidence runs rendered
that card as a markdown table under free-tier model limits.

**Demo runs.** The flagship run is the one in the video: session
`01m19dsedw3t7b9ygp1bjexcc3`, simulation `d777e8a9`, 810 payments, SSE in
`docs/evidence/turn2/4/5/6.sse`. Two alternate sessions appear in the repo and
are labelled as such: a narrower 90-rental / 180-row investigation, and the v2
"store 2 / 2020" run (7,992 store-2 payments, 97 store-2 2020 rentals) that
triggered the subagent fan-out in `turn-v2-subagents.sse` and produced
`demo/frames-v2/`.

No mocks: real Postgres 17 + Pagila (16k payments), real DB clones, real
Daytona sandboxes. Raw TrueForge SSE session logs are committed under
docs/evidence/. A 38-test suite runs against the live database and covers the
red path (broken rollback -> execution refused, grade F refused, drifted
production refused), the green path (verified restore), and production
isolation.

## AI use disclosure
AI coding assistants (Claude-based agent) were used throughout development.
All code was reviewed, tested against a live database, and is fully
understood and explainable by the participant. Code review ran through Qodo
on every substantive PR.

## Blog post
demo/BLOG-POST.md in the repo (publish link: TBD)
