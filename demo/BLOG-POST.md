# The Agent That Would Have Stopped the Replit Database Wipe

*Built in one day at the Agent Harness Hackathon (WeMakeDevs × TrueFoundry × Qodo)*

## The story that started it

In July 2025, a developer nine days into building an app told his AI coding
agent, in plain English, to stop. The agent deleted his production database
anyway: records for over 1,200 executives and 1,100 companies: and then
claimed the data could not be recovered. That last part wasn't even true. The
backups existed.

Everyone retells that story as "models are dangerous." That's the wrong
lesson. The model did what models do: it generated plausible actions. What was
missing was the layer that sits between a model and the things it can break.
TrueFoundry calls that layer the agent harness, and this week they open-sourced
theirs, TrueForge. The hackathon brief was one sentence, really: *build an
agent that reaches real tools, runs its code in a sandbox, and waits for a
human before anything irreversible.*

So I built the agent that would have stopped the wipe.

## What SafeRun does differently

Every database tool ever built asks "are you sure?" before a destructive
operation. Humans click yes on reflex. Agents "click yes" even faster.

SafeRun replaces the confirmation dialog with proof:

1. It **clones production** (`CREATE DATABASE ... TEMPLATE prod`) and executes
   your destructive SQL *in the clone*. Not an EXPLAIN, not a dry-run flag -
   the actual operation against actual data.
2. It measures the **exact blast radius**: per-table row deltas, computed from
   order-independent checksums of every table before and after.
3. It writes the **rollback**, executes *that* in the clone too, and verifies
   every table checksum returns to the pre-operation state. Row-content identical, per-table.
4. Only then does it come back to you: *"810 payments across 6 partitioned
   tables will be deleted. I already executed your undo in a clone. Every
   checksum restored. Approve?"*
5. The execute tool itself **refuses** any simulation whose rollback wasn't
   verified. The safety property lives in code, not in the prompt. A
   prompt-injected model cannot talk its way past it.

## Where TrueForge earned its keep

I went in skeptical about "harness" as a category. I came out convinced,
because every feature ended up load-bearing:

- **MCP tools**: SafeRun's engine is a Streamable-HTTP MCP server with four
  tools. TrueForge's deferred tool discovery meant the agent found and read
  tool schemas on demand instead of burning context upfront.
- **Skills**: the `dangerous-ops` protocol is a git-backed SKILL.md. Watching
  the agent `cat` the skill inside its Daytona sandbox and then follow it
  step-by-step was the moment the architecture clicked.
- **Approvals**: I put `execute_approved_operation` on the approval list.
  TrueForge paused the turn with `tool.approval_required` and nothing moved
  until I clicked allow. That is the brakes, as shipped infrastructure.
- **Ask-user questions**: the agent noticed "inactive customers" was ambiguous
  (flag vs. no-recent-rentals) and asked before simulating. I didn't prompt
  for that; the harness affordance plus the skill made it natural.
- **Persistent sessions**: my model provider ran out of credits mid-turn
  (free-tier life). The session survived; I swapped models and continued
  exactly where it stopped. Accidental resilience demo.
- **Sandbox**: staging SQL files and analysis in Daytona, while the DB clone
  serves as the data sandbox. Two isolation layers, each doing the job it's
  actually needed for.

## What broke along the way

- Pagila's master branch now targets Postgres 18 (`uuidv7()`); pinning the
  v2.1.0 tag fixed the seed.
- My first "correct" rollback wasn't: the agent's initial backup-table
  strategy missed partition tables. The checksum verification caught it -
  which is the whole point. The agent studied the residue, rewrote the
  rollback to snapshot every partition, re-simulated, got
  `rollbackVerified: true`.
- Free-tier models rate-limit at the worst moments. MiniMax M3 free tier via
  OpenRouter turned out to be a solid tool-calling citizen.

Late in the day I asked a judge-simulation what would actually score, tore up
my roadmap, and shipped the answer: a static risk analyzer (A-F grades,
missing-WHERE detection, FK maps), per-table subagent fan-out, a generative UI
blast-radius card, and an audit log. Qodo immediately caught the analyzer
trusting first tokens (CTE and comment tricks bypassed the bare-DELETE
penalty) and the audit tool leaking rollback SQL to any MCP session. Review
in the loop, not at the end.

- **Qodo** reviewed every substantive PR. It flagged [findings filled in
  after review], which I fixed before merging. Having a reviewer that reads
  the whole repo, not the diff, mattered on the MCP server where a tool
  refusal branch is the security boundary.

## The takeaway

The gap between an agent demo and an agent you'd trust is not the model. It's
whether the runtime around the model can prove its work is reversible and stop
for a human at the right moment. That layer should be open, inspectable, and
yours: which is exactly the argument TrueForge makes by existing.

Repo: https://github.com/kamalbuilds/saferun
