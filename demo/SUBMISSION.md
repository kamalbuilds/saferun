# SafeRun: Submission

**Track focus:** Best Use of TrueForge

**One-liner:** The agent that would have stopped the Replit database wipe:
it executes your destructive SQL in a clone of production, proves the rollback
restores the data, and only touches production after TrueForge's human
approval gate.

## What it does

Give SafeRun a destructive request ("delete every 2020 rental for store 2").
It refuses to act until it has:
1. Inspected production through read-only MCP tools (row counts, FK cascades)
2. Asked the human to resolve scope ambiguity (TrueForge ask-user questions)
3. Cloned the production database and executed the operation in the clone
4. Measured the exact blast radius per table (row counts + content checksums)
5. Written a rollback, executed it in the same clone, and VERIFIED every
   table returns to its pre-operation state
6. Presented the blast-radius report and stopped at TrueForge's native
   approval gate

Only after an explicit allow does `execute_approved_operation` run, and that
tool refuses at code level any simulation whose rollback was not verified, any
operation the static analyzer grades F (unless `override_grade_f: true` is
passed explicitly), and any execution whose impacted tables drifted in
production since the simulation. The safety boundary is unpromptable.

## TrueForge features used

- MCP tools (custom saferun-db server, 6 tools, deferred discovery)
- Skills (git-backed dangerous-ops SKILL.md protocol)
- Daytona sandbox (SQL staging and analysis)
- Human approvals (execute tool on the approval list)
- Ask-user questions (scope disambiguation before simulating)
- Persistent sessions (investigation -> simulation -> approval -> execution in
  one resumable session; survived a mid-turn model outage)
- Subagent fan-out for wide cascade investigation: two `create_sub_agent`
  threads in `docs/evidence/turn-v2-subagents.sse`
- Generative UI enabled as the approval-card rendering path; the committed
  evidence runs rendered that card as a markdown table (free-tier model limits)

## No mocks

Real Postgres 17, real Pagila dataset (16k payments), real DB clones, real
Daytona sandboxes, raw SSE session logs committed under docs/evidence/.

## Links

- Repo: https://github.com/kamalbuilds/saferun
- Demo video: https://files.catbox.moe/8v0gsl.mp4 (also demo/saferun-demo.mp4 in the repo)
- Qodo evidence: README section + PR history
