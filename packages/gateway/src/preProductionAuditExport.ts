import { isGatewayUuidV7 } from "./identifiers.js";

export const PRE_PRODUCTION_AUDIT_EXPORT_CONTRACT_VERSION =
  "revagent.m4-value-free-audit-export/v1" as const;

export const PRE_PRODUCTION_AUDIT_EXPORT_LIMITS = Object.freeze({
  maxInputEvents: 128,
  maxSelectedRecords: 64,
  maxRecordBytes: 4_096,
  maxTotalBytes: 131_072,
} as const);

export const PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS = Object.freeze([
  "invalid_invocation",
  "invalid_selector",
  "already_attempted",
  "source_unavailable",
  "input_event_limit_exceeded",
  "event_schema_refused",
  "selector_mismatch",
  "selected_record_missing",
  "selected_record_limit_exceeded",
  "duplicate_sequence",
  "duplicate_event_id",
  "record_byte_limit_exceeded",
  "total_byte_limit_exceeded",
] as const);

export type PreProductionAuditExportErrorReason =
  (typeof PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS)[number];

const ERROR_MESSAGES: Readonly<
  Record<PreProductionAuditExportErrorReason, string>
> = Object.freeze({
  invalid_invocation: "pre-production audit export invocation is invalid",
  invalid_selector: "pre-production audit export selector is invalid",
  already_attempted: "pre-production audit export was already attempted",
  source_unavailable: "pre-production audit event source is unavailable",
  input_event_limit_exceeded:
    "pre-production audit export input event limit exceeded",
  event_schema_refused: "pre-production audit event schema was refused",
  selector_mismatch: "pre-production audit selector did not match",
  selected_record_missing: "pre-production audit export has no selected record",
  selected_record_limit_exceeded:
    "pre-production audit export selected record limit exceeded",
  duplicate_sequence: "pre-production audit export sequence is duplicated",
  duplicate_event_id: "pre-production audit export event identifier is duplicated",
  record_byte_limit_exceeded:
    "pre-production audit export record byte limit exceeded",
  total_byte_limit_exceeded:
    "pre-production audit export total byte limit exceeded",
});

export class PreProductionAuditExportError extends Error {
  readonly code = "preproduction_audit_export_refused" as const;

  constructor(readonly reason: PreProductionAuditExportErrorReason) {
    super(ERROR_MESSAGES[reason]);
    this.name = "PreProductionAuditExportError";
    Object.freeze(this);
  }
}

export interface PreProductionAuditExportInput {
  readonly profile: "lan_test";
  readonly mode: "preproduction";
  readonly selector: {
    readonly tenantId: string;
    readonly userId: string;
    readonly principalKey: string;
    readonly gatewaySessionId: string;
  };
  readonly approvedTools: readonly PreProductionAuditApprovedTool[];
  readonly events: readonly unknown[];
}

export interface PreProductionAuditApprovedTool {
  readonly name: string;
  readonly version: string;
  readonly policyClass: PreProductionAuditPolicyClass;
  readonly mutationScopePolicy: PreProductionAuditMutationScopePolicy;
  readonly executor: PreProductionAuditExecutor;
}

export interface PreProductionAuditSelectorEvidence {
  readonly tenantBound: true;
  readonly userBound: true;
  readonly principalBound: true;
  readonly gatewaySessionBound: true;
}

export type PreProductionAuditPolicyClass = "auto" | "confirm" | "gated";
export type PreProductionAuditPolicyDecision =
  | "auto"
  | "preview"
  | "confirmed"
  | "gated_approved"
  | "denied";
export type PreProductionAuditMutationScopePolicy =
  | "none"
  | "document"
  | "session";
export type PreProductionAuditExecutor = "bridge" | "internal_mcp" | "aps";
export type PreProductionAuditInvocationOutcome =
  | "completed"
  | "guarded"
  | "confirmation_required"
  | "failed";
export type PreProductionAuditConfirmationState =
  | "requested"
  | "approved"
  | "denied"
  | "expired";

