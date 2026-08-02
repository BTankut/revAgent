import {
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortRefusal,
} from "./gatewayPorts.js";

/**
 * The RBP ingress mount point, reserved but not implemented (GW-2).
 *
 * The shell owns the paths so a later task can fill them in without moving the
 * public surface, and so a bridge that connects early gets a structured refusal
 * instead of a 404 it would interpret as a wrong URL.
 */
export const RBP_INGRESS_MOUNT_PREFIX = "/bridge/v1" as const;

/** The exact HTTP-fallback corpus the production ingress task will serve. */
export const RBP_INGRESS_HTTP_FALLBACK_PATHS = Object.freeze([
  "/bridge/v1/http/connections",
  "/bridge/v1/http/connections/:connection_id/events",
  "/bridge/v1/http/connections/:connection_id/messages",
] as const);

export interface RbpIngressHost {
  readonly kind: GatewayPortAdapterKind;
  readonly mountPrefix: typeof RBP_INGRESS_MOUNT_PREFIX;
  readonly enabled: boolean;
  /**
   * Synchronous so the raw `upgrade` handler can build a refusal without
   * awaiting inside a socket event, where a rejected promise would tear down
   * the connection with no status line at all.
   */
  refuse(input: {
    readonly path: string;
    readonly kind: "http" | "upgrade";
  }): GatewayPortRefusal;
}

export function createUnavailableRbpIngressHost(): RbpIngressHost {
  const host: RbpIngressHost = {
    kind: "unavailable" as const,
    mountPrefix: RBP_INGRESS_MOUNT_PREFIX,
    enabled: false,
    refuse(input): GatewayPortRefusal {
      // `not_implemented`, never 401/403: no identity was consulted on this
      // path, so an auth status code would claim an authorization decision that
      // was never made.
      return portNotImplemented(
        "rbp_ingress",
        `${input.kind} ${input.path} is reserved for the production RBP ingress`,
      );
    },
  };
  return Object.freeze(host);
}
