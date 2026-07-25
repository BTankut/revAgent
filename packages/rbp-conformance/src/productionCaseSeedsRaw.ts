import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { JsonValue } from "./processHarness.js";
import type { Binding } from "./types.js";

export const RAW_PRODUCTION_CASES = [
  "O1-C25",
  "O1-C26",
  "O1-C27",
  "O1-C28",
  "O1-C29",
  "O1-C30",
  "O1-C31",
  "O1-C32",
  "O1-C33",
  "O1-C34",
  "O1-C35",
  "O1-C36",
  "O1-C37",
  "O1-C38",
  "O1-C39",
  "O1-C40",
] as const;

export type RawProductionCaseId = (typeof RAW_PRODUCTION_CASES)[number];

export const C27_RECONNECT_JITTER_UNITS = Object.freeze(
  Array.from({ length: 9 }, () => 0.999999),
);
export const C27_OPENING_FAILURE_COUNT = 8 as const;

export interface RawProductionRuntimeSeed {
  readonly binding?: Binding;
  readonly deviceToken?: string;
  readonly otherDeviceToken?: string;
}

export interface RawProductionFrameFact {
  readonly caseId: RawProductionCaseId;
  readonly stepId: string;
  readonly source: "frame" | "serializedFrame";
  readonly credentialSource: "configured" | "step_override";
  readonly type: string | null;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

const CLOCK_ISO = "2026-07-22T12:00:00.000Z";
const MAX_SAFE_SEQUENCE = 9_007_199_254_740_991;
const DEFAULT_RSID = "rs_raw_primary";
const DOCUMENT_ID = "doc-raw-001";
const FINGERPRINT = `sha256:${"0".repeat(64)}`;
const OTHER_FINGERPRINT = `sha256:${"1".repeat(64)}`;
const RESULT_DIGEST = sha256Json({ verified: true });
const EVIDENCE_DIGEST = RESULT_DIGEST;
const HOLD_ID = `vh:${"2".repeat(64)}`;

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("raw production seed contains an unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("raw production seed contains an unpaired low surrogate");
    }
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("raw production seed contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => {
    assertWellFormedUnicode(key);
    return `${JSON.stringify(key)}:${canonicalize(value[key]!)}`;
  }).join(",")}}`;
}

function sha256Json(value: JsonValue): `sha256:${string}` {
  return sha256Text(canonicalize(value));
}

function deterministicUuid(key: string): string {
  const hex = createHash("sha256").update(`revagent-rbp-raw:${key}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function messageId(key: string): string {
  return deterministicUuid(`message:${key}`);
}

function invocationId(key: string): string {
  return deterministicUuid(`invocation:${key}`);
}

function batchId(key: string): string {
  return deterministicUuid(`batch:${key}`);
}

function hello(
  key: string,
  deviceId = "device-01",
  fingerprint = FINGERPRINT,
  minimum = 1,
  maximum = 1,
): JsonValue {
  return {
    type: "hello",
    id: messageId(`${key}:hello`),
    ts: CLOCK_ISO,
    payload: {
      min_protocol: minimum,
      max_protocol: maximum,
      capabilities: [
        "journal_v1",
        "chunked_results",
        "doc_context_cached_v1",
        "transport_streamable_http",
      ],
      bridge_version: "1.0.0-conformance",
      device_id: deviceId,
      machine: {
        hostname: "raw-conformance-host",
        os: "Windows 11",
        fingerprint,
      },
      addin_versions: ["2026.07.22.0"],
    },
  };
}

function controlFrame(key: string, type: string, payload: JsonValue): JsonValue {
  return {
    v: 1,
    type,
    id: messageId(key),
    ts: CLOCK_ISO,
    payload,
  };
}

function dataFrame(
  key: string,
  type: string,
  payload: JsonValue,
  sequence = 1,
  rsid = DEFAULT_RSID,
): JsonValue {
  return {
    v: 1,
    type,
    id: messageId(key),
    ts: CLOCK_ISO,
    rsid,
    seq: sequence,
    ack: 0,
    payload,
  };
}

function policy(kind: "read" | "write" = "read"): JsonValue {
  return kind === "read"
    ? { class: "auto", decision: "auto", confirmation_id: null }
    : { class: "confirm", decision: "confirmed", confirmation_id: deterministicUuid("confirmation") };
}

function invokePayload(
  key: string,
  options: {
    readonly method?: string;
    readonly params?: JsonValue;
    readonly timeoutMs?: number;
    readonly mutating?: boolean;
    readonly mutationScope?: JsonValue;
    readonly verification?: JsonValue;
    readonly recoveryClearances?: JsonValue[];
  } = {},
): JsonValue {
  const mutating = options.mutating ?? false;
  return {
    invocation_id: invocationId(key),
    method: options.method ?? "fixture_echo",
    params: options.params ?? { vector: key },
    timeout_ms: options.timeoutMs ?? 30_000,
    mutating,
    mutation_scope: mutating ? (options.mutationScope ?? { kind: "session" }) : null,
    policy: policy(mutating ? "write" : "read"),
    verification: options.verification ?? null,
    recovery_clearances: options.recoveryClearances ?? [],
  };
}

