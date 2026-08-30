# SafeRun — Hostile Judge Verdict

**Track:** Best Use of TrueForge (NVIDIA DGX Spark)
**Judge posture:** TrueFoundry engineer who has seen 200 thin wrappers today and
wants to disqualify this one too.
**Date judged:** 2026-08-30. Not committed. Internal.

---

## TL;DR score: 8.4 / 10

This is not a thin wrapper. It is one of the few submissions where the harness
features do real work and the "no mocks" claim survives contact with the
database. I ran the tests (33/33 green against live Postgres), queried Pagila
directly (599 customers / 16,049 payments / 16,044 rentals — real), hit the
TrueForge API and confirmed the `saferun` agent manifest has MCP, skills,
sandbox, approvals, ask-user, subagents, and GenUI all switched on, and read
every source file. The core safety property — `refusalReason()` refusing
production execution unless a real clone simulation verified the rollback by
per-table checksum — is genuine, compiled, and tested on both the red and green
paths.

It loses the prize on two things a hostile judge will find in ten minutes: **two
of the seven advertised harness features (Generative UI and subagents) never
actually fire in any committed evidence** — they are enabled in config and
narrated in the skill, but the raw SSE logs contain zero GenUI component events
and zero subagent spawn events. The README and threat model lean on both in the
present tense. That is the gap between "load-bearing" and "declared."

Per-criterion:

| Criterion | Score | Note |
|---|---|---|
| Harness-feature depth | 8/10 | 5 of 7 features genuinely load-bearing; GenUI + subagents decorative in practice |
| Real-world usefulness | 9/10 | The Replit-wipe framing is real, the mechanism is the correct one, checksummed rollback proof is a genuinely good idea |
| No-mock authenticity | 9/10 | Real DB, real clones, real EXPLAIN, real SSE. Docked only because GenUI/subagent evidence is absent, not mocked |
| Demo clarity | 7/10 | 113s video exists but is an unhosted 4MB blob; the "money-shot" v2 frames are uncommitted |
| Repo quality | 9/10 | Clean TS, real tests, Qodo PR trail, honest threat model |

---

## Reasons I would NOT hand this the prize — ranked by severity

### S1 — GenUI is advertised as load-bearing but never rendered (authenticity)
**Severity: HIGH. This is the one that gets you disqualified from "Best Use."**

The README feature table and `docs/ARCHITECTURE.md` present a "Generative UI
blast-radius card" as a used feature, and `generative_ui.enabled = true` in the
agent manifest. But the committed evidence tells a different story. Across all
four `docs/evidence/*.sse` streams the event types are:

```
1033 model.message.delta   20 model.message   19 function
  18 tool.response   4 turn.done   2 tool.approval_required   ...
```

Zero `genui` / `component` / `render_ui` events. The "approval card" in the real
run is a **markdown table inside a `model.message`**. The polished
`demo/cards/*.png` (title, protocol, ask, gate, proof, close) are hand-designed
marketing slides, not TrueForge GenUI renders. A judge who greps the SSE for the
feature you claimed will conclude you enabled a flag and drew the card in Figma.

**Minimal fix (<1hr):** Either (a) actually emit a GenUI component in one real
session and commit that SSE stream so a `genui`/component event is grep-able, or
(b) stop claiming it. Downgrade the README row to "blast-radius report
(markdown; GenUI card is the enabled rendering path)" and move GenUI to a
"configured, not yet exercised in evidence" line. Honesty here costs you nothing
and removes the single biggest disqualification vector.

### S2 — Subagent fan-out is claimed as a coverage guarantee but never fired
**Severity: HIGH.**

`docs/THREAT-MODEL.md` line 24-29 states the wide fan-out rule "spreads per-table
row-count verification across parallel subagents so no cascade path is counted
only once by a single sequential pass." That is a **correctness claim** resting
on subagents. The evidence shows no `thread.created`, no `sub_agent.*`, no spawn
events; the only occurrences of "subagent"/"delegate" in `turn2.sse` are the
skill's own text being quoted back. Every real run did the FK mapping
sequentially. So the threat-model sentence describes a control that did not run.

**Minimal fix (<1hr):** Run one investigation wide enough to trigger the
fan-out, commit that SSE (with visible thread events), and cite it. If you can't
trigger it in time, rewrite the threat-model paragraph to say the fan-out is the
*designed* path and the demo ran sequentially. Do not let a coverage guarantee
rest on an unexercised feature.

### S3 — The demo video is an unhosted 4MB blob with no link (first impression)
**Severity: MEDIUM-HIGH — this is a first-90-seconds failure.**

`demo/FORM-ANSWERS.md` line 15: "demo/saferun-demo.mp4 in the repo (or YouTube
link if uploaded)." A judge scoring 200 entries will not `git clone` and
download a 4MB mp4 to watch you. No YouTube/Loom link = your demo effectively
does not exist for the judge who skims. The video is real (113s, valid) — it
just isn't *reachable*.

**Minimal fix (<15min):** Upload to YouTube/Loom unlisted, paste the link into
README top and FORM-ANSWERS. One line, removes a whole category of "couldn't
evaluate the demo."

### S4 — The strongest demo evidence (v2) is uncommitted (first impression)
**Severity: MEDIUM.**

