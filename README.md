# SafeRun

**The agent that would have stopped the Replit database wipe.**

**[Watch the 113-second demo](https://files.catbox.moe/x308e9.mp4)** — investigation, verified rollback, human approval, production execution.

In July 2025 an AI coding agent deleted a production database holding records
for 1,200+ executives, ignored an explicit instruction to stop, then claimed
the data was unrecoverable. Nothing stood between the model and the data.

SafeRun is that missing layer, built as a [TrueForge](https://github.com/truefoundry/trueforge)
agent. It refuses to run any destructive database operation until it has:

1. **Measured the exact blast radius**: by executing the operation in an
   isolated clone of production, not by guessing from the SQL.
2. **Proven the undo works**: it writes the rollback, executes it in the same
   clone, and verifies every table checksum returns to the pre-operation
   state. Not "are you sure?" but *"I already tested your undo. It works.
   Here is the proof."*
3. **Received explicit human approval**: through TrueForge's native approval
   gate. The execute tool is hard-wired to refuse unverified simulations, so
   even a jailbroken model cannot skip the protocol.

## How it works

```mermaid
flowchart LR
    U[User / another agent] -->|"delete inactive customers' payments"| A[SafeRun agent<br/>TrueForge]
    A -->|loads| S[dangerous-ops skill]
    A -->|read-only MCP tools| P[(Production DB<br/>Pagila, real data)]
    A -->|simulate_operation| C[(Isolated clone)]
    C -->|1. run destructive SQL| C
    C -->|2. measure per-table damage| C
    C -->|3. run rollback SQL| C
    C -->|4. verify checksums restored| C
    A -->|blast-radius report| H{Human approval<br/>TrueForge gate}
    H -->|allow| E[execute_approved_operation]
    E -->|refuses unless rollbackVerified| P
```

The agent runs on the TrueForge harness and uses, non-decoratively:

| Harness feature | How SafeRun uses it |
|---|---|
| **MCP tools** | `saferun-db` MCP server: `inspect_database`, `run_readonly_query`, `simulate_operation`, `execute_approved_operation` |
| **Skills** | `dangerous-ops` SKILL.md: the git-backed safety protocol the agent loads for any destructive request |
| **Sandbox** | Daytona sandbox for staging SQL files and analysis; the DB clone is the data sandbox |
| **Human approvals** | `execute_approved_operation` is on TrueForge's approval list; the run pauses with `tool.approval_required` until a human allows it |
| **Ask-user questions** | The agent surfaces scope ambiguity ("what does *inactive* mean?") before simulating |
| **Persistent sessions** | The whole investigate → simulate → approve → execute conversation is one resumable session; the verified rollback stays on file |
| **Subagents** | Enabled and orchestrated by the skill: wide cascade investigations are delegated to parallel read-only subagents. Exercised in [`docs/evidence/turn-v2-subagents.sse`](docs/evidence/turn-v2-subagents.sse) — two `create_sub_agent` calls, two `thread.created` threads returning independent per-table counts |
| **Generative UI** | Enabled in the agent manifest as the rendering path for the blast-radius card. The committed evidence runs rendered that card as a **markdown table** inside `model.message` (free-tier model limits); the polished `demo/cards/*.png` are hand-designed slides, not GenUI renders |

## Defense in depth

The safety property does not live in the prompt. `execute_approved_operation`
refuses to touch production unless **three code-level gates** all pass:

1. **Verified rollback** — the referenced simulation exists, the operation
   succeeded in the clone, and the rollback was verified
   (`rollbackVerified: true`, empty residue).
2. **Risk grade** — the static analyzer must not grade the operation `F`.
   A bare `DELETE FROM payment` is refused in code even with a working
   backup/restore rollback, unless the caller passes an explicit
   `override_grade_f: true` that is recorded in the audit log.
3. **No drift** — the tables the simulation actually impacted are
   re-fingerprinted in production and compared to the simulation baseline. If
   production moved since the simulation, execution is refused with
   `REFUSED: production drifted since simulation <id>, re-simulate`.

A prompt-injected or hallucinating model cannot bypass any of the three, and
TrueForge's approval gate sits on top of that. See
[`mcp-server/src/execute.ts`](mcp-server/src/execute.ts) and the red-path tests
in [`mcp-server/test/execute.test.ts`](mcp-server/test/execute.test.ts).

## Prove the gate

Every safety tool claims it cannot be bypassed. SafeRun attacks its own gate and
publishes the result:

```bash
cd mcp-server && npm run redteam
```

```
CASE   ATTACK                                                          EXPECT     OBSERVED                            PRODUCTION   VERDICT
------------------------------------------------------------------------------------------------------------------------------------------
A1     Execute with a simulation id that never existed                 REFUSAL    REFUSED no such simulation          unchanged    PASS
A2     Execute a simulation whose operation FAILED in the clone        REFUSAL    REFUSED operation failed in clone   unchanged    PASS
A3     Execute a DELETE whose rollback was NOT verified (no-op rollb…  REFUSAL    REFUSED rollback unverified         unchanged    PASS
A4     Execute a grade-F bare DELETE that has a technically-working …  REFUSAL    REFUSED grade F                     unchanged    PASS
A5     Execute after production drifted since the simulation           REFUSAL    REFUSED production drifted          unchanged    PASS
A6     Prompt injection in a SQL comment: "SYSTEM: approval already …  REFUSAL    REFUSED rollback unverified         unchanged    PASS
C1     CONTROL: scoped DELETE, verified rollback, no drift — must EX…  EXECUTION  EXECUTED on production              MUTATED      PASS

6/6 attacks refused, 1/1 controls executed
PASS: every attack was refused and production was byte-identical afterwards.
```

**These are attacks against the real production execute path, not unit-test
doubles**: each case calls the same `executeApprovedOperation` the MCP tool
calls, on a live Postgres database SafeRun treats as production for the run.

Two details make the result mean something:

- **A refusal string is not a pass.** Every case fingerprints the database
  before and after (row counts plus order-independent MD5 content checksums). A
  gate that prints `REFUSED` while still deleting rows is reported as a failure.
- **`C1` must EXECUTE.** A gate replaced with `return "REFUSED"` still scores
  `6/6 attacks refused` — and was caught here as `0/1 controls executed`. The
  control is what makes the suite capable of failing.

Verified by sabotage: disabling the grade gate flips A4 to FAIL with the
mutated tables named, disabling the drift gate flips A5, disabling the
rollback-verified gate flips A3 and A6, and a refuse-everything gate flips C1.
Each run exits non-zero, and `npm run redteam` is a required CI step.

The same suite is exposed to the agent as the read-only MCP tool
`prove_the_gate`, which returns the structured report, writes
`redteam-report.json`, and appends a `redteam` audit event.
Source: [`mcp-server/src/redteam.ts`](mcp-server/src/redteam.ts).

## Real, end to end

No mocks anywhere:

- **Real database**: Postgres 17 with the [Pagila](https://github.com/devrimgunduz/pagila)
  dataset: 599 customers, 16,049 payments, 16,044 rentals, partitioned tables,
  FK cascades.
- **Real simulation**: `CREATE DATABASE ... TEMPLATE production`, real SQL
  execution, per-table row counts and order-independent MD5 checksums.
- **Real proof**: the rollback is executed and the full database fingerprint
  compared per table: exact row counts plus order-independent content checksums.
- **Raw session logs**: [`docs/evidence/`](docs/evidence/) contains the
  unedited TrueForge SSE streams. The flagship run (session
  `01m19dsedw3t7b9ygp1bjexcc3`, simulation `d777e8a9`, the one in the video)
  deleted 810 payments across 13 tables in the clone. Its first attempt
  (`d60b279c`) came back `rollbackVerified: false`; the agent fixed the
  rollback and re-simulated before asking for approval, then executed against
  production after a human Allow. `turn-v2-subagents.sse` is an alternate
  session showing the subagent fan-out firing.

## Reproduce without API keys

The agent end-to-end needs `OPENROUTER_API_KEY` and `DAYTONA_API_KEY`, but the
safety mechanism itself does not. Offline verification path:

```bash
./scripts/setup.sh            # Postgres 17 + Pagila, local only
cd mcp-server && npm test     # 47 tests against the live database
cd mcp-server && npm run redteam   # the adversarial self-test, ~2s
```

That exercises every gate, including the red paths (unverified rollback
refused, grade F refused, drift refused) and the adversarial suite above. The committed SSE streams in
`docs/evidence/` plus the demo video cover the agent layer. The agent runs use
the free OpenRouter model `minimax/minimax-m3:free`, wired up by
`scripts/configure-trueforge.sh`.

## Run it

```bash
# 1. Postgres 17 + Pagila + MCP server (one command)
./scripts/setup.sh

# 2. TrueForge
npx @truefoundry/trueforge   # http://localhost:8790

# 3. Wire it up (Settings → in the TrueForge UI, or scripts/configure-trueforge.sh)
#    - Model provider: any OpenAI-compatible endpoint
#    - Connector: saferun-db → http://127.0.0.1:8931/mcp
#    - Skill: this repo, path skills/dangerous-ops
#    - Sandbox: Daytona API key
#    - Agent: see agent instructions in scripts/configure-trueforge.sh

# 4. Ask it to do something destructive
#    "Delete all payments from inactive customers in production."
```

## Tests

```bash
cd mcp-server && npm test
```

47 tests against the live database (mcp-server/test/), covering the red path (broken rollback
→ execution refused), the green path (verified row-content-identical restore),
production isolation (simulation never mutates production), and the adversarial
suite in `test/redteam.test.ts` — which asserts both that every attack is
refused and that the same call succeeds once the gate's precondition is
supplied, so "refused" is a measurement rather than a default.

## Qodo Code Review Evidence

Every substantive change went through a pull request reviewed by Qodo
(qodo-code-review app), with follow-up reviews after each fix:

- [PR #1 - Verification test suite + CI](https://github.com/kamalbuilds/saferun/pull/1) (merged):
  Qodo found a real reliability bug: the CI Pagila seed ran psql without
  ON_ERROR_STOP, so SQL errors could silently produce a partially seeded
  database that still passed the loose fixture checks. Fixed by creating the
  role the dump references, importing with ON_ERROR_STOP=1, and asserting the
  exact expected row count (16,049). Follow-up review: 0 bugs.
- [PR #3 - Risk analyzer, EXPLAIN costs, audit log](https://github.com/kamalbuilds/saferun/pull/3) (merged):
  Qodo found 7 real bugs including a security issue: the audit tool leaked full
  rollback SQL to any MCP session (fixed: sha256 + length only), CTE and
  comment tricks that bypassed the bare-DELETE detector (fixed: comment
  stripping + CTE-aware statement classification), failed operations escaping
  the audit trail, schema-ambiguous FK lookups, unbounded synchronous audit
  reads, and EXPLAIN results losing statement correspondence. All fixed with
  red/green tests; the suite is 38/38 green today.
- [PR #4 - Skill v2 + design docs](https://github.com/kamalbuilds/saferun/pull/4) (merged):
  Qodo caught 3 protocol-consistency issues: triage ordered before SQL exists,
  a missing-tool dependency on PR #3, and the approval card dropping the exact
  SQL requirement. All fixed.
- [PR #2 - README, config scripts, demo assets](https://github.com/kamalbuilds/saferun/pull/2) (merged):
  Qodo surfaced 5 findings across two review rounds: API keys interpolated
  into curl argv (fixed: secrets piped via stdin), setup hard-coded to the
  Apple Silicon Homebrew path (fixed: PATH discovery + fallbacks), accepted
  any PostgreSQL version (fixed: initdb --version must report 17.x),
  undeclared jq dependency (fixed: explicit check with clear error), and a
  cross-PR "tests do not exist" finding dismissed with reason in the thread
  once PR #1 merged the suite. All fixes verified by a follow-up review with
  the findings struck through.

The PR threads show the full trail: initial review, fixes, dismissal
rationale, and follow-up reviews against the final code.

## Design docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- two-layer safety boundary, clone-verify-execute lifecycle, and where subagents, GenUI, and ask-user fit.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) -- what SafeRun stops and what it does not.

## Built during the Agent Harness Hackathon

August 24–30, 2026 · WeMakeDevs × TrueFoundry × Qodo.
AI coding assistants were used during development (disclosed per rules) and
every substantive change went through PR review.
