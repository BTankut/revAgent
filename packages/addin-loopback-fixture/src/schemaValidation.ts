import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { Effect, JsonObject } from "./types.js";

const require = createRequire(import.meta.url);

const SCHEMA_PREFIX = "https://schemas.revagent.local/addin-loopback/v1/";
const schemaFiles = [
  "common.schema.json",
  "json-rpc-response.schema.json",
  "mcp-status.schema.json",
  "get-document-context.schema.json",
  "execute-batch.schema.json",
] as const;

export const BATCHABLE_METHODS = [
  "get_current_view_elements",
  "get_current_view_info",
  "get_selected_elements",
  "list_open_views",
  "get_ui_state",
  "find_elements",
  "inspect_levels",
  "inspect_sheet_text",
  "inspect_schedules",
  "count_annotations",
  "extract_spatial_snapshot",
  "get_spatial_change_state",
  "delete_review_view",
] as const;

export type BatchableMethod = (typeof BATCHABLE_METHODS)[number];

export interface BatchableDescriptor {
  readonly method: BatchableMethod;
  readonly effect: Effect;
  readonly transactionPolicy: "none" | "nested_transaction_required";
  readonly rollbackDisposition:
    | "discard_result_on_batch_rollback"
    | "transaction_group_rollback";
  readonly parameterProfile: "ordinary_v1" | "delete_review_view_commit_v1";
}

export const BATCHABLE_DESCRIPTORS: readonly BatchableDescriptor[] = BATCHABLE_METHODS.map(
  (method): BatchableDescriptor =>
    method === "delete_review_view"
      ? {
          method,
          effect: "model_transaction",
          transactionPolicy: "nested_transaction_required",
          rollbackDisposition: "transaction_group_rollback",
          parameterProfile: "delete_review_view_commit_v1",
        }
      : {
          method,
          effect: "read_only",
          transactionPolicy: "none",
          rollbackDisposition: "discard_result_on_batch_rollback",
          parameterProfile: "ordinary_v1",
        },
);

export type ContractErrorKind = "invalid_request" | "invalid_params" | "invalid_response";

export class ContractValidationError extends Error {
  public readonly kind: ContractErrorKind;

  public constructor(kind: ContractErrorKind, message: string) {
    super(message);
    this.name = "ContractValidationError";
    this.kind = kind;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new ContractValidationError("invalid_params", `${label} must be an object`);
  return value;
}

function loadSchema(file: (typeof schemaFiles)[number]): JsonObject {
  const schemaPath = require.resolve(`@revagent/protocol/schemas/addin-loopback/v1/${file}`);
  return JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export interface ValidatedRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: JsonObject;
}

export class LoopbackContractValidator {
  readonly #ajv: Ajv2020;
  readonly #requestValidators: ReadonlyMap<string, ValidateFunction>;
  readonly #successValidators: ReadonlyMap<string, ValidateFunction>;
  readonly #errorValidator: ValidateFunction;
  readonly #descriptors: ReadonlyMap<string, BatchableDescriptor>;
  readonly #maxRequestPayloadBytes: number;

