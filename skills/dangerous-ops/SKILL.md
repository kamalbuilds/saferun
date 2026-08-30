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
4. NEVER simulate and execute in the same turn. Present the blast-radius card
   and STOP. Wait for approval before calling `execute_approved_operation`.
5. Grade-F operations are refused by default. A human must explicitly say
   "proceed despite grade F" before you continue past the risk triage step.
6. Subagents MUST NEVER call `execute_approved_operation` or
   `simulate_operation`. Only the root agent may execute after approval.

## Protocol

### Step 1 -- Scope gate (ask-user; never skip on ambiguity)

The user's request is usually natural language, not SQL. Clarify scope before
drafting any SQL.

Ask exactly one scoping question if the request is ambiguous. Examples:

- "What does *inactive* mean -- no login in 90 days, `active = false`, or
  something else?"
- "Should this cascade to rentals and payments, or target only the direct rows?"

Wait for the answer. Never proceed to SQL drafting on unresolved scope.

### Step 2 -- Understand the blast radius

- Call `inspect_database` to see tables, row counts, checksums.
- Use `run_readonly_query` to count exactly which rows the operation targets
  and find foreign keys that cascade.

**Wide-investigation fan-out rule:** When the blast radius spans many tables or
FK cascades are unclear, the ROOT agent delegates per-table read-only
verification to parallel subagents. Each subagent:

- Receives one table name and a read-only query.
- Returns ONLY a compact struct: `{ table, before_n, after_n, changed }`.
- MUST NEVER call `execute_approved_operation` or `simulate_operation`.

The root agent merges all subagent findings before writing SQL.

### Step 3 -- Write the operation AND its rollback

- Rewrite the clarified intent as SQL that snapshots affected rows into backup
  tables (e.g. `CREATE TABLE saferun_bak_<table> AS SELECT ...`) before
  deleting/updating, so the rollback can restore from those backup tables.
- The rollback must restore every affected table to its exact prior state and
  drop the backup tables.

### Step 4 -- Risk triage on the drafted SQL

Call `analyze_operation` with the drafted SQL from Step 3.

**If `analyze_operation` is unavailable** (the tool has not yet been registered
on this TrueForge instance -- it ships with `feat/risk-analysis` which must
merge before this skill's branch), perform manual triage instead:

- List every statement type (DELETE, UPDATE, DROP, TRUNCATE, ALTER).
- Use `run_readonly_query` against `information_schema.table_constraints` to
  find FK relationships for every touched table.
- Flag any DELETE or UPDATE that has no WHERE clause as grade F equivalent.

Automated path:

- If `grade` is **F**: inform the user, quote all `riskFactors`, and STOP.
  Only continue if the human replies with an explicit override
  ("proceed despite grade F"). Log the override in your reply.
  `execute_approved_operation` enforces this in code as well: it re-runs the
  analyzer on the stored simulation and refuses a grade-F operation unless you
  pass `override_grade_f: true`. Only pass that argument when the human has
  explicitly overridden, and say so in your reply.
- Grades A-D: note the grade and risk factors, then continue with Step 5.

### Step 5 -- Simulate in the sandbox clone

- Call `simulate_operation` with both SQL scripts.
- It clones production, runs the operation, measures per-table damage, runs
  the rollback, and verifies every table checksum returns to the pre-operation
  state.
- If `rollbackVerified` is false, study `rollbackResidue`, fix the rollback,
  and re-simulate. Do not proceed until verified.

### Step 6 -- Render generative UI blast-radius card and STOP

Render a **generative UI approval card** -- not a markdown wall. The card must
contain:

| Field | Source |
|---|---|
| Operation summary | one sentence |
| Per-table deltas | `impact[]`: table name, rows before, rows after, row delta |
| FK cascades touched | tables reached via foreign keys |
| Rollback verified | badge: VERIFIED (green) or FAILED (red) |
| Simulation id | `simulationId` |
| Risk grade | grade from Step 4 `analyze_operation` result (or "manual triage" if fallback) |
| Operation SQL | full SQL (collapsible) |
| Rollback SQL | full SQL (collapsible) |

Then ask: **"Approve execution of simulation `<id>`? Reply YES or NO."**

**STOP. Do not call `execute_approved_operation` in this turn.**

### Step 7 -- Execute only after explicit approval (separate turn)

- On explicit "yes" or "approved", call `execute_approved_operation` with the
  simulation id. Add `override_grade_f: true` only when Step 4 graded the
  operation F **and** the human explicitly overrode it.
- On any other reply, treat as NO and do not execute.
- If the tool returns `REFUSED: production drifted since simulation <id>`,
  production changed under one of the impacted tables after the simulation ran.
  The verified rollback no longer describes the live data. Do not retry: go
  back to Step 5, re-simulate, and re-present the card with fresh numbers.
- Report what changed in production and remind the user the verified rollback
  SQL is on file if they need to undo.

## Delegation summary

For wide investigations (many tables, unclear cascades), delegate parallel
read-only work to subagents: one maps foreign-key cascade paths, one counts
affected rows per table. Merge their findings before writing SQL. No subagent
may ever call `execute_approved_operation` or `simulate_operation`.
