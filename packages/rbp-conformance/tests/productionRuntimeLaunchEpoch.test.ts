import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function source(relativePath: string): string {
  return readFileSync(path.join(packageRoot, "src", relativePath), "utf8");
}

function exportedFunction(sourceText: string, declaration: string): string {
  const start = sourceText.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  return sourceText.slice(start);
}

describe("production runtime integrity epoch composition", () => {
  it("keeps component-boundary checks fail-closed to the active plan and physical root", () => {
    const executionPlan = source("productionExecutionPlan.ts");
    const launchGuard = exportedFunction(
      executionPlan,
      "export function assertProductionRuntimeLaunchCurrent(",
    );
    const activeEpochCheck = launchGuard.indexOf(
      "if (activeProductionRuntimeLaunchEpoch !== null)",
    );
    const mismatchedKeyRejection = launchGuard.indexOf(
      "component launch does not match the active production runtime integrity epoch",
    );
    const fullValidation = launchGuard.indexOf(
      "const validation = validateExecutionPlanStructure(plan);",
    );

    expect(activeEpochCheck).toBeGreaterThanOrEqual(0);
    expect(mismatchedKeyRejection).toBeGreaterThan(activeEpochCheck);
    expect(fullValidation).toBeGreaterThan(mismatchedKeyRejection);
    expect(executionPlan).toContain(
      "const physicalRoot = realpathSync(repoRoot);",
    );
    expect(executionPlan).toContain(
      "assertProductionRuntimeLaunchCurrent(epoch.plan, epoch.repoRoot);",
    );
    expect(executionPlan).toContain(
      "production runtime integrity epoch closing verification failed",
    );
  });

  it("opens one epoch around all forty cases and closes it before the run verdict", () => {
    const suiteRunner = exportedFunction(
      source("productionSuiteRunner.ts"),
      "export async function executeProductionConformanceRun(",
    );
    const begin = suiteRunner.indexOf(
      "const runtimeEpoch = beginProductionRuntimeLaunchEpoch(plan, repoRoot);",
    );
    const caseLoop = suiteRunner.indexOf("for (const result of report.cases)");
    const end = suiteRunner.indexOf(
      "endProductionRuntimeLaunchEpoch(runtimeEpoch);",
    );
    const verdict = suiteRunner.lastIndexOf("report.run = {");

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(caseLoop).toBeGreaterThan(begin);
    expect(end).toBeGreaterThan(caseLoop);
    expect(verdict).toBeGreaterThan(end);
    expect(suiteRunner.slice(caseLoop, verdict)).toMatch(
      /finally\s*\{[\s\S]*endProductionRuntimeLaunchEpoch\(runtimeEpoch\);/u,
    );
  });

  it("covers soak setup, churn, and cleanup, then closes before report status is retained", () => {
    const soakRunner = exportedFunction(
      source("soakRunner.ts"),
      "export async function runReconnectSoak(",
    );
    const begin = soakRunner.indexOf(
      "const runtimeEpoch = beginProductionRuntimeLaunchEpoch(plan, repoRoot);",
    );
    const adapterCreate = soakRunner.indexOf(
      "adapter = await createProductionReconnectSoakAdapter({",
    );
    const churn = soakRunner.indexOf(
      "const observation = await adapter.churn(binding, cycle);",
    );
    const cleanup = soakRunner.lastIndexOf("await adapter.close();");
    const end = soakRunner.lastIndexOf(
      "endProductionRuntimeLaunchEpoch(runtimeEpoch);",
    );
    const report = soakRunner.indexOf("const report: SoakReport = {");

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(adapterCreate).toBeGreaterThan(begin);
    expect(churn).toBeGreaterThan(adapterCreate);
    expect(cleanup).toBeGreaterThan(churn);
    expect(end).toBeGreaterThan(cleanup);
    expect(report).toBeGreaterThan(end);
    expect(soakRunner).toContain('code: "soak_runtime_integrity"');
  });
});
