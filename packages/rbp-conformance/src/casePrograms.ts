import {
  makeBatchDigest,
  makeParamsDigest,
  type BatchDigestInput,
  type JsonValue,
} from "@revagent/protocol";

import { canonicalManifest } from "./manifest.js";
import type {
  AssertionCategory,
  Binding,
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

export const GATEWAY_CONTROL_ACTIONS = [
  "enqueue_frame_fault",
  "enqueue_opening_fault",
  "flush_held",
  "set_sse_buffering",
  "disconnect",
  "set_auth_status",
  "expire_pending",
  "install_hold",
  "record_verification_evidence",
  "record_late_terminal_evidence",
  "dispatch_invoke",
  "dispatch_batch",
  "dispatch_cancel",
  "dispatch_payload_recovery",
  "prime_sequence_for_conformance",
  "liveness_sweep",
  "set_clock",
  "snapshot",
] as const;

export const BRIDGE_CONTROL_ACTIONS = [
  "discover_fixture",
  "attach_fixture_session",
  "open_transport",
  "start_run_loop",
  "session_register",
  "session_resume",
  "session_unregister",
  "prime_sequence_for_conformance",
  "send_heartbeat_for_conformance",
  "renew_exhausted_session",
  "tick",
  "poll_document_context",
  "flush_outbound",
  "invoke_local",
  "read_journal_record_for_conformance",
  "record_verification_attempt",
  "record_late_evidence",
  "resolve_hold",
  "clearance_for_hold",
  "inject_crash",
  "restart_simulator",
  "configure_reconnect_conformance",
  "advance_reconnect_conformance_clock",
  "send_chunk_conformance",
  "snapshot_evidence",
  "shutdown",
] as const;

export const FIXTURE_CONTROL_ACTIONS = [
  "plan_fault",
  "release_stall",
  "apply_document_context",
  "snapshot_evidence",
  "shutdown",
] as const;

export const HARNESS_ACTIONS = [
  "restart_case_stack",
  "stop_case_stack",
  "begin_wire_capture",
  "end_wire_capture",
  "await_condition",
  "set_gateway_proxy_backpressure",
  "drive_bridge_outbound",
  "inspect_gateway_artifact_bytes",
  "send_binding_frame",
  "send_fixture_frame",
  "send_split_fixture_frame",
  "send_coalesced_fixture_frames",
  "restart_component",
  "spawn_fixture_bind_probe",
  "execute_product_artifact_scenario",
  "capture_resource_sample",
] as const;

export type GatewayControlAction = (typeof GATEWAY_CONTROL_ACTIONS)[number];
export type BridgeControlAction = (typeof BRIDGE_CONTROL_ACTIONS)[number];
export type FixtureControlAction = (typeof FIXTURE_CONTROL_ACTIONS)[number];
export type HarnessAction = (typeof HARNESS_ACTIONS)[number];

export interface BindingArguments {
  common?: Readonly<Record<string, unknown>>;
  wss?: Readonly<Record<string, unknown>>;
  streamable_http_sse?: Readonly<Record<string, unknown>>;
}

/**
 * Parent control-operation terminal, not the remote protocol verdict carried
 * by a wire observation. For example, a negative send_binding_frame vector
 * expects success when injection/capture succeeds even if the peer then emits
 * an HTTP rejection or WSS close.
 */
export type StepExpectedOutcome =
  | { kind: "success" }
  | { kind: "control_error"; code: string; messageIncludes?: string }
  | { kind: "http_status"; status: number }
  | { kind: "close"; code: number; reasonIncludes?: string };

export type StepExecutionSemantics =
  | { mode: "sequential" }
  | { mode: "async_start"; handle: string }
  | { mode: "async_join"; handles: string[] }
  | { mode: "barrier"; handles: "all" | string[] };

export type StepCaptureMetadata =
  | { name: string; source: "result" | "control_error" | "http_body"; jsonPointer: string }
  | { name: string; source: "http_header"; header: string }
  | { name: string; source: "close"; field: "code" | "reason" };

interface BaseControlStep {
  stepId: string;
  phase: "setup" | "stimulus" | "observation" | "cleanup";
  arguments: BindingArguments;
  expectedOutcome: StepExpectedOutcome;
  execution: StepExecutionSemantics;
  captures: StepCaptureMetadata[];
  parentTimeoutMs: number;
}

export type CaseControlStep =
  | (BaseControlStep & {
      channel: "gateway_http_control";
      componentId: "gateway_stub";
      action: GatewayControlAction;
    })
  | (BaseControlStep & {
      channel: "bridge_jsonl_control";
      componentId: "bridge_simulator";
      action: BridgeControlAction;
    })
  | (BaseControlStep & {
      channel: "fixture_jsonl_control";
      componentId: "addin_loopback_fixture";
      action: FixtureControlAction;
    })
  | (BaseControlStep & {
      channel: "parent_harness";
      componentId: null;
      action: HarnessAction;
    });

export interface CaseObservationRequirement {
  alias: string;
  componentId: ComponentId;
  kind: ProcessObservationRecord["kind"];
  sourceStepIds: string[];
  requiredJsonPointers: string[];
}

export interface CanonicalAssertionProbe {
  assertionId: string;
  subvectorId: string;
  operator: "canonical_subvector";
  evaluationOwner: "parent_runner";
  expected: true;
  observationAliases: string[];
}

export interface ConformanceCaseProgram {
  caseId: string;
  bindings: Binding[];
  steps: CaseControlStep[];
  observations: CaseObservationRequirement[];
  assertionProbes: CanonicalAssertionProbe[];
  requiredHarnessCapabilities: string[];
}

type StepPhase = CaseControlStep["phase"];

const FINGERPRINT = `sha256:${"0".repeat(64)}`;

function args(common: Readonly<Record<string, unknown>> = {}): BindingArguments {
  return { common };
}

function byBinding(
  wss: Readonly<Record<string, unknown>>,
  streamableHttpSse: Readonly<Record<string, unknown>>,
  common: Readonly<Record<string, unknown>> = {},
): BindingArguments {
  return { common, wss, streamable_http_sse: streamableHttpSse };
}

function gateway(
  stepId: string,
  action: GatewayControlAction,
  actionArguments: BindingArguments = args(),
  phase: StepPhase = "stimulus",
  parentTimeoutMs = 30_000,
): CaseControlStep {
  return {
    stepId,
    phase,
    channel: "gateway_http_control",
    componentId: "gateway_stub",
    action,
    arguments: actionArguments,
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs,
  };
}

function bridge(
  stepId: string,
  action: BridgeControlAction,
  actionArguments: BindingArguments = args(),
  phase: StepPhase = "stimulus",
  parentTimeoutMs = 30_000,
): CaseControlStep {
  return {
    stepId,
    phase,
    channel: "bridge_jsonl_control",
    componentId: "bridge_simulator",
    action,
    arguments: actionArguments,
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs,
  };
}

function fixture(
  stepId: string,
  action: FixtureControlAction,
  actionArguments: BindingArguments = args(),
  phase: StepPhase = "stimulus",
  parentTimeoutMs = 30_000,
): CaseControlStep {
  return {
    stepId,
    phase,
    channel: "fixture_jsonl_control",
    componentId: "addin_loopback_fixture",
    action,
    arguments: actionArguments,
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs,
  };
}

function harness(
  stepId: string,
  action: HarnessAction,
  actionArguments: BindingArguments = args(),
  phase: StepPhase = "stimulus",
  parentTimeoutMs = 30_000,
): CaseControlStep {
  return {
    stepId,
    phase,
    channel: "parent_harness",
    componentId: null,
    action,
    arguments: actionArguments,
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs,
  };
}

function withExecution(
  step: CaseControlStep,
  execution: StepExecutionSemantics,
): CaseControlStep {
  return { ...step, execution };
}

function withExpectedOutcome(
  step: CaseControlStep,
  expectedOutcome: StepExpectedOutcome,
): CaseControlStep {
  return { ...step, expectedOutcome };
}

function withCaptures(
  step: CaseControlStep,
  captures: StepCaptureMetadata[],
): CaseControlStep {
  return { ...step, captures };
}

const METADATA_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function assertMetadataName(value: string, label: string): void {
  if (!METADATA_NAME.test(value)) throw new Error(`${label} must be a non-empty metadata name`);
}

export function assertValidCaseControlStepSemantics(step: CaseControlStep): void {
  if (!Number.isInteger(step.parentTimeoutMs) || step.parentTimeoutMs < 1 || step.parentTimeoutMs > 300_000) {
    throw new Error(`${step.stepId} parent timeout must be an integer from 1 through 300000 milliseconds`);
  }
  const expected = step.expectedOutcome;
  switch (expected.kind) {
    case "success":
      break;
    case "control_error":
      if (expected.code.length === 0) throw new Error(`${step.stepId} control-error code must not be empty`);
      if (expected.messageIncludes !== undefined && expected.messageIncludes.length === 0) {
        throw new Error(`${step.stepId} control-error message fragment must not be empty`);
      }
      break;
    case "http_status":
      if (!Number.isInteger(expected.status) || expected.status < 100 || expected.status > 599) {
        throw new Error(`${step.stepId} expected HTTP status must be an integer from 100 through 599`);
      }
      break;
    case "close":
      if (!Number.isInteger(expected.code) || expected.code < 1000 || expected.code > 4999) {
        throw new Error(`${step.stepId} expected close code must be an integer from 1000 through 4999`);
      }
      if (expected.reasonIncludes !== undefined && expected.reasonIncludes.length === 0) {
        throw new Error(`${step.stepId} close-reason fragment must not be empty`);
      }
      break;
    default:
      throw new Error(`${step.stepId} has an unknown expected outcome`);
  }

  const execution = step.execution;
  switch (execution.mode) {
    case "sequential":
      break;
    case "async_start":
      assertMetadataName(execution.handle, `${step.stepId} async handle`);
      break;
    case "async_join":
      if (execution.handles.length === 0) throw new Error(`${step.stepId} async join must name at least one handle`);
      for (const handle of execution.handles) assertMetadataName(handle, `${step.stepId} async join handle`);
      if (new Set(execution.handles).size !== execution.handles.length) {
        throw new Error(`${step.stepId} async join handles must be unique`);
      }
      break;
    case "barrier":
      if (execution.handles !== "all") {
        if (execution.handles.length === 0) throw new Error(`${step.stepId} barrier must name handles or use all`);
        for (const handle of execution.handles) assertMetadataName(handle, `${step.stepId} barrier handle`);
        if (new Set(execution.handles).size !== execution.handles.length) {
          throw new Error(`${step.stepId} barrier handles must be unique`);
        }
      }
      break;
    default:
      throw new Error(`${step.stepId} has unknown execution semantics`);
  }

  const captureNames = new Set<string>();
  for (const capture of step.captures) {
    assertMetadataName(capture.name, `${step.stepId} capture name`);
    if (captureNames.has(capture.name)) throw new Error(`${step.stepId} capture names must be unique`);
    captureNames.add(capture.name);
    if (capture.source === "http_header") {
      if (expected.kind !== "http_status") {
        throw new Error(`${step.stepId} HTTP-header capture requires an expected HTTP outcome`);
      }
      if (!HTTP_HEADER_NAME.test(capture.header)) throw new Error(`${step.stepId} capture header is invalid`);
    } else if (capture.source === "close") {
      if (expected.kind !== "close") {
        throw new Error(`${step.stepId} close capture requires an expected close outcome`);
      }
      if (capture.field !== "code" && capture.field !== "reason") throw new Error(`${step.stepId} close capture field is invalid`);
    } else if (capture.jsonPointer !== "" && !capture.jsonPointer.startsWith("/")) {
      throw new Error(`${step.stepId} capture JSON pointer must be empty or begin with a slash`);
    } else if (capture.source === "result" && expected.kind !== "success") {
      throw new Error(`${step.stepId} result capture requires an expected success outcome`);
    } else if (capture.source === "control_error" && expected.kind !== "control_error") {
      throw new Error(`${step.stepId} control-error capture requires an expected control-error outcome`);
    } else if (capture.source === "http_body" && expected.kind !== "http_status") {
      throw new Error(`${step.stepId} HTTP-body capture requires an expected HTTP outcome`);
    }
  }
}

function hello(caseId: string, suffix = "initial"): Record<string, unknown> {
  return {
    id: `{{ids.${caseId}.hello-${suffix}.envelopeId}}`,
    ts: "{{clock.iso}}",
    bridgeVersion: "0.0.0",
    deviceId: "{{case.device_id}}",
    hostname: "conformance-host",
    os: "linux",
    fingerprint: FINGERPRINT,
  };
}

function sessionSetup(
  caseId: string,
  grantedSessionCapabilities?: string[],
  options: {
    discovery?: Readonly<Record<string, unknown>>;
    probeIndex?: unknown;
  } = {},
): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  return [
    bridge(`${prefix}.discover`, "discover_fixture", args(options.discovery ?? {
      host: "{{fixture.ready.host}}",
      port: "{{fixture.ready.port}}",
      probeTimeoutMs: 1_000,
    }), "setup"),
    withCaptures(
      bridge(`${prefix}.open`, "open_transport", byBinding(
        {
          kind: "wss",
          endpointPolicy: "loopback_test_tls",
          deviceToken: "{{case.device_token}}",
          wssUrl: "{{gateway.ready.ws_url}}",
          tlsTrust: {
            caCertificatePath: "{{gateway.ready.ca_certificate_path}}",
            caCertificateSha256: "{{gateway.ready.ca_certificate_sha256}}",
            serverCertificateSha256: "{{gateway.ready.server_certificate_sha256}}",
          },
          hello: hello(caseId),
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{gateway.ready.http_connection_url}}",
          hello: hello(caseId),
        },
      ), "setup"),
      [
        { name: "case.connection_id", source: "result", jsonPointer: "/connectionId" },
        {
          name: "case.connection_capabilities",
          source: "result",
          jsonPointer: "/helloAck/payload/granted_capabilities",
        },
        {
          name: "case.negotiated_protocol",
          source: "result",
          jsonPointer: "/helloAck/payload/protocol",
        },
      ],
    ),
    bridge(`${prefix}.run-loop`, "start_run_loop", args(), "setup"),
    bridge(`${prefix}.register`, "session_register", args({
      probeIndex: options.probeIndex ?? 0,
      userHint: "conformance-user",
      hostname: "conformance-host",
      fingerprint: FINGERPRINT,
      bridgeVersion: "0.0.0",
    }), "setup"),
    withCaptures(
      harness(`${prefix}.await-register`, "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions/0/rsid",
        operator: "exists",
        timeoutMs: 5_000,
        ...(grantedSessionCapabilities === undefined
          ? {}
          : { grantedSessionCapabilities }),
      }), "setup"),
      [
        { name: "case.rsid", source: "result", jsonPointer: "/dynamic/rsid" },
        { name: "case.next_seq", source: "result", jsonPointer: "/dynamic/nextSeq" },
        { name: "case.last_ack", source: "result", jsonPointer: "/dynamic/lastAck" },
        {
          name: "case.session_capabilities",
          source: "result",
          jsonPointer: "/dynamic/grantedSessionCapabilities",
        },
      ],
    ),
  ];
}

