import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { type ConformanceRbpIngressHost } from "./rbpIngress.js";
import {
  startGatewayServer,
  type GatewayServerHandle,
  type GatewayServerOptions,
} from "./server.js";

/**
 * WP-12's distinct, explicitly non-production Gateway process composition.
 * The host imports the real RBP authority, ingress and server. It does not
 * import the gateway stub or any pre-production composition/credential code.
 */
export async function startProductionGatewayHost(input: {
  readonly server: Omit<GatewayServerOptions, "ports">;
  readonly ports: GatewayServerOptions["ports"];
  readonly authority: GatewayBridgeSessionAuthority;
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
  if (input.ports.identity !== input.authority.identity || input.ports.protocolStore !== input.authority.store) {
    throw new Error("productionGatewayHost requires one exact authority/identity/store graph");
  }
  const ingress = input.ports.rbpIngress;
  if (!(ingress instanceof Object) || ingress.kind !== "conformance" || ingress.authority !== input.authority) {
    throw new Error("productionGatewayHost requires the exact validated conformance ingress/authority graph");
  }
  const handle = await startGatewayServer({
    ...input.server,
    ports: { ...input.ports, rbpIngress: ingress },
  });
  return Object.freeze({ ...handle, ingress: ingress as ConformanceRbpIngressHost });
}
