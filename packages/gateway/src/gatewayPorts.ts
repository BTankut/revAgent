/**
 * The refusal shape every Phase-1 Gateway port speaks (GW-2).
 *
 * GW-2 delivers the service shell and the port *interfaces*; the adapters
 * behind them arrive in later work packages. A port that is not yet implemented
 * must therefore say so structurally rather than return `undefined`, resolve to
 * a default, or throw an anonymous error: a caller that cannot tell "refused"
 * from "succeeded with nothing" is the fail-open case this file exists to
 * prevent.
 *
 * This is deliberately separate from `dispatch.ts`'s invocation error union.
 * That union describes an invocation that reached the dispatcher; this one
 * describes infrastructure that is absent, and collapsing them would let a
 * missing adapter be reported as a tool failure.
 */

export type GatewayPortName =
  | "identity"
  | "entitlement"
  | "event_sink"
  | "protocol_store"
  | "object_store"
  | "guardrails"
  | "north_mcp"
  | "rbp_ingress"
  | "engine_mode";

/**
 * `not_implemented` — Phase 1 ships no adapter for this port.
 * `not_configured` — an adapter exists but the deployment gave it nothing.
 * `unavailable` — a configured adapter could not be reached right now.
 */
export type GatewayPortErrorCode =
  | "not_implemented"
  | "not_configured"
  | "unavailable";

export interface GatewayPortRefusal {
  readonly ok: false;
  readonly port: GatewayPortName;
  readonly code: GatewayPortErrorCode;
  readonly message: string;
}

export type GatewayPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | GatewayPortRefusal;

export function portNotImplemented(
  port: GatewayPortName,
  detail: string,
): GatewayPortRefusal {
  return Object.freeze({
    ok: false as const,
    port,
    code: "not_implemented" as const,
    message: `${port} port is not implemented in Phase 1: ${detail}`,
  });
}

export function isGatewayPortRefusal(value: unknown): value is GatewayPortRefusal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GatewayPortRefusal>;
  return (
    candidate.ok === false &&
    typeof candidate.port === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  );
}

export type GatewayPortAdapterKind =
  | "unavailable"
  | "fake"
  | "preproduction"
  | "capture"
  | "memory"
  /** Ephemeral, loopback-only WP-12 conformance adapters; never deployable. */
  | "conformance"
  | "oidc"
  | "postgres"
  | "fs";

/**
 * Adapter kinds that exist only to make tests deterministic.
 *
 * The server refuses to start in production when any injected port reports one
 * of these. That is an executable gate rather than a convention: fake identity
 * is the one adapter whose accidental promotion to a live deployment would
 * authenticate everybody.
 */
export const GATEWAY_FIXTURE_ADAPTER_KINDS = Object.freeze([
  "fake",
  "capture",
  "memory",
] as const);

export function isFixtureAdapterKind(kind: GatewayPortAdapterKind): boolean {
  return (GATEWAY_FIXTURE_ADAPTER_KINDS as readonly string[]).includes(kind);
}
