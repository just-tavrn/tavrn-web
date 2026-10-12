#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The "N flaky" line of a Playwright run for the GitHub job summary: reads the JSON report (the json reporter of the
// configs in CI), prints the counts, a warning annotation per test that passed only on a retry, appends both to
// $GITHUB_STEP_SUMMARY and sets the step output `flaky`. Retries are a safety net, never silent. A missing report (the
// run did not start) is noted, not an error. The organization's reusable e2e workflow does the same for the main suite.
//   node scripts/playwright-flaky.mjs apps/desktop-electron/test-results/results.json
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: playwright-flaky.mjs <Playwright JSON report>");
  process.exit(2);
}
const output = (key, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
if (!existsSync(file)) {
  console.log(`no Playwright JSON report at ${file}`);
  output("flaky", 0);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const flaky = [];
const walk = (suite, path) => {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "flaky") flaky.push(`${t.projectName || "default"} › ${spec.file}:${spec.line} › ${[...path, spec.title].join(" › ")}`);
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
};
for (const top of report.suites ?? []) walk(top, []);
const stats = report.stats ?? {};
const line = `Playwright: ${stats.expected ?? 0} passed, ${flaky.length} flaky, ${stats.unexpected ?? 0} failed, ${stats.skipped ?? 0} skipped`;
const escape = (m) => m.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
console.log(line);
for (const f of flaky) console.log(`::warning title=Flaky test (passed only on a retry)::${escape(f)}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n${flaky.length ? `\n${flaky.map((f) => `- ${f}`).join("\n")}\n` : ""}`);
}
output("flaky", flaky.length);
