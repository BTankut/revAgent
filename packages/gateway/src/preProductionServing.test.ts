import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  HelloEnvelope,
  RbpEnvelope,
  SessionRegisteredEnvelope,
} from "@revagent/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createPreProductionRuntimeAdapters,
} from "./preProductionRuntimeAdapters.js";
import type { GatewayEventEnvelope } from "./events.js";
import {
  preparePreProductionServing,
  type PreparedPreProductionServing,
  type PreProductionServingDependencies,
  type PreProductionServingOptions,
} from "./preProductionServing.js";
import {
  launchPreProductionServing,
  launchPreProductionServingOwned,
  safePreProductionStartupReason,
  type PreProductionServingCliDependencies,
} from "./preProductionServingCli.js";
import {
  createGatewayApp,
  type GatewayServerHandle,
  type GatewayServerTlsMaterial,
} from "./server.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import type { AuthorizedNorthMcpRequest } from "./northMcpEndpoint.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const NOW_MS = 1_800_000_000_000;
const NORTH_TOKEN = "SYNTHETIC-M4-NORTH-BEARER-TOKEN-000000000001";
const IDENTITY_KEY = "SYNTHETIC-M4-IDENTITY-TOKEN-KEY-000000000001";
const REQUEST_KEY = "SYNTHETIC-M4-REQUEST-STATE-KEY-000000000001";
const CREDENTIAL_PATH = "/run/revagent/m4/credentials.json";
const SEED_PATH = "/app/packages/gateway/registry-seed.json";
const KEY_PATH = "/run/revagent/m4/tls.key";
const CERT_PATH = "/run/revagent/m4/tls.crt";
const ARTIFACT_PATH = "/run/revagent/m4/enrollment.json";
const MACHINE_FINGERPRINT = `sha256:${"4".repeat(64)}`;
const AUDIT_CANARIES = Object.freeze({
  tenantId: "SYNTHETIC-AUDIT-TENANT__HEAD__DO-NOT-EMIT",
  userId: "SYNTHETIC-AUDIT-USER__MIDDLE__DO-NOT-EMIT",
  sessionId: "SYNTHETIC-AUDIT-SESSION__TAIL__DO-NOT-EMIT",
  oauthClientId: "SYNTHETIC-AUDIT-OAUTH__MIDDLE__DO-NOT-EMIT",
  idempotencyKey: "SYNTHETIC-AUDIT-IDEMPOTENCY__TAIL__DO-NOT-EMIT",
  mcpSessionId: "SYNTHETIC-AUDIT-MCP-SESSION__HEAD__DO-NOT-EMIT",
});
let rbpIdOffset = 0;
const rbpId = (): string => gatewayUuidV7(NOW_MS + rbpIdOffset++);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_SEED = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
) as unknown;

function environment(nodeEnv = "preproduction"): NodeJS.ProcessEnv {
  return {
    NODE_ENV: nodeEnv,
    LOG_LEVEL: "fatal",
    GATEWAY_BIND_HOST: "0.0.0.0",
    PORT: "18443",
    GATEWAY_PUBLIC_URL: "https://m4-gateway.example.test:18443",
  };
}

function options(
  overrides: Partial<PreProductionServingOptions> = {},
): PreProductionServingOptions {
  return {
    profile: "lan_test",
    mode: "preproduction",
    environment: environment(),
    credentialFilePath: CREDENTIAL_PATH,
    registrySeed: RAW_SEED,
    principal: {
      tenantId: "tenant-m4-serving",
      userId: "user-m4-serving",
      role: "user",
      sessionId: "gateway-session-m4-serving",
      oauthClientId: "m4-client-serving",
    },
    device: {
      enrollmentId: "enrollment-m4-serving",
      deviceId: "device-m4-serving",
      seatId: "seat-m4-serving",
      machineFingerprint: MACHINE_FINGERPRINT,
      grantedSessionCapabilities: [
        "transport_streamable_http",
        "partial_progress",
      ],
    },
    clock: () => NOW_MS,
    ...overrides,
  };
}

