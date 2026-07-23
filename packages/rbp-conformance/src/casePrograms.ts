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
  "tick",
  "poll_document_context",
  "flush_outbound",
  "invoke_local",
  "record_verification_attempt",
  "record_late_evidence",
  "resolve_hold",
  "clearance_for_hold",
  "inject_crash",
  "restart_simulator",
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
  "begin_wire_capture",
  "end_wire_capture",
  "await_condition",
  "send_binding_frame",
  "send_fixture_frame",
  "send_split_fixture_frame",
  "send_coalesced_fixture_frames",
  "restart_component",
  "spawn_fixture_bind_probe",
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

function sessionSetup(caseId: string, grantedSessionCapabilities?: string[]): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  return [
    bridge(`${prefix}.discover`, "discover_fixture", args({
      host: "{{fixture.ready.host}}",
      port: "{{fixture.ready.port}}",
      probeTimeoutMs: 1_000,
    }), "setup"),
    bridge(`${prefix}.open`, "open_transport", byBinding(
      {
        kind: "wss",
        endpointPolicy: "loopback_test_readiness",
        deviceToken: "{{case.device_token}}",
        wssUrl: "{{gateway.ready.ws_url}}",
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
    bridge(`${prefix}.run-loop`, "start_run_loop", args(), "setup"),
    bridge(`${prefix}.register`, "session_register", args({
      probeIndex: 0,
      userHint: "conformance-user",
      hostname: "conformance-host",
      fingerprint: FINGERPRINT,
      bridgeVersion: "0.0.0",
    }), "setup"),
    harness(`${prefix}.await-register`, "await_condition", args({
      source: "bridge.snapshot_evidence",
      jsonPointer: "/sessions/0/rsid",
      operator: "exists",
      timeoutMs: 5_000,
      grantedSessionCapabilities: grantedSessionCapabilities ?? "{{fixture.sessionCapabilities}}",
    }), "setup"),
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

function batchEnvelope(
  caseId: string,
  suffix: string,
  atomic: boolean,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    v: 1,
    type: "invoke_batch",
    id: `{{ids.${caseId}.${suffix}.envelopeId}}`,
    ts: "{{clock.iso}}",
    rsid: "{{case.rsid}}",
    seq: "{{case.next_seq}}",
    ack: "{{case.last_ack}}",
    payload: {
      batch_id: `{{ids.${caseId}.${suffix}.batchId}}`,
      atomic,
      timeout_ms: 30_000,
      recovery_clearances: [],
      steps: "{{case.batch_steps}}",
      batch_digest: "{{jcs.batch_digest}}",
      ...overrides,
    },
  };
}

interface ProgramDefinition {
  caseId: string;
  controls: CaseControlStep[];
  requiredHarnessCapabilities: string[];
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
      ...sessionSetup("O1-C05"),
      fixture("o1-c05.context", "apply_document_context", args({ event: "{{vectors.document_context}}" })),
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
      gateway("o1-c15.hold-data", "enqueue_frame_fault", byBinding(
        { rule: { direction: "bridge_to_gateway", action: "hold", binding: "wss", messageType: "chunk", remaining: 2 } },
        { rule: { direction: "bridge_to_gateway", action: "hold", binding: "http_sse", messageType: "chunk", remaining: 2 } },
      )),
      bridge("o1-c15.invoke", "invoke_local", args({ envelope: envelope("O1-C15", "chunked", { method: "fixture_multi_file_output" }) })),
      bridge("o1-c15.flush-control", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
      gateway("o1-c15.flush-held", "flush_held"),
    ],
    requiredHarnessCapabilities: ["chunk_wire_capture", "decoded_digest_verification", "buffered_amount_sampling"],
  },
  {
    caseId: "O1-C16",
    controls: [
      ...sessionSetup("O1-C16"),
      harness("o1-c16.params-oversize", "send_binding_frame", args({
        frame: "{{vectors.params_over_limit_envelope}}",
        expectedBoundary: "params",
      })),
      harness("o1-c16.result-oversize", "send_binding_frame", args({
        frame: "{{vectors.result_over_limit_invoke}}",
        expectedBoundary: "result",
      })),
    ],
    requiredHarnessCapabilities: ["oversize_payload_generation", "raw_binding_frame", "boundary_fault_capture"],
  },
  {
    caseId: "O1-C17",
    controls: [
      ...sessionSetup("O1-C17"),
      fixture("o1-c17.stall", "plan_fault", args({ requestId: "{{vectors.c17_dispatch_invoke.request.payload.invocation_id}}", fault: { stall: true } })),
      withExecution(
        gateway("o1-c17.dispatch", "dispatch_invoke", args({ request: "{{vectors.c17_dispatch_invoke}}" })),
        { mode: "async_start", handle: "o1-c17.dispatch" },
      ),
      gateway("o1-c17.cancel", "dispatch_cancel", args({ request: {
        rsid: "{{case.rsid}}",
        invocationId: "{{vectors.c17_dispatch_invoke.request.payload.invocation_id}}",
        reason: "user_requested",
      } })),
      withExecution(
        fixture("o1-c17.release", "release_stall", args({ requestId: "{{vectors.c17_dispatch_invoke.request.payload.invocation_id}}" })),
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
      fixture("o1-c18.method-not-found", "plan_fault", args({ requestId: invocationRef("O1-C18", "method"), fault: {
        jsonRpcError: { code: -32601, message: "method not found" },
      } })),
      bridge("o1-c18.invoke-method", "invoke_local", args({ envelope: envelope("O1-C18", "method") })),
      fixture("o1-c18.invalid-params", "plan_fault", args({ requestId: invocationRef("O1-C18", "params"), fault: {
        jsonRpcError: { code: -32602, message: "invalid params" },
      } })),
      bridge("o1-c18.invoke-params", "invoke_local", args({ envelope: envelope("O1-C18", "params") })),
      fixture("o1-c18.addin-exception", "plan_fault", args({ requestId: invocationRef("O1-C18", "exception"), fault: {
        injectedOutcome: { state: "failed", error: { code: "revit_api", message: "injected add-in exception" } },
      } })),
      bridge("o1-c18.invoke-exception", "invoke_local", args({ envelope: envelope("O1-C18", "exception") })),
      fixture("o1-c18.guarded", "plan_fault", args({ requestId: invocationRef("O1-C18", "guarded"), fault: {
        injectedOutcome: { state: "guarded", guardedReason: "busy" },
      } })),
      bridge("o1-c18.invoke-guarded", "invoke_local", args({ envelope: envelope("O1-C18", "guarded") })),
      harness("o1-c18.invoke-failure-shaped", "send_fixture_frame", args({
        frame: "{{vectors.c18.failure_shaped_addin_result}}",
      })),
    ],
    requiredHarnessCapabilities: ["fixture_fault_control", "terminal_error_mapping_capture"],
  },
  {
    caseId: "O1-C19",
    controls: [
      harness("o1-c19.big-endian", "send_fixture_frame", args({ frame: "{{vectors.big_endian_fixture_frame}}" })),
      harness("o1-c19.split", "send_split_fixture_frame", args({
        frame: "{{vectors.split_fixture_frame}}",
        splitOffsets: [1, 3, 7],
      })),
      harness("o1-c19.coalesced", "send_coalesced_fixture_frames", args({
        frames: "{{vectors.coalesced_fixture_frames}}",
      })),
      harness("o1-c19.former-8192", "send_fixture_frame", args({
        frame: "{{vectors.fixture_payload_8192_bytes}}",
      })),
    ],
    requiredHarnessCapabilities: ["raw_fixture_tcp", "packet_fragmentation", "packet_coalescing", "exact_byte_capture"],
  },
  {
    caseId: "O1-C20",
    controls: [
      ...sessionSetup("O1-C20"),
      bridge("o1-c20.batch", "invoke_local", args({ envelope: batchEnvelope("O1-C20", "non-atomic", false) })),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "batch_terminal_capture"],
  },
  {
    caseId: "O1-C21",
    controls: [
      harness("o1-c21.restart-gateway-without-atomic", "restart_component", args({
        componentId: "gateway_stub",
        preserveState: false,
        startupOverrides: { sessionCapabilities: [] },
      }), "setup"),
      ...sessionSetup("O1-C21", []),
      bridge("o1-c21.batch", "invoke_local", args({ envelope: batchEnvelope("O1-C21", "atomic-unsupported", true) })),
    ],
    requiredHarnessCapabilities: ["session_capability_override", "fixture_request_execution_count"],
  },
  {
    caseId: "O1-C22",
    controls: [
      harness("o1-c22.restart-gateway-with-atomic", "restart_component", args({
        componentId: "gateway_stub",
        preserveState: false,
        startupOverrides: { sessionCapabilities: ["batch_atomic"] },
      }), "setup"),
      ...sessionSetup("O1-C22", ["batch_atomic"]),
      bridge("o1-c22.commit", "invoke_local", args({ envelope: batchEnvelope("O1-C22", "atomic-commit", true) })),
      fixture("o1-c22.rollback-fault", "plan_fault", args({
        requestId: `{{ids.O1-C22.atomic-rollback.batchId}}`,
        fault: { rollbackFailure: false, injectedOutcome: {
          state: "failed",
          error: { code: "command_failure", message: "injected atomic step failure" },
        } },
      })),
      bridge("o1-c22.rollback", "invoke_local", args({ envelope: batchEnvelope("O1-C22", "atomic-rollback", true) })),
    ],
    requiredHarnessCapabilities: ["session_capability_override", "fixture_model_digest", "batch_terminal_capture"],
  },
  {
    caseId: "O1-C23",
    controls: [
      ...sessionSetup("O1-C23"),
      fixture("o1-c23.context-event", "apply_document_context", args({ event: "{{vectors.document_context_revision_2}}" })),
      bridge("o1-c23.poll", "poll_document_context", args({ rsid: "{{case.rsid}}", force: false })),
      bridge("o1-c23.flush", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
      harness("o1-c23.await-context", "await_condition", args({
        source: "wire_capture",
        jsonPointer: "/frames/document_context/payload/revision",
        operator: "equals",
        expected: 2,
        timeoutMs: 15_000,
      })),
    ],
    requiredHarnessCapabilities: ["monotonic_timing", "fixture_method_execution_count", "document_context_wire_capture"],
  },
  {
    caseId: "O1-C24",
    controls: [
      ...sessionSetup("O1-C24"),
      gateway("o1-c24.duplicate", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "duplicate", binding: "wss", remaining: 1 } },
        { rule: { direction: "gateway_to_bridge", action: "duplicate", binding: "http_sse", remaining: 1 } },
      )),
      gateway("o1-c24.hold-first", "enqueue_frame_fault", byBinding(
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "wss", remaining: 1 } },
        { rule: { direction: "gateway_to_bridge", action: "hold", binding: "http_sse", remaining: 1 } },
      )),
      gateway("o1-c24.dispatch-a", "dispatch_invoke", args({ request: "{{vectors.c24_dispatch_a}}" })),
      gateway("o1-c24.dispatch-b", "dispatch_invoke", args({ request: "{{vectors.c24_dispatch_b}}" })),
      gateway("o1-c24.disconnect", "disconnect", args({ connection_id: "{{case.connection_id}}" })),
      bridge("o1-c24.resume", "session_resume", args({ rsid: "{{case.rsid}}" })),
      gateway("o1-c24.release-order", "flush_held"),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "sequence_snapshot", "reconnect_resume"],
  },
  {
    caseId: "O1-C25",
    controls: [
      ...sessionSetup("O1-C25"),
      harness("o1-c25.cross-device-resume", "send_binding_frame", args({
        credential: "{{case.other_device_token}}",
        frame: "{{vectors.cross_device_resume}}",
      })),
      harness("o1-c25.cross-rsid-resume", "send_binding_frame", args({
        credential: "{{case.device_token}}",
        frame: "{{vectors.cross_rsid_resume}}",
      })),
      gateway("o1-c25.unknown-session-invoke", "dispatch_invoke", args({ request: "{{vectors.unregistered_rsid_invoke}}" })),
    ],
    requiredHarnessCapabilities: ["multiple_device_credentials", "raw_binding_frame", "authorization_fault_capture"],
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
      ...sessionSetup("O1-C27"),
      gateway("o1-c27.disconnect", "disconnect", args({ connection_id: "{{case.connection_id}}" })),
      harness("o1-c27.await-attempts", "await_condition", args({
        source: "bridge_reconnect_schedule",
        jsonPointer: "/attempts",
        operator: "minimum_count",
        expected: 8,
        timeoutMs: 180_000,
      }), "stimulus", 190_000),
      harness("o1-c27.await-steady-reset", "await_condition", args({
        source: "bridge_reconnect_schedule",
        jsonPointer: "/steadyDurationMs",
        operator: "crosses",
        expected: 120_000,
        timeoutMs: 130_000,
      }), "stimulus", 140_000),
    ],
    requiredHarnessCapabilities: ["deterministic_random", "reconnect_schedule_capture", "steady_duration_control"],
  },
  {
    caseId: "O1-C28",
    controls: [
      ...sessionSetup("O1-C28"),
      gateway("o1-c28.dispatch-origin", "dispatch_invoke", args({ request: "{{vectors.c28_origin_mutation}}" })),
      gateway("o1-c28.expire", "expire_pending", args({ rsid: "{{case.rsid}}" })),
      gateway("o1-c28.fresh-id", "dispatch_invoke", args({ request: "{{vectors.c28_fresh_id_mutation}}" })),
      gateway("o1-c28.batch", "dispatch_batch", args({ request: "{{vectors.c28_conflicting_batch}}" })),
      gateway("o1-c28.inconclusive", "record_verification_evidence", args({ request: "{{vectors.c28_inconclusive_evidence}}" })),
      gateway("o1-c28.invalid", "record_verification_evidence", args({ request: "{{vectors.c28_invalid_clearance}}" })),
      gateway("o1-c28.conclusive", "record_verification_evidence", args({ request: "{{vectors.c28_conclusive_clearance}}" })),
      gateway("o1-c28.late-terminal", "record_late_terminal_evidence", args({ request: "{{vectors.c28_late_terminal}}" })),
    ],
    requiredHarnessCapabilities: ["gateway_hold_ledger", "fixture_request_execution_count", "journal_snapshot"],
  },
  {
    caseId: "O1-C29",
    controls: [
      ...sessionSetup("O1-C29", ["batch_atomic"]),
      bridge("o1-c29.non-atomic", "invoke_local", args({ envelope: batchEnvelope("O1-C29", "mixed-non-atomic", false) })),
      bridge("o1-c29.atomic-terminal", "invoke_local", args({ envelope: batchEnvelope("O1-C29", "atomic-terminal", true) })),
      bridge("o1-c29.atomic-replay", "invoke_local", args({ envelope: batchEnvelope("O1-C29", "atomic-terminal", true) })),
      harness("o1-c29.crash-during-atomic", "restart_component", args({
        componentId: "bridge_simulator",
        preserveState: true,
        crashWindow: "after_dispatch_before_terminal",
      })),
      bridge("o1-c29.atomic-recover", "invoke_local", args({ envelope: batchEnvelope("O1-C29", "atomic-indeterminate", true) })),
    ],
    requiredHarnessCapabilities: ["batch_crash_window", "fixture_request_execution_count", "gateway_hold_ledger"],
  },
  {
    caseId: "O1-C30",
    controls: [
      ...sessionSetup("O1-C30"),
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
      ].map((vector) => harness(`o1-c30.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c30.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: ["rfc8785_vector_generation", "raw_binding_frame", "pre_dispatch_count_capture"],
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
    controls: [
      ...sessionSetup("O1-C32"),
      ...[
        "base64_alphabet",
        "base64_padding",
        "stream_identity",
        "stream_indexing",
        "decoded_limit",
        "reconstruction_size",
        "content_digest",
      ].map((vector) => harness(`o1-c32.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c32.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: ["chunk_vector_generation", "raw_binding_frame", "decoded_digest_verification"],
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
      ...[
        "max_safe_seq",
        "unsafe_two_pow_53",
        "no_wrap_renewal",
        "duplicate_seq",
        "gap_seq",
      ].map((vector) => harness(`o1-c35.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c35.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: ["raw_binding_frame", "sequence_snapshot", "session_renewal_capture"],
  },
  {
    caseId: "O1-C36",
    controls: [
      ...sessionSetup("O1-C36"),
      gateway("o1-c36.opening-wss", "enqueue_opening_fault", args({
        rule: { binding: "wss", status: 503, retryAfter: "1", remaining: 1 },
      })),
      gateway("o1-c36.opening-sse", "enqueue_opening_fault", args({
        rule: { binding: "http_sse", status: 503, retryAfter: "1", remaining: 1 },
      })),
      harness("o1-c36.restart-bridge-for-other-binding", "restart_component", args({
        componentId: "bridge_simulator",
        preserveState: true,
      })),
      bridge("o1-c36.open-other-binding", "open_transport", byBinding(
        { kind: "streamable_http_sse", endpointPolicy: "loopback_test_readiness", deviceToken: "{{case.device_token}}", fallbackUrl: "{{gateway.ready.http_connection_url}}", hello: hello("O1-C36", "other-binding") },
        { kind: "wss", endpointPolicy: "loopback_test_readiness", deviceToken: "{{case.device_token}}", wssUrl: "{{gateway.ready.ws_url}}", hello: hello("O1-C36", "other-binding") },
      )),
      gateway("o1-c36.buffer-sse", "set_sse_buffering", args({
        connection_id: "{{case.sse_connection_id}}",
        enabled: true,
      })),
      gateway("o1-c36.unbuffer-sse", "set_sse_buffering", args({
        connection_id: "{{case.sse_connection_id}}",
        enabled: false,
      })),
      gateway("o1-c36.flush", "flush_held", args({ connection_id: "{{case.sse_connection_id}}" })),
    ],
    requiredHarnessCapabilities: ["component_restart_with_state", "binding_parity_snapshot", "opening_error_capture", "proxy_buffering_control"],
  },
  {
    caseId: "O1-C37",
    controls: [
      ...sessionSetup("O1-C37"),
      ...["bridge_shutdown", "session_replaced", "operator_requested"].map((reason) => bridge(
        `o1-c37.${reason}.register`,
        "session_register",
        args({
          probeIndex: 0,
          userHint: "conformance-user",
          hostname: "conformance-host",
          fingerprint: FINGERPRINT,
          bridgeVersion: "0.0.0",
        }),
        "setup",
      )),
      harness("o1-c37.await-four-sessions", "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions",
        operator: "count_equals",
        expected: 4,
        timeoutMs: 5_000,
      }), "setup"),
      ...[
        "revit_exited",
        "bridge_shutdown",
        "session_replaced",
        "operator_requested",
      ].flatMap((reason) => [
        gateway(`o1-c37.${reason}.dispatch`, "dispatch_invoke", args({ request: `{{vectors.c37.${reason}.possibly_dispatched_mutation}}` })),
        bridge(`o1-c37.${reason}.unregister`, "session_unregister", args({
          rsid: `{{case.c37.${reason}.rsid}}`,
          reason,
        })),
        bridge(`o1-c37.${reason}.resume`, "session_resume", args({ rsid: `{{case.c37.${reason}.rsid}}` })),
        gateway(`o1-c37.${reason}.new-dispatch`, "dispatch_invoke", args({ request: `{{vectors.c37.${reason}.post_unregister_invoke}}` })),
      ]),
    ],
    requiredHarnessCapabilities: ["four_isolated_registered_sessions", "resume_fault_capture", "journal_snapshot"],
  },
  {
    caseId: "O1-C38",
    controls: [
      ...sessionSetup("O1-C38"),
      fixture("o1-c38.valid-guarded", "plan_fault", args({
        requestId: "{{vectors.c38.guarded.steps.0.id}}",
        fault: { injectedOutcome: { state: "guarded", guardedReason: "operator_confirmation_required" } },
      })),
      bridge("o1-c38.first-delivery", "invoke_local", args({ envelope: batchEnvelope("O1-C38", "guarded", false) })),
      harness("o1-c38.missing-reason", "send_binding_frame", args({ frame: "{{vectors.c38.guarded_without_reason}}" })),
    ],
    requiredHarnessCapabilities: ["fixture_request_execution_count", "raw_binding_frame", "batch_terminal_capture"],
  },
  {
    caseId: "O1-C39",
    controls: [
      ...sessionSetup("O1-C39"),
      gateway("o1-c39.valid-recovery", "dispatch_payload_recovery", args({ request: "{{vectors.c39.valid_recovery}}" })),
      ...[
        "nonreplay",
        "missing_digest",
        "inline_result",
      ].map((vector) => harness(`o1-c39.${vector}`, "send_binding_frame", args({
        frame: `{{vectors.c39.${vector}}}`,
      }))),
    ],
    requiredHarnessCapabilities: ["payload_omission_vectors", "raw_binding_frame", "audited_recovery_capture"],
  },
  {
    caseId: "O1-C40",
    controls: [
      ...sessionSetup("O1-C40"),
      ...[
        "raw_path",
        "traversal_path",
        "reparse_path",
        "valid_multifile",
        "retransmission",
        "invalid_member",
      ].map((vector) => bridge(`o1-c40.${vector}`, "invoke_local", args({
        envelope: envelope("O1-C40", vector, {
          method: "fixture_multi_file_output",
          params: `{{vectors.c40.${vector}.params}}`,
        }),
      }))),
    ],
    requiredHarnessCapabilities: ["artifact_spool_inspection", "chunk_wire_capture", "reparse_point_fixture", "fixture_request_execution_count"],
  },
];

const OBSERVATION_POINTERS: Readonly<Record<ProcessObservationRecord["kind"], readonly string[]>> = {
  control_result: ["/request", "/response", "/requestBytes", "/responseBytes"],
  wire_event: ["/direction", "/binding", "/serialized", "/frame", "/atMonotonicMs"],
  gateway_snapshot: ["/sessions", "/mutationHolds", "/runtime"],
  bridge_snapshot: [
    "/invocations",
    "/holds",
    "/durabilityEvents",
    "/sessions",
    "/sequences",
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
      sourceStepIds: [`${prefix}.isolated-stack`],
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
    harness(`${definition.caseId.toLowerCase()}.isolated-stack`, "restart_case_stack", args({
      caseId: definition.caseId,
      binding: "{{binding}}",
      preserveState: false,
      requireExactExecutionPlanIdentity: true,
    }), "setup"),
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
