import { createHash } from "node:crypto";

import {
  HttpSseGatewayBinding,
  WssGatewayBinding,
  type GatewayBinding,
} from "../../bridge-simulator/dist/index.js";
import {
  createReceivedJournalRecord,
  dataEnvelopeImmutableDigest,
  type DataEnvelopeSnapshot,
  type HelloEnvelope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import type {
  GatewayExecutorRequest,
  GatewayJsonObject,
} from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import type { GatewayRecoveryPendingDispatch } from "./recoveryAuthority.js";
import { createProductionRbpIngressHost } from "./rbpIngress.js";
import {
  createFailClosedPorts,
  startGatewayServer,
  type GatewayServerHandle,
} from "./server.js";
import { createRestartableTestStore } from "./testAdapters.js";
import type { GatewayConfig } from "./config.js";
import { E5_TOOL_BINDINGS } from "./toolBindings.js";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["transport_streamable_http", "partial_progress"],
      bridge_version: "gw12-test",
      device_id: "device-gw12",
      machine: { hostname: "gw12-test", os: "windows" },
      addin_versions: ["gw12-test"],
    },
  };
}

function registration(): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: "local-gw12",
      user_hint: { name: "fixture" },
      machine: {
        hostname: "gw12-test",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2025", build: "fixture", pid: 1234 },
      addin_version: "gw12-test",
      result_contract_version: 1,
      session_capabilities: ["transport_streamable_http", "partial_progress"],
      bridge_version: "gw12-test",
      documents: [],
      port: 48884,
    },
  };
}

function identity(
  grantedSessionCapabilities: readonly string[] = [
    "transport_streamable_http",
    "partial_progress",
  ],
): IdentityPort {
  const tokenDigest = `sha256:${createHash("sha256").update("device-token").digest("hex")}` as const;
  return {
    kind: "oidc" as const,
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside this fixture",
      };
    },
    async authenticateDevice(input) {
      if (input.deviceToken !== "device-token") {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "unknown device token",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: "tenant-gw12",
          userId: "user-gw12",
          deviceId: "device-gw12",
          seatId: "seat-gw12",
        },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedSessionCapabilities,
        deviceTokenDigest: tokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function request(
  rsid: string,
  options: {
    readonly method?: string;
    readonly toolName?: string;
    readonly mutating?: boolean;
  } = {},
): GatewayExecutorRequest {
  const args: GatewayJsonObject = { probe: "gw12" };
  const invocationId = id();
  const method = options.method ?? "get_revit_mcp_status";
  const toolName = options.toolName ?? "core.get_revit_status";
  const mutating = options.mutating ?? false;
  return {
    toolName,
    toolVersion: "1.0.0",
    executorMethod: method,
    policyClass: "auto",
    mutationScopePolicy: mutating ? "session" : "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: "tenant-gw12:user-gw12",
      actor: { tenantId: "tenant-gw12", userId: "user-gw12", role: "user" },
      gatewaySessionId: "gateway-session-gw12",
      oauthClientId: "oauth-client-gw12",
      mcpSessionId: "mcp-session-gw12",
      rsid,
      toolName,
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: mutating ? "session" : "none",
      mutating,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "doc-gw12" },
      paramsDigest: `sha256:${"1".repeat(64)}`,
      mutationScope: mutating ? { kind: "session" } : null,
      startedAtMs: Date.now(),
    },
  };
}

function terminal(
  rsid: string,
  invocationId: string,
  seq: number,
  ack: number,
): Extract<RbpEnvelope, { type: "result" }> {
  return {
    v: 1,
    type: "result",
    id: id(),
    rsid,
    seq,
    ack,
    ts: new Date().toISOString(),
    payload: {
      kind: "invocation",
      invocation_id: invocationId,
      status: "completed",
      result: { success: true, source: "gw12-fixture" },
      metrics: {
        execute_ms: 1,
        request_bytes: 1,
        response_bytes: 1,
        framing: "length-prefixed",
      },
    },
  };
}

