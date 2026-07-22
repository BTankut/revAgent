import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { validateExecutionPlanStructure } from "./validator.js";
import type { ExecutionPlan, RunReport } from "./types.js";

export function createUnexecutedRunReport(plan: ExecutionPlan): RunReport {
  const validation = validateExecutionPlanStructure(plan);
  if (!validation.ok) {
    throw new Error(`Invalid execution plan: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }

  return {
    schemaVersion: "rbp-conformance-run/v1",
    manifest: { ...canonicalManifestIdentity },
    run: {
      runId: plan.runId,
      sequence: plan.sequence,
      status: "initialized",
      seed: `unexecuted:${plan.runId}`,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
    },
    source: { ...plan.source },
    components: plan.components.map((component) => ({
      ...component,
      expectedIdentity: { ...component.expectedIdentity },
      command: {
        ...component.command,
        args: [...component.command.args],
        environmentKeys: [...component.command.environmentKeys],
        readiness: { ...component.command.readiness },
        shutdown: { ...component.command.shutdown },
      },
      observedIdentity: null,
      process: {
        pid: null,
        startedAt: null,
        readyAt: null,
        stoppedAt: null,
        exitCode: null,
      },
    })),
    cases: canonicalManifest.cases.map((entry) => ({
      caseId: entry.id,
      title: entry.title,
      status: "not_run",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      requiredComponents: [...entry.requiredComponents],
      bindings: entry.bindings.map((binding) => ({ binding, status: "not_run", durationMs: null })),
      assertions: canonicalManifest.requiredAssertions[entry.id]!.map((assertion) => ({
        assertionId: assertion.id,
        subvectorId: assertion.subvectorId,
        statement: assertion.statement,
        category: assertion.category,
        passed: null,
        expected: assertion.expected,
        actual: null,
        evidenceSha256: null,
        message: "unexecuted",
      })),
      artifacts: [],
      failure: null,
    })),
    timing: {
      suiteDurationMs: null,
      setupDurationMs: null,
      teardownDurationMs: null,
    },
    leaks: {
      openFileDescriptorDelta: 0,
      residentBytesDelta: 0,
      journalPendingDelta: 0,
      orphanProcessCount: 0,
    },
    artifacts: [],
  };
}
