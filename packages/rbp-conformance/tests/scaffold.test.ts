import { describe, expect, it } from "vitest";

import {
  canonicalManifest,
  createUnexecutedRunReport,
  evaluatePassingRun,
  validateExecutionPlanStructure,
  validateRunReportStructure,
} from "../src/index.js";
import { createPlan } from "./helpers.js";

describe("unexecuted report scaffold", () => {
  it("initializes every canonical case as not_run without observed processes", () => {
    const plan = createPlan();
    expect(validateExecutionPlanStructure(plan).ok).toBe(true);
    const report = createUnexecutedRunReport(plan);
    expect(report.run.status).toBe("initialized");
    expect(report.cases).toHaveLength(40);
    expect(report.cases.every(({ status }) => status === "not_run")).toBe(true);
    expect(report.cases.flatMap(({ bindings }) => bindings).every(({ status }) => status === "not_run")).toBe(true);
    expect(report.cases.flatMap(({ assertions }) => assertions).every(({ passed }) => passed === null)).toBe(true);
    expect(report.components.every(({ observedIdentity, process }) => observedIdentity === null && process.pid === null)).toBe(true);
    expect(report.artifacts).toEqual([]);
    expect(validateRunReportStructure(report).ok).toBe(true);
  });

  it("fails the pass gate for all unexecuted cases", () => {
    const result = evaluatePassingRun(createUnexecutedRunReport(createPlan()));
    expect(result.ok).toBe(false);
    expect(result.issues.some(({ code }) => code === "run.not_passed")).toBe(true);
    expect(result.issues.filter(({ code }) => code === "case.not_passed")).toHaveLength(canonicalManifest.cases.length);
  });
});
