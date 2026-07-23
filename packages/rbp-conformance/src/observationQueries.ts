import type {
  Binding,
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

export type ObservationObject = Record<string, unknown>;

export interface StepControlFact {
  readonly observation: ProcessObservationRecord;
  readonly stepId: string;
  readonly phase: string;
  readonly channel: string;
  readonly action: string;
  readonly request: ObservationObject;
  readonly response: ObservationObject;
}

const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function observationObject(value: unknown, label: string): ObservationObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as ObservationObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function decodePointerSegment(segment: string): string {
  if (segment.includes("~") && /~(?![01])/u.test(segment)) {
    throw new Error(`invalid JSON pointer escape in ${segment}`);
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Strict JSON-pointer lookup used only by parent-owned predicates. */
export function observationPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("observation pointer must begin with /");
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (FORBIDDEN_POINTER_SEGMENTS.has(segment)) {
      throw new Error(`observation pointer contains reserved segment ${segment}`);
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        throw new Error(`observation pointer array index ${segment} is invalid`);
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new Error(`observation pointer index ${segment} does not resolve`);
      }
      current = current[index];
    } else {
      const record = observationObject(current, `observation pointer parent for ${segment}`);
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        throw new Error(`observation pointer segment ${segment} does not resolve`);
      }
      current = record[segment];
    }
  }
  return current;
}

export function parseStepControlFact(observation: ProcessObservationRecord): StepControlFact {
  if (observation.kind !== "control_result") {
    throw new Error(`${observation.observationId} is not a control_result`);
  }
  const payload = observationObject(observation.payload, `${observation.observationId} payload`);
  if (payload.schemaVersion !== "rbp-step-control-observation/v1") {
    throw new Error(`${observation.observationId} has an unknown control observation schema`);
  }
  const request = observationObject(payload.request, `${observation.observationId} request`);
  const response = observationObject(payload.response, `${observation.observationId} response`);
  return {
    observation,
    stepId: requiredString(payload.stepId, `${observation.observationId} stepId`),
    phase: requiredString(payload.phase, `${observation.observationId} phase`),
    channel: requiredString(payload.channel, `${observation.observationId} channel`),
    action: requiredString(request.action, `${observation.observationId} action`),
    request,
    response,
  };
}

export function controlFactForStep(
  observations: readonly ProcessObservationRecord[],
  stepId: string,
): StepControlFact {
  const matches = observations
    .filter(({ kind }) => kind === "control_result")
    .map(parseStepControlFact)
    .filter((fact) => fact.stepId === stepId);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one control_result for ${stepId}, observed ${matches.length}`);
  }
  return matches[0]!;
}

export function successfulControlResult(
  observations: readonly ProcessObservationRecord[],
  stepId: string,
  expectedAction?: string,
): unknown {
  const fact = controlFactForStep(observations, stepId);
  if (expectedAction !== undefined && fact.action !== expectedAction) {
    throw new Error(`${stepId} action ${fact.action} does not match ${expectedAction}`);
  }
  if (fact.response.kind !== "success" || !Object.prototype.hasOwnProperty.call(fact.response, "result")) {
    throw new Error(`${stepId} did not retain a successful control result`);
  }
  return structuredClone(fact.response.result);
}

export function observationsForStep(
  observations: readonly ProcessObservationRecord[],
  stepId: string,
  options: {
    kind?: ProcessObservationRecord["kind"];
    componentId?: ComponentId;
    binding?: Binding;
  } = {},
): ProcessObservationRecord[] {
  return observations.filter((observation) => {
    if (options.kind !== undefined && observation.kind !== options.kind) return false;
    if (options.componentId !== undefined && observation.componentId !== options.componentId) return false;
    if (options.binding !== undefined && observation.binding !== options.binding) return false;
    if (observation.kind === "control_result") {
      return parseStepControlFact(observation).stepId === stepId;
    }
    const payload = observationObject(observation.payload, `${observation.observationId} payload`);
    return payload.stepId === stepId;
  }).map((observation) => structuredClone(observation));
}

export function singleStepObservation(
  observations: readonly ProcessObservationRecord[],
  stepId: string,
  options: {
    kind: ProcessObservationRecord["kind"];
    componentId?: ComponentId;
    binding?: Binding;
  },
): ProcessObservationRecord {
  const matches = observationsForStep(observations, stepId, options);
  if (matches.length !== 1) {
    throw new Error(`expected one ${options.kind} observation for ${stepId}, observed ${matches.length}`);
  }
  return matches[0]!;
}
