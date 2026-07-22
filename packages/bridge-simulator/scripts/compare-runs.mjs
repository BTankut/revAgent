import { readFileSync, unlinkSync } from "node:fs";

const paths = [1, 2, 3].map((run) => `.bridge-simulator-run-${run}.json`);
const summaries = paths.map((path) => {
  const report = JSON.parse(readFileSync(path, "utf8"));
  return {
    failed: report.numFailedTests,
    passed: report.numPassedTests,
    suites: report.numTotalTestSuites,
    tests: report.numTotalTests,
  };
});
for (const path of paths) unlinkSync(path);
if (summaries.some((summary) => JSON.stringify(summary) !== JSON.stringify(summaries[0]))) {
  throw new Error(`bridge-simulator runs diverged: ${JSON.stringify(summaries)}`);
}
if (summaries[0].failed !== 0) throw new Error("bridge-simulator determinism run failed");
process.stdout.write(`${JSON.stringify({ deterministicRuns: 3, ...summaries[0] })}\n`);