interface BatchStepSeed {
  readonly invocation_id: string;
  readonly method: string;
  readonly params: JsonValue;
  readonly params_digest: string;
  readonly mutating: boolean;
  readonly mutation_scope: JsonValue;
  readonly policy: JsonValue;
}

function batchStep(
  key: string,
  params: JsonValue = { vector: key },
  mutating = false,
): BatchStepSeed {
  return {
    invocation_id: invocationId(key),
    method: "fixture_echo",
    params,
    params_digest: sha256Json(params),
    mutating,
    mutation_scope: mutating ? { kind: "session" } : null,
    policy: policy(mutating ? "write" : "read"),
  };
}

function batchDigest(input: {
  readonly atomic: boolean;
  readonly batch_id: string;
  readonly timeout_ms: number;
  readonly recovery_clearances: readonly JsonValue[];
  readonly steps: readonly BatchStepSeed[];
}): `sha256:${string}` {
  return sha256Json({
    atomic: input.atomic,
    batch_id: input.batch_id,
    recovery_clearances: [...input.recovery_clearances],
    steps: input.steps.map((step) => ({
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope,
      params_digest: step.params_digest,
      policy: step.policy,
    })),
    timeout_ms: input.timeout_ms,
  });
}

function batchEnvelope(
  key: string,
  atomic: boolean,
  steps: readonly BatchStepSeed[],
  recoveryClearances: readonly JsonValue[] = [],
): JsonValue {
  const payloadBase = {
    batch_id: batchId(key),
    atomic,
    timeout_ms: 30_000,
    recovery_clearances: [...recoveryClearances],
    steps: steps.map((step) => ({ ...step })),
  };
  return dataFrame(key, "invoke_batch", {
    ...payloadBase,
    batch_digest: batchDigest(payloadBase),
  });
}

function resultMetrics(): JsonValue {
  return {
    execute_ms: 1,
    request_bytes: 64,
    response_bytes: 64,
    framing: "length-prefixed",
  };
}

function sessionRegisterPayload(key: string): JsonValue {
  return {
    local_session_key: `raw:${key}`,
    user_hint: { name: "Baris Tankut" },
    machine: {
      hostname: "raw-conformance-host",
      fingerprint: FINGERPRINT,
    },
    revit: { version: "2026", build: "26.0.0", pid: 4_226 },
    addin_version: "2026.07.22.0",
    result_contract_version: 2,
    session_capabilities: ["batch_atomic", "chunked_results", "doc_context_cached_v1"],
    bridge_version: "1.0.0-conformance",
    documents: [{
      document_id: DOCUMENT_ID,
      title: "Raw conformance document",
      path_digest: `sha256:${"3".repeat(64)}`,
      is_workshared: false,
      is_active: true,
    }],
    port: 48_298,
  };
}

function c28Vectors(): Record<string, JsonValue> {
  const origin = invokePayload("O1-C28:origin", {
    method: "send_code_to_revit",
    params: { vector: "O1-C28:origin", fixtureOnly: true },
    timeoutMs: 250,
    mutating: true,
  });
  const fresh = invokePayload("O1-C28:fresh", {
    method: "send_code_to_revit",
    params: { vector: "O1-C28:fresh", fixtureOnly: true },
    mutating: true,
  });
  const conflictingParams = {
    viewId: 28_001,
    mode: "commit",
    confirmDelete: true,
    viewType: "ThreeD",
  };
  const conflictingStep: BatchStepSeed = {
    ...batchStep("O1-C28:batch-write", conflictingParams, true),
    method: "delete_review_view",
  };
  const conflictingBatch = batchEnvelope(
    "O1-C28:conflicting",
    false,
    [conflictingStep],
  ) as Record<string, JsonValue>;
  const invalidRecovery = invokePayload("O1-C28:invalid-recovery", {
    method: "send_code_to_revit",
    params: { vector: "O1-C28:invalid-recovery", fixtureOnly: true },
    mutating: true,
  });
  return {
    c28: {
      origin,
      fresh,
      conflicting_batch: conflictingBatch,
      verification: invokePayload("O1-C28:verification", {
        method: "fixture_echo",
        params: { vector: "O1-C28:verification", fixtureOnly: true },
      }),
      recovery: invokePayload("O1-C28:recovery", {
        method: "send_code_to_revit",
        params: { vector: "O1-C28:recovery", fixtureOnly: true },
        mutating: true,
      }),
      invalid_recovery: invalidRecovery,
      invalid_verification_invocation_id: invocationId("O1-C28:invalid-verification"),
      invalid_evidence_digest: sha256Json({ vector: "O1-C28:invalid-evidence" }),
      invalid_resolution_id: deterministicUuid("O1-C28:invalid-resolution"),
      invalid_audit_id: deterministicUuid("O1-C28:invalid-audit"),
      resolution_id: deterministicUuid("O1-C28:resolution"),
      audit_id: deterministicUuid("O1-C28:audit"),
      evidence_at_ms: Date.parse(CLOCK_ISO),
    },
  };
}

