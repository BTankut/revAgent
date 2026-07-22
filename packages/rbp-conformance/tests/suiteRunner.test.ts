import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { executeConformanceRun } from "../src/suiteRunner.js";
import { createPlan } from "./helpers.js";

describe("forty-case process suite runner", () => {
  it("retains failed observations and never turns absent daemon evidence into a pass", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-suite-"));
    const plan = createPlan();
    const startedAt = "2026-07-22T00:00:00.000Z";
    const components = plan.components.map((component, index) => ({
      ...component,
      observedIdentity: { ...component.expectedIdentity },
      process: {
        pid: 1000 + index,
        startedAt,
        readyAt: startedAt,
        stoppedAt: null,
        exitCode: null,
      },
    }));
    try {
      const { report } = await executeConformanceRun({
        plan,
        artifactRoot: root,
        seed: "fail-closed-unit-test",
        driver: {
          start: async () => ({
            components,
            caseSupport: () => ({ supported: true }),
            executeBinding: async () => ({ observations: [], measurements: [] }),
            sampleResources: async () => ({ residentBytes: 100_000_000, openFileDescriptorCount: 20, journalPendingCount: 0 }),
            stop: async () => {
              const stoppedAt = new Date().toISOString();
              components.forEach((component) => {
                component.process.stoppedAt = stoppedAt;
                component.process.exitCode = 0;
              });
              return { orphanProcessCount: 0 };
            },
          }),
        },
      });
      expect(report.run.status).toBe("failed");
      expect(report.cases).toHaveLength(40);
      expect(report.cases.every(({ status }) => status === "failed")).toBe(true);
      expect(report.cases.flatMap(({ assertions }) => assertions).every(({ passed }) => passed === false)).toBe(true);
      expect(report.cases[0]!.assertions[0]!.message).toMatch(/received 0 binding measurements/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps an unsupported binding not_run and never invokes its case executor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-suite-unsupported-"));
    const plan = createPlan();
    const startedAt = "2026-07-22T00:00:00.000Z";
    const components = plan.components.map((component, index) => ({
      ...component,
      observedIdentity: { ...component.expectedIdentity },
      process: {
        pid: 2000 + index,
        startedAt,
        readyAt: startedAt,
        stoppedAt: null,
        exitCode: null,
      },
    }));
    let executions = 0;
    try {
      const { report } = await executeConformanceRun({
        plan,
        artifactRoot: root,
        seed: "unsupported-unit-test",
        driver: {
          start: async () => ({
            components,
            caseSupport: (caseId, binding) => ({
              supported: false,
              reason: `missing exact choreography for ${caseId}/${binding}`,
            }),
            executeBinding: async () => {
              executions += 1;
              return { observations: [], measurements: [] };
            },
            sampleResources: async () => ({ residentBytes: 100_000_000, openFileDescriptorCount: 20, journalPendingCount: 0 }),
            stop: async () => ({ orphanProcessCount: 0 }),
          }),
        },
      });
      expect(executions).toBe(0);
      expect(report.run.status).toBe("failed");
      expect(report.cases.every(({ status }) => status === "failed")).toBe(true);
      expect(report.cases.every(({ bindings }) => bindings.every(({ status }) => status === "not_run"))).toBe(true);
      expect(report.cases.every(({ failure }) => failure?.code === "unsupported_case")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