interface PreProductionAuditRecordBase {
  readonly schema: "revagent.event.v2";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly seq: number;
}

export interface PreProductionInvocationAuditRecord
  extends PreProductionAuditRecordBase {
  readonly recordType: "invocation";
  readonly eventType: "tool.invocation";
  readonly dispatchAttemptId: string;
  readonly invocationId: string | null;
  readonly confirmationId: string | null;
  readonly originatingPreviewInvocationId: string | null;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: PreProductionAuditPolicyClass;
  readonly policyDecision: PreProductionAuditPolicyDecision | null;
  readonly mutationScopePolicy: PreProductionAuditMutationScopePolicy;
  readonly mutating: boolean | null;
  readonly executor: PreProductionAuditExecutor;
  readonly paramsDigest: `sha256:${string}` | null;
  readonly previewDigest: `sha256:${string}` | null;
  readonly commitArgsDigest: `sha256:${string}` | null;
  readonly outcome: PreProductionAuditInvocationOutcome;
  readonly executorReached: boolean;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly durationMs: number;
}

export interface PreProductionConfirmationAuditRecord
  extends PreProductionAuditRecordBase {
  readonly recordType: "confirmation";
  readonly eventType: "tool.confirmation";
  readonly invocationId: string | null;
  readonly state: PreProductionAuditConfirmationState;
  readonly confirmationId: string | null;
  readonly originatingPreviewInvocationId: string | null;
  readonly commitInvocationId: string | null;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly commitArgsDigest: `sha256:${string}` | null;
  readonly previewDigest: `sha256:${string}` | null;
  readonly recordedAtMs: number;
}

export type PreProductionAuditExportRecord =
  | PreProductionInvocationAuditRecord
  | PreProductionConfirmationAuditRecord;

export interface PreProductionAuditExportBundle {
  readonly contractVersion: typeof PRE_PRODUCTION_AUDIT_EXPORT_CONTRACT_VERSION;
  readonly profile: "lan_test";
  readonly mode: "preproduction";
  readonly approvedLiveSelector: true;
  readonly complete: true;
  readonly selector: PreProductionAuditSelectorEvidence;
  readonly recordCount: number;
  readonly records: readonly PreProductionAuditExportRecord[];
}

const PROJECTED_AUDIT_BUNDLES = new WeakSet<object>();

/**
 * Runtime provenance guard for the stdout writer.
 *
 * TypeScript types are not a security boundary: a caller could otherwise cast
 * a raw or extra-field object to `PreProductionAuditExportBundle` and bypass
 * the closed value-free projection. Only objects produced by this module's
 * projector are admitted to the retained-evidence writer.
 */
export function isProjectedPreProductionAuditBundle(
  value: unknown,
): value is PreProductionAuditExportBundle {
  return (
    value !== null &&
    typeof value === "object" &&
    PROJECTED_AUDIT_BUNDLES.has(value)
  );
}

type PlainRecord = Record<string, unknown>;

