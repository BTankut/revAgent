import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest, evaluatePassingAggregate } from "../src/index.js";
import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import type { AggregateReport } from "../src/index.js";
import { stableJson } from "../src/stableJson.js";
import {
  createCurrentProductionPlan,
  materializePassingRunInputs,
} from "./helpers.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const compiledCli = path.join(packageRoot, "dist", "src", "cli.js");
const cliBootstrap = path.join(
  packageRoot,
  "scripts",
  "production-cli-bootstrap.mjs",
);
const productionLauncher = path.join(
  packageRoot,
  "scripts",
  "invoke-production.ps1",
);
const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (windowsRoot === undefined) {
  throw new Error("aggregate CLI tests require SystemRoot");
}
const systemPowerShell = path.join(
  windowsRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function invokeCurrentCli(
  args: readonly string[],
  cwd: string,
): Promise<CliInvocationResult> {
  const child = spawn(
    systemPowerShell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      productionLauncher,
      "-NodeExecutable",
      process.execPath,
      "-Entrypoint",
      cliBootstrap,
      ...args,
    ],
    {
      cwd,
      shell: false,
      env: sanitizedProductionRuntimeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90_000);
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: timedOut
          ? new Error("aggregate CLI launcher timed out after 90000ms")
          : launchError,
      });
    });
  });
}

interface CliInvocationResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

describe("aggregate CLI retained-evidence flow", () => {
  it("writes and binds aggregate JUnit, then passes its own full validator", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-cli-aggregate-"));
    try {
      const plans = ([1, 2, 3] as const).map((sequence) =>
        createCurrentProductionPlan(
          repoRoot,
          `run-${String(sequence)}`,
          sequence,
        )) as [
          ReturnType<typeof createCurrentProductionPlan>,
          ReturnType<typeof createCurrentProductionPlan>,
          ReturnType<typeof createCurrentProductionPlan>,
        ];
      const planFiles = plans.map((plan, index) => {
        const target = path.join(root, `plan-${String(index + 1)}.json`);
        writeFileSync(target, stableJson(plan), "utf8");
        return target;
      }) as [string, string, string];
      const planFlags = [
        "--plan-1",
        planFiles[0],
        "--plan-2",
        planFiles[1],
        "--plan-3",
        planFiles[2],
        "--repo-root",
        repoRoot,
      ];
      const inputs = materializePassingRunInputs(root, plans);
      const runAuditResult = await invokeCurrentCli(
        [
          "validate-run",
          inputs[0]!.reportPath,
          "--plan",
          planFiles[0],
          "--repo-root",
          repoRoot,
          "--artifact-root",
          root,
        ],
        root,
      );
      expect(runAuditResult.error).toBeUndefined();
      expect(runAuditResult.status).toBe(0);
      expect(String(runAuditResult.stdout)).toContain(
        "VALID (NON-AUTHORITATIVE)",
      );
      expect(String(runAuditResult.stdout)).not.toContain("PASS");

      const output = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        canonicalManifest.retainedEvidence.aggregateReport,
      );
      expect(existsSync(systemPowerShell)).toBe(true);
      expect(existsSync(productionLauncher)).toBe(true);
      expect(existsSync(compiledCli)).toBe(true);
      expect(existsSync(cliBootstrap)).toBe(true);
      const invalidOutput = await invokeCurrentCli(
        [
          "aggregate",
          ...inputs.map(({ reportPath }) => reportPath),
          ...planFlags,
          "--output",
          path.join(root, "outside.json"),
        ],
        root,
      );
      expect(invalidOutput.error).toBeUndefined();
      expect(invalidOutput.status).not.toBe(0);
      expect(String(invalidOutput.stdout)).not.toContain("PASS");

      const aggregateResult = await invokeCurrentCli(
        [
          "aggregate",
          ...inputs.map(({ reportPath }) => reportPath),
          ...planFlags,
          "--artifact-root",
          root,
        ],
        root,
      );
      expect(aggregateResult.error).toBeUndefined();
      expect(aggregateResult.status).toBe(0);
      expect(String(aggregateResult.stdout)).not.toContain("PASS");

      const aggregate = JSON.parse(readFileSync(output, "utf8")) as AggregateReport;
      expect(aggregate.reportPath).toBe(
        `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateReport}`,
      );
      expect(aggregate.artifacts).toHaveLength(1);
      expect(aggregate.artifacts[0]).toMatchObject({
        kind: "aggregate_junit",
        path: `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`,
        mediaType: "application/xml",
      });
      expect(
        evaluatePassingAggregate(aggregate, {
          verifyArtifactFiles: true,
          artifactRoot: root,
          aggregateReportFile: output,
        }).ok,
      ).toBe(true);
      const validationResult = await invokeCurrentCli(
        [
          "validate-aggregate",
          output,
          ...planFlags,
          "--artifact-root",
          root,
        ],
        root,
      );
      expect(validationResult.error).toBeUndefined();
      expect(validationResult.status).toBe(0);
      expect(String(validationResult.stdout)).toContain(
        "VALID (NON-AUTHORITATIVE)",
      );
      expect(String(validationResult.stdout)).not.toContain("PASS");

      const copiedOutput = path.join(root, "copied-aggregate.json");
      copyFileSync(output, copiedOutput);
      const copiedValidation = await invokeCurrentCli(
        [
          "validate-aggregate",
          copiedOutput,
          ...planFlags,
          "--artifact-root",
          root,
        ],
        root,
      );
      expect(copiedValidation.error).toBeUndefined();
      expect(copiedValidation.status).not.toBe(0);
      expect(String(copiedValidation.stdout)).not.toContain("PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