  public constructor(maxRequestPayloadBytes: number) {
    this.#maxRequestPayloadBytes = maxRequestPayloadBytes;
    this.#ajv = new Ajv2020({ allErrors: true, strict: true });
    (addFormats as unknown as (instance: Ajv2020) => void)(this.#ajv);
    for (const file of schemaFiles) this.#ajv.addSchema(loadSchema(file));

    const methodSchemas = new Map([
      ["mcp_status", `${SCHEMA_PREFIX}mcp-status.schema.json`],
      ["get_document_context", `${SCHEMA_PREFIX}get-document-context.schema.json`],
      ["execute_batch", `${SCHEMA_PREFIX}execute-batch.schema.json`],
    ]);
    this.#requestValidators = new Map(
      [...methodSchemas].map(([method, id]) => [method, this.#requiredSchema(`${id}#/$defs/request`)]),
    );
    this.#successValidators = new Map(
      [...methodSchemas].map(([method, id]) => [method, this.#requiredSchema(`${id}#/$defs/successResponse`)]),
    );
    this.#errorValidator = this.#requiredSchema(
      `${SCHEMA_PREFIX}json-rpc-response.schema.json#/$defs/errorResponse`,
    );
    this.#descriptors = new Map(BATCHABLE_DESCRIPTORS.map((entry) => [entry.method, entry]));
  }

  public validateRequest(value: unknown, payloadBytes: number): ValidatedRequest {
    if (!isObject(value) || !exactKeys(value, ["jsonrpc", "id", "method", "params"])) {
      throw new ContractValidationError(
        "invalid_request",
        "request must contain exactly jsonrpc, id, method, and params",
      );
    }
    if (value.jsonrpc !== "2.0") {
      throw new ContractValidationError("invalid_request", "jsonrpc must equal 2.0");
    }
    if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
      throw new ContractValidationError("invalid_request", "id must be a non-empty bounded string");
    }
    if (
      typeof value.method !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/u.test(value.method)
    ) {
      throw new ContractValidationError("invalid_request", "method has an invalid v1 token");
    }
    if (!isObject(value.params)) {
      throw new ContractValidationError("invalid_params", "params must be an object");
    }

    const request = value as unknown as ValidatedRequest;
    const validator = this.#requestValidators.get(request.method);
    if (validator && !validator(value)) {
      throw new ContractValidationError("invalid_params", this.#schemaErrors(validator));
    }
    if (request.method === "execute_batch") {
      this.#validateBatchSemantics(request, payloadBytes);
    }
    return request;
  }

  public validateResponse(method: string, requestId: string, value: unknown): void {
    if (!isObject(value)) {
      throw new ContractValidationError("invalid_response", "response must be an object");
    }
    const isError = "error" in value;
    const validator = isError ? this.#errorValidator : this.#successValidators.get(method);
    if (validator) {
      if (!validator(value)) {
        throw new ContractValidationError("invalid_response", this.#schemaErrors(validator));
      }
    } else if (!this.#validateOrdinarySuccess(value)) {
      throw new ContractValidationError("invalid_response", "ordinary success violates JSON-RPC v1 shape");
    }
    if (value.id !== requestId) {
      throw new ContractValidationError("invalid_response", "response id does not echo request id");
    }
    if (method === "mcp_status" && !isError) this.#validateStatusSemantics(value);
    if (method === "get_document_context" && !isError) this.#validateDocumentSemantics(value);
    if (method === "execute_batch" && !isError) this.#validateBatchResponseSemantics(value);
  }

  public formatSchemaErrors(error: unknown): string {
    return error instanceof ContractValidationError ? error.message : String(error);
  }

  #requiredSchema(id: string): ValidateFunction {
    const validator = this.#ajv.getSchema(id);
    if (!validator) throw new Error(`Required add-in loopback schema is unavailable: ${id}`);
    return validator;
  }

  #schemaErrors(validator: ValidateFunction): string {
    return this.#ajv.errorsText(validator.errors, { separator: "; " }).slice(0, 600);
  }

  #validateOrdinarySuccess(value: JsonObject): boolean {
    if (!exactKeys(value, ["jsonrpc", "id", "result"])) return false;
    if (value.jsonrpc !== "2.0" || typeof value.id !== "string") return false;
    if (!isObject(value.result)) return false;
    return value.result.resultContractVersion === 2;
  }

  #validateBatchSemantics(request: ValidatedRequest, payloadBytes: number): void {
    const params = object(request.params, "execute_batch.params");
    if (request.id !== params.batchId) {
      throw new ContractValidationError("invalid_params", "request id must equal params.batchId");
    }
    if (payloadBytes > this.#maxRequestPayloadBytes) {
      throw new ContractValidationError("invalid_params", "batch exceeds advertised request cap");
    }
    const steps = params.steps;
    if (!Array.isArray(steps)) {
      throw new ContractValidationError("invalid_params", "execute_batch.steps must be an array");
    }
    const invocationIds = new Set<string>();
    steps.forEach((value, index) => {
      const step = object(value, `execute_batch.steps[${index}]`);
      if (step.index !== index) {
        throw new ContractValidationError("invalid_params", `step ${index} index is not contiguous`);
      }
      const invocationId = String(step.invocationId);
      if (invocationIds.has(invocationId)) {
        throw new ContractValidationError("invalid_params", `step ${index} invocationId is duplicated`);
      }
      invocationIds.add(invocationId);
      const descriptor = this.#descriptors.get(String(step.method));
      if (!descriptor || descriptor.effect !== step.effect) {
        throw new ContractValidationError(
          "invalid_params",
          `step ${index} differs from the advertised descriptor`,
        );
      }
    });
  }