function c29Vectors(): Record<string, JsonValue> {
  const c29ReadStep = (key: string): BatchStepSeed => {
    const params = { vector: key };
    return {
      invocation_id: invocationId(key),
      method: "get_ui_state",
      params,
      params_digest: sha256Json(params),
      mutating: false,
      mutation_scope: null,
      policy: policy("read"),
    };
  };
  const c29MutationStep = (key: string, viewId: number): BatchStepSeed => {
    const params = {
      viewId,
      mode: "commit",
      confirmDelete: true,
      viewType: "ThreeD",
    };
    return {
      invocation_id: invocationId(key),
      method: "delete_review_view",
      params,
      params_digest: sha256Json(params),
      mutating: true,
      mutation_scope: { kind: "session" },
      policy: policy("write"),
    };
  };
  return {
    mixed_write_invocation_id: invocationId("O1-C29:mixed:write-1"),
    mixed_non_atomic: batchEnvelope("O1-C29:mixed-non-atomic", false, [
      c29ReadStep("O1-C29:mixed:read-0"),
      c29MutationStep("O1-C29:mixed:write-1", 29_001),
      c29ReadStep("O1-C29:mixed:read-2"),
    ]),
    atomic_terminal: batchEnvelope("O1-C29:atomic-terminal", true, [
      c29ReadStep("O1-C29:atomic-terminal:read"),
      c29MutationStep("O1-C29:atomic-terminal:write", 29_002),
    ]),
    atomic_indeterminate: batchEnvelope("O1-C29:atomic-indeterminate", true, [
      c29ReadStep("O1-C29:atomic-indeterminate:read"),
      c29MutationStep("O1-C29:atomic-indeterminate:write", 29_003),
    ]),
  };
}

function c30Batch(key: string, params: JsonValue): JsonValue {
  return batchEnvelope(`O1-C30:${key}`, false, [batchStep(`O1-C30:${key}:step`, params)]);
}

