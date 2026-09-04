import {
  createUnavailableIdentityPort,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayConfig } from "./config.js";
import {
  M5EnrollmentEntitlementControlPlane,
  type M5Capability,
} from "./m5EnrollmentEntitlement.js";
import { createM5BridgeIdentityAuthority } from "./m5BridgeIdentityAuthority.js";
import { createOidcIdentityPort } from "./oidcIdentity.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";
import type { ProductionIdentityAuthority } from "./productionIdentityStore.js";

/**
 * EU-20-AUTH-INGRESS production composition root for the Gateway's
 * `ports.identity`.
 *
 * This is the *only* place a real deployment should build
 * `M5BridgeIdentityAuthority`: `main.ts` (`packages/gateway/package.json`'s
 * `start` script, `node dist/main.js`) is the actual production container
 * entry point (GW-2). `productionConformanceHostCli.ts` is a distinct,
 * explicitly non-production WP-12 conformance harness with its own fixture
 * identity (`ConformanceCredentialAuthority`) and is not wired here or
 * changed by this unit.
 *
 * M5's Postgres-backed enrollment/device control plane needs exactly two
 * secrets neither `GatewayConfig` nor its env allowlist carries (by design —
 * that allowlist and the startup log it feeds are asserted to be
 * value-free): the already-allowlisted `DATABASE_URL`, and a new
 * `M5_TOKEN_PEPPER` HMAC secret. Both are read directly from `process.env`
 * here, never placed on `GatewayConfig`, exactly like `DATABASE_URL`'s raw
 * value already is nowhere on `GatewayConfig` (only its *presence* is,
 * `config.credentialsPresent.databaseUrl`).
 *
 * When both are absent, this returns `null` and the caller must keep the
 * existing fail-closed identity port — never silently compose a working
 * identity port from partial configuration. `main.ts`'s other production
 * ports (`protocolStore`, `rbpIngress`, ...) remain the existing fail-closed
 * stubs regardless: no production-grade `GatewayProtocolStore` exists in
 * this codebase yet (the only implementation, `SqliteConformanceProtocolStore`,
 * is explicitly WP-12-conformance-only), so `assertProductionPorts` already
 * refuses to start a true `NODE_ENV=production` process today independent of
 * this identity wiring. That is a pre-existing GW-12 gap this bounded unit
 * does not close; composing a real identity here is still correct and
 * forward-compatible with the day a real protocol store lands.
 *
 * The returned `plane` is the *same instance* the caller must pass to
 * `startGatewayServer`'s `m5EnrollmentEntitlement` option, so the
 * `/bridge/v1/enroll` HTTP endpoint and the WSS/HTTP-SSE ingress identity
 * decision are backed by the exact same Postgres-backed control plane.
 */
export interface ProductionM5IdentityComposition {
  readonly identity: ProductionIdentityAuthority;
  readonly plane: M5EnrollmentEntitlementControlPlane;
}

/**
 * The minimal production dispatch-entitlement catalog this composition
 * grants through M5. Which tool/module capabilities a deployed Gateway
 * exposes is a product/licensing decision orthogonal to this card's scope
 * (device-credential *authentication*, not dispatch *entitlement*): this
 * lists exactly the one already-real, already-exercised read-only tool this
 * unit's own tests dispatch against the real add-in loopback fixture
 * (`m5BridgeIdentityAuthority.test.ts`, `core.get_status` /
 * `mcp_status`), as a safe, honestly-scoped starting catalog rather than an
 * invented product decision. A real deployment should replace this with its
 * actual module capability list.
 */
const PRODUCTION_M5_CAPABILITIES: readonly M5Capability[] = Object.freeze([
  Object.freeze({
    name: "core.get_status",
    module: "core",
    summary: "Report Bridge/Revit MCP runtime status (read-only).",
  }),
]);

export function composeProductionM5Identity(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProductionM5IdentityComposition | null {
  const databaseUrl = env.DATABASE_URL?.trim();
  const tokenPepper = env.M5_TOKEN_PEPPER?.trim();
  if (
    databaseUrl === undefined ||
    databaseUrl.length === 0 ||
    tokenPepper === undefined ||
    tokenPepper.length === 0
  ) {
    return null;
  }
  const plane = new M5EnrollmentEntitlementControlPlane({
    databaseUrl,
    tokenPepper,
    capabilities: PRODUCTION_M5_CAPABILITIES,
  });
  const northIdentity: IdentityPort & { readonly kind: "oidc" } =
    config.oidc?.configured === true
      ? createOidcIdentityPort({
          issuer: config.oidc.issuerUrl!,
          audience: config.oidc.clientId!,
          jwksUri: config.oidc.jwksUri!,
          repository: new PostgresTenantStore(databaseUrl),
        })
      : failClosedOidcNorthIdentity();
  const identity = createM5BridgeIdentityAuthority({ northIdentity, plane });
  return Object.freeze({ identity, plane });
}

/**
 * A `kind: "oidc"`-branded north identity that always refuses. Used only
 * when OIDC itself is not configured, so `M5BridgeIdentityAuthority`'s
 * required-`"oidc"` branding is still satisfied (device auth is unaffected —
 * M5 alone decides that) while north-user requests fail closed rather than
 * silently succeeding against nothing.
 */
function failClosedOidcNorthIdentity(): IdentityPort & { readonly kind: "oidc" } {
  const fallback = createUnavailableIdentityPort();
  return Object.freeze({
    kind: "oidc" as const,
    authenticateNorthRequest: (input: Parameters<IdentityPort["authenticateNorthRequest"]>[0]) =>
      fallback.authenticateNorthRequest(input),
    authenticateDevice: (input: Parameters<IdentityPort["authenticateDevice"]>[0]) =>
      fallback.authenticateDevice(input),
  });
}