function fakeHandle(): GatewayServerHandle {
  return {
    app: {} as FastifyInstance,
    url: "https://127.0.0.1:18443",
    port: 18443,
    beginShutdown: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function dependencies(): {
  readonly value: PreProductionServingDependencies;
  readonly counts: Record<string, number>;
  readonly handle: GatewayServerHandle;
} {
  const counts: Record<string, number> = {
    credential: 0,
    runtime: 0,
    seed: 0,
    start: 0,
  };
  const handle = fakeHandle();
  return {
    counts,
    handle,
    value: {
      async loadCredential() {
        counts.credential += 1;
        return {
          contractVersion: "revagent.m4-preproduction-credentials/v1",
          profile: "lan_test",
          mode: "preproduction",
          northAuthorization: `Bearer ${NORTH_TOKEN}`,
          identityTokenKey: IDENTITY_KEY,
          requestStateHmacKey: REQUEST_KEY,
        };
      },
      createRuntimeAdapters({ clock }) {
        counts.runtime += 1;
        return createPreProductionRuntimeAdapters({
          clock,
          entitlement: {
            allowedModules: ["core"],
            allowedToolNames: ["core.ui.state"],
          },
        });
      },
      verifySeed(candidate) {
        counts.seed += 1;
        return verifyRegistrySeed(candidate);
      },
      async startServer({ composition, tls }) {
        counts.start += 1;
        expect(composition.ports.identity).toBe(composition.identity);
        expect(composition.rbpIngress.authority).toBe(
          composition.bridgeAuthority,
        );
        expect(tls.key.toString()).toBe("SYNTHETIC-TLS-KEY");
        return handle;
      },
    },
  };
}

function installEventProbe(
  fixture: ReturnType<typeof dependencies>,
  options: { readonly flushError?: Error } = {},
) {
  const originalCreate = fixture.value.createRuntimeAdapters;
  let baseEvents:
    | ReturnType<typeof createPreProductionRuntimeAdapters>["events"]
    | undefined;
  let flushCompleted = false;
  const flush = vi.fn(async () => {
    if (options.flushError !== undefined) throw options.flushError;
    if (baseEvents === undefined) throw new Error("event probe unavailable");
    const result = await baseEvents.flush();
    flushCompleted = result.ok;
    return result;
  });
  const snapshot = vi.fn(() => {
    if (!flushCompleted || baseEvents === undefined) {
      throw new Error("snapshot before successful flush");
    }
    return baseEvents.snapshot();
  });
  fixture.value.createRuntimeAdapters = ({ clock }) => {
    const adapters = originalCreate({ clock });
    baseEvents = adapters.events;
    return Object.freeze({
      ...adapters,
      events: Object.freeze({
        kind: adapters.events.kind,
        emit: (event: GatewayEventEnvelope) => adapters.events.emit(event),
        emitBatch: (events: readonly GatewayEventEnvelope[]) =>
          adapters.events.emitBatch(events),
        flush,
        snapshot,
      }),
    });
  };
  return Object.freeze({ flush, snapshot });
}

function auditPrincipal(): PreProductionServingOptions["principal"] {
  return Object.freeze({
    tenantId: AUDIT_CANARIES.tenantId,
    userId: AUDIT_CANARIES.userId,
    role: "user" as const,
    sessionId: AUDIT_CANARIES.sessionId,
    oauthClientId: AUDIT_CANARIES.oauthClientId,
  });
}

function auditInvocationEvent(): GatewayEventEnvelope {
  const eventId = rbpId();
  const attemptId = rbpId();
  const invocationId = rbpId();
  const recordedAt = new Date(NOW_MS).toISOString();
  return {
    schema: "revagent.event.v2",
    event_id: eventId,
    event_type: "tool.invocation",
    occurred_at: recordedAt,
    recorded_at: recordedAt,
    tenant_id: AUDIT_CANARIES.tenantId,
    source: {
      component: "revagent-gateway",
      version: "revagent.m4-preproduction-serving/v1",
      instance: "m4-lan-test",
    },
    actor: { type: "user", user_id: AUDIT_CANARIES.userId },
    session_id: AUDIT_CANARIES.sessionId,
    seq: 1,
    payload: {
      dispatch_attempt_id: attemptId,
      invocation_id: invocationId,
      idempotency_key: AUDIT_CANARIES.idempotencyKey,
      principal_key: `${AUDIT_CANARIES.tenantId}:${AUDIT_CANARIES.userId}`,
      actor_role: "user",
      gateway_session_id: AUDIT_CANARIES.sessionId,
      oauth_client_id: AUDIT_CANARIES.oauthClientId,
      mcp_session_id: AUDIT_CANARIES.mcpSessionId,
      rsid: null,
      tool_name: "core.ui.state",
      tool_version: "1.0.0",
      policy_class: "auto",
      policy_decision: "auto",
      confirmation_id: null,
      originating_preview_invocation_id: null,
      preview_digest: null,
      preview_ref: null,
      commit_args_digest: null,
      confirmation_reason: null,
      mutation_scope_policy: "none",
      mutating: false,
      executor: "bridge",
      document_identity: null,
      params_digest: `sha256:${"a".repeat(64)}`,
      mutation_scope: null,
      recovery_hold_ids: [],
      recovery_resolution_ids: [],
      outcome: "completed",
      outcome_error_code: null,
      executor_reached: true,
      started_at_ms: NOW_MS - 25,
      completed_at_ms: NOW_MS,
      duration_ms: 25,
    },
  };
}

describe("M4 pre-production serving composition", () => {
  it("does not register C39 from a key-file setting without a durable inventory", async () => {
    await expect(preparePreProductionServing({
      ...options(),
      environment: { ...options().environment, C39_PROTECTED_OBJECT_KEY_FILE: "/run/revagent/c39-key.json" },
    })).rejects.toMatchObject({ reason: "c39_protected_object_unavailable" });
  });
  it("loads one credential and builds one inspectable identity/store/Bridge/north graph", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );

    expect(fixture.counts).toEqual({
      credential: 1,
      runtime: 1,
      seed: 1,
      start: 0,
    });
    expect(prepared.composition.ports.identity).toBe(
      prepared.composition.identity,
    );
    expect(prepared.composition.bridgeAuthority.identity).toBe(
      prepared.composition.identity,
    );
    expect(prepared.composition.bridgeAuthority.store).toBe(
      prepared.composition.ports.protocolStore,
    );
    expect(prepared.composition.ports.objectStore.kind).toBe("unavailable");
    expect(Object.hasOwn(prepared.composition, "resourceAuthority")).toBe(false);
    expect(prepared.composition.northAuthenticator.identity).toBe(
      prepared.composition.identity,
    );
    expect(prepared.enrollment.enrollmentToken).toMatch(/^pp-enrollment-/u);

    const north = await prepared.composition.identity.authenticateNorthRequest({
      authorization: `Bearer ${NORTH_TOKEN}`,
    });
    expect(north).toMatchObject({
      ok: true,
      value: {
        principalKey: "tenant-m4-serving:user-m4-serving",
      },
    });
  });

  it("flushes before projecting one registry-bound value-free audit snapshot", async () => {
    const fixture = dependencies();
    const probe = installEventProbe(fixture);
    const prepared = await preparePreProductionServing(
      options({ principal: auditPrincipal() }),
      fixture.value,
    );
    await expect(
      prepared.composition.ports.events.emit(auditInvocationEvent()),
    ).resolves.toEqual({ ok: true, value: undefined });

    const bundle = await prepared.exportAuditSnapshot();

    expect(probe.flush).toHaveBeenCalledOnce();
    expect(probe.snapshot).toHaveBeenCalledOnce();
    expect(probe.flush.mock.invocationCallOrder[0]).toBeLessThan(
      probe.snapshot.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(bundle).toMatchObject({
      contractVersion: "revagent.m4-value-free-audit-export/v1",
      profile: "lan_test",
      mode: "preproduction",
      approvedLiveSelector: true,
      complete: true,
      selector: {
        tenantBound: true,
        userBound: true,
        principalBound: true,
        gatewaySessionBound: true,
      },
      recordCount: 1,
      records: [
        {
          recordType: "invocation",
          toolName: "core.ui.state",
          toolVersion: "1.0.0",
          policyClass: "auto",
          mutationScopePolicy: "none",
          executor: "bridge",
          outcome: "completed",
        },
      ],
    });
    const retained = JSON.stringify(bundle);
    for (const canary of Object.values(AUDIT_CANARIES)) {
      expect(retained).not.toContain(canary);
    }
    for (const fragment of ["SYNTHETIC-", "HEAD", "MIDDLE", "TAIL"]) {
      expect(retained).not.toContain(fragment);
    }
  });

  it("transfers audit ownership before awaiting flush and refuses every later attempt", async () => {
    const fixture = dependencies();
    const probe = installEventProbe(fixture);
    const prepared = await preparePreProductionServing(
      options({ principal: auditPrincipal() }),
      fixture.value,
    );
    await prepared.composition.ports.events.emit(auditInvocationEvent());

    const first = prepared.exportAuditSnapshot();
    await expect(prepared.exportAuditSnapshot()).rejects.toMatchObject({
      code: "preproduction_audit_export_refused",
      reason: "already_attempted",
    });
    await expect(first).resolves.toMatchObject({ recordCount: 1 });
    await expect(prepared.exportAuditSnapshot()).rejects.toMatchObject({
      code: "preproduction_audit_export_refused",
      reason: "already_attempted",
    });
    expect(probe.flush).toHaveBeenCalledOnce();
    expect(probe.snapshot).toHaveBeenCalledOnce();
  });

  it("maps source failure to a value-free refusal without taking a snapshot or retrying", async () => {
    const sourceCanary =
      "SYNTHETIC-AUDIT-SOURCE__HEAD__MIDDLE__TAIL__DO-NOT-EMIT";
    const fixture = dependencies();
    const probe = installEventProbe(fixture, {
      flushError: new Error(sourceCanary),
    });
    const prepared = await preparePreProductionServing(
      options({ principal: auditPrincipal() }),
      fixture.value,
    );

    let caught: unknown;
    try {
      await prepared.exportAuditSnapshot();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "preproduction_audit_export_refused",
      reason: "source_unavailable",
    });
    const retained = `${JSON.stringify(caught)}${String(caught)}${String(
      (caught as Error | undefined)?.stack,
    )}`;
    expect(retained).not.toContain(sourceCanary);
    expect(retained).not.toContain("SYNTHETIC-");
    expect(probe.flush).toHaveBeenCalledOnce();
    expect(probe.snapshot).not.toHaveBeenCalled();
    await expect(prepared.exportAuditSnapshot()).rejects.toMatchObject({
      reason: "already_attempted",
    });
    expect(probe.flush).toHaveBeenCalledOnce();
  });

  it("mounts enrollment on the composed RBP host and exchanges through that same identity", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );
    const app = Fastify({ logger: false });
    prepared.composition.rbpIngress.mount?.(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/bridge/v1/enroll",
        headers: { "content-type": "application/json" },
        payload: {
          enrollment_token: prepared.enrollment.enrollmentToken,
          machine_fingerprint: MACHINE_FINGERPRINT,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const exchanged = response.json<{
        device_id: string;
        device_token: string;
      }>();
      expect(exchanged.device_id).toBe("device-m4-serving");
      await expect(
        prepared.composition.identity.authenticateDevice({
          deviceToken: exchanged.device_token,
          connectionId: "connection-m4-serving",
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("refuses enrollment during shared ingress drain without consuming the token", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );
    const app = Fastify({ logger: false });
    prepared.composition.rbpIngress.mount?.(app);
    prepared.composition.rbpIngress.beginDrain?.();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/bridge/v1/enroll",
        headers: { "content-type": "application/json" },
        payload: {
          enrollment_token: prepared.enrollment.enrollmentToken,
          machine_fingerprint: MACHINE_FINGERPRINT,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        ok: false,
        state: "unavailable",
        error: "enrollment_exchange_unavailable",
      });
      expect(
        prepared.composition.identity.exchangeEnrollmentToken({
          enrollmentToken: prepared.enrollment.enrollmentToken,
          machineFingerprint: MACHINE_FINGERPRINT,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("routes the prepared north graph through its accepted live document context", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );
    const authority = prepared.composition.bridgeAuthority;
    await authority.open();
    try {
      const exchanged = prepared.composition.identity.exchangeEnrollmentToken({
        enrollmentToken: prepared.enrollment.enrollmentToken,
        machineFingerprint: MACHINE_FINGERPRINT,
      });
      expect(exchanged.ok).toBe(true);
      if (!exchanged.ok) return;

      const frames: RbpEnvelope[] = [];
      const hello: HelloEnvelope = {
        type: "hello",
        id: rbpId(),
        ts: new Date(NOW_MS).toISOString(),
        payload: {
          min_protocol: 1,
          max_protocol: 1,
          capabilities: ["partial_progress"],
          bridge_version: "m4-serving-test",
          device_id: "device-m4-serving",
          machine: { hostname: "petrucci", os: "windows" },
          addin_versions: ["m4-serving-test"],
        },
      };
      const opened = await authority.openConnection({
        deviceToken: exchanged.value.deviceToken,
        binding: "wss",
        hello,
        channel: {
          async send(serialized): Promise<void> {
            frames.push(JSON.parse(serialized) as RbpEnvelope);
          },
          async close(): Promise<void> {},
        },
      });
      await authority.receive(opened.connectionId, {
        v: 1,
        type: "session_register",
        id: rbpId(),
        ts: new Date(NOW_MS).toISOString(),
        payload: {
          local_session_key: "petrucci-local-session",
          user_hint: { name: "M4 serving fixture" },
          machine: {
            hostname: "petrucci",
            fingerprint: MACHINE_FINGERPRINT,
          },
          revit: { version: "2022", build: "fixture", pid: 4321 },
          addin_version: "m4-serving-test",
          result_contract_version: 1,
          session_capabilities: ["partial_progress"],
          bridge_version: "m4-serving-test",
          documents: [],
          port: 48884,
        },
      });
      const registered = frames.find(
        (frame): frame is SessionRegisteredEnvelope =>
          frame.type === "session_registered",
      );
      expect(registered).toBeDefined();
      if (registered === undefined) return;
      await authority.receive(opened.connectionId, {
        v: 1,
        type: "doc_context_update",
        id: rbpId(),
        rsid: registered.payload.rsid,
        seq: 1,
        ts: new Date(NOW_MS).toISOString(),
        payload: {
          documents: [
            {
              document_id: "petrucci-document-live",
              title: "M4 read-only sample",
              path_digest: null,
              is_workshared: false,
              is_active: true,
            },
          ],
          active_document: "petrucci-document-live",
          active_view: null,
        },
      });

      const north = await prepared.composition.identity.authenticateNorthRequest({
        authorization: `Bearer ${NORTH_TOKEN}`,
      });
      expect(north.ok).toBe(true);
      if (!north.ok) return;
      const authenticated: AuthorizedNorthMcpRequest = {
        authInfo: {
          clientId: "m4-client-serving",
          scopes: ["mcp:tools"],
          resource: new URL("/mcp", prepared.composition.config.publicUrl),
        },
        authContext: north.value,
        principalKey: north.value.principalKey,
      };
      const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
        principalKey: authenticated.principalKey,
        transportMcpSessionId: "mcp-session-serving-live",
        identityMcpSessionId: null,
        nowMs: 1_775_000_000_000,
      });
      const route = await Promise.resolve(
        prepared.composition.northMcp.invocationRouteFor(
          authenticated,
          "mcp-session-serving-live",
          effectiveMcpRequestScope,
        ),
      );
      expect(route).toEqual({
        tenantId: "tenant-m4-serving",
        effectiveMcpRequestScope,
        mcpSessionId: "mcp-session-serving-live",
        rsid: registered.payload.rsid,
        documentIdentity: {
          kind: "live",
          session_document_id: "petrucci-document-live",
        },
      });
    } finally {
      await authority.close();
    }
  });

  it("starts only once with explicit TLS and exposes deterministic revoke refusal", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );
    const exchange = prepared.composition.identity.exchangeEnrollmentToken({
      enrollmentToken: prepared.enrollment.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(exchange.ok).toBe(true);
    if (!exchange.ok) return;

    const tls: GatewayServerTlsMaterial = {
      key: Buffer.from("SYNTHETIC-TLS-KEY"),
      cert: Buffer.from("SYNTHETIC-TLS-CERT"),
    };
    await expect(prepared.start(tls)).resolves.toBe(fixture.handle);
    await expect(prepared.start(tls)).rejects.toMatchObject({
      code: "preproduction_serving_refused",
      reason: "invalid_invocation",
    });
    expect(fixture.counts.start).toBe(1);

    await prepared.composition.bridgeAuthority.open();
    await expect(prepared.revokeConfiguredDevice()).resolves.toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked" },
    });
    await expect(
      prepared.composition.bridgeAuthority.openConnection({
        deviceToken: exchange.value.deviceToken,
        binding: "wss",
        hello: {
          type: "hello",
          id: "018f0f7a-3f5e-7c00-8000-000000000091",
          ts: new Date(NOW_MS).toISOString(),
          payload: {
            min_protocol: 1,
            max_protocol: 1,
            capabilities: ["partial_progress"],
            bridge_version: "m4-serving-test",
            device_id: "device-m4-serving",
            machine: { hostname: "petrucci", os: "windows" },
            addin_versions: ["m4-serving-test"],
          },
        },
        channel: { async send() {}, async close() {} },
      }),
    ).rejects.toMatchObject({ code: "auth", httpStatus: 403, closeCode: 4403 });
    await prepared.composition.bridgeAuthority.close();
  });

  it("refuses a pre-production composition before listener creation when TLS is absent", async () => {
    const fixture = dependencies();
    const prepared = await preparePreProductionServing(
      options(),
      fixture.value,
    );
    expect(() =>
      createGatewayApp({
        config: prepared.composition.config,
        ports: prepared.composition.ports,
        northMcp: prepared.composition.northMcp,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "gateway_composition_refused",
        reason: "preproduction_tls_required",
      }),
    );
  });

  it("refuses production before credential, seed, adapter, or listener dependencies", async () => {
    const fixture = dependencies();
    await expect(
      preparePreProductionServing(
        options({ environment: environment("production") }),
        fixture.value,
      ),
    ).rejects.toMatchObject({
      code: "preproduction_serving_refused",
      reason: "production_mode_refused",
    });
    expect(fixture.counts).toEqual({
      credential: 0,
      runtime: 0,
      seed: 0,
      start: 0,
    });
  });

  it("maps credential failures to a value-free refusal", async () => {
    const sentinel = "SYNTHETIC-M4-SECRET-SENTINEL-DO-NOT-EMIT";
    const fixture = dependencies();
    fixture.value.loadCredential = async () => {
      throw new Error(sentinel);
    };
    let caught: unknown;
    try {
      await preparePreProductionServing(options(), fixture.value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "preproduction_serving_refused",
      reason: "invalid_invocation",
    });
    expect(JSON.stringify(caught)).not.toContain(sentinel);
    expect(fixture.counts.runtime).toBe(0);
    expect(fixture.counts.start).toBe(0);
  });
});

function cliArguments(): string[] {
  return [
    "--credential-file", CREDENTIAL_PATH,
    "--registry-seed-file", SEED_PATH,
    "--tls-key-file", KEY_PATH,
    "--tls-cert-file", CERT_PATH,
    "--enrollment-output-file", ARTIFACT_PATH,
    "--profile", "lan_test",
    "--mode", "preproduction",
    "--tenant-id", "tenant-m4-serving",
    "--user-id", "user-m4-serving",
    "--role", "user",
    "--gateway-session-id", "gateway-session-m4-serving",
    "--oauth-client-id", "m4-client-serving",
    "--enrollment-id", "enrollment-m4-serving",
    "--device-id", "device-m4-serving",
    "--seat-id", "seat-m4-serving",
    "--machine-fingerprint", MACHINE_FINGERPRINT,
    "--session-capabilities", "partial_progress,transport_streamable_http",
  ];
}

describe("M4 pre-production serving launch lifecycle", () => {
  it("maps forged secret-bearing startup errors to a closed value-free reason", () => {
    const sentinel = "SYNTHETIC-M4-SECRET-SENTINEL-DO-NOT-EMIT";
    const forged = {
      name: "PreProductionTlsMaterialError",
      code: "preproduction_tls_material_refused",
      reason: sentinel,
    };
    const classified = safePreProductionStartupReason(forged);
    expect(classified).toBe("internal_error");
    expect(classified).not.toContain(sentinel);
  });

  it("writes the enrollment artifact before start and positively removes it on cleanup", async () => {
    const sequence: string[] = [];
    const handle = fakeHandle();
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => {
        sequence.push("start");
        return handle;
      },
    } as unknown as PreparedPreProductionServing;
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => {
        sequence.push("seed");
        return RAW_SEED;
      },
      prepare: async () => {
        sequence.push("prepare");
        return prepared;
      },
      loadTls: async () => {
        sequence.push("tls");
        return { key: Buffer.from("key"), cert: Buffer.from("cert") };
      },
      writeEnrollmentArtifact: async () => {
        sequence.push("artifact");
      },
      removeEnrollmentArtifact: async () => {
        sequence.push("unlink");
      },
    };

    const launch = await launchPreProductionServing(
      cliArguments(),
      environment(),
      deps,
    );
    expect(sequence).toEqual(["seed", "prepare", "tls", "artifact", "start"]);
    await launch.cleanup();
    expect(handle.beginShutdown).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(sequence.at(-1)).toBe("unlink");
  });

  it("removes the enrollment artifact if listener start fails", async () => {
    const sequence: string[] = [];
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => {
        sequence.push("start");
        throw new Error("listener_failed");
      },
    } as unknown as PreparedPreProductionServing;
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => RAW_SEED,
      prepare: async () => prepared,
      loadTls: async () => ({
        key: Buffer.from("key"),
        cert: Buffer.from("cert"),
      }),
      writeEnrollmentArtifact: async () => {
        sequence.push("artifact");
      },
      removeEnrollmentArtifact: async () => {
        sequence.push("unlink");
      },
    };
    await expect(
      launchPreProductionServing(cliArguments(), environment(), deps),
    ).rejects.toThrow("listener_failed");
    expect(sequence).toEqual(["artifact", "start", "unlink"]);
  });

  it("raises a safe residue failure when failed-start cleanup cannot unlink", async () => {
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => {
        throw new Error("SYNTHETIC-LISTENER-ERROR-WITH-SECRET-LIKE-DATA");
      },
    } as unknown as PreparedPreProductionServing;
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => RAW_SEED,
      prepare: async () => prepared,
      loadTls: async () => ({
        key: Buffer.from("key"),
        cert: Buffer.from("cert"),
      }),
      writeEnrollmentArtifact: async () => undefined,
      removeEnrollmentArtifact: async () => {
        throw new Error("SYNTHETIC-UNLINK-ERROR-WITH-SECRET-LIKE-DATA");
      },
    };
    let caught: unknown;
    try {
      await launchPreProductionServing(cliArguments(), environment(), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "preproduction_serving_cli_refused",
      reason: "enrollment_artifact_cleanup_failed",
    });
    expect(JSON.stringify(caught)).not.toContain("SYNTHETIC-LISTENER");
    expect(JSON.stringify(caught)).not.toContain("SYNTHETIC-UNLINK");
  });

  it("surfaces artifact cleanup failure and retries residue cleanup without reclosing", async () => {
    const handle = fakeHandle();
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => handle,
    } as unknown as PreparedPreProductionServing;
    let unlinkAttempts = 0;
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => RAW_SEED,
      prepare: async () => prepared,
      loadTls: async () => ({
        key: Buffer.from("key"),
        cert: Buffer.from("cert"),
      }),
      writeEnrollmentArtifact: async () => undefined,
      removeEnrollmentArtifact: async () => {
        unlinkAttempts += 1;
        if (unlinkAttempts === 1) throw new Error("unlink_failed");
      },
    };
    const launch = await launchPreProductionServing(
      cliArguments(),
      environment(),
      deps,
    );
    await expect(launch.cleanup()).rejects.toThrow("unlink_failed");
    await expect(launch.cleanup()).resolves.toBeUndefined();
    expect(handle.beginShutdown).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(unlinkAttempts).toBe(2);
  });

  it("continues close and artifact removal when beginShutdown throws", async () => {
    const handle = fakeHandle();
    handle.beginShutdown = vi.fn(() => {
      throw new Error("SYNTHETIC-BEGIN-SHUTDOWN-FAILURE");
    });
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => handle,
    } as unknown as PreparedPreProductionServing;
    const unlink = vi.fn(async () => undefined);
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => RAW_SEED,
      prepare: async () => prepared,
      loadTls: async () => ({
        key: Buffer.from("key"),
        cert: Buffer.from("cert"),
      }),
      writeEnrollmentArtifact: async () => undefined,
      removeEnrollmentArtifact: unlink,
    };
    const launch = await launchPreProductionServing(
      cliArguments(),
      environment(),
      deps,
    );

    await expect(launch.cleanup()).rejects.toThrow(
      "SYNTHETIC-BEGIN-SHUTDOWN-FAILURE",
    );
    expect(handle.close).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("removes the enrollment artifact when a post-launch action throws", async () => {
    const handle = fakeHandle();
    const prepared = {
      enrollment: {
        enrollmentToken: "SYNTHETIC-ENROLLMENT-TOKEN-000000000001",
        expiresAtMs: NOW_MS + 60_000,
      },
      start: async () => handle,
    } as unknown as PreparedPreProductionServing;
    const unlink = vi.fn(async () => undefined);
    const deps: PreProductionServingCliDependencies = {
      readRegistrySeed: async () => RAW_SEED,
      prepare: async () => prepared,
      loadTls: async () => ({
        key: Buffer.from("key"),
        cert: Buffer.from("cert"),
      }),
      writeEnrollmentArtifact: async () => undefined,
      removeEnrollmentArtifact: unlink,
    };

    await expect(
      launchPreProductionServingOwned(
        cliArguments(),
        environment(),
        () => {
          throw new Error("SYNTHETIC-POST-LAUNCH-LOG-FAILURE");
        },
        deps,
      ),
    ).rejects.toThrow("SYNTHETIC-POST-LAUNCH-LOG-FAILURE");
    expect(handle.beginShutdown).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledOnce();
  });
});