  #validateStatusSemantics(response: JsonObject): void {
    const result = object(response.result, "mcp_status.result");
    const service = object(result.service, "mcp_status.result.service");
    const framing = object(service.framing, "mcp_status.result.service.framing");
    const contracts = object(result.capabilityContracts, "mcp_status.result.capabilityContracts");
    const capabilities = result.sessionCapabilities;
    if (!Array.isArray(capabilities)) {
      throw new ContractValidationError("invalid_response", "sessionCapabilities must be an array");
    }
    if (JSON.stringify([...capabilities].sort()) !== JSON.stringify(Object.keys(contracts).sort())) {
      throw new ContractValidationError(
        "invalid_response",
        "session capabilities and descriptors differ",
      );
    }
    if (capabilities.includes("batch_atomic")) {
      const batch = object(contracts.batch_atomic, "capabilityContracts.batch_atomic");
      if (
        batch.maxRequestPayloadBytes !== framing.maxRequestPayloadBytes ||
        batch.maxResponsePayloadBytes !== framing.maxResponsePayloadBytes
      ) {
        throw new ContractValidationError("invalid_response", "batch and framing caps differ");
      }
    }
    if (result.recentHistoryCount !== (result.recentTasks as unknown[]).length) {
      throw new ContractValidationError("invalid_response", "recent task counter differs from array");
    }
  }

  #validateDocumentSemantics(response: JsonObject): void {
    const result = object(response.result, "get_document_context.result");
    const documents = result.documents;
    if (!Array.isArray(documents)) {
      throw new ContractValidationError("invalid_response", "documents must be an array");
    }
    const rows = documents.map((entry, index) => object(entry, `documents[${index}]`));
    const ids = rows.map((row) => String(row.documentId));
    if (new Set(ids).size !== ids.length) {
      throw new ContractValidationError("invalid_response", "document ids are not unique");
    }
    const active = rows.filter((row) => row.isActive === true);
    if (result.activeDocumentId === null) {
      if (active.length !== 0) {
        throw new ContractValidationError("invalid_response", "active row exists without activeDocumentId");
      }
    } else if (active.length !== 1 || active[0]?.documentId !== result.activeDocumentId) {
      throw new ContractValidationError("invalid_response", "activeDocumentId does not identify active row");
    }
    if (result.activeView !== null) {
      const activeView = object(result.activeView, "activeView");
      if (activeView.documentId !== result.activeDocumentId) {
        throw new ContractValidationError("invalid_response", "active view has a different document id");
      }
    }
  }

  #validateBatchResponseSemantics(response: JsonObject): void {
    const result = object(response.result, "execute_batch.result");
    const steps = result.steps;
    if (!Array.isArray(steps)) {
      throw new ContractValidationError("invalid_response", "batch response steps must be an array");
    }
    const failedStepIndex = result.failedStepIndex;
    if (result.status === "completed") {
      if (failedStepIndex !== null || steps.some((entry) => object(entry, "step").executionState !== "completed")) {
        throw new ContractValidationError("invalid_response", "completed batch has a non-success step");
      }
      return;
    }
    const firstNonSuccess = steps.findIndex(
      (entry) => object(entry, "step").executionState !== "completed",
    );
    if (firstNonSuccess < 0 || firstNonSuccess !== failedStepIndex) {
      throw new ContractValidationError("invalid_response", "failedStepIndex is not first non-success");
    }
    const rollback = object(result.rollback, "execute_batch.result.rollback");
    if (rollback.triggerStepIndex !== failedStepIndex) {
      throw new ContractValidationError("invalid_response", "rollback trigger index differs");
    }
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 32 * 1024 * 1024) {
      throw new ContractValidationError("invalid_response", "batch response exceeds aggregate cap");
    }
  }
}
