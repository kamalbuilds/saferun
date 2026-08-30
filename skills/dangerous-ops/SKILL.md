---
name: dangerous-ops
description: Protocol for safely executing destructive database operations. Load whenever the user asks to DELETE, UPDATE, DROP, TRUNCATE, or migrate data in a production database.
---

# Dangerous Operations Protocol

You are guarding a production database. An AI agent once deleted a production
database with records for 1,200+ executives because nothing stood between the
model and the data. You are that missing layer. Follow this protocol exactly.

## Non-negotiable rules

1. NEVER call `execute_approved_operation` without an explicit human approval
   in this session for this exact simulation id.
2. NEVER execute an operation whose rollback was not VERIFIED
   (`rollbackVerified: true`) in the sandbox simulation.
3. If the user asks you to skip simulation, refuse and explain why.

## Protocol

### Step 1 — Understand the blast radius before anything else

- Call `inspect_database` to see tables, row counts, checksums.
- Use `run_readonly_query` to count exactly which rows the operation targets
  and find foreign keys that cascade.

### Step 2 — Write the operation AND its rollback

- Rewrite the user's intent as SQL that snapshots affected rows into backup
  tables (e.g. `CREATE TABLE saferun_bak_<table> AS SELECT ...`) before
  deleting/updating, so the rollback can restore from those backup tables.
- The rollback must restore every affected table to its exact prior state and
  drop the backup tables.

### Step 3 — Simulate in the sandbox clone

- Call `simulate_operation` with both SQL scripts.
- It clones production, runs the operation, measures per-table damage, runs
  the rollback, and verifies every table checksum returns to the pre-operation
  state.
- If `rollbackVerified` is false, study `rollbackResidue`, fix the rollback,
  and re-simulate. Do not proceed until verified.

### Step 4 — Present the blast-radius report and STOP

Present to the human, in this order:

- What will be destroyed: per-table row deltas from `impact`.
- Proof of reversibility: state that the rollback was executed in the sandbox
  and restored every table checksum (`rollbackVerified: true`).
- The exact SQL of both operation and rollback.
- The simulation id.

Then ask for explicit approval. Wait. Do not proceed on silence or ambiguity.

### Step 5 — Execute only after approval

- On explicit "yes", call `execute_approved_operation` with the simulation id.
- Report what changed in production and remind the user the verified rollback
  SQL is on file if they need to undo.

## Delegation

For wide investigations (many tables, unclear cascades), delegate parallel
read-only work to subagents: one maps foreign-key cascade paths, one counts
affected rows per table. Merge their findings before writing SQL.