function c30Vectors(): Record<string, JsonValue> {
  const propertyOrder = c30Batch("property-order", { b: 1, a: 2 });
  const numberFormatting = c30Batch("number-formatting", { z: 0, tiny: 1e-27, n: 1e30, m: 4.5 });
  const unicode = c30Batch("unicode", { "€": "euro", "😀": "emoji", "é": "composed", "é": "decomposed" });
  const escapes = c30Batch("escapes", { string: "line\nquote\"slash\\solidus/control\u000f" });
  const paramsMismatch = structuredClone(propertyOrder) as Record<string, JsonValue>;
  const paramsMismatchStep = ((paramsMismatch.payload as Record<string, JsonValue>).steps as JsonValue[])[0] as Record<string, JsonValue>;
  paramsMismatchStep.params_digest = `sha256:${"5".repeat(64)}`;
  const perStep = batchEnvelope("O1-C30:per-step-digest", false, [
    batchStep("O1-C30:per-step:0"),
    batchStep("O1-C30:per-step:1"),
  ]) as Record<string, JsonValue>;
  const perStepRows = ((perStep.payload as Record<string, JsonValue>).steps as JsonValue[]);
  (perStepRows[1] as Record<string, JsonValue>).params_digest = `sha256:${"6".repeat(64)}`;
  const batchMismatch = structuredClone(propertyOrder) as Record<string, JsonValue>;
  (batchMismatch.payload as Record<string, JsonValue>).batch_digest = `sha256:${"7".repeat(64)}`;
  const omitted = structuredClone(propertyOrder) as Record<string, JsonValue>;
  (omitted.payload as Record<string, JsonValue>).steps = [];
  const changedPolicy = batchEnvelope("O1-C30:changed-policy", false, [
    batchStep("O1-C30:redelivery", { stable: true }, true),
  ]) as Record<string, JsonValue>;
  const changedPolicyPayload = changedPolicy.payload as Record<string, JsonValue>;
  ((changedPolicyPayload.steps as JsonValue[])[0] as Record<string, JsonValue>).policy = {
    class: "gated",
    decision: "gated_approved",
    confirmation_id: deterministicUuid("O1-C30:changed-policy"),
  };
  changedPolicyPayload.batch_digest = batchDigest(changedPolicyPayload as never);
  const changedScope = batchEnvelope("O1-C30:changed-scope", false, [
    batchStep("O1-C30:redelivery-scope", { stable: true }, true),
  ]) as Record<string, JsonValue>;
  const changedScopePayload = changedScope.payload as Record<string, JsonValue>;
  ((changedScopePayload.steps as JsonValue[])[0] as Record<string, JsonValue>).mutation_scope = {
    kind: "document",
    document_id: DOCUMENT_ID,
  };
  changedScopePayload.batch_digest = batchDigest(changedScopePayload as never);
  const clearance = {
    hold_id: HOLD_ID,
    mutation_scope: { kind: "session" },
    resolution_id: deterministicUuid("O1-C30:clearance-resolution"),
    basis: "late_terminal",
    verification_invocation_id: null,
    evidence_digest: EVIDENCE_DIGEST,
    decision: "postcondition_verified",
    audit_id: deterministicUuid("O1-C30:clearance-audit"),
  };
  const changedClearance = batchEnvelope("O1-C30:changed-clearance", false, [
    batchStep("O1-C30:redelivery-clearance", { stable: true }, true),
  ], [clearance]);

  const harmlessObject = c30Batch("harmless-reserialization", {
    escaped: "line\nvalue",
    order: { z: 1, a: 2 },
  });
  const harmlessRecord = harmlessObject as Record<string, JsonValue>;
  const harmlessPayload = harmlessRecord.payload as Record<string, JsonValue>;
  const harmlessStep = (harmlessPayload.steps as JsonValue[])[0] as Record<string, JsonValue>;
  const harmlessSerialized = `{"ts":${JSON.stringify(CLOCK_ISO)},"id":${JSON.stringify(harmlessRecord.id)},"type":"invoke_batch","v":1,"ack":0,"seq":1,"rsid":${JSON.stringify(DEFAULT_RSID)},"payload":{"steps":[{"policy":${JSON.stringify(harmlessStep.policy)},"mutation_scope":null,"mutating":false,"params_digest":${JSON.stringify(harmlessStep.params_digest)},"params":{"order":{"z":1,"a":2},"escaped":"line\\u000avalue"},"method":"fixture_echo","invocation_id":${JSON.stringify(harmlessStep.invocation_id)}}],"timeout_ms":30000,"recovery_clearances":[],"batch_id":${JSON.stringify(harmlessPayload.batch_id)},"batch_digest":${JSON.stringify(harmlessPayload.batch_digest)},"atomic":false}}`;

  return {
    "property-order": propertyOrder,
    "number-formatting": numberFormatting,
    unicode,
    escapes,
    "step-omission": omitted,
    "params-digest-mismatch": paramsMismatch,
    "per-step-digest": perStep,
    "batch-digest": batchMismatch,
    "changed-policy": changedPolicy,
    "changed-scope": changedScope,
    "changed-clearance": changedClearance,
    "harmless-reserialization": harmlessSerialized,
  };
}

function c31Vectors(): Record<string, JsonValue> {
  const validRegister = sessionRegisterPayload("c31");
  const invalidRegister = structuredClone(validRegister) as Record<string, JsonValue>;
  invalidRegister.documents = [{ document_id: DOCUMENT_ID }];
  return {
    heartbeat_ack_positive: controlFrame("O1-C31:heartbeat-ack-positive", "heartbeat_ack", {
      server_time: CLOCK_ISO,
      acks: [{ rsid: DEFAULT_RSID, seq: 0 }],
    }),
    heartbeat_ack_negative: controlFrame("O1-C31:heartbeat-ack-negative", "heartbeat_ack", {
      acks: [{ rsid: DEFAULT_RSID, seq: 0 }],
    }),
    session_register_positive: controlFrame("O1-C31:register-positive", "session_register", validRegister),
    session_register_negative: controlFrame("O1-C31:register-negative", "session_register", invalidRegister),
    session_unregister_positive: controlFrame("O1-C31:unregister-positive", "session_unregister", {
      rsid: DEFAULT_RSID,
      reason: "operator_requested",
    }),
    session_unregister_negative: controlFrame("O1-C31:unregister-negative", "session_unregister", {
      rsid: DEFAULT_RSID,
      reason: "unknown_reason",
    }),
    session_resume_positive: controlFrame("O1-C31:resume-positive", "session_resume", {
      rsid: DEFAULT_RSID,
      resume_token: "opaque-valid-shape-token",
      last_rx_seq: 0,
    }),
    session_resume_negative: controlFrame("O1-C31:resume-negative", "session_resume", {
      rsid: DEFAULT_RSID,
      last_rx_seq: 0,
    }),
    cancel_positive: dataFrame("O1-C31:cancel-positive", "cancel", {
      invocation_id: invocationId("O1-C31:cancel-target"),
      reason: "user_requested",
    }),
    cancel_negative: dataFrame("O1-C31:cancel-negative", "cancel", {
      invocation_id: invocationId("O1-C31:cancel-target"),
      reason: "not_a_reason",
    }),
    goodbye_positive: controlFrame("O1-C31:goodbye-positive", "goodbye", {
      reason: "server_draining",
      retry_after_ms: 1_000,
    }),
    goodbye_negative: controlFrame("O1-C31:goodbye-negative", "goodbye", {
      reason: "shutdown",
      retry_after_ms: 1_000,
    }),
    manifest_positive: controlFrame("O1-C31:manifest-positive", "manifest_check", {
      bridge_version: "1.0.0-conformance",
      addin_versions: ["2026.07.22.0"],
      channel: "stable",
      highest_accepted_release_sequence: 42,
    }),
    manifest_negative: controlFrame("O1-C31:manifest-negative", "manifest_check", {
      bridge_version: "1.0.0-conformance",
      addin_versions: ["2026.07.22.0"],
      channel: "stable",
    }),
  };
}

