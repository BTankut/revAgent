import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalizeJson,
  makeParamsDigest,
  type JsonValue,
  type DocContextUpdateEnvelope,
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
import {
  GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
  GATEWAY_RBP_SESSION_V2_NAMESPACE,
  GatewayBridgeSessionAuthority,
  GatewayRbpFault,
  TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER,
  type BridgeConnectionChannel,
  type ConformanceOriginResendPolicy,
  type GatewayRouteRebindAuditSnapshot,
} from "./bridgeSession.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  createEffectiveMcpRequestScopeV1,
  createGatewayDispatchProofAuthority,
} from "./invocationContext.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { ConformanceProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";
import { EncryptedProtectedObjectStore } from "./protectedObjectStore.js";
import { SqliteConformanceProtocolStore } from "./conformanceEphemeralAdapters.js";
import type { GatewayProtocolStore, StoreOutcome, StoreTransaction } from "./store.js";
import { createMemoryObjectStore, createRestartableTestStore } from "./testAdapters.js";

const TENANT_ID = "tenant-route";
const USER_ID = "user-route";
const DEVICE_ID = "device-route";
const MCP_SESSION_ID = "mcp-route";
const DEVICE_TOKEN = "device-token-route";

/** Exact owned shape of generated RouteRebindDocumentContext. */
interface RouteRebindDocumentContext {
  readonly documents: Array<{
    readonly document_id: string;
    readonly title: string;
    readonly path_digest: string | null;
    readonly is_workshared: boolean;
    readonly is_active: boolean;
  }>;
  readonly active_document: string | null;
  readonly active_view: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly level?: string | null;
  } | null;
  readonly discipline_hint?: string;
}

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

