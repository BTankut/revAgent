import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import commonSchema from "../schemas/rbp/v1/common.schema.json" with { type: "json" };
import envelopeSchema from "../schemas/rbp/v1/envelope.schema.json" with { type: "json" };
import payloadsSchema from "../schemas/rbp/v1/payloads.schema.json" with { type: "json" };
import type {
  BatchResult,
  InvocationResult,
  InvokeBatch,
  RbpEnvelope,
  RecoveryClearance,
} from "./generated/envelope.js";
import { makeBatchDigest, makeParamsDigest, type JsonValue } from "./paramsDigest.js";

// Composed fragments inherit their object type through allOf/$ref. Ajv cannot
// infer that relationship for strictTypes, while the remaining strict checks
// stay enabled.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addSchema(commonSchema);
ajv.addSchema(payloadsSchema);

const validateSchema = ajv.compile<RbpEnvelope>(envelopeSchema);
let lastErrors: ErrorObject[] = [];

function semanticError(instancePath: string, message: string): ErrorObject {
  return {
    instancePath,
    schemaPath: "#/rbpSemantic",
    keyword: "rbpSemantic",
    params: {},
    message,
  };
}

function duplicateInvocationIdErrors(
  steps: Array<{ invocation_id?: unknown }>,
  path: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (typeof step.invocation_id === "string") {
      if (seen.has(step.invocation_id)) {
        errors.push(
          semanticError(
            `${path}/${index}/invocation_id`,
            "batch step invocation_id values must be unique",
          ),
        );
      }
      seen.add(step.invocation_id);
    }
  }
  return errors;
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function recoveryClearanceErrors(
  clearances: RecoveryClearance[],
  path: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const holdIds = clearances.map((clearance) => clearance.hold_id);
  for (const [index, holdId] of holdIds.entries()) {
    if (holdIds.indexOf(holdId) !== index) {
      errors.push(
        semanticError(`${path}/${index}/hold_id`, "recovery clearance hold_id values must be unique"),
      );
    }
    if (index > 0 && (holdIds[index - 1] ?? "") > holdId) {
      errors.push(
        semanticError(path, "recovery clearances must be sorted by hold_id ascending"),
      );
      break;
    }
  }
  return errors;
}

function invokeBatchErrors(payload: InvokeBatch): ErrorObject[] {
  const errors = duplicateInvocationIdErrors(payload.steps, "/payload/steps");
  errors.push(...recoveryClearanceErrors(payload.recovery_clearances, "/payload/recovery_clearances"));

  for (const [index, step] of payload.steps.entries()) {
    try {
      const expected = makeParamsDigest(step.params as JsonValue);
      if (step.params_digest !== expected) {
        errors.push(
          semanticError(
            `/payload/steps/${index}/params_digest`,
            `params_digest must equal the RFC 8785 digest of step params (${expected})`,
          ),
        );
      }
    } catch (error) {
      errors.push(
        semanticError(
          `/payload/steps/${index}/params`,
          `step params are not RFC 8785 JSON: ${error instanceof Error ? error.message : "invalid value"}`,
        ),
      );
    }
  }

  try {
    const expected = makeBatchDigest({
      atomic: payload.atomic,
      batch_id: payload.batch_id,
      recovery_clearances: payload.recovery_clearances as unknown as JsonValue[],
      steps: payload.steps.map((step) => ({
        invocation_id: step.invocation_id,
        method: step.method,
        mutating: step.mutating,
        mutation_scope: step.mutation_scope as unknown as JsonValue,
        params_digest: step.params_digest,
        policy: {
          class: step.policy.class,
          confirmation_id: step.policy.confirmation_id,
          decision: step.policy.decision,
        },
      })),
      timeout_ms: payload.timeout_ms,
    });
    if (payload.batch_digest !== expected) {
      errors.push(
        semanticError(
          "/payload/batch_digest",
          `batch_digest must equal the RFC 8785 digest of batch semantics (${expected})`,
        ),
      );
    }
  } catch (error) {
    errors.push(
      semanticError(
        "/payload/batch_digest",
        `batch digest material is not RFC 8785 JSON: ${error instanceof Error ? error.message : "invalid value"}`,
      ),
    );
  }

  return errors;
}