function partialChunk(
  key: string,
  data: string,
  options: {
    readonly streamId?: string;
    readonly artifactId?: string;
    readonly artifactIndex?: number;
    readonly chunkIndex?: number;
    readonly invocation?: string;
  } = {},
): JsonValue {
  const streamId = options.streamId ?? "result";
  return dataFrame(key, "partial", {
    kind: "chunk",
    invocation_id: options.invocation ?? invocationId("O1-C32:target"),
    stream_id: streamId,
    ...(streamId === "result"
      ? {}
      : {
          artifact_id: options.artifactId ?? deterministicUuid("O1-C32:artifact"),
          artifact_index: options.artifactIndex ?? 0,
        }),
    chunk_index: options.chunkIndex ?? 0,
    encoding: "base64",
    content_type: "application/octet-stream",
    data,
  });
}

function c32Vectors(): Record<string, JsonValue> {
  const artifactId = deterministicUuid("O1-C32:artifact");
  const invocation = invocationId("O1-C32:target");
  const bytes = Buffer.from("raw-chunk", "utf8");
  return {
    base64_alphabet: partialChunk("O1-C32:base64-alphabet", "AA-_"),
    base64_padding: partialChunk("O1-C32:base64-padding", "A==="),
    stream_identity: partialChunk("O1-C32:stream-identity", bytes.toString("base64"), {
      streamId: `artifact:${artifactId}`,
      artifactId: deterministicUuid("O1-C32:other-artifact"),
      invocation,
    }),
    stream_indexing: partialChunk("O1-C32:stream-indexing", bytes.toString("base64"), {
      chunkIndex: 1,
      invocation,
    }),
    decoded_limit: partialChunk(
      "O1-C32:decoded-limit",
      Buffer.alloc(1024 * 1024 + 1).toString("base64"),
      { invocation },
    ),
    reconstruction_size: dataFrame("O1-C32:reconstruction-size", "result", {
      kind: "invocation",
      invocation_id: invocation,
      status: "completed",
      chunked: true,
      stream_id: "result",
      content_type: "application/octet-stream",
      total_chunks: 1,
      total_size: bytes.byteLength + 1,
      sha256: sha256Text(bytes.toString("utf8")),
      replayed: false,
      metrics: resultMetrics(),
    }),
    content_digest: dataFrame("O1-C32:content-digest", "result", {
      kind: "invocation",
      invocation_id: invocation,
      status: "completed",
      chunked: true,
      stream_id: "result",
      content_type: "application/octet-stream",
      total_chunks: 1,
      total_size: bytes.byteLength,
      sha256: `sha256:${"9".repeat(64)}`,
      replayed: false,
      metrics: resultMetrics(),
    }),
  };
}

function c34Vectors(): Record<string, JsonValue> {
  const valid = sessionRegisterPayload("c34");
  const seatSpoof = { ...(valid as Record<string, JsonValue>), seat_id: "seat-foreign" };
  const userHint = (valid as Record<string, JsonValue>).user_hint as Record<string, JsonValue>;
  const userSpoof = {
    ...(valid as Record<string, JsonValue>),
    user_hint: { ...userHint, user_id: "user-foreign" },
  };
  return {
    valid_session_register: controlFrame("O1-C34:valid", "session_register", valid),
    seat_spoof_register: controlFrame("O1-C34:seat-spoof", "session_register", seatSpoof),
    user_spoof_register: controlFrame("O1-C34:user-spoof", "session_register", userSpoof),
  };
}

function documentContext(sequence: number, key: string): JsonValue {
  return dataFrame(key, "doc_context_update", {
    documents: [{
      document_id: DOCUMENT_ID,
      title: "Raw conformance document",
      path_digest: null,
      is_workshared: false,
      is_active: true,
    }],
    active_document: DOCUMENT_ID,
    active_view: null,
  }, sequence);
}

