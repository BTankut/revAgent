import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
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
