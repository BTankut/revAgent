import { canonicalManifest } from "./manifest.js";
import { stableJson } from "./stableJson.js";
import type {
  AssertionCategory,
  AssertionResult,
  Binding,
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

export interface AssertionMeasurement {
  assertionId: string;
  actual: unknown;
  observationIds: string[];
  message?: string;
}

export interface AssertionEvidenceBinding {
  assertionId: string;
  requiredComponents: ComponentId[];
  requiredBindings: Binding[];
  requiredKinds: ProcessObservationRecord["kind"][];
}

function requiredComponents(category: AssertionCategory): ComponentId[] {
  switch (category) {
    case "execution_count":
      return ["addin_loopback_fixture"];
    case "journal_truth":
      return ["bridge_simulator"];
    case "artifact_integrity":
      return ["bridge_simulator", "addin_loopback_fixture"];
    case "discovery":
      return ["bridge_simulator", "addin_loopback_fixture"];
    case "safety":
    case "resource_leak":
      return ["gateway_stub", "bridge_simulator", "addin_loopback_fixture"];
    default:
      return ["gateway_stub", "bridge_simulator"];
  }
}

function requiredKinds(category: AssertionCategory): ProcessObservationRecord["kind"][] {
  switch (category) {
    case "execution_count":
      return ["fixture_execution_count"];
    case "journal_truth":
      return ["bridge_snapshot"];
    case "artifact_integrity":
      return ["bridge_snapshot", "fixture_snapshot"];
    case "discovery":
      return ["control_result", "fixture_snapshot"];
    case "resource_leak":
      return ["resource_sample"];
    default:
      return ["control_result", "wire_event"];
  }
}

export const ASSERTION_EVIDENCE_BINDINGS: ReadonlyMap<string, AssertionEvidenceBinding> = new Map(
  canonicalManifest.cases.flatMap((caseEntry) =>
    canonicalManifest.requiredAssertions[caseEntry.id]!.map((assertion) => [
      assertion.id,
      {
        assertionId: assertion.id,
        requiredComponents: requiredComponents(assertion.category),
        requiredBindings: [...caseEntry.bindings],
        requiredKinds: requiredKinds(assertion.category),
      },
    ] as const)),
);

export class CaseObservationLedger {
  readonly #records = new Map<string, ProcessObservationRecord>();

  constructor(
    readonly runId: string,
    readonly caseId: string,
  ) {
    if (!canonicalManifest.cases.some(({ id }) => id === caseId)) {
      throw new Error(`unknown conformance case ${caseId}`);
    }
  }

  add(record: ProcessObservationRecord): void {
    if (record.schemaVersion !== "rbp-process-observation/v1" ||
      record.runId !== this.runId || record.caseId !== this.caseId) {
      throw new Error("process observation is not bound to this run/case ledger");
    }
    if (this.#records.has(record.observationId)) throw new Error(`duplicate observation id ${record.observationId}`);
    if (!Number.isFinite(Date.parse(record.at))) throw new Error(`observation ${record.observationId} has an invalid timestamp`);
    const bytes = Buffer.byteLength(stableJson(record.payload), "utf8");
    if (bytes > 64 * 1024) throw new Error(`observation ${record.observationId} payload exceeds 64 KiB`);
    this.#records.set(record.observationId, structuredClone(record));
  }

  records(): ProcessObservationRecord[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  evaluate(measurements: readonly AssertionMeasurement[]): AssertionResult[] {
    const required = canonicalManifest.requiredAssertions[this.caseId]!;
    const byId = new Map<string, AssertionMeasurement>();
    for (const measurement of measurements) {
      if (byId.has(measurement.assertionId)) throw new Error(`duplicate assertion measurement ${measurement.assertionId}`);
      if (Object.prototype.hasOwnProperty.call(measurement, "passed")) {
        throw new Error(`measurement ${measurement.assertionId} must not carry a child-supplied passed flag`);
      }
      byId.set(measurement.assertionId, measurement);
    }
    const unknown = [...byId.keys()].filter((id) => !required.some(({ id: requiredId }) => requiredId === id));
    if (unknown.length > 0) throw new Error(`unknown assertion measurements: ${unknown.join(", ")}`);

    return required.map((assertion) => {
      const measurement = byId.get(assertion.id);
      const binding = ASSERTION_EVIDENCE_BINDINGS.get(assertion.id)!;
      const records = measurement?.observationIds.flatMap((id) => {
        const record = this.#records.get(id);
        return record === undefined ? [] : [record];
      }) ?? [];
      const allIdsResolve = measurement !== undefined && records.length === measurement.observationIds.length;
      const observedComponents = new Set(records.map(({ componentId }) => componentId));
      const observedBindings = new Set(records.map(({ binding: observedBinding }) => observedBinding));
      const observedKinds = new Set(records.map(({ kind }) => kind));
      const coverage =
        allIdsResolve &&
        measurement!.observationIds.length > 0 &&
        new Set(measurement!.observationIds).size === measurement!.observationIds.length &&
        binding.requiredComponents.every((component) => observedComponents.has(component)) &&
        binding.requiredBindings.every((requiredBinding) => observedBindings.has(requiredBinding)) &&
        binding.requiredKinds.every((kind) => observedKinds.has(kind));
      const semantics = measurement !== undefined && stableJson(measurement.actual) === stableJson(assertion.expected);
      const passed = coverage && semantics;
      return {
        assertionId: assertion.id,
        subvectorId: assertion.subvectorId,
        statement: assertion.statement,
        category: assertion.category,
        passed,
        expected: assertion.expected,
        actual: measurement?.actual ?? null,
        observationIds: measurement?.observationIds ?? [],
        evidenceSha256: null,
        message: passed
          ? null
          : measurement?.message ?? (coverage ? "observed value did not meet canonical semantics" : "missing same-case process/binding evidence coverage"),
      };
    });
  }
}
