import { createHash } from "node:crypto";

import {
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
  GATEWAY_RBP_UNREGISTER_NAMESPACE,
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createRestartableTestStore } from "./testAdapters.js";

const TENANT_ID = "tenant-unregister";
const USER_ID = "user-unregister";
const DEVICE_ID = "device-unregister";
const DEVICE_TOKEN = "device-token-unregister";
const OTHER_USER_ID = "other-user-unregister";
const OTHER_DEVICE_ID = "other-device-unregister";
const OTHER_DEVICE_TOKEN = "other-device-token-unregister";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function tokenDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identity(): IdentityPort {
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
      const authenticatedToken = input.deviceToken === OTHER_DEVICE_TOKEN
        ? OTHER_DEVICE_TOKEN
        : DEVICE_TOKEN;
      const actor = input.deviceToken === DEVICE_TOKEN
        ? { userId: USER_ID, deviceId: DEVICE_ID, seatId: "seat-unregister" }
        : input.deviceToken === OTHER_DEVICE_TOKEN
          ? {
              userId: OTHER_USER_ID,
              deviceId: OTHER_DEVICE_ID,
              seatId: "seat-other-unregister",
            }
          : null;
      if (actor === null) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "device identity is unavailable",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: { type: "device", tenantId: TENANT_ID, ...actor },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedSessionCapabilities: ["partial_progress"],
        deviceTokenDigest: tokenDigest(authenticatedToken),
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(deviceId = DEVICE_ID): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["partial_progress"],
      bridge_version: "wp02-unregister-test",
      device_id: deviceId,
      machine: { hostname: "petrucci", os: "windows" },
      addin_versions: ["wp02-unregister-test"],
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
      local_session_key: "wp02-unregister-local",
      user_hint: { name: "fixture" },
      machine: {
        hostname: "petrucci",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2022", build: "fixture", pid: 4321 },
      addin_version: "wp02-unregister-test",
      result_contract_version: 1,
      session_capabilities: ["partial_progress"],
      bridge_version: "wp02-unregister-test",
      documents: [],
      port: 48884,
    },
  };
}

function unregister(
  rsid: string,
  reason: Extract<RbpEnvelope, { type: "session_unregister" }>["payload"]["reason"] = "revit_exited",
): Extract<RbpEnvelope, { type: "session_unregister" }> {
  return {
    v: 1,
    type: "session_unregister",
    id: id(),
    ts: new Date().toISOString(),
    payload: { rsid, reason },
  };
}

function resume(
  rsid: string,
  resumeToken: string,
): Extract<RbpEnvelope, { type: "session_resume" }> {
  return {
    v: 1,
    type: "session_resume",
    id: id(),
    ts: new Date().toISOString(),
    payload: { rsid, resume_token: resumeToken, last_rx_seq: 0 },
  };
}

interface TestChannel extends BridgeConnectionChannel {
  readonly frames: RbpEnvelope[];
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
  const frame = channel.frames.find(
    (candidate): candidate is SessionRegisteredEnvelope =>
      candidate.type === "session_registered",
  );
  if (frame === undefined) throw new Error("session_registered was not emitted");
  return frame;
}

async function openConnection(
  authority: GatewayBridgeSessionAuthority,
  input: { readonly token?: string; readonly deviceId?: string } = {},
): Promise<{ readonly connectionId: string; readonly channel: TestChannel }> {
  const openedChannel = channel();
  const opened = await authority.openConnection({
    deviceToken: input.token ?? DEVICE_TOKEN,
    binding: "wss",
    hello: hello(input.deviceId ?? DEVICE_ID),
    channel: openedChannel,
  });
  return { connectionId: opened.connectionId, channel: openedChannel };
}

async function register(authority: GatewayBridgeSessionAuthority) {
  const opened = await openConnection(authority);
  await authority.receive(opened.connectionId, registration());
  const registered = registeredFrame(opened.channel);
  return {
    ...opened,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
  };
}