const normalizedDigest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalizeJson(value as JsonValue)).digest("hex")}`;

async function injectDurableD2Claim(
  fixture: ReturnType<typeof createRestartableTestStore>,
  rsid: string,
  originInvocationId: string,
): Promise<void> {
  const root = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE && row.key === rsid,
  );
  const marker = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE && row.key === rsid,
  );
  if (root === undefined || marker === undefined) throw new Error("normalized fixture session is missing");
  const nextRoot = structuredClone(root.value) as {
    rootVersion: number;
    sequence: Record<string, unknown>;
  };
  nextRoot.rootVersion += 1;
  nextRoot.sequence.d2ConformanceOriginResend = {
    version: 1,
    state: "claimed",
    originInvocationId,
    originEnvelopeDigest: `sha256:${"a".repeat(64)}`,
    originOuterSequence: 1,
    resendEnvelopeDigest: `sha256:${"b".repeat(64)}`,
    claimedAtMs: 1,
  };
  const nextMarker = {
    ...(marker.value as Record<string, unknown>),
    rootVersion: nextRoot.rootVersion,
    rootDigest: normalizedDigest(nextRoot),
  };
  const staged = await fixture.store.transact({ tenantId: TENANT_ID }, (tx) => {
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_V2_NAMESPACE,
      key: rsid,
      value: nextRoot as unknown as GatewayJsonObject,
      expect: { kind: "version", version: root.version },
    });
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
      key: rsid,
      value: nextMarker as GatewayJsonObject,
      expect: { kind: "version", version: marker.version },
    });
  });
  if (!staged.ok) throw new Error(staged.message);
}

async function mutateDurableRoute(
  fixture: ReturnType<typeof createRestartableTestStore>,
  rsid: string,
  mutate: (
    route: Record<string, unknown>,
    root: {
      binding: {
        sessionVersion: number;
        grantedCapabilities: string[];
      };
      lifecycle: {
        connectionLifecycle: { grantedCapabilities: string[] };
        liveDocumentRoute: Record<string, unknown> | null;
        routeRebindReceipt?: Record<string, unknown> | null;
        routeRebindFreshness?: unknown;
      };
    },
  ) => void,
): Promise<void> {
  const root = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE && row.key === rsid,
  );
  const marker = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE && row.key === rsid,
  );
  if (root === undefined || marker === undefined) throw new Error("normalized fixture session is missing");
  const nextRoot = structuredClone(root.value) as {
    rootVersion: number;
    lifecycle: {
      connectionLifecycle: { grantedCapabilities: string[] };
      liveDocumentRoute: Record<string, unknown> | null;
      routeRebindReceipt?: Record<string, unknown> | null;
      routeRebindFreshness?: unknown;
    };
    binding: {
      sessionVersion: number;
      grantedCapabilities: string[];
    };
  };
  const route = nextRoot.lifecycle.liveDocumentRoute;
  if (route === null) throw new Error("fixture route is missing");
  mutate(route, nextRoot);
  nextRoot.rootVersion += 1;
  const nextMarker = {
    ...(marker.value as Record<string, unknown>),
    rootVersion: nextRoot.rootVersion,
    rootDigest: normalizedDigest(nextRoot),
  };
  const staged = await fixture.store.transact({ tenantId: TENANT_ID }, (tx) => {
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_V2_NAMESPACE,
      key: rsid,
      value: nextRoot as unknown as GatewayJsonObject,
      expect: { kind: "version", version: root.version },
    });
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
      key: rsid,
      value: nextMarker as GatewayJsonObject,
      expect: { kind: "version", version: marker.version },
    });
  });
  if (!staged.ok) throw new Error(staged.message);
}

async function mutateDurableSessionGrant(
  fixture: ReturnType<typeof createRestartableTestStore>,
  rsid: string,
  mutate: (root: { binding: { grantedCapabilities: string[] } }) => void,
): Promise<void> {
  const root = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE && row.key === rsid,
  );
  const marker = fixture.snapshot().records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE && row.key === rsid,
  );
  if (root === undefined || marker === undefined) throw new Error("normalized fixture session is missing");
  const nextRoot = structuredClone(root.value) as {
    rootVersion: number;
    binding: { grantedCapabilities: string[] };
  };
  mutate(nextRoot);
  nextRoot.rootVersion += 1;
  const nextMarker = {
    ...(marker.value as Record<string, unknown>),
    rootVersion: nextRoot.rootVersion,
    rootDigest: normalizedDigest(nextRoot),
  };
  const staged = await fixture.store.transact({ tenantId: TENANT_ID }, (tx) => {
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_V2_NAMESPACE,
      key: rsid,
      value: nextRoot as unknown as GatewayJsonObject,
      expect: { kind: "version", version: root.version },
    });
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
      key: rsid,
      value: nextMarker as GatewayJsonObject,
      expect: { kind: "version", version: marker.version },
    });
  });
  if (!staged.ok) throw new Error(staged.message);
}

function identity(capabilities: {
  readonly connectionCapabilities?: readonly string[];
  readonly sessionCapabilities?: readonly string[];
} = {}): IdentityPort {
  const deviceTokenDigest = `sha256:${createHash("sha256")
    .update(DEVICE_TOKEN)
    .digest("hex")}` as const;
  return {
    kind: "fake" as const,
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside this fixture",
      };
    },
    async authenticateDevice(input) {
      if (input.deviceToken !== DEVICE_TOKEN) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "device identity is unavailable",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: TENANT_ID,
          userId: USER_ID,
          deviceId: DEVICE_ID,
          seatId: "seat-route",
        },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedConnectionCapabilities: capabilities.connectionCapabilities ?? [],
        grantedSessionCapabilities: capabilities.sessionCapabilities ?? ["partial_progress"],
        deviceTokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(capabilities: readonly string[] = ["partial_progress"]): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [...capabilities],
      bridge_version: "m4-route-test",
      device_id: DEVICE_ID,
      machine: { hostname: "petrucci", os: "windows" },
      addin_versions: ["m4-route-test"],
    },
  };
}

function registration(
  localSessionKey: string,
): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: localSessionKey,
      user_hint: { name: "fixture" },
      machine: {
        hostname: "petrucci",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2022", build: "fixture", pid: 4321 },
      addin_version: "m4-route-test",
      result_contract_version: 1,
      session_capabilities: ["partial_progress"],
      bridge_version: "m4-route-test",
      documents: [],
      port: 48884,
    },
  };
}

function document(documentId: string, isActive: boolean) {
  return {
    document_id: documentId,
    title: "M4 route fixture",
    path_digest: null,
    is_workshared: false,
    is_active: isActive,
  };
}

function contextUpdate(input: {
  readonly rsid: string;
  readonly seq: number;
  readonly activeDocument: string | null;
  readonly documents: readonly ReturnType<typeof document>[];
}): DocContextUpdateEnvelope {
  return {
    v: 1,
    type: "doc_context_update",
    id: id(),
    rsid: input.rsid,
    seq: input.seq,
    ts: new Date().toISOString(),
    payload: {
      documents: [...input.documents],
      active_document: input.activeDocument,
      active_view: null,
    },
  };
}

async function establishCurrentRoute(
  authority: GatewayBridgeSessionAuthority,
  connectionId: string,
  rsid: string,
  documentId = "document-carrier",
): Promise<void> {
  await authority.receive(connectionId, contextUpdate({
    rsid,
    seq: 1,
    activeDocument: documentId,
    documents: [document(documentId, true)],
  }));
}

interface TestChannel extends BridgeConnectionChannel {
  readonly frames: RbpEnvelope[];
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observingProtocolStore(
  backing: SqliteConformanceProtocolStore,
  callbackErrors: unknown[],
  outcomes: StoreOutcome<unknown>[],
): GatewayProtocolStore {
  return {
    kind: backing.kind,
    contractVersion: backing.contractVersion,
    startupCoordinator: backing.startupCoordinator,
    async open() { return await backing.open(); },
    async close() { return await backing.close(); },
    async transact<T>(
      scope: { readonly tenantId: string },
      fn: (tx: StoreTransaction) => Promise<T> | T,
    ): Promise<StoreOutcome<T>> {
      const outcome = await backing.transact(scope, async (tx) => {
        try {
          return await fn(tx) as T;
        } catch (error) {
          callbackErrors.push(error);
          throw error;
        }
      });
      outcomes.push(outcome as StoreOutcome<unknown>);
      return outcome;
    },
  };
}

function channel(): TestChannel {
  const frames: RbpEnvelope[] = [];
  return {
    frames,
    async send(serialized): Promise<void> {
      frames.push(JSON.parse(serialized) as RbpEnvelope);
    },
    async close(): Promise<void> {},
  };
}

function registeredFrame(channel: TestChannel): SessionRegisteredEnvelope {
  const found = [...channel.frames]
    .reverse()
    .find((frame): frame is SessionRegisteredEnvelope =>
      frame.type === "session_registered",
    );
  if (found === undefined) throw new Error("session_registered was not emitted");
  return found;
}

async function openConnection(
  authority: GatewayBridgeSessionAuthority,
  binding: "wss" | "http_sse" = "wss",
  capabilities: readonly string[] = ["partial_progress"],
): Promise<{ readonly connectionId: string; readonly channel: TestChannel }> {
  const openedChannel = channel();
  const opened = await authority.openConnection({
    deviceToken: DEVICE_TOKEN,
    binding,
    hello: hello(capabilities),
    channel: openedChannel,
  });
  return { connectionId: opened.connectionId, channel: openedChannel };
}

function resumeWithRouteProof(input: {
  readonly rsid: string;
  readonly resumeToken: string;
  readonly connectionId: string;
  readonly lastRxSeq?: number;
  readonly proofId?: string;
  readonly context?: RouteRebindDocumentContext;
  readonly sourceRevision?: number;
  readonly cacheIncarnationDigest?: string;
}): Extract<RbpEnvelope, { type: "session_resume" }> {
  const context: RouteRebindDocumentContext = input.context ?? {
    documents: [document("document-rebound", true)],
    active_document: "document-rebound",
    active_view: null,
  };
  return {
    v: 1,
    type: "session_resume",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      rsid: input.rsid,
      resume_token: input.resumeToken,
      last_rx_seq: input.lastRxSeq ?? 0,
      route_rebind_proof: {
        version: 1,
        connection_id: input.connectionId,
        proof_id: input.proofId ?? id(),
        context,
        context_digest: createHash("sha256")
          .update("revagent:doc-context-payload:v1\n", "utf8")
          .update(canonicalizeJson(routeRebindContextJson(context)), "utf8")
          .digest("hex"),
        freshness: {
          source_revision: input.sourceRevision ?? 1,
          cache_incarnation_digest: input.cacheIncarnationDigest ?? `sha256:${"c".repeat(64)}`,
        },
      },
    },
  };
}

function routeRebindContextJson(context: RouteRebindDocumentContext): JsonValue {
  return {
    documents: context.documents.map((entry) => ({
      document_id: entry.document_id,
      title: entry.title,
      path_digest: entry.path_digest,
      is_workshared: entry.is_workshared,
      is_active: entry.is_active,
    })),
    active_document: context.active_document,
    active_view: context.active_view === null
      ? null
      : {
          id: context.active_view.id,
          name: context.active_view.name,
          type: context.active_view.type,
          ...(context.active_view.level === undefined ? {} : { level: context.active_view.level }),
        },
    ...(context.discipline_hint === undefined ? {} : { discipline_hint: context.discipline_hint }),
  };
}

describe("C39 route-authority digest vectors", () => {
  it("locks the checkpoint and connection-digest domains to exact canonical vectors", () => {
    // These values are the shared Bridge/Gateway C39 fixture vector.  The
    // hardcoded digests below make a domain-string or JCS field-order drift
    // visible without relying on a self-derived expected value.
    const rsid = "rs-vector";
    const connectionId = "019f9add-7a83-7d11-a6a9-d2f8108c0098";
    const proofId = "019f9add-7a83-7d12-a6a9-d2f8108c0099";
    const contextDigest = "a".repeat(64);
    const cacheIncarnationDigest = `sha256:${"b".repeat(64)}`;
    const checkpointCanonical = canonicalizeJson({
      rsid,
      connection_id: connectionId,
      proof_id: proofId,
      context_digest: contextDigest,
      freshness: {
        source_revision: 7,
        cache_incarnation_digest: cacheIncarnationDigest,
      },
    } as JsonValue);
    const connectionCanonical = canonicalizeJson({ rsid, connection_id: connectionId } as JsonValue);

    expect(checkpointCanonical).toBe(
      `{"connection_id":"${connectionId}","context_digest":"${contextDigest}","freshness":{"cache_incarnation_digest":"${cacheIncarnationDigest}","source_revision":7},"proof_id":"${proofId}","rsid":"${rsid}"}`,
    );
    expect(connectionCanonical).toBe(`{"connection_id":"${connectionId}","rsid":"${rsid}"}`);
    expect(`sha256:${createHash("sha256")
      .update("revagent/c39-route-authority-checkpoint/v1\0", "utf8")
      .update(checkpointCanonical, "utf8").digest("hex")}`).toBe(
      "sha256:ab4e0489142f3c9021386003710993e264559db902e85909105e6a5866c65518",
    );
    expect(`sha256:${createHash("sha256")
      .update("revagent/c39-route-authority-connection/v1\0", "utf8")
      .update(connectionCanonical, "utf8").digest("hex")}`).toBe(
      "sha256:9449ea3d182b5308a70be5bdd5266d31c6d586d68500299915a1158022fbb6c6",
    );
  });
});

async function register(
  authority: GatewayBridgeSessionAuthority,
  localSessionKey = "local-route",
  binding: "wss" | "http_sse" = "wss",
  capabilities: readonly string[] = ["partial_progress"],
) {
  const opened = await openConnection(authority, binding, capabilities);
  await authority.receive(opened.connectionId, registration(localSessionKey));
  const registered = registeredFrame(opened.channel);
  return {
    ...opened,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
  };
}

function bridgeRequest(
  rsid: string,
  invocationId: string,
  executorMethod = "get_revit_mcp_status",
): GatewayExecutorRequest {
  const args: GatewayJsonObject = { carrier: "wp11" };
  const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
    principalKey: `${TENANT_ID}:${USER_ID}`,
    transportMcpSessionId: MCP_SESSION_ID,
    identityMcpSessionId: null,
    nowMs: 1_775_000_000_000,
  });
  return {
    toolName: "core.get_status",
    toolVersion: "1.0.0",
    executorMethod,
    policyClass: "auto",
    mutationScopePolicy: "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: `${TENANT_ID}:${USER_ID}`,
      actor: { tenantId: TENANT_ID, userId: USER_ID, role: "user" },
      gatewaySessionId: "gateway-route",
      oauthClientId: "oauth-route",
      mcpSessionId: MCP_SESSION_ID,
      effectiveMcpRequestScope,
      rsid,
      toolName: "core.get_status",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: "none",
      mutating: false,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "document-carrier" },
      paramsDigest: makeParamsDigest(args as unknown as Parameters<typeof makeParamsDigest>[0]),
      mutationScope: null,
      startedAtMs: 1_775_000_000_000,
    },
  };
}

function recoveryBridgeRequest(
  rsid: string,
  recoveryInvocationId: string,
  originInvocationId: string,
  originResultDigest: `sha256:${string}`,
): GatewayExecutorRequest {
  const args: GatewayJsonObject = {
    origin_invocation_id: originInvocationId,
    expected_result_digest: originResultDigest,
  };
  const base = bridgeRequest(rsid, recoveryInvocationId, "dispatch_payload_recovery");
  return {
    ...base,
    toolName: "core.dispatch.payload_recovery",
    args,
    context: {
      ...base.context,
      toolName: "core.dispatch.payload_recovery",
      paramsDigest: makeParamsDigest(args as unknown as Parameters<typeof makeParamsDigest>[0]),
    },
  };
}

async function emittedInvoke(channel: TestChannel): Promise<Extract<RbpEnvelope, { type: "invoke" }>> {
  for (let turn = 0; turn < 30; turn += 1) {
    const frame = channel.frames.find(
      (candidate): candidate is Extract<RbpEnvelope, { type: "invoke" }> => candidate.type === "invoke",
    );
    if (frame !== undefined) return frame;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("carrier dispatch did not emit an invoke frame");
}

async function emittedInvokeFor(
  channel: TestChannel,
  invocationId: string,
): Promise<Extract<RbpEnvelope, { type: "invoke" }>> {
  for (let turn = 0; turn < 30; turn += 1) {
    const frame = channel.frames.find(
      (candidate): candidate is Extract<RbpEnvelope, { type: "invoke" }> =>
        candidate.type === "invoke" && candidate.payload.invocation_id === invocationId,
    );
    if (frame !== undefined) return frame;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("C39 recovery dispatch did not emit its exact carrier invocation");
}

function resolve(authority: GatewayBridgeSessionAuthority) {
  return authority.resolveLiveInvocationRoute({
    tenantId: TENANT_ID,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    effectiveMcpRequestScope: createEffectiveMcpRequestScopeV1({
      principalKey: `${TENANT_ID}:${USER_ID}`,
      transportMcpSessionId: MCP_SESSION_ID,
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    }),
  });
}

function expectUnavailable(authority: GatewayBridgeSessionAuthority): void {
  let thrown: unknown;
  try {
    resolve(authority);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GatewayRbpFault);
  expect(thrown).toMatchObject({
    code: "unavailable",
    message: "live invocation route is unavailable",
    httpStatus: 503,
    closeCode: 1011,
  });
}

describe("GatewayBridgeSessionAuthority live document routing", () => {
  const authorities: GatewayBridgeSessionAuthority[] = [];

  async function authority(): Promise<GatewayBridgeSessionAuthority> {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    authorities.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(authorities.splice(0).map(async (created) => created.close()));
  });

  it("D2a Never policy leaves a matching C39 fixture invoke as an ordinary one-shot dispatch", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open(); authorities.push(created);
    const session = await register(created, "d2a-conformance");
    await created.receive(session.connectionId, contextUpdate({
      rsid: session.rsid, seq: 1, activeDocument: "document-carrier", documents: [document("document-carrier", true)],
    }));
    const invocationId = id();
    const baseRequest = bridgeRequest(session.rsid, invocationId, "fixture_multi_file_output");
    const c39Args: GatewayJsonObject = { scenario: "valid_multifile", fileCount: 2, bytesPerFile: 32, contentType: "application/octet-stream" };
    void created.createExecutor().execute({
      ...baseRequest,
      toolName: "conformance.fixture.c39_multifile",
      args: c39Args,
      context: {
        ...baseRequest.context,
        toolName: "conformance.fixture.c39_multifile",
        paramsDigest: makeParamsDigest(c39Args as unknown as Parameters<typeof makeParamsDigest>[0]),
      },
    });
    const origin = await emittedInvoke(session.channel);
    await created.receive(session.connectionId, {
      v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
      payload: { bridge_version: "m4-route-test", acks: [{ rsid: session.rsid, seq: origin.seq }], sessions: [] },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const invokes = session.channel.frames.filter((frame): frame is Extract<RbpEnvelope, { type: "invoke" }> => frame.type === "invoke");
    expect(invokes).toEqual([origin]);
  });

  it("D2a accepts capture only through explicit internal fixture policy injection", async () => {
    const calls: Array<{ toolName: string; executorMethod: string; mutating: boolean }> = [];
    const policy: ConformanceOriginResendPolicy = {
      kind: "internal_d2b_conformance",
      allowCapture(input) { calls.push({ toolName: input.toolName, executorMethod: input.executorMethod ?? "", mutating: input.mutating ?? true }); return true; },
      takeResumeRequest() { return null; },
      clear() {},
    };
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity(), { internalConformanceOriginResendPolicy: policy });
    await created.open(); authorities.push(created);
    const session = await register(created, "d2a-policy");
    await created.receive(session.connectionId, contextUpdate({ rsid: session.rsid, seq: 1, activeDocument: "document-carrier", documents: [document("document-carrier", true)] }));
    const invocationId = id();
    const baseRequest = bridgeRequest(session.rsid, invocationId, "fixture_multi_file_output");
    const c39Args: GatewayJsonObject = { scenario: "valid_multifile", fileCount: 2, bytesPerFile: 32, contentType: "application/octet-stream" };
    void created.createExecutor().execute({ ...baseRequest, toolName: "conformance.fixture.c39_multifile", args: c39Args, context: { ...baseRequest.context, toolName: "conformance.fixture.c39_multifile", paramsDigest: makeParamsDigest(c39Args as unknown as Parameters<typeof makeParamsDigest>[0]) } });
    await emittedInvoke(session.channel);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ toolName: "conformance.fixture.c39_multifile", executorMethod: "fixture_multi_file_output", mutating: false }]);
  });

  it("atomically clears a matched durable D2 claim when its exact origin terminal commits", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open(); authorities.push(created);
    const session = await register(created, "d2-terminal-clear");
    await created.receive(session.connectionId, contextUpdate({
      rsid: session.rsid, seq: 1, activeDocument: "document-carrier",
      documents: [document("document-carrier", true)],
    }));
    const originInvocationId = id();
    const outcome = created.createExecutor().execute(
      bridgeRequest(session.rsid, originInvocationId),
    );
    const invoke = await emittedInvokeFor(session.channel, originInvocationId);
    await injectDurableD2Claim(fixture, session.rsid, originInvocationId);
    await created.receive(session.connectionId, {
      v: 1, type: "result", id: id(), rsid: session.rsid, seq: 2,
      ack: invoke.seq, ts: new Date().toISOString(), payload: {
        kind: "invocation", invocation_id: originInvocationId,
        status: "completed", replayed: false, result: { terminal: true },
        metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
      },
    });
    await expect(outcome).resolves.toMatchObject({ state: "completed" });
    const root = fixture.snapshot().records.find((row) =>
      row.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE && row.key === session.rsid,
    );
    expect((root?.value as { sequence?: Record<string, unknown> }).sequence)
      .toMatchObject({ d2ConformanceOriginResend: null });
  });

  it("separates connection and session grants and quarantines unavailable result capabilities", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: [
          "journal_v1",
          "transport_streamable_http",
          "chunked_results",
          "artifact_result_v1",
        ],
        sessionCapabilities: [
          "batch_atomic",
          "doc_context_cached_v1",
          "partial_progress",
        ],
      }),
    );
    authorities.push(created);
    await created.open();
    const openedChannel = channel();
    const connectionHello = hello();
    connectionHello.payload.capabilities = [
      "journal_v1",
      "transport_streamable_http",
      "partial_progress",
      "chunked_results",
      "artifact_result_v1",
    ];
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: connectionHello,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "journal_v1",
      "transport_streamable_http",
    ]);

    const registrationFrame = registration("capability-separation");
    registrationFrame.payload.session_capabilities = [
      "batch_atomic",
      "doc_context_cached_v1",
      "partial_progress",
      "journal_v1",
    ];
    await created.receive(opened.connectionId, registrationFrame);
    expect(registeredFrame(openedChannel).payload.granted_session_capabilities).toEqual([
      "batch_atomic",
      "doc_context_cached_v1",
    ]);
  });

  it("grants the complete provisioned HTTP carrier and session capability sets", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: [
          "journal_v1",
          "transport_streamable_http",
          "chunked_results",
          "artifact_result_v1",
        ],
        sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
      }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = [
      "journal_v1",
      "transport_streamable_http",
      "chunked_results",
      "artifact_result_v1",
    ];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "http_sse",
      hello: offered,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ]);
    const register = registration("http-full-grants");
    register.payload.session_capabilities = [
      "batch_atomic",
      "doc_context_cached_v1",
    ];
    await created.receive(opened.connectionId, register);
    expect(registeredFrame(openedChannel).payload.granted_session_capabilities).toEqual([
      "batch_atomic",
      "doc_context_cached_v1",
    ]);
  });

  it("grants carrier capabilities only to an exact-store ready authority", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: ["chunked_results", "artifact_result_v1"],
      }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: channel(),
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "chunked_results",
      "artifact_result_v1",
    ]);

    const mismatched = createRestartableTestStore();
    const unready = new GatewayBridgeSessionAuthority(
      mismatched.store,
      identity({ connectionCapabilities: ["chunked_results", "artifact_result_v1"] }),
      { resourceAuthority: resources },
    );
    authorities.push(unready);
    await unready.open();
    const denied = await unready.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: channel(),
    });
    expect(denied.helloAck.payload.granted_capabilities).toEqual([]);
  });

  it("maps a partial acknowledgement beyond durable high-water to its bounded value-free subtype", async () => {
    const fixture = createRestartableTestStore();
    const classifications: string[] = [];
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results"] }),
      {
        resourceAuthority: resources,
        onConformancePartialCarrierCommitFailure: (failure) =>
          classifications.push(failure),
      },
    );
    await created.open(); authorities.push(created);
    const offered = hello();
    offered.payload.capabilities = ["chunked_results"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN, binding: "wss", hello: offered, channel: openedChannel,
    });
    await created.receive(opened.connectionId, registration("bounded-c39-diagnostic"));
    const session = registeredFrame(openedChannel);
    await created.receive(opened.connectionId, contextUpdate({
      rsid: session.payload.rsid, seq: 1, activeDocument: "document-carrier",
      documents: [document("document-carrier", true)],
    }));
    const invocationId = id();
    void created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvokeFor(openedChannel, invocationId);
    await expect(created.receive(opened.connectionId, {
      v: 1, type: "partial", id: id(), rsid: session.payload.rsid, seq: 2,
      ack: invoke.seq + 100,
      ts: new Date().toISOString(), payload: {
        kind: "chunk", invocation_id: invocationId, stream_id: "result", chunk_index: 0,
        encoding: "base64", content_type: "application/json",
        data: Buffer.from("{}", "utf8").toString("base64"),
      },
    })).rejects.toBeDefined();
    expect(classifications).toEqual(["sequence_ack_beyond_sent"]);
    expect(JSON.stringify(classifications)).toBe('["sequence_ack_beyond_sent"]');
  });

  it.each(["wss", "http_sse"] as const)(
    "keeps a chunked result private until Tx-C commits through the shared %s handler",
    async (binding) => {
      const fixture = createRestartableTestStore();
      const objects = createMemoryObjectStore();
      const resources = new GatewayResourceAuthority({
        protocolStore: fixture.store,
        objectStore: objects,
      });
      const created = new GatewayBridgeSessionAuthority(
        fixture.store,
        identity({ connectionCapabilities: ["chunked_results", "transport_streamable_http"] }),
        { resourceAuthority: resources },
      );
      authorities.push(created);
      await created.open();
      const offered = hello();
      offered.payload.capabilities = ["chunked_results", "transport_streamable_http"];
      const openedChannel = channel();
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN,
        binding,
        hello: offered,
        channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration("chunked-carrier"));
      const session = registeredFrame(openedChannel);
      await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
      const invocationId = id();
      const request = bridgeRequest(session.payload.rsid, invocationId);
      const outcome = created.createExecutor().execute(request);
      const invoke = await emittedInvoke(openedChannel);
      const bytes = Buffer.from('{"carrier":"complete"}', "utf8");
      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

      await created.receive(opened.connectionId, {
        v: 1,
        type: "partial",
        id: id(),
        rsid: session.payload.rsid,
        seq: 2,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: 0,
          encoding: "base64",
          content_type: "application/json",
          data: bytes.toString("base64"),
        },
      });
      expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);

      await created.receive(opened.connectionId, {
        v: 1,
        type: "result",
        id: id(),
        rsid: session.payload.rsid,
        seq: 3,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: false,
          chunked: true,
          stream_id: "result",
          content_type: "application/json",
          total_chunks: 1,
          total_size: bytes.byteLength,
          sha256,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: bytes.byteLength, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({ state: "completed", result: { carrier: "complete" } });
      expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toHaveLength(1);
    },
  );

  it("projects one current route-rebind CAS as fixed value-free state only", async () => {
    const created = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-rebind-audit-current", "wss", ["route_rebind_proof_v1"]);
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }));

    const projection = await created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID });
    expect(projection).toEqual({
      status: "current",
      candidateCount: 1,
      capabilityGranted: true,
      receiptCurrent: true,
      resumeCasCurrent: true,
      routeProvenanceCurrent: true,
      currentConnection: true,
      routeAuthorityCheckpoint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      connectionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      serverProofDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      authorityGenerationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      proofCasRecordVersion: expect.any(Number),
    });
    const serialized = JSON.stringify(projection);
    for (const value of [original.rsid, rebound.connectionId, TENANT_ID, USER_ID, DEVICE_ID]) {
      expect(serialized).not.toContain(value);
    }
    expect(Object.entries(projection)
      .filter(([, value]) => typeof value === "string" && value.startsWith("sha256:"))
      .map(([key]) => key)
      .sort())
      .toEqual([
        "authorityGenerationDigest",
        "connectionDigest",
        "routeAuthorityCheckpoint",
        "serverProofDigest",
      ]);
  });

  it.each(["wss", "http_sse"] as const)(
    "admits a %s route proof from the connection capability domain without a session capability grant",
    async (binding) => {
      const capabilities = binding === "http_sse"
        ? ["route_rebind_proof_v1", "transport_streamable_http"]
        : ["route_rebind_proof_v1"];
      const created = new GatewayBridgeSessionAuthority(
        createRestartableTestStore().store,
        identity({
          connectionCapabilities: capabilities,
          sessionCapabilities: ["partial_progress"],
        }),
      );
      authorities.push(created);
      await created.open();
      const original = await register(created, `route-rebind-connection-domain-${binding}`, binding, capabilities);
      await created.detach(original.connectionId);
      const rebound = await openConnection(created, binding, capabilities);
      await created.receive(rebound.connectionId, resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: rebound.connectionId,
      }));

      await expect(created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID }))
        .resolves.toMatchObject({
          status: "current",
          capabilityGranted: true,
        });
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });
    },
  );

  it("refuses a route proof when only the session-grant domain contains its capability", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: [],
        sessionCapabilities: ["partial_progress", "route_rebind_proof_v1"],
      }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-rebind-session-domain-only", "wss", ["route_rebind_proof_v1"]);
    // The durable session grant is deliberately polluted with the
    // connection-only capability. It must not authorize the resumed route.
    await mutateDurableSessionGrant(fixture, original.rsid, (root) => {
      root.binding.grantedCapabilities = [
        ...root.binding.grantedCapabilities,
        "route_rebind_proof_v1",
      ];
    });
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await expect(created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }))).rejects.toMatchObject({ code: "unsupported" });
    expectUnavailable(created);
    await expect(created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "none", capabilityGranted: false });
  });

  it("fails closed when a durable route-rebind connection grant is removed", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-rebind-durable-capability-removal", "wss", ["route_rebind_proof_v1"]);
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }));
    await mutateDurableRoute(fixture, original.rsid, (_route, root) => {
      root.lifecycle.connectionLifecycle.grantedCapabilities = [];
    });

    await expect(created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "not_current", capabilityGranted: false });
    // Synchronize the active record through its normal durable heartbeat CAS;
    // current-route consumers must then reject the same missing durable grant.
    await created.receive(rebound.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "m4-route-test",
        acks: [{ rsid: original.rsid, seq: 0 }],
        sessions: [],
      },
    });
    expectUnavailable(created);
  });

  type RouteRebindAuditBoolean = Exclude<keyof GatewayRouteRebindAuditSnapshot, "status" | "candidateCount">;
  type RouteRebindDrift = readonly [
    string,
    Parameters<typeof mutateDurableRoute>[2],
    RouteRebindAuditBoolean,
  ];
  const routeRebindDrifts: readonly RouteRebindDrift[] = [
    ["receipt", (_route, root) => {
      root.lifecycle.routeRebindReceipt = {
        ...(root.lifecycle.routeRebindReceipt ?? {}),
        proofId: id(),
      };
    }, "receiptCurrent"],
    ["binding", (route: Record<string, unknown>) => {
      route.resultantSessionVersion = Number(route.resultantSessionVersion) + 1;
    }, "resumeCasCurrent"],
    ["generation", (route: Record<string, unknown>) => {
      route.authorityGenerationDigest = `sha256:${"d".repeat(64)}`;
    }, "resumeCasCurrent"],
  ];
  it.each(routeRebindDrifts)("fails closed in the audit projection when the durable route-rebind %s drifts", async (_name, mutate, falseField) => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, `route-rebind-audit-${_name}`, "wss", ["route_rebind_proof_v1"]);
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }));
    await mutateDurableRoute(fixture, original.rsid, mutate);

    const projection = await created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID });
    expect(projection.status).toBe("not_current");
    expect(projection.candidateCount).toBe(1);
    expect(projection[falseField]).toBe(false);
  });

  it("fails closed and redacts every route-rebind candidate when two live proof routes exist", async () => {
    const created = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    for (const localSessionKey of ["route-rebind-audit-first", "route-rebind-audit-second"]) {
      const original = await register(created, localSessionKey, "wss", ["route_rebind_proof_v1"]);
      await created.detach(original.connectionId);
      const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
      await created.receive(rebound.connectionId, resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: rebound.connectionId,
      }));
    }
    expect(await created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID })).toEqual({
      status: "ambiguous",
      candidateCount: 2,
      capabilityGranted: false,
      receiptCurrent: false,
      resumeCasCurrent: false,
      routeProvenanceCurrent: false,
      currentConnection: false,
      routeAuthorityCheckpoint: null,
      connectionDigest: null,
      serverProofDigest: null,
      authorityGenerationDigest: null,
      proofCasRecordVersion: null,
    });
  });

  it("commits an artifact carrier's receipt, terminal, and bridge completion in Tx-B/Tx-C", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results", "artifact_result_v1"] }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "chunked_results",
      "artifact_result_v1",
    ]);
    await created.receive(opened.connectionId, registration("artifact-carrier"));
    const session = registeredFrame(openedChannel);
    await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
    const invocationId = id();
    const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const artifactId = "0197a3c2-0000-7000-8000-000000000911";
    const bytes = Buffer.from([9, 1, 1]);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    await created.receive(opened.connectionId, {
      v: 1,
      type: "partial",
      id: id(),
      rsid: session.payload.rsid,
      seq: 2,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk",
        invocation_id: invocationId,
        stream_id: `artifact:${artifactId}`,
        artifact_id: artifactId,
        artifact_index: 0,
        chunk_index: 0,
        encoding: "base64",
        content_type: "image/png",
        data: bytes.toString("base64"),
      },
    });
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "chunk_durable")).toHaveLength(1);

    await created.receive(opened.connectionId, {
      v: 1,
      type: "result",
      id: id(),
      rsid: session.payload.rsid,
      seq: 3,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "invocation",
        invocation_id: invocationId,
        status: "completed",
        replayed: false,
        chunked: true,
        result: { artifact_id: artifactId, artifact_index: 0 },
        artifacts: [{
          artifact_id: artifactId,
          artifact_index: 0,
          stream_id: `artifact:${artifactId}`,
          filename: "proof.png",
          content_type: "image/png",
          total_chunks: 1,
          total_size: bytes.byteLength,
          sha256,
        }],
        metrics: { execute_ms: 1, request_bytes: 1, response_bytes: bytes.byteLength, framing: "length-prefixed" },
      },
    });
    await expect(outcome).resolves.toEqual({
      state: "completed",
      result: { artifact_id: artifactId, artifact_index: 0 },
    });
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toHaveLength(1);
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toHaveLength(1);
  });

  it("denies an artifact partial before any carrier side effect without artifact_result_v1", async () => {
    const fixture = createRestartableTestStore();
    const objects = createMemoryObjectStore();
    const resources = new GatewayResourceAuthority({ protocolStore: fixture.store, objectStore: objects });
    const tailEvents: Array<{ stage: string; queuedBytes: number }> = [];
    const options = { resourceAuthority: resources };
    Object.defineProperty(options, TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER, {
      value: (event: { readonly stage: string; readonly queuedBytes: number }) => {
        tailEvents.push({ stage: event.stage, queuedBytes: event.queuedBytes });
      },
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results"] }),
      options,
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN, binding: "wss", hello: offered, channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual(["chunked_results"]);
    await created.receive(opened.connectionId, registration("artifact-capability-denied"));
    const session = registeredFrame(openedChannel);
    await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
    const invocationId = id();
    void created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const artifactId = "0197a3c2-0000-7000-8000-000000000912";
    await expect(created.receive(opened.connectionId, {
      v: 1, type: "partial", id: id(), rsid: session.payload.rsid, seq: 2, ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk", invocation_id: invocationId, stream_id: `artifact:${artifactId}`,
        artifact_id: artifactId, artifact_index: 0, chunk_index: 0, encoding: "base64",
        content_type: "image/png", data: Buffer.from([1]).toString("base64"),
      },
    })).rejects.toMatchObject({ code: "unsupported", httpStatus: 403 });
    expect(objects.keys()).toEqual([]);
    expect(fixture.snapshot().records.filter((row) =>
      row.namespace === "gateway_resource_v1" ||
      row.namespace.startsWith("gateway.carrier") ||
      row.namespace === "gateway.resource-set/v1",
    )).toEqual([]);
    expect(tailEvents).toEqual([{ stage: "denied_prequeue", queuedBytes: 0 }]);

    // The rejected artifact did not consume seq=2: a result-only chunk with
    // the same sequence is accepted under the independently granted chunk cap.
    await expect(created.receive(opened.connectionId, {
      v: 1, type: "partial", id: id(), rsid: session.payload.rsid, seq: 2, ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk", invocation_id: invocationId, stream_id: "result", chunk_index: 0,
        encoding: "base64", content_type: "application/json", data: Buffer.from("{}").toString("base64"),
      },
    })).resolves.toBeUndefined();
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1")).toHaveLength(1);
    expect(tailEvents).toEqual([
      { stage: "denied_prequeue", queuedBytes: 0 },
      { stage: "tail_installed", queuedBytes: 2 },
      { stage: "tail_released", queuedBytes: 0 },
    ]);
  });

  it("caps each rsid carrier tail at 8 MiB while keeping a heartbeat serviceable", async () => {
    const fixture = createRestartableTestStore();
    const baseObjects = createMemoryObjectStore();
    let releasePut!: () => void;
    const putsReleased = new Promise<void>((resolve) => { releasePut = resolve; });
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: {
        ...baseObjects,
        async put(input) {
          await putsReleased;
          return baseObjects.put(input);
        },
      },
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results"] }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: openedChannel,
    });
    await created.receive(opened.connectionId, registration("carrier-tail"));
    const session = registeredFrame(openedChannel);
    await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
    const invocationId = id();
    void created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const megabyte = Buffer.alloc(1024 * 1024, 7).toString("base64");
    const queued = Array.from({ length: 8 }, (_, index) =>
      created.receive(opened.connectionId, {
        v: 1,
        type: "partial",
        id: id(),
        rsid: session.payload.rsid,
        seq: index + 2,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: index,
          encoding: "base64",
          content_type: "application/json",
          data: megabyte,
        },
      }),
    );
    await expect(created.receive(opened.connectionId, {
      v: 1,
      type: "partial",
      id: id(),
      rsid: session.payload.rsid,
      seq: 10,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk",
        invocation_id: invocationId,
        stream_id: "result",
        chunk_index: 8,
        encoding: "base64",
        content_type: "application/json",
        data: megabyte,
      },
    })).rejects.toMatchObject({ code: "unavailable", closeCode: 1013 });
    await expect(created.receive(opened.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "m4-route-test",
        acks: [],
        sessions: [],
      },
    })).resolves.toBeUndefined();
    expect(openedChannel.frames.some((frame) => frame.type === "heartbeat_ack")).toBe(true);
    releasePut();
    await expect(Promise.all(queued)).resolves.toHaveLength(8);
  });

  it("refuses routing until an accepted document context identifies one active document", async () => {
    const created = await authority();
    await register(created);

    expectUnavailable(created);
  });

  it("routes an empty registration after its first accepted document context update", async () => {
    const created = await authority();
    const session = await register(created);

    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    expect(resolve(created)).toEqual({
      tenantId: TENANT_ID,
      mcpSessionId: MCP_SESSION_ID,
      effectiveMcpRequestScope: expect.objectContaining({
        principalKey: `${TENANT_ID}:${USER_ID}`,
        effectiveMcpSessionId: MCP_SESSION_ID,
      }),
      rsid: session.rsid,
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live",
      },
    });
    expect(resolve(created).principalKey).toBe(`${TENANT_ID}:${USER_ID}`);
  });

  it.each(["wss", "http_sse"] as const)(
    "persists the %s document route before the next heartbeat-driven acknowledgement",
    async (binding) => {
      const fixture = createRestartableTestStore();
      const observations: Array<{ readonly stage: string; readonly sequence: number; readonly contextDigest: string }> = [];
      const created = new GatewayBridgeSessionAuthority(fixture.store, identity(
        binding === "http_sse"
          ? { connectionCapabilities: ["transport_streamable_http"] }
          : {},
      ), {
        onDocumentContextObservation: (observation) => observations.push(observation),
      });
      authorities.push(created);
      await created.open();
      const openedChannel = channel();
      const offered = hello();
      if (binding === "http_sse") {
        offered.payload.capabilities = ["partial_progress", "transport_streamable_http"];
      }
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN,
        binding,
        hello: offered,
        channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration(`route-before-ack-${binding}`));
      const registered = registeredFrame(openedChannel);
      const session = {
        connectionId: opened.connectionId,
        channel: openedChannel,
        rsid: registered.payload.rsid,
      };

      await created.receive(session.connectionId, contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-route-before-ack",
        documents: [document("document-route-before-ack", true)],
      }));

      // This is the public route authority, independently visible before the
      // worker emits its later heartbeat fence acknowledgement.
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-route-before-ack",
      });
      expect(observations).toEqual([expect.objectContaining({
        stage: "accepted", sequence: 1, contextDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })]);
      expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toEqual([]);

      await created.receive(session.connectionId, {
        v: 1,
        type: "heartbeat",
        id: id(),
        ts: new Date().toISOString(),
        payload: { bridge_version: "m4-route-test", acks: [], sessions: [] },
      });
      expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toHaveLength(1);
    },
  );

  it("does not journal a rejected document update without route or acknowledgement", async () => {
    const fixture = createRestartableTestStore();
    const observations: Array<{ readonly stage: string; readonly sequence: number; readonly contextDigest: string }> = [];
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity(), {
      onDocumentContextObservation: (observation) => observations.push(observation),
    });
    authorities.push(created);
    await created.open();
    const session = await register(created, "document-route-rejected");

    await expect(created.receive(session.connectionId, contextUpdate({
      rsid: session.rsid,
      seq: 1,
      activeDocument: "document-a",
      documents: [document("document-a", true), document("document-b", true)],
    }))).rejects.toMatchObject({ code: "protocol", httpStatus: 400 });

    expect(observations).toEqual([]);
    expectUnavailable(created);
    expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toEqual([]);
  });

  it("clears the live route when a later accepted context has no active document", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 2,
        activeDocument: null,
        documents: [document("document-live", false)],
      }),
    );

    expectUnavailable(created);
  });

  it("rejects inconsistent or ambiguous active-document state without replacing the last route", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 2,
          activeDocument: "document-live",
          documents: [
            document("document-live", true),
            document("document-other", true),
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "protocol",
      message: "document context is inconsistent",
      httpStatus: 400,
      closeCode: 4400,
    });
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 2,
          activeDocument: "document-live",
          documents: [
            document("document-live", true),
            document("document-live", false),
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "protocol",
      message: "document context is inconsistent",
    });
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });
  });

  it("keeps duplicate sequence handling idempotent and rejects conflicting reuse", async () => {
    const created = await authority();
    const session = await register(created);
    const accepted = contextUpdate({
      rsid: session.rsid,
      seq: 1,
      activeDocument: "document-live",
      documents: [document("document-live", true)],
    });
    await created.receive(session.connectionId, accepted);

    await created.receive(session.connectionId, accepted);
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 1,
          activeDocument: "document-other",
          documents: [document("document-other", true)],
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayRbpFault);
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });
  });

  it("requires a fresh current-connection context after resume", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-before-resume",
        documents: [document("document-before-resume", true)],
      }),
    );
    await created.detach(session.connectionId);

    const resumedConnection = await openConnection(created);
    await created.receive(resumedConnection.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: session.rsid,
        resume_token: session.resumeToken,
        last_rx_seq: 0,
      },
    });

    expectUnavailable(created);

    await created.receive(
      resumedConnection.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 2,
        activeDocument: "document-after-resume",
        documents: [document("document-after-resume", true)],
      }),
    );
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-after-resume",
    });
  });

  it.each(["wss", "http_sse"] as const)(
    "binds a fresh route proof through the shared %s resume CAS without consuming data sequence",
    async (binding) => {
      const capabilities = binding === "http_sse"
        ? ["route_rebind_proof_v1", "transport_streamable_http"]
        : ["route_rebind_proof_v1"];
      const created = new GatewayBridgeSessionAuthority(
        createRestartableTestStore().store,
        identity({ connectionCapabilities: capabilities }),
      );
      authorities.push(created);
      await created.open();
      const original = await register(created, `route-rebind-${binding}`, binding, capabilities);
      await created.detach(original.connectionId);
      const rebound = await openConnection(created, binding, capabilities);
      const proof = resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: rebound.connectionId,
      });

      await created.receive(rebound.connectionId, proof);
      expect(rebound.channel.frames.filter((frame) => frame.type === "resume_ack")).toHaveLength(1);
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });
      // Proof provenance deliberately has no observed data sequence.
      expect(created.readCurrentDocumentRouteAuditSnapshot({ tenantId: TENANT_ID })).toBeNull();

      // ACK-loss retry is an exact receipt replay: it does not install a
      // second route or consume a data sequence.
      await created.receive(rebound.connectionId, proof);
      expect(rebound.channel.frames.filter((frame) => frame.type === "resume_ack")).toHaveLength(2);
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });

      // The first real data context consumes sequence 1, proving that the
      // proof itself did not create a synthetic accepted-inbound row.
      await created.receive(rebound.connectionId, contextUpdate({
        rsid: original.rsid,
        seq: 1,
        activeDocument: "document-after-proof",
        documents: [document("document-after-proof", true)],
      }));
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-after-proof",
      });
      expect(created.readCurrentDocumentRouteAuditSnapshot({ tenantId: TENANT_ID }))
        .toMatchObject({ observedSequence: 1 });

      const altered = structuredClone(proof) as typeof proof & {
        payload: typeof proof.payload & { route_rebind_proof: Record<string, unknown> };
      };
      altered.payload.route_rebind_proof = {
        ...altered.payload.route_rebind_proof,
        proof_id: id(),
      };
      await expect(created.receive(rebound.connectionId, altered)).rejects.toMatchObject({
        code: "protocol",
        message: "route rebind proof receipt is immutable",
      });
    },
  );

  it("fails closed when the route proof is present without a granted capability", async () => {
    const created = await authority();
    const original = await register(created, "route-rebind-no-cap");
    await created.detach(original.connectionId);
    const rebound = await openConnection(created);
    await expect(created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }))).rejects.toMatchObject({ code: "unsupported" });
    expectUnavailable(created);
  });

  it("rejects stale connection and tampered digest proofs before resume CAS", async () => {
    const created = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-rebind-negative");
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    const stale = resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: original.connectionId,
    });
    await expect(created.receive(rebound.connectionId, stale)).rejects.toMatchObject({
      code: "auth",
      message: "route rebind proof is not bound to the current connection",
    });

    const malformed = resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }) as ReturnType<typeof resumeWithRouteProof> & {
      payload: ReturnType<typeof resumeWithRouteProof>["payload"] & {
        route_rebind_proof: Record<string, unknown>;
      };
    };
    malformed.payload.route_rebind_proof.context_digest = "0".repeat(64);
    await expect(created.receive(rebound.connectionId, malformed)).rejects.toMatchObject({
      code: "protocol",
      message: "route rebind context digest is invalid",
    });
    expectUnavailable(created);
  });

  it.each(["wss", "http_sse"] as const)(
    "accepts unchanged equal route-proof freshness from a fresh %s connection-bound proof",
    async (binding) => {
      const capabilities = binding === "http_sse"
        ? ["route_rebind_proof_v1", "transport_streamable_http"]
        : ["route_rebind_proof_v1"];
      const created = new GatewayBridgeSessionAuthority(
        createRestartableTestStore().store,
        identity({ connectionCapabilities: capabilities }),
      );
      authorities.push(created);
      await created.open();
      const original = await register(
        created,
        `route-rebind-stable-${binding}`,
        binding,
        capabilities,
      );
      await created.detach(original.connectionId);
      const incarnation = `sha256:${"a".repeat(64)}`;
      const first = await openConnection(created, binding, capabilities);
      const firstProof = resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: first.connectionId,
        sourceRevision: 2,
        cacheIncarnationDigest: incarnation,
      });
      await created.receive(first.connectionId, firstProof);
      expect(first.channel.frames.filter((frame) => frame.type === "resume_ack"))
        .toHaveLength(1);
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });
      await created.detach(first.connectionId);

      const replacement = await openConnection(created, binding, capabilities);
      const replacementProof = resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: replacement.connectionId,
        sourceRevision: 2,
        cacheIncarnationDigest: incarnation,
      });
      const firstRouteProof = firstProof.payload.route_rebind_proof;
      const replacementRouteProof = replacementProof.payload.route_rebind_proof;
      if (firstRouteProof === undefined || replacementRouteProof === undefined) {
        throw new Error("route-rebind test fixture omitted its required proof");
      }
      expect(replacementRouteProof.proof_id).not.toBe(firstRouteProof.proof_id);
      expect(replacementRouteProof.connection_id).toBe(replacement.connectionId);

      await created.receive(replacement.connectionId, replacementProof);

      expect(replacement.channel.frames.filter((frame) => frame.type === "resume_ack"))
        .toHaveLength(1);
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });
    },
  );

  it("rejects same-incarnation route-proof regression or context change and permits a new incarnation on a new connection", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-rebind-freshness");
    await created.detach(original.connectionId);
    const first = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    const incarnationA = `sha256:${"a".repeat(64)}`;
    await created.receive(first.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: first.connectionId,
      sourceRevision: 2,
      cacheIncarnationDigest: incarnationA,
    }));
    await created.detach(first.connectionId);

    const replacement = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await expect(created.receive(replacement.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: replacement.connectionId,
      sourceRevision: 1,
      cacheIncarnationDigest: incarnationA,
    }))).rejects.toMatchObject({
      code: "protocol",
      message: "route rebind freshness rejected: source revision regressed within cache incarnation",
    });
    const changedContext = {
      documents: [document("document-equal-revision-changed", true)],
      active_document: "document-equal-revision-changed",
      active_view: null,
    };
    await expect(created.receive(replacement.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: replacement.connectionId,
      sourceRevision: 2,
      cacheIncarnationDigest: incarnationA,
      context: changedContext,
    }))).rejects.toMatchObject({
      code: "protocol",
      message: "route rebind freshness rejected: context changed at an equal source revision",
    });
    expectUnavailable(created);

    const incarnationB = `sha256:${"b".repeat(64)}`;
    await created.receive(replacement.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: replacement.connectionId,
      sourceRevision: 1,
      cacheIncarnationDigest: incarnationB,
      context: changedContext,
    }));
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-equal-revision-changed",
    });
  });

  it.each(["wss", "http_sse"] as const)(
    "preserves the %s freshness watermark across proofless downgrade and restart",
    async (binding) => {
      const capabilities = binding === "http_sse"
        ? ["route_rebind_proof_v1", "transport_streamable_http"]
        : ["route_rebind_proof_v1"];
      const fixture = createRestartableTestStore();
      const created = new GatewayBridgeSessionAuthority(
        fixture.store,
        identity({ connectionCapabilities: capabilities }),
      );
      authorities.push(created);
      await created.open();
      const original = await register(created, `route-watermark-${binding}`, binding, capabilities);
      await created.detach(original.connectionId);
      const first = await openConnection(created, binding, capabilities);
      const incarnationA = `sha256:${"a".repeat(64)}`;
      await created.receive(first.connectionId, resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: first.connectionId,
        sourceRevision: 2,
        cacheIncarnationDigest: incarnationA,
      }));
      await created.detach(first.connectionId);

      const downgrade = await openConnection(created, binding, capabilities);
      await created.receive(downgrade.connectionId, {
        v: 1,
        type: "session_resume",
        id: id(),
        ts: new Date().toISOString(),
        payload: {
          rsid: original.rsid,
          resume_token: original.resumeToken,
          last_rx_seq: 0,
        },
      });
      expectUnavailable(created);
      await created.close();

      const restarted = new GatewayBridgeSessionAuthority(
        fixture.store,
        identity({ connectionCapabilities: capabilities }),
      );
      authorities.push(restarted);
      await restarted.open();
      const stale = await openConnection(restarted, binding, capabilities);
      await expect(restarted.receive(stale.connectionId, resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: stale.connectionId,
        sourceRevision: 1,
        cacheIncarnationDigest: incarnationA,
      }))).rejects.toMatchObject({
        code: "protocol",
        message: "route rebind freshness rejected: source revision regressed within cache incarnation",
      });
      const incarnationB = `sha256:${"b".repeat(64)}`;
      await restarted.receive(stale.connectionId, resumeWithRouteProof({
        rsid: original.rsid,
        resumeToken: original.resumeToken,
        connectionId: stale.connectionId,
        sourceRevision: 1,
        cacheIncarnationDigest: incarnationB,
      }));
      expect(resolve(restarted).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-rebound",
      });
    },
  );

  it.each([
    ["resultant binding version", (route: Record<string, unknown>) => {
      route.resultantSessionVersion = Number(route.resultantSessionVersion) + 1;
    }],
    ["durable binding version", (_route: Record<string, unknown>, root: { binding: { sessionVersion: number } }) => {
      root.binding.sessionVersion += 1;
    }],
    ["authority generation digest", (route: Record<string, unknown>) => {
      route.authorityGenerationDigest = `sha256:${"d".repeat(64)}`;
    }],
  ] as const)("fails closed when durable proof-route %s drifts", async (_name, mutate) => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, `route-rebind-drift-${_name}`);
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }));
    await mutateDurableRoute(fixture, original.rsid, mutate);
    await created.receive(rebound.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "m4-route-test",
        acks: [{ rsid: original.rsid, seq: 0 }],
        sessions: [],
      },
    });
    expectUnavailable(created);
  });

  it("fails closed when the persisted freshness watermark is malformed", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["route_rebind_proof_v1"] }),
    );
    authorities.push(created);
    await created.open();
    const original = await register(created, "route-watermark-malformed");
    await created.detach(original.connectionId);
    const rebound = await openConnection(created, "wss", ["route_rebind_proof_v1"]);
    await created.receive(rebound.connectionId, resumeWithRouteProof({
      rsid: original.rsid,
      resumeToken: original.resumeToken,
      connectionId: rebound.connectionId,
    }));
    await mutateDurableRoute(fixture, original.rsid, (_route, root) => {
      root.lifecycle.routeRebindFreshness = {
        version: 1,
        cacheIncarnationDigest: `sha256:${"a".repeat(64)}`,
        sourceRevision: 0,
        contextDigest: "a".repeat(64),
      };
    });
    await expect(created.receive(rebound.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "m4-route-test",
        acks: [{ rsid: original.rsid, seq: 0 }],
        sessions: [],
      },
    })).rejects.toMatchObject({ code: "unavailable" });
    const index = authorities.indexOf(created);
    if (index >= 0) authorities.splice(index, 1);
    await created.close().catch(() => undefined);
  });

  it("refuses an ambiguous identity with multiple matching live sessions", async () => {
    const created = await authority();
    const first = await register(created, "local-route-first");
    const second = await register(created, "local-route-second");
    await created.receive(
      first.connectionId,
      contextUpdate({
        rsid: first.rsid,
        seq: 1,
        activeDocument: "document-first",
        documents: [document("document-first", true)],
      }),
    );
    await created.receive(
      second.connectionId,
      contextUpdate({
        rsid: second.rsid,
        seq: 1,
        activeDocument: "document-second",
        documents: [document("document-second", true)],
      }),
    );

    expectUnavailable(created);
  });

  it("fences a blocked resume send at phase one without holding another rsid", async () => {
    const fixture = createRestartableTestStore();
    let nowMs = 1_775_000_100_000;
    const drainEntered = deferred();
    const releaseDrain = deferred();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity(), {
      clock: () => nowMs,
      wait: async () => {
        drainEntered.resolve();
        await releaseDrain.promise;
        nowMs += 5_000;
      },
    });
    authorities.push(created);
    await created.open();
    const original = await register(created, "lock-scope-original");
    await created.detach(original.connectionId);

    const resumeStarted = deferred();
    const releaseResume = deferred();
    const blocked = channel();
    const send = blocked.send.bind(blocked);
    blocked.send = async (serialized): Promise<void> => {
      const frame = JSON.parse(serialized) as RbpEnvelope;
      if (frame.type === "resume_ack") {
        resumeStarted.resolve();
        await releaseResume.promise;
      }
      await send(serialized);
    };
    const replacement = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: hello(),
      channel: blocked,
    });
    const resuming = created.receive(replacement.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: original.rsid,
        resume_token: original.resumeToken,
        last_rx_seq: 0,
      },
    });
    await resumeStarted.promise;

    const revoker = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: hello(),
      channel: channel(),
    });
    const unregistering = created.receive(revoker.connectionId, {
      v: 1,
      type: "session_unregister",
      id: id(),
      ts: new Date().toISOString(),
      payload: { rsid: original.rsid, reason: "revit_exited" },
    });
    await drainEntered.promise;

    const egress = fixture.snapshot().records.find((row) =>
      row.namespace === "gateway.rbp-session-egress/v2" &&
      typeof row.value === "object" && row.value !== null &&
      "rsid" in row.value && row.value.rsid === original.rsid,
    );
    expect(egress?.value).toMatchObject({
      fence: {
        state: "revocation_pending",
        lease: { operation: "resume_ack", phase: "started" },
      },
    });

    // A distinct rsid is never queued behind the blocked carrier's tail.
    const other = await register(created, "lock-scope-other");
    expect(other.rsid).not.toBe(original.rsid);

    releaseResume.resolve();
    await expect(resuming).rejects.toMatchObject({
      code: "unavailable",
      message: "dispatch completed after durable revocation",
    });
    releaseDrain.resolve();
    await expect(unregistering).resolves.toBeUndefined();
    expect(blocked.frames.filter((frame) => frame.type === "resume_ack")).toHaveLength(1);
  });
});

describe("Gateway dispatch proof nominal authority", () => {
  it("rejects a forged or foreign proof while JCS-equivalent route material remains stable", () => {
    const first = createGatewayDispatchProofAuthority();
    const second = createGatewayDispatchProofAuthority();
    const material = {
      tenantId: "tenant-route", rsid: "rsid-route", effectiveMcpSessionId: "mcp-route",
      sessionBindingId: "binding-route", connectionId: "connection-route",
      routeSnapshot: { b: 2, a: 1 }, documentHash: "sha256:" + "a".repeat(64),
      documentSequence: 2, documentAck: 1, gatewayProcessEpoch: "epoch-route",
      gatewayProcessOrdinal: 4, effectiveScope: { principalKey: "p", effectiveMcpSessionId: "mcp-route" },
      invocationId: "invoke-route", correlationId: "invoke-route",
      envelopeDigest: ("sha256:" + "b".repeat(64)) as `sha256:${string}`,
      toolName: "route_tool", toolVersion: "1", argsDigest: ("sha256:" + "c".repeat(64)) as `sha256:${string}`,
      policy: { decision: "auto" }, confirmationId: null,
    };
    const proof = first.mint(material);
    expect(first.digest(proof)).toMatch(/^sha256:/u);
    expect(first.routeSnapshotDigest(proof)).toBe(first.routeSnapshotDigest(proof));
    expect(() => second.assert(proof)).toThrow(/not owned/u);
    expect(() => first.assert(Object.freeze({}))).toThrow(/not owned/u);
    expect(first.digest(first.mint({ ...material, routeSnapshot: { a: 1, b: 2 } })))
      .toBe(first.digest(proof));
    expect(first.digest(first.mint({ ...material, toolName: "changed" })))
      .not.toBe(first.digest(proof));
  });
});

describe("Gateway omitted-payload recovery admission", () => {
  it("denies an inline terminal without an explicit omission marker", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("inline-terminal"));
      const session = registeredFrame(opened.channel);
      await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
      const invocationId = id();
      const originResultDigest = `sha256:${"c".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 2, ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation", invocation_id: invocationId, status: "completed", replayed: false,
          result: { inline: true }, result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({ state: "completed", result: { inline: true } });
      const root = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const binding = (root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined) throw new Error("missing fixture binding");
      await expect(created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId: invocationId, originResultDigest, newCarrierRecoveryInvocationId: id(),
      })).resolves.toEqual({ kind: "guarded" });
    } finally {
      await created.close();
    }
  });

  it("fails closed when retained omitted-terminal evidence is corrupted", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("corrupt-omitted-evidence"));
      const session = registeredFrame(opened.channel);
      await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
      const invocationId = id();
      const originResultDigest = `sha256:${"d".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 2, ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation", invocation_id: invocationId, status: "completed", replayed: true,
          payload_omitted: true, result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await outcome;
      const root = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const binding = (root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      const evidence = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session-evidence/v2" && row.key.startsWith(`${session.payload.rsid}/`));
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined || evidence === undefined) throw new Error("missing omitted fixture evidence");
      await fixture.store.transact({ tenantId: TENANT_ID }, async (tx) => {
        tx.stage({ namespace: evidence.namespace, key: evidence.key, value: {}, expect: { kind: "version", version: evidence.version } });
      });
      await expect(created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId: invocationId, originResultDigest, newCarrierRecoveryInvocationId: id(),
      })).resolves.toEqual({ kind: "guarded" });
    } finally {
      // The deliberately corrupt durable child also makes shutdown fail closed.
      await created.close().catch(() => undefined);
    }
  });

  it("admits only a genuine omitted terminal for its authenticated current owner and never re-executes origin", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("omitted-payload"));
      const session = registeredFrame(opened.channel);
      await establishCurrentRoute(created, opened.connectionId, session.payload.rsid);
      const invocationId = id();
      const originResultDigest = `sha256:${"a".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1,
        type: "result",
        id: id(),
        rsid: session.payload.rsid,
        seq: 2,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: true,
          payload_omitted: true,
          result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({
        state: "omitted_payload",
        originInvocationId: invocationId,
        expectedResultDigest: originResultDigest,
      });
      const root = fixture.snapshot().records.find((row) =>
        row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid,
      );
      const binding = root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } };
      expect(binding.binding).toMatchObject({ sessionVersion: 1 });
      const sessionBinding = binding.binding;
      if (sessionBinding?.sessionBindingId === undefined || sessionBinding.sessionVersion === undefined) {
        throw new Error("fixture omitted the current bridge session binding");
      }
      const terminalEvidence = fixture.snapshot().records.find((row) =>
        row.namespace === "gateway.rbp-session-evidence/v2" && row.key.startsWith(`${session.payload.rsid}/`),
      );
      expect(terminalEvidence?.value).toMatchObject({ entry: {
        effectiveMcpSessionId: MCP_SESSION_ID,
        terminalInvocationId: invocationId,
        terminalTruth: { payloadRetained: false, resultDigest: originResultDigest },
      } });
      const input = {
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid,
        sessionBindingId: sessionBinding.sessionBindingId,
        sessionVersion: sessionBinding.sessionVersion,
        originInvocationId: invocationId,
        originResultDigest,
        newCarrierRecoveryInvocationId: id(),
      };
      const claims = await Promise.all(Array.from({ length: 8 }, async () =>
        await created.admitOmittedPayloadRecovery(input),
      ));
      expect(claims.map((claim) => claim.kind).sort()).toEqual([
        "admitted", "resume", "resume", "resume", "resume", "resume", "resume", "resume",
      ]);
      await expect(created.admitOmittedPayloadRecovery({ ...input, userId: "foreign" }))
        .resolves.toEqual({ kind: "guarded" });
      await expect(created.admitOmittedPayloadRecovery({ ...input, originResultDigest: `sha256:${"b".repeat(64)}` }))
        .resolves.toEqual({ kind: "guarded" });
      expect(opened.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
      await created.detach(opened.connectionId);
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
      const rebound = await openConnection(created);
      await created.receive(rebound.connectionId, {
        v: 1,
        type: "session_resume",
        id: id(),
        ts: new Date().toISOString(),
        payload: { rsid: session.payload.rsid, resume_token: session.payload.resume_token, last_rx_seq: 1 },
      });
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
      const reboundRoot = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const reboundBinding = (reboundRoot?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (reboundBinding?.sessionBindingId === undefined || reboundBinding.sessionVersion === undefined) throw new Error("missing rebound fixture binding");
      await expect(created.admitOmittedPayloadRecovery({
        ...input, sessionBindingId: reboundBinding.sessionBindingId, sessionVersion: reboundBinding.sessionVersion,
      })).resolves.toEqual({ kind: "guarded" });
      await created.receive(rebound.connectionId, {
        v: 1,
        type: "session_unregister",
        id: id(),
        ts: new Date().toISOString(),
        payload: { rsid: session.payload.rsid, reason: "operator_requested" },
      });
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
    } finally {
      await created.close();
    }
  });

  it("returns an exact live C39 recovery snapshot only for its durable owner", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("snapshot-omitted"));
      const session = registeredFrame(opened.channel);
      await created.receive(opened.connectionId, contextUpdate({
        rsid: session.payload.rsid, seq: 1, activeDocument: "document-c39",
        documents: [document("document-c39", true)],
      }));
      const invocationId = id();
      const originResultDigest = `sha256:${"f".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 2, ack: invoke.seq,
        ts: new Date().toISOString(), payload: {
          kind: "invocation", invocation_id: invocationId, status: "completed", replayed: true,
          payload_omitted: true, result_digest: originResultDigest,
          metrics: { execute_ms: 0, request_bytes: 0, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await outcome;
      const root = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const binding = (root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined) throw new Error("missing recovery binding");
      const claim = await created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId: invocationId,
        originResultDigest, newCarrierRecoveryInvocationId: id(),
      });
      if (claim.kind !== "admitted") throw new Error("recovery claim was not admitted");
      const snapshot = await created.resolveCurrentRecoveryAuthoritySnapshot({
        tenantId: TENANT_ID, userId: USER_ID, principalKey: `${TENANT_ID}:${USER_ID}`,
        effectiveMcpSessionId: MCP_SESSION_ID, rsid: session.payload.rsid,
        sessionBindingId: binding.sessionBindingId, sessionBindingVersion: binding.sessionVersion,
        recoveryInvocationId: claim.record.carrierRecoveryInvocationId,
        originInvocationId: invocationId, originResultDigest,
      });
      expect(snapshot).toEqual(expect.objectContaining({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionBindingVersion: binding.sessionVersion,
      }));
      await created.detach(opened.connectionId);
      await expect(created.resolveCurrentRecoveryAuthoritySnapshot({
        tenantId: TENANT_ID, userId: USER_ID, principalKey: `${TENANT_ID}:${USER_ID}`,
        effectiveMcpSessionId: MCP_SESSION_ID, rsid: session.payload.rsid,
        sessionBindingId: binding.sessionBindingId, sessionBindingVersion: binding.sessionVersion,
        recoveryInvocationId: claim.record.carrierRecoveryInvocationId,
        originInvocationId: invocationId, originResultDigest,
      })).resolves.toBeNull();
    } finally {
      await created.close().catch(() => undefined);
    }
  });

  it("C2 acknowledges only an exact active recovery receipt without carrier-ack state", async () => {
    const fixture = createRestartableTestStore();
    const objects = createMemoryObjectStore();
    const inventory = Object.freeze({
      kind: "conformance" as const,
      async listLiveKids() { return Object.freeze(["c39-c2-key"]); },
    });
    const keys = new ConformanceProtectedObjectKeyProvider(
      "c39-c2-key", new Map([["c39-c2-key", Buffer.alloc(32, 7)]]), inventory,
    );
    const authorityRef: { current: GatewayBridgeSessionAuthority | null } = { current: null };
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store, objectStore: objects,
      protectedObjectStore: new EncryptedProtectedObjectStore(objects, keys),
      reauthorizeRecoveryScope: async (owner) =>
        await authorityRef.current?.resolveCurrentRecoveryAuthoritySnapshot(owner) ?? null,
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results", "route_rebind_proof_v1"] }),
      { resourceAuthority: resources },
    );
    authorityRef.current = created;
    await created.open();
    try {
      const offered = hello();
      offered.payload.capabilities = ["chunked_results", "route_rebind_proof_v1"];
      const openedChannel = channel();
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN, binding: "wss", hello: offered, channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration("c39-c2-ingress"));
      const session = registeredFrame(openedChannel);
      await created.receive(opened.connectionId, contextUpdate({
        rsid: session.payload.rsid, seq: 1, activeDocument: "document-carrier",
        documents: [document("document-carrier", true)],
      }));

      const raw = Buffer.from('{"c39":"recovered"}', "utf8");
      const originInvocationId = id();
      const originDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}` as const;
      const origin = created.createExecutor().execute(
        bridgeRequest(session.payload.rsid, originInvocationId),
      );
      const originInvoke = await emittedInvokeFor(openedChannel, originInvocationId);
      await created.detach(opened.connectionId);
      const rebound = await openConnection(created, "wss", ["chunked_results", "route_rebind_proof_v1"]);
      await created.receive(rebound.connectionId, resumeWithRouteProof({
        rsid: session.payload.rsid,
        resumeToken: session.payload.resume_token,
        connectionId: rebound.connectionId,
        lastRxSeq: originInvoke.seq,
      }));
      await expect(created.readRouteRebindAuditSnapshot({ tenantId: TENANT_ID }))
        .resolves.toMatchObject({
          status: "current",
          capabilityGranted: true,
        });
      await created.receive(rebound.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 2,
        ack: originInvoke.seq, ts: new Date().toISOString(), payload: {
          kind: "invocation", invocation_id: originInvocationId, status: "completed",
          replayed: true, payload_omitted: true, result_digest: originDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await expect(origin).resolves.toMatchObject({ state: "omitted_payload" });
      const sessionRecord = fixture.snapshot().records.find((row) =>
        row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid,
      )?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } };
      const binding = sessionRecord.binding;
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined) {
        throw new Error("C39 C2 fixture lacks a current owner binding");
      }
      const claim = await created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId, originResultDigest: originDigest,
        newCarrierRecoveryInvocationId: id(),
      });
      if (claim.kind !== "admitted") throw new Error("C39 C2 claim was not admitted");
      const recoveryId = claim.record.carrierRecoveryInvocationId;
      const recoveryRequest = recoveryBridgeRequest(
        session.payload.rsid, recoveryId, originInvocationId, originDigest,
      );
      const effective = recoveryRequest.context.effectiveMcpRequestScope;
      if (effective === undefined) throw new Error("C39 C2 request lacks effective MCP scope");
      const recovery = created.createExecutor().execute(recoveryRequest);
      const recoveryInvoke = await emittedInvokeFor(rebound.channel, recoveryId);
      expect(recoveryInvoke.payload).toMatchObject({
        invocation_id: recoveryId, method: "dispatch_payload_recovery",
        params: { origin_invocation_id: originInvocationId, expected_result_digest: originDigest },
      });

      const partial = {
        v: 1 as const, type: "partial" as const, id: id(), rsid: session.payload.rsid,
        seq: 3, ack: recoveryInvoke.seq, ts: new Date().toISOString(), payload: {
          kind: "chunk" as const, invocation_id: recoveryId, stream_id: "result" as const,
          chunk_index: 0, encoding: "base64" as const, content_type: "application/json" as const,
          data: raw.toString("base64"),
        },
      };
      await expect(created.receive(rebound.connectionId, {
        ...partial, payload: { ...partial.payload, invocation_id: id() },
      })).rejects.toBeDefined();
      expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.recovery-chunk/v1")).toEqual([]);
      await expect(created.receive(rebound.connectionId, partial)).resolves.toBeUndefined();
      const afterPartial = fixture.snapshot().records;
      expect(afterPartial.find((row) => row.namespace === "gateway.recovery-chunk/v1")?.value)
        .toMatchObject({ state: "active", bridgeSequence: 3, chunkIndex: 0 });
      expect(afterPartial.find((row) => row.namespace === "gateway.rbp-session/v2")?.value)
        .toMatchObject({ sequence: { sequence: { lastRxSeq: 3 } } });
      expect(objects.keys().length).toBeGreaterThanOrEqual(1);

      expect(afterPartial.some((row) => row.namespace === "gateway.carrier-ack/v1")).toBe(false);
      await created.receive(rebound.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid,
        seq: 4, ack: recoveryInvoke.seq, ts: new Date().toISOString(), payload: {
          kind: "invocation", invocation_id: recoveryId, status: "completed",
          replayed: false, result_digest: originDigest, chunked: true,
          stream_id: "result", content_type: "application/json",
          total_chunks: 1, total_size: raw.byteLength, sha256: originDigest,
          metrics: { execute_ms: 0, request_bytes: 0, response_bytes: raw.byteLength, framing: "length-prefixed" },
        },
      });
      await expect(recovery).resolves.toMatchObject({
        state: "completed",
        result: { kind: "result_ref" },
      });
      const terminalRecords = fixture.snapshot().records;
      expect(terminalRecords.find((row) => row.namespace === "gateway.omitted-payload-recovery/v1")?.value)
        .toMatchObject({
          state: "completed",
          originResultDigest: originDigest,
          resultReferenceDigest: expect.stringMatching(/^sha256:/u),
        });
      expect(terminalRecords.find((row) => row.namespace === "gateway.rbp-session/v2")?.value)
        .toMatchObject({ sequence: { sequence: { lastRxSeq: 4 } } });

      const completedClaim = await created.admitOmittedPayloadRecoveryFromNorth({
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        rsid: session.payload.rsid,
        originInvocationId,
        originResultDigest: originDigest,
      });
      expect(completedClaim).toMatchObject({
        kind: "completed",
        record: { carrierRecoveryInvocationId: recoveryId },
      });
      const invokeCountBeforeReplay = rebound.channel.frames.filter(
        (frame) => frame.type === "invoke",
      ).length;
      await expect(created.replayOmittedPayloadRecoveryReferenceFromNorth({
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        effectiveMcpRequestScope: effective,
        rsid: session.payload.rsid,
        carrierRecoveryInvocationId: recoveryId,
      })).resolves.toMatchObject({ kind: "result_ref" });
      expect(rebound.channel.frames.filter((frame) => frame.type === "invoke"))
        .toHaveLength(invokeCountBeforeReplay);
      await expect(created.admitOmittedPayloadRecoveryFromNorth({
        tenantId: TENANT_ID,
        userId: "foreign-user",
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        rsid: session.payload.rsid,
        originInvocationId,
        originResultDigest: originDigest,
      })).resolves.toEqual({ kind: "guarded" });
      const foreignEffective = createEffectiveMcpRequestScopeV1({
        principalKey: effective.principalKey,
        transportMcpSessionId: "foreign-mcp-session",
        identityMcpSessionId: null,
        nowMs: Date.now(),
      });
      await expect(created.replayOmittedPayloadRecoveryReferenceFromNorth({
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: foreignEffective.effectiveMcpSessionId,
        effectiveMcpRequestScope: foreignEffective,
        rsid: session.payload.rsid,
        carrierRecoveryInvocationId: recoveryId,
      })).resolves.toBeNull();

      await created.receive(rebound.connectionId, {
        v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
        payload: { bridge_version: "m4-route-test", acks: [], sessions: [] },
      });
      expect(rebound.channel.frames.some((frame) => frame.type === "heartbeat_ack")).toBe(true);

      await created.detach(rebound.connectionId);
      const drifted = await openConnection(
        created,
        "wss",
        ["chunked_results", "route_rebind_proof_v1"],
      );
      await created.receive(drifted.connectionId, resumeWithRouteProof({
        rsid: session.payload.rsid,
        resumeToken: session.payload.resume_token,
        connectionId: drifted.connectionId,
        lastRxSeq: recoveryInvoke.seq,
      }));
      await expect(created.admitOmittedPayloadRecoveryFromNorth({
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        rsid: session.payload.rsid,
        originInvocationId,
        originResultDigest: originDigest,
      })).resolves.toEqual({ kind: "guarded" });
      await expect(created.replayOmittedPayloadRecoveryReferenceFromNorth({
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        effectiveMcpRequestScope: effective,
        rsid: session.payload.rsid,
        carrierRecoveryInvocationId: recoveryId,
      })).resolves.toBeNull();
    } finally {
      await created.close().catch(() => undefined);
    }
  });

  it("C2 atomically commits the exact active recovery receipt on SQLite", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "revagent-c39-sqlite-route-"));
    const backing = new SqliteConformanceProtocolStore(root);
    const callbackErrors: unknown[] = [];
    const outcomes: StoreOutcome<unknown>[] = [];
    const protocolStore = observingProtocolStore(backing, callbackErrors, outcomes);
    const objects = createMemoryObjectStore();
    const inventory = Object.freeze({
      kind: "conformance" as const,
      async listLiveKids() { return Object.freeze(["c39-c2-key"]); },
    });
    const keys = new ConformanceProtectedObjectKeyProvider(
      "c39-c2-key", new Map([["c39-c2-key", Buffer.alloc(32, 7)]]), inventory,
    );
    const authorityRef: { current: GatewayBridgeSessionAuthority | null } = { current: null };
    const resources = new GatewayResourceAuthority({
      protocolStore, objectStore: objects,
      protectedObjectStore: new EncryptedProtectedObjectStore(objects, keys),
      reauthorizeRecoveryScope: async (owner) =>
        await authorityRef.current?.resolveCurrentRecoveryAuthoritySnapshot(owner) ?? null,
    });
    const created = new GatewayBridgeSessionAuthority(
      protocolStore,
      identity({ connectionCapabilities: ["chunked_results"] }),
      { resourceAuthority: resources },
    );
    authorityRef.current = created;
    await created.open();
    try {
      const offered = hello();
      offered.payload.capabilities = ["chunked_results"];
      const openedChannel = channel();
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN, binding: "wss", hello: offered, channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration("c39-c2-sqlite"));
      const session = registeredFrame(openedChannel);
      await created.receive(opened.connectionId, contextUpdate({
        rsid: session.payload.rsid, seq: 1, activeDocument: "document-carrier",
        documents: [document("document-carrier", true)],
      }));

      const raw = Buffer.from('{"c39":"sqlite-recovered"}', "utf8");
      const originInvocationId = id();
      const originDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}` as const;
      const origin = created.createExecutor().execute(
        bridgeRequest(session.payload.rsid, originInvocationId),
      );
      const originInvoke = await emittedInvokeFor(openedChannel, originInvocationId);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 2,
        ack: originInvoke.seq, ts: new Date().toISOString(), payload: {
          kind: "invocation", invocation_id: originInvocationId, status: "completed",
          replayed: true, payload_omitted: true, result_digest: originDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await expect(origin).resolves.toMatchObject({ state: "omitted_payload" });
      const rootRead = await protocolStore.transact({ tenantId: TENANT_ID }, (tx) =>
        tx.read("gateway.rbp-session/v2", session.payload.rsid),
      );
      if (!rootRead.ok || rootRead.value === null) throw new Error("SQLite C39 fixture lacks a session root");
      const binding = (rootRead.value.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined) {
        throw new Error("SQLite C39 fixture lacks a current owner binding");
      }
      const claim = await created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId, originResultDigest: originDigest,
        newCarrierRecoveryInvocationId: id(),
      });
      if (claim.kind !== "admitted") throw new Error("SQLite C39 claim was not admitted");
      const recoveryId = claim.record.carrierRecoveryInvocationId;
      const recoveryRequest = recoveryBridgeRequest(
        session.payload.rsid, recoveryId, originInvocationId, originDigest,
      );
      const recovery = created.createExecutor().execute(recoveryRequest);
      const recoveryInvoke = await emittedInvokeFor(openedChannel, recoveryId);
      const partial = {
        v: 1 as const, type: "partial" as const, id: id(), rsid: session.payload.rsid,
        seq: 3, ack: recoveryInvoke.seq, ts: new Date().toISOString(), payload: {
          kind: "chunk" as const, invocation_id: recoveryId, stream_id: "result" as const,
          chunk_index: 0, encoding: "base64" as const, content_type: "application/json" as const,
          data: raw.toString("base64"),
        },
      };
      const effective = recoveryRequest.context.effectiveMcpRequestScope!;
      const owner = Object.freeze({
        tenantId: TENANT_ID, userId: USER_ID, principalKey: effective.principalKey,
        effectiveMcpSessionId: effective.effectiveMcpSessionId,
        sessionBindingId: binding.sessionBindingId, sessionBindingVersion: binding.sessionVersion,
        rsid: session.payload.rsid, recoveryInvocationId: recoveryId,
        originInvocationId, originResultDigest: originDigest,
      });
      await expect(resources.stageRecoveryChunk({
        scope: { tenantId: TENANT_ID, actorId: USER_ID, principalKey: effective.principalKey,
          mcpSessionId: effective.effectiveMcpSessionId },
        effectiveMcpRequestScope: effective,
        owner,
        bridgeSequence: partial.seq,
        chunkIndex: partial.payload.chunk_index,
        contentType: partial.payload.content_type,
        data: partial.payload.data,
        commitBridge: async () => { throw new Error("test recovery activation lost before durable Bridge commit"); },
      })).rejects.toBeDefined();
      const interrupted = await protocolStore.transact({ tenantId: TENANT_ID }, async (tx) => ({
        recovery: await tx.list("gateway.recovery-chunk/v1"),
        generic: await tx.list("gateway.carrier-chunk/v1"),
      }));
      expect(interrupted).toMatchObject({ ok: true });
      if (!interrupted.ok) throw new Error(interrupted.message);
      expect(interrupted.value.recovery[0]?.value).toMatchObject({ state: "writing", bridgeSequence: 3, chunkIndex: 0 });
      expect(interrupted.value.generic).toEqual([]);
      callbackErrors.length = 0;
      outcomes.length = 0;

      await created.detach(opened.connectionId);
      const reboundHello = hello();
      reboundHello.payload.capabilities = ["chunked_results"];
      const reboundChannel = channel();
      const rebound = await created.openConnection({
        deviceToken: DEVICE_TOKEN, binding: "wss", hello: reboundHello, channel: reboundChannel,
      });
      await created.receive(rebound.connectionId, {
        v: 1, type: "session_resume", id: id(), ts: new Date().toISOString(),
        payload: { rsid: session.payload.rsid, resume_token: session.payload.resume_token,
          last_rx_seq: recoveryInvoke.seq },
      });

      let receiveError: unknown;
      try {
        await created.receive(rebound.connectionId, partial);
      } catch (error) {
        receiveError = error;
      }
      if (receiveError !== undefined) {
        const callbackDetail = callbackErrors.map((error) =>
          error instanceof Error ? `${error.name}:${error.message}` : String(error));
        const failedOutcomes = outcomes.filter((outcome) => !outcome.ok);
        throw new Error(`SQLite C39 retry failed: receive=${String(receiveError)} callback=${JSON.stringify(callbackDetail)} outcomes=${JSON.stringify(failedOutcomes)}`);
      }
      const afterPartial = await protocolStore.transact({ tenantId: TENANT_ID }, async (tx) => ({
        recovery: await tx.list("gateway.recovery-chunk/v1"),
        generic: await tx.list("gateway.carrier-chunk/v1"),
        session: await tx.read("gateway.rbp-session/v2", session.payload.rsid),
      }));
      expect(afterPartial).toMatchObject({ ok: true });
      if (!afterPartial.ok) throw new Error(afterPartial.message);
      expect(afterPartial.value.recovery[0]?.value).toMatchObject({ state: "active", bridgeSequence: 3, chunkIndex: 0 });
      expect(afterPartial.value.generic).toEqual([]);
      expect(afterPartial.value.session?.value).toMatchObject({ sequence: { sequence: { lastRxSeq: 3 } } });
      void recovery.catch(() => undefined);
    } finally {
      await created.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
