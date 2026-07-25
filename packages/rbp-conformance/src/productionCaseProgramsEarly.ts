import {
  assertValidCaseControlStepSemantics,
  caseProgram,
  type BindingArguments,
  type BridgeControlAction,
  type CaseControlStep,
  type ConformanceCaseProgram,
  type FixtureControlAction,
  type GatewayControlAction,
  type HarnessAction,
  type StepCaptureMetadata,
} from "./casePrograms.js";
import {
  EARLY_PRODUCTION_CASES,
  type EarlyProductionCase,
} from "./productionCaseSeedsEarly.js";

const FINGERPRINT = `sha256:${"0".repeat(64)}`;

function args(common: Readonly<Record<string, unknown>> = {}): BindingArguments {
  return { common };
}

function byBinding(
  wss: Readonly<Record<string, unknown>>,
  streamableHttpSse: Readonly<Record<string, unknown>>,
): BindingArguments {
  return { wss, streamable_http_sse: streamableHttpSse };
}

function gateway(
  stepId: string,
  action: GatewayControlAction,
  actionArguments: BindingArguments = args(),
  phase: CaseControlStep["phase"] = "stimulus",
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
    parentTimeoutMs: 30_000,
  };
}

function bridge(
  stepId: string,
  action: BridgeControlAction,
  actionArguments: BindingArguments = args(),
  phase: CaseControlStep["phase"] = "stimulus",
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
    parentTimeoutMs: 30_000,
  };
}

function fixture(
  stepId: string,
  action: FixtureControlAction,
  actionArguments: BindingArguments = args(),
  phase: CaseControlStep["phase"] = "stimulus",
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
    parentTimeoutMs: 30_000,
  };
}

function harness(
  stepId: string,
  action: HarnessAction,
  actionArguments: BindingArguments = args(),
  phase: CaseControlStep["phase"] = "stimulus",
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
    parentTimeoutMs: 30_000,
  };
}

function captures(
  step: CaseControlStep,
  values: StepCaptureMetadata[],
): CaseControlStep {
  return { ...step, captures: values };
}

function expectedControlError(
  step: CaseControlStep,
  code: string,
  messageIncludes?: string,
): CaseControlStep {
  return {
    ...step,
    expectedOutcome: {
      kind: "control_error",
      code,
      ...(messageIncludes === undefined ? {} : { messageIncludes }),
    },
  };
}

function hello(caseId: string, suffix = "initial"): Record<string, unknown> {
  return {
    id: `{{ids.${caseId}.hello-${suffix}.envelopeId}}`,
    ts: "{{clock.iso}}",
    bridgeVersion: "0.0.0",
    deviceId: "{{case.device_id}}",
    hostname: "conformance-host",
    os: "Windows conformance",
    fingerprint: FINGERPRINT,
  };
}

function rawHello(caseId: string): Record<string, unknown> {
  return {
    type: "hello",
    id: `{{ids.${caseId}.hello-initial.envelopeId}}`,
    ts: "{{clock.iso}}",
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "transport_streamable_http",
      ],
      bridge_version: "early-production-driver",
      device_id: "{{case.device_id}}",
      machine: {
        hostname: "conformance-host",
        os: "Windows conformance",
      },
      addin_versions: ["0.0.0"],
    },
  };
}