const EVENT_TYPES = new Set([
  "session.started",
  "session.ended",
  "tool.invocation",
  "tool.confirmation",
  "bridge.connected",
  "bridge.disconnected",
  "bridge.enrolled",
  "bridge.revoked",
  "auth.event",
  "registry.published",
]);
const POLICY_CLASSES = new Set(["auto", "confirm", "gated"]);
const POLICY_DECISIONS = new Set([
  "auto",
  "preview",
  "confirmed",
  "gated_approved",
  "denied",
]);
const MUTATION_SCOPE_POLICIES = new Set(["none", "document", "session"]);
const EXECUTORS = new Set(["bridge", "internal_mcp", "aps"]);
const INVOCATION_OUTCOMES = new Set([
  "completed",
  "guarded",
  "confirmation_required",
  "failed",
]);
const CONFIRMATION_STATES = new Set([
  "requested",
  "approved",
  "denied",
  "expired",
]);
const ACTOR_ROLES = new Set(["user", "tenant_admin", "vendor_admin"]);
const ACTOR_TYPES = new Set(["user", "device", "system"]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const TOOL_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

const INPUT_KEYS = Object.freeze([
  "profile",
  "mode",
  "selector",
  "approvedTools",
  "events",
]);
const SELECTOR_KEYS = Object.freeze([
  "tenantId",
  "userId",
  "principalKey",
  "gatewaySessionId",
]);
const APPROVED_TOOL_KEYS = Object.freeze([
  "name",
  "version",
  "policyClass",
  "mutationScopePolicy",
  "executor",
]);
const EVENT_REQUIRED_KEYS = Object.freeze([
  "schema",
  "event_id",
  "event_type",
  "occurred_at",
  "recorded_at",
  "tenant_id",
  "source",
  "actor",
  "seq",
  "payload",
]);
const EVENT_OPTIONAL_KEYS = Object.freeze(["session_id", "turn_id"]);
const INVOCATION_PAYLOAD_KEYS = Object.freeze([
  "dispatch_attempt_id",
  "invocation_id",
  "idempotency_key",
  "principal_key",
  "actor_role",
  "gateway_session_id",
  "oauth_client_id",
  "mcp_session_id",
  "rsid",
  "tool_name",
  "tool_version",
  "policy_class",
  "policy_decision",
  "confirmation_id",
  "originating_preview_invocation_id",
  "preview_digest",
  "preview_ref",
  "commit_args_digest",
  "confirmation_reason",
  "mutation_scope_policy",
  "mutating",
  "executor",
  "document_identity",
  "params_digest",
  "mutation_scope",
  "recovery_hold_ids",
  "recovery_resolution_ids",
  "outcome",
  "outcome_error_code",
  "executor_reached",
  "started_at_ms",
  "completed_at_ms",
  "duration_ms",
]);
const CONFIRMATION_PAYLOAD_KEYS = Object.freeze([
  "invocation_id",
  "state",
  "confirmation_id",
  "originating_preview_invocation_id",
  "commit_invocation_id",
  "principal_key",
  "actor_role",
  "gateway_session_id",
  "mcp_session_id",
  "confirmation_session_id",
  "oauth_client_id",
  "tool_name",
  "tool_version",
  "commit_args_digest",
  "preview_digest",
  "preview_ref",
  "reason",
  "recorded_at_ms",
]);

function refuse(reason: PreProductionAuditExportErrorReason): never {
  throw new PreProductionAuditExportError(reason);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const requiredSet = new Set(required);
  const allowedSet = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowedSet.has(key)) &&
    keys.length >= requiredSet.size
  );
}

function isBoundedText(value: unknown, maxLength = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNullableBoundedText(value: unknown): value is string | null {
  return value === null || isBoundedText(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafeMillisecond(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableUuidV7(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isGatewayUuidV7(value));
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isNullableDigest(value: unknown): value is `sha256:${string}` | null {
  return value === null || isDigest(value);
}

function isNullableEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === null || (typeof value === "string" && allowed.has(value));
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((entry) => isBoundedText(entry))
  );
}

function validateSource(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["component", "version", "instance"]) &&
    value.component === "revagent-gateway" &&
    value.version === "revagent.m4-preproduction-serving/v1" &&
    value.instance === "m4-lan-test"
  );
}

function validateActor(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type"], ["user_id", "device_id"]) ||
    typeof value.type !== "string" ||
    !ACTOR_TYPES.has(value.type)
  ) {
    return false;
  }
  return (
    (value.user_id === undefined || isBoundedText(value.user_id)) &&
    (value.device_id === undefined || isBoundedText(value.device_id))
  );
}

interface ValidatedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly tenantId: string;
  readonly actor: PlainRecord;
  readonly sessionId: string | undefined;
  readonly seq: number;
  readonly payload: PlainRecord;
}