function invocationResultErrors(payload: InvocationResult): ErrorObject[] {
  if (!("artifacts" in payload) || payload.artifacts === undefined) {
    return [];
  }

  const errors: ErrorObject[] = [];
  const artifactIds = new Set<string>();
  let combinedSize = 0;
  for (const [position, artifact] of payload.artifacts.entries()) {
    combinedSize += artifact.total_size;
    if (artifact.artifact_index !== position) {
      errors.push(
        semanticError(
          `/payload/artifacts/${position}/artifact_index`,
          `artifact_index must equal its zero-based descriptor position (${position})`,
        ),
      );
    }
    if (artifactIds.has(artifact.artifact_id)) {
      errors.push(
        semanticError(
          `/payload/artifacts/${position}/artifact_id`,
          "artifact_id values must be unique within an invocation",
        ),
      );
    }
    artifactIds.add(artifact.artifact_id);
    if (artifact.stream_id !== `artifact:${artifact.artifact_id}`) {
      errors.push(
        semanticError(
          `/payload/artifacts/${position}/stream_id`,
          "artifact stream_id must be artifact:<artifact_id>",
        ),
      );
    }
  }
  if (combinedSize > 33_554_432) {
    errors.push(
      semanticError(
        "/payload/artifacts",
        "combined artifact descriptor total_size must not exceed 32 MiB",
      ),
    );
  }
  return errors;
}

