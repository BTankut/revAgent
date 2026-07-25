import { canonicalManifest } from "./manifest.js";
import { stableJson } from "./stableJson.js";
import type {
  AssertionCategory,
  AssertionResult,
  Binding,
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

export interface ParentAssertionProbe {
  assertionId: string;
  observationIds: string[];
  evaluate(observations: readonly ProcessObservationRecord[]): unknown;
  message?: string;
}

export interface AssertionEvidenceBinding {
  assertionId: string;
  requiredComponents: ComponentId[];
  requiredBindings: Binding[];
  requiredKinds: ProcessObservationRecord["kind"][];
}

function requiredComponents(category: AssertionCategory, caseId: string): ComponentId[] {
  if (caseId === "O1-C19") return ["gateway_stub", "bridge_simulator", "addin_loopback_fixture"];
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

function requiredKinds(category: AssertionCategory, caseId: string): ProcessObservationRecord["kind"][] {
  if (caseId === "O1-C19") return ["process_lifecycle", "wire_event", "fixture_execution_count"];
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
        requiredComponents: requiredComponents(assertion.category, caseEntry.id),
        requiredBindings: [...caseEntry.bindings],
        requiredKinds: requiredKinds(assertion.category, caseEntry.id),
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
    const keys = Object.keys(record).sort().join("|");
    const expectedKeys = ["schemaVersion", "observationId", "runId", "caseId", "binding", "componentId", "kind", "at", "payload"].sort().join("|");
    if (keys !== expectedKeys) throw new Error("process observation has unknown or missing top-level fields");
    if (record.schemaVersion !== "rbp-process-observation/v2" ||
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

  evaluate(probes: readonly ParentAssertionProbe[]): AssertionResult[] {
    const required = canonicalManifest.requiredAssertions[this.caseId]!;
    const byId = new Map<string, ParentAssertionProbe>();
    for (const probe of probes) {
      if (byId.has(probe.assertionId)) throw new Error(`duplicate assertion probe ${probe.assertionId}`);
      const allowed = ["assertionId", "observationIds", "evaluate", "message"];
      if (Object.prototype.hasOwnProperty.call(probe, "passed") || Object.prototype.hasOwnProperty.call(probe, "actual") ||
        Object.keys(probe).some((key) => !allowed.includes(key))) {
        throw new Error(`probe ${probe.assertionId} must not carry child-supplied actual or passed fields`);
      }
      if (typeof probe.assertionId !== "string" || !Array.isArray(probe.observationIds) ||
        !probe.observationIds.every((id) => typeof id === "string") || typeof probe.evaluate !== "function") {
        throw new Error(`probe ${probe.assertionId} lacks a parent evaluator or valid observation ids`);
      }
      byId.set(probe.assertionId, probe);
    }
    const unknown = [...byId.keys()].filter((id) => !required.some(({ id: requiredId }) => requiredId === id));
    if (unknown.length > 0) throw new Error(`unknown parent assertion probes: ${unknown.join(", ")}`);

    return required.map((assertion) => {
      const probe = byId.get(assertion.id);
      const binding = ASSERTION_EVIDENCE_BINDINGS.get(assertion.id)!;
      const records = probe?.observationIds.flatMap((id) => {
        const record = this.#records.get(id);
        return record === undefined ? [] : [record];
      }) ?? [];
      const allIdsResolve = probe !== undefined && records.length === probe.observationIds.length;
      const observedComponents = new Set(records.map(({ componentId }) => componentId));
      const observedBindings = new Set(records.map(({ binding: observedBinding }) => observedBinding));
      const observedKinds = new Set(records.map(({ kind }) => kind));
      const coverage =
        allIdsResolve &&
        probe!.observationIds.length > 0 &&
        new Set(probe!.observationIds).size === probe!.observationIds.length &&
        binding.requiredComponents.every((component) => observedComponents.has(component)) &&
        binding.requiredBindings.every((requiredBinding) => observedBindings.has(requiredBinding)) &&
        binding.requiredKinds.every((kind) => observedKinds.has(kind));
      let actual: unknown = null;
      let evaluationError: string | undefined;
      if (probe !== undefined && allIdsResolve) {
        try {
          actual = probe.evaluate(records.map((record) => structuredClone(record)));
        } catch (error) {
          evaluationError = error instanceof Error ? error.message : String(error);
        }
      }
      const semantics = evaluationError === undefined && stableJson(actual) === stableJson(assertion.expected);
      const passed = coverage && semantics;
      return {
        assertionId: assertion.id,
        subvectorId: assertion.subvectorId,
        statement: assertion.statement,
        category: assertion.category,
        passed,
        expected: assertion.expected,
        actual,
        observationIds: probe?.observationIds ?? [],
        evidenceSha256: null,
        message: passed
          ? null
          : evaluationError ?? probe?.message ?? (coverage ? "parent predicate did not meet canonical semantics" : "missing same-case process/binding evidence coverage"),
      };
    });
  }
}
