import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { createProductionRbpIngressHost } from "./rbpIngress.js";
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
}): Promise<GatewayServerHandle> {
  if (input.server.config.nodeEnv === "production") {
    throw new Error("productionGatewayHost is conformance-only and refuses production configuration");
  }
  if (input.server.config.http.bindHost !== "127.0.0.1") {
    throw new Error("productionGatewayHost requires numeric loopback binding");
  }
  for (const [name, kind] of [
    ["identity", input.ports.identity.kind],
    ["protocol_store", input.ports.protocolStore.kind],
    ["object_store", input.ports.objectStore.kind],
  ] as const) {
    if (kind !== "conformance") {
      throw new Error(`productionGatewayHost requires an explicit conformance ${name} adapter, not ${kind}`);
    }
  }
  if (input.ports.identity !== input.authority.identity || input.ports.protocolStore !== input.authority.store) {
    throw new Error("productionGatewayHost requires one exact authority/identity/store graph");
  }
  const ingress = createProductionRbpIngressHost({ authority: input.authority });
  return startGatewayServer({
    ...input.server,
    ports: { ...input.ports, rbpIngress: ingress },
  });
}
