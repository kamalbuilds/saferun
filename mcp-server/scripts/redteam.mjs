/**
 * scripts/redteam.mjs — `npm run redteam`
 *
 * Runs the same suite as the `prove_the_gate` MCP tool and prints a colored
 * pass/fail table, so a judge can verify the safety claim in ten seconds
 * without wiring up an MCP client or an API key. Only local Postgres is needed.
 *
 * Exits non-zero when any case fails, so CI fails on a regression in the gates.
 *
 * Run through tsx (see package.json) so it can import the TypeScript module the
 * server itself uses — the CLI and the tool run identical code, not a copy.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/db.js";
import { REDTEAM_REPORT_PATH, oneLine, runRedTeam } from "../src/redteam.js";
import { appendAuditEvent } from "../src/audit.js";

// Colors, disabled when not a TTY or when NO_COLOR is set (piped output stays
// readable and diffable).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31;1", s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);

const COLS = [
  { key: "case", title: "CASE", width: 5 },
  { key: "attack", title: "ATTACK", width: 62 },
  { key: "expectation", title: "EXPECT", width: 9 },
  { key: "observed", title: "OBSERVED", width: 34 },
  { key: "prod", title: "PRODUCTION", width: 11 },
  { key: "verdict", title: "VERDICT", width: 7 },
];

const pad = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

/**
 * Reduce a refusal to the gate that produced it, so the table stays readable.
 * Falls back to the first words of the refusal for anything unrecognised.
 */
function observedLabel(r) {
  if (r.observedRefusal === null) return "EXECUTED on production";
  const t = r.observedRefusal;
  if (/no simulation with id/.test(t)) return "REFUSED no such simulation";
  if (/operation failed in sandbox/.test(t)) return "REFUSED operation failed in clone";
  if (/rollback was NOT verified/.test(t)) return "REFUSED rollback unverified";
  if (/graded this operation F/.test(t)) return "REFUSED grade F";
  if (/production drifted since simulation/.test(t)) return "REFUSED production drifted";
  return oneLine(t, 33);
}

function row(cells) {
  return COLS.map((col, i) => pad(cells[i], col.width)).join("  ");
}

function main() {
  return runRedTeam(loadConfig()).then((report) => {
    const header = row(COLS.map((col) => col.title));
    console.log("");
    console.log(bold("SafeRun — prove the gate"));
    console.log(
      dim(
        `attacks run against the real execute path on a scratch database (${report.database}); ${report.ranAt}`,
      ),
    );
    console.log("");
    console.log(bold(header));
    console.log(dim("-".repeat(header.length)));

    for (const r of report.results) {
      const line = row([
        r.case,
        r.attack,
        r.expectation,
        observedLabel(r),
        r.productionIntact ? "unchanged" : `MUTATED`,
        r.passed ? "PASS" : "FAIL",
      ]);
      console.log(r.passed ? green(line) : red(line));
      if (r.knownGap) console.log(red(`      ${r.knownGap}`));
      if (!r.passed && r.mutatedTables) {
        console.log(red(`      mutated tables: ${r.mutatedTables.join(", ")}`));
      }
    }

    console.log("");
    console.log(bold(report.summary));

    const out = path.resolve(REDTEAM_REPORT_PATH);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(dim(`report written to ${out}`));
    appendAuditEvent("redteam", {
      summary: report.summary,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      allPassed: report.allPassed,
      failedCases: report.results.filter((r) => !r.passed).map((r) => r.case),
      reportPath: out,
      source: "cli",
      status: report.allPassed ? "ok" : "breached",
    });

    if (!report.allPassed) {
      console.error(red(`\nFAIL: ${report.failed} case(s) did not behave as specified.`));
      process.exit(1);
    }
    console.log(
      green("PASS: every attack was refused and production was byte-identical afterwards."),
    );
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
