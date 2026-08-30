# SafeRun

**The agent that would have stopped the Replit database wipe.**

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
| **Subagents** | Wide cascade investigations can be delegated to parallel read-only subagents |

## Defense in depth

The safety property does not live in the prompt. `execute_approved_operation`
refuses to touch production unless the referenced simulation exists, the
operation succeeded in the clone, and the rollback was **verified**
(`rollbackVerified: true`, empty residue). A prompt-injected or hallucinating
model cannot bypass it, and TrueForge's approval gate sits on top of that.

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
  unedited TrueForge SSE streams of the demo run: 810 payments deleted in
  the clone, rollback verified, human approval, production execution.

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

Eight tests against the live database (mcp-server/test/), covering the red path (broken rollback
→ execution refused), the green path (verified row-content-identical restore), and
production isolation (simulation never mutates production).

## Qodo Code Review Evidence

<!-- filled after review cycle -->

## Built during the Agent Harness Hackathon

August 24–30, 2026 · WeMakeDevs × TrueFoundry × Qodo.
AI coding assistants were used during development (disclosed per rules) and
every substantive change went through PR review.