function batchResultErrors(payload: BatchResult): ErrorObject[] {
  const errors = duplicateInvocationIdErrors(payload.steps, "/payload/steps");
  const firstNonSuccess = payload.steps.findIndex((step) => step.status !== "completed");
  const expectedFailureIndex = firstNonSuccess === -1 ? null : firstNonSuccess;

  for (const [position, step] of payload.steps.entries()) {
    const stepRecord = step as BatchResult["steps"][number] & {
      late_after_indeterminate?: unknown;
      verification_hold_id?: unknown;
      result_digest?: unknown;
      error?: {
        fault_class?: unknown;
        replayed?: unknown;
        late_after_indeterminate?: unknown;
        verification_hold_id?: unknown;
        result_digest?: unknown;
      };
    };
    const nestedError = stepRecord.error;

    if (step.index !== position) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/index`,
          `batch step index must equal its zero-based position (${position})`,
        ),
      );
    }

    if (firstNonSuccess !== -1 && position > firstNonSuccess && step.status !== "not_started") {
      errors.push(
        semanticError(
          `/payload/steps/${position}/status`,
          "steps after the first non-success terminal step must be not_started",
        ),
      );
    }

    if (step.status === "indeterminate") {
      const error = step.error;
      if (
        error?.fault_class !== "journal_indeterminate" ||
        error.retryable !== false ||
        error.outcome !== "indeterminate" ||
        error.verification_required !== true ||
        typeof error.verification_hold_id !== "string" ||
        error.mutation_scope === undefined
      ) {
        errors.push(
          semanticError(
            `/payload/steps/${position}/error`,
            "an indeterminate step requires the journal_indeterminate unknown-outcome contract",
          ),
        );
      }
    } else if (step.status === "failed" && nestedError?.fault_class === "cancelled") {
      errors.push(
        semanticError(
          `/payload/steps/${position}/error/fault_class`,
          "step status:failed excludes fault_class:cancelled",
        ),
      );
    } else if (step.status === "cancelled" && nestedError?.fault_class !== "cancelled") {
      errors.push(
        semanticError(
          `/payload/steps/${position}/error/fault_class`,
          "step status:cancelled requires fault_class:cancelled",
        ),
      );
    } else if (
      (step.status === "failed" || step.status === "cancelled") &&
      nestedError?.fault_class === "journal_indeterminate"
    ) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/error/fault_class`,
          "journal_indeterminate requires step status:indeterminate",
        ),
      );
    }

    if (nestedError?.replayed === true && step.replayed === false) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/error/replayed`,
          "nested error.replayed:true requires enclosing step.replayed:true",
        ),
      );
    } else if (
      nestedError !== undefined &&
      step.replayed === false &&
      nestedError.replayed !== false
    ) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/error/replayed`,
          "a fresh batch step requires nested error.replayed:false",
        ),
      );
    }

    const stepIsLate = stepRecord.late_after_indeterminate === true;
    const errorIsLate = nestedError?.late_after_indeterminate === true;
    if (nestedError !== undefined && stepIsLate !== errorIsLate) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/late_after_indeterminate`,
          "a terminal error and its enclosing step must agree on late_after_indeterminate",
        ),
      );
    }

    if (
      errorIsLate &&
      (stepRecord.verification_hold_id !== nestedError.verification_hold_id ||
        stepRecord.result_digest !== nestedError.result_digest)
    ) {
      errors.push(
        semanticError(
          `/payload/steps/${position}/verification_hold_id`,
          "a late terminal error and its enclosing step must carry identical hold and result digests",
        ),
      );
    }
  }

  if (payload.failed_step_index !== expectedFailureIndex) {
    errors.push(
      semanticError(
        "/payload/failed_step_index",
        `failed_step_index must be ${expectedFailureIndex === null ? "null" : expectedFailureIndex}`,
      ),
    );
  }

  const expectedStatus =
    firstNonSuccess === -1 ? "completed" : payload.steps[firstNonSuccess]?.status;
  if (payload.status !== expectedStatus) {
    errors.push(
      semanticError(
        "/payload/status",
        `batch status must match the first non-success step (${String(expectedStatus)})`,
      ),
    );
  }

  const expectedTransactionState = !payload.atomic
    ? "not_applicable"
    : payload.status === "completed"
      ? "committed"
      : payload.status === "indeterminate"
        ? "indeterminate"
        : "rolled_back";
  if (payload.transaction_state !== expectedTransactionState) {
    errors.push(
      semanticError(
        "/payload/transaction_state",
        `atomic:${String(payload.atomic)} status:${payload.status} requires transaction_state:${expectedTransactionState}`,
      ),
    );
  }

  if (
    payload.replayed &&
    payload.steps.some((step) => step.status !== "not_started" && !step.replayed)
  ) {
    errors.push(
      semanticError(
        "/payload/replayed",
        "batch replayed:true requires every returned terminal step to be replayed",
      ),
    );
  }

  return errors;
}

function semanticEnvelopeErrors(value: RbpEnvelope): ErrorObject[] {
  if (value.type === "invoke_batch") {
    return invokeBatchErrors(value.payload);
  }

  if (value.type === "invoke") {
    return recoveryClearanceErrors(
      value.payload.recovery_clearances,
      "/payload/recovery_clearances",
    );
  }

  if (value.type === "partial") {
    const payload = value.payload;
    if (
      payload.kind === "chunk" &&
      typeof payload.data === "string" &&
      decodedBase64Size(payload.data) > 1_048_576
    ) {
      return [
        semanticError(
          "/payload/data",
          "decoded partial chunk data must not exceed 1 MiB",
        ),
      ];
    }
    if (
      payload.kind === "chunk" &&
      "artifact_id" in payload &&
      payload.stream_id !== `artifact:${String(payload.artifact_id)}`
    ) {
      return [
        semanticError(
          "/payload/stream_id",
          "artifact chunk stream_id must be artifact:<artifact_id>",
        ),
      ];
    }
    return [];
  }

  if (value.type === "result") {
    const payload = value.payload as { kind?: unknown };
    if (payload.kind === "batch") {
      return batchResultErrors(value.payload as BatchResult);
    }
    return invocationResultErrors(value.payload as InvocationResult);
  }

  return [];
}

/**
 * Validates an already-parsed object. It intentionally cannot enforce raw
 * UTF-8 byte limits; use parseRbpFrame at every wire boundary.
 */
export function validateRbpEnvelope(value: unknown): value is RbpEnvelope {
  if (!validateSchema(value)) {
    lastErrors = validateSchema.errors ?? [];
    return false;
  }

  lastErrors = semanticEnvelopeErrors(value);
  return lastErrors.length === 0;
}

export function rbpEnvelopeErrors(): ErrorObject[] {
  return lastErrors;
}