function sessionSetupDrain(caseId: string): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  return [
    harness(
      `${prefix}.drain-setup`,
      "drive_bridge_outbound",
      args({ advanceByMs: 15_000 }),
      "setup",
      20_000,
    ),
    harness(`${prefix}.await-setup-drain`, "await_condition", args({
      source: "bridge.snapshot_evidence",
      jsonPointer: "/sequences/0/outbox",
      operator: "count_equals",
      expected: 0,
      timeoutMs: 10_000,
    }), "setup", 15_000),
  ];
}

function invocationRef(caseId: string, suffix: string): string {
  return `{{ids.${caseId}.${suffix}.invocationId}}`;
}

function envelope(caseId: string, suffix: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    v: 1,
    type: "invoke",
    id: `{{ids.${caseId}.${suffix}.envelopeId}}`,
    ts: "{{clock.iso}}",
    rsid: "{{case.rsid}}",
    seq: "{{case.next_seq}}",
    ack: "{{case.last_ack}}",
    payload: {
      invocation_id: invocationRef(caseId, suffix),
      method: "fixture_echo",
      params: { vector: suffix },
      policy: { class: "auto", decision: "auto", confirmation_id: null },
      mutating: false,
      mutation_scope: null,
      timeout_ms: 30_000,
      verification: null,
      recovery_clearances: [],
      ...overrides,
    },
  };
}

function invokePayload(
  caseId: string,
  suffix: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    invocation_id: invocationRef(caseId, suffix),
    method: "fixture_echo",
    params: { vector: suffix },
    policy: { class: "auto", decision: "auto", confirmation_id: null },
    mutating: false,
    mutation_scope: null,
    timeout_ms: 30_000,
    verification: null,
    recovery_clearances: [],
    ...overrides,
  };
}

function dispatchInvokeRequest(
  caseId: string,
  suffix: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rsid: "{{case.rsid}}",
    payload: invokePayload(caseId, suffix, overrides),
  };
}

function dispatchBatchRequest(
  caseId: string,
  suffix: string,
  atomic: boolean,
): Record<string, unknown> {
  return {
    rsid: "{{case.rsid}}",
    payload: {
      batch_id: `{{ids.${caseId}.${suffix}.batchId}}`,
      atomic,
      timeout_ms: 30_000,
      recovery_clearances: [],
      steps: `{{batches.${caseId}.${suffix}.steps}}`,
      batch_digest: `{{batches.${caseId}.${suffix}.batchDigest}}`,
    },
  };
}

type C30JournalScenario = "policy" | "scope" | "clearance";
type C30JournalVariant = "baseline" | "changed";

function c30Uuid(ordinal: number): string {
  return `019c3000-0000-7000-8000-${ordinal.toString().padStart(12, "0")}`;
}

/**
 * A real Bridge-journal redelivery pair. Transport identity changes between
 * deliveries, while batch/invocation identity remains fixed and exactly one
 * immutable binding field changes.
 */
function c30JournalEnvelope(
  scenario: C30JournalScenario,
  variant: C30JournalVariant,
  seq: number,
): Record<string, unknown> {
  const scenarioOrdinal = scenario === "policy" ? 1 : scenario === "scope" ? 2 : 3;
  const mutating = scenario !== "policy";
  const params: JsonValue = mutating
    ? { viewId: 42, mode: "commit", confirmDelete: true, viewType: "ThreeD" }
    : { scenario, stable: true };
  const baselineScope = mutating
    ? { kind: "document", document_id: `c30-${scenario}-document-a` }
    : null;
  const mutationScope = scenario === "scope" && variant === "changed"
    ? { kind: "document", document_id: "c30-scope-document-b" }
    : baselineScope;
  const baselinePolicy = mutating
    ? { class: "confirm", decision: "confirmed", confirmation_id: `c30-${scenario}-confirmation` }
    : { class: "auto", decision: "auto", confirmation_id: null };
  const policy = scenario === "policy" && variant === "changed"
    ? { class: "gated", decision: "gated_approved", confirmation_id: "c30-policy-changed" }
    : baselinePolicy;
  const recoveryClearances = scenario === "clearance" && variant === "changed"
    ? [{
        hold_id: `vh:${"2".repeat(64)}`,
        mutation_scope: baselineScope,
        resolution_id: c30Uuid(301),
        basis: "late_terminal",
        verification_invocation_id: null,
        evidence_digest: `sha256:${"3".repeat(64)}`,
        decision: "postcondition_verified",
        audit_id: c30Uuid(302),
      }]
    : [];
  const step = {
    invocation_id: c30Uuid(100 + scenarioOrdinal),
    method: mutating ? "delete_review_view" : "get_ui_state",
    params,
    params_digest: makeParamsDigest(params),
    mutating,
    mutation_scope: mutationScope,
    policy,
  };
  const digestInput: BatchDigestInput = {
    atomic: false,
    batch_id: c30Uuid(200 + scenarioOrdinal),
    recovery_clearances: recoveryClearances as JsonValue[],
    steps: [{
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope as JsonValue,
      params_digest: step.params_digest,
      policy: step.policy,
    }],
    timeout_ms: 30_000,
  };
  return {
    v: 1,
    type: "invoke_batch",
    id: c30Uuid((variant === "baseline" ? 10 : 20) + scenarioOrdinal),
    ts: "{{clock.iso}}",
    rsid: "{{case.rsid}}",
    seq,
    ack: 0,
    payload: {
      ...digestInput,
      steps: [{ ...step }],
      batch_digest: makeBatchDigest(digestInput),
    },
  };
}

const C32_VECTORS = [
  "base64_alphabet",
  "base64_padding",
  "stream_identity",
  "stream_indexing",
  "decoded_limit",
  "reconstruction_size",
  "content_digest",
] as const;

type C32Vector = (typeof C32_VECTORS)[number];
const C32_STACK_LIFECYCLE_TIMEOUT_MS = 90_000;

function c32CaptureRoot(vector: C32Vector, initial: boolean): string {
  return initial ? "case" : `c32.${vector}.case`;
}

function c32ReadinessRoot(vector: C32Vector, initial: boolean): string {
  return initial ? "" : `c32.${vector}.`;
}

function c32RestartStack(vector: C32Vector): CaseControlStep {
  return withCaptures(
    harness(`o1-c32.${vector}.restart-stack`, "restart_case_stack", args({
      caseId: "O1-C32",
      binding: "{{binding}}",
      preserveState: false,
      requireExactExecutionPlanIdentity: true,
    }), "setup", C32_STACK_LIFECYCLE_TIMEOUT_MS),
    [
      {
        name: `c32.${vector}.fixture.ready.host`,
        source: "result",
        jsonPointer: "/readiness/fixture/host",
      },
      {
        name: `c32.${vector}.fixture.ready.port`,
        source: "result",
        jsonPointer: "/readiness/fixture/port",
      },
      {
        name: `c32.${vector}.gateway.ready.ws_url`,
        source: "result",
        jsonPointer: "/readiness/gateway/ws_url",
      },
      {
        name: `c32.${vector}.gateway.ready.http_connection_url`,
        source: "result",
        jsonPointer: "/readiness/gateway/http_connection_url",
      },
      {
        name: `c32.${vector}.gateway.ready.ca_certificate_path`,
        source: "result",
        jsonPointer: "/readiness/gateway/tlsTrust/caCertificatePath",
      },
      {
        name: `c32.${vector}.gateway.ready.ca_certificate_sha256`,
        source: "result",
        jsonPointer: "/readiness/gateway/tlsTrust/caCertificateSha256",
      },
      {
        name: `c32.${vector}.gateway.ready.server_certificate_sha256`,
        source: "result",
        jsonPointer: "/readiness/gateway/tlsTrust/serverCertificateSha256",
      },
    ],
  );
}

function c32SessionSetup(vector: C32Vector, initial: boolean): CaseControlStep[] {
  const stepPrefix = `o1-c32.${vector}`;
  const readiness = c32ReadinessRoot(vector, initial);
  const captureRoot = c32CaptureRoot(vector, initial);
  return [
    bridge(`${stepPrefix}.discover`, "discover_fixture", args({
      host: `{{${readiness}fixture.ready.host}}`,
      port: `{{${readiness}fixture.ready.port}}`,
      probeTimeoutMs: 1_000,
    }), "setup"),
    withCaptures(
      bridge(`${stepPrefix}.open`, "open_transport", byBinding(
        {
          kind: "wss",
          endpointPolicy: "loopback_test_tls",
          deviceToken: "{{case.device_token}}",
          wssUrl: `{{${readiness}gateway.ready.ws_url}}`,
          tlsTrust: {
            caCertificatePath: `{{${readiness}gateway.ready.ca_certificate_path}}`,
            caCertificateSha256: `{{${readiness}gateway.ready.ca_certificate_sha256}}`,
            serverCertificateSha256: `{{${readiness}gateway.ready.server_certificate_sha256}}`,
          },
          hello: hello("O1-C32"),
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: `{{${readiness}gateway.ready.http_connection_url}}`,
          hello: hello("O1-C32"),
        },
      ), "setup"),
      [
        {
          name: `${captureRoot}.connection_id`,
          source: "result",
          jsonPointer: "/connectionId",
        },
        {
          name: `${captureRoot}.connection_capabilities`,
          source: "result",
          jsonPointer: "/helloAck/payload/granted_capabilities",
        },
        {
          name: `${captureRoot}.negotiated_protocol`,
          source: "result",
          jsonPointer: "/helloAck/payload/protocol",
        },
      ],
    ),
    bridge(`${stepPrefix}.run-loop`, "start_run_loop", args(), "setup"),
    bridge(`${stepPrefix}.register`, "session_register", args({
      probeIndex: 0,
      userHint: "conformance-user",
      hostname: "conformance-host",
      fingerprint: FINGERPRINT,
      bridgeVersion: "0.0.0",
    }), "setup"),
    withCaptures(
      harness(`${stepPrefix}.await-register`, "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions/0/rsid",
        operator: "exists",
        timeoutMs: 5_000,
      }), "setup"),
      [
        { name: `${captureRoot}.rsid`, source: "result", jsonPointer: "/dynamic/rsid" },
        { name: `${captureRoot}.next_seq`, source: "result", jsonPointer: "/dynamic/nextSeq" },
        { name: `${captureRoot}.last_ack`, source: "result", jsonPointer: "/dynamic/lastAck" },
        {
          name: `${captureRoot}.session_capabilities`,
          source: "result",
          jsonPointer: "/dynamic/grantedSessionCapabilities",
        },
      ],
    ),
  ];
}

function c32Controls(): CaseControlStep[] {
  const controls: CaseControlStep[] = [];
  C32_VECTORS.forEach((vector, index) => {
    const initial = index === 0;
    if (!initial) {
      controls.push(c32RestartStack(vector));
    }
    const captureRoot = c32CaptureRoot(vector, initial);
    const invocationId = invocationRef("O1-C32", "retransmission");
    const dispatchHandle = `o1-c32.${vector}.dispatch`;
    controls.push(
      ...c32SessionSetup(vector, initial),
      fixture(`o1-c32.${vector}.stall`, "plan_fault", args({
        requestId: invocationId,
        fault: { stall: true },
      })),
      withExecution(
        gateway(`o1-c32.${vector}.dispatch`, "dispatch_invoke", args({
          request: {
            rsid: `{{${captureRoot}.rsid}}`,
            payload: invokePayload("O1-C32", "retransmission"),
          },
        })),
        { mode: "async_start", handle: dispatchHandle },
      ),
      harness(`o1-c32.${vector}.await-stalled`, "await_condition", args({
        source: "fixture.snapshot_evidence",
        jsonPointer: "/pendingStalls/0/requestId",
        operator: "equals",
        expected: invocationId,
        timeoutMs: 5_000,
      })),
      gateway(`o1-c32.${vector}.gateway-registered`, "snapshot", args(), "observation"),
      bridge(`o1-c32.${vector}`, "send_chunk_conformance", args({
        vector,
        rsid: `{{${captureRoot}.rsid}}`,
        invocationId,
      })),
      withExecution(
        gateway(`o1-c32.${vector}.expire`, "expire_pending", args({
          rsid: `{{${captureRoot}.rsid}}`,
        })),
        { mode: "async_join", handles: [dispatchHandle] },
      ),
    );
  });
  return controls;
}

