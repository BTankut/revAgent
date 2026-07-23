import { canonicalManifest } from "./manifest.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type {
  Binding,
  ComponentId,
  ComponentIdentity,
  ProcessEvidence,
  ProcessObservationRecord,
} from "./types.js";

/**
 * Read-only projection of a process that the parent runner already spawned.
 * Case adapters deliberately receive neither a spawn nor a stop capability.
 */
export interface ParentOwnedComponentView {
  readonly componentId: ComponentId;
  readonly pid: number;
  readonly observedIdentity: ComponentIdentity;
  readonly process: Readonly<ProcessEvidence>;
  readonly readiness: Readonly<JsonObject>;
  requestRaw?(action: string, fields?: Readonly<Record<string, JsonValue>>, timeoutMs?: number): Promise<JsonValue>;
}

export interface ObservationOnlyAdapterContext {
  readonly runId: string;
  readonly caseId: string;
  readonly binding: Binding;
  readonly components: Readonly<Record<ComponentId, ParentOwnedComponentView>>;
}

/** Raw adapters may report observations only. Parent-owned evaluators derive outcomes. */
export interface RawCaseObservationBatch {
  observations: ProcessObservationRecord[];
}

export interface ObservationOnlyCaseAdapter {
  readonly caseId: string;
  readonly supportedBindings: readonly Binding[];
  readonly requiredComponents: readonly ComponentId[];
  observe(context: ObservationOnlyAdapterContext): Promise<RawCaseObservationBatch>;
}

export type ObservationOnlyAdapterRegistry = ReadonlyMap<string, ObservationOnlyCaseAdapter>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runtime boundary for every raw adapter. It rejects assertion outcomes even
 * when an untyped child adds them to the observation envelope. Opaque protocol
 * payloads may legitimately contain fields named actual or passed.
 */
export function assertObservationOnlyBatch(
  value: unknown,
  expected: { runId: string; caseId: string; binding: Binding },
): asserts value is RawCaseObservationBatch {
  if (!isObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.observations)) {
    throw new Error("raw case adapter result must contain observations only");
  }
  for (const observation of value.observations) {
    if (!isObject(observation) || observation.schemaVersion !== "rbp-process-observation/v2" ||
      observation.runId !== expected.runId || observation.caseId !== expected.caseId ||
      observation.binding !== expected.binding) {
      throw new Error("raw case adapter observation is not bound to the supervised run/case/binding");
    }
    if (Object.prototype.hasOwnProperty.call(observation, "actual") ||
      Object.prototype.hasOwnProperty.call(observation, "passed")) {
      throw new Error("raw case adapter must not supply observation-envelope actual or passed");
    }
  }
}

export function validateObservationOnlyAdapterRegistry(registry: ObservationOnlyAdapterRegistry): void {
  for (const [registeredCaseId, adapter] of registry) {
    const manifestCase = canonicalManifest.cases.find(({ id }) => id === registeredCaseId);
    if (manifestCase === undefined || adapter.caseId !== registeredCaseId) {
      throw new Error(`observation adapter registry has an unknown or mismatched case ${registeredCaseId}`);
    }
    if (adapter.supportedBindings.length !== manifestCase.bindings.length ||
      new Set(adapter.supportedBindings).size !== adapter.supportedBindings.length ||
      adapter.supportedBindings.some((binding) => !manifestCase.bindings.includes(binding))) {
      throw new Error(`observation adapter ${registeredCaseId} has invalid binding coverage`);
    }
    if (new Set(adapter.requiredComponents).size !== adapter.requiredComponents.length ||
      adapter.requiredComponents.length !== manifestCase.requiredComponents.length ||
      adapter.requiredComponents.some((component) => !manifestCase.requiredComponents.includes(component))) {
      throw new Error(`observation adapter ${registeredCaseId} does not declare the canonical component set`);
    }
  }
}

export function assertCompleteObservationOnlyAdapterRegistry(registry: ObservationOnlyAdapterRegistry): void {
  validateObservationOnlyAdapterRegistry(registry);
  const missing = canonicalManifest.cases
    .map(({ id }) => id)
    .filter((caseId) => !registry.has(caseId));
  if (missing.length > 0 || registry.size !== canonicalManifest.cases.length) {
    throw new Error(`observation adapter registry is not a complete 40-case suite; missing: ${missing.join(", ")}`);
  }
}
