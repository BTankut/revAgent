import type { GatewayJsonObject, GatewayJsonValue } from "./dispatch.js";
import type { GatewayEventEnvelope } from "./events.js";
import { summarizeAuditInput, validateEu12EventEnvelope } from "./eventPersistence.js";
import type { Eu12EventWriteReceipt } from "./eventPersistence.js";
import type { ResultReference, ResultReferenceScope } from "./resultReferenceStore.js";

export interface Eu12InvocationEventWriter {
  write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]>;
}

export interface Eu12InvocationResultWriter {
  put(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey?: string;
    readonly invocationId?: string;
    readonly refLabel?: string;
    readonly expiresAtMs?: number;
  }): Promise<ResultReference>;
}

export interface Eu12InvocationInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly source: GatewayEventEnvelope["source"];
  readonly sequence: number;
  readonly idempotencyKey: string;
  /** Stable across transport redelivery; distinct from the envelope event id. */
  readonly invocationId?: string;
  readonly dispatchAttemptId?: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: "auto" | "confirm" | "gated";
  readonly executor: "bridge" | "internal_mcp" | "aps";
  readonly outcome: "completed" | "guarded" | "failed" | "denied" | "cancelled" | "timeout";
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly params: GatewayJsonObject;
  readonly context?: GatewayJsonObject;
  readonly search?: GatewayJsonObject;
  readonly result: GatewayJsonValue;
  readonly resultExpiresAtMs?: number;
}

export interface Eu12InvocationReceipt {
  readonly event: GatewayEventEnvelope;
  readonly eventWrite: Eu12EventWriteReceipt;
  readonly resultRef: ResultReference;
}

/**
 * This is deliberately a persistence composition, not a dispatcher or model
 * loop. An external client remains responsible for the invocation itself.
 */
export class Eu12InvocationRecorder {
  readonly #events: Eu12InvocationEventWriter;
  readonly #results: Eu12InvocationResultWriter;

  public constructor(input: { readonly events: Eu12InvocationEventWriter; readonly results: Eu12InvocationResultWriter }) {
    this.#events = input.events;
    this.#results = input.results;
  }

  public async record(input: Eu12InvocationInput): Promise<Eu12InvocationReceipt> {
    if (!Number.isSafeInteger(input.startedAtMs) || !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs < input.startedAtMs ||
      !Number.isSafeInteger(input.requestBytes) || input.requestBytes < 0 || !Number.isSafeInteger(input.responseBytes) || input.responseBytes < 0) {
      throw new Error("invocation audit timing or byte counts are invalid");
    }
    const audit = summarizeAuditInput(input.params);
    const event = validateEu12EventEnvelope({
      schema: "revagent.event.v2",
      event_id: input.eventId,
      event_type: "tool.invocation",
      occurred_at: new Date(input.completedAtMs).toISOString(),
      recorded_at: new Date(input.completedAtMs).toISOString(),
      tenant_id: input.tenantId,
      source: input.source,
      actor: { type: "user", user_id: input.actorUserId },
      session_id: input.sessionId,
      seq: input.sequence,
      payload: Object.freeze({
        dispatch_attempt_id: input.dispatchAttemptId ?? input.idempotencyKey,
        invocation_id: input.invocationId ?? input.idempotencyKey,
        idempotency_key: input.idempotencyKey,
        tool_name: input.toolName,
        tool_version: input.toolVersion,
        policy_class: input.policyClass,
        executor: input.executor,
        params_digest: audit.paramsDigest,
        params_summary: audit.paramsSummary,
        code: input.params.code === undefined ? null : audit.paramsSummary.code ?? null,
        outcome: input.outcome,
        started_at_ms: input.startedAtMs,
        completed_at_ms: input.completedAtMs,
        duration_ms: input.completedAtMs - input.startedAtMs,
        request_bytes: input.requestBytes,
        response_bytes: input.responseBytes,
        context: input.context ?? null,
        search: input.search ?? null,
      }),
    });
    const [eventWrite] = await this.#events.write([event]);
    if (eventWrite === undefined) throw new Error("event writer returned no invocation receipt");
    const resultRef = await this.#results.put({
      scope: { tenantId: input.tenantId, sessionId: input.sessionId },
      payload: input.result,
      idempotencyKey: `result-${input.idempotencyKey}`,
      invocationId: input.invocationId ?? input.idempotencyKey,
      // Durable stores allocate R17 then non-colliding labels on the same session.
      refLabel: undefined,
      expiresAtMs: input.resultExpiresAtMs,
    });
    return Object.freeze({ event, eventWrite, resultRef });
  }
}
