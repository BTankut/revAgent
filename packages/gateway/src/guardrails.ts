import {
  type GatewayPortAdapterKind,
} from "./gatewayPorts.js";
import type { AuthContext } from "./authContext.js";

/**
 * The guardrail seam (GW-2).
 *
 * Deliberately a single `evaluate` rather than a chain with a fixed stage
 * order. Idempotency propagation and confirmation round trips are the
 * acceptance criteria of later tasks; pinning their order from a two-day shell
 * would fix downstream behaviour before it is designed, and would stop those
 * tasks from exercising one stage in isolation.
 *
 * This port is intentionally **not** wired into `GatewayDispatcher` yet. The
 * dispatcher's existing inline refusal stays exactly as it is until the policy
 * middleware task replaces it, so no existing test changes behaviour here.
 */
export type GuardrailRefusalCode =
  | "not_implemented"
  | "entitlement_denied"
  | "policy_refused"
  | "actor_binding_failed"
  | "idempotency_conflict";

export type GuardrailDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: GuardrailRefusalCode; readonly message: string };

export interface GuardrailPort {
  readonly kind: GatewayPortAdapterKind;
  evaluate(input: {
    readonly auth: AuthContext;
    readonly toolName: string;
    readonly toolVersion: string;
  }): Promise<GuardrailDecision>;
}

export function createUnavailableGuardrailPort(): GuardrailPort {
  return Object.freeze({
    kind: "unavailable" as const,
    async evaluate(): Promise<GuardrailDecision> {
      return Object.freeze({
        ok: false as const,
        code: "not_implemented" as const,
        message:
          "guardrails port is not implemented in Phase 1: no policy middleware is installed",
      });
    },
  });
}