function validateEnvelope(value: unknown): ValidatedEvent {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, EVENT_REQUIRED_KEYS, EVENT_OPTIONAL_KEYS) ||
    value.schema !== "revagent.event.v2" ||
    typeof value.event_type !== "string" ||
    !EVENT_TYPES.has(value.event_type) ||
    typeof value.event_id !== "string" ||
    !isGatewayUuidV7(value.event_id) ||
    !isCanonicalTimestamp(value.occurred_at) ||
    !isCanonicalTimestamp(value.recorded_at) ||
    !isBoundedText(value.tenant_id) ||
    !validateSource(value.source) ||
    !validateActor(value.actor) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    !isPlainRecord(value.payload) ||
    (value.session_id !== undefined && !isBoundedText(value.session_id)) ||
    (value.turn_id !== undefined && !isBoundedText(value.turn_id))
  ) {
    refuse("event_schema_refused");
  }

  return {
    eventId: value.event_id,
    eventType: value.event_type,
    occurredAt: value.occurred_at,
    recordedAt: value.recorded_at,
    tenantId: value.tenant_id,
    actor: value.actor as PlainRecord,
    sessionId: value.session_id as string | undefined,
    seq: value.seq as number,
    payload: value.payload,
  };
}

function validateSelector(input: PlainRecord): PreProductionAuditExportInput {
  if (
    !hasExactKeys(input, INPUT_KEYS) ||
    input.profile !== "lan_test" ||
    input.mode !== "preproduction" ||
    !isPlainRecord(input.selector) ||
    !hasExactKeys(input.selector, SELECTOR_KEYS) ||
    !isBoundedText(input.selector.tenantId) ||
    !isBoundedText(input.selector.userId) ||
    !isBoundedText(input.selector.principalKey) ||
    !isBoundedText(input.selector.gatewaySessionId) ||
    !Array.isArray(input.approvedTools) ||
    input.approvedTools.length < 1 ||
    input.approvedTools.length > 256 ||
    !Array.isArray(input.events)
  ) {
    refuse("invalid_selector");
  }
  const bindings = new Set<string>();
  for (const approvedTool of input.approvedTools) {
    if (
      !isPlainRecord(approvedTool) ||
      !hasExactKeys(approvedTool, APPROVED_TOOL_KEYS) ||
      typeof approvedTool.name !== "string" ||
      !TOOL_NAME_PATTERN.test(approvedTool.name) ||
      typeof approvedTool.version !== "string" ||
      !TOOL_VERSION_PATTERN.test(approvedTool.version) ||
      typeof approvedTool.policyClass !== "string" ||
      !POLICY_CLASSES.has(approvedTool.policyClass) ||
      typeof approvedTool.mutationScopePolicy !== "string" ||
      !MUTATION_SCOPE_POLICIES.has(approvedTool.mutationScopePolicy) ||
      typeof approvedTool.executor !== "string" ||
      !EXECUTORS.has(approvedTool.executor)
    ) {
      refuse("invalid_selector");
    }
    const binding = `${approvedTool.name}\u0000${approvedTool.version}`;
    if (bindings.has(binding)) {
      refuse("invalid_selector");
    }
    bindings.add(binding);
  }
  return input as unknown as PreProductionAuditExportInput;
}

function approvedToolFor(
  input: PreProductionAuditExportInput,
  toolName: unknown,
  toolVersion: unknown,
): PreProductionAuditApprovedTool {
  if (typeof toolName !== "string" || typeof toolVersion !== "string") {
    refuse("event_schema_refused");
  }
  const approvedTool = input.approvedTools.find(
    (candidate) =>
      candidate.name === toolName && candidate.version === toolVersion,
  );
  if (approvedTool === undefined) {
    refuse("event_schema_refused");
  }
  return approvedTool;
}

function selectorMatches(
  event: ValidatedEvent,
  selector: PreProductionAuditExportInput["selector"],
): boolean {
  return (
    event.tenantId === selector.tenantId &&
    event.actor.type === "user" &&
    event.actor.user_id === selector.userId &&
    event.sessionId === selector.gatewaySessionId &&
    event.payload.principal_key === selector.principalKey &&
    event.payload.gateway_session_id === selector.gatewaySessionId
  );
}