function c35Vectors(): Record<string, JsonValue> {
  return {
    max_safe_seq: documentContext(MAX_SAFE_SEQUENCE, "O1-C35:max-safe"),
    unsafe_two_pow_53: documentContext(MAX_SAFE_SEQUENCE + 1, "O1-C35:unsafe"),
    no_wrap_renewal: documentContext(MAX_SAFE_SEQUENCE - 1, "O1-C35:no-wrap"),
    duplicate_seq: documentContext(1, "O1-C35:duplicate"),
    gap_seq: documentContext(3, "O1-C35:gap"),
  };
}

function c37Vectors(): Record<string, JsonValue> {
  const reasons = ["revit_exited", "bridge_shutdown", "session_replaced", "operator_requested"] as const;
  return Object.fromEntries(reasons.map((reason) => [
    reason,
    {
      possibly_dispatched_invocation_id: invocationId(`O1-C37:${reason}:possibly-dispatched`),
      possibly_dispatched_mutation:
        invokePayload(`O1-C37:${reason}:possibly-dispatched`, { mutating: true }),
      post_unregister_invoke: invokePayload(`O1-C37:${reason}:post-unregister`),
    },
  ])) as Record<string, JsonValue>;
}

function c38Vectors(): Record<string, JsonValue> {
  const guarded = batchEnvelope("O1-C38:guarded", false, [
    { ...batchStep("O1-C38:guarded:0"), method: "get_ui_state" },
    { ...batchStep("O1-C38:guarded:1"), method: "get_ui_state" },
    { ...batchStep("O1-C38:guarded:2"), method: "get_ui_state" },
  ]);
  return {
    guarded,
    guarded_first_invocation_id:
      (((guarded as Record<string, JsonValue>).payload as Record<string, JsonValue>).steps as JsonValue[])
        .map((step) => (step as Record<string, JsonValue>).invocation_id)[0]!,
    guarded_without_reason: dataFrame("O1-C38:guarded-without-reason", "result", {
      kind: "invocation",
      invocation_id: invocationId("O1-C38:missing-reason"),
      status: "guarded",
      result: { guarded: true },
      replayed: false,
      metrics: resultMetrics(),
    }),
  };
}

function omittedResult(
  key: string,
  patch: Readonly<Record<string, JsonValue>> = {},
): JsonValue {
  return dataFrame(key, "result", {
    kind: "invocation",
    invocation_id: invocationId("O1-C39:origin"),
    status: "completed",
    payload_omitted: true,
    result_digest: RESULT_DIGEST,
    replayed: true,
    metrics: resultMetrics(),
    ...patch,
  });
}

function c39Vectors(): Record<string, JsonValue> {
  const origin = invokePayload("O1-C39:origin", {
    method: "fixture_multi_file_output",
    params: {
      scenario: "valid_multifile",
      fileCount: 1,
      bytesPerFile: 1_048_577,
    },
  });
  const recoveryPayload = invokePayload("O1-C39:recovery", {
    params: {
      origin_invocation_id: invocationId("O1-C39:origin"),
      expected_result_digest: RESULT_DIGEST,
    },
  });
  return {
    origin,
    valid_recovery: {
      rsid: DEFAULT_RSID,
      originInvocationId: invocationId("O1-C39:origin"),
      omittedResultDigest: RESULT_DIGEST,
      auditId: deterministicUuid("O1-C39:audit"),
      payload: recoveryPayload,
    },
    nonreplay: omittedResult("O1-C39:nonreplay", { replayed: false }),
    missing_digest: (() => {
      const frame = omittedResult("O1-C39:missing-digest") as Record<string, JsonValue>;
      delete (frame.payload as Record<string, JsonValue>).result_digest;
      return frame;
    })(),
    inline_result: omittedResult("O1-C39:inline-result", { result: { guessed: true } }),
  };
}

function c40Vectors(): Record<string, JsonValue> {
  return {
    raw_path: { params: { scenario: "raw_path", path: "C:\\temp\\raw-output.bin" } },
    local_path: { params: { scenario: "local_path", path: "C:\\temp\\local-output.bin" } },
    traversal_path: { params: { scenario: "traversal_path", path: "..\\outside\\artifact.bin" } },
    reparse_path: { params: { scenario: "reparse_path", path: "C:\\temp\\reparse-output.bin" } },
    valid_multifile: { params: { scenario: "valid_multifile", fileCount: 2, bytesPerFile: 1_048_577 } },
    retransmission: { params: { scenario: "valid_multifile", fileCount: 2, bytesPerFile: 1_048_577 } },
    invalid_member: { params: { scenario: "invalid_member" } },
  };
}

