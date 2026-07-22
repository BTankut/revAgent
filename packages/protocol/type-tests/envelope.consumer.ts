import type {
  BatchResult,
  DataErrorEnvelope,
  HelloEnvelope,
  Invoke,
  InvokeBatchEnvelope,
  InvokeEnvelope,
  InvocationResult,
  ManifestInfo,
  Partial,
  RecoveryClearance,
} from "../src/index.js";

const hello: HelloEnvelope = {
  v: 1,
  type: "hello",
  id: "0197a3c2-0000-7000-8000-000000000001",
  ts: "2026-07-22T12:00:00.000Z",
  payload: {
    min_protocol: 1,
    max_protocol: 1,
    capabilities: [],
    bridge_version: "1.0.0",
    device_id: "device-01",
    machine: { hostname: "WS01", os: "Windows" },
    addin_versions: [],
  },
};

const illegalControlField: HelloEnvelope = {
  ...hello,
  // @ts-expect-error control envelopes prohibit rsid, seq, and ack
  rsid: "rs_01",
};

const illegalControlSeq: HelloEnvelope = {
  ...hello,
  // @ts-expect-error control envelopes prohibit seq
  seq: 1,
};

const illegalControlAck: HelloEnvelope = {
  ...hello,
  // @ts-expect-error control envelopes prohibit ack
  ack: 0,
};

const invokePayload: InvokeEnvelope["payload"] = {
  invocation_id: "0197a3c2-0000-7000-8000-000000000010",
  method: "inspect_schedules",
  params: {},
  timeout_ms: 1_000,
  mutating: false,
  mutation_scope: null,
  policy: { class: "auto", decision: "auto", confirmation_id: null },
  verification: null,
  recovery_clearances: [],
};

// @ts-expect-error data envelopes require rsid even when seq is present
const dataMissingRsid: InvokeEnvelope = {
  v: 1,
  type: "invoke",
  id: "0197a3c2-0000-7000-8000-000000000010",
  seq: 1,
  ts: "2026-07-22T12:00:00.000Z",
  payload: invokePayload,
};

// @ts-expect-error data envelopes require seq even when rsid is present
const dataMissingSeq: InvokeEnvelope = {
  v: 1,
  type: "invoke",
  id: "0197a3c2-0000-7000-8000-000000000010",
  rsid: "rs_01",
  ts: "2026-07-22T12:00:00.000Z",
  payload: invokePayload,
};

const validBatch: InvokeBatchEnvelope = {
  v: 1,
  type: "invoke_batch",
  id: "0197a3c2-0000-7000-8000-000000000020",
  rsid: "rs_01",
  seq: 1,
  ts: "2026-07-22T12:00:00.000Z",
  payload: {
    batch_id: "0197a3c2-0000-7000-8000-000000000020",
    atomic: false,
    timeout_ms: 1_000,
    recovery_clearances: [],
    steps: [
      {
        invocation_id: "0197a3c2-0000-7000-8000-000000000021",
        method: "inspect_schedules",
        params: {},
        params_digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        mutating: false,
        mutation_scope: null,
        policy: { class: "auto", decision: "auto", confirmation_id: null },
      },
    ],
    batch_digest: "sha256:1fc2059e586e0c429fd0793b31ca910f4f4188d87813e7cce102f0a2882b48ac",
  },
};

const batchStepMethod: string = validBatch.payload.steps[0].method;

// @ts-expect-error read invocations require mutation_scope:null
const readWithMutationScope: Invoke = {
  ...invokePayload,
  mutation_scope: { kind: "session" },
};

// @ts-expect-error mutating invocations require a non-null scope
const mutationWithoutScope: Invoke = {
  ...invokePayload,
  mutating: true,
  mutation_scope: null,
};

