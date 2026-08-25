import {
  GatewayBridgeSessionAuthority,
  type ConformanceOriginResendPolicy,
} from "./bridgeSession.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { isFactoryConformanceRbpIngressHost, type ConformanceRbpIngressHost } from "./rbpIngress.js";
import {
  startGatewayServer,
  type GatewayServerHandle,
  type GatewayServerOptions,
} from "./server.js";
import type { FastifyInstance } from "fastify";
import type { NorthMcpEndpointOptions } from "./northMcpEndpoint.js";

/**
 * The only D2b-capable policy factory. It is intentionally not configurable:
 * productionConformanceHost owns the fixed C39 fixture identity, while every
 * ordinary composition retains the BridgeSession's sealed Never policy.
 */
export function createProductionConformanceC39OriginResendPolicy(): ConformanceOriginResendPolicy {
  const pending = new Map<string, {
    readonly tenantId: string;
    readonly userId: string;
    readonly rsid: string;
    readonly originInvocationId: string;
  }>();
  const key = (rsid: string, originInvocationId: string) => `${rsid}\u0000${originInvocationId}`;
  return Object.freeze({
    kind: "internal_d2b_conformance" as const,
    allowCapture(input: Parameters<ConformanceOriginResendPolicy["allowCapture"]>[0]) {
      if (
        input.tenantId !== "conformance" ||
        input.userId !== "conformance" ||
        input.method !== "fixture_multi_file_output" ||
        input.toolName !== "conformance.fixture.c39_multifile"
      ) return false;
      pending.set(key(input.rsid, input.originInvocationId), Object.freeze({
        tenantId: input.tenantId,
        userId: input.userId,
        rsid: input.rsid,
        originInvocationId: input.originInvocationId,
      }));
      return true;
    },
    peekResumeRequest(input: Parameters<NonNullable<ConformanceOriginResendPolicy["peekResumeRequest"]>>[0]) {
      for (const candidate of pending.values()) {
        if (
          candidate.tenantId === input.tenantId && candidate.userId === input.userId &&
          candidate.rsid === input.rsid &&
          input.deviceId === "wp12-device" && input.seatId === "seat-wp12-device"
        ) {
          return Object.freeze({
            originInvocationId: candidate.originInvocationId,
            originIdempotencyKey: `${candidate.rsid}/${candidate.originInvocationId}`,
          });
        }
      }
      return null;
    },
    // This legacy entry must never consume. D2a uses peek and calls clear only
    // after a terminal/success/failure lifecycle decision.
    takeResumeRequest: () => null,
    clear(input: Parameters<ConformanceOriginResendPolicy["clear"]>[0]) {
      pending.delete(key(input.rsid, input.originInvocationId));
    },
  });
}

/**
 * WP-12's distinct, explicitly non-production Gateway process composition.
 * The host imports the real RBP authority, ingress and server. It does not
 * import the gateway stub or any pre-production composition/credential code.
 */
export async function startProductionGatewayHost(input: {
  readonly server: Omit<GatewayServerOptions, "ports">;
  readonly ports: GatewayServerOptions["ports"];
  readonly authority: GatewayBridgeSessionAuthority;
  /** The exact durable carrier authority composed with the bridge authority. */
  readonly resourceAuthority: GatewayResourceAuthority;
  /** Installed before listen by this conformance-only composition. */
  readonly mountConformanceControl?: (app: FastifyInstance) => void;
  /**
   * The authenticated north surface used by the real-case driver.  It is
   * optional so the host remains usable for carrier-only conformance probes;
   * when present it is still bound by the server's loopback TLS policy.
   */
  readonly northMcp?: NorthMcpEndpointOptions;
  /** Deliberate, value-free admission token. No other host profile may use conformance ports. */
  readonly hostProfile: "production_conformance";
}): Promise<GatewayServerHandle & { readonly ingress: ConformanceRbpIngressHost }> {
  if (input.hostProfile !== "production_conformance") {
    throw new Error("productionGatewayHost requires production_conformance host profile");
  }
  if (input.server.config.nodeEnv === "production") {
    throw new Error("productionGatewayHost is conformance-only and refuses production configuration");
  }
  if (input.server.config.http.bindHost !== "127.0.0.1") {
    throw new Error("productionGatewayHost requires numeric loopback binding");
  }
  if (input.server.tls === undefined) {
    throw new Error("productionGatewayHost requires explicit loopback TLS material");
  }
  for (const [name, kind] of [
    ["identity", input.ports.identity.kind],
    ["entitlement", input.ports.entitlement.kind],
    ["events", input.ports.events.kind],
    ["protocol_store", input.ports.protocolStore.kind],
    ["object_store", input.ports.objectStore.kind],
    ["guardrails", input.ports.guardrails.kind],
    ["rbp_ingress", input.ports.rbpIngress.kind],
  ] as const) {
    if (kind !== "conformance") {
      throw new Error(`productionGatewayHost requires an explicit conformance ${name} adapter, not ${kind}`);
    }
  }
  if (!(input.authority instanceof GatewayBridgeSessionAuthority) || input.ports.identity !== input.authority.identity || input.ports.protocolStore !== input.authority.store) {
    throw new Error("productionGatewayHost requires one exact authority/identity/store graph");
  }
  if (!(input.resourceAuthority instanceof GatewayResourceAuthority) ||
      !input.authority.hasExactCarrierComposition(
        input.resourceAuthority,
        input.ports.objectStore,
      )) {
    throw new Error("productionGatewayHost requires one exact bridge/resource/store/object-store carrier graph");
  }
  const ingress = input.ports.rbpIngress;
  if (!isFactoryConformanceRbpIngressHost(ingress) || ingress.authority !== input.authority || ingress.delegate.authority !== input.authority || ingress.mount !== ingress.delegate.mount || ingress.handleUpgrade !== ingress.delegate.handleUpgrade || ingress.start !== ingress.delegate.start || ingress.close !== ingress.delegate.close) {
    throw new Error("productionGatewayHost requires the exact validated conformance ingress/authority graph");
  }
  const handle = await startGatewayServer({
    ...input.server,
    ports: { ...input.ports, rbpIngress: ingress },
    northMcp: input.northMcp,
    beforeListen: input.mountConformanceControl,
  });
  return Object.freeze({ ...handle, ingress: ingress as ConformanceRbpIngressHost });
}