function rawVectors(): Record<string, JsonValue> {
  const c30 = c30Vectors();
  return {
    raw_opening_hello: hello("raw-opening"),
    cross_device_opening_hello: hello(
      "cross-device-opening",
      "device-02",
      OTHER_FINGERPRINT,
    ),
    c25: {
      foreign_session_register: controlFrame(
        "O1-C25:foreign-session-register",
        "session_register",
        sessionRegisterPayload("c25-foreign"),
      ),
    },
    hello_version_n: hello("O1-C26:version-n", "device-01", FINGERPRINT, 2, 2),
    hello_version_n_minus_one: hello("O1-C26:version-n-minus-one", "device-01", FINGERPRINT, 1, 1),
    additive_within_version: {
      ...(hello("O1-C26:additive", "device-01", FINGERPRINT, 2, 2) as Record<string, JsonValue>),
      additive_probe: { optional: true },
    },
    breaking_within_version: (() => {
      const frame = hello("O1-C26:breaking", "device-01", FINGERPRINT, 2, 2) as Record<string, JsonValue>;
      const payload = frame.payload as Record<string, JsonValue>;
      delete payload.addin_versions;
      return frame;
    })(),
    c27_reconnect_jitter_units: [...C27_RECONNECT_JITTER_UNITS],
    c27_opening_failure_count: C27_OPENING_FAILURE_COUNT,
    ...c28Vectors(),
    c29: c29Vectors(),
    c30,
    c31: c31Vectors(),
    c32: c32Vectors(),
    remote_hostname: "raw-nonloopback.invalid",
    c34: c34Vectors(),
    c35: c35Vectors(),
    c37: c37Vectors(),
    c38: c38Vectors(),
    c39: c39Vectors(),
    c40: c40Vectors(),
  };
}

const RAW_VECTORS = rawVectors();

function idsForPrograms(): Record<string, JsonValue> {
  const ids: Record<string, JsonValue> = {};
  for (const caseId of RAW_PRODUCTION_CASES) {
    const caseIds: Record<string, JsonValue> = {
      "hello-initial": { envelopeId: messageId(`${caseId}:hello-initial`) },
      "hello-other-binding": { envelopeId: messageId(`${caseId}:hello-other-binding`) },
      "hello-proxy-sse": { envelopeId: messageId(`${caseId}:hello-proxy-sse`) },
    };
    if (caseId === "O1-C29") {
      caseIds["hello-mixed-restart"] = {
        envelopeId: messageId(`${caseId}:hello-mixed-restart`),
      };
      caseIds["hello-atomic-restart"] = {
        envelopeId: messageId(`${caseId}:hello-atomic-restart`),
      };
    }
    for (const suffix of [
      "raw_path",
      "local_path",
      "traversal_path",
      "reparse_path",
      "valid_multifile",
      "retransmission",
      "invalid_member",
      "duplicate",
      "gap",
    ]) {
      caseIds[suffix] = {
        envelopeId: messageId(`${caseId}:${suffix}`),
        invocationId: invocationId(`${caseId}:${suffix}`),
        batchId: batchId(`${caseId}:${suffix}`),
      };
    }
    if (caseId === "O1-C25") {
      for (const suffix of ["cross-device-resume", "cross-rsid-resume", "foreign-invoke"]) {
        caseIds[suffix] = {
          envelopeId: messageId(`${caseId}:${suffix}`),
          invocationId: invocationId(`${caseId}:${suffix}`),
        };
      }
    }
    ids[caseId] = caseIds;
  }
  return ids;
}

function commonBatchSteps(): JsonValue[] {
  return [batchStep("raw-common-batch-step") as unknown as JsonValue];
}

function assertRuntimeSeed(input: RawProductionRuntimeSeed): void {
  if (input.binding !== undefined && input.binding !== "wss" && input.binding !== "streamable_http_sse") {
    throw new TypeError("raw production binding must be wss or streamable_http_sse");
  }
  for (const [label, value] of [
    ["deviceToken", input.deviceToken],
    ["otherDeviceToken", input.otherDeviceToken],
  ] as const) {
    if (value !== undefined && (value.length < 1 || value.length > 4_096 || /[\r\n\u0000]/u.test(value))) {
      throw new TypeError(`raw production ${label} must be a bounded non-empty string`);
    }
  }
}

/**
 * Returns a fresh, deterministic parent-runner seed for one C25-C40 program.
 * Runtime readiness values may replace only endpoints and opaque credentials;
 * protocol vectors and canonical identities remain immutable across bindings.
 */
export function rawProductionCaseVariables(
  caseId: RawProductionCaseId,
  input: RawProductionRuntimeSeed = {},
): Readonly<Record<string, JsonValue>> {
  if (!(RAW_PRODUCTION_CASES as readonly string[]).includes(caseId)) {
    throw new TypeError(`unsupported raw production case ${caseId as string}`);
  }
  assertRuntimeSeed(input);
  const binding = input.binding ?? "wss";
  const commonSteps = commonBatchSteps();
  const commonBatch = {
    atomic: false,
    batch_id: batchId("raw-common-batch"),
    recovery_clearances: [],
    steps: commonSteps,
    timeout_ms: 30_000,
  };
  return structuredClone({
    binding,
    clock: { iso: CLOCK_ISO },
    protocol: { N: 2, N_minus_one: 1 },
    fixture: {
      sessionCapabilities: ["batch_atomic", "chunked_results", "doc_context_cached_v1"],
    },
    case: {
      device_token: input.deviceToken ?? "test-device-token",
      other_device_token: input.otherDeviceToken ?? "other-device-token",
      device_id: "device-01",
      batch_steps: commonSteps,
    },
    ids: idsForPrograms(),
    jcs: { batch_digest: batchDigest(commonBatch as never) },
    vectors: RAW_VECTORS,
  });
}

