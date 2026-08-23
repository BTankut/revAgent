import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { GatewayDispatcher } from "./dispatch.js";
import { EntitledCatalogView } from "./entitledRegistry.js";
import { GatewayToolRegistry, M2_BOOTSTRAP_TOOL_RECORDS } from "./registry.js";
import { PRODUCTION_CONFORMANCE_TOOL_RECORDS, productionConformanceCatalog } from "./productionConformanceTools.js";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { IncomingMessage } from "node:http";
import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  SqliteConformanceProtocolStore,
  createConformanceSupportingPorts,
} from "./conformanceEphemeralAdapters.js";
import { startProductionGatewayHost } from "./productionConformanceHost.js";
import { createConformanceRbpIngressHost } from "./rbpIngress.js";
import type { AuthorizedNorthMcpRequest, NorthMcpEndpointOptions } from "./northMcpEndpoint.js";
import type { EffectiveMcpRequestScopeV1 } from "./invocationContext.js";

interface CliOptions {
  readonly root: string;
  readonly certificate: string;
  readonly key: string;
  readonly controlToken: string;
  readonly port: number;
}

type ConformanceBinding = "wss" | "streamable_http_sse";

const REQUIRED_SESSION_CAPABILITIES = Object.freeze([
  "batch_atomic",
  "doc_context_cached_v1",
]);

const REQUIRED_CONNECTION_CAPABILITIES = Object.freeze([
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
]);

const REAL_CASE_AUDIT_SCHEMA = "revagent.wp12-real-case-audit/v1" as const;

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function redactedSessionAudit(records: readonly { readonly namespace: string; readonly key: string; readonly value: unknown }[]): readonly Record<string, unknown>[] {
  return Object.freeze(records.slice(0, 32).map((record) => {
    const value = record.value !== null && typeof record.value === "object" && !Array.isArray(record.value)
      ? record.value as Record<string, unknown>
      : {};
    const lifecycle = value.lifecycle !== null && typeof value.lifecycle === "object" && !Array.isArray(value.lifecycle)
      ? value.lifecycle as Record<string, unknown>
      : {};
    const session = lifecycle.sessionLifecycle !== null && typeof lifecycle.sessionLifecycle === "object" && !Array.isArray(lifecycle.sessionLifecycle)
      ? lifecycle.sessionLifecycle as Record<string, unknown>
      : {};
    const binding = value.binding !== null && typeof value.binding === "object" && !Array.isArray(value.binding)
      ? value.binding as Record<string, unknown>
      : {};
    return Object.freeze({
      namespace: record.namespace,
      keyDigest: digest(record.key),
      rsidDigest: typeof value.rsid === "string" ? digest(value.rsid) : null,
      carrier: typeof binding.binding === "string" ? binding.binding : "unknown",
      phase: typeof session.phase === "string" ? session.phase : "unknown",
      dispatchAllowed: session.dispatchAllowed === true,
      recordDigest: digest(value),
    });
  }));
}

export function conformanceConnectionCapabilitiesForBinding(
  binding: ConformanceBinding,
): readonly string[] {
  return Object.freeze([
    ...REQUIRED_CONNECTION_CAPABILITIES,
    ...(binding === "streamable_http_sse" ? ["transport_streamable_http"] : []),
  ]);
}

function exactCapabilityList(value: unknown, expected: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length && expected.every((entry) => value.includes(entry));
}

/** Returns the only authority provision accepted by the public test route. */
export function validateConformanceDeviceProvision(input: {
  readonly binding: unknown;
  readonly connectionCapabilities: unknown;
  readonly sessionCapabilities: unknown;
}): { readonly binding: ConformanceBinding; readonly connectionCapabilities: readonly string[]; readonly sessionCapabilities: readonly string[] } | null {
  if (input.binding !== "wss" && input.binding !== "streamable_http_sse") return null;
  const connectionCapabilities = conformanceConnectionCapabilitiesForBinding(input.binding);
  if (!exactCapabilityList(input.connectionCapabilities, connectionCapabilities) ||
      !exactCapabilityList(input.sessionCapabilities, REQUIRED_SESSION_CAPABILITIES)) return null;
  return Object.freeze({
    binding: input.binding,
    connectionCapabilities,
    sessionCapabilities: REQUIRED_SESSION_CAPABILITIES,
  });
}

