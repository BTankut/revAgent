import { createHash } from "node:crypto";

import { canonicalizeJson, makeParamsDigest, type JsonValue } from "@revagent/protocol";
import { z } from "zod";

import type { GatewayJsonObject, GatewayJsonValue } from "./dispatch.js";
import {
  REVAGENT_EVENT_SCHEMA,
  type GatewayEventEnvelope,
  type GatewayEventSink,
  type GatewayEventType,
} from "./events.js";
import type { GatewayPortAdapterKind, GatewayPortResult } from "./gatewayPorts.js";

const EVENT_ID_SCHEMA = z.string().uuid();
const ISO_TIME_SCHEMA = z.string().datetime({ offset: true });

const jsonValueSchema: z.ZodType = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const nonNegativeInteger = z.number().int().nonnegative();
const boundedText = z.string().min(1).max(4_096);
const nullableText = z.string().max(4_096).nullable();
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const jsonObjectSchema = z.object({}).catchall(jsonValueSchema);

const sessionStartedPayloadSchema = z.object({
  client_type: z.enum(["mcp", "web", "bridge"]),
  entitled_modules: z.array(z.string().min(1).max(128)).max(32),
}).catchall(jsonValueSchema);
const sessionEndedPayloadSchema = z.object({
  reason: boundedText,
  duration_ms: nonNegativeInteger,
  turn_count: nonNegativeInteger,
  invocation_count: nonNegativeInteger,
}).catchall(jsonValueSchema);
const turnCompletedPayloadSchema = z.object({
  engine_mode: z.literal("external_client"),
  router: z.object({
    discipline: nullableText,
    data_plane: z.enum(["live", "published"]),
    complexity: z.enum(["low", "medium", "high"]),
  }).strict(),
  llm_call_ids: z.array(z.string().uuid()).max(256),
  duration_ms: nonNegativeInteger,
}).catchall(jsonValueSchema);
const llmCallPayloadSchema = z.object({
  idempotency_key: boundedText,
  upstream_name: boundedText,
  model_name: boundedText,
  engine_mode: z.literal("external_client"),
  role: z.literal("external_client"),
  input_tokens: nonNegativeInteger,
  output_tokens: nonNegativeInteger,
  cache_read_tokens: nonNegativeInteger,
  cache_creation_tokens: nonNegativeInteger,
  duration_ms: nonNegativeInteger,
  latency_ms: nonNegativeInteger,
  cost_microusd: nonNegativeInteger,
  stop_reason: boundedText,
  outcome: z.enum(["completed", "failed", "cancelled", "timeout"]),
}).catchall(jsonValueSchema);
const toolInvocationPayloadSchema = z.object({
  dispatch_attempt_id: boundedText,
  invocation_id: boundedText,
  idempotency_key: z.string().min(1).max(256).nullable(),
  tool_name: boundedText,
  tool_version: nullableText,
  policy_class: z.enum(["auto", "confirm", "gated"]).nullable(),
  executor: z.enum(["bridge", "internal_mcp", "aps"]).nullable(),
  params_digest: sha256Schema.nullable(),
  outcome: z.enum(["completed", "guarded", "failed", "denied", "cancelled", "timeout"]),
  started_at_ms: nonNegativeInteger,
  completed_at_ms: nonNegativeInteger,
  duration_ms: nonNegativeInteger,
  request_bytes: nonNegativeInteger.optional(),
  response_bytes: nonNegativeInteger.optional(),
  params_summary: jsonObjectSchema.optional(),
  code: jsonObjectSchema.nullable().optional(),
  context: jsonObjectSchema.nullable().optional(),
  search: jsonObjectSchema.nullable().optional(),
}).catchall(jsonValueSchema).superRefine((payload, context) => {
  if (payload.completed_at_ms < payload.started_at_ms) {
    context.addIssue({ code: "custom", message: "completed_at_ms must not precede started_at_ms", path: ["completed_at_ms"] });
  }
  if (payload.duration_ms !== payload.completed_at_ms - payload.started_at_ms) {
    context.addIssue({ code: "custom", message: "duration_ms must equal the bounded invocation interval", path: ["duration_ms"] });
  }
});
const toolConfirmationPayloadSchema = z.object({
  invocation_id: nullableText,
  state: z.enum(["requested", "approved", "denied", "expired"]),
  tool_name: boundedText,
  tool_version: nullableText,
  confirmation_id: nullableText,
  preview_ref: nullableText,
  recorded_at_ms: nonNegativeInteger,
}).catchall(jsonValueSchema);
const bridgeConnectedPayloadSchema = z.object({
  device_id: boundedText,
  bridge_version: nullableText,
  addin_version: nullableText,
  revit_version: nullableText,
  protocol_version: nullableText,
}).catchall(jsonValueSchema);
const bridgeDisconnectedPayloadSchema = z.object({
  device_id: boundedText,
  reason: boundedText,
  connected_ms: nonNegativeInteger,
}).catchall(jsonValueSchema);
const bridgeEnrollmentPayloadSchema = z.object({
  device_id: boundedText,
  by_user: nullableText,
  reason: nullableText,
}).catchall(jsonValueSchema);
const bridgeUpdatePayloadSchema = z.object({
  device_id: boundedText,
  from_version: nullableText,
  to_version: nullableText,
  status: z.enum(["started", "applied", "failed", "deferred"]),
  reason: nullableText,
  error: nullableText,
}).catchall(jsonValueSchema);
const authEventPayloadSchema = z.object({
  kind: z.enum(["login", "login_failed", "logout", "token_rotated", "seat_denied", "entitlement_denied", "role_changed"]),
  subject: nullableText,
  detail: jsonObjectSchema.nullable(),
  ip: nullableText,
}).catchall(jsonValueSchema);
const registryPublishedPayloadSchema = z.object({
  entity: z.enum(["tool", "module", "instruction_doc", "bridge_release"]),
  entity_id: boundedText,
  version: nullableText,
  by_user: nullableText,
}).catchall(jsonValueSchema);