function frameFact(
  caseId: RawProductionCaseId,
  stepId: string,
  value: JsonValue,
  source: RawProductionFrameFact["source"] = "frame",
  credentialSource: RawProductionFrameFact["credentialSource"] = "configured",
): RawProductionFrameFact {
  const serialized = source === "serializedFrame"
    ? String(value)
    : JSON.stringify(value);
  let type: string | null = null;
  try {
    const parsed = source === "serializedFrame" ? JSON.parse(serialized) as unknown : value;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = (parsed as { type?: unknown }).type;
      if (typeof candidate === "string") type = candidate;
    }
  } catch {
    type = null;
  }
  return {
    caseId,
    stepId,
    source,
    credentialSource,
    type,
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: sha256Text(serialized),
  };
}

function frameFacts(): ReadonlyMap<string, RawProductionFrameFact> {
  const vectors = RAW_VECTORS;
  const facts: RawProductionFrameFact[] = [
    frameFact(
      "O1-C25",
      "o1-c25.foreign-session-register",
      (vectors.c25 as Record<string, JsonValue>).foreign_session_register!,
    ),
    frameFact("O1-C26", "o1-c26.version-n", vectors.hello_version_n!),
    frameFact("O1-C26", "o1-c26.version-n-minus-one", vectors.hello_version_n_minus_one!),
    frameFact("O1-C26", "o1-c26.additive", vectors.additive_within_version!),
    frameFact("O1-C26", "o1-c26.breaking", vectors.breaking_within_version!),
    ...Object.entries(vectors.c30 as Record<string, JsonValue>).map(([name, value]) =>
      frameFact(
        "O1-C30",
        `o1-c30.${name}`,
        value,
        name === "harmless-reserialization" ? "serializedFrame" : "frame",
      )),
    ...Object.entries(vectors.c31 as Record<string, JsonValue>).map(([name, value]) =>
      frameFact("O1-C31", `o1-c31.${name}`, value)),
    frameFact(
      "O1-C34",
      "o1-c34.document-schema",
      (vectors.c34 as Record<string, JsonValue>).valid_session_register!,
    ),
    frameFact(
      "O1-C34",
      "o1-c34.seat-spoof",
      (vectors.c34 as Record<string, JsonValue>).seat_spoof_register!,
      "frame",
      "step_override",
    ),
    frameFact(
      "O1-C34",
      "o1-c34.user-spoof",
      (vectors.c34 as Record<string, JsonValue>).user_spoof_register!,
      "frame",
      "step_override",
    ),
    frameFact(
      "O1-C35",
      "o1-c35.unsafe_two_pow_53",
      (vectors.c35 as Record<string, JsonValue>).unsafe_two_pow_53!,
    ),
    frameFact("O1-C36", "o1-c36.capture-opening-fault", vectors.raw_opening_hello!),
    frameFact(
      "O1-C38",
      "o1-c38.missing-reason",
      (vectors.c38 as Record<string, JsonValue>).guarded_without_reason!,
    ),
    ...["nonreplay", "missing_digest", "inline_result"].map((name) =>
      frameFact("O1-C39", `o1-c39.${name}`, (vectors.c39 as Record<string, JsonValue>)[name]!)),
  ];
  const byStep = new Map<string, RawProductionFrameFact>();
  for (const fact of facts) {
    if (byStep.has(fact.stepId)) throw new Error(`duplicate raw production frame fact ${fact.stepId}`);
    byStep.set(fact.stepId, Object.freeze(fact));
  }
  return byStep;
}

export const RAW_PRODUCTION_FRAME_FACTS = frameFacts();

export function rawProductionFrameFact(stepId: string): RawProductionFrameFact | undefined {
  const fact = RAW_PRODUCTION_FRAME_FACTS.get(stepId);
  return fact === undefined ? undefined : { ...fact };
}

/** Driver callback: C25 authenticates the cross-device probe with the other enrolled identity. */
export function rawProductionOpeningHello(
  request: Readonly<{ caseId: string; stepId: string }>,
): JsonValue {
  if (request.caseId === "O1-C25" && request.stepId === "o1-c25.cross-device-resume") {
    return structuredClone((RAW_VECTORS.cross_device_opening_hello as JsonValue));
  }
  return structuredClone((RAW_VECTORS.raw_opening_hello as JsonValue));
}