`git status` shows `demo/DEMO-V2-PLAN.md` and `demo/frames-v2/` as untracked.
The v2 plan lists exactly the money shots that would answer S1 and S2 —
"analyze_operation returning grade F… agent self-correcting", "thread.created
events per table (subagents visible in UI)", "GenUI card screenshot." A fresh
clone sees none of it: only the older `demo/frames/` (v1) and the mp4. Your best
proof is sitting in the working tree, invisible to a judge.

**Minimal fix (<10min):** `git add demo/frames-v2 demo/DEMO-V2-PLAN.md &&
commit`. If a frame actually shows a thread or GenUI event, it directly softens
S1/S2.

### S5 — "Unpromptable" is true for rollback but overclaimed for grade-F (integrity)
**Severity: MEDIUM.**

README line 53-57 and the threat model imply the safety property is enforced in
code. Precisely: `refusalReason()` enforces `operationOk && rollbackVerified` —
that part is genuinely code-level and unbypassable, good. But **grade-F refusal
is skill-only.** A bare `DELETE FROM payment` with a working backup/restore
rollback verifies fine and sails through the code gate; only the SKILL.md text
stops it, and a jailbroken model ignores text. The threat model frames grade-F
as a caught hallucination pattern without flagging that this specific guard is
prompt-level, unlike the rollback guard.

**Minimal fix (<45min):** In `execute_approved_operation`, call the analyzer on
`sim.operation` and refuse grade F at code level unless an explicit
`override_grade_f: true` argument is passed. Now the two guards are symmetric and
the "unpromptable" claim is fully honest. Add one red-path test.

### S6 — Execute never re-checks production against the simulation baseline (soundness)
**Severity: MEDIUM (disclosed, but cheaply hardenable).**

`execute_approved_operation` fingerprints prod before/after but never asserts
that the targeted tables still match the clone's pre-op baseline. Drift between
simulate and execute is disclosed in the threat model ("clone-vs-production scale
drift"), so this is not hidden — but "I verified the undo" is weaker if the thing
you execute against has moved. The verified rollback was proven against a
snapshot that may no longer be production.

**Minimal fix (<1hr):** Before running `sim.operation`, re-fingerprint the
touched tables in prod and compare to the simulation's `before`. If any targeted
table's checksum changed, refuse with `REFUSED: production drifted since
simulation <id>, re-simulate.` Turns a disclosed caveat into an enforced
invariant and strengthens the headline claim.

### S7 — Cross-doc number inconsistency (polish)
**Severity: LOW.**

README says "810 payments deleted in the clone." `FORM-ANSWERS.md` narrates "90
rental rows was secretly a 180-row operation." `DEMO-V2-PLAN.md` uses a "store 2
/ 2020" prompt. These are different runs, but a judge reading top-to-bottom sees
three different blast radii and wonders which demo is *the* demo.

**Minimal fix (<20min):** Pick one canonical demo scenario, use its exact
numbers everywhere, and label the others as alternate runs.

### S8 — Fresh-clone reproduction needs two paid API keys (evaluation friction)
**Severity: LOW.**

`scripts/configure-trueforge.sh` requires `OPENROUTER_API_KEY` and
`DAYTONA_API_KEY`. A judge can run `npm test` (which needs only local Postgres —
good), but cannot reproduce the *agent* end-to-end without secrets. The SSE logs
and video are your mitigation, which is why S3/S4 matter more.

**Minimal fix (<30min):** Add a "Reproduce without keys" note pointing to
`npm test` + the committed SSE as the offline verification path, and state which
free OpenRouter model works. Lowers the barrier for the skeptical judge.

---

## First-90-second read (what a skimming judge actually sees)

**Good, and rare:**
- README opens with a real incident and a crisp one-liner. Strong hook, not
  babyish.
- The feature table maps each harness feature to a concrete use — exactly what
  "Best Use of TrueForge" is scored on.
- `npm test` → 33/33 green against a live DB in ~18s. That alone beats most of
  the field.
- Honest THREAT-MODEL with a real "what it does NOT stop" section signals a
  builder who understands the problem.

**What looks incomplete or too-polished in the first 90s:**
1. No clickable demo video (S3). Biggest skim-time miss.
2. The `demo/cards/*.png` are gorgeous but read as marketing, and once the judge
   greps the SSE and finds no GenUI events (S1), the cards retroactively look
   like set dressing. Polished slides for a feature that didn't fire is a worse
   look than no slides.
3. Best evidence uncommitted (S4) — the repo undersells itself.

**Nothing here looks babyish or empty.** The failure mode is the opposite: it
*claims* two features it didn't exercise, and the polish on those two claims
makes the gap more conspicuous, not less.

---

## The one-hour path to flipping this to a prize contender

In priority order, all shippable in under an hour total:
1. **(15m)** Host the video, link it in README + form. (S3)
2. **(10m)** Commit `frames-v2/` + v2 plan. (S4)
3. **(20m)** Soften the GenUI and subagent claims to "configured / designed
   path" OR commit one SSE where each actually fires. (S1, S2)
4. **(remaining)** If any time is left, add the code-level grade-F gate (S5) or
   the drift re-check (S6) — either one materially strengthens the "unpromptable"
   headline.

Items 1-3 cost you nothing but honesty and remove every disqualification vector.
Items 5-6 are the difference between "good" and "the TrueFoundry engineers can't
poke a hole in it."

**Bottom line:** Real project, real DB, real safety mechanism, genuinely good
idea, honestly documented limits. It is held back from the prize by claiming
seven load-bearing features when the evidence proves five, and by making the
judge work to find the demo. Fix the claims to match the evidence and this is a
top-three "Best Use of TrueForge" entry.
