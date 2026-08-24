import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

interface Scenario {
  request: JsonObject;
  response: JsonObject;
}

type SchemaName =
  | "json-rpc-response"
  | "mcp-status"
  | "get-document-context"
  | "execute-batch";

interface NegativeVector {
  name: string;
  base: string;
  schema: SchemaName;
  validation: "schema" | "semantic" | "semantic-status" | "semantic-batch";
  mutation: {
    operation: "add" | "replace" | "delete";
    path: string;
    value?: unknown;
  };
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(packageRoot, relativePath), "utf8")) as T;
}

const schemaFiles = [
  "common.schema.json",
  "json-rpc-response.schema.json",
  "mcp-status.schema.json",
  "get-document-context.schema.json",
  "execute-batch.schema.json",
] as const;

const executeBatchSchema = loadJson<JsonObject>(
  "schemas/addin-loopback/v1/execute-batch.schema.json",
);

const schemaIds: Record<SchemaName, string> = {
  "json-rpc-response": "https://schemas.revagent.local/addin-loopback/v1/json-rpc-response.schema.json",
  "mcp-status": "https://schemas.revagent.local/addin-loopback/v1/mcp-status.schema.json",
  "get-document-context": "https://schemas.revagent.local/addin-loopback/v1/get-document-context.schema.json",
  "execute-batch": "https://schemas.revagent.local/addin-loopback/v1/execute-batch.schema.json",
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);

for (const file of schemaFiles) {
  ajv.addSchema(
    file === "execute-batch.schema.json"
      ? executeBatchSchema
      : loadJson<JsonObject>(`schemas/addin-loopback/v1/${file}`),
  );
}

const validators = Object.fromEntries(
  Object.entries(schemaIds).map(([name, id]) => {
    const validator = ajv.getSchema(id);
    if (!validator) {
      throw new Error(`Schema was not registered: ${id}`);
    }
    return [name, validator];
  }),
) as Record<SchemaName, ValidateFunction>;

const mcpStatus = loadJson<Scenario>("fixtures/addin-loopback/v1/mcp-status.positive.json");
const documentContext = loadJson<Scenario>("fixtures/addin-loopback/v1/get-document-context.positive.json");
const batchCommit = loadJson<Scenario>("fixtures/addin-loopback/v1/execute-batch-commit.positive.json");
const batchRollback = loadJson<Scenario>("fixtures/addin-loopback/v1/execute-batch-rollback.positive.json");
const batchIndeterminate = loadJson<Scenario>(
  "fixtures/addin-loopback/v1/execute-batch-indeterminate.positive.json",
);
const batchReadTriggerIndeterminate = loadJson<Scenario>(
  "fixtures/addin-loopback/v1/execute-batch-read-trigger-indeterminate.positive.json",
);
const batchResponseLimitRollback = loadJson<Scenario>(
  "fixtures/addin-loopback/v1/execute-batch-response-limit-rollback.positive.json",
);
const jsonRpcError = loadJson<JsonObject>("fixtures/addin-loopback/v1/json-rpc-error.positive.json");
const jsonRpcParseError = loadJson<JsonObject>(
  "fixtures/addin-loopback/v1/json-rpc-parse-error.positive.json",
);
const negativeVectors = loadJson<NegativeVector[]>("fixtures/addin-loopback/v1/negative-vectors.json");
const normativeSpec = readFileSync(
  resolve(packageRoot, "../../docs/specs/O1-bridge-gateway-protocol.md"),
  "utf8",
);

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

const executeBatchDefs = object(executeBatchSchema.$defs, "execute-batch.$defs");
const ordinaryReservedParamName = object(
  executeBatchDefs.ordinaryReservedParamName,
  "execute-batch.$defs.ordinaryReservedParamName",
);
const ordinaryReservedParamNames = array(
  ordinaryReservedParamName.enum,
  "execute-batch.$defs.ordinaryReservedParamName.enum",
).map((value) => {
  if (typeof value !== "string") {
    throw new Error("ordinary reserved parameter names must be strings");
  }
  return value;
});

