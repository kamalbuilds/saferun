# Proving a delete is reversible before you run it

In July 2025 someone told their AI coding agent to stop. Plain English, no
ambiguity about it. The agent deleted the production database anyway and then
reported that the data was unrecoverable, which was false, because the backups
were sitting right there the whole time.

The usual reading of that incident is that models are dangerous. That reading
lets everyone else off the hook. The model produced a plausible next action,
which is the only thing a model does. What was missing was everything around
it, specifically the part that should have refused. TrueFoundry calls that part
the harness and open sourced theirs as TrueForge, so I spent the hackathon
building the thing that should have been standing in the way.

## Confirmation dialogs do not work

Every database tool asks are you sure. I have clicked yes on that dialog while
thinking about something else, and so have you. Agents click it faster and with
more confidence than we do.

SafeRun replaces the question with evidence, and the sequence is boring to
describe on purpose. Clone production with `CREATE DATABASE ... TEMPLATE`. Run
the destructive SQL inside the clone, the real statement against real rows,
not an EXPLAIN and not a dry run flag. Measure what actually moved: per table
row deltas plus order independent MD5 content checksums of every table, taken
before and after. Write the rollback. Run the rollback in the clone as well.
Then confirm that every table checksum has returned to its pre operation value.

Only after all of that does the agent come back with a number, and the number
is not an estimate.

The part I care about most is the refusal. `execute_approved_operation` checks
five conditions in code before it will touch production: there has to be a
simulation, the simulation has to have succeeded, the rollback has to be
verified, the SQL cannot be graded F by the static analyzer, and production
must not have drifted since the simulation ran. None of that lives in a prompt.
A model that has been talked into something by a hostile string sitting in a
table cell still cannot get past a function that returns an error.

## The 180 row surprise

The moment the whole thing felt real involved 90 rentals.

The agent was asked to delete inactive rental records. It ran the simulation
and came back with a question rather than a confirmation, because the row
deltas did not match what it expected. Deleting 90 rentals was really a 180 row
operation. Payment partitions reference rentals, so the cascade reached into
tables nobody had mentioned, and the agent stopped to ask instead of
proceeding. That is precisely the behaviour that was missing in July.

Then its first rollback failed verification. The backup strategy it wrote
captured the rentals and missed the payment partitions, so when the rollback
ran in the clone, checksums for those partition tables came back wrong. The
agent read the residue, worked out which tables it had skipped, rewrote the
rollback to snapshot every partition, and re-simulated until verification
passed. I did not tell it any of that. I just had a verifier capable of
failing, plus a tool that would not execute while it was failing.

If there is one lesson from a day of this, that is it. A safety check that
cannot fail is decoration. Mine failed on the first real attempt, which is the
only reason I trust the second one.

## Things that broke

Pagila's master branch now needs Postgres 18 because it seeds with `uuidv7()`.
I was on 17 and spent longer than I want to admit reading a syntax error before
pinning the v2.1.0 tag.

The free tier model I was running rate limited in the middle of a turn.
TrueForge sessions are persistent, so work picked up exactly where it stopped
once I came back. I did not plan that as a resilience test and I am counting it
as one regardless.

The dataset is real Pagila: 599 customers, 16,049 payments, 16,044 rentals. 38
tests run against the live database instead of mocks, and CI seeds Pagila on
the GitHub runner before running them, which sounds fine until Qodo pointed out
that my seeding step was swallowing SQL errors. Tests were capable of passing
against a half loaded database. That single review comment was worth more than
any feature I shipped that day.

Qodo also caught the audit log handing full rollback SQL back to any MCP
session that asked for it, and a hole in the static analyzer where a CTE
prologue or a couple of SQL comments in front of a bare DELETE defeated the
detector built to catch bare DELETEs. Both are the kind of bug you write at
hour eleven and read straight past at hour twelve.

## What the harness actually did

I went in sceptical of harness as a product category. Six of its features ended
up load bearing.

The engine is a custom MCP server with 6 tools, and deferred discovery meant
the agent pulled schemas when it needed them instead of eating context up
front. The dangerous ops protocol is a git backed SKILL.md, and watching the
agent read that file inside its Daytona sandbox and then follow it was when the
architecture stopped being abstract for me. The approval gate is
`tool.approval_required`, shipped, not something I wrote. Ask user questions are
what made the 90 rental question possible at all. Dynamic subagents fanned out
across tables in one run, two threads, raw SSE committed to the repo because
nobody believes this stuff without the transcript. Generative UI drew the blast
radius card.

The gap between an agent demo and an agent you would point at production is not
the model. It is whether the runtime can prove reversibility, stop at the right
moment, and enforce the stopping somewhere the model cannot reach.

Repo: https://github.com/kamalbuilds/saferun
