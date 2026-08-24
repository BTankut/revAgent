import { GATEWAY_AUTH_CONTRACT_VERSION, type GatewayRole } from "./authContext.js";
import { GatewayDispatcher } from "./dispatch.js";
import { buildCatalog, EntitledCatalogView } from "./entitledRegistry.js";
import { createUnavailableGuardrailPort } from "./guardrails.js";
import {
  M2_NORTH_FIRST_SLICE_CALLABLE,
  buildNorthFirstSliceCallableRegistry,
} from "./northFirstSlice.js";
import {
  createPreProductionLanTestComposition,
  type PreProductionLanTestComposition,
} from "./preProductionComposition.js";
import {
  PreProductionAuditExportError,
  projectPreProductionAudit,
  type PreProductionAuditExportBundle,
} from "./preProductionAuditExport.js";
import {
  loadPreProductionCredentialFile,
  type PreProductionCredentialMaterial,
} from "./preProductionCredentialFile.js";
import type {
  PreProductionEnrollmentIssue,
  PreProductionIdentityResult,
} from "./preProductionIdentity.js";
import {
  createPreProductionRuntimeAdapters,
  type PreProductionRuntimeAdapters,
} from "./preProductionRuntimeAdapters.js";
import { GatewayRecoveryAuthority } from "./recoveryAuthority.js";
import { verifyRegistrySeed, type RegistrySeed } from "./registrySeed.js";
import {
  startGatewayServer,
  type GatewayServerHandle,
  type GatewayServerTlsMaterial,
} from "./server.js";
import { createUnavailableObjectStore } from "./store.js";
import { loadGatewayConfig } from "./config.js";

export const PRE_PRODUCTION_SERVING_CONTRACT_VERSION =
  "revagent.m4-preproduction-serving/v1" as const;

export type PreProductionServingErrorReason =
  | "invalid_invocation"
  | "production_mode_refused"
  | "invalid_gateway_configuration"
  | "invalid_registry_seed"
  | "runtime_adapter_unavailable"
  | "enrollment_issue_refused"
  | "c39_protected_object_unavailable";

export class PreProductionServingError extends Error {
  readonly code = "preproduction_serving_refused" as const;

  constructor(readonly reason: PreProductionServingErrorReason) {
    super(`pre-production serving refused: ${reason}`);
    this.name = "PreProductionServingError";
  }
}

export interface PreProductionServingPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: GatewayRole;
  readonly sessionId: string;
  readonly oauthClientId: string;
}

export interface PreProductionServingDevice {
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly machineFingerprint: string;
  readonly grantedSessionCapabilities: readonly string[];
}

export interface PreProductionServingOptions {
  readonly profile: "lan_test";
  readonly mode: "preproduction";
  /** Explicit allowlisted Gateway environment; process.env is never inferred. */
  readonly environment: NodeJS.ProcessEnv;
  readonly credentialFilePath: string;
  readonly registrySeed: unknown;
  readonly principal: PreProductionServingPrincipal;
  readonly device: PreProductionServingDevice;
  readonly clock?: () => number;
}

export interface PreProductionServingDependencies {
  loadCredential(
    filePath: string,
  ): Promise<PreProductionCredentialMaterial>;
  createRuntimeAdapters(input: {
    readonly clock: () => number;
  }): PreProductionRuntimeAdapters;
  verifySeed(candidate: unknown): RegistrySeed;
  startServer(input: {
    readonly composition: PreProductionLanTestComposition;
    readonly tls: GatewayServerTlsMaterial;
  }): Promise<GatewayServerHandle>;
}

export interface PreparedPreProductionServing {
  readonly contractVersion: typeof PRE_PRODUCTION_SERVING_CONTRACT_VERSION;
  readonly composition: PreProductionLanTestComposition;
  readonly enrollment: PreProductionEnrollmentIssue;
  start(tls: GatewayServerTlsMaterial): Promise<GatewayServerHandle>;
  revokeConfiguredDevice(): Promise<PreProductionIdentityResult<unknown>>;
  exportAuditSnapshot(): Promise<PreProductionAuditExportBundle>;
}

const DEFAULT_DEPENDENCIES: PreProductionServingDependencies = Object.freeze({
  loadCredential: loadPreProductionCredentialFile,
  createRuntimeAdapters: ({
    clock,
  }: {
    readonly clock: () => number;
  }) =>
    createPreProductionRuntimeAdapters({
      protocolStore: { clock },
      entitlement: {
        allowedToolNames: [M2_NORTH_FIRST_SLICE_CALLABLE],
        allowedModules: ["core"],
      },
    }),
  verifySeed: verifyRegistrySeed,
  startServer: async ({
    composition,
    tls,
  }: {
    readonly composition: PreProductionLanTestComposition;
    readonly tls: GatewayServerTlsMaterial;
  }) =>
    startGatewayServer({
      config: composition.config,
      ports: composition.ports,
      northMcp: composition.northMcp,
      tls,
    }),
});

