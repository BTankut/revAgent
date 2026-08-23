import {
  makeBatchDigest,
  makeParamsDigest,
} from "@revagent/protocol";

import type { JsonObject, JsonValue } from "./processHarness.js";
import type { Binding } from "./types.js";

const MAX_PARAMS_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MACHINE_FINGERPRINT = `sha256:${"0".repeat(64)}`;

export const MIDDLE_PRODUCTION_CASES = [
  "O1-C15",
  "O1-C16",
  "O1-C17",
  "O1-C18",
  "O1-C19",
  "O1-C20",
  "O1-C21",
  "O1-C22",
  "O1-C23",
  "O1-C24",
] as const;

export type MiddleProductionCase = (typeof MIDDLE_PRODUCTION_CASES)[number];

const SUPPORTED = new Set<string>(MIDDLE_PRODUCTION_CASES);

function caseNumber(caseId: MiddleProductionCase): number {
  return Number(caseId.slice(-2));
}

function uuid7(caseId: MiddleProductionCase, slot: number): string {
  const suffix = (caseNumber(caseId) * 100_000 + slot).toString().padStart(12, "0");
  return `019f0b00-0000-7000-8000-${suffix}`;
}

function exactPaddingObject(byteLength: number): JsonObject {
  const empty: JsonObject = { padding: "" };
  const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (!Number.isSafeInteger(byteLength) || byteLength < overhead) {
    throw new Error("exact JSON padding byte length is invalid");
  }
  const value: JsonObject = { padding: "x".repeat(byteLength - overhead) };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") !== byteLength) {
    throw new Error(`failed to generate exact ${byteLength}-byte JSON value`);
  }
  return value;
}

function exactFixtureRequest(
  id: string,
  payloadBytes: number,
): JsonObject {
  const base: JsonObject = {
    jsonrpc: "2.0",
    id,
    method: "fixture_echo",
    params: { padding: "" },
  };
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  if (payloadBytes < overhead) throw new Error("fixture request byte target is too small");
  (base.params as JsonObject).padding = "x".repeat(payloadBytes - overhead);
  if (Buffer.byteLength(JSON.stringify(base), "utf8") !== payloadBytes) {
    throw new Error(`failed to generate exact ${payloadBytes}-byte fixture request`);
  }
  return base;
}

function rawOpeningHello(
  caseId: MiddleProductionCase,
  suffix: string,
  clockIso: string,
  id: string,
): JsonObject {
  return {
    type: "hello",
    id,
    ts: clockIso,
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "transport_streamable_http",
      ],
      bridge_version: `middle-${caseId.toLowerCase()}-${suffix}`,
      device_id: "device-01",
      machine: {
        hostname: "conformance-host",
        os: "Windows 11",
        fingerprint: MACHINE_FINGERPRINT,
      },
      addin_versions: ["0.0.0"],
    },
  };
}

function paramsOverLimitEnvelope(
  caseId: MiddleProductionCase,
  clockIso: string,
): JsonObject {
  return {
    v: 1,
    type: "invoke",
    id: uuid7(caseId, 20),
    ts: clockIso,
    rsid: "rs_boundary_params",
    seq: 1,
    ack: 0,
    payload: {
      invocation_id: uuid7(caseId, 21),
      method: "fixture_echo",
      params: exactPaddingObject(MAX_PARAMS_BYTES + 1),
      policy: { class: "auto", decision: "auto", confirmation_id: null },
      mutating: false,
      mutation_scope: null,
      timeout_ms: 30_000,
      verification: null,
      recovery_clearances: [],
    },
  };
}

function resultOverLimitEnvelope(
  caseId: MiddleProductionCase,
  clockIso: string,
): JsonObject {
  return {
    v: 1,
    type: "result",
    id: uuid7(caseId, 22),
    ts: clockIso,
    rsid: "rs_boundary_result",
    seq: 1,
    ack: 0,
    payload: {
      kind: "invocation",
      invocation_id: uuid7(caseId, 23),
      status: "completed",
      replayed: false,
      result: exactPaddingObject(MAX_RESULT_BYTES + 1),
      metrics: {
        execute_ms: 1,
        request_bytes: 1,
        response_bytes: MAX_RESULT_BYTES + 1,
        framing: "length-prefixed",
      },
    },
  };
}

interface BatchSeed {
  steps: JsonValue[];
  batchDigest: string;
  stepInvocationIds: string[];
  stepInvocationIdsByIndex: Record<string, string>;
}