async function next(binding: GatewayBinding): Promise<RbpEnvelope> {
  const result = await binding.messages()[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("binding closed before the expected frame");
  return result.value;
}

const config: GatewayConfig = {
  nodeEnv: "development",
  logLevel: "fatal",
  http: { bindHost: "127.0.0.1", port: 0 },
  publicUrl: "http://127.0.0.1",
  objectStore: { driver: "fs", root: null },
  credentialsPresent: { databaseUrl: true },
  ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
};

describe("GW-12 production RBP ingress", () => {
  const handles: GatewayServerHandle[] = [];
  const bindings: GatewayBinding[] = [];

  afterEach(async () => {
    await Promise.allSettled(bindings.splice(0).map(async (binding) => binding.close()));
    await Promise.allSettled(handles.splice(0).map(async (handle) => handle.close()));
  });

  for (const kind of ["wss", "http_sse"] as const) {
    it(`routes register and dispatch through the shared ${kind} authority`, async () => {
      const restartable = createRestartableTestStore();
      const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
      const ingress = createProductionRbpIngressHost({ authority });
      const server = await startGatewayServer({
        config,
        ports: { ...createFailClosedPorts(), identity: identity(), protocolStore: restartable.store, rbpIngress: ingress },
      });
      handles.push(server);
      const binding: GatewayBinding =
        kind === "wss"
          ? new WssGatewayBinding({
              baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
              deviceToken: "device-token",
              endpointPolicy: "loopback_test_readiness",
            })
          : new HttpSseGatewayBinding({
              baseUrl: `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
              deviceToken: "device-token",
              endpointPolicy: "loopback_test_readiness",
            });
      bindings.push(binding);

      const ack = await binding.open(hello());
      expect(ack.payload.connection_id).toBe(binding.connectionId);
      expect(ack.payload.granted_capabilities).toContain("transport_streamable_http");
      if (kind === "wss" && (binding as WssGatewayBinding).closeInfo !== null) {
        throw new Error(
          `WSS closed after hello: ${JSON.stringify((binding as WssGatewayBinding).closeInfo)}`,
        );
      }
      await binding.send(registration());
      const registered = (await next(binding)) as SessionRegisteredEnvelope;

      const executor = authority.createExecutor();
      const invocation = request(registered.payload.rsid);
      const outcomePromise = executor.execute(invocation);
      const invoke = await next(binding);
      expect(invoke).toMatchObject({
        type: "invoke",
        rsid: registered.payload.rsid,
        payload: { method: "get_revit_mcp_status" },
      });
      await binding.send(
        terminal(
          registered.payload.rsid,
          invocation.context.invocationId,
          1,
          (invoke as Extract<RbpEnvelope, { type: "invoke" }>).seq,
        ),
      );
      await expect(outcomePromise).resolves.toEqual({
        state: "completed",
        result: { success: true, source: "gw12-fixture" },
      });
      await expect(
        binding.sendChunkConformanceFrame!({
          v: 1,
          type: "partial",
          id: id(),
          rsid: registered.payload.rsid,
          seq: 2,
          ts: new Date().toISOString(),
          payload: { kind: "chunk", invocation_id: "missing-required-fields" },
        }),
      ).resolves.toMatchObject({
        accepted: false,
        faultClass: "protocol",
        binding: kind === "wss" ? "wss" : "streamable_http_sse",
      });
    });
  }

  it("refuses HTTP/SSE unless the fallback capability was provisioned and granted", async () => {
    const restartable = createRestartableTestStore();
    const noFallbackIdentity = identity([]);
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      noFallbackIdentity,
    );
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: noFallbackIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const response = await fetch(
      `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello()),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      fault_class: "unsupported",
    });
  });

  it("routes every bridge-bound runtime method and keeps discovery internal", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;
    const allRuntimeTools = E5_TOOL_BINDINGS.filter(
      (row) => row.module === "runtime",
    );
    expect(allRuntimeTools).toHaveLength(35);
    expect(
      allRuntimeTools.find((row) => row.tool === "list_revit_instances"),
    ).toMatchObject({ executor: "internal_mcp" });
    const runtimeTools = allRuntimeTools.filter(
      (row) => row.tool !== "list_revit_instances",
    );
    expect(runtimeTools).toHaveLength(34);

    let bridgeSequence = 0;
    for (const row of runtimeTools) {
      const invocation = request(registered.payload.rsid, {
        method: row.tool,
        toolName: row.target,
      });
      const pending = authority.createExecutor().execute(invocation);
      while (sent.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const invoke = sent.shift() as Extract<RbpEnvelope, { type: "invoke" }>;
      expect(invoke.payload.method).toBe(row.tool);
      bridgeSequence += 1;
      await authority.receive(
        opening.connectionId,
        terminal(
          registered.payload.rsid,
          invocation.context.invocationId,
          bridgeSequence,
          invoke.seq,
        ),
      );
      await expect(pending).resolves.toMatchObject({ state: "completed" });
    }
    await authority.close();
  });

  it("exposes only committed bridge acceptance and terminal journal evidence", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;
    const invocation = request(registered.payload.rsid, { mutating: true });
    const executor = authority.createExecutor();
    const draft = executor.buildMutationDispatch!(invocation);
    const envelope = draft.envelope as Extract<RbpEnvelope, { type: "invoke" }>;
    const journal = createReceivedJournalRecord(draft.expected.bindings[0]!);
    const envelopeDigest = dataEnvelopeImmutableDigest(
      envelope as DataEnvelopeSnapshot,
    );
    const prepared: GatewayRecoveryPendingDispatch = {
      kind: "mutation",
      envelope,
      envelopeDigest,
      gatewaySequence: envelope.seq,
      sessionBindingId: draft.sessionBindingId,
      preparedConnectionId: draft.connectionId,
      authorizedSessionVersion: 1,
      requiredSessionCapabilities: [],
      mutationEntries: [
        {
          invocationId: invocation.context.invocationId,
          idempotencyKey: invocation.context.idempotencyKey,
          mutationScope: { kind: "session" },
          journalBindingDigest: journal.bindingDigest,
        },
      ],
      journalRecords: [journal],
      journalAttestation: null,
      batchTerminal: null,
      recoveryHoldIds: [],
      recoveryClearances: [],
      verificationHoldId: null,
      originRedelivery: false,
      bridgeAcceptance: null,
      preparedAtMs: Date.now(),
    };
    const pending = executor.executePreparedMutation!(invocation, prepared);
    while (sent.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const dispatched = sent.shift() as Extract<RbpEnvelope, { type: "invoke" }>;
    await authority.receive(
      opening.connectionId,
      terminal(
        registered.payload.rsid,
        invocation.context.invocationId,
        1,
        dispatched.seq,
      ),
    );
    await expect(pending).resolves.toMatchObject({ state: "completed" });

    const lookup = await restartable.store.transact(
      { tenantId: "tenant-gw12" },
      async (tx) =>
        authority.inspectDispatch(tx, {
          rsid: registered.payload.rsid,
          sessionBindingId: draft.sessionBindingId,
          gatewaySequence: dispatched.seq,
          envelopeDigest,
          invocationBindings: [
            {
              idempotencyKey: invocation.context.idempotencyKey,
              bindingDigest: journal.bindingDigest,
            },
          ],
        }),
    );
    expect(lookup).toMatchObject({
      ok: true,
      value: {
        kind: "found",
        observation: {
          acceptance: { cumulativeAck: dispatched.seq },
          journal: { kind: "known_terminal" },
        },
      },
    });
    await authority.close();
  });

  it("uses the frozen heartbeat thresholds for degraded and disconnected dispatch", async () => {
    let nowMs = 0;
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      identity(),
      { clock: () => nowMs },
    );
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;

    nowMs = 35_000;
    await expect(authority.sweepLiveness()).resolves.toEqual([]);
    expect(() => authority.buildEnvelope(request(registered.payload.rsid))).not.toThrow();

    nowMs = 65_000;
    await expect(authority.sweepLiveness()).resolves.toEqual([
      registered.payload.rsid,
    ]);
    expect(() => authority.buildEnvelope(request(registered.payload.rsid))).toThrow(
      "registered rsid is not connected",
    );
    await authority.close();
  });

  it("resumes one active binding after restart and retransmits the durable outbox", async () => {
    const restartable = createRestartableTestStore();
    const sentBeforeRestart: RbpEnvelope[] = [];
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sentBeforeRestart.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sentBeforeRestart.at(-1) as SessionRegisteredEnvelope;
    const invocation = request(registered.payload.rsid, { mutating: true });
    const pending = authority.createExecutor().execute(invocation);
    while (!sentBeforeRestart.some((candidate) => candidate.type === "invoke")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const invoke = sentBeforeRestart.find(
      (candidate) => candidate.type === "invoke",
    ) as Extract<RbpEnvelope, { type: "invoke" }>;
    await authority.close();
    await expect(pending).resolves.toMatchObject({
      state: "failed",
      error: { code: "journal_indeterminate" },
    });

    const sentAfterRestart: RbpEnvelope[] = [];
    const restarted = new GatewayBridgeSessionAuthority(restartable.restart(), identity());
    await restarted.open();
    const second = await restarted.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sentAfterRestart.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await restarted.receive(second.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: registered.payload.rsid,
        resume_token: registered.payload.resume_token,
        last_rx_seq: 0,
      },
    });
    expect(sentAfterRestart.map((candidate) => candidate.type)).toEqual([
      "resume_ack",
      "invoke",
    ]);
    expect(
      dataEnvelopeImmutableDigest(
        sentAfterRestart[1] as unknown as DataEnvelopeSnapshot,
      ),
    ).toBe(
      dataEnvelopeImmutableDigest(invoke as unknown as DataEnvelopeSnapshot),
    );
    await restarted.close();
  });
});