function parse(args: readonly string[]): CliOptions {
  if (args.length !== 10) throw new Error("production conformance host requires five --key value pairs");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) throw new Error("invalid production conformance host arguments");
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const rawPort = required("--port");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || values.size !== 5) throw new Error("invalid production conformance host port");
  return Object.freeze({ root: path.resolve(required("--root")), certificate: path.resolve(required("--certificate")), key: path.resolve(required("--key")), controlToken: required("--control-token"), port });
}

function constantTokenEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Executable WP-12 Gateway composition. The admin surface is deliberately
 * loopback/TLS-only and requires an out-of-band test token. It is the sole
 * mutation route for the conformance credential authority; callers cannot
 * reach its in-process store or authority object directly.
 */
export async function runProductionConformanceHostCli(args: readonly string[]): Promise<void> {
  const options = parse(args);
  const [cert, key] = await Promise.all([readFile(options.certificate), readFile(options.key)]);
  const credentials = [{ tenantId: "conformance", userId: "conformance", deviceId: "wp12-device", token: "wp12-device-token" }];
  const identity = new ConformanceCredentialAuthority(credentials);
  const protocolStore = new SqliteConformanceProtocolStore(options.root);
  const opened = await protocolStore.open();
  if (!opened.ok) throw new Error("conformance protocol store did not open");
  // The carrier and the host ports must use one exact durable pair.  This is
  // deliberately composed before ingress so carrier capability grants cannot
  // pass a readiness check against an unrelated object store.
  const objectStore = new DigestFileConformanceObjectStore(options.root);
  const resourceAuthority = new GatewayResourceAuthority({
    protocolStore,
    objectStore,
  });
  const authority = new GatewayBridgeSessionAuthority(protocolStore, identity, {
    resourceAuthority,
  });
  const ingress = createConformanceRbpIngressHost({ authority });
  const supporting = createConformanceSupportingPorts();
  const registry = new GatewayToolRegistry([
    ...M2_BOOTSTRAP_TOOL_RECORDS,
    ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
  ]);
  const coreUiState = registry.require("core.ui.state");
  const entitledCatalog = new EntitledCatalogView(
    productionConformanceCatalog(coreUiState),
    () => true,
  );
  const dispatcher = new GatewayDispatcher(registry, [authority.createExecutor()], {
    eventSink: supporting.events,
    eventSource: {
      component: "gateway-production-conformance",
      version: "wp12",
      instance: "loopback",
    },
    // This host exposes a single auto/read-only MCP tool. Any mutation path is
    // intentionally unreachable, so it cannot use the test control plane as a
    // recovery authority.
    recoveryAuthority: {} as never,
  });
  const auditAccesses: Array<{ readonly atMs: number; readonly tenantId: string; readonly action: string }> = [];
  const northMcp: NorthMcpEndpointOptions = Object.freeze({
    registry,
    dispatcher,
    resourceAuthority,
    resourceMaxInlineResultBytes: 32 * 1024,
    catalogViewFor: () => entitledCatalog,
    invocationRouteFor: (authenticated: AuthorizedNorthMcpRequest, _mcpSessionId: string, effectiveMcpRequestScope: EffectiveMcpRequestScopeV1) =>
      authority.resolveLiveInvocationRoute({
        tenantId: authenticated.authContext.actor.tenantId,
        userId: authenticated.authContext.actor.userId,
        deviceId: credentials[0]!.deviceId,
        effectiveMcpRequestScope,
      }),
    requestState: { key: createHash("sha256").update(options.controlToken).digest() },
    resourceMetadataUrl: new URL("https://127.0.0.1/.well-known/oauth-protected-resource/mcp"),
    authenticator: {
      kind: "conformance",
      async authenticate(request: IncomingMessage) {
        const outcome = await identity.authenticateNorthRequest({
          authorization: request.headers.authorization,
        });
        if (!outcome.ok) return null;
        const authorization = request.headers.authorization;
        const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
        const authInfo: AuthInfo = {
          token,
          clientId: "conformance-loopback",
          scopes: ["mcp:tools"],
          resource: new URL("https://127.0.0.1/mcp"),
        };
        // The loopback bearer is issued for this fixed test MCP client.  Bind
        // the callback context to that client before the north endpoint's
        // normal principal/client consistency check; no identity-port state is
        // changed and the token remains outside all emitted evidence.
        return Object.freeze({
          authInfo,
          authContext: Object.freeze({
            ...outcome.value,
            session: Object.freeze({
              ...outcome.value.session,
              oauthClientId: "conformance-loopback",
            }),
          }),
          principalKey: outcome.value.principalKey,
        });
      },
    },
  });
  let conformanceEndpoint: string | null = null;
  let stopping = false;
  try {
    const handle = await startProductionGatewayHost({
      hostProfile: "production_conformance",
      authority,
      resourceAuthority,
      northMcp,
      server: {
        config: {
          nodeEnv: "test",
          logLevel: "fatal",
          http: { bindHost: "127.0.0.1", port: options.port },
          publicUrl: "https://127.0.0.1",
          objectStore: { driver: "fs", root: null },
          credentialsPresent: { databaseUrl: false },
          ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
        },
        tls: { cert, key },
      },
      ports: {
        identity,
        protocolStore,
        objectStore,
        entitlement: supporting.entitlement,
        events: supporting.events,
        guardrails: supporting.guardrails,
        rbpIngress: ingress,
      },
      mountConformanceControl(app) {
        app.post("/__conformance/v1/control", async (request, reply) => {
          if (!constantTokenEquals(request.headers["x-rbp-test-control"], options.controlToken)) return reply.code(401).send({ ok: false, error: "unauthorized" });
          const body = request.body as {
            action?: unknown;
            binding?: unknown;
            connectionCapabilities?: unknown;
            sessionCapabilities?: unknown;
            tenantId?: unknown;
          } | null;
          const action = body?.action;
          if (action === "issue_device_credential") {
            const provision = validateConformanceDeviceProvision({
              binding: body?.binding,
              connectionCapabilities: body?.connectionCapabilities,
              sessionCapabilities: body?.sessionCapabilities,
            });
            if (provision === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_binding" });
            }
            if (conformanceEndpoint === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_capability_provision" });
            }
            const credential = credentials[0]!;
            const proof = identity.issue(credential.deviceId, {
              connectionCapabilities: provision.connectionCapabilities,
              sessionCapabilities: provision.sessionCapabilities,
            });
            return reply.send({
              ok: true,
              action,
              binding: provision.binding,
              deviceId: credential.deviceId,
              deviceToken: credential.token,
              deviceProof: proof,
              connectionCapabilities: provision.connectionCapabilities,
              sessionCapabilities: provision.sessionCapabilities,
              gatewayEndpoint: conformanceEndpoint,
              credentialProvenance: "gateway_production_conformance",
              adapterProvenance: {
                identity: identity.kind,
                protocolStore: protocolStore.kind,
                authority: "GatewayBridgeSessionAuthority",
              },
              audit: identity.audit(),
            });
          }
          if (action === "issue_north_credential") {
            if (Object.keys(body ?? {}).length !== 1 || conformanceEndpoint === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_north_credential_request" });
            }
            const credential = credentials[0]!;
            return reply.send({
              ok: true,
              action,
              bearer: credential.token,
              audience: `${conformanceEndpoint}/mcp`,
              credentialProvenance: "gateway_production_conformance",
              identityContract: "revagent.auth-context/v1",
            });
          }
          if (action === "revoke_device") {
            const credential = credentials[0]!;
            const revoked = identity.revoke(credential.deviceId);
            return reply.send({ ok: true, action, revoked, audit: identity.audit() });
          }
          if (action === "snapshot_audit") {
            const sessions = await protocolStore.transact(
              { tenantId: "conformance" },
              async (tx) => await tx.list("gateway.rbp-session/v2"),
            );
            if (!sessions.ok) {
              return reply.code(503).send({ ok: false, action, error: "session_audit_unavailable" });
            }
            return reply.send({ ok: true, action, audit: identity.audit(), sessions: sessions.value });
          }
          if (action === "read_real_case_audit") {
            if (body?.tenantId !== "conformance" || Object.keys(body ?? {}).length !== 2) {
              return reply.code(400).send({ ok: false, action, error: "invalid_audit_scope" });
            }
            auditAccesses.push(Object.freeze({ atMs: Date.now(), tenantId: "conformance", action: "read_real_case_audit" }));
            const namespaces = [
              "gateway.rbp-session/v2",
              "gateway.mutation-hold/v1",
              "gateway.invocation-outcome/v1",
              "gateway.resource-carrier/v1",
            ];
            const records: Array<{ readonly namespace: string; readonly key: string; readonly value: unknown }> = [];
            for (const namespace of namespaces) {
              const result = await protocolStore.transact({ tenantId: "conformance" }, async (tx) => await tx.list(namespace));
              if (!result.ok) return reply.code(503).send({ ok: false, action, error: "real_case_audit_unavailable" });
              records.push(...result.value.map((row) => ({ namespace: row.namespace, key: row.key, value: row.value })));
            }
            const rows = redactedSessionAudit(records);
            return reply.send({
              ok: true,
              action,
              schemaVersion: REAL_CASE_AUDIT_SCHEMA,
              tenantDigest: digest("conformance"),
              rows,
              counts: Object.freeze({ records: records.length, auditAccesses: auditAccesses.length }),
              frontier: digest(rows),
              auditAccessDigest: digest(auditAccesses.map((entry) => entry.action)),
            });
          }
          return reply.code(400).send({ ok: false, error: "invalid_action" });
        });
      },
    });
    conformanceEndpoint = `https://127.0.0.1:${String(handle.port)}`;
    const close = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      handle.beginShutdown();
      await handle.close();
    };
    const stopped = new Promise<void>((resolve, reject) => {
      process.once("SIGTERM", () => { void close().then(resolve, reject); });
      process.once("SIGINT", () => { void close().then(resolve, reject); });
      if (process.send !== undefined) process.on("message", (message: unknown) => {
        if ((message as { action?: unknown })?.action === "emit_test_signal") void close().then(resolve, reject);
      });
    });
    // Register STOP before publishing READY: a parent which stops immediately
    // after the ready line must still observe a normal close rather than a
    // signal-terminated child.
    // C# pins the DER certificate returned by TLS, not the PEM transport file.
    const certificateSha256 = `sha256:${createHash("sha256").update(new X509Certificate(cert).raw).digest("hex")}`;
    process.stdout.write(`${JSON.stringify({ ready: true, component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1", endpoint: conformanceEndpoint, tlsCertificateSha256: certificateSha256, controlPath: "/__conformance/v1/control", pid: process.pid })}\n`);
    await stopped;
    // An IPC channel is supplied only by the Windows supervision harness. It
    // keeps Node's event loop alive after an otherwise clean app close unless
    // it is explicitly released.
    if (process.connected) process.disconnect();
  } finally {
    await protocolStore.close();
  }
}

if (process.argv[1]?.endsWith("productionConformanceHostCli.js")) {
  void runProductionConformanceHostCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`production-conformance-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  });
}