function sessionSetup(
  caseId: EarlyProductionCase,
  options: {
    discovery?: Readonly<Record<string, unknown>>;
    primaryProbeIndex?: unknown;
    clockStartMs?: unknown;
  } = {},
): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  const discovery = options.discovery ?? {
    host: "{{fixture.ready.host}}",
    port: "{{fixture.ready.port}}",
    probeTimeoutMs: 1_000,
  };
  const clock = options.clockStartMs === undefined
    ? {}
    : { clockStartMs: options.clockStartMs };
  return [
    bridge(`${prefix}.discover`, "discover_fixture", args(discovery), "setup"),
    captures(
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
          ...clock,
        },
        {
          kind: "streamable_http_sse",
          endpointPolicy: "loopback_test_readiness",
          deviceToken: "{{case.device_token}}",
          fallbackUrl: "{{gateway.ready.http_connection_url}}",
          hello: hello(caseId),
          ...clock,
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
      probeIndex: options.primaryProbeIndex ?? 0,
      userHint: "conformance-user",
      hostname: "conformance-host",
      fingerprint: FINGERPRINT,
      bridgeVersion: "0.0.0",
    }), "setup"),
    captures(
      harness(`${prefix}.await-register`, "await_condition", args({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions/0/rsid",
        operator: "exists",
        timeoutMs: 5_000,
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
    harness(`${prefix}.await-initial-context`, "await_condition", args({
      source: "gateway.compact_snapshot",
      jsonPointer: "/sessions/{{case.rsid}}/sequence/lastRxSeq",
      operator: "crosses",
      expected: 1,
      timeoutMs: 5_000,
    }), "setup"),
  ];
}

function invocationRef(caseId: EarlyProductionCase, suffix: string): string {
  return `{{ids.${caseId}.${suffix}.invocationId}}`;
}

function invokePayload(
  caseId: EarlyProductionCase,
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

function invokeEnvelope(
  caseId: EarlyProductionCase,
  suffix: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    v: 1,
    type: "invoke",
    id: `{{ids.${caseId}.${suffix}.envelopeId}}`,
    ts: "{{clock.iso}}",
    rsid: "{{case.rsid}}",
    seq: "{{case.next_seq}}",
    ack: "{{case.last_ack}}",
    payload: invokePayload(caseId, suffix, overrides),
  };
}

function dispatch(
  caseId: EarlyProductionCase,
  suffix: string,
  rsid: unknown = "{{case.rsid}}",
  overrides: Readonly<Record<string, unknown>> = {},
): CaseControlStep {
  return gateway(`${caseId.toLowerCase()}.${suffix}`, "dispatch_invoke", args({
    request: {
      rsid,
      payload: invokePayload(caseId, suffix, overrides),
    },
  }));
}

function terminalAwait(
  caseId: EarlyProductionCase,
  suffix: string,
  rsid: string,
  stepSuffix = `await-${suffix}`,
): CaseControlStep {
  return harness(`${caseId.toLowerCase()}.${stepSuffix}`, "await_condition", args({
    source: "gateway.compact_snapshot",
    jsonPointer:
      `/sessions/${rsid}/terminalOutcomes/{{ids.${caseId}.${suffix}.invocationId}}/classification`,
    operator: "exists",
    timeoutMs: 10_000,
  }), "observation");
}

function controlsFor(caseId: EarlyProductionCase): CaseControlStep[] {
  switch (caseId) {
    case "O1-C02":
      return [
        gateway("o1-c02.version-opening-fault", "enqueue_opening_fault", byBinding(
          { rule: { binding: "wss", status: 426, remaining: 1 } },
          { rule: { binding: "http_sse", status: 426, remaining: 1 } },
        ), "setup"),
        harness("o1-c02.version-probe", "send_binding_frame", args({
          credential: "{{case.device_token}}",
          frame: rawHello(caseId),
          targetIsOpeningFrame: true,
        })),
      ];
    case "O1-C03":
      return [
        gateway("o1-c03.revoke-token", "set_auth_status", args({
          token: "{{case.device_token}}",
          status: "revoked",
        }), "setup"),
        harness("o1-c03.revoked-probe", "send_binding_frame", args({
          credential: "{{case.device_token}}",
          frame: rawHello(caseId),
          targetIsOpeningFrame: true,
        })),
      ];
    case "O1-C04":
      return [
        captures(
          harness("o1-c04.spawn-extra-fixture", "spawn_fixture_bind_probe", args({
            mode: "fixture_session",
          }), "setup"),
          [
            { name: "case.discovery_first_port", source: "result", jsonPointer: "/firstPort" },
            { name: "case.discovery_last_port", source: "result", jsonPointer: "/lastPort" },
            { name: "case.primary_probe_index", source: "result", jsonPointer: "/primaryProbeIndex" },
            { name: "case.auxiliary_probe_index", source: "result", jsonPointer: "/auxiliaryProbeIndex" },
          ],
        ),
        bridge("o1-c04.bounded-discovery", "discover_fixture", args({
          host: "127.0.0.1",
          firstPort: "{{case.discovery_first_port}}",
          lastPort: "{{case.discovery_last_port}}",
          probeTimeoutMs: 1_000,
        })),
      ];
    case "O1-C06":
      return [
        ...sessionSetup(caseId, { clockStartMs: "{{clock.base_ms}}" }),
        gateway("o1-c06.drop-heartbeat-ack", "enqueue_frame_fault", byBinding(
          {
            rule: {
              direction: "gateway_to_bridge",
              action: "drop",
              binding: "wss",
              messageType: "heartbeat_ack",
              remaining: 8,
            },
          },
          {
            rule: {
              direction: "gateway_to_bridge",
              action: "drop",
              binding: "http_sse",
              messageType: "heartbeat_ack",
              remaining: 8,
            },
          },
        )),
        gateway("o1-c06.clock-35s", "set_clock", args({ now_ms: "{{clock.at_35s_ms}}" })),
        bridge("o1-c06.tick-35s", "tick", args({ nowMs: "{{clock.at_35s_ms}}" })),
        gateway("o1-c06.clock-65s", "set_clock", args({ now_ms: "{{clock.at_65s_ms}}" })),
        bridge("o1-c06.tick-65s", "tick", args({ nowMs: "{{clock.at_65s_ms}}" })),
        gateway("o1-c06.sweep", "liveness_sweep"),
        harness("o1-c06.await-reconnect", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/peer/connectionId",
          operator: "not_equals",
          expected: "{{case.connection_id}}",
          timeoutMs: 10_000,
        }), "observation"),
      ];
    case "O1-C07":
      return [
        ...sessionSetup(caseId),
        gateway("o1-c07.drop-downlink", "enqueue_frame_fault", byBinding(
          {
            rule: {
              direction: "gateway_to_bridge",
              action: "drop",
              binding: "wss",
              messageType: "invoke",
              remaining: 1,
            },
          },
          {
            rule: {
              direction: "gateway_to_bridge",
              action: "drop",
              binding: "http_sse",
              messageType: "invoke",
              remaining: 1,
            },
          },
        )),
        dispatch(caseId, "retransmit"),
        gateway("o1-c07.drop-uplink", "enqueue_frame_fault", byBinding(
          {
            rule: {
              direction: "bridge_to_gateway",
              action: "drop",
              binding: "wss",
              messageType: "doc_context_update",
              remaining: 1,
            },
          },
          {
            rule: {
              direction: "bridge_to_gateway",
              action: "drop",
              binding: "http_sse",
              messageType: "doc_context_update",
              remaining: 1,
            },
          },
        )),
        bridge("o1-c07.poll-context", "poll_document_context", args({
          rsid: "{{case.rsid}}",
          force: true,
        })),
        bridge("o1-c07.flush-uplink", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
        captures(
          harness("o1-c07.await-durable-uplink", "await_condition", args({
            source: "bridge.snapshot_evidence",
            jsonPointer: "/sequences/0/outbox",
            operator: "minimum_count",
            expected: 1,
            timeoutMs: 5_000,
          })),
          [{
            name: "case.c07_pre_restart_outbox",
            source: "result",
            jsonPointer: "/snapshot/sequences/0/outbox",
          }],
        ),
        captures(
          harness("o1-c07.restart-gateway", "restart_component", args({
            componentId: "gateway_stub",
            preserveState: true,
          })),
          [
            { name: "gateway.restarted.ws_url", source: "result", jsonPointer: "/readiness/ws_url" },
            {
              name: "gateway.restarted.http_connection_url",
              source: "result",
              jsonPointer: "/readiness/http_connection_url",
            },
            {
              name: "gateway.restarted.ca_certificate_path",
              source: "result",
              jsonPointer: "/readiness/tlsTrust/caCertificatePath",
            },
            {
              name: "gateway.restarted.ca_certificate_sha256",
              source: "result",
              jsonPointer: "/readiness/tlsTrust/caCertificateSha256",
            },
            {
              name: "gateway.restarted.server_certificate_sha256",
              source: "result",
              jsonPointer: "/readiness/tlsTrust/serverCertificateSha256",
            },
          ],
        ),
        bridge("o1-c07.restart-bridge", "restart_simulator"),
        captures(
          bridge("o1-c07.reopen", "open_transport", byBinding(
            {
              kind: "wss",
              endpointPolicy: "loopback_test_tls",
              deviceToken: "{{case.device_token}}",
              wssUrl: "{{gateway.restarted.ws_url}}",
              tlsTrust: {
                caCertificatePath: "{{gateway.restarted.ca_certificate_path}}",
                caCertificateSha256: "{{gateway.restarted.ca_certificate_sha256}}",
                serverCertificateSha256: "{{gateway.restarted.server_certificate_sha256}}",
              },
              hello: hello(caseId, "reconnect"),
            },
            {
              kind: "streamable_http_sse",
              endpointPolicy: "loopback_test_readiness",
              deviceToken: "{{case.device_token}}",
              fallbackUrl: "{{gateway.restarted.http_connection_url}}",
              hello: hello(caseId, "reconnect"),
            },
          )),
          [{
            name: "case.reconnected_connection_id",
            source: "result",
            jsonPointer: "/connectionId",
          }],
        ),
        bridge("o1-c07.restart-run-loop", "start_run_loop"),
        harness("o1-c07.await-bridge-retransmit", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/invocations/0/state",
          operator: "equals",
          expected: "completed",
          timeoutMs: 10_000,
        }), "observation"),
        bridge("o1-c07.flush-terminal", "flush_outbound", args({
          rsid: "{{case.rsid}}",
        })),
        harness("o1-c07.await-retransmit", "await_condition", args({
          source: "gateway.compact_snapshot",
          jsonPointer: `/sessions/{{case.rsid}}/inFlight/correlationId`,
          operator: "exists",
          timeoutMs: 10_000,
        }), "observation"),
      ];
    case "O1-C08":
      return [
        ...sessionSetup(caseId),
        bridge("o1-c08.first", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "terminal-replay"),
        })),
        bridge("o1-c08.restart", "restart_simulator"),
        bridge("o1-c08.redeliver", "invoke_local", args({
          envelope: {
            ...invokeEnvelope(caseId, "terminal-replay"),
            id: "{{ids.O1-C08.terminal-replay.redeliveryEnvelopeId}}",
            seq: 2,
          },
        })),
      ];
    case "O1-C09":
      return [
        ...sessionSetup(caseId),
        bridge("o1-c09.first", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "mutation-indeterminate", {
            method: "send_code_to_revit",
            mutating: true,
            mutation_scope: { kind: "document", document_id: "model-a" },
          }),
          crashAt: "after_executing_before_addin_write",
        })),
        bridge("o1-c09.restart", "restart_simulator"),
        bridge("o1-c09.redeliver", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "mutation-indeterminate", {
            method: "send_code_to_revit",
            mutating: true,
            mutation_scope: { kind: "document", document_id: "model-a" },
          }),
        })),
      ];
    case "O1-C10":
      return [
        ...sessionSetup(caseId),
        bridge("o1-c10.first", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "read-indeterminate"),
          crashAt: "after_addin_response_before_terminal",
        })),
        bridge("o1-c10.restart", "restart_simulator"),
        bridge("o1-c10.redeliver", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "read-indeterminate"),
        })),
      ];
    case "O1-C11":
      return [
        ...sessionSetup(caseId),
        bridge("o1-c11.original", "invoke_local", args({
          envelope: invokeEnvelope(caseId, "digest-mismatch", {
            params: { canonical: "value-a" },
          }),
        })),
        bridge("o1-c11.digest-mismatch", "invoke_local", args({
          envelope: {
            ...invokeEnvelope(caseId, "digest-mismatch", {
              params: { canonical: "value-b" },
            }),
            id: "{{ids.O1-C11.digest-mismatch.redeliveryEnvelopeId}}",
            seq: 2,
          },
        })),
      ];
    case "O1-C12":
      return [
        captures(
          harness("o1-c12.spawn-extra-fixture", "spawn_fixture_bind_probe", args({
            mode: "fixture_session",
          }), "setup"),
          [
            { name: "case.discovery_first_port", source: "result", jsonPointer: "/firstPort" },
            { name: "case.discovery_last_port", source: "result", jsonPointer: "/lastPort" },
            { name: "case.primary_probe_index", source: "result", jsonPointer: "/primaryProbeIndex" },
            { name: "case.auxiliary_probe_index", source: "result", jsonPointer: "/auxiliaryProbeIndex" },
          ],
        ),
        ...sessionSetup(caseId, {
          discovery: {
            host: "127.0.0.1",
            firstPort: "{{case.discovery_first_port}}",
            lastPort: "{{case.discovery_last_port}}",
            probeTimeoutMs: 1_000,
          },
          primaryProbeIndex: "{{case.primary_probe_index}}",
        }),
        bridge("o1-c12.register-second", "session_register", args({
          probeIndex: "{{case.auxiliary_probe_index}}",
          userHint: "conformance-user-2",
          hostname: "conformance-host",
          fingerprint: FINGERPRINT,
          bridgeVersion: "0.0.0",
        }), "setup"),
        captures(
          harness("o1-c12.await-second", "await_condition", args({
            source: "bridge.snapshot_evidence",
            jsonPointer: "/sessions",
            operator: "minimum_count",
            expected: 2,
            timeoutMs: 5_000,
          }), "setup"),
          [{ name: "case.second_rsid", source: "result", jsonPointer: "/dynamic/rsids/1" }],
        ),
        fixture("o1-c12.stall-first", "plan_fault", args({
          requestId: invocationRef(caseId, "first"),
          fault: { stall: true },
        })),
        dispatch(caseId, "first"),
        expectedControlError(
          dispatch(caseId, "same-rsid-second"),
          "gateway_control_http_500",
          "window",
        ),
        dispatch(caseId, "cross-rsid", "{{case.second_rsid}}"),
        terminalAwait(caseId, "cross-rsid", "{{case.second_rsid}}", "await-cross-rsid"),
        fixture("o1-c12.release-first", "release_stall", args({
          requestId: invocationRef(caseId, "first"),
        })),
        terminalAwait(caseId, "first", "{{case.rsid}}", "await-first"),
      ];
    case "O1-C13":
      return [
        ...sessionSetup(caseId),
        fixture("o1-c13.pre-invoke-fixture-snapshot", "snapshot_evidence", args(), "observation"),
        dispatch(caseId, "normal"),
        harness("o1-c13.await-bridge-terminal", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/invocations/0/terminalOutcomeDigest",
          operator: "exists",
          timeoutMs: 10_000,
        }), "observation"),
        harness("o1-c13.await-terminal-staged", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/durabilityEvents",
          operator: "minimum_count",
          expected: 8,
          timeoutMs: 10_000,
        }), "observation"),
        bridge("o1-c13.flush-terminal", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
        terminalAwait(caseId, "normal", "{{case.rsid}}"),
      ];
    case "O1-C14":
      return [
        ...sessionSetup(caseId),
        fixture("o1-c14.pre-failure-fixture-snapshot", "snapshot_evidence", args(), "observation"),
        fixture("o1-c14.plan-timeout", "plan_fault", args({
          requestId: invocationRef(caseId, "timeout"),
          fault: {
            jsonRpcError: {
              code: -32603,
              message: "fixture simulated Revit timeout",
            },
          },
        })),
        dispatch(caseId, "timeout", "{{case.rsid}}", { timeout_ms: 100 }),
        harness("o1-c14.await-bridge-terminal", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/invocations/0/terminalOutcomeDigest",
          operator: "exists",
          timeoutMs: 10_000,
        }), "observation"),
        harness("o1-c14.await-terminal-staged", "await_condition", args({
          source: "bridge.snapshot_evidence",
          jsonPointer: "/durabilityEvents",
          operator: "minimum_count",
          expected: 8,
          timeoutMs: 10_000,
        }), "observation"),
        bridge("o1-c14.flush-terminal", "flush_outbound", args({ rsid: "{{case.rsid}}" })),
        terminalAwait(caseId, "timeout", "{{case.rsid}}"),
      ];
  }
}

