import type { GatewayExecutor, GatewayExecutorOutcome, GatewayExecutorRequest, GatewayJsonValue } from "./dispatch.js";
import { GatewayDispatcher } from "./dispatch.js";
import { EntitledCatalogView, type CatalogEntry } from "./entitledRegistry.js";
import type { EffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import type { AuthorizedNorthMcpRequest, NorthMcpEndpointOptions } from "./northMcpEndpoint.js";
import { GatewayToolRegistry, type GatewayToolRecord } from "./registry.js";
import type { PostgresTenantStore } from "./postgresTenantStore.js";
import { createOidcNorthMcpAuthenticator } from "./oidcIdentity.js";
import type { IdentityPort } from "./authContext.js";

const RECORD: GatewayToolRecord = Object.freeze({
  name: "core.bridge.list",
  summary: "List a bounded set of tenant-authorized bridge devices.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "auto",
  mutationScopePolicy: "none",
  executor: "internal_mcp",
  executorMethod: "list_revit_instances",
  inputSchema: {},
  inputJsonSchema: Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: Object.freeze({}),
    type: "object",
  }),
});

const CATALOG: CatalogEntry = Object.freeze({
  name: RECORD.name,
  summary: RECORD.summary,
  namespace: RECORD.namespace,
  version: RECORD.version,
  tool: RECORD.executorMethod,
  module: "runtime",
  policyClass: RECORD.policyClass,
  mutationScopePolicy: RECORD.mutationScopePolicy,
  executor: RECORD.executor,
  variants: Object.freeze([]),
  terms: Object.freeze(["bridge", "core", "list"]),
});

function createReadWindowAuthority() {
  const windows = new Map<string, string>();
  return {
    async acquireInvocationWindow(input: { tenantId: string; rsid: string; attemptId: string }) {
      const key = `${input.tenantId}\0${input.rsid}`;
      const active = windows.get(key);
      if (active === undefined) { windows.set(key, input.attemptId); return { kind: "acquired" as const }; }
      return active === input.attemptId ? { kind: "already_acquired" as const } : { kind: "blocked" as const, activeAttemptId: active };
    },
    async releaseInvocationWindow(input: { tenantId: string; rsid: string; attemptId: string }) {
      const key = `${input.tenantId}\0${input.rsid}`;
      const active = windows.get(key);
      if (active === undefined) return { kind: "already_released" as const };
      if (active !== input.attemptId) return { kind: "protocol_fault" as const, reason: "invocation_window_attempt_mismatch" as const };
      windows.delete(key); return { kind: "released" as const };
    },
    async preflightMutation() { return { kind: "clear" as const }; },
    async prepareMutationDispatch() { return { kind: "unavailable" as const, code: "unavailable" as const, message: "read-only vertical" }; },
    async reconcilePendingDispatch() { return { kind: "unavailable" as const, code: "unavailable" as const, message: "read-only vertical" }; },
  };
}

export function createAuthenticatedTenantReadNorthMcp(input: {
  readonly identity: IdentityPort & { readonly kind: "oidc" };
  readonly store: PostgresTenantStore;
  readonly resource: URL;
  readonly resourceMetadataUrl: URL;
  readonly requestStateKey: string | Uint8Array;
}): NorthMcpEndpointOptions {
  const registry = new GatewayToolRegistry([RECORD]);
  const view = new EntitledCatalogView([CATALOG], () => true);
  const executor: GatewayExecutor = Object.freeze({
    binding: "internal_mcp" as const,
    async execute(request: GatewayExecutorRequest): Promise<GatewayExecutorOutcome> {
      if (request.executorMethod !== "list_revit_instances") {
        return { state: "failed" as const, error: { code: "unsupported_method", message: "bounded tenant read only" } };
      }
      const devices = await input.store.listDevices({ actor: request.context.actor });
      const jsonDevices = devices.map((device) => ({
        deviceId: device.deviceId,
        machineName: device.machineName,
        bridgeVersion: device.bridgeVersion,
        addinVersion: device.addinVersion,
        status: device.status,
      })) as readonly GatewayJsonValue[];
      return { state: "completed" as const, result: { devices: jsonDevices, count: devices.length, bounded: true } };
    },
  });
  const dispatcher = new GatewayDispatcher(registry, [executor], {
    eventSink: input.store,
    eventSource: Object.freeze({ component: "gateway", version: "m5-v1", instance: "north-mcp" }),
    recoveryAuthority: createReadWindowAuthority(),
  });
  return Object.freeze({
    authenticator: createOidcNorthMcpAuthenticator({ identity: input.identity, resource: input.resource }),
    catalogViewFor: () => view,
    invocationRouteFor: (authenticated: AuthorizedNorthMcpRequest, mcpSessionId: string, effectiveMcpRequestScope: EffectiveMcpRequestScopeV1) => Object.freeze({
      tenantId: authenticated.authContext.actor.tenantId,
      principalKey: authenticated.principalKey,
      mcpSessionId,
      effectiveMcpRequestScope,
      rsid: authenticated.authContext.session.sessionId,
      documentIdentity: Object.freeze({ kind: "live" as const, session_document_id: "gateway-device-inventory" }),
    }),
    dispatcher,
    registry,
    requestState: Object.freeze({ key: input.requestStateKey }),
    modeA: Object.freeze({ schemaBudgetBytes: 4096, pinnedToolNames: Object.freeze([RECORD.name]) }),
    resourceMetadataUrl: input.resourceMetadataUrl,
  });
}