interface ProgramDefinition {
  caseId: string;
  controls: CaseControlStep[];
  requiredHarnessCapabilities: string[];
  initialStackTimeoutMs?: number;
  startupOverrides?: {
    sessionCapabilities?: string[];
    connectionCapabilities?: string[];
    supportedProtocols?: number[];
  };
}

const CASE_DEFINITIONS: ProgramDefinition[] = [
  {
    caseId: "O1-C01",
    controls: sessionSetup("O1-C01"),
    requiredHarnessCapabilities: ["authenticated_transport", "hello_negotiation", "session_registration"],
  },
  {
    caseId: "O1-C02",
    controls: [
      gateway("o1-c02.version-opening-fault", "enqueue_opening_fault", byBinding(
        { rule: { binding: "wss", status: 426, remaining: 1 } },
        { rule: { binding: "http_sse", status: 426, remaining: 1 } },
      ), "setup"),
      ...sessionSetup("O1-C02").slice(0, 2),
      harness("o1-c02.await-bounded-reconnect", "await_condition", args({
        source: "wire_capture",
        jsonPointer: "/openingAttempts",
        operator: "bounded_retry_after_terminal_version_fault",
        timeoutMs: 5_000,
      })),
    ],
    requiredHarnessCapabilities: ["opening_error_capture", "reconnect_schedule_capture"],
  },
  {
    caseId: "O1-C03",
    controls: [
      gateway("o1-c03.revoke-token", "set_auth_status", args({
        token: "{{case.device_token}}",
        status: "revoked",
      }), "setup"),
      ...sessionSetup("O1-C03").slice(0, 2),
    ],
    requiredHarnessCapabilities: ["opening_error_capture", "credential_state_control"],
  },
  {
    caseId: "O1-C04",
    controls: [
      bridge("o1-c04.bounded-discovery", "discover_fixture", args({
        host: "127.0.0.1",
        firstPort: "{{fixture.ready.port}}",
        lastPort: "{{fixture.ready.port}}",
        probeTimeoutMs: 1_000,
      }), "stimulus"),
    ],
    requiredHarnessCapabilities: ["loopback_discovery", "discovery_side_effect_audit"],
  },
  {
    caseId: "O1-C05",
    controls: [
      fixture("o1-c05.context", "apply_document_context", args({ event: "{{vectors.document_context}}" })),
      ...sessionSetup("O1-C05"),
      bridge("o1-c05.poll-context", "poll_document_context", args({ rsid: "{{case.rsid}}", force: true })),
      bridge("o1-c05.flush-context", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
    ],
    requiredHarnessCapabilities: ["session_registration", "document_context_capture"],
  },
  {
    caseId: "O1-C06",
    controls: [
      ...sessionSetup("O1-C06"),
      gateway("o1-c06.drop-heartbeat-ack", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "drop", binding: "wss", messageType: "heartbeat_ack", remaining: 8 } },
        { rule: { direction: "gateway_to_bridge", action: "drop", binding: "http_sse", messageType: "heartbeat_ack", remaining: 8 } },
      )),
      gateway("o1-c06.clock-35s", "set_clock", args({ now_ms: 35_000 })),
      bridge("o1-c06.tick-35s", "tick", args({ nowMs: 35_000 })),
      gateway("o1-c06.clock-65s", "set_clock", args({ now_ms: 65_000 })),
      bridge("o1-c06.tick-65s", "tick", args({ nowMs: 65_000 })),
      gateway("o1-c06.sweep", "liveness_sweep"),
    ],
    requiredHarnessCapabilities: ["deterministic_clock", "heartbeat_wire_capture", "reconnect_schedule_capture"],
  },
  {
    caseId: "O1-C07",
    controls: [
      ...sessionSetup("O1-C07"),
      gateway("o1-c07.hold-outbound", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "wss", remaining: 1 } },
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "http_sse", remaining: 1 } },
      )),
      harness("o1-c07.restart-gateway", "restart_component", args({ componentId: "gateway_stub", preserveState: true })),
      bridge("o1-c07.restart-bridge", "restart_simulator"),
      bridge("o1-c07.reopen", "open_transport", byBinding(
        { kind: "wss", endpointPolicy: "loopback_test_readiness", deviceToken: "{{case.device_token}}", wssUrl: "{{gateway.ready.ws_url}}", hello: hello("O1-C07", "reconnect") },
        { kind: "streamable_http_sse", endpointPolicy: "loopback_test_readiness", deviceToken: "{{case.device_token}}", fallbackUrl: "{{gateway.ready.http_connection_url}}", hello: hello("O1-C07", "reconnect") },
      )),
      bridge("o1-c07.restart-run-loop", "start_run_loop", args()),
      bridge("o1-c07.resume", "session_resume", args({ rsid: "{{case.rsid}}" })),
      bridge("o1-c07.flush", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
      gateway("o1-c07.flush-held", "flush_held"),
    ],
    requiredHarnessCapabilities: ["component_restart_with_state", "resume_token_capture", "bidirectional_retransmit_capture"],
  },
  {
    caseId: "O1-C08",
    controls: [
      ...sessionSetup("O1-C08"),
      fixture("o1-c08.plan-late-terminal", "plan_fault", args({
        requestId: invocationRef("O1-C08", "terminal-replay"),
        fault: { crash: "after_dispatch" },
      })),
      bridge("o1-c08.first", "invoke_local", args({
        envelope: envelope("O1-C08", "terminal-replay"),
        crashAt: "after_addin_response_before_terminal",
      })),
      bridge("o1-c08.restart", "restart_simulator"),
      bridge("o1-c08.redeliver", "invoke_local", args({ envelope: envelope("O1-C08", "terminal-replay") })),
    ],
    requiredHarnessCapabilities: ["bridge_crash_recovery", "fixture_request_execution_count", "journal_terminal_replay"],
  },
  {
    caseId: "O1-C09",
    controls: [
      ...sessionSetup("O1-C09"),
      bridge("o1-c09.first", "invoke_local", args({
        envelope: envelope("O1-C09", "mutation-indeterminate", {
          method: "send_code_to_revit",
          mutating: true,
          mutation_scope: { kind: "document", document_id: "model-a" },
        }),
        crashAt: "after_executing_before_addin_write",
      })),
      bridge("o1-c09.restart", "restart_simulator"),
      bridge("o1-c09.redeliver", "invoke_local", args({ envelope: envelope("O1-C09", "mutation-indeterminate", {
        method: "send_code_to_revit",
        mutating: true,
        mutation_scope: { kind: "document", document_id: "model-a" },
      }) })),
    ],
    requiredHarnessCapabilities: ["bridge_crash_recovery", "fixture_request_execution_count", "journal_indeterminate"],
  },
  {
    caseId: "O1-C10",
    controls: [
      ...sessionSetup("O1-C10"),
      bridge("o1-c10.first", "invoke_local", args({
        envelope: envelope("O1-C10", "read-indeterminate"),
        crashAt: "after_addin_response_before_terminal",
      })),
      bridge("o1-c10.restart", "restart_simulator"),
      bridge("o1-c10.redeliver", "invoke_local", args({ envelope: envelope("O1-C10", "read-indeterminate") })),
    ],
    requiredHarnessCapabilities: ["bridge_crash_recovery", "fixture_request_execution_count"],
  },
  {
    caseId: "O1-C11",
    controls: [
      ...sessionSetup("O1-C11"),
      bridge("o1-c11.original", "invoke_local", args({ envelope: envelope("O1-C11", "digest-mismatch", {
        params: { canonical: "value-a" },
      }) })),
      bridge("o1-c11.digest-mismatch", "invoke_local", args({ envelope: envelope("O1-C11", "digest-mismatch", {
        params: { canonical: "value-b" },
      }) })),
    ],
    requiredHarnessCapabilities: ["jcs_vector_generation", "protocol_fault_capture", "fixture_request_execution_count"],
  },
  {
    caseId: "O1-C12",
    controls: [
      ...sessionSetup("O1-C12"),
      bridge("o1-c12.register-second", "session_register", args({
        probeIndex: 0,
        userHint: "conformance-user",
        hostname: "conformance-host",
        fingerprint: FINGERPRINT,
        bridgeVersion: "0.0.0",
      }), "setup"),
      harness("o1-c12.await-second", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions",
        operator: "minimum_count",
        expected: 2,
        timeoutMs: 5_000,
      }), "setup"),
      fixture("o1-c12.stall-first", "plan_fault", args({ requestId: invocationRef("O1-C12", "first"), fault: { stall: true } })),
      withExecution(
        bridge("o1-c12.first", "invoke_local", args({ envelope: envelope("O1-C12", "first") })),
        { mode: "async_start", handle: "o1-c12.first" },
      ),
      withExecution(
        bridge("o1-c12.same-rsid-second", "invoke_local", args({ envelope: envelope("O1-C12", "same-rsid-second") })),
        { mode: "async_start", handle: "o1-c12.same-rsid-second" },
      ),
      withExecution(
        bridge("o1-c12.cross-rsid", "invoke_local", args({ envelope: "{{case.second_rsid_envelope}}" })),
        { mode: "async_start", handle: "o1-c12.cross-rsid" },
      ),
      withExecution(
        fixture("o1-c12.release-first", "release_stall", args({ requestId: invocationRef("O1-C12", "first") })),
        {
          mode: "async_join",
          handles: ["o1-c12.first", "o1-c12.same-rsid-second", "o1-c12.cross-rsid"],
        },
      ),
    ],
    requiredHarnessCapabilities: ["two_registered_sessions", "concurrent_control_requests", "fixture_request_execution_count"],
  },
  {
    caseId: "O1-C13",
    controls: [
      ...sessionSetup("O1-C13"),
      bridge("o1-c13.invoke", "invoke_local", args({ envelope: envelope("O1-C13", "normal") })),
    ],
    requiredHarnessCapabilities: ["fixture_method_execution_count"],
  },
  {
    caseId: "O1-C14",
    controls: [
      ...sessionSetup("O1-C14"),
      fixture("o1-c14.busy", "plan_fault", args({ requestId: invocationRef("O1-C14", "busy"), fault: { busy: true } })),
      bridge("o1-c14.invoke", "invoke_local", args({ envelope: envelope("O1-C14", "busy") })),
    ],
    requiredHarnessCapabilities: ["fixture_fault_control", "fixture_method_execution_count", "failure_enrichment_capture"],
  },
  {
    caseId: "O1-C15",
    controls: [
      ...sessionSetup("O1-C15"),
      ...sessionSetupDrain("O1-C15"),
      harness("o1-c15.backpressure-on", "set_gateway_proxy_backpressure", args({ enabled: true })),
      withExecution(
        gateway("o1-c15.dispatch", "dispatch_invoke", args({
          request: dispatchInvokeRequest("O1-C15", "chunked", {
            method: "fixture_multi_file_output",
            params: {
              scenario: "valid_multifile",
              fileCount: 2,
              bytesPerFile: 4_194_304,
            },
          }),
        }), "stimulus", 120_000),
        { mode: "async_start", handle: "o1-c15.dispatch" },
      ),
      harness("o1-c15.await-bounded-chunk", "await_condition", byBinding(
        {
          source: "bridge.snapshot_evidence",
          jsonPointer: "/peer/deliveryProgress/records/0/chunkFramesSent",
          operator: "equals",
          expected: 1,
          timeoutMs: 15_000,
        },
        {
          source: "bridge.snapshot_evidence",
          jsonPointer: "/peer/backpressure/currentBufferedAmount",
          operator: "crosses",
          expected: 1,
          timeoutMs: 15_000,
        },
      ), "observation", 20_000),
      gateway("o1-c15.control-serviceable", "snapshot", args(), "observation"),
      harness("o1-c15.backpressure-off", "set_gateway_proxy_backpressure", args({ enabled: false })),
      ...Array.from({ length: 11 }, (_, index) =>
        harness(
          `o1-c15.drive-${String(index + 1).padStart(2, "0")}`,
          "drive_bridge_outbound",
          args({ advanceByMs: 15_001, driveOutbound: true }),
          "stimulus",
          20_000,
        )),
      withExecution(
        harness(
          "o1-c15.drive-12",
          "drive_bridge_outbound",
          args({ advanceByMs: 15_001, driveOutbound: true }),
          "stimulus",
          20_000,
        ),
        { mode: "async_join", handles: ["o1-c15.dispatch"] },
      ),
      harness("o1-c15.parent-artifact-bytes", "inspect_gateway_artifact_bytes", args({
        rsid: "{{case.rsid}}",
        invocationId: invocationRef("O1-C15", "chunked"),
      }), "observation", 20_000),
    ],
    requiredHarnessCapabilities: [
      "chunk_wire_capture",
      "decoded_digest_verification",
      "buffered_amount_sampling",
      "parent_proxy_backpressure",
      "direct_control_serviceability",
    ],
  },
  {
    caseId: "O1-C16",
    controls: [
      ...sessionSetup("O1-C16"),
      harness("o1-c16.params-oversize", "send_binding_frame", args({
        frame: "{{vectors.params_over_limit_envelope}}",
        hello: "{{vectors.raw_opening_hello_params}}",
        expectedBoundary: "params",
      })),
      harness("o1-c16.result-oversize", "send_binding_frame", args({
        frame: "{{vectors.result_over_limit_invoke}}",
        hello: "{{vectors.raw_opening_hello_result}}",
        expectedBoundary: "result",
      })),
    ],
    requiredHarnessCapabilities: ["oversize_payload_generation", "raw_binding_frame", "boundary_fault_capture"],
  },
  {
    caseId: "O1-C17",
    controls: [
      ...sessionSetup("O1-C17"),
      ...sessionSetupDrain("O1-C17"),
      fixture("o1-c17.stall", "plan_fault", args({
        requestId: invocationRef("O1-C17", "cancelled"),
        fault: { stall: true },
      })),
      withExecution(
        gateway("o1-c17.dispatch", "dispatch_invoke", args({
          request: dispatchInvokeRequest("O1-C17", "cancelled"),
        })),
        { mode: "async_start", handle: "o1-c17.dispatch" },
      ),
      harness("o1-c17.await-stalled", "await_condition", args({
        source: "fixture.snapshot_evidence",
        jsonPointer: "/pendingStalls/0/requestId",
        operator: "equals",
        expected: invocationRef("O1-C17", "cancelled"),
        timeoutMs: 5_000,
      })),
      gateway("o1-c17.cancel", "dispatch_cancel", args({ request: {
        rsid: "{{case.rsid}}",
        invocationId: invocationRef("O1-C17", "cancelled"),
        reason: "user_requested",
      } })),
      harness("o1-c17.await-cancel-accepted", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/invocations/0/abandoned",
        operator: "equals",
        expected: true,
        timeoutMs: 5_000,
      })),
      withExecution(
        fixture("o1-c17.release", "release_stall", args({
          requestId: invocationRef("O1-C17", "cancelled"),
        })),
        { mode: "async_join", handles: ["o1-c17.dispatch"] },
      ),
      bridge("o1-c17.flush", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
    ],
    requiredHarnessCapabilities: ["concurrent_control_requests", "late_terminal_capture", "journal_snapshot"],
  },
  {
    caseId: "O1-C18",
    controls: [
      ...sessionSetup("O1-C18"),
      ...sessionSetupDrain("O1-C18"),
      fixture("o1-c18.method-not-found", "plan_fault", args({ requestId: invocationRef("O1-C18", "method"), fault: {
        jsonRpcError: { code: -32601, message: "method not found" },
      } })),
      gateway("o1-c18.invoke-method", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C18", "method"),
      })),
      fixture("o1-c18.invalid-params", "plan_fault", args({ requestId: invocationRef("O1-C18", "params"), fault: {
        jsonRpcError: { code: -32602, message: "invalid params" },
      } })),
      gateway("o1-c18.invoke-params", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C18", "params"),
      })),
      fixture("o1-c18.addin-exception", "plan_fault", args({ requestId: invocationRef("O1-C18", "exception"), fault: {
        injectedOutcome: { state: "failed", error: { code: "revit_api", message: "injected add-in exception" } },
      } })),
      gateway("o1-c18.invoke-exception", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C18", "exception"),
      })),
      fixture("o1-c18.guarded", "plan_fault", args({ requestId: invocationRef("O1-C18", "guarded"), fault: {
        injectedOutcome: { state: "guarded", guardedReason: "busy" },
      } })),
      gateway("o1-c18.invoke-guarded", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C18", "guarded"),
      })),
      fixture("o1-c18.failure-shaped", "plan_fault", args({
        requestId: invocationRef("O1-C18", "failure-shaped"),
        fault: {
          injectedOutcome: {
            state: "failed",
            error: { code: "command_failure", message: "failure-shaped add-in result" },
          },
        },
      })),
      gateway("o1-c18.invoke-failure-shaped", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C18", "failure-shaped"),
      })),
    ],
    requiredHarnessCapabilities: ["fixture_fault_control", "terminal_error_mapping_capture"],
  },
  {
    caseId: "O1-C19",
    controls: [
      harness("o1-c19.big-endian", "send_fixture_frame", args({
        vector: "big_endian",
        frame: "{{vectors.big_endian_fixture_frame}}",
      })),
      harness("o1-c19.split", "send_split_fixture_frame", args({
        vector: "split_read",
        frame: "{{vectors.split_fixture_frame}}",
        splitOffsets: [1, 3, 7],
      })),
      harness("o1-c19.coalesced", "send_coalesced_fixture_frames", args({
        vector: "coalesced_read",
        frames: "{{vectors.coalesced_fixture_frames}}",
      })),
      harness("o1-c19.former-8192", "send_fixture_frame", args({
        vector: "former_8192",
        frame: "{{vectors.fixture_payload_8192_bytes}}",
      })),
    ],
    requiredHarnessCapabilities: ["raw_fixture_tcp", "packet_fragmentation", "packet_coalescing", "exact_byte_capture"],
  },
  {
    caseId: "O1-C20",
    controls: [
      ...sessionSetup("O1-C20"),
      ...sessionSetupDrain("O1-C20"),
      fixture("o1-c20.fail-step-1", "plan_fault", args({
        requestId: `{{batches.O1-C20.non-atomic.stepInvocationIdsByIndex.1}}`,
        fault: { jsonRpcError: { code: -32602, message: "injected non-atomic step failure" } },
      })),
      gateway("o1-c20.batch", "dispatch_batch", args({
        request: dispatchBatchRequest("O1-C20", "non-atomic", false),
      })),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "batch_terminal_capture"],
  },
  {
    caseId: "O1-C21",
    controls: [
      ...sessionSetup("O1-C21", ["doc_context_cached_v1"]),
      ...sessionSetupDrain("O1-C21"),
      withExpectedOutcome(
        gateway("o1-c21.batch", "dispatch_batch", args({
          request: dispatchBatchRequest("O1-C21", "atomic-unsupported", true),
        })),
        { kind: "control_error", code: "gateway_control_http_400", messageIncludes: "atomic batch" },
      ),
    ],
    requiredHarnessCapabilities: ["session_capability_override", "fixture_request_execution_count"],
    startupOverrides: { sessionCapabilities: ["doc_context_cached_v1"] },
  },
  {
    caseId: "O1-C22",
    controls: [
      ...sessionSetup("O1-C22", ["batch_atomic", "doc_context_cached_v1"]),
      ...sessionSetupDrain("O1-C22"),
      gateway("o1-c22.commit", "dispatch_batch", args({
        request: dispatchBatchRequest("O1-C22", "atomic-commit", true),
      })),
      fixture("o1-c22.after-commit", "snapshot_evidence", args(), "observation"),
      fixture("o1-c22.rollback-fault", "plan_fault", args({
        requestId: `{{batches.O1-C22.atomic-rollback.stepInvocationIdsByIndex.2}}`,
        fault: { rollbackFailure: false, injectedOutcome: {
          state: "failed",
          error: { code: "command_failure", message: "injected atomic step failure" },
        } },
      })),
      gateway("o1-c22.rollback", "dispatch_batch", args({
        request: dispatchBatchRequest("O1-C22", "atomic-rollback", true),
      })),
      fixture("o1-c22.after-rollback", "snapshot_evidence", args(), "observation"),
    ],
    requiredHarnessCapabilities: ["session_capability_override", "fixture_model_digest", "batch_terminal_capture"],
    startupOverrides: { sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"] },
  },
  {
    caseId: "O1-C23",
    controls: [
      ...sessionSetup("O1-C23"),
      ...sessionSetupDrain("O1-C23"),
      fixture("o1-c23.context-event", "apply_document_context", args({ event: "{{vectors.document_context_revision_2}}" })),
      bridge("o1-c23.poll", "poll_document_context", args({ rsid: "{{case.rsid}}", force: true })),
      harness("o1-c23.flush", "drive_bridge_outbound", args({ advanceByMs: 15_000 })),
      harness("o1-c23.await-context", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/documents/0/title",
        operator: "equals",
        expected: "Conformance Fixture Revision 2",
        timeoutMs: 15_000,
      })),
    ],
    requiredHarnessCapabilities: ["monotonic_timing", "fixture_method_execution_count", "document_context_wire_capture"],
  },
  {
    caseId: "O1-C24",
    controls: [
      ...sessionSetup("O1-C24"),
      ...sessionSetupDrain("O1-C24"),
      gateway("o1-c24.duplicate", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "duplicate", binding: "wss", remaining: 1 } },
        { rule: { direction: "gateway_to_bridge", action: "duplicate", binding: "http_sse", remaining: 1 } },
      )),
      gateway("o1-c24.hold-first", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "wss", remaining: 1 } },
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "http_sse", remaining: 1 } },
      )),
      gateway("o1-c24.dispatch-a", "dispatch_invoke", args({
        request: dispatchInvokeRequest("O1-C24", "duplicate"),
      })),
      withExecution(
        gateway("o1-c24.dispatch-b", "dispatch_invoke", args({
          request: dispatchInvokeRequest("O1-C24", "reordered"),
        })),
        { mode: "async_start", handle: "o1-c24.dispatch-b" },
      ),
      harness("o1-c24.await-held", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/runtime/heldOutboundFrames",
        operator: "equals",
        expected: 1,
        timeoutMs: 5_000,
      }), "observation", 10_000),
      gateway("o1-c24.disconnect", "disconnect", args({ connection_id: "{{case.connection_id}}" })),
      bridge("o1-c24.restart-bridge", "restart_simulator"),
      bridge("o1-c24.reopen", "open_transport", byBinding(
        {
          kind: "wss",
          endpointPolicy: "loopback_test_tls",
          deviceToken: "{{case.device_token}}",
          wssUrl: "{{gateway.ready.ws_url}}",
          tlsTrust: {
            caCertificatePath: "{{gateway.ready.ca_certificate_path}}",
            caCertificateSha256: "{{gateway.ready.ca_certificate_sha256}}",
            serverCertificateSha256: "{{gateway.ready.server_certificate_sha256}}",
          },
          hello: hello("O1-C24", "reconnect"),
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{gateway.ready.http_connection_url}}",
          hello: hello("O1-C24", "reconnect"),
        },
      )),
      bridge("o1-c24.restart-run-loop", "start_run_loop", args()),
      harness("o1-c24.await-resume-ack", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      withExecution(
        harness("o1-c24.join-reordered", "drive_bridge_outbound", args({ advanceByMs: 15_001 })),
        { mode: "async_join", handles: ["o1-c24.dispatch-b"] },
      ),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "sequence_snapshot", "reconnect_resume"],
  },
  {
    caseId: "O1-C25",
    controls: [
      ...sessionSetup("O1-C25"),
      withCaptures(
        harness("o1-c25.foreign-session-register", "send_binding_frame", args({
          frame: "{{vectors.c25.foreign_session_register}}",
        })),
        [
          {
            name: "case.foreign_rsid",
            source: "result",
            jsonPointer: "/remoteOutcome/sessionRegistration/rsid",
          },
          {
            name: "case.foreign_resume_token_sha256",
            source: "result",
            jsonPointer: "/remoteOutcome/sessionRegistration/resumeTokenSha256",
          },
        ],
      ),
      harness("o1-c25.cross-device-resume", "send_binding_frame", args({
        credential: "{{case.other_device_token}}",
        authorizationProbe: {
          sourceRsid: "{{case.rsid}}",
          targetRsid: "{{case.rsid}}",
          messageId: "{{ids.O1-C25.cross-device-resume.envelopeId}}",
          ts: "{{clock.iso}}",
        },
      })),
      harness("o1-c25.cross-rsid-resume", "send_binding_frame", args({
        credential: "{{case.device_token}}",
        authorizationProbe: {
          sourceRsid: "{{case.rsid}}",
          targetRsid: "{{case.foreign_rsid}}",
          messageId: "{{ids.O1-C25.cross-rsid-resume.envelopeId}}",
          ts: "{{clock.iso}}",
        },
      })),
      bridge("o1-c25.unknown-session-invoke", "invoke_local", args({
        envelope: {
          ...envelope("O1-C25", "foreign-invoke"),
          rsid: "{{case.foreign_rsid}}",
          seq: 1,
          ack: 0,
        },
      })),
    ],
    requiredHarnessCapabilities: [
      "multiple_device_credentials",
      "raw_binding_frame",
      "authorization_fault_capture",
      "gateway_persisted_session_authority_capture",
      "secret_redacted_resume_probe",
    ],
  },
  {
    caseId: "O1-C26",
    controls: [
      harness("o1-c26.restart-version-window", "restart_component", args({
        componentId: "gateway_stub",
        preserveState: false,
        startupOverrides: { supportedProtocols: ["{{protocol.N}}", "{{protocol.N_minus_one}}"] },
      }), "setup"),
      harness("o1-c26.version-n", "send_binding_frame", args({ frame: "{{vectors.hello_version_n}}" })),
      harness("o1-c26.version-n-minus-one", "send_binding_frame", args({ frame: "{{vectors.hello_version_n_minus_one}}" })),
      harness("o1-c26.additive", "send_binding_frame", args({ frame: "{{vectors.additive_within_version}}" })),
      harness("o1-c26.breaking", "send_binding_frame", args({ frame: "{{vectors.breaking_within_version}}" })),
    ],
    requiredHarnessCapabilities: ["gateway_protocol_window_n_and_n_minus_one", "raw_binding_frame", "schema_fault_capture"],
  },
  {
    caseId: "O1-C27",
    controls: [
      bridge("o1-c27.configure-backoff", "configure_reconnect_conformance", args({
        mode: "deterministic_virtual_clock",
        jitterUnits: "{{vectors.c27_reconnect_jitter_units}}",
      }), "setup"),
      ...sessionSetup("O1-C27"),
      gateway("o1-c27.opening-faults", "enqueue_opening_fault", byBinding(
        {
          rule: {
            binding: "wss",
            status: 503,
            remaining: "{{vectors.c27_opening_failure_count}}",
          },
        },
        {
          rule: {
            binding: "http_sse",
            status: 503,
            remaining: "{{vectors.c27_opening_failure_count}}",
          },
        },
      )),
      gateway("o1-c27.disconnect", "disconnect", args({ connection_id: "{{case.connection_id}}" })),
      harness("o1-c27.await-attempts", "await_condition", args({
        source: "bridge_reconnect_schedule",
        jsonPointer: "/reconnectConformance/attempts",
        operator: "count_equals",
        expected: 9,
        timeoutMs: 15_000,
      }), "stimulus", 20_000),
      harness("o1-c27.await-resume-ack", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c27.after-attempts", "snapshot_evidence", args(), "observation"),
      bridge("o1-c27.advance-before-reset", "advance_reconnect_conformance_clock", args({
        advanceByMs: 119_999,
        heartbeatStepMs: 30_000,
      }), "stimulus"),
      bridge("o1-c27.before-reset", "snapshot_evidence", args(), "observation"),
      bridge("o1-c27.advance-to-reset", "advance_reconnect_conformance_clock", args({
        advanceByMs: 1,
        heartbeatStepMs: 1,
      }), "stimulus"),
      bridge("o1-c27.after-reset", "snapshot_evidence", args(), "observation"),
    ],
    requiredHarnessCapabilities: [
      "deterministic_random",
      "virtual_clock",
      "gateway_opening_fault_injection",
      "reconnect_schedule_capture",
      "steady_duration_control",
      "heartbeat_wire_capture",
    ],
  },
  {
    caseId: "O1-C28",
    controls: [
      ...sessionSetup("O1-C28"),
      fixture("o1-c28.delay-origin", "plan_fault", args({
        requestId: "{{vectors.c28.origin.invocation_id}}",
        fault: { delayMs: 750 },
      })),
      gateway("o1-c28.dispatch-origin", "dispatch_invoke", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c28.origin}}",
        },
      })),
      gateway("o1-c28.expire", "expire_pending", args({ rsid: "{{case.rsid}}" })),
      withCaptures(
        harness("o1-c28.capture-hold", "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer: "/mutationHolds/holds/0/holdId",
          operator: "exists",
          timeoutMs: 5_000,
        }), "observation", 10_000),
        [{ name: "case.c28_hold_id", source: "result", jsonPointer: "/observed" }],
      ),
      withExpectedOutcome(
        gateway("o1-c28.fresh-id", "dispatch_invoke", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: "{{vectors.c28.fresh}}",
          },
        })),
        {
          kind: "control_error",
          code: "gateway_control_http_500",
          messageIncludes: "mutation conflicts",
        },
      ),
      withExpectedOutcome(
        gateway("o1-c28.batch", "dispatch_batch", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: "{{vectors.c28.conflicting_batch.payload}}",
          },
        })),
        {
          kind: "control_error",
          code: "gateway_control_http_500",
          messageIncludes: "mutation conflicts",
        },
      ),
      withExpectedOutcome(
        gateway("o1-c28.invalid", "dispatch_invoke", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: {
              invocation_id: "{{vectors.c28.invalid_recovery.invocation_id}}",
              method: "{{vectors.c28.invalid_recovery.method}}",
              params: "{{vectors.c28.invalid_recovery.params}}",
              timeout_ms: "{{vectors.c28.invalid_recovery.timeout_ms}}",
              mutating: true,
              mutation_scope: { kind: "session" },
              policy: "{{vectors.c28.invalid_recovery.policy}}",
              verification: null,
              recovery_clearances: [{
                hold_id: "{{case.c28_hold_id}}",
                mutation_scope: { kind: "session" },
                resolution_id: "{{vectors.c28.invalid_resolution_id}}",
                basis: "verification_read",
                verification_invocation_id: "{{vectors.c28.invalid_verification_invocation_id}}",
                evidence_digest: "{{vectors.c28.invalid_evidence_digest}}",
                decision: "postcondition_verified",
                audit_id: "{{vectors.c28.invalid_audit_id}}",
              }],
            },
          },
        })),
        {
          kind: "control_error",
          code: "gateway_control_http_400",
          messageIncludes: "recovery clearance rejected: clearance_not_ready",
        },
      ),
      harness("o1-c28.await-bridge-indeterminate", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/invocations/0/state",
        operator: "equals",
        expected: "indeterminate",
        timeoutMs: 5_000,
      }), "observation", 10_000),
      harness("o1-c28.await-indeterminate-wire", "await_condition", args({
        source: "gateway.snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c28.origin.invocation_id}}/classification",
        operator: "equals",
        expected: "journal_indeterminate",
        timeoutMs: 5_000,
      }), "observation", 10_000),
      harness("o1-c28.await-late-journal", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/invocations/0/lateTerminalOutcomeDigest",
        operator: "exists",
        timeoutMs: 5_000,
      }), "observation", 10_000),
      gateway("o1-c28.hold-origin-redelivery", "enqueue_frame_fault", byBinding(
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "hold",
            binding: "wss",
            messageType: "invoke",
            remaining: 1,
          },
        },
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "hold",
            binding: "http_sse",
            messageType: "invoke",
            remaining: 1,
          },
        },
      )),
      withExecution(
        gateway("o1-c28.redeliver-origin", "dispatch_invoke", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: "{{vectors.c28.origin}}",
          },
        })),
        { mode: "async_start", handle: "o1-c28.redeliver-origin" },
      ),
      harness("o1-c28.await-origin-redelivery-held", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/runtime/heldOutboundFrames",
        operator: "equals",
        expected: 1,
        timeoutMs: 5_000,
      }), "observation", 10_000),
      gateway("o1-c28.expire-redelivery", "expire_pending", args({ rsid: "{{case.rsid}}" })),
      withExecution(
        gateway("o1-c28.flush-origin-redelivery", "flush_held"),
        { mode: "async_join", handles: ["o1-c28.redeliver-origin"] },
      ),
      harness(
        "o1-c28.ack-expiry-and-drive-late-replay",
        "drive_bridge_outbound",
        args({ advanceByMs: 15_001 }),
        "stimulus",
        20_000,
      ),
      withCaptures(
        harness("o1-c28.capture-late-digest", "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer:
            "/sessions/{{case.rsid}}/lateTerminalEvidence/{{vectors.c28.origin.invocation_id}}/1/envelope/payload/result_digest",
          operator: "exists",
          timeoutMs: 10_000,
        }), "observation", 15_000),
        [{ name: "case.c28_late_digest", source: "result", jsonPointer: "/observed" }],
      ),
      withCaptures(
        bridge("o1-c28.read-origin-journal", "read_journal_record_for_conformance", args({
          rsid: "{{case.rsid}}",
          invocationId: "{{vectors.c28.origin.invocation_id}}",
        }), "observation"),
        [{ name: "case.c28_origin_journal", source: "result", jsonPointer: "/journalRecord" }],
      ),
      gateway("o1-c28.late-terminal", "record_late_terminal_evidence", args({
        request: {
          rsid: "{{case.rsid}}",
          holdId: "{{case.c28_hold_id}}",
          originIdempotencyKey: "{{case.rsid}}/{{vectors.c28.origin.invocation_id}}",
          evidenceDigest: "{{case.c28_late_digest}}",
          conclusion: "postcondition_verified",
          journalRecord: "{{case.c28_origin_journal}}",
        },
      })),
      bridge("o1-c28.bridge-late-terminal", "record_late_evidence", args({
        rsid: "{{case.rsid}}",
        holdId: "{{case.c28_hold_id}}",
        originInvocationId: "{{vectors.c28.origin.invocation_id}}",
        evidenceDigest: "{{case.c28_late_digest}}",
        conclusion: "postcondition_verified",
        atMs: "{{vectors.c28.evidence_at_ms}}",
      })),
      gateway("o1-c28.after-late-terminal", "snapshot", args(), "observation"),
      gateway("o1-c28.dispatch-verification", "dispatch_invoke", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: {
            invocation_id: "{{vectors.c28.verification.invocation_id}}",
            method: "{{vectors.c28.verification.method}}",
            params: "{{vectors.c28.verification.params}}",
            timeout_ms: "{{vectors.c28.verification.timeout_ms}}",
            mutating: false,
            mutation_scope: null,
            policy: "{{vectors.c28.verification.policy}}",
            verification: {
              hold_id: "{{case.c28_hold_id}}",
              mutation_scope: { kind: "session" },
              purpose: "resolve_indeterminate",
            },
            recovery_clearances: [],
          },
        },
      })),
      withCaptures(
        harness("o1-c28.capture-verification-digest", "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer:
            "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c28.verification.invocation_id}}/envelope/payload/result_digest",
          operator: "exists",
          timeoutMs: 10_000,
        }), "observation", 15_000),
        [{
          name: "case.c28_verification_digest",
          source: "result",
          jsonPointer: "/observed",
        }],
      ),
      withCaptures(
        bridge("o1-c28.read-verification-journal", "read_journal_record_for_conformance", args({
          rsid: "{{case.rsid}}",
          invocationId: "{{vectors.c28.verification.invocation_id}}",
        }), "observation"),
        [{
          name: "case.c28_verification_journal",
          source: "result",
          jsonPointer: "/journalRecord",
        }],
      ),
      gateway("o1-c28.inconclusive", "record_verification_evidence", args({
        request: {
          rsid: "{{case.rsid}}",
          holdId: "{{case.c28_hold_id}}",
          mutationScope: { kind: "session" },
          verificationInvocationId: "{{vectors.c28.verification.invocation_id}}",
          evidenceDigest: "{{case.c28_verification_digest}}",
          conclusion: "inconclusive",
          journalRecord: "{{case.c28_verification_journal}}",
        },
      })),
      bridge("o1-c28.bridge-inconclusive", "record_verification_attempt", args({
        rsid: "{{case.rsid}}",
        holdId: "{{case.c28_hold_id}}",
        verificationInvocationId: "{{vectors.c28.verification.invocation_id}}",
        evidenceDigest: "{{case.c28_verification_digest}}",
        conclusion: "inconclusive",
        atMs: "{{vectors.c28.evidence_at_ms}}",
      })),
      gateway("o1-c28.after-inconclusive", "snapshot", args(), "observation"),
      gateway("o1-c28.conclusive", "record_verification_evidence", args({
        request: {
          rsid: "{{case.rsid}}",
          holdId: "{{case.c28_hold_id}}",
          mutationScope: { kind: "session" },
          verificationInvocationId: "{{vectors.c28.verification.invocation_id}}",
          evidenceDigest: "{{case.c28_verification_digest}}",
          conclusion: "postcondition_verified",
          journalRecord: "{{case.c28_verification_journal}}",
        },
      })),
      bridge("o1-c28.bridge-conclusive", "record_verification_attempt", args({
        rsid: "{{case.rsid}}",
        holdId: "{{case.c28_hold_id}}",
        verificationInvocationId: "{{vectors.c28.verification.invocation_id}}",
        evidenceDigest: "{{case.c28_verification_digest}}",
        conclusion: "postcondition_verified",
        atMs: "{{vectors.c28.evidence_at_ms}}",
      })),
      gateway("o1-c28.hold-recovery", "enqueue_frame_fault", byBinding(
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "hold",
            binding: "wss",
            messageType: "invoke",
            remaining: 1,
          },
        },
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "hold",
            binding: "http_sse",
            messageType: "invoke",
            remaining: 1,
          },
        },
      )),
      withExecution(
        gateway("o1-c28.dispatch-recovery", "dispatch_invoke", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: {
              invocation_id: "{{vectors.c28.recovery.invocation_id}}",
              method: "{{vectors.c28.recovery.method}}",
              params: "{{vectors.c28.recovery.params}}",
              timeout_ms: "{{vectors.c28.recovery.timeout_ms}}",
              mutating: true,
              mutation_scope: { kind: "session" },
              policy: "{{vectors.c28.recovery.policy}}",
              verification: null,
              recovery_clearances: [{
                hold_id: "{{case.c28_hold_id}}",
                mutation_scope: { kind: "session" },
                resolution_id: "{{vectors.c28.resolution_id}}",
                basis: "verification_read",
                verification_invocation_id: "{{vectors.c28.verification.invocation_id}}",
                evidence_digest: "{{case.c28_verification_digest}}",
                decision: "postcondition_verified",
                audit_id: "{{vectors.c28.audit_id}}",
              }],
            },
          },
        })),
        { mode: "async_start", handle: "o1-c28.dispatch-recovery" },
      ),
      harness("o1-c28.await-recovery-held", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/runtime/heldOutboundFrames",
        operator: "equals",
        expected: 1,
        timeoutMs: 5_000,
      }), "observation", 10_000),
      withCaptures(
        harness("o1-c28.capture-recovery-dispatch-identity", "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer: "/sessions/{{case.rsid}}/inFlight/dispatchIdentity",
          operator: "exists",
          timeoutMs: 5_000,
        }), "observation", 10_000),
        [{
          name: "case.c28_recovery_dispatch_identity",
          source: "result",
          jsonPointer: "/observed",
        }],
      ),
      bridge("o1-c28.resolve-bridge-hold", "resolve_hold", args({
        rsid: "{{case.rsid}}",
        holdId: "{{case.c28_hold_id}}",
        basis: "verification_read",
        verificationInvocationId: "{{vectors.c28.verification.invocation_id}}",
        evidenceDigest: "{{case.c28_verification_digest}}",
        decision: "postcondition_verified",
        resolutionId: "{{vectors.c28.resolution_id}}",
        auditId: "{{vectors.c28.audit_id}}",
        authorizedDispatchIdentity: "{{case.c28_recovery_dispatch_identity}}",
        atMs: "{{vectors.c28.evidence_at_ms}}",
      })),
      withCaptures(
        bridge("o1-c28.capture-bridge-clearance", "clearance_for_hold", args({
          rsid: "{{case.rsid}}",
          holdId: "{{case.c28_hold_id}}",
        }), "observation"),
        [{
          name: "case.c28_bridge_clearance",
          source: "result",
          jsonPointer: "/clearance",
        }],
      ),
      withExecution(
        gateway("o1-c28.flush-recovery", "flush_held"),
        { mode: "async_join", handles: ["o1-c28.dispatch-recovery"] },
      ),
      harness("o1-c28.await-gateway-cleared", "await_condition", args({
        source: "gateway.snapshot",
        jsonPointer: "/mutationHolds/holds/0/state",
        operator: "equals",
        expected: "cleared",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      harness("o1-c28.await-bridge-cleared", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/holds/0/state",
        operator: "equals",
        expected: "cleared",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      harness("o1-c28.await-recovery-terminal", "await_condition", args({
        source: "gateway.snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c28.recovery.invocation_id}}/classification",
        operator: "equals",
        expected: "result",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      gateway("o1-c28.final-gateway", "snapshot", args(), "observation"),
      bridge("o1-c28.final-bridge", "snapshot_evidence", args(), "observation"),
    ],
    requiredHarnessCapabilities: [
      "bridge_crash_recovery",
      "gateway_hold_ledger",
      "late_terminal_capture",
      "fixture_request_execution_count",
      "journal_snapshot",
    ],
  },
  {
    caseId: "O1-C29",
    controls: [
      ...sessionSetup("O1-C29", ["batch_atomic"]),
      fixture("o1-c29.mixed-fault", "plan_fault", args({
        requestId: "{{vectors.c29.mixed_write_invocation_id}}",
        fault: {
          injectedOutcome: {
            state: "failed",
            error: {
              code: "revit_api",
              message: "C29 known non-atomic mutation failure",
            },
          },
        },
      })),
      bridge("o1-c29.mixed-crash-plan", "inject_crash", args({
        point: "after_non_atomic_step_terminal_before_batch_terminal",
      })),
      gateway("o1-c29.mixed-initial", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.mixed_non_atomic.payload}}",
        },
      }), "stimulus", 60_000),
      harness("o1-c29.await-mixed-crash", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/crash/crashed",
        operator: "equals",
        expected: true,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c29.mixed-crash-evidence", "snapshot_evidence", args(), "observation"),
      bridge("o1-c29.mixed-restart", "restart_simulator"),
      bridge("o1-c29.mixed-reopen", "open_transport", byBinding(
        {
          kind: "wss",
          endpointPolicy: "loopback_test_tls",
          deviceToken: "{{case.device_token}}",
          wssUrl: "{{gateway.ready.ws_url}}",
          tlsTrust: {
            caCertificatePath: "{{gateway.ready.ca_certificate_path}}",
            caCertificateSha256: "{{gateway.ready.ca_certificate_sha256}}",
            serverCertificateSha256: "{{gateway.ready.server_certificate_sha256}}",
          },
          hello: hello("O1-C29", "mixed-restart"),
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{gateway.ready.http_connection_url}}",
          hello: hello("O1-C29", "mixed-restart"),
        },
      )),
      bridge("o1-c29.mixed-run-loop", "start_run_loop"),
      harness("o1-c29.await-mixed-resume", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      harness("o1-c29.await-mixed-terminal", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c29.mixed_non_atomic.payload.batch_id}}",
        operator: "exists",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      gateway("o1-c29.mixed-redelivery", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.mixed_non_atomic.payload}}",
        },
      })),
      harness("o1-c29.await-mixed-redelivery", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/inFlight",
        operator: "equals",
        expected: null,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c29.mixed-redelivery-evidence", "snapshot_evidence", args(), "observation"),
      fixture("o1-c29.mixed-execution-evidence", "snapshot_evidence", args(), "observation"),
      gateway("o1-c29.atomic-terminal", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.atomic_terminal.payload}}",
        },
      })),
      harness("o1-c29.await-atomic-terminal", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/inFlight",
        operator: "equals",
        expected: null,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      gateway("o1-c29.atomic-replay", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.atomic_terminal.payload}}",
        },
      })),
      harness("o1-c29.await-atomic-replay", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/inFlight",
        operator: "equals",
        expected: null,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      fixture("o1-c29.atomic-replay-execution-evidence", "snapshot_evidence", args(), "observation"),
      bridge("o1-c29.atomic-crash-plan", "inject_crash", args({
        point: "after_executing_before_addin_write",
      })),
      gateway("o1-c29.atomic-indeterminate-initial", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.atomic_indeterminate.payload}}",
        },
      }), "stimulus", 60_000),
      harness("o1-c29.await-atomic-crash", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/crash/crashed",
        operator: "equals",
        expected: true,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c29.atomic-crash-evidence", "snapshot_evidence", args(), "observation"),
      fixture("o1-c29.atomic-pre-restart-execution-evidence", "snapshot_evidence", args(), "observation"),
      bridge("o1-c29.atomic-restart", "restart_simulator"),
      bridge("o1-c29.atomic-reopen", "open_transport", byBinding(
        {
          kind: "wss",
          endpointPolicy: "loopback_test_tls",
          deviceToken: "{{case.device_token}}",
          wssUrl: "{{gateway.ready.ws_url}}",
          tlsTrust: {
            caCertificatePath: "{{gateway.ready.ca_certificate_path}}",
            caCertificateSha256: "{{gateway.ready.ca_certificate_sha256}}",
            serverCertificateSha256: "{{gateway.ready.server_certificate_sha256}}",
          },
          hello: hello("O1-C29", "atomic-restart"),
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{gateway.ready.http_connection_url}}",
          hello: hello("O1-C29", "atomic-restart"),
        },
      )),
      bridge("o1-c29.atomic-run-loop", "start_run_loop"),
      harness("o1-c29.await-atomic-resume", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      harness("o1-c29.await-atomic-indeterminate", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c29.atomic_indeterminate.payload.batch_id}}",
        operator: "exists",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      gateway("o1-c29.atomic-indeterminate-redelivery", "dispatch_batch", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c29.atomic_indeterminate.payload}}",
        },
      })),
      harness("o1-c29.await-atomic-indeterminate-redelivery", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/inFlight",
        operator: "equals",
        expected: null,
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c29.final-bridge-evidence", "snapshot_evidence", args(), "observation"),
      gateway("o1-c29.final-gateway-evidence", "snapshot", args(), "observation"),
      fixture("o1-c29.final-execution-evidence", "snapshot_evidence", args(), "observation"),
    ],
    requiredHarnessCapabilities: [
      "batch_crash_window",
      "fixture_request_execution_count",
      "gateway_hold_ledger",
      "journal_snapshot",
      "reconnect_resume",
    ],
  },
  {
    caseId: "O1-C30",
    controls: [
      ...sessionSetup("O1-C30"),
      bridge("o1-c30.journal-policy-baseline", "invoke_local", args({
        envelope: c30JournalEnvelope("policy", "baseline", 1),
      })),
      bridge("o1-c30.journal-policy-changed", "invoke_local", args({
        envelope: c30JournalEnvelope("policy", "changed", 2),
      })),
      bridge("o1-c30.journal-scope-baseline", "invoke_local", args({
        envelope: c30JournalEnvelope("scope", "baseline", 3),
      })),
      bridge("o1-c30.journal-scope-changed", "invoke_local", args({
        envelope: c30JournalEnvelope("scope", "changed", 4),
      })),
      bridge("o1-c30.journal-clearance-baseline", "invoke_local", args({
        envelope: c30JournalEnvelope("clearance", "baseline", 5),
      })),
      bridge("o1-c30.journal-clearance-changed", "invoke_local", args({
        envelope: c30JournalEnvelope("clearance", "changed", 6),
      })),
      ...[
        "property-order",
        "number-formatting",
        "unicode",
        "escapes",
        "step-omission",
        "params-digest-mismatch",
        "per-step-digest",
        "batch-digest",
        "changed-policy",
        "changed-scope",
        "changed-clearance",
        "harmless-reserialization",
      ].map((vector) => harness(`o1-c30.${vector}`, "send_binding_frame", args(
        vector === "harmless-reserialization"
          ? { serializedFrame: `{{vectors.c30.${vector}}}` }
          : { frame: `{{vectors.c30.${vector}}}` },
      ))),
    ],
    requiredHarnessCapabilities: [
      "rfc8785_vector_generation",
      "raw_binding_frame",
      "pre_dispatch_count_capture",
      "journal_binding_redelivery",
    ],
  },
  {
    caseId: "O1-C31",
    controls: [
      ...sessionSetup("O1-C31"),
      ...[
        "heartbeat_ack_positive",
        "heartbeat_ack_negative",
        "session_register_positive",
        "session_register_negative",
        "session_unregister_positive",
        "session_unregister_negative",
        "session_resume_positive",
        "session_resume_negative",
        "cancel_positive",
        "cancel_negative",
        "goodbye_positive",
        "goodbye_negative",
        "manifest_positive",
        "manifest_negative",
      ].map((vector) => harness(`o1-c31.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c31.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: ["payload_schema_vectors", "raw_binding_frame", "schema_fault_capture"],
  },
  {
    caseId: "O1-C32",
    controls: c32Controls(),
    initialStackTimeoutMs: C32_STACK_LIFECYCLE_TIMEOUT_MS,
    requiredHarnessCapabilities: [
      "registered_session_chunk_conformance",
      "base64_boundary_vectors",
      "chunk_reconstruction_verification",
      "decoded_digest_verification",
    ],
  },
  {
    caseId: "O1-C33",
    controls: [
      bridge("o1-c33.loopback", "discover_fixture", args({
        host: "127.0.0.1",
        port: "{{fixture.ready.port}}",
        probeTimeoutMs: 1_000,
      })),
      harness("o1-c33.wildcard", "spawn_fixture_bind_probe", args({ host: "0.0.0.0", expected: "reject" })),
      bridge("o1-c33.lan", "discover_fixture", args({ host: "192.0.2.10", port: 48_298, probeTimeoutMs: 100 })),
      bridge("o1-c33.hostname", "discover_fixture", args({ host: "{{vectors.remote_hostname}}", port: 48_298, probeTimeoutMs: 100 })),
      harness("o1-c33.override", "spawn_fixture_bind_probe", args({
        host: "127.0.0.1",
        allowUnsafeBind: true,
        expected: "reject",
      })),
    ],
    requiredHarnessCapabilities: ["fixture_bind_probe", "controlled_hostname_resolution", "discovery_error_capture"],
  },
  {
    caseId: "O1-C34",
    controls: [
      ...sessionSetup("O1-C34"),
      harness("o1-c34.document-schema", "send_binding_frame", args({ frame: "{{vectors.c34.valid_session_register}}" })),
      harness("o1-c34.seat-spoof", "send_binding_frame", args({
        credential: "{{case.device_token}}",
        frame: "{{vectors.c34.seat_spoof_register}}",
      })),
      harness("o1-c34.user-spoof", "send_binding_frame", args({
        credential: "{{case.device_token}}",
        frame: "{{vectors.c34.user_spoof_register}}",
      })),
    ],
    requiredHarnessCapabilities: ["enrollment_identity_fixture", "raw_binding_frame", "authorization_audit_capture"],
  },
  {
    caseId: "O1-C35",
    controls: [
      ...sessionSetup("O1-C35"),
      harness("o1-c35.await-initial-context", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/sequence/lastRxSeq",
        operator: "equals",
        expected: 1,
        timeoutMs: 10_000,
      }), "setup"),
      bridge("o1-c35.ack-initial-context", "send_heartbeat_for_conformance", args(), "setup"),
      harness("o1-c35.await-initial-drain", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sequences/0/outbox",
        operator: "count_equals",
        expected: 0,
        timeoutMs: 10_000,
      }), "setup"),
      gateway("o1-c35.prime-gateway-near-exhaustion", "prime_sequence_for_conformance", args({
        rsid: "{{case.rsid}}",
        mode: "bridge_to_gateway_near_exhaustion",
      })),
      bridge("o1-c35.prime-bridge-near-exhaustion", "prime_sequence_for_conformance", args({
        rsid: "{{case.rsid}}",
        mode: "outbound_near_exhaustion",
      })),
      bridge("o1-c35.send-max-safe", "poll_document_context", args({
        rsid: "{{case.rsid}}",
        force: true,
      })),
      harness("o1-c35.await-max-safe", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.rsid}}/sequence/lastRxSeq",
        operator: "equals",
        expected: 9_007_199_254_740_991,
        timeoutMs: 10_000,
      })),
      bridge("o1-c35.ack-max-safe", "send_heartbeat_for_conformance"),
      harness("o1-c35.await-max-drain", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sequences/0/outbox",
        operator: "count_equals",
        expected: 0,
        timeoutMs: 10_000,
      })),
      bridge("o1-c35.renew", "renew_exhausted_session", args({
        rsid: "{{case.rsid}}",
      })),
      withCaptures(
        harness("o1-c35.await-renewal", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/sessions/0/rsid",
          operator: "not_equals",
          expected: "{{case.rsid}}",
          timeoutMs: 10_000,
        })),
        [{ name: "case.renewed_rsid", source: "result", jsonPointer: "/dynamic/rsid" }],
      ),
      harness("o1-c35.await-renewed-context", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.renewed_rsid}}/sequence/lastRxSeq",
        operator: "equals",
        expected: 1,
        timeoutMs: 10_000,
      })),
      gateway("o1-c35.after-renewal-gateway", "snapshot", args(), "observation"),
      bridge("o1-c35.after-renewal-bridge", "snapshot_evidence", args(), "observation"),
      harness("o1-c35.unsafe_two_pow_53", "send_binding_frame", args({
        frame: "{{vectors.c35.unsafe_two_pow_53}}",
      })),
      gateway("o1-c35.duplicate-fault", "enqueue_frame_fault", byBinding(
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "duplicate",
            binding: "wss",
            messageType: "invoke",
            remaining: 1,
          },
        },
        {
          rule: {
            direction: "gateway_to_bridge",
            action: "duplicate",
            binding: "http_sse",
            messageType: "invoke",
            remaining: 1,
          },
        },
      )),
      gateway("o1-c35.duplicate-dispatch", "dispatch_invoke", args({
        request: {
          rsid: "{{case.renewed_rsid}}",
          payload: invokePayload("O1-C35", "duplicate"),
        },
      })),
      harness("o1-c35.await-duplicate-terminal", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/sessions/{{case.renewed_rsid}}/terminalOutcomes/{{ids.O1-C35.duplicate.invocationId}}",
        operator: "exists",
        timeoutMs: 15_000,
      })),
      fixture("o1-c35.after-duplicate-fixture", "snapshot_evidence", args(), "observation"),
      bridge("o1-c35.after-duplicate-bridge", "snapshot_evidence", args(), "observation"),
      gateway("o1-c35.after-duplicate-gateway", "snapshot", args(), "observation"),
      gateway("o1-c35.prime-forward-gap", "prime_sequence_for_conformance", args({
        rsid: "{{case.renewed_rsid}}",
        mode: "gateway_to_bridge_gap_after_one",
      })),
      gateway("o1-c35.gap-dispatch", "dispatch_invoke", args({
        request: {
          rsid: "{{case.renewed_rsid}}",
          payload: invokePayload("O1-C35", "gap"),
        },
      })),
      harness("o1-c35.await-gap", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/runLoopError",
        operator: "exists",
        timeoutMs: 10_000,
      })),
      fixture("o1-c35.after-gap-fixture", "snapshot_evidence", args(), "observation"),
      bridge("o1-c35.after-gap-bridge", "snapshot_evidence", args(), "observation"),
      gateway("o1-c35.after-gap-gateway", "snapshot", args(), "observation"),
    ],
    requiredHarnessCapabilities: [
      "raw_binding_frame",
      "sequence_snapshot",
      "session_renewal_capture",
      "fixture_request_execution_count",
    ],
  },
  {
    caseId: "O1-C36",
    controls: [
      gateway("o1-c36.opening-fault", "enqueue_opening_fault", byBinding(
        { rule: { binding: "wss", status: 503, retryAfter: "1", remaining: 1 } },
        { rule: { binding: "http_sse", status: 503, retryAfter: "1", remaining: 1 } },
      ), "setup"),
      harness("o1-c36.capture-opening-fault", "send_binding_frame", args({
        frame: "{{vectors.raw_opening_hello}}",
      }), "setup"),
      ...sessionSetup("O1-C36"),
      bridge("o1-c36.restart-for-other-binding", "restart_simulator"),
      withCaptures(
        harness("o1-c36.restart-gateway-cleartext", "restart_component", args({
          componentId: "gateway_stub",
          preserveState: true,
          transportSecurity: "cleartext_loopback",
        })),
        [
          {
            name: "case.c36.cleartext_ws_url",
            source: "result",
            jsonPointer: "/readiness/ws_url",
          },
          {
            name: "case.c36.cleartext_http_connection_url",
            source: "result",
            jsonPointer: "/readiness/http_connection_url",
          },
        ],
      ),
      withCaptures(
        bridge("o1-c36.open-other-binding", "open_transport", byBinding(
          {
            kind: "streamable_http_sse",
            endpointPolicy: "loopback_test_readiness",
            deviceToken: "{{case.device_token}}",
            fallbackUrl: "{{case.c36.cleartext_http_connection_url}}",
            clockStartMs: 0,
            hello: hello("O1-C36", "other-binding"),
          },
          {
            kind: "wss",
            endpointPolicy: "loopback_test_readiness",
            deviceToken: "{{case.device_token}}",
            wssUrl: "{{case.c36.cleartext_ws_url}}",
            clockStartMs: 0,
            hello: hello("O1-C36", "other-binding"),
          },
        )),
        [{ name: "case.other_connection_id", source: "result", jsonPointer: "/connectionId" }],
      ),
      bridge("o1-c36.other-run-loop", "start_run_loop"),
      harness("o1-c36.await-other-resume", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      bridge("o1-c36.restart-for-sse-proxy", "restart_simulator"),
      withCaptures(
        bridge("o1-c36.open-sse-proxy", "open_transport", args({
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{case.c36.cleartext_http_connection_url}}",
          clockStartMs: 0,
          hello: hello("O1-C36", "proxy-sse"),
        })),
        [{ name: "case.sse_connection_id", source: "result", jsonPointer: "/connectionId" }],
      ),
      bridge("o1-c36.sse-run-loop", "start_run_loop"),
      harness("o1-c36.await-sse-resume", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/sessions/0/phase",
        operator: "equals",
        expected: "registered",
        timeoutMs: 10_000,
      }), "observation", 15_000),
      gateway("o1-c36.buffer-sse", "set_sse_buffering", args({
        connection_id: "{{case.sse_connection_id}}",
        enabled: true,
      })),
      bridge("o1-c36.buffered-heartbeat", "tick", args({ nowMs: 15_000 })),
      harness("o1-c36.await-buffered-heartbeat", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer: "/runtime/heldOutboundFrames",
        operator: "equals",
        expected: 1,
        timeoutMs: 5_000,
      }), "observation", 10_000),
      gateway("o1-c36.unbuffer-sse", "set_sse_buffering", args({
        connection_id: "{{case.sse_connection_id}}",
        enabled: false,
      })),
      gateway("o1-c36.flush", "flush_held", args({ connection_id: "{{case.sse_connection_id}}" })),
      harness("o1-c36.await-heartbeat-ack", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/lastHeartbeatAckAtMs",
        operator: "equals",
        expected: 15_000,
        timeoutMs: 5_000,
      }), "observation", 10_000),
    ],
    requiredHarnessCapabilities: ["component_restart_with_state", "binding_parity_snapshot", "opening_error_capture", "proxy_buffering_control"],
  },
  {
    caseId: "O1-C37",
    controls: [
      withCaptures(
        harness("o1-c37.spawn-three-fixtures", "spawn_fixture_bind_probe", args({
          mode: "fixture_session",
          count: 3,
        }), "setup"),
        [
          { name: "case.c37.discovery_first_port", source: "result", jsonPointer: "/firstPort" },
          { name: "case.c37.discovery_last_port", source: "result", jsonPointer: "/lastPort" },
          { name: "case.c37.primary_probe_index", source: "result", jsonPointer: "/primaryProbeIndex" },
          { name: "case.c37.auxiliary_probe_0", source: "result", jsonPointer: "/auxiliaryProbeIndexes/0" },
          { name: "case.c37.auxiliary_probe_1", source: "result", jsonPointer: "/auxiliaryProbeIndexes/1" },
          { name: "case.c37.auxiliary_probe_2", source: "result", jsonPointer: "/auxiliaryProbeIndexes/2" },
        ],
      ),
      ...sessionSetup("O1-C37", undefined, {
        discovery: {
          host: "127.0.0.1",
          firstPort: "{{case.c37.discovery_first_port}}",
          lastPort: "{{case.c37.discovery_last_port}}",
          probeTimeoutMs: 1_000,
        },
        probeIndex: "{{case.c37.primary_probe_index}}",
      }),
      ...([
        ["bridge_shutdown", "case.c37.auxiliary_probe_0", 2, 1],
        ["session_replaced", "case.c37.auxiliary_probe_1", 3, 2],
        ["operator_requested", "case.c37.auxiliary_probe_2", 4, 3],
      ] as const).flatMap(([reason, probeIndex, expectedCount, sessionIndex]) => [
        bridge(
          `o1-c37.${reason}.register`,
          "session_register",
          args({
            probeIndex: `{{${probeIndex}}}`,
            userHint: `conformance-user-${sessionIndex + 1}`,
            hostname: "conformance-host",
            fingerprint: FINGERPRINT,
            bridgeVersion: "0.0.0",
          }),
          "setup",
        ),
        withCaptures(
          harness(`o1-c37.${reason}.await-register`, "await_condition", args({
            source: "bridge.snapshot_evidence",
            jsonPointer: "/sessions",
            operator: "count_equals",
            expected: expectedCount,
            timeoutMs: 10_000,
          }), "setup", 15_000),
          [{
            name: `case.c37.${reason}.rsid`,
            source: "result",
            jsonPointer: `/snapshot/sessions/${sessionIndex}/rsid`,
          }],
        ),
      ]),
      ...([
        ["revit_exited", "case.rsid", 0],
        ["bridge_shutdown", "case.c37.bridge_shutdown.rsid", 1],
        ["session_replaced", "case.c37.session_replaced.rsid", 2],
        ["operator_requested", "case.c37.operator_requested.rsid", 3],
      ] as const).flatMap(([reason, rsid, fixtureIndex]) => [
        fixture(`o1-c37.${reason}.stall`, "plan_fault", args({
          fixtureIndex,
          requestId: `{{vectors.c37.${reason}.possibly_dispatched_invocation_id}}`,
          fault: { stall: true },
        })),
        gateway(`o1-c37.${reason}.dispatch`, "dispatch_invoke", args({
          request: {
            rsid: `{{${rsid}}}`,
            payload: `{{vectors.c37.${reason}.possibly_dispatched_mutation}}`,
          },
        })),
        harness(`o1-c37.${reason}.await-dispatch-start`, "await_condition", args({
          source: `fixture.snapshot_evidence.${fixtureIndex}`,
          jsonPointer: "/pendingStalls/0/requestId",
          operator: "equals",
          expected: `{{vectors.c37.${reason}.possibly_dispatched_invocation_id}}`,
          timeoutMs: 10_000,
        }), "observation", 15_000),
        bridge(`o1-c37.${reason}.unregister`, "session_unregister", args({
          rsid: `{{${rsid}}}`,
          reason,
        })),
        harness(`o1-c37.${reason}.await-revocation`, "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer: `/sessions/{{${rsid}}}/lifecycle/unregisterReason`,
          operator: "equals",
          expected: reason,
          timeoutMs: 10_000,
        }), "observation", 15_000),
        withExpectedOutcome(
          bridge(`o1-c37.${reason}.resume`, "session_resume", args({ rsid: `{{${rsid}}}` })),
          {
            kind: "control_error",
            code: "bridge_control_invalid_control_request",
            messageIncludes: "not resumable",
          },
        ),
        withExpectedOutcome(
          gateway(`o1-c37.${reason}.new-dispatch`, "dispatch_invoke", args({
            request: {
              rsid: `{{${rsid}}}`,
              payload: `{{vectors.c37.${reason}.post_unregister_invoke}}`,
            },
          })),
          {
            kind: "control_error",
            code: "gateway_control_http_403",
            messageIncludes: "revoked",
          },
        ),
        fixture(`o1-c37.${reason}.release`, "release_stall", args({
          fixtureIndex,
          requestId: `{{vectors.c37.${reason}.possibly_dispatched_invocation_id}}`,
        })),
        fixture(
          `o1-c37.${reason}.execution-evidence`,
          "snapshot_evidence",
          args({ fixtureIndex }),
          "observation",
        ),
      ]),
    ],
    requiredHarnessCapabilities: ["four_isolated_registered_sessions", "resume_fault_capture", "journal_snapshot"],
  },
  {
    caseId: "O1-C38",
    controls: [
      ...sessionSetup("O1-C38"),
      fixture("o1-c38.valid-guarded", "plan_fault", args({
        requestId: "{{vectors.c38.guarded_first_invocation_id}}",
        fault: { injectedOutcome: { state: "guarded", guardedReason: "operator_confirmation_required" } },
      })),
      bridge("o1-c38.first-delivery", "invoke_local", args({
        envelope: {
          v: "{{vectors.c38.guarded.v}}",
          type: "{{vectors.c38.guarded.type}}",
          id: "{{vectors.c38.guarded.id}}",
          ts: "{{clock.iso}}",
          rsid: "{{case.rsid}}",
          seq: "{{case.next_seq}}",
          ack: "{{case.last_ack}}",
          payload: "{{vectors.c38.guarded.payload}}",
        },
      })),
      harness("o1-c38.missing-reason", "send_binding_frame", args({ frame: "{{vectors.c38.guarded_without_reason}}" })),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "raw_binding_frame", "batch_terminal_capture"],
  },
  {
    caseId: "O1-C39",
    controls: [
      ...sessionSetup("O1-C39"),
      withExecution(
        gateway("o1-c39.dispatch-origin", "dispatch_invoke", args({
          request: {
            rsid: "{{case.rsid}}",
            payload: "{{vectors.c39.origin}}",
          },
        }), "stimulus", 60_000),
        { mode: "async_start", handle: "o1-c39.dispatch-origin" },
      ),
      harness("o1-c39.await-first-artifact-chunk", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/deliveryProgress/records/0/artifactChunkFramesSent",
        operator: "equals",
        expected: 1,
        timeoutMs: 30_000,
      }), "observation", 35_000),
      harness(
        "o1-c39.ack-artifact-chunk-1",
        "drive_bridge_outbound",
        args({ advanceByMs: 15_001 }),
        "stimulus",
        20_000,
      ),
      harness(
        "o1-c39.ack-artifact-chunk-2",
        "drive_bridge_outbound",
        args({ advanceByMs: 15_001 }),
        "stimulus",
        20_000,
      ),
      withExecution(
        harness(
          "o1-c39.ack-origin-terminal",
          "drive_bridge_outbound",
          args({ advanceByMs: 15_001 }),
          "stimulus",
          20_000,
        ),
        { mode: "async_join", handles: ["o1-c39.dispatch-origin"] },
      ),
      harness("o1-c39.await-origin-terminal", "await_condition", args({
        source: "gateway.compact_snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/terminalOutcomes/{{vectors.c39.origin.invocation_id}}/classification",
        operator: "equals",
        expected: "result",
        timeoutMs: 30_000,
      }), "observation", 35_000),
      gateway("o1-c39.redispatch-origin", "dispatch_invoke", args({
        request: {
          rsid: "{{case.rsid}}",
          payload: "{{vectors.c39.origin}}",
        },
      })),
      harness("o1-c39.await-omitted", "await_condition", args({
        source: "gateway.snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/omittedPayloadRecoveries/{{vectors.c39.origin.invocation_id}}/state",
        operator: "equals",
        expected: "awaiting_correlated_read",
        timeoutMs: 15_000,
      }), "observation", 20_000),
      withCaptures(
        harness("o1-c39.capture-omitted-digest", "await_condition", args({
          source: "gateway.snapshot",
          jsonPointer:
            "/sessions/{{case.rsid}}/omittedPayloadRecoveries/{{vectors.c39.origin.invocation_id}}/omittedResultDigest",
          operator: "exists",
          timeoutMs: 5_000,
        }), "observation", 10_000),
        [{
          name: "case.c39_omitted_digest",
          source: "result",
          jsonPointer: "/observed",
        }],
      ),
      gateway("o1-c39.valid-recovery", "dispatch_payload_recovery", args({
        request: {
          rsid: "{{case.rsid}}",
          originInvocationId: "{{vectors.c39.valid_recovery.originInvocationId}}",
          omittedResultDigest: "{{case.c39_omitted_digest}}",
          auditId: "{{vectors.c39.valid_recovery.auditId}}",
          payload: {
            invocation_id: "{{vectors.c39.valid_recovery.payload.invocation_id}}",
            method: "{{vectors.c39.valid_recovery.payload.method}}",
            params: {
              origin_invocation_id: "{{vectors.c39.valid_recovery.originInvocationId}}",
              expected_result_digest: "{{case.c39_omitted_digest}}",
            },
            timeout_ms: "{{vectors.c39.valid_recovery.payload.timeout_ms}}",
            mutating: false,
            mutation_scope: null,
            policy: "{{vectors.c39.valid_recovery.payload.policy}}",
            verification: null,
            recovery_clearances: [],
          },
        },
      })),
      harness("o1-c39.await-recovered", "await_condition", args({
        source: "gateway.snapshot",
        jsonPointer:
          "/sessions/{{case.rsid}}/omittedPayloadRecoveries/{{vectors.c39.origin.invocation_id}}/state",
        operator: "equals",
        expected: "recovered",
        timeoutMs: 15_000,
      }), "observation", 20_000),
      fixture("o1-c39.execution-evidence", "snapshot_evidence", args(), "observation"),
      ...[
        "nonreplay",
        "missing_digest",
        "inline_result",
      ].map((vector) => harness(`o1-c39.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c39.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: [
      "payload_omission_vectors",
      "raw_binding_frame",
      "audited_recovery_capture",
      "fixture_request_execution_count",
      "chunk_wire_capture",
      "heartbeat_wire_capture",
    ],
  },
  {
    caseId: "O1-C40",
    controls: [
      ...sessionSetup("O1-C40"),
      ...[
        "raw_path",
        "local_path",
        "traversal_path",
        "reparse_path",
        "valid_multifile",
        "retransmission",
        "invalid_member",
      ].map((vector) => harness(`o1-c40.${vector}`, "execute_product_artifact_scenario", args({
        scenario: vector,
        envelope: envelope(
          "O1-C40",
          vector,
          {
            ...(vector === "retransmission"
              ? { invocation_id: invocationRef("O1-C40", "valid_multifile") }
              : {}),
            method: "fixture_multi_file_output",
            params: `{{vectors.c40.${vector}.params}}`,
          },
        ),
      }))),
    ],
    requiredHarnessCapabilities: ["artifact_spool_inspection", "chunk_wire_capture", "reparse_point_fixture", "fixture_request_execution_count"],
  },
];

const OBSERVATION_POINTERS: Readonly<Record<ProcessObservationRecord["kind"], readonly string[]>> = {
  control_result: ["/request", "/response", "/requestBytes", "/responseBytes"],
  wire_event: ["/direction", "/binding", "/serialized", "/frame", "/atMonotonicMs"],
  gateway_snapshot: ["/sessions", "/mutationHolds", "/authorizationAudit", "/runtime"],
  bridge_snapshot: [
    "/invocations",
    "/holds",
    "/durabilityEvents",
    "/sessions",
    "/sequences",
    "/artifactSpool",
    "/peer",
    "/transport",
    "/crash",
  ],
  fixture_snapshot: [
    "/observations",
    "/executionCounts",
    "/methodExecutionCounts",
    "/modelStateDigest",
    "/pendingStalls",
    "/documentContextEvidence",
    "/openSocketCount",
  ],
  fixture_execution_count: ["/executionCounts", "/methodExecutionCounts"],
  resource_sample: ["/residentBytes", "/openFileDescriptorCount", "/journalPendingCount"],
  process_lifecycle: ["/spawnOwner", "/identity", "/process"],
};

function finalEvidenceSteps(caseId: string): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  return [
    gateway(`${prefix}.gateway-snapshot`, "snapshot", args(), "observation"),
    bridge(`${prefix}.bridge-snapshot`, "snapshot_evidence", args(), "observation"),
    fixture(`${prefix}.fixture-snapshot`, "snapshot_evidence", args(), "observation"),
    harness(`${prefix}.resource-sample`, "capture_resource_sample", args(), "observation"),
    harness(`${prefix}.wire-end`, "end_wire_capture", args(), "observation"),
    harness(`${prefix}.stack-stop`, "stop_case_stack", args(), "cleanup"),
  ];
}

function controlSteps(steps: readonly CaseControlStep[], componentId: ComponentId): string[] {
  return steps.filter((step) => step.componentId === componentId).map(({ stepId }) => stepId);
}

function observations(caseId: string, steps: readonly CaseControlStep[]): CaseObservationRequirement[] {
  const prefix = caseId.toLowerCase();
  const wireStep = `${prefix}.wire-end`;
  const requirements: CaseObservationRequirement[] = [
    {
      alias: "gateway.control",
      componentId: "gateway_stub",
      kind: "control_result",
      sourceStepIds: controlSteps(steps, "gateway_stub"),
      requiredJsonPointers: [...OBSERVATION_POINTERS.control_result],
    },
    {
      alias: "bridge.control",
      componentId: "bridge_simulator",
      kind: "control_result",
      sourceStepIds: controlSteps(steps, "bridge_simulator"),
      requiredJsonPointers: [...OBSERVATION_POINTERS.control_result],
    },
    {
      alias: "fixture.control",
      componentId: "addin_loopback_fixture",
      kind: "control_result",
      sourceStepIds: controlSteps(steps, "addin_loopback_fixture"),
      requiredJsonPointers: [...OBSERVATION_POINTERS.control_result],
    },
    {
      alias: "gateway.snapshot",
      componentId: "gateway_stub",
      kind: "gateway_snapshot",
      sourceStepIds: [`${prefix}.gateway-snapshot`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.gateway_snapshot],
    },
    {
      alias: "bridge.snapshot",
      componentId: "bridge_simulator",
      kind: "bridge_snapshot",
      sourceStepIds: [`${prefix}.bridge-snapshot`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.bridge_snapshot],
    },
    {
      alias: "fixture.snapshot",
      componentId: "addin_loopback_fixture",
      kind: "fixture_snapshot",
      sourceStepIds: [`${prefix}.fixture-snapshot`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.fixture_snapshot],
    },
    {
      alias: "fixture.execution",
      componentId: "addin_loopback_fixture",
      kind: "fixture_execution_count",
      sourceStepIds: [`${prefix}.fixture-snapshot`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.fixture_execution_count],
    },
    ...(["gateway_stub", "bridge_simulator", "addin_loopback_fixture"] as const).map((componentId) => ({
      alias: `wire.${componentId}`,
      componentId,
      kind: "wire_event" as const,
      sourceStepIds: [wireStep],
      requiredJsonPointers: [...OBSERVATION_POINTERS.wire_event],
    })),
    ...(["gateway_stub", "bridge_simulator", "addin_loopback_fixture"] as const).map((componentId) => ({
      alias: `resource.${componentId}`,
      componentId,
      kind: "resource_sample" as const,
      sourceStepIds: [`${prefix}.resource-sample`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.resource_sample],
    })),
    ...(["gateway_stub", "bridge_simulator", "addin_loopback_fixture"] as const).map((componentId) => ({
      alias: `process.${componentId}`,
      componentId,
      kind: "process_lifecycle" as const,
      sourceStepIds: [`${prefix}.stack-stop`],
      requiredJsonPointers: [...OBSERVATION_POINTERS.process_lifecycle],
    })),
  ];
  return requirements;
}

function aliasesForCategory(category: AssertionCategory): string[] {
  switch (category) {
    case "execution_count":
      return ["fixture.execution", "bridge.snapshot"];
    case "journal_truth":
      return ["gateway.snapshot", "bridge.snapshot", "fixture.execution"];
    case "artifact_integrity":
      return ["bridge.snapshot", "fixture.snapshot", "wire.bridge_simulator", "wire.addin_loopback_fixture"];
    case "discovery":
      return ["bridge.control", "bridge.snapshot", "fixture.snapshot"];
    case "resource_leak":
      return [
        "resource.gateway_stub",
        "resource.bridge_simulator",
        "resource.addin_loopback_fixture",
        "gateway.snapshot",
        "bridge.snapshot",
        "fixture.snapshot",
      ];
    case "safety":
      return [
        "gateway.control",
        "bridge.control",
        "fixture.control",
        "gateway.snapshot",
        "bridge.snapshot",
        "fixture.execution",
        "wire.gateway_stub",
        "wire.bridge_simulator",
        "wire.addin_loopback_fixture",
      ];
    case "authorization":
      return ["gateway.control", "gateway.snapshot", "wire.gateway_stub", "wire.bridge_simulator"];
    case "transport_parity":
      return ["gateway.control", "bridge.control", "gateway.snapshot", "bridge.snapshot", "wire.gateway_stub", "wire.bridge_simulator"];
    case "timing":
      return ["bridge.control", "bridge.snapshot", "wire.gateway_stub", "wire.bridge_simulator"];
    case "recovery":
      return [
        "gateway.control",
        "bridge.control",
        "gateway.snapshot",
        "bridge.snapshot",
        "fixture.execution",
        "wire.gateway_stub",
        "wire.bridge_simulator",
      ];
    case "compatibility":
    case "schema":
    case "wire_behavior":
      return [
        "gateway.control",
        "bridge.control",
        "fixture.control",
        "wire.gateway_stub",
        "wire.bridge_simulator",
        "wire.addin_loopback_fixture",
        "fixture.execution",
        "process.gateway_stub",
        "process.bridge_simulator",
        "process.addin_loopback_fixture",
      ];
  }
}

function buildProgram(definition: ProgramDefinition): ConformanceCaseProgram {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === definition.caseId);
  if (manifestCase === undefined) throw new Error(`case program references unknown case ${definition.caseId}`);
  const steps = [
    withCaptures(
      harness(`${definition.caseId.toLowerCase()}.isolated-stack`, "restart_case_stack", args({
        caseId: definition.caseId,
        binding: "{{binding}}",
        preserveState: false,
        requireExactExecutionPlanIdentity: true,
        ...(definition.startupOverrides === undefined
          ? {}
          : { startupOverrides: definition.startupOverrides }),
      }), "setup", definition.initialStackTimeoutMs ?? 30_000),
      [
        {
          name: "fixture.ready.host",
          source: "result",
          jsonPointer: "/readiness/fixture/host",
        },
        {
          name: "fixture.ready.port",
          source: "result",
          jsonPointer: "/readiness/fixture/port",
        },
        {
          name: "gateway.ready.ws_url",
          source: "result",
          jsonPointer: "/readiness/gateway/ws_url",
        },
        {
          name: "gateway.ready.http_connection_url",
          source: "result",
          jsonPointer: "/readiness/gateway/http_connection_url",
        },
        {
          name: "gateway.ready.control_url",
          source: "result",
          jsonPointer: "/readiness/gateway/control_url",
        },
        {
          name: "gateway.ready.ca_certificate_path",
          source: "result",
          jsonPointer: "/readiness/gateway/tlsTrust/caCertificatePath",
        },
        {
          name: "gateway.ready.ca_certificate_sha256",
          source: "result",
          jsonPointer: "/readiness/gateway/tlsTrust/caCertificateSha256",
        },
        {
          name: "gateway.ready.server_certificate_sha256",
          source: "result",
          jsonPointer: "/readiness/gateway/tlsTrust/serverCertificateSha256",
        },
      ],
    ),
    harness(`${definition.caseId.toLowerCase()}.wire-begin`, "begin_wire_capture", args(), "setup"),
    ...definition.controls,
    ...finalEvidenceSteps(definition.caseId),
  ];
  for (const step of steps) assertValidCaseControlStepSemantics(step);
  return {
    caseId: definition.caseId,
    bindings: [...manifestCase.bindings],
    steps,
    observations: observations(definition.caseId, steps),
    assertionProbes: canonicalManifest.requiredAssertions[definition.caseId]!.map((assertion) => ({
      assertionId: assertion.id,
      subvectorId: assertion.subvectorId,
      operator: "canonical_subvector",
      evaluationOwner: "parent_runner",
      expected: true,
      observationAliases: aliasesForCategory(assertion.category),
    })),
    requiredHarnessCapabilities: [
      "same_case_observation_binding",
      "parent_runner_predicates",
      "both_transport_bindings",
      "isolated_case_stack",
      ...definition.requiredHarnessCapabilities,
    ],
  };
}

if (CASE_DEFINITIONS.map(({ caseId }) => caseId).join("|") !== canonicalManifest.cases.map(({ id }) => id).join("|")) {
  throw new Error("case-program catalog must exactly preserve the canonical forty-case order");
}

export const CASE_CONTROL_OBSERVATION_MAP: ReadonlyMap<string, ConformanceCaseProgram> = new Map(
  CASE_DEFINITIONS.map((definition) => {
    const program = buildProgram(definition);
    return [program.caseId, program] as const;
  }),
);

export function caseProgram(caseId: string): ConformanceCaseProgram {
  const program = CASE_CONTROL_OBSERVATION_MAP.get(caseId);
  if (program === undefined) throw new Error(`no control/observation program for ${caseId}`);
  return structuredClone(program);
}
