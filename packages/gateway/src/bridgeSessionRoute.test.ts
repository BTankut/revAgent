import { createHash } from "node:crypto";

import {
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
  GatewayBridgeSessionAuthority,
  GatewayRbpFault,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createRestartableTestStore } from "./testAdapters.js";

const TENANT_ID = "tenant-route";
const USER_ID = "user-route";
const DEVICE_ID = "device-route";
const MCP_SESSION_ID = "mcp-route";
const DEVICE_TOKEN = "device-token-route";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function identity(): IdentityPort {
  const deviceTokenDigest = `sha256:${createHash("sha256")
    .update(DEVICE_TOKEN)
    .digest("hex")}` as const;
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
        grantedSessionCapabilities: ["partial_progress"],
        deviceTokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["partial_progress"],
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
): Promise<{ readonly connectionId: string; readonly channel: TestChannel }> {
  const openedChannel = channel();
  const opened = await authority.openConnection({
    deviceToken: DEVICE_TOKEN,
    binding: "wss",
    hello: hello(),
    channel: openedChannel,
  });
  return { connectionId: opened.connectionId, channel: openedChannel };
}

async function register(
  authority: GatewayBridgeSessionAuthority,
  localSessionKey = "local-route",
) {
  const opened = await openConnection(authority);
  await authority.receive(opened.connectionId, registration(localSessionKey));
  const registered = registeredFrame(opened.channel);
  return {
    ...opened,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
  };
}

function resolve(authority: GatewayBridgeSessionAuthority) {
  return authority.resolveLiveInvocationRoute({
    tenantId: TENANT_ID,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    mcpSessionId: MCP_SESSION_ID,
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
      rsid: session.rsid,
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live",
      },
    });
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
});