function request(rsid: string, mutating: boolean): GatewayExecutorRequest {
  const args: GatewayJsonObject = { probe: "wp02-unregister" };
  const invocationId = id();
  return {
    toolName: mutating ? "core.set_parameter" : "core.get_status",
    toolVersion: "1.0.0",
    executorMethod: mutating ? "set_element_parameter" : "get_revit_mcp_status",
    policyClass: "auto",
    mutationScopePolicy: mutating ? "session" : "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: `${TENANT_ID}:${USER_ID}`,
      actor: { tenantId: TENANT_ID, userId: USER_ID, role: "user" },
      gatewaySessionId: "gateway-unregister",
      oauthClientId: "oauth-unregister",
      mcpSessionId: "mcp-unregister",
      rsid,
      toolName: mutating ? "core.set_parameter" : "core.get_status",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: mutating ? "session" : "none",
      mutating,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "document-unregister" },
      paramsDigest: `sha256:${"1".repeat(64)}`,
      mutationScope: mutating ? { kind: "session" } : null,
      startedAtMs: Date.now(),
    },
  };
}

describe("GatewayBridgeSessionAuthority durable unregister", () => {
  const authorities: GatewayBridgeSessionAuthority[] = [];

  afterEach(async () => {
    await Promise.all(authorities.splice(0).map(async (authority) => authority.close()));
  });

  it("never resumes an old token on the same socket or after restart", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);

    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(
      authority.receive(session.connectionId, resume(session.rsid, session.resumeToken)),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });

    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    const restarted = new GatewayBridgeSessionAuthority(restartable.restart(), identity());
    authorities.push(restarted);
    await restarted.open();
    const fresh = await openConnection(restarted);
    await expect(
      restarted.receive(fresh.connectionId, resume(session.rsid, session.resumeToken)),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });
  });

  it("makes an exact same-owner unregister replay a durable no-op", async () => {
    const authority = new GatewayBridgeSessionAuthority(createRestartableTestStore().store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    await authority.receive(session.connectionId, unregister(session.rsid, "bridge_shutdown"));

    const replay = await openConnection(authority);
    await expect(
      authority.receive(replay.connectionId, unregister(session.rsid, "bridge_shutdown")),
    ).resolves.toBeUndefined();
  });

  it("rejects changed-reason and cross-owner unregister replays with 4403", async () => {
    const authority = new GatewayBridgeSessionAuthority(createRestartableTestStore().store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    await authority.receive(session.connectionId, unregister(session.rsid, "revit_exited"));

    const sameOwner = await openConnection(authority);
    await expect(
      authority.receive(sameOwner.connectionId, unregister(session.rsid, "bridge_shutdown")),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });

    const otherOwner = await openConnection(authority, {
      token: OTHER_DEVICE_TOKEN,
      deviceId: OTHER_DEVICE_ID,
    });
    await expect(
      authority.receive(otherOwner.connectionId, unregister(session.rsid, "revit_exited")),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });
  });

  it("closes a pending read but persists an indeterminate mutation hold", async () => {
    const store = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(store.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);

    const read = authority.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(read).resolves.toMatchObject({
      state: "failed",
      error: { code: "revit_timeout" },
    });
    const readTombstone = store.snapshot().records.find(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    );
    expect(readTombstone?.value).toMatchObject({
      pendingDisposition: { kind: "read_closed", verificationHoldIds: [] },
    });

    const second = await register(authority);
    const mutation = authority.createExecutor().execute(request(second.rsid, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(second.connectionId, unregister(second.rsid));
    await expect(mutation).resolves.toMatchObject({
      state: "failed",
      error: { code: "journal_indeterminate" },
    });
    const tombstones = store.snapshot().records.filter(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    );
    expect(tombstones.at(-1)?.value).toMatchObject({
      pendingDisposition: {
        kind: "mutation_indeterminate",
        correlationId: expect.any(String),
        verificationHoldIds: [expect.any(String)],
      },
    });
  });

  it("adds a tombstone beside a legacy v1 session row without requiring v2 normalization", async () => {
    const store = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(store.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    const legacyBefore = store.snapshot().records.find(
      (record) => record.namespace === "gateway.rbp-session/v1" && record.key === session.rsid,
    );
    expect(legacyBefore).toBeDefined();
    expect(legacyBefore?.value).not.toHaveProperty("unregisterTombstone");

    await authority.receive(session.connectionId, unregister(session.rsid));

    const rows = store.snapshot().records.filter((record) => record.key === session.rsid);
    expect(rows.map((record) => record.namespace).sort()).toEqual([
      "gateway.rbp-session/v1",
      GATEWAY_RBP_UNREGISTER_NAMESPACE,
    ]);
    expect(rows.find((record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE)?.value)
      .toMatchObject({ version: 1, tenantId: TENANT_ID, rsid: session.rsid });
  });
});