function refreshedObservations(
  program: ConformanceCaseProgram,
  steps: readonly CaseControlStep[],
): ConformanceCaseProgram["observations"] {
  return program.observations.map((requirement) => {
    const componentId = requirement.alias === "gateway.control"
      ? "gateway_stub"
      : requirement.alias === "bridge.control"
        ? "bridge_simulator"
        : requirement.alias === "fixture.control"
          ? "addin_loopback_fixture"
          : null;
    if (componentId === null) return structuredClone(requirement);
    return {
      ...structuredClone(requirement),
      sourceStepIds: steps
        .filter((step) => step.componentId === componentId)
        .map(({ stepId }) => stepId),
    };
  });
}

function startupStep(
  base: CaseControlStep,
  caseId: EarlyProductionCase,
): CaseControlStep {
  if (caseId !== "O1-C06") return structuredClone(base);
  const cloned = structuredClone(base);
  const common = { ...(cloned.arguments.common ?? {}) };
  common.startupOverrides = { clockStartMs: "{{clock.base_ms}}" };
  cloned.arguments = { ...cloned.arguments, common };
  return cloned;
}

function finalEvidenceBoundary(
  base: ConformanceCaseProgram,
  caseId: EarlyProductionCase,
): CaseControlStep[] {
  const prefix = caseId.toLowerCase();
  const startStepId = `${prefix}.gateway-snapshot`;
  const starts = base.steps
    .map(({ stepId }, index) => stepId === startStepId ? index : -1)
    .filter((index) => index >= 0);
  if (starts.length !== 1 || base.steps.at(-1)?.stepId !== `${prefix}.stack-stop`) {
    throw new Error(`${caseId} base program has an invalid final evidence boundary`);
  }
  return base.steps.slice(starts[0]).map((step) => structuredClone(step));
}

export function earlyProductionCaseProgram(caseId: string): ConformanceCaseProgram {
  if (!(EARLY_PRODUCTION_CASES as readonly string[]).includes(caseId)) {
    throw new Error(`early production program is not implemented: ${caseId}`);
  }
  const selected = caseId as EarlyProductionCase;
  const base = caseProgram(selected);
  const controls = controlsFor(selected);
  const steps = [
    startupStep(base.steps[0]!, selected),
    structuredClone(base.steps[1]!),
    ...controls,
    ...finalEvidenceBoundary(base, selected),
  ];
  for (const step of steps) assertValidCaseControlStepSemantics(step);
  return {
    ...base,
    steps,
    observations: refreshedObservations(base, steps),
    requiredHarnessCapabilities: [
      ...new Set([
        ...base.requiredHarnessCapabilities,
        "real_supervised_processes",
        "explicit_canonical_assertion_oracles",
      ]),
    ],
  };
}
