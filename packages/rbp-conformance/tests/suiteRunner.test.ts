import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { executeSupervisedC19Run } from "../src/supervisedC19.js";
import { verifyRunEvidenceFiles } from "../src/evidence.js";
import { sha256File } from "../src/executionPlan.js";
import { canonicalManifest } from "../src/manifest.js";
import {
  assertProductionExecutionPlanCurrent,
} from "../src/productionExecutionPlan.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import { validateRunReportStructure } from "../src/validator.js";
import { createPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const componentScript = path.join(packageRoot, "tests", "fixtures", "supervised-c19-component.mjs");

function supervisedPlan(): ExecutionPlan {
  const plan = createPlan();
  const roleByComponent = {
    gateway_stub: "gateway",
    bridge_simulator: "bridge",
    addin_loopback_fixture: "fixture",
  } as const;
  for (const component of plan.components) {
    component.expectedIdentity.executableSha256 = sha256File(componentScript);
    component.command = {
      executable: process.execPath,
      args: [componentScript, roleByComponent[component.id]],
      workingDirectory: ".",
      environmentKeys: [],
      readiness: { kind: "stdout_pattern", value: "json", timeoutMs: 10_000 },
      shutdown: { signal: "SIGTERM", timeoutMs: 5_000 },
    };
  }
  return plan;
}

describe("supervised C19 runner", () => {
  it("starts a fresh real process trio for each binding and derives C19 from raw v2 evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-supervised-c19-"));
    let runtimeGuardCalls = 0;
    try {
      const { report, reportPath } = await executeSupervisedC19Run({
        plan: supervisedPlan(),
        repoRoot,
        artifactRoot: root,
        seed: "supervised-c19-test",
        runtimeLaunchGuard() {
          runtimeGuardCalls += 1;
        },
      });
      expect(runtimeGuardCalls).toBe(14);
      const c19 = report.cases.find(({ caseId }) => caseId === "O1-C19")!;
      expect(c19.status).toBe("passed");
      expect(c19.bindings.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(c19.assertions.every(({ passed, actual }) => passed === true && actual === true)).toBe(true);
      expect(report.cases.filter(({ caseId }) => caseId !== "O1-C19").every(({ status }) => status === "not_run")).toBe(true);
      expect(report.run).toMatchObject({ status: "failed", exitCode: 1 });
      expect(validateRunReportStructure(report).ok).toBe(true);
      expect(verifyRunEvidenceFiles(report, root).filter(({ path: issuePath }) =>
        issuePath.startsWith("/cases/18"))).toEqual([]);

      const evidenceArtifact = c19.artifacts.find(({ kind }) => kind === "case_evidence")!;
      const evidence = JSON.parse(readFileSync(path.join(root, evidenceArtifact.path), "utf8"));
      expect(evidence.schemaVersion).toBe("rbp-case-evidence/v2");
      expect(evidence.evaluationOwner).toBe("parent_runner");
      expect(evidence.observations).toHaveLength(16);
      expect(evidence.evaluations).toHaveLength(4);
      expect(JSON.stringify(evidence.observations)).not.toMatch(/"(?:actual|passed)"\s*:/u);

      const lifecycles = evidence.observations.filter((entry: { kind: string }) => entry.kind === "process_lifecycle");
      expect(lifecycles).toHaveLength(6);
      expect(new Set(lifecycles.map((entry: { payload: { process: { pid: number } } }) => entry.payload.process.pid)).size).toBe(6);
      expect(lifecycles.every((entry: { payload: { spawnOwner: string; process: { exitCode: number } } }) =>
        entry.payload.spawnOwner === "parent_runner" && entry.payload.process.exitCode === 0)).toBe(true);

      expect(readFileSync(path.join(root, reportPath), "utf8")).toBe(stableJson(report));
      if (process.platform !== "win32") {
        const retainedRoot = path.join(root, canonicalManifest.retainedEvidence.root);
        expect(statSync(retainedRoot).mode & 0o777).toBe(0o700);
        expect(statSync(path.join(root, evidenceArtifact.path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves runtime drift when instance-root cleanup also fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-supervised-c19-cleanup-"));
    const instanceRoots: string[] = [];
    let runtimeGuardCalls = 0;
    try {
      const { report } = await executeSupervisedC19Run({
        plan: supervisedPlan(),
        repoRoot,
        artifactRoot: root,
        seed: "supervised-c19-cleanup-test",
        runtimeLaunchGuard() {
          runtimeGuardCalls += 1;
          if (runtimeGuardCalls === 2) {
            throw new Error("planned C19 primary runtime drift");
          }
        },
        instanceRootRemover(instanceRoot) {
          instanceRoots.push(instanceRoot);
          throw new Error("planned C19 instance-root cleanup failure");
        },
      });
      const c19 = report.cases.find(({ caseId }) => caseId === "O1-C19")!;
      expect(c19.status).toBe("error");
      expect(c19.failure).toMatchObject({
        code: "supervised_process_error",
      });
      expect(c19.failure?.message).toMatch(/planned C19 primary runtime drift/u);
      expect(c19.failure?.message).toMatch(
        /planned C19 instance-root cleanup failure/u,
      );
      expect(runtimeGuardCalls).toBe(10);
      expect(instanceRoots).toHaveLength(2);
    } finally {
      for (const instanceRoot of instanceRoots) {
        rmSync(instanceRoot, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("surfaces shutdown-boundary drift before later C19 cleanup failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-supervised-c19-shutdown-"));
    const instanceRoots: string[] = [];
    let runtimeGuardCalls = 0;
    try {
      const { report } = await executeSupervisedC19Run({
        plan: supervisedPlan(),
        repoRoot,
        artifactRoot: root,
        seed: "supervised-c19-shutdown-test",
        runtimeLaunchGuard() {
          runtimeGuardCalls += 1;
          if (runtimeGuardCalls === 7) {
            throw new Error("planned C19 shutdown-boundary runtime drift");
          }
        },
        instanceRootRemover(instanceRoot) {
          instanceRoots.push(instanceRoot);
          throw new Error("planned C19 shutdown cleanup failure");
        },
      });
      const c19 = report.cases.find(({ caseId }) => caseId === "O1-C19")!;
      expect(c19.status).toBe("error");
      expect(c19.failure).toMatchObject({
        code: "supervised_process_error",
      });
      expect(c19.failure?.message).toMatch(
        /planned C19 shutdown-boundary runtime drift/u,
      );
      expect(c19.failure?.message).toMatch(/planned C19 shutdown cleanup failure/u);
      expect(runtimeGuardCalls).toBe(14);
      expect(instanceRoots).toHaveLength(2);
    } finally {
      for (const instanceRoot of instanceRoots) {
        rmSync(instanceRoot, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a fixture-only plan that lacks production provenance", () => {
    expect(() =>
      assertProductionExecutionPlanCurrent(
        supervisedPlan(),
        repoRoot,
      )).toThrow(
        /gateway_stub version, interface, or command does not match the canonical production descriptor/u,
      );
  });
});