const envelopeShape = {
  schema: z.literal(REVAGENT_EVENT_SCHEMA),
  event_id: EVENT_ID_SCHEMA,
  occurred_at: ISO_TIME_SCHEMA,
  recorded_at: ISO_TIME_SCHEMA,
  tenant_id: EVENT_ID_SCHEMA,
  source: z.object({
    component: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    instance: z.string().min(1).max(256),
  }).strict(),
  actor: z.object({
    type: z.enum(["user", "device", "system"]),
    user_id: EVENT_ID_SCHEMA.optional(),
    device_id: EVENT_ID_SCHEMA.optional(),
  }).strict(),
  session_id: EVENT_ID_SCHEMA.optional(),
  turn_id: EVENT_ID_SCHEMA.optional(),
  seq: z.number().int().nonnegative(),
};

/** P-EVT-1: one discriminated envelope with one zod-validated payload per kind. */
export const EU12_EVENT_ENVELOPE_SCHEMA = z.discriminatedUnion("event_type", [
  z.object({ ...envelopeShape, event_type: z.literal("session.started"), payload: sessionStartedPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("session.ended"), payload: sessionEndedPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("turn.completed"), payload: turnCompletedPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("llm.call"), payload: llmCallPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("tool.invocation"), payload: toolInvocationPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("tool.confirmation"), payload: toolConfirmationPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("bridge.connected"), payload: bridgeConnectedPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("bridge.disconnected"), payload: bridgeDisconnectedPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("bridge.enrolled"), payload: bridgeEnrollmentPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("bridge.revoked"), payload: bridgeEnrollmentPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("bridge.update"), payload: bridgeUpdatePayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("auth.event"), payload: authEventPayloadSchema }).strict(),
  z.object({ ...envelopeShape, event_type: z.literal("registry.published"), payload: registryPublishedPayloadSchema }).strict(),
]).superRefine((event, context) => {
  if (event.actor.type === "user" && event.actor.user_id === undefined) {
    context.addIssue({ code: "custom", message: "user events require actor.user_id", path: ["actor", "user_id"] });
  }
  if (event.actor.type === "device" && event.actor.device_id === undefined) {
    context.addIssue({ code: "custom", message: "device events require actor.device_id", path: ["actor", "device_id"] });
  }
  if ((event.event_type === "tool.invocation" || event.event_type === "llm.call") && event.session_id === undefined) {
    context.addIssue({ code: "custom", message: "invocation records require session_id", path: ["session_id"] });
  }
});

