import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const manifestPath = resolve(scriptDirectory, "../readiness/gw13-manifest.json");
const vitestPath = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function flattenAssertions(report) {
  const assertions = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      assertions.push({
        file:
          typeof file.name === "string"
            ? relative(repositoryRoot, file.name).replaceAll("\\", "/")
            : null,
        name: assertion.fullName ?? assertion.title ?? "",
        status: assertion.status ?? "unknown",
      });
    }
  }
  return assertions;
}

function evidence(group, assertions) {
  const checks = group.tests.map((selector) => {
    const matches = assertions.filter((assertion) => assertion.name.includes(selector));
    return {
      selector,
      status:
        matches.length === 0
          ? "missing"
          : matches.every((match) => match.status === "passed")
            ? "passed"
            : "failed",
      matches,
    };
  });
  return {
    ...group,
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks,
  };
}

const outputPath = resolve(
  repositoryRoot,
  argument("--output", "packages/gateway/artifacts/gw13-readiness.json"),
);
const sourceRevision = argument(
  "--source-revision",
  process.env.EXPECTED_HEAD_SHA ?? "local-worktree",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "revagent-gw13-"));
const vitestOutput = join(temporaryDirectory, "vitest.json");

let vitest = { status: 1, stdout: "", stderr: "" };
let assertions = [];
try {
  const result = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      ...manifest.testFiles,
      "--reporter=json",
      `--outputFile=${vitestOutput}`,
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  vitest = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  try {
    assertions = flattenAssertions(JSON.parse(readFileSync(vitestOutput, "utf8")));
  } catch {
    assertions = [];
  }

  const cases = manifest.cases.map((item) => evidence(item, assertions));
  const seams = manifest.res14Seams.map((item) => evidence(item, assertions));
  const liveSmoke = spawnSync(
    process.execPath,
    [
      resolve(scriptDirectory, "gw13-live-smoke.mjs"),
      "--endpoint",
      "https://gateway.invalid/mcp",
      "--client",
      "selected-codex-desktop",
      "--client-build",
      "post-m3-m5",
      "--token-env",
      "REVAGENT_GW13_SMOKE_TOKEN",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  let liveSmokeReport;
  try {
    liveSmokeReport = JSON.parse(liveSmoke.stdout ?? "");
  } catch {
    liveSmokeReport = undefined;
  }
  const liveSmokeReady =
    liveSmoke.status === 0 &&
    liveSmokeReport?.execute === false &&
    liveSmokeReport.state === "dry_run_ready" &&
    liveSmokeReport.target === null;
  const passed =
    vitest.status === 0 &&
    liveSmokeReady &&
    cases.every((item) => item.status === "passed") &&
    seams.every((item) => item.status === "passed");
  const report = {
    schema: "revagent.gw13-readiness/v1",
    planRow: manifest.planRow,
    sourceRevision,
    authoritative: false,
    evidenceState: passed ? "passed" : "failed",
    acceptanceState: "awaiting_milestone_owner",
    boundaries: {
      fakeAuthOnly: true,
      oauthPassed: false,
      externalClientHandsOnPassed: false,
      liveRevitPassed: false,
      apsRuntimeActivated: false,
      modeBActivated: false,
    },
    summary: {
      caseCount: cases.length,
      passedCaseCount: cases.filter((item) => item.status === "passed").length,
      res14SeamCount: seams.length,
      passedRes14SeamCount: seams.filter((item) => item.status === "passed").length,
      executedAssertionCount: assertions.length,
      liveSmokeDryRunReady: liveSmokeReady,
      liveSmokeDryRunTargetless: liveSmokeReport?.target === null,
    },
    cases,
    res14Seams: seams.map((seam) => ({
      ...seam,
      acceptanceState: "awaiting_owner_acceptance",
    })),
    manualObligations: [
      "WP9 C01-C14 must still be run hands-on against the selected Codex Desktop build.",
      "OAuth/DCR, token refresh/revoke, Turkish UX, visible progress/cancel, downloaded-file opening and Revit-visible results are not proven here.",
      "The live-smoke command requires a caller-supplied approved workstation target and may execute only after M3/M5 integration with an approved endpoint and credential.",
      "P6-T1 passed-to-accepted remains a milestone-owner decision.",
    ],
    diagnostics: passed
      ? []
      : [
          {
            vitestExitCode: vitest.status,
            vitestStdout: vitest.stdout.slice(-4000),
            vitestStderr: vitest.stderr.slice(-4000),
            liveSmokeExitCode: liveSmoke.status ?? 1,
            liveSmokeStdout: (liveSmoke.stdout ?? "").slice(-2000),
            liveSmokeStderr: (liveSmoke.stderr ?? "").slice(-2000),
          },
        ],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
