# SafeRun Threat Model

This document describes what SafeRun's two safety layers stop, and what they
explicitly do not stop.

## What it stops

### Prompt injection reaching `execute_approved_operation`

A prompt-injected or jailbroken model cannot reach `execute_approved_operation`
without a simulation id that exists in the in-process store and has
`rollbackVerified: true`. The store is written only by `simulate_operation`.
No prompt can fabricate a valid id. `refusalReason()` in
`mcp-server/src/simulate.ts` is a compiled code check, not an instruction.

### Unverified rollbacks

The rollback SQL is actually executed inside the clone and every table
checksum is diffed against the pre-operation fingerprint. If a single table
is not restored to its exact row count and content MD5, `rollbackVerified`
stays false and `refusalReason()` blocks execution. "Are you sure the rollback
works?" is replaced with "I ran it. Here is the per-table proof."

### Hidden FK blast radius

`analyze_operation` queries `information_schema` for every FK relationship
reaching or from the target tables before any SQL runs. The wide fan-out rule
spreads per-table row-count verification across parallel subagents so no
cascade path is counted only once by a single sequential pass.

### Same-turn simulate-and-execute race

The skill protocol enforces a hard turn boundary: the agent renders the
approval card and stops. `execute_approved_operation` cannot be called in the
same turn as `simulate_operation`. TrueForge's approval gate pauses the run at
the harness layer for a human click.

### Grade-F bare-destructive operations

`analyze_operation` gives grade F to any bare DELETE or UPDATE with no WHERE
clause (score >= 55). The skill refuses to proceed past Step 0 until the human
explicitly overrides with "proceed despite grade F". This catches the
hallucination pattern where a model drops a WHERE clause under pressure.

## What it does NOT stop

### Clone-vs-production scale drift

The clone is created from production at simulation time via
`CREATE DATABASE ... TEMPLATE`. If production is under heavy write load between
simulation and execution, the clone does not reflect inserts or updates that
arrived after the snapshot. Row counts in the blast-radius report may be
slightly stale. A per-row content lock before execution is out of scope.

### A malicious or compromised DBA

A database administrator with direct `psql` access bypasses the entire SafeRun
harness. SafeRun guards only the agent execution path through the MCP server.
Database-level RBAC and audit logs (Postgres `pgaudit`) are a separate control
plane.

### Schema-only damage that row checksums miss

The fingerprint is row count + order-independent MD5 of row content. A DDL
operation that drops a column or changes a column type but leaves row counts
and the content of remaining columns unchanged will not show residue in
`rollbackResidue`. Schema diffing (comparing `information_schema.columns`
before and after) is not currently implemented.

### Subagent instruction override

The skill instructs subagents not to call `execute_approved_operation` or
`simulate_operation`. A sufficiently adversarial prompt injected into the
subagent's context could attempt to override this. The harness-layer approval
gate still fires even for subagent tool calls, so a human click is still
required, but the subagent could in theory initiate the approval flow on a
different simulation id.