export type Eu12EventRoute = "events" | "tool_invocations" | "llm_calls";

export interface Eu12EventWriteReceipt {
  readonly eventId: string;
  readonly tenantId: string;
  readonly route: Eu12EventRoute;
  readonly digest: `sha256:${string}`;
  readonly disposition: "inserted" | "duplicate";
}

export interface Eu12EventPersistence {
  readonly kind: GatewayPortAdapterKind;
  write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]>;
  read(scope: { readonly tenantId: string; readonly eventId: string }): Promise<GatewayEventEnvelope | null>;
  list(scope: { readonly tenantId: string }): Promise<readonly GatewayEventEnvelope[]>;
}

export class Eu12EventValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Eu12EventValidationError";
  }
}

export class Eu12EventIdempotencyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Eu12EventIdempotencyError";
  }
}

export class Eu12EventBackpressureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Eu12EventBackpressureError";
  }
}

interface StoredEvent {
  readonly event: GatewayEventEnvelope;
  readonly digest: `sha256:${string}`;
  readonly route: Eu12EventRoute;
}

function asGatewayEventEnvelope(value: unknown): GatewayEventEnvelope {
  const parsed = EU12_EVENT_ENVELOPE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`);
    throw new Eu12EventValidationError(`invalid revagent.event.v2 envelope: ${issues.join("; ")}`);
  }
  return Object.freeze({
    schema: parsed.data.schema,
    event_id: parsed.data.event_id,
    event_type: parsed.data.event_type as GatewayEventType,
    occurred_at: parsed.data.occurred_at,
    recorded_at: parsed.data.recorded_at,
    tenant_id: parsed.data.tenant_id,
    source: Object.freeze({ ...parsed.data.source }),
    actor: Object.freeze({ ...parsed.data.actor }),
    ...(parsed.data.session_id === undefined ? {} : { session_id: parsed.data.session_id }),
    ...(parsed.data.turn_id === undefined ? {} : { turn_id: parsed.data.turn_id }),
    seq: parsed.data.seq,
    payload: Object.freeze(parsed.data.payload as GatewayJsonObject),
  });
}

function asJsonValue(value: GatewayJsonValue): JsonValue {
  return value as JsonValue;
}

function eventIdentity(event: GatewayEventEnvelope): JsonValue {
  return {
    schema: event.schema,
    event_type: event.event_type,
    tenant_id: event.tenant_id,
    source: event.source as JsonValue,
    actor: event.actor as JsonValue,
    session_id: event.session_id ?? null,
    turn_id: event.turn_id ?? null,
    payload: event.payload as JsonValue,
  };
}

function eventIdempotencyKey(event: GatewayEventEnvelope): string | null {
  const candidate = event.payload.idempotency_key;
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256
    ? `${event.tenant_id}/${event.event_type}/${candidate}`
    : null;
}

export function eventIdempotencyDigest(event: GatewayEventEnvelope): `sha256:${string}` {
  const hash = createHash("sha256").update(canonicalizeJson(eventIdentity(event)), "utf8").digest("hex");
  return `sha256:${hash}`;
}

export function eventEnvelopeDigest(event: GatewayEventEnvelope): `sha256:${string}` {
  // Dispatch attaches request scope as a non-enumerable convenience property;
  // hash only the canonical persisted envelope, never that runtime attachment.
  const persisted = validateEu12EventEnvelope(event);
  const hash = createHash("sha256").update(canonicalizeJson(asJsonValue(persisted as unknown as GatewayJsonValue)), "utf8").digest("hex");
  return `sha256:${hash}`;
}

export function validateEu12EventEnvelope(value: unknown): GatewayEventEnvelope {
  return asGatewayEventEnvelope(value);
}

export function routeEu12Event(event: GatewayEventEnvelope): Eu12EventRoute {
  if (event.event_type === "tool.invocation") return "tool_invocations";
  if (event.event_type === "llm.call") return "llm_calls";
  return "events";
}

/**
 * A passive observation hook for the authorized external client path. This
 * function only validates/labels already-observed usage; it has no transport,
 * credential, model-call, planner, retry, or conversation-state behavior.
 */
export interface ExternalLlmMeteringObservation {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly source: GatewayEventEnvelope["source"];
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly upstreamName: string;
  readonly modelName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens?: number;
  readonly durationMs: number;
  readonly cost: number;
  readonly stopReason?: string | null;
  readonly outcome?: "completed" | "failed" | "cancelled" | "timeout";
}

export function createExternalLlmMeteringEvent(input: ExternalLlmMeteringObservation): GatewayEventEnvelope {
  const cacheCreationTokens = input.cacheCreationTokens ?? 0;
  const costMicrousd = Math.round(input.cost * 1_000_000);
  for (const value of [input.inputTokens, input.outputTokens, input.cacheReadTokens, cacheCreationTokens, input.durationMs, input.cost, costMicrousd]) {
    if (!Number.isFinite(value) || value < 0) throw new Eu12EventValidationError("metering counters must be finite non-negative values");
  }
  return validateEu12EventEnvelope({
    schema: REVAGENT_EVENT_SCHEMA,
    event_id: input.eventId,
    event_type: "llm.call",
    occurred_at: input.occurredAt,
    recorded_at: input.recordedAt,
    tenant_id: input.tenantId,
    source: input.source,
    actor: { type: "user", user_id: input.actorUserId },
    session_id: input.sessionId,
    seq: input.sequence,
    payload: {
      idempotency_key: input.idempotencyKey,
      upstream_name: input.upstreamName,
      model_name: input.modelName,
      engine_mode: "external_client",
      role: "external_client",
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cache_read_tokens: input.cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      duration_ms: input.durationMs,
      latency_ms: input.durationMs,
      cost_microusd: costMicrousd,
      stop_reason: input.stopReason ?? "unknown",
      outcome: input.outcome ?? "completed",
    },
  });
}

/**
 * Deterministic conformance persistence. Its tenant-indexed API models the
 * Postgres RLS boundary, while production adapters can implement the same port.
 */
export class InMemoryEu12EventPersistence implements Eu12EventPersistence {
  public readonly kind = "memory" as const;
  readonly #byEventId = new Map<string, StoredEvent>();
  readonly #byTenant = new Map<string, Map<string, StoredEvent>>();
  readonly #byIdempotencyKey = new Map<string, StoredEvent>();

  public async write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]> {
    const validated = events.map((event) => validateEu12EventEnvelope(event));
    const staged: Array<{ readonly event: GatewayEventEnvelope; readonly digest: `sha256:${string}`; readonly route: Eu12EventRoute; readonly idempotencyKey: string | null }> = [];
    for (const event of validated) {
      const digest = eventEnvelopeDigest(event);
      const route = routeEu12Event(event);
      const knownById = this.#byEventId.get(event.event_id);
      if (knownById !== undefined && (knownById.digest !== digest || knownById.event.tenant_id !== event.tenant_id)) {
        throw new Eu12EventIdempotencyError("event_id replay changed immutable event evidence");
      }
      const idempotencyKey = eventIdempotencyKey(event);
      const knownByIdempotency = idempotencyKey === null ? undefined : this.#byIdempotencyKey.get(idempotencyKey);
      if (knownByIdempotency !== undefined && eventIdempotencyDigest(knownByIdempotency.event) !== eventIdempotencyDigest(event)) {
        throw new Eu12EventIdempotencyError("idempotency_key replay changed immutable event evidence");
      }
      staged.push(Object.freeze({ event, digest, route, idempotencyKey }));
    }

    const receipts: Eu12EventWriteReceipt[] = [];
    for (const item of staged) {
      const existing = this.#byEventId.get(item.event.event_id) ??
        (item.idempotencyKey === null ? undefined : this.#byIdempotencyKey.get(item.idempotencyKey));
      if (existing !== undefined) {
        receipts.push(Object.freeze({
          eventId: existing.event.event_id,
          tenantId: existing.event.tenant_id,
          route: existing.route,
          digest: existing.digest,
          disposition: "duplicate",
        }));
        continue;
      }
      const stored = Object.freeze({ event: item.event, digest: item.digest, route: item.route });
      this.#byEventId.set(item.event.event_id, stored);
      let tenantRecords = this.#byTenant.get(item.event.tenant_id);
      if (tenantRecords === undefined) {
        tenantRecords = new Map<string, StoredEvent>();
        this.#byTenant.set(item.event.tenant_id, tenantRecords);
      }
      tenantRecords.set(item.event.event_id, stored);
      if (item.idempotencyKey !== null) this.#byIdempotencyKey.set(item.idempotencyKey, stored);
      receipts.push(Object.freeze({
        eventId: item.event.event_id,
        tenantId: item.event.tenant_id,
        route: item.route,
        digest: item.digest,
        disposition: "inserted",
      }));
    }
    return Object.freeze(receipts);
  }

  public async read(scope: { readonly tenantId: string; readonly eventId: string }): Promise<GatewayEventEnvelope | null> {
    return this.#byTenant.get(scope.tenantId)?.get(scope.eventId)?.event ?? null;
  }

  public async list(scope: { readonly tenantId: string }): Promise<readonly GatewayEventEnvelope[]> {
    return Object.freeze([...(this.#byTenant.get(scope.tenantId)?.values() ?? [])]
      .map((stored) => stored.event)
      .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id)));
  }

  /** Retention is deliberately tenant-scoped even in the conformance adapter. */
  public async listForRetention(input: { readonly tenantId: string; readonly month: string }): Promise<readonly GatewayEventEnvelope[]> {
    if (!/^\d{4}-\d{2}$/u.test(input.month)) throw new Error("retention month must be YYYY-MM");
    return Object.freeze((await this.list({ tenantId: input.tenantId }))
      .filter((event) => event.occurred_at.slice(0, 7) === input.month));
  }

  public async dropArchived(input: { readonly tenantId: string; readonly eventIds: readonly string[] }): Promise<number> {
    let removed = 0;
    const tenantRecords = this.#byTenant.get(input.tenantId);
    if (tenantRecords === undefined) return 0;
    for (const eventId of input.eventIds) {
      const stored = tenantRecords.get(eventId);
      if (stored === undefined) continue;
      tenantRecords.delete(eventId);
      this.#byEventId.delete(eventId);
      const key = eventIdempotencyKey(stored.event);
      if (key !== null && this.#byIdempotencyKey.get(key) === stored) this.#byIdempotencyKey.delete(key);
      removed += 1;
    }
    return removed;
  }
}

interface QueuedWrite {
  readonly events: readonly GatewayEventEnvelope[];
  readonly resolve: (receipts: readonly Eu12EventWriteReceipt[]) => void;
  readonly reject: (reason: unknown) => void;
}

export interface BoundedEu12EventWriterOptions {
  readonly persistence: Eu12EventPersistence;
  readonly maxPendingEvents?: number;
}

/** Bounded, serial durable writer used by the event sink without a lossy queue. */
export class BoundedEu12EventWriter implements GatewayEventSink {
  public readonly kind: GatewayPortAdapterKind;
  public readonly bounded = true as const;
  readonly #persistence: Eu12EventPersistence;
  readonly #maxPendingEvents: number;
  readonly #queue: QueuedWrite[] = [];
  readonly #flushWaiters: Array<() => void> = [];
  #pendingEvents = 0;
  #draining = false;

  public constructor(options: BoundedEu12EventWriterOptions) {
    if (!Number.isSafeInteger(options.maxPendingEvents ?? 1_024) || (options.maxPendingEvents ?? 1_024) < 1) {
      throw new Error("maxPendingEvents must be a positive integer");
    }
    this.#persistence = options.persistence;
    this.#maxPendingEvents = options.maxPendingEvents ?? 1_024;
    this.kind = options.persistence.kind;
  }

  public get pendingEvents(): number {
    return this.#pendingEvents;
  }

  public get maxPendingEvents(): number {
    return this.#maxPendingEvents;
  }

  public async write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]> {
    const validated = events.map((event) => validateEu12EventEnvelope(event));
    if (validated.length === 0) return Object.freeze([]);
    if (validated.length > this.#maxPendingEvents || this.#pendingEvents + validated.length > this.#maxPendingEvents) {
      throw new Eu12EventBackpressureError(`event writer capacity ${this.#maxPendingEvents} would be exceeded`);
    }
    this.#pendingEvents += validated.length;
    const written = new Promise<readonly Eu12EventWriteReceipt[]>((resolve, reject) => {
      this.#queue.push(Object.freeze({ events: validated, resolve, reject }));
    });
    void this.#drain();
    return await written;
  }

  public async emit(event: GatewayEventEnvelope): Promise<GatewayPortResult<void>> {
    try {
      await this.write([event]);
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return Object.freeze({
        ok: false as const,
        port: "event_sink" as const,
        code: "unavailable" as const,
        message: "bounded event persistence rejected the event",
      });
    }
  }

  public async emitBatch(events: readonly GatewayEventEnvelope[]): Promise<GatewayPortResult<void>> {
    try {
      await this.write(events);
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return Object.freeze({
        ok: false as const,
        port: "event_sink" as const,
        code: "unavailable" as const,
        message: "bounded event persistence rejected the event batch",
      });
    }
  }

  public async flush(): Promise<GatewayPortResult<void>> {
    if (this.#pendingEvents === 0) return Object.freeze({ ok: true as const, value: undefined });
    await new Promise<void>((resolve) => this.#flushWaiters.push(resolve));
    return Object.freeze({ ok: true as const, value: undefined });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift();
        if (next === undefined) continue;
        try {
          next.resolve(await this.#persistence.write(next.events));
        } catch (error) {
          next.reject(error);
        } finally {
          this.#pendingEvents -= next.events.length;
        }
      }
    } finally {
      this.#draining = false;
      if (this.#pendingEvents === 0) {
        while (this.#flushWaiters.length > 0) this.#flushWaiters.shift()?.();
      }
    }
  }
}

const SAFE_STRING_KEYS = new Set([
  "transactionMode", "responseMode", "planMode", "planCandidateMode",
  "targetVisualStyle", "intent", "imageFormat", "cameraOrientation",
  "viewType", "category", "discipline", "cropBasis", "searchBudget",
  "linkScope", "reason", "scanStoppedReason",
]);

const WRITE_PATTERNS: readonly Readonly<{ readonly name: string; readonly pattern: RegExp }>[] = Object.freeze([
  { name: "Parameter.Set", pattern: /\.Set\s*\(/iu },
  { name: "Parameter.SetValueString", pattern: /\.SetValueString\s*\(/iu },
  { name: "Parameter.ClearValue", pattern: /\.ClearValue\s*\(/iu },
  { name: "Schedule.SetCellText", pattern: /\.\s*SetCellText\s*\(/iu },
  { name: "Schedule table edit", pattern: /\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/iu },
  { name: "Document.Delete", pattern: /\.\s*Delete\s*\(/iu },
  { name: "ElementTransformUtils", pattern: /ElementTransformUtils/iu },
  { name: "Location.Move", pattern: /\.Move\s*\(/iu },
  { name: "Element.ChangeTypeId", pattern: /\.ChangeTypeId\s*\(/iu },
  { name: "Connector.ConnectTo", pattern: /\.ConnectTo\s*\(/iu },
  { name: "Connector.DisconnectFrom", pattern: /\.DisconnectFrom\s*\(/iu },
  { name: "FamilySymbol.Activate", pattern: /\.Activate\s*\(/iu },
  { name: "NewFamilyInstance", pattern: /NewFamilyInstance/u },
  { name: "Create API", pattern: /\.(Create|New[A-Z]\w*)\s*\(/u },
  { name: "View visibility/overrides", pattern: /\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/iu },
  { name: "Geometry join/cut", pattern: /(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/u },
  { name: "Parameter binding edit", pattern: /\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/iu },
  { name: "Revit property assignment", pattern: /\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/iu },
  { name: "Manual Transaction", pattern: /new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/iu },
]);

function shortHash(value: unknown): string {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function truncateText(value: unknown, maxChars: number): GatewayJsonObject {
  const text = String(value || "");
  return text.length <= maxChars
    ? Object.freeze({ text, truncated: false })
    : Object.freeze({ text: `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`, truncated: true });
}

function summarizeText(value: unknown, maxChars: number): GatewayJsonObject {
  const text = String(value || "");
  const summary: Record<string, GatewayJsonValue> = {
    hash: shortHash(text), length: text.length, present: text.length > 0,
  };
  if (maxChars > 0) {
    const preview = truncateText(text, maxChars);
    summary.text = preview.text as string;
    summary.textTruncated = preview.truncated as boolean;
  }
  return Object.freeze(summary);
}

export function summarizeAuditCode(value: unknown, codeLimit = 4_000): GatewayJsonObject {
  const text = String(value || "");
  const patterns = WRITE_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.name);
  const summary: Record<string, GatewayJsonValue> = {
    hash: shortHash(text),
    length: text.length,
    lineCount: text.split(/\r\n|\r|\n/u).length,
    writePatternCount: patterns.length,
    writePatterns: patterns.slice(0, 12),
    hasManualTransaction: /new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/iu.test(text),
  };
  if (codeLimit > 0) {
    const preview = truncateText(text, codeLimit);
    summary.preview = preview.text as string;
    summary.previewTruncated = preview.truncated as boolean;
  }
  return Object.freeze(summary);
}

export interface AuditSummaryOptions {
  readonly textLimit?: number;
  readonly codeLimit?: number;
}

export function summarizeAuditParams(params: GatewayJsonObject = {}, options: AuditSummaryOptions = {}): GatewayJsonObject {
  const textLimit = options.textLimit ?? 1_000;
  const codeLimit = options.codeLimit ?? 4_000;
  if (!Number.isSafeInteger(textLimit) || textLimit < 0 || !Number.isSafeInteger(codeLimit) || codeLimit < 0) {
    throw new Error("audit summary limits must be non-negative integers");
  }
  const summary: Record<string, GatewayJsonValue> = { keys: [] };
  const keys = Object.keys(params).sort();
  summary.keys = keys.filter((key) => key !== "code" && key !== "parameters");
  for (const key of keys) {
    const value = params[key];
    if (key === "code") {
      summary.code = summarizeAuditCode(value, codeLimit);
      continue;
    }
    if (key === "parameters") {
      summary.parameters = { count: Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1 };
      continue;
    }
    if (/elementIds$/iu.test(key) && Array.isArray(value)) {
      summary[key] = { count: value.length };
      continue;
    }
    if (Array.isArray(value)) {
      summary[key] = { count: value.length };
      continue;
    }
    if (value !== null && typeof value === "object") {
      summary[key] = { keys: Object.keys(value).sort() };
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      summary[key] = value;
      continue;
    }
    if (typeof value === "string") {
      summary[key] = SAFE_STRING_KEYS.has(key) ? value : summarizeText(value, textLimit);
    }
  }
  return Object.freeze(summary);
}

export function summarizeAuditInput(params: GatewayJsonObject, options: AuditSummaryOptions = {}): Readonly<{
  readonly paramsDigest: `sha256:${string}`;
  readonly paramsSummary: GatewayJsonObject;
}> {
  return Object.freeze({
    paramsDigest: makeParamsDigest(params as JsonValue),
    paramsSummary: summarizeAuditParams(params, options),
  });
}