// @ts-expect-error late_terminal requires an explicit null verification id
const invalidLateClearance: RecoveryClearance = {
  hold_id: "vh:3333333333333333333333333333333333333333333333333333333333333333",
  mutation_scope: { kind: "session" },
  resolution_id: "0197a3c2-0000-7000-8000-000000000101",
  basis: "late_terminal",
  verification_invocation_id: "0197a3c2-0000-7000-8000-000000000099",
  evidence_digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  decision: "postcondition_verified",
  audit_id: "0197a3c2-0000-7000-8000-000000000102",
};

const validArtifactChunk: Partial = {
  kind: "chunk",
  invocation_id: "0197a3c2-0000-7000-8000-000000000010",
  stream_id: "artifact:0197a3c2-0000-7000-8000-000000000201",
  artifact_id: "0197a3c2-0000-7000-8000-000000000201",
  artifact_index: 0,
  chunk_index: 0,
  encoding: "base64",
  content_type: "image/png",
  data: "UE5HMQ==",
};

// @ts-expect-error the result stream prohibits artifact identity fields
const invalidResultChunk: Partial = {
  kind: "chunk",
  invocation_id: "0197a3c2-0000-7000-8000-000000000010",
  stream_id: "result",
  artifact_id: "0197a3c2-0000-7000-8000-000000000201",
  artifact_index: 0,
  chunk_index: 0,
  encoding: "base64",
  content_type: "application/json",
  data: "e30=",
};

// @ts-expect-error guarded invocation results require guarded_reason
const guardedWithoutReason: InvocationResult = {
  kind: "invocation",
  invocation_id: "0197a3c2-0000-7000-8000-000000000010",
  status: "guarded",
  result: {},
  metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
};

// @ts-expect-error completed invocation results prohibit guarded_reason
const completedWithGuardedReason: InvocationResult = {
  kind: "invocation",
  invocation_id: "0197a3c2-0000-7000-8000-000000000010",
  status: "completed",
  guarded_reason: "not-applicable",
  result: {},
  metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
};

// @ts-expect-error atomic failed batches must be rolled_back
const atomicFailedCommitted: BatchResult = {
  kind: "batch",
  batch_id: "0197a3c2-0000-7000-8000-000000000020",
  atomic: true,
  status: "failed",
  transaction_state: "committed",
  failed_step_index: 0,
  steps: [
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "failed",
      error: {
        retryable: false,
        fault_class: "revit_api",
        outcome: "known",
        verification_required: false,
        replayed: false,
        message: "failed",
      },
      replayed: false,
    },
  ],
  replayed: false,
};

const atomicIndeterminate: BatchResult = {
  kind: "batch",
  batch_id: "0197a3c2-0000-7000-8000-000000000020",
  atomic: true,
  status: "indeterminate",
  transaction_state: "indeterminate",
  failed_step_index: 0,
  steps: [
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "indeterminate",
      error: {
        retryable: false,
        fault_class: "journal_indeterminate",
        message: "verify",
        outcome: "indeterminate",
        verification_required: true,
        replayed: false,
        verification_hold_id: "vh:3333333333333333333333333333333333333333333333333333333333333333",
        mutation_scope: { kind: "document", document_id: "doc-01" },
      },
      replayed: false,
    },
  ],
  replayed: false,
};

const lateFailedBatch: BatchResult = {
  kind: "batch",
  batch_id: "0197a3c2-0000-7000-8000-000000000020",
  atomic: false,
  status: "failed",
  transaction_state: "not_applicable",
  failed_step_index: 0,
  steps: [
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "failed",
      replayed: true,
      late_after_indeterminate: true,
      verification_hold_id: "vh:3333333333333333333333333333333333333333333333333333333333333333",
      result_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      error: {
        retryable: false,
        fault_class: "revit_api",
        outcome: "known",
        verification_required: false,
        replayed: true,
        late_after_indeterminate: true,
        verification_hold_id: "vh:3333333333333333333333333333333333333333333333333333333333333333",
        result_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        message: "late durable failure",
      },
    },
  ],
  replayed: true,
};

