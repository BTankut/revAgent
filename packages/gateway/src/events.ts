import {
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortResult,
} from "./gatewayPorts.js";
import type { GatewayJsonObject } from "./dispatch.js";

/**
 * The event contract the Gateway emits against (GW-2).
 *
 * Field names are snake_case verbatim from the WP4 event schema so the Postgres
 * writer that lands later needs no translation layer between this envelope and
 * its table.
 */
export const REVAGENT_EVENT_SCHEMA = "revagent.event.v2" as const;

/**
 * The persisted O7 event vocabulary. `llm.call` and `turn.completed` are
 * instrumentation records only: RES-23/29 still leave conversation state,
 * model calls, planning, retries, and the agentic loop with the external
 * client. Nothing in this contract configures or invokes a provider.
 */
export const GATEWAY_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "turn.completed",
  "llm.call",
  "tool.invocation",
  "tool.confirmation",
  "bridge.connected",
  "bridge.disconnected",
  "bridge.enrolled",
  "bridge.revoked",
  "bridge.update",
  "auth.event",
  "registry.published",
] as const;

export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number];

export interface GatewayEventEnvelope {
  readonly schema: typeof REVAGENT_EVENT_SCHEMA;
  readonly event_id: string;
  readonly event_type: GatewayEventType;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly tenant_id: string;
  readonly source: {
    readonly component: string;
    readonly version: string;
    readonly instance: string;
  };
  readonly actor: {
    readonly type: "user" | "device" | "system";
    readonly user_id?: string;
    readonly device_id?: string;
  };
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly seq: number;
  readonly payload: GatewayJsonObject;
}

/**
 * `emitBatch` and `flush` are in the contract from the start.
 *
 * A later work package has to prove a large event burst arrives with no loss
 * through an unchanged suite. A buffering sink with no flush barrier makes that
 * unprovable, and adding the barrier afterwards would be a breaking change to
 * every adapter.
 */
export interface GatewayEventSink {
  readonly kind: GatewayPortAdapterKind;
  emit(event: GatewayEventEnvelope): Promise<GatewayPortResult<void>>;
  emitBatch(
    events: readonly GatewayEventEnvelope[],
  ): Promise<GatewayPortResult<void>>;
  flush(): Promise<GatewayPortResult<void>>;
}

export function createUnavailableEventSink(): GatewayEventSink {
  return Object.freeze({
    kind: "unavailable" as const,
    async emit(): Promise<GatewayPortResult<void>> {
      return portNotImplemented("event_sink", "no event store is configured in Phase 1");
    },
    async emitBatch(): Promise<GatewayPortResult<void>> {
      return portNotImplemented("event_sink", "no event store is configured in Phase 1");
    },
    async flush(): Promise<GatewayPortResult<void>> {
      return portNotImplemented("event_sink", "no event store is configured in Phase 1");
    },
  });
}