function batchStep(
  invocationId: string,
  method: string,
  params: JsonObject,
  mutating = false,
): JsonObject {
  return {
    invocation_id: invocationId,
    method,
    params,
    params_digest: makeParamsDigest(params as never),
    mutating,
    mutation_scope: mutating
      ? { kind: "document", document_id: "fixture-document-1" }
      : null,
    policy: mutating
      ? {
          class: "confirm",
          decision: "confirmed",
          confirmation_id: invocationId,
        }
      : { class: "auto", decision: "auto", confirmation_id: null },
  };
}

function batchSeed(
  caseId: MiddleProductionCase,
  suffix: string,
  atomic: boolean,
  batchId: string,
  definitions: ReadonlyArray<{
    method: string;
    params: JsonObject;
    mutating?: boolean;
  }>,
  firstSlot: number,
): BatchSeed {
  const stepInvocationIds = definitions.map((_entry, index) => uuid7(caseId, firstSlot + index));
  const steps = definitions.map((definition, index) =>
    batchStep(
      stepInvocationIds[index]!,
      definition.method,
      definition.params,
      definition.mutating === true,
    ));
  const digestMaterial = {
    atomic,
    batch_id: batchId,
    recovery_clearances: [],
    steps: steps.map((step) => ({
      invocation_id: step.invocation_id!,
      method: step.method!,
      mutating: step.mutating!,
      mutation_scope: step.mutation_scope!,
      params_digest: step.params_digest!,
      policy: step.policy!,
    })),
    timeout_ms: 30_000,
  };
  void suffix;
  return {
    steps,
    batchDigest: makeBatchDigest(digestMaterial as never),
    stepInvocationIds,
    stepInvocationIdsByIndex: Object.fromEntries(
      stepInvocationIds.map((invocationId, index) => [String(index), invocationId]),
    ),
  };
}

function invocationIds(caseId: MiddleProductionCase): Record<string, JsonValue> {
  const ids: Record<string, JsonValue> = {
    "hello-initial": { envelopeId: uuid7(caseId, 1) },
  };
  const addInvocation = (suffix: string, slot: number): void => {
    ids[suffix] = {
      envelopeId: uuid7(caseId, slot),
      invocationId: uuid7(caseId, slot + 1),
    };
  };
  switch (caseId) {
    case "O1-C15":
      addInvocation("chunked", 100);
      break;
    case "O1-C17":
      addInvocation("cancelled", 100);
      break;
    case "O1-C18":
      ["method", "params", "exception", "guarded", "failure-shaped"]
        .forEach((suffix, index) => addInvocation(suffix, 100 + index * 2));
      break;
    case "O1-C20":
      ids["non-atomic"] = {
        envelopeId: uuid7(caseId, 100),
        batchId: uuid7(caseId, 101),
      };
      break;
    case "O1-C21":
      ids["atomic-unsupported"] = {
        envelopeId: uuid7(caseId, 100),
        batchId: uuid7(caseId, 101),
      };
      break;
    case "O1-C22":
      ids["atomic-commit"] = {
        envelopeId: uuid7(caseId, 100),
        batchId: uuid7(caseId, 101),
      };
      ids["atomic-rollback"] = {
        envelopeId: uuid7(caseId, 110),
        batchId: uuid7(caseId, 111),
      };
      break;
    case "O1-C24":
      ids["hello-reconnect"] = { envelopeId: uuid7(caseId, 2) };
      addInvocation("duplicate", 100);
      addInvocation("reordered", 110);
      break;
    default:
      break;
  }
  return ids;
}