const invalidNestedReplay: BatchResult = {
  ...lateFailedBatch,
  replayed: false,
  steps: [
    // @ts-expect-error nested error replay cannot exceed the enclosing step replay state
    {
      ...lateFailedBatch.steps[0],
      replayed: false,
      late_after_indeterminate: false,
      verification_hold_id: undefined,
      result_digest: undefined,
      error: {
        retryable: false,
        fault_class: "revit_api",
        outcome: "known",
        verification_required: false,
        replayed: true,
        message: "invalid nested replay",
      },
    },
  ],
};

const invalidFailedCancellation: BatchResult = {
  ...lateFailedBatch,
  replayed: false,
  steps: [
    // @ts-expect-error failed steps exclude fault_class:cancelled
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "failed",
      replayed: false,
      error: {
        retryable: false,
        fault_class: "cancelled",
        outcome: "known",
        verification_required: false,
        replayed: false,
        message: "wrong carrier",
      },
    },
  ],
};

const invalidLateEvidence: BatchResult = {
  ...lateFailedBatch,
  steps: [
    // @ts-expect-error late batch steps require enclosing hold and result digest evidence
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "failed",
      replayed: true,
      late_after_indeterminate: true,
      error: lateFailedBatch.steps[0].error,
    },
  ],
};

const invalidIndeterminateStep: BatchResult = {
  ...atomicIndeterminate,
  steps: [
    // @ts-expect-error indeterminate status requires journal_indeterminate/unknown outcome
    {
      index: 0,
      invocation_id: "0197a3c2-0000-7000-8000-000000000021",
      status: "indeterminate",
      error: {
        retryable: false,
        fault_class: "revit_api",
        outcome: "known",
        verification_required: false,
        replayed: false,
        message: "wrong class",
      },
      replayed: false,
    },
  ],
};

const updateAvailable: ManifestInfo = {
  status: "update_available",
  channel: "stable",
  latest_version: "1.1.0",
  min_supported_version: "1.0.0",
  release_sequence: 2,
  rollout_cohort: "pilot",
  manifest_url: "/manifest/2",
  signature_url: "/manifest/2.sig",
};

// @ts-expect-error an available update requires rollout and both URLs
const updateMissingSignature: ManifestInfo = {
  status: "update_available",
  channel: "stable",
  latest_version: "1.1.0",
  min_supported_version: "1.0.0",
  release_sequence: 2,
  rollout_cohort: "pilot",
  manifest_url: "/manifest/2",
};

// @ts-expect-error up_to_date prohibits update metadata
const upToDateWithUpdateUrl: ManifestInfo = {
  status: "up_to_date",
  channel: "stable",
  latest_version: "1.0.0",
  min_supported_version: "1.0.0",
  release_sequence: 1,
  manifest_url: "/manifest/1",
};

const knownError: DataErrorEnvelope = {
  v: 1,
  type: "error",
  id: "0197a3c2-0000-7000-8000-000000000030",
  rsid: "rs_01",
  seq: 2,
  ts: "2026-07-22T12:00:00.000Z",
  payload: {
    retryable: false,
    fault_class: "parameter",
    message: "invalid",
    outcome: "known",
    verification_required: false,
  },
};

const invalidIndeterminateError: DataErrorEnvelope = {
  ...knownError,
  // @ts-expect-error journal_indeterminate requires retryable:false and unknown outcome fields
  payload: {
    retryable: true,
    fault_class: "journal_indeterminate",
    message: "unknown",
    outcome: "known",
    verification_required: false,
  },
};

void illegalControlField;
void illegalControlSeq;
void illegalControlAck;
void dataMissingRsid;
void dataMissingSeq;
void batchStepMethod;
void readWithMutationScope;
void mutationWithoutScope;
void invalidLateClearance;
void validArtifactChunk;
void invalidResultChunk;
void guardedWithoutReason;
void completedWithGuardedReason;
void atomicFailedCommitted;
void invalidIndeterminateStep;
void updateAvailable;
void updateMissingSignature;
void upToDateWithUpdateUrl;
void knownError;
void invalidIndeterminateError;