function documentedOrdinaryReservedParamNames(): string[] {
  const listPrefix = "following exact reserved-name set is rejected before dispatch:";
  const listSuffix = ". These are connection, timeout, response-mode,";
  const start = normativeSpec.indexOf(listPrefix);
  const end = normativeSpec.indexOf(listSuffix, start);
  if (start < 0 || end < 0) {
    throw new Error("normative ordinary-v1 reserved parameter list was not found");
  }
  return [...normativeSpec.slice(start + listPrefix.length, end).matchAll(/`([^`]+)`/g)].map(
    (match) => match[1],
  );
}

function schemaErrors(validator: ValidateFunction): string {
  return ajv.errorsText(validator.errors, { separator: "\n" });
}

function validateInstance(schema: SchemaName, value: unknown): boolean {
  return Boolean(validators[schema](value));
}

function serializedPayloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function multibytePaddingForBytes(byteCount: number): string {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw new Error(`Invalid padding byte count: ${byteCount}`);
  }
  return "ğ".repeat(Math.floor(byteCount / 2)) + (byteCount % 2 === 0 ? "" : "x");
}

function statusSemanticErrors(scenario: Scenario): string[] {
  const errors: string[] = [];
  const request = scenario.request;
  const response = scenario.response;
  const result = object(response.result, "mcp_status.result");
  const service = object(result.service, "mcp_status.result.service");
  const framing = object(service.framing, "mcp_status.result.service.framing");

  if (request.id !== response.id) errors.push("response id does not echo request id");

  for (const address of array(service.boundAddresses, "boundAddresses")) {
    if (typeof address !== "string" || isIP(address) === 0) {
      errors.push(`invalid IP listener address: ${String(address)}`);
      continue;
    }
    if (address !== "::1" && !address.startsWith("127.")) {
      errors.push(`non-loopback listener address: ${address}`);
    }
  }

  const capabilities = array(result.sessionCapabilities, "sessionCapabilities") as string[];
  const contracts = object(result.capabilityContracts, "capabilityContracts");
  const capabilityKeys = Object.keys(contracts).sort();
  if (JSON.stringify([...capabilities].sort()) !== JSON.stringify(capabilityKeys)) {
    errors.push("sessionCapabilities and capabilityContracts keys differ");
  }

  if (capabilities.includes("batch_atomic")) {
    const batch = object(contracts.batch_atomic, "capabilityContracts.batch_atomic");
    if (batch.maxRequestPayloadBytes !== framing.maxRequestPayloadBytes) {
      errors.push("batch request cap differs from the listener framing cap");
    }
    if (batch.maxResponsePayloadBytes !== framing.maxResponsePayloadBytes) {
      errors.push("batch response cap differs from the listener framing cap");
    }
    const commands = array(batch.batchableCommands, "batchableCommands").map((entry) =>
      object(entry, "batchable command"),
    );
    const methodNames = commands.map((entry) => String(entry.method));
    if (new Set(methodNames).size !== methodNames.length) {
      errors.push("batchable command methods are not unique");
    }
    if (commands.some((entry) =>
      entry.resultDelivery !== "inline_only" || entry.maxInlineResultBytes !== 8_388_608
    )) {
      errors.push("batchable command does not attest inline-only result delivery");
    }

    const deleteReviewView = commands.find((entry) => entry.method === "delete_review_view");
    if (!deleteReviewView) {
      errors.push("batch_atomic lacks the required delete_review_view descriptor");
    } else if (
      deleteReviewView.effect !== "model_transaction" ||
      deleteReviewView.transactionPolicy !== "nested_transaction_required" ||
      deleteReviewView.rollbackDisposition !== "transaction_group_rollback" ||
      deleteReviewView.parameterProfile !== "delete_review_view_commit_v1" ||
      deleteReviewView.resultDelivery !== "inline_only" ||
      deleteReviewView.maxInlineResultBytes !== 8_388_608
    ) {
      errors.push("delete_review_view descriptor does not prove transaction-group rollback support");
    }
  }

  const recentTasks = array(result.recentTasks, "recentTasks");
  if (result.recentHistoryCount !== recentTasks.length) {
    errors.push("recentHistoryCount differs from recentTasks length");
  }

  return errors;
}

function documentContextSemanticErrors(scenario: Scenario): string[] {
  const errors: string[] = [];
  const request = scenario.request;
  const response = scenario.response;
  const result = object(response.result, "get_document_context.result");
  const documents = array(result.documents, "documents").map((entry) => object(entry, "document"));
  const activeDocuments = documents.filter((entry) => entry.isActive === true);
  const documentIds = documents.map((entry) => String(entry.documentId));

  if (request.id !== response.id) errors.push("response id does not echo request id");
  if (new Set(documentIds).size !== documentIds.length) errors.push("document ids are not unique");
  if (activeDocuments.length > 1) errors.push("more than one document is active");

  if (result.activeDocumentId === null) {
    if (activeDocuments.length !== 0) errors.push("active document row exists while activeDocumentId is null");
  } else if (
    activeDocuments.length !== 1 ||
    activeDocuments[0]?.documentId !== result.activeDocumentId
  ) {
    errors.push("activeDocumentId does not identify the sole isActive document");
  }

  if (result.activeView !== null) {
    const activeView = object(result.activeView, "activeView");
    if (activeView.documentId !== result.activeDocumentId) {
      errors.push("activeView documentId differs from activeDocumentId");
    }
  }

  return errors;
}

function batchSemanticErrors(scenario: Scenario, statusScenario: Scenario): string[] {
  const errors: string[] = [];
  const request = scenario.request;
  const response = scenario.response;
  const params = object(request.params, "execute_batch.params");
  const result = object(response.result, "execute_batch.result");
  const requestSteps = array(params.steps, "execute_batch.params.steps").map((entry) =>
    object(entry, "request step"),
  );
  const responseSteps = array(result.steps, "execute_batch.result.steps").map((entry) =>
    object(entry, "response step"),
  );

  if (request.id !== params.batchId) errors.push("JSON-RPC id differs from params.batchId");
  if (response.id !== request.id) errors.push("response id does not echo request id");
  if (result.batchId !== params.batchId) errors.push("response batchId differs from request batchId");
  if (result.batchDigest !== params.batchDigest) errors.push("response batchDigest differs from request digest");
  if (responseSteps.length !== requestSteps.length) errors.push("response step count differs from request");

  const invocationIds = new Set<string>();
  const statusResult = object(statusScenario.response.result, "mcp_status.result");
  const contracts = object(statusResult.capabilityContracts, "capabilityContracts");
  const batchCapability = object(contracts.batch_atomic, "batch_atomic");
  const maxRequestPayloadBytes = Number(batchCapability.maxRequestPayloadBytes);
  const maxResponsePayloadBytes = Number(batchCapability.maxResponsePayloadBytes);
  if (requestSteps.length > Number(batchCapability.maxSteps)) {
    errors.push("request exceeds the session-advertised maxSteps");
  }
  if (serializedPayloadBytes(request) > maxRequestPayloadBytes) {
    errors.push("serialized execute_batch request exceeds the advertised aggregate cap");
  }
  if (serializedPayloadBytes(response) > maxResponsePayloadBytes) {
    errors.push("serialized execute_batch response exceeds the advertised aggregate cap");
  }
  const advertised = new Map(
    array(batchCapability.batchableCommands, "batchableCommands").map((entry) => {
      const descriptor = object(entry, "batchable command");
      return [String(descriptor.method), descriptor] as const;
    }),
  );

  requestSteps.forEach((step, index) => {
    if (step.index !== index) errors.push(`request step ${index} has non-contiguous index`);
    const invocationId = String(step.invocationId);
    if (invocationIds.has(invocationId)) errors.push(`duplicate invocationId at step ${index}`);
    invocationIds.add(invocationId);

    const descriptor = advertised.get(String(step.method));
    if (!descriptor) {
      errors.push(`step ${index} method was not advertised as batchable`);
    } else if (descriptor.effect !== step.effect) {
      errors.push(`step ${index} effect differs from advertised descriptor`);
    }

    const outcome = responseSteps[index];
    if (!outcome) return;
    if (
      outcome.index !== index ||
      outcome.invocationId !== step.invocationId ||
      outcome.method !== step.method
    ) {
      errors.push(`response step ${index} correlation differs from request`);
    }

    if (outcome.executionState === "not_started") {
      if (outcome.effectState !== "not_started") {
        errors.push(`not-started step ${index} has a non-empty effect state`);
      }
    } else if (result.transactionState === "committed") {
      const expected = step.effect === "model_transaction" ? "committed" : "read_only";
      if (outcome.effectState !== expected) {
        errors.push(`committed step ${index} has the wrong effect disposition`);
      }
    } else if (result.transactionState === "rolled_back") {
      const expected = step.effect === "model_transaction" ? "rolled_back" : "discarded";
      if (outcome.effectState !== expected) {
        errors.push(`rolled-back step ${index} has the wrong effect disposition`);
      }
      if (outcome.resultSuppressed !== "batch_rolled_back") {
        errors.push(`rolled-back step ${index} has the wrong suppression reason`);
      }
    } else if (result.transactionState === "indeterminate") {
      const expected = step.effect === "model_transaction" ? "indeterminate" : "discarded";
      if (outcome.effectState !== expected) {
        errors.push(`indeterminate step ${index} has the wrong effect disposition`);
      }
      if (outcome.resultSuppressed !== "batch_indeterminate") {
        errors.push(`indeterminate step ${index} has the wrong suppression reason`);
      }
    }

    if (outcome.error !== undefined) {
      const stepError = object(outcome.error, `step ${index} error`);
      if (stepError.code === "response_payload_limit") {
        if (stepError.maxResponsePayloadBytes !== maxResponsePayloadBytes) {
          errors.push(`step ${index} response cap differs from the advertised aggregate cap`);
        }
        if (Number(stepError.tentativeResponsePayloadBytes) <= maxResponsePayloadBytes) {
          errors.push(`step ${index} response-limit error does not exceed the aggregate cap`);
        }
      }
    }
  });

  if (result.status === "completed") {
    if (result.failedStepIndex !== null) errors.push("completed batch has failedStepIndex");
  } else {
    const firstNonSuccess = responseSteps.findIndex((step) => step.executionState !== "completed");
    if (firstNonSuccess < 0 || result.failedStepIndex !== firstNonSuccess) {
      errors.push("failedStepIndex is not the first non-success step");
    }
    const rollback = object(result.rollback, "rollback");
    if (rollback.triggerStepIndex !== result.failedStepIndex) {
      errors.push("rollback trigger index differs from failedStepIndex");
    }
    if (result.status !== "indeterminate" && rollback.triggerState !== result.status) {
      errors.push("rollback trigger state differs from batch status");
    }
    const triggerStep = responseSteps[firstNonSuccess];
    if (triggerStep && rollback.triggerState !== triggerStep.executionState) {
      errors.push("rollback trigger state differs from the triggering step execution state");
    }

    responseSteps.forEach((step, index) => {
      if (index > firstNonSuccess && step.executionState !== "not_started") {
        errors.push(`successor step ${index} was not stopped`);
      }
      if (result.transactionState === "rolled_back" && "result" in step) {
        errors.push(`rolled-back step ${index} leaked a result`);
      }
    });
  }

  return errors;
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function mutate(base: unknown, vector: NegativeVector): unknown {
  const copy = structuredClone(base);
  const tokens = vector.mutation.path
    .split("/")
    .slice(1)
    .map(decodePointerToken);
  const finalToken = tokens.pop();
  if (finalToken === undefined) throw new Error(`Invalid mutation path: ${vector.mutation.path}`);

  let parent: unknown = copy;
  for (const token of tokens) {
    if (Array.isArray(parent)) {
      parent = parent[Number(token)];
    } else {
      parent = object(parent, `mutation parent ${token}`)[token];
    }
  }

  if (Array.isArray(parent)) {
    const index = Number(finalToken);
    if (vector.mutation.operation === "delete") parent.splice(index, 1);
    else parent[index] = vector.mutation.value;
  } else {
    const target = object(parent, "mutation parent");
    if (vector.mutation.operation === "delete") delete target[finalToken];
    else target[finalToken] = vector.mutation.value;
  }

  return copy;
}

const bases: Record<string, unknown> = {
  "mcpStatus.response": mcpStatus.response,
  "mcpStatus.scenario": mcpStatus,
  "documentContext.response": documentContext.response,
  "batchCommit.request": batchCommit.request,
  "batchCommit.response": batchCommit.response,
  "batchCommit.scenario": batchCommit,
  "batchRollback.request": batchRollback.request,
  "batchRollback.response": batchRollback.response,
  "batchRollback.scenario": batchRollback,
  "batchIndeterminate.response": batchIndeterminate.response,
  "batchIndeterminate.scenario": batchIndeterminate,
  "batchReadTriggerIndeterminate.scenario": batchReadTriggerIndeterminate,
  "batchResponseLimitRollback.response": batchResponseLimitRollback.response,
  "batchResponseLimitRollback.scenario": batchResponseLimitRollback,
  jsonRpcError,
  jsonRpcParseError,
};

describe("add-in loopback v1 schemas", () => {
  it("accepts the positive mcp_status request/response and capability semantics", () => {
    expect(validateInstance("mcp-status", mcpStatus.request), schemaErrors(validators["mcp-status"])).toBe(true);
    expect(validateInstance("mcp-status", mcpStatus.response), schemaErrors(validators["mcp-status"])).toBe(true);
    expect(statusSemanticErrors(mcpStatus)).toEqual([]);
  });

  it("accepts the positive cached document-context request/response", () => {
    expect(
      validateInstance("get-document-context", documentContext.request),
      schemaErrors(validators["get-document-context"]),
    ).toBe(true);
    expect(
      validateInstance("get-document-context", documentContext.response),
      schemaErrors(validators["get-document-context"]),
    ).toBe(true);
    expect(documentContextSemanticErrors(documentContext)).toEqual([]);
  });

  it("accepts the optional cache incarnation correlate only for an initialized revision", () => {
    const withDigest = structuredClone(documentContext);
    object(withDigest.response.result, "get_document_context.result").cache_incarnation_digest =
      `sha256:${"b".repeat(64)}`;
    expect(
      validateInstance("get-document-context", withDigest.response),
      schemaErrors(validators["get-document-context"]),
    ).toBe(true);

    const withoutDigest = structuredClone(documentContext);
    expect(
      validateInstance("get-document-context", withoutDigest.response),
      schemaErrors(validators["get-document-context"]),
    ).toBe(true);

    const malformedDigest = structuredClone(withDigest);
    object(malformedDigest.response.result, "get_document_context.result").cache_incarnation_digest =
      "sha256:not-a-digest";
    expect(validateInstance("get-document-context", malformedDigest.response)).toBe(false);

    const uninitializedDigest = structuredClone(withDigest);
    object(uninitializedDigest.response.result, "get_document_context.result").revision = 0;
    expect(validateInstance("get-document-context", uninitializedDigest.response)).toBe(false);

    const unknownResultProperty = structuredClone(withDigest);
    object(unknownResultProperty.response.result, "get_document_context.result").unknown_property = true;
    expect(validateInstance("get-document-context", unknownResultProperty.response)).toBe(false);
  });

  it.each([
    ["commit", batchCommit],
    ["rollback", batchRollback],
    ["indeterminate rollback", batchIndeterminate],
    ["indeterminate read trigger", batchReadTriggerIndeterminate],
    ["response-limit rollback", batchResponseLimitRollback],
  ] as const)("accepts the positive atomic %s scenario", (_name, scenario) => {
    expect(
      validateInstance("execute-batch", scenario.request),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(
      validateInstance("execute-batch", scenario.response),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(batchSemanticErrors(scenario, mcpStatus)).toEqual([]);
  });

  it("keeps the ordinary-v1 reserved parameter list identical to the normative spec", () => {
    expect(new Set(ordinaryReservedParamNames).size).toBe(ordinaryReservedParamNames.length);
    expect(documentedOrdinaryReservedParamNames()).toEqual(ordinaryReservedParamNames);
  });

  it.each(ordinaryReservedParamNames)(
    "rejects reserved ordinary-v1 runtime/control parameter: %s",
    (reservedName) => {
      const candidate = structuredClone(batchCommit);
      const params = object(candidate.request.params, "params");
      const steps = array(params.steps, "steps");
      const stepParams = object(object(steps[0], "step").params, "step params");
      stepParams[reservedName] = true;
      expect(validateInstance("execute-batch", candidate.request)).toBe(false);
    },
  );

  it("keeps ordinary-v1 functional params additive", () => {
    const candidate = structuredClone(batchCommit);
    const params = object(candidate.request.params, "params");
    const steps = array(params.steps, "steps");
    const stepParams = object(object(steps[0], "step").params, "step params");
    stepParams.futureFunctionalFilter = { mode: "new", values: ["a", "b"] };
    expect(
      validateInstance("execute-batch", candidate.request),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(batchSemanticErrors(candidate, mcpStatus)).toEqual([]);
  });

  it("accepts viewId plus ThreeD and rejects another viewType", () => {
    const accepted = structuredClone(batchCommit);
    const acceptedParams = object(accepted.request.params, "params");
    const acceptedSteps = array(acceptedParams.steps, "steps");
    const acceptedDeleteParams = object(object(acceptedSteps[1], "step").params, "step params");
    delete acceptedDeleteParams.viewName;
    delete acceptedDeleteParams.exactName;
    acceptedDeleteParams.viewId = 123;
    acceptedDeleteParams.viewType = "ThreeD";
    expect(
      validateInstance("execute-batch", accepted.request),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(batchSemanticErrors(accepted, mcpStatus)).toEqual([]);

    const rejected = structuredClone(accepted);
    const rejectedParams = object(rejected.request.params, "params");
    const rejectedSteps = array(rejectedParams.steps, "steps");
    const rejectedDeleteParams = object(object(rejectedSteps[1], "step").params, "step params");
    rejectedDeleteParams.viewType = "FloorPlan";
    expect(validateInstance("execute-batch", rejected.request)).toBe(false);
  });

  it("reserves rollback_failure for the indeterminate rollback carrier", () => {
    expect(
      validateInstance("execute-batch", batchIndeterminate.response),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);

    const rejected = structuredClone(batchResponseLimitRollback.response);
    const result = object(rejected.result, "result");
    const steps = array(result.steps, "steps");
    object(steps[1], "step").error = {
      code: "rollback_failure",
      message: "Rollback failure belongs only in rollback.error",
    };
    expect(validateInstance("execute-batch", rejected)).toBe(false);
  });

  it("accepts a bounded standard JSON-RPC error response", () => {
    expect(
      validateInstance("json-rpc-response", jsonRpcError),
      schemaErrors(validators["json-rpc-response"]),
    ).toBe(true);
  });

  it("accepts a null id only for a pre-correlation parse error", () => {
    expect(
      validateInstance("json-rpc-response", jsonRpcParseError),
      schemaErrors(validators["json-rpc-response"]),
    ).toBe(true);
  });

  it("enforces exact aggregate request and response payload boundaries", () => {
    const statusResult = object(mcpStatus.response.result, "mcp_status.result");
    const contracts = object(statusResult.capabilityContracts, "capabilityContracts");
    const batchCapability = object(contracts.batch_atomic, "batch_atomic");
    const requestLimit = Number(batchCapability.maxRequestPayloadBytes);
    const responseLimit = Number(batchCapability.maxResponsePayloadBytes);

    const requestBoundary = structuredClone(batchCommit);
    const requestSteps = array(object(requestBoundary.request.params, "params").steps, "steps");
    const requestPaddingTarget = object(object(requestSteps[0], "step").params, "params");
    requestPaddingTarget.boundaryPadding = "";
    requestPaddingTarget.boundaryPadding = multibytePaddingForBytes(
      requestLimit - serializedPayloadBytes(requestBoundary.request),
    );
    expect(serializedPayloadBytes(requestBoundary.request)).toBe(requestLimit);
    expect(requestPaddingTarget.boundaryPadding).toContain("ğ");
    expect(
      validateInstance("execute-batch", requestBoundary.request),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(batchSemanticErrors(requestBoundary, mcpStatus)).toEqual([]);
    requestPaddingTarget.boundaryPadding += "x";
    expect(serializedPayloadBytes(requestBoundary.request)).toBe(requestLimit + 1);
    expect(batchSemanticErrors(requestBoundary, mcpStatus)).toContain(
      "serialized execute_batch request exceeds the advertised aggregate cap",
    );

    const responseBoundary = structuredClone(batchCommit);
    const responseSteps = array(object(responseBoundary.response.result, "result").steps, "steps");
    const responsePaddingTarget = object(object(responseSteps[0], "step").result, "result");
    responsePaddingTarget.boundaryPadding = "";
    responsePaddingTarget.boundaryPadding = multibytePaddingForBytes(
      responseLimit - serializedPayloadBytes(responseBoundary.response),
    );
    expect(serializedPayloadBytes(responseBoundary.response)).toBe(responseLimit);
    expect(responsePaddingTarget.boundaryPadding).toContain("ğ");
    expect(
      validateInstance("execute-batch", responseBoundary.response),
      schemaErrors(validators["execute-batch"]),
    ).toBe(true);
    expect(batchSemanticErrors(responseBoundary, mcpStatus)).toEqual([]);
    responsePaddingTarget.boundaryPadding += "x";
    expect(serializedPayloadBytes(responseBoundary.response)).toBe(responseLimit + 1);
    expect(batchSemanticErrors(responseBoundary, mcpStatus)).toContain(
      "serialized execute_batch response exceeds the advertised aggregate cap",
    );
  });

  it.each(negativeVectors)("rejects negative vector: $name", (vector) => {
    const base = bases[vector.base];
    if (base === undefined) throw new Error(`Unknown fixture base: ${vector.base}`);
    const candidate = mutate(base, vector);

    if (vector.validation === "schema") {
      expect(validateInstance(vector.schema, candidate)).toBe(false);
      return;
    }

    if (vector.validation === "semantic") {
      expect(validateInstance(vector.schema, candidate), schemaErrors(validators[vector.schema])).toBe(true);
      expect(documentContextSemanticErrors({ ...documentContext, response: candidate as JsonObject })).not.toEqual([]);
      return;
    }

    if (vector.validation === "semantic-status") {
      const scenario = candidate as Scenario;
      expect(
        validateInstance(vector.schema, scenario.response),
        schemaErrors(validators[vector.schema]),
      ).toBe(true);
      expect(statusSemanticErrors(scenario)).not.toEqual([]);
      return;
    }

    const scenario = candidate as Scenario;
    expect(
      validateInstance(vector.schema, scenario.request),
      schemaErrors(validators[vector.schema]),
    ).toBe(true);
    expect(
      validateInstance(vector.schema, scenario.response),
      schemaErrors(validators[vector.schema]),
    ).toBe(true);
    expect(batchSemanticErrors(scenario, mcpStatus)).not.toEqual([]);
  });
});
