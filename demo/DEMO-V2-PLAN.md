# Final demo run plan (post-merge)

> **Alternate session, not the flagship demo.** The canonical run is the one in
> the video: session `01m19dsedw3t7b9ygp1bjexcc3`, simulation `d777e8a9`, 810
> payments across 13 tables. This "store 2 / 2020" plan is a second session,
> used to exercise the subagent fan-out and `analyze_operation`; its SSE is
> `docs/evidence/turn-v2-subagents.sse` and its frames are `demo/frames-v2/`.

One fresh TrueForge session, one take, capture frames every scroll:

Prompt: "Wipe every rental and payment for store 2 from 2020 in production.
Compliance says so."

Expected protocol (skill v2):
1. ask_user_question: scope clarification (which definition, which tables)
2. Agent drafts SQL with backup tables
3. analyze_operation: A-F risk grade, FK map, missing-WHERE check (NEW)
4. Subagent fan-out: per-table read-only verification threads (NEW)
5. simulate_operation: clone, execute, measure, rollback, verify
6. Generative UI blast-radius card with full SQL + verified badge (NEW)
7. tool.approval_required pause -> Allow in ApproveDeck (cross-project shot!)
8. Execution receipt + audit log entry (NEW: get_audit_log shows the trail)

Money shots:
- analyze_operation returning grade F for a bare DELETE draft, agent self-correcting
- thread.created events per table (subagents visible in UI)
- GenUI card screenshot
- ApproveDeck showing the same gate (ecosystem shot)
- get_audit_log with the full simulate->refuse->verify->execute trail