function batchVariables(caseId: MiddleProductionCase, ids: Record<string, JsonValue>): JsonObject {
  const batchId = (suffix: string): string => {
    const value = ids[suffix];
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.batchId !== "string") {
      throw new Error(`${caseId}/${suffix} batch id is absent`);
    }
    return value.batchId;
  };
  switch (caseId) {
    case "O1-C20":
      return {
        "O1-C20": {
          "non-atomic": batchSeed(
            caseId,
            "non-atomic",
            false,
            batchId("non-atomic"),
            [
              { method: "get_ui_state", params: { vector: "non-atomic-0" } },
              { method: "inspect_levels", params: { vector: "non-atomic-1" } },
              { method: "find_elements", params: { vector: "non-atomic-2" } },
            ],
            200,
          ) as unknown as JsonValue,
        },
      };
    case "O1-C21":
      return {
        "O1-C21": {
          "atomic-unsupported": batchSeed(
            caseId,
            "atomic-unsupported",
            true,
            batchId("atomic-unsupported"),
            [
              { method: "get_ui_state", params: { vector: "unsupported-0" } },
              {
                method: "delete_review_view",
                params: {
                  viewId: 42,
                  mode: "commit",
                  confirmDelete: true,
                  viewType: "ThreeD",
                },
                mutating: true,
              },
            ],
            200,
          ) as unknown as JsonValue,
        },
      };
    case "O1-C22": {
      const definitions: Array<{
        method: string;
        params: JsonObject;
        mutating?: boolean;
      }> = [
        { method: "get_ui_state", params: { vector: "atomic-0" } },
        {
          method: "delete_review_view",
          params: {
            viewId: 42,
            mode: "commit",
            confirmDelete: true,
            viewType: "ThreeD",
          },
          mutating: true,
        },
        { method: "inspect_levels", params: { vector: "atomic-2" } },
      ];
      return {
        "O1-C22": {
          "atomic-commit": batchSeed(
            caseId,
            "atomic-commit",
            true,
            batchId("atomic-commit"),
            definitions,
            200,
          ) as unknown as JsonValue,
          "atomic-rollback": batchSeed(
            caseId,
            "atomic-rollback",
            true,
            batchId("atomic-rollback"),
            definitions,
            210,
          ) as unknown as JsonValue,
        },
      };
    }
    default:
      return {};
  }
}

function c19Vectors(caseId: MiddleProductionCase): JsonObject {
  const bigId = uuid7(caseId, 300);
  const splitId = uuid7(caseId, 301);
  const coalescedFirst = uuid7(caseId, 302);
  const coalescedSecond = uuid7(caseId, 303);
  const former8192 = uuid7(caseId, 304);
  return {
    big_endian_fixture_frame: {
      jsonrpc: "2.0",
      id: bigId,
      method: "fixture_echo",
      params: { vector: "big_endian" },
    },
    split_fixture_frame: {
      jsonrpc: "2.0",
      id: splitId,
      method: "fixture_counter",
      params: {},
    },
    coalesced_fixture_frames: [
      {
        jsonrpc: "2.0",
        id: coalescedFirst,
        method: "fixture_counter",
        params: { ordinal: 0 },
      },
      {
        jsonrpc: "2.0",
        id: coalescedSecond,
        method: "fixture_counter",
        params: { ordinal: 1 },
      },
    ],
    fixture_payload_8192_bytes: exactFixtureRequest(former8192, 8_192),
  };
}

function documentContextRevision2(clockIso: string): JsonObject {
  return {
    capturedAtUtc: clockIso,
    cacheState: "ready",
    unavailableReason: null,
    documents: [
      {
        documentId: "conformance-document",
        title: "Conformance Fixture Revision 2",
        pathDigest: null,
        isWorkshared: false,
        isActive: true,
      },
    ],
    activeDocumentId: "conformance-document",
    activeView: {
      documentId: "conformance-document",
      id: "3002",
      name: "Conformance 3D Revision 2",
      type: "ThreeD",
      level: null,
    },
    disciplineHint: "mechanical",
  };
}

export function middleProductionCaseVariables(
  caseId: string,
  binding: Binding,
  clockIso = "2026-07-23T00:00:00.000Z",
): Readonly<Record<string, JsonValue>> {
  if (!SUPPORTED.has(caseId)) {
    throw new Error(`middle production case seed is not implemented: ${caseId}`);
  }
  const supportedCase = caseId as MiddleProductionCase;
  const ids = invocationIds(supportedCase);
  let vectors: JsonObject = {};
  if (supportedCase === "O1-C16") {
    vectors = {
      raw_opening_hello_params: rawOpeningHello(
        supportedCase,
        "params",
        clockIso,
        uuid7(supportedCase, 10),
      ),
      raw_opening_hello_result: rawOpeningHello(
        supportedCase,
        "result",
        clockIso,
        uuid7(supportedCase, 11),
      ),
      params_over_limit_envelope: paramsOverLimitEnvelope(supportedCase, clockIso),
      result_over_limit_invoke: resultOverLimitEnvelope(supportedCase, clockIso),
    };
  } else if (supportedCase === "O1-C19") {
    vectors = c19Vectors(supportedCase);
  } else if (supportedCase === "O1-C23") {
    vectors = { document_context_revision_2: documentContextRevision2(clockIso) };
  }
  return {
    binding,
    clock: { iso: clockIso },
    case: {
      device_token: "test-device-token",
      device_id: "device-01",
    },
    ids: { [supportedCase]: ids },
    batches: batchVariables(supportedCase, ids),
    fixture: {},
    gateway: {},
    vectors,
  };
}