function refused(reason: PreProductionServingErrorReason): never {
  throw new PreProductionServingError(reason);
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value;
}

function validateInvocation(options: PreProductionServingOptions): void {
  if (
    options.profile !== "lan_test" ||
    options.mode !== "preproduction" ||
    options.environment.NODE_ENV !== "preproduction" ||
    !nonEmpty(options.credentialFilePath) ||
    !nonEmpty(options.principal.tenantId) ||
    !nonEmpty(options.principal.userId) ||
    !nonEmpty(options.principal.sessionId) ||
    !nonEmpty(options.principal.oauthClientId) ||
    !nonEmpty(options.device.enrollmentId) ||
    !nonEmpty(options.device.deviceId) ||
    !nonEmpty(options.device.seatId)
  ) {
    if (options.environment.NODE_ENV === "production") {
      refused("production_mode_refused");
    }
    refused("invalid_invocation");
  }
}

/**
 * Prepares the M4 LAN/test process without opening a listener.
 *
 * Validation of the explicit non-production discriminants runs before the
 * credential loader, registry verifier, store factory, or listener dependency.
 * Raw credentials and the issued enrollment token are returned only to the
 * privileged caller and are never logged by this module.
 */
export async function preparePreProductionServing(
  options: PreProductionServingOptions,
  dependencies: PreProductionServingDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreparedPreProductionServing> {
  validateInvocation(options);

  const loadedConfig = loadGatewayConfig(options.environment);
  if (!loadedConfig.ok || loadedConfig.value.nodeEnv !== "preproduction") {
    refused("invalid_gateway_configuration");
  }
  if (loadedConfig.value.objectStore.protectedObjectKeyFile != null) {
    // The serving simulator owns no durable C39 receipt inventory and cannot
    // turn a key path into a fixture/provider selection.
    refused("c39_protected_object_unavailable");
  }

  let credential: PreProductionCredentialMaterial;
  try {
    credential = await dependencies.loadCredential(options.credentialFilePath);
  } catch {
    return refused("invalid_invocation");
  }

  let seed: RegistrySeed;
  try {
    seed = dependencies.verifySeed(options.registrySeed);
  } catch {
    return refused("invalid_registry_seed");
  }

  const clock = options.clock ?? Date.now;
  let adapters: PreProductionRuntimeAdapters;
  try {
    adapters = dependencies.createRuntimeAdapters({ clock });
  } catch {
    return refused("runtime_adapter_unavailable");
  }

  const catalog = buildCatalog(seed);
  const entitledCatalog = new EntitledCatalogView(
    catalog,
    (entry) => entry.name === M2_NORTH_FIRST_SLICE_CALLABLE,
  );
  const registry = buildNorthFirstSliceCallableRegistry(catalog);
  const principal = options.principal;
  const device = options.device;
  const nowMs = clock();

  const composition = createPreProductionLanTestComposition({
    profile: "lan_test",
    mode: "preproduction",
    config: loadedConfig,
    identityOptions: {
      tokenKey: credential.identityTokenKey,
      clock,
      northIdentities: [
        {
          authorization: credential.northAuthorization,
          context: {
            contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
            actor: {
              type: "user",
              tenantId: principal.tenantId,
              userId: principal.userId,
              role: principal.role,
              oidcIssuer: "https://preproduction.invalid/m4",
              oidcSubject: principal.userId,
            },
            session: {
              sessionId: principal.sessionId,
              clientType: "mcp",
              mcpSessionId: null,
              oauthClientId: principal.oauthClientId,
            },
            principalKey: `${principal.tenantId}:${principal.userId}`,
            issuedAtMs: nowMs,
            expiresAtMs: null,
          },
        },
      ],
    },
    protocolStore: adapters.protocolStore,
    entitlement: adapters.entitlement,
    events: adapters.events,
    objectStore: createUnavailableObjectStore(),
    guardrails: createUnavailableGuardrailPort(),
    northAuth: {
      scopes: ["mcp:tools"],
      resource: new URL("/mcp", loadedConfig.value.publicUrl),
    },
    northMcpFor: ({ bridgeAuthority }) => {
      const recoveryAuthority = new GatewayRecoveryAuthority(
        adapters.protocolStore,
        {
          bridgeEvidence: bridgeAuthority,
          evidenceDecision: {
            async decideEvidence() {
              return {
                kind: "unavailable" as const,
                message:
                  "pre-production serving does not authorize recovery evidence decisions",
              };
            },
          },
          clock,
        },
      );
      const dispatcher = new GatewayDispatcher(
        registry,
        [bridgeAuthority.createExecutor()],
        {
          eventSink: adapters.events,
          eventSource: {
            component: "revagent-gateway",
            version: PRE_PRODUCTION_SERVING_CONTRACT_VERSION,
            instance: "m4-lan-test",
          },
          clock,
          recoveryAuthority,
        },
      );
      return {
        catalogViewFor: () => entitledCatalog,
        invocationRouteFor: (authenticated, _mcpSessionId, effectiveMcpRequestScope) => {
          if (
            authenticated.authContext.actor.tenantId !== principal.tenantId ||
            authenticated.authContext.actor.userId !== principal.userId
          ) {
            throw new Error("live invocation route is unavailable");
          }
          return bridgeAuthority.resolveLiveInvocationRoute({
            tenantId: principal.tenantId,
            userId: principal.userId,
            deviceId: device.deviceId,
            effectiveMcpRequestScope,
          });
        },
        dispatcher,
        registry,
        requestState: { key: credential.requestStateHmacKey },
        resourceMetadataUrl: new URL(
          "/.well-known/oauth-protected-resource/mcp",
          loadedConfig.value.publicUrl,
        ),
      };
    },
  });

  const issued = composition.identity.issueEnrollmentToken({
    enrollmentId: device.enrollmentId,
    tenantId: principal.tenantId,
    userId: principal.userId,
    deviceId: device.deviceId,
    seatId: device.seatId,
    machineFingerprint: device.machineFingerprint,
    grantedSessionCapabilities: device.grantedSessionCapabilities,
  });
  if (!issued.ok) {
    return refused("enrollment_issue_refused");
  }

  const auditSelector = Object.freeze({
    tenantId: principal.tenantId,
    userId: principal.userId,
    principalKey: `${principal.tenantId}:${principal.userId}`,
    gatewaySessionId: principal.sessionId,
  });
  const auditApprovedTools = Object.freeze(
    registry.records().map((record) =>
      Object.freeze({
        name: record.name,
        version: record.version,
        policyClass: record.policyClass,
        mutationScopePolicy: record.mutationScopePolicy,
        executor: record.executor,
      }),
    ),
  );

  let started = false;
  let auditExportAttempted = false;
  return Object.freeze({
    contractVersion: PRE_PRODUCTION_SERVING_CONTRACT_VERSION,
    composition,
    enrollment: issued.value,
    async start(tls: GatewayServerTlsMaterial): Promise<GatewayServerHandle> {
      if (started) {
        return refused("invalid_invocation");
      }
      started = true;
      try {
        return await dependencies.startServer({ composition, tls });
      } catch (error) {
        started = false;
        throw error;
      }
    },
    async revokeConfiguredDevice(): Promise<PreProductionIdentityResult<unknown>> {
      const revoked = composition.identity.revokeDevice(device.deviceId);
      if (
        revoked.ok &&
        composition.bridgeAuthority.lifecycle().state === "open"
      ) {
        await composition.bridgeAuthority.revokeIdentityAuthority({
          tenantId: principal.tenantId,
          kind: "device",
          deviceId: device.deviceId,
          seatId: device.seatId,
          authorizationVersion: revoked.value.authorizationVersion,
          identityRecordVersion: revoked.value.identityRecordVersion,
          connectionCapabilityVersion:
            revoked.value.connectionCapabilityVersion,
          sessionCapabilityVersion: revoked.value.sessionCapabilityVersion,
          seatAuthorityVersion: revoked.value.seatAuthorityVersion,
          seatRecordVersion: revoked.value.seatRecordVersion,
        });
      }
      return revoked;
    },
    async exportAuditSnapshot(): Promise<PreProductionAuditExportBundle> {
      if (auditExportAttempted) {
        throw new PreProductionAuditExportError("already_attempted");
      }
      // Ownership is transferred before the first await so concurrent callers
      // cannot flush, snapshot, or project a second process-lifetime export.
      auditExportAttempted = true;

      let events: readonly unknown[];
      try {
        const flushed = await adapters.events.flush();
        if (!flushed.ok) {
          throw new PreProductionAuditExportError("source_unavailable");
        }
        events = adapters.events.snapshot();
      } catch (error: unknown) {
        if (error instanceof PreProductionAuditExportError) {
          throw error;
        }
        throw new PreProductionAuditExportError("source_unavailable");
      }

      try {
        return projectPreProductionAudit({
          profile: composition.profile,
          mode: composition.mode,
          selector: auditSelector,
          approvedTools: auditApprovedTools,
          events,
        });
      } catch (error: unknown) {
        if (error instanceof PreProductionAuditExportError) {
          throw error;
        }
        throw new PreProductionAuditExportError("source_unavailable");
      }
    },
  });
}