function validateDiscardedInvocationFields(payload: PlainRecord): boolean {
  const nullableDocumentIdentity = payload.document_identity;
  const nullableMutationScope = payload.mutation_scope;
  return (
    isNullableBoundedText(payload.idempotency_key) &&
    typeof payload.actor_role === "string" &&
    ACTOR_ROLES.has(payload.actor_role) &&
    isBoundedText(payload.gateway_session_id) &&
    isBoundedText(payload.oauth_client_id) &&
    isBoundedText(payload.mcp_session_id) &&
    isNullableBoundedText(payload.rsid) &&
    isNullableBoundedText(payload.preview_ref) &&
    isNullableBoundedText(payload.confirmation_reason) &&
    (nullableDocumentIdentity === null || isPlainRecord(nullableDocumentIdentity)) &&
    (nullableMutationScope === null || isPlainRecord(nullableMutationScope)) &&
    isStringArray(payload.recovery_hold_ids) &&
    isStringArray(payload.recovery_resolution_ids) &&
    isNullableBoundedText(payload.outcome_error_code)
  );
}

function invocationRecord(
  event: ValidatedEvent,
  approvedTool: PreProductionAuditApprovedTool,
): PreProductionInvocationAuditRecord {
  const payload = event.payload;
  if (
    !hasExactKeys(payload, INVOCATION_PAYLOAD_KEYS) ||
    !validateDiscardedInvocationFields(payload) ||
    typeof payload.dispatch_attempt_id !== "string" ||
    !isGatewayUuidV7(payload.dispatch_attempt_id) ||
    !isNullableUuidV7(payload.invocation_id) ||
    !isNullableUuidV7(payload.confirmation_id) ||
    !isNullableUuidV7(payload.originating_preview_invocation_id) ||
    typeof payload.tool_name !== "string" ||
    !TOOL_NAME_PATTERN.test(payload.tool_name) ||
    typeof payload.tool_version !== "string" ||
    !TOOL_VERSION_PATTERN.test(payload.tool_version) ||
    !isNullableEnum(payload.policy_class, POLICY_CLASSES) ||
    !isNullableEnum(payload.policy_decision, POLICY_DECISIONS) ||
    !isNullableEnum(payload.mutation_scope_policy, MUTATION_SCOPE_POLICIES) ||
    !(payload.mutating === null || typeof payload.mutating === "boolean") ||
    !isNullableEnum(payload.executor, EXECUTORS) ||
    !isNullableDigest(payload.params_digest) ||
    !isNullableDigest(payload.preview_digest) ||
    !isNullableDigest(payload.commit_args_digest) ||
    typeof payload.outcome !== "string" ||
    !INVOCATION_OUTCOMES.has(payload.outcome) ||
    typeof payload.executor_reached !== "boolean" ||
    !isSafeMillisecond(payload.started_at_ms) ||
    !isSafeMillisecond(payload.completed_at_ms) ||
    !isSafeMillisecond(payload.duration_ms) ||
    payload.completed_at_ms < payload.started_at_ms ||
    payload.duration_ms !== payload.completed_at_ms - payload.started_at_ms ||
    event.occurredAt !== new Date(payload.completed_at_ms).toISOString() ||
    event.recordedAt !== event.occurredAt
  ) {
    refuse("event_schema_refused");
  }
  if (
    payload.tool_name !== approvedTool.name ||
    payload.tool_version !== approvedTool.version ||
    payload.policy_class !== approvedTool.policyClass ||
    payload.mutation_scope_policy !== approvedTool.mutationScopePolicy ||
    payload.executor !== approvedTool.executor
  ) {
    refuse("event_schema_refused");
  }
  const expectedMutating = approvedTool.mutationScopePolicy !== "none";
  if (
    (payload.mutating !== null && payload.mutating !== expectedMutating) ||
    (payload.mutating === null &&
      (payload.outcome !== "failed" ||
        payload.executor_reached !== false ||
        payload.document_identity !== null ||
        payload.mutation_scope !== null))
  ) {
    refuse("event_schema_refused");
  }
  if (
    payload.policy_decision !== null &&
    payload.policy_decision !== "denied" &&
    ((approvedTool.policyClass === "auto" &&
      payload.policy_decision !== "auto") ||
      (approvedTool.policyClass === "confirm" &&
        payload.policy_decision !== "preview" &&
        payload.policy_decision !== "confirmed") ||
      (approvedTool.policyClass === "gated" &&
        payload.policy_decision !== "gated_approved"))
  ) {
    refuse("event_schema_refused");
  }

  return Object.freeze({
    recordType: "invocation" as const,
    schema: "revagent.event.v2" as const,
    eventId: event.eventId,
    eventType: "tool.invocation" as const,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    seq: event.seq,
    dispatchAttemptId: payload.dispatch_attempt_id,
    invocationId: payload.invocation_id,
    confirmationId: payload.confirmation_id,
    originatingPreviewInvocationId: payload.originating_preview_invocation_id,
    toolName: payload.tool_name,
    toolVersion: payload.tool_version,
    policyClass: payload.policy_class as PreProductionAuditPolicyClass,
    policyDecision:
      payload.policy_decision as PreProductionAuditPolicyDecision | null,
    mutationScopePolicy:
      payload.mutation_scope_policy as PreProductionAuditMutationScopePolicy,
    mutating: payload.mutating,
    executor: payload.executor as PreProductionAuditExecutor,
    paramsDigest: payload.params_digest,
    previewDigest: payload.preview_digest,
    commitArgsDigest: payload.commit_args_digest,
    outcome: payload.outcome as PreProductionAuditInvocationOutcome,
    executorReached: payload.executor_reached,
    startedAtMs: payload.started_at_ms,
    completedAtMs: payload.completed_at_ms,
    durationMs: payload.duration_ms,
  });
}

function validateDiscardedConfirmationFields(payload: PlainRecord): boolean {
  return (
    typeof payload.actor_role === "string" &&
    ACTOR_ROLES.has(payload.actor_role) &&
    isBoundedText(payload.gateway_session_id) &&
    isBoundedText(payload.mcp_session_id) &&
    isBoundedText(payload.confirmation_session_id) &&
    payload.confirmation_session_id === payload.mcp_session_id &&
    isBoundedText(payload.oauth_client_id) &&
    isNullableBoundedText(payload.preview_ref) &&
    isNullableBoundedText(payload.reason)
  );
}

function confirmationRecord(
  event: ValidatedEvent,
  approvedTool: PreProductionAuditApprovedTool,
): PreProductionConfirmationAuditRecord {
  const payload = event.payload;
  if (
    !hasExactKeys(payload, CONFIRMATION_PAYLOAD_KEYS) ||
    !validateDiscardedConfirmationFields(payload) ||
    !isNullableUuidV7(payload.invocation_id) ||
    typeof payload.state !== "string" ||
    !CONFIRMATION_STATES.has(payload.state) ||
    !isNullableUuidV7(payload.confirmation_id) ||
    !isNullableUuidV7(payload.originating_preview_invocation_id) ||
    !isNullableUuidV7(payload.commit_invocation_id) ||
    typeof payload.tool_name !== "string" ||
    !TOOL_NAME_PATTERN.test(payload.tool_name) ||
    typeof payload.tool_version !== "string" ||
    !TOOL_VERSION_PATTERN.test(payload.tool_version) ||
    !isNullableDigest(payload.commit_args_digest) ||
    !isNullableDigest(payload.preview_digest) ||
    !isSafeMillisecond(payload.recorded_at_ms) ||
    event.occurredAt !== new Date(payload.recorded_at_ms).toISOString() ||
    event.recordedAt !== event.occurredAt
  ) {
    refuse("event_schema_refused");
  }
  if (
    payload.tool_name !== approvedTool.name ||
    payload.tool_version !== approvedTool.version ||
    (payload.state !== "denied" && approvedTool.policyClass !== "confirm") ||
    (payload.state !== "denied" &&
      (payload.invocation_id === null ||
        payload.confirmation_id === null ||
        payload.originating_preview_invocation_id === null))
  ) {
    refuse("event_schema_refused");
  }

  return Object.freeze({
    recordType: "confirmation" as const,
    schema: "revagent.event.v2" as const,
    eventId: event.eventId,
    eventType: "tool.confirmation" as const,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    seq: event.seq,
    invocationId: payload.invocation_id,
    state: payload.state as PreProductionAuditConfirmationState,
    confirmationId: payload.confirmation_id,
    originatingPreviewInvocationId: payload.originating_preview_invocation_id,
    commitInvocationId: payload.commit_invocation_id,
    toolName: payload.tool_name,
    toolVersion: payload.tool_version,
    commitArgsDigest: payload.commit_args_digest,
    previewDigest: payload.preview_digest,
    recordedAtMs: payload.recorded_at_ms,
  });
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Projects a detached event-sink snapshot into the sole closed M4 audit bundle.
 * Raw envelopes are compared and validated in-process; they are never spread or
 * retained by the returned object.
 */
export function projectPreProductionAudit(
  input: PreProductionAuditExportInput,
): PreProductionAuditExportBundle {
  if (!isPlainRecord(input)) {
    refuse("invalid_invocation");
  }
  const validatedInput = validateSelector(input);
  if (
    validatedInput.events.length >
    PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxInputEvents
  ) {
    refuse("input_event_limit_exceeded");
  }

  const sequences = new Set<number>();
  const eventIds = new Set<string>();
  const records: PreProductionAuditExportRecord[] = [];

  for (const rawEvent of validatedInput.events) {
    const event = validateEnvelope(rawEvent);
    if (sequences.has(event.seq)) {
      refuse("duplicate_sequence");
    }
    sequences.add(event.seq);
    if (eventIds.has(event.eventId)) {
      refuse("duplicate_event_id");
    }
    eventIds.add(event.eventId);

    if (
      event.eventType !== "tool.invocation" &&
      event.eventType !== "tool.confirmation"
    ) {
      continue;
    }
    if (!selectorMatches(event, validatedInput.selector)) {
      refuse("selector_mismatch");
    }
    const record =
      event.eventType === "tool.invocation"
        ? invocationRecord(
            event,
            approvedToolFor(
              validatedInput,
              event.payload.tool_name,
              event.payload.tool_version,
            ),
          )
        : confirmationRecord(
            event,
            approvedToolFor(
              validatedInput,
              event.payload.tool_name,
              event.payload.tool_version,
            ),
          );
    if (
      serializedBytes(record) >
      PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxRecordBytes
    ) {
      refuse("record_byte_limit_exceeded");
    }
    records.push(record);
  }

  if (records.length === 0) {
    refuse("selected_record_missing");
  }
  if (
    records.length > PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxSelectedRecords
  ) {
    refuse("selected_record_limit_exceeded");
  }
  records.sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));

  const selector = Object.freeze({
    tenantBound: true as const,
    userBound: true as const,
    principalBound: true as const,
    gatewaySessionBound: true as const,
  });
  const bundle: PreProductionAuditExportBundle = Object.freeze({
    contractVersion: PRE_PRODUCTION_AUDIT_EXPORT_CONTRACT_VERSION,
    profile: "lan_test" as const,
    mode: "preproduction" as const,
    approvedLiveSelector: true as const,
    complete: true as const,
    selector,
    recordCount: records.length,
    records: Object.freeze(records),
  });
  if (
    serializedBytes(bundle) > PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxTotalBytes
  ) {
    refuse("total_byte_limit_exceeded");
  }
  PROJECTED_AUDIT_BUNDLES.add(bundle);
  return bundle;
}
