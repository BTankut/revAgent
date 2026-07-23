import type {
  CanonicalAssertionOracle,
  CanonicalAssertionOracleContext,
  CanonicalAssertionOracleRegistry,
} from "./canonicalEvaluators.js";
import { canonicalManifest } from "./manifest.js";
import {
  RAW_PRODUCTION_CASES,
  rawProductionFrameFact,
} from "./productionCaseSeedsRaw.js";
import type { ProcessObservationRecord } from "./types.js";

type ObjectValue = Record<string, unknown>;
type ObservationKind = ProcessObservationRecord["kind"];

const FORBIDDEN_VERDICT_KEYS = new Set(["actual", "passed", "verdict"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function objectValue(value: unknown): ObjectValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? value as ObjectValue
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function pathValue(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    const object = objectValue(cursor);
    if (object === null || !Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    cursor = object[segment];
  }
  return cursor;
}

function visitObjects(
  value: unknown,
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  if (Array.isArray(value)) return value.some((entry) => visitObjects(entry, predicate));
  const object = objectValue(value);
  if (object === null) return false;
  if (Object.keys(object).some((key) => FORBIDDEN_VERDICT_KEYS.has(key))) {
    const retained = Object.fromEntries(
      Object.entries(object).filter(([key]) => !FORBIDDEN_VERDICT_KEYS.has(key)),
    );
    if (predicate(retained)) return true;
  } else if (predicate(object)) {
    return true;
  }
  return Object.entries(object).some(([key, entry]) =>
    !FORBIDDEN_VERDICT_KEYS.has(key) && visitObjects(entry, predicate));
}

function observations(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind?: ObservationKind,
): readonly ProcessObservationRecord[] {
  return context.observations.filter((observation) =>
    observation.caseId === context.caseId &&
    observation.binding === context.binding &&
    (kind === undefined || observation.kind === kind));
}

function hasDomainObject(
  context: Readonly<CanonicalAssertionOracleContext>,
  kinds: readonly ObservationKind[],
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  return observations(context)
    .filter(({ kind }) => kinds.includes(kind))
    .some(({ payload }) => visitObjects(payload, predicate));
}

function stepIdOf(payload: ObjectValue): string | null {
  return stringValue(payload.stepId);
}

function rawWire(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const fact = rawProductionFrameFact(stepId);
  if (fact === undefined || fact.caseId !== context.caseId) return null;
  const matches = observations(context, "wire_event").filter(({ payload }) => {
    const object = objectValue(payload);
    return object !== null && stepIdOf(object) === stepId;
  });
  if (matches.length !== 1) return null;
  const payload = objectValue(matches[0]!.payload);
  if (
    payload === null ||
    payload.action !== "send_binding_frame" ||
    payload.direction !== "parent_to_gateway" ||
    payload.binding !== context.binding
  ) {
    return null;
  }
  const serialized = objectValue(payload.serialized);
  const frame = objectValue(payload.frame);
  const remote = objectValue(payload.remoteOutcome);
  if (
    serialized === null ||
    frame === null ||
    remote === null ||
    serialized.bytes !== fact.bytes ||
    serialized.sha256 !== fact.sha256 ||
    frame.source !== fact.source ||
    frame.type !== fact.type ||
    payload.credentialSource !== fact.credentialSource
  ) {
    return null;
  }
  const expectedRemoteKind = context.binding === "wss"
    ? "wss_exchange"
    : "streamable_http_sse_exchange";
  return remote.kind === expectedRemoteKind ? payload : null;
}

function parsedRemoteFrames(remote: ObjectValue): readonly ObjectValue[] {
  const direct = arrayValue(remote.receivedFrames);
  const sse = objectValue(remote.sse);
  const fromSse = sse === null ? [] : arrayValue(sse.receivedFrames);
  return [...direct, ...fromSse]
    .map((frame) => objectValue(frame))
    .filter((frame): frame is ObjectValue => frame !== null)
    .filter((frame) => frame.parseState === "parsed")
    .map((frame) => objectValue(frame.parsed))
    .filter((frame): frame is ObjectValue => frame !== null);
}

function remoteMessages(remote: ObjectValue): string[] {
  const messages: string[] = [];
  for (const frame of parsedRemoteFrames(remote)) {
    const payload = objectValue(frame.payload);
    const message = stringValue(payload?.message);
    if (message !== null) messages.push(message);
  }
  for (const responseName of ["createResponse", "messagesResponse"] as const) {
    const response = objectValue(remote[responseName]);
    const body = objectValue(response?.body);
    const parsed = objectValue(body?.parsed);
    for (const candidate of [parsed?.error, parsed?.message]) {
      if (typeof candidate === "string") messages.push(candidate);
    }
  }
  const close = objectValue(remote.close);
  const closeReason = stringValue(close?.reason);
  if (closeReason !== null) messages.push(closeReason);
  return messages;
}

function remoteFaultClass(remote: ObjectValue): string | null {
  for (const frame of parsedRemoteFrames(remote)) {
    if (frame.type !== "error") continue;
    const faultClass = stringValue(objectValue(frame.payload)?.fault_class);
    if (faultClass !== null) return faultClass;
  }
  return null;
}

function rawRemote(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(rawWire(context, stepId)?.remoteOutcome);
}

function rawHasResponseType(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  expectedType: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (parsedRemoteFrames(remote).some((frame) => frame.type === expectedType)) return true;
  const created = objectValue(pathValue(remote, ["createResponse", "body", "parsed"]));
  return created?.type === expectedType;
}

function rawAcceptedWithoutResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (context.binding === "streamable_http_sse") {
    return pathValue(remote, ["messagesResponse", "status"]) === 202;
  }
  const close = objectValue(remote.close);
  return close === null || close.remote !== true || close.code === 1000;
}

function rawGoodbyeAccepted(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (context.binding === "streamable_http_sse") {
    return pathValue(remote, ["messagesResponse", "status"]) === 202;
  }
  const close = objectValue(remote.close);
  return close?.remote === true && close.code === 1000;
}

function rawFault(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  faultClass: "protocol" | "auth",
  message: RegExp,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null || remoteFaultClass(remote) !== faultClass) return false;
  if (!remoteMessages(remote).some((candidate) => message.test(candidate))) return false;
  if (context.binding === "wss") {
    const close = objectValue(remote.close);
    return close?.remote === true && close.code === (faultClass === "auth" ? 4403 : 4400);
  }
  return pathValue(remote, ["messagesResponse", "status"]) === 400 ||
    pathValue(remote, ["createResponse", "status"]) === 400;
}

function rawPostSchema(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  type: string,
): boolean {
  const directionallyAccepted = rawFault(
    context,
    stepId,
    "protocol",
    new RegExp(`directionally invalid ${type}`, "iu"),
  );
  const authorizedAfterSchema = rawFault(
    context,
    stepId,
    "auth",
    /resume|token|session|device|binding|authorization|credential|foreign/i,
  );
  return directionallyAccepted || authorizedAfterSchema || rawAcceptedWithoutResponse(context, stepId);
}

function rawSchemaRejected(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  detail: RegExp = /invalid|schema|required|must|envelope|base64|digest|safe integer|sequence|chunk|payload/i,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  const protocolFault = remoteFaultClass(remote) === "protocol" ||
    (
      context.binding === "streamable_http_sse" &&
      pathValue(remote, ["createResponse", "status"]) === 400
    );
  if (!protocolFault) return false;
  const messages = remoteMessages(remote);
  return messages.some((message) =>
    detail.test(message) &&
    !/directionally invalid|does not match the active|foreign session/i.test(message));
}

function controlResult(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const matches = observations(context, "control_result").filter(({ payload }) => {
    const object = objectValue(payload);
    return object?.schemaVersion === "rbp-step-control-observation/v1" &&
      object.stepId === stepId;
  });
  if (matches.length !== 1) return null;
  const payload = objectValue(matches[0]!.payload);
  const request = objectValue(payload?.request);
  const response = objectValue(payload?.response);
  if (
    payload === null ||
    request === null ||
    response === null ||
    typeof request.action !== "string"
  ) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(response, "result")
    ? objectValue(response.result)
    : objectValue(response.details) ?? response;
}

function semanticControl(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  predicate: (result: Readonly<ObjectValue>) => boolean,
): boolean {
  const result = controlResult(context, stepId);
  return result !== null && predicate(result);
}

function transportOpened(
  context: Readonly<CanonicalAssertionOracleContext>,
  requestedKind: "wss" | "streamable_http_sse",
): boolean {
  return observations(context, "control_result").some(({ payload }) => {
    const root = objectValue(payload);
    const request = objectValue(root?.request);
    const requestArguments = objectValue(request?.arguments);
    const response = objectValue(root?.response);
    const result = objectValue(response?.result);
    const helloAck = objectValue(result?.helloAck);
    return request?.action === "open_transport" &&
      requestArguments?.kind === requestedKind &&
      result?.requestedKind === requestedKind &&
      result.selectedKind === requestedKind &&
      typeof result.connectionId === "string" &&
      helloAck?.type === "hello_ack";
  });
}

function snapshots(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: Extract<ObservationKind, "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count">,
): readonly ObjectValue[] {
  return observations(context, kind)
    .map(({ payload }) => objectValue(payload))
    .filter((payload): payload is ObjectValue => payload !== null);
}

function snapshotHas(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: Extract<ObservationKind, "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count">,
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  return snapshots(context, kind).some((snapshot) => visitObjects(snapshot, predicate));
}

function safe(predicate: CanonicalAssertionOracle): CanonicalAssertionOracle {
  return (context) => {
    try {
      return predicate(context) === true;
    } catch {
      return false;
    }
  };
}

function exactRawFault(
  stepId: string,
  faultClass: "protocol" | "auth",
  message: RegExp,
): CanonicalAssertionOracle {
  return safe((context) => rawFault(context, stepId, faultClass, message));
}

function exactSchemaAccepted(stepId: string, type: string): CanonicalAssertionOracle {
  return safe((context) => rawPostSchema(context, stepId, type));
}

function exactSchemaRejected(stepId: string, detail?: RegExp): CanonicalAssertionOracle {
  return safe((context) => rawSchemaRejected(context, stepId, detail));
}

function exactHelloAccepted(stepId: string): CanonicalAssertionOracle {
  return safe((context) => rawHasResponseType(context, stepId, "hello_ack"));
}

function semanticEvent(
  kinds: readonly ObservationKind[],
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): CanonicalAssertionOracle {
  return safe((context) => hasDomainObject(context, kinds, predicate));
}

function fixtureCount(
  context: Readonly<CanonicalAssertionOracleContext>,
  invocation: RegExp,
  expected: number,
): boolean {
  return snapshotHas(context, "fixture_execution_count", (candidate) =>
    Object.entries(candidate).some(([key, value]) =>
      invocation.test(key) && value === expected));
}

const entries: Array<readonly [string, CanonicalAssertionOracle]> = [];

function define(assertionId: string, oracle: CanonicalAssertionOracle): void {
  if (entries.some(([existing]) => existing === assertionId)) {
    throw new Error(`duplicate raw production oracle ${assertionId}`);
  }
  entries.push([assertionId, safe(oracle)]);
}

define(
  "O1-C25-CROSS-DEVICE-RESUME-REJECT",
  exactRawFault("o1-c25.cross-device-resume", "auth", /device|credential|resume token/i),
);
define(
  "O1-C25-CROSS-RSID-RESUME-REJECT",
  exactRawFault("o1-c25.cross-rsid-resume", "auth", /rsid|session|resume token/i),
);
define(
  "O1-C25-INVOCATION-AUTHORIZATION-REJECT",
  semanticEvent(["control_result", "gateway_snapshot", "wire_event"], (candidate) =>
    (candidate.stepId === "o1-c25.unknown-session-invoke" ||
      candidate.rsid === "rs_unregistered") &&
    (
      candidate.faultClass === "auth" ||
      candidate.fault_class === "auth" ||
      /not registered|unknown session|foreign session/i.test(String(candidate.message ?? candidate.error ?? ""))
    )),
);

define("O1-C26-N-COMPATIBLE", exactHelloAccepted("o1-c26.version-n"));
define("O1-C26-N-MINUS-ONE-COMPATIBLE", exactHelloAccepted("o1-c26.version-n-minus-one"));
define("O1-C26-ADDITIVE-CHANGE-ACCEPTED", exactHelloAccepted("o1-c26.additive"));
define("O1-C26-BREAKING-CHANGE-REJECTED", exactSchemaRejected(
  "o1-c26.breaking",
  /addin_versions|required|invalid|schema|hello/i,
));

define(
  "O1-C27-FULL-JITTER-BOUNDS",
  semanticEvent(["wire_event", "bridge_snapshot"], (candidate) => {
    const attempt = numberValue(candidate.attemptIndex ?? candidate.attempt_index);
    const delay = numberValue(candidate.delayMs ?? candidate.delay_ms);
    if (attempt === null || delay === null || !Number.isSafeInteger(attempt) || attempt < 0) return false;
    const limit = Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 30)));
    return delay >= 0 && delay <= limit;
  }),
);
define(
  "O1-C27-SIXTY-SECOND-CAP",
  semanticEvent(["wire_event", "bridge_snapshot"], (candidate) => {
    const attempt = numberValue(candidate.attemptIndex ?? candidate.attempt_index);
    const limit = numberValue(candidate.limitMs ?? candidate.limit_ms ?? candidate.baseMs ?? candidate.base_ms);
    return attempt !== null && attempt >= 6 && limit === 60_000;
  }),
);
define(
  "O1-C27-NO-EARLY-RESET",
  semanticEvent(["wire_event", "bridge_snapshot"], (candidate) => {
    const steady = numberValue(candidate.steadyDurationMs ?? candidate.steady_ms);
    const reset = boolValue(candidate.reset);
    return steady !== null && steady < 120_000 && reset === false;
  }),
);
define(
  "O1-C27-RESET-AFTER-STEADY",
  semanticEvent(["wire_event", "bridge_snapshot"], (candidate) => {
    const steady = numberValue(candidate.steadyDurationMs ?? candidate.steady_ms);
    const reset = boolValue(candidate.reset);
    return steady !== null && steady >= 120_000 && reset === true;
  }),
);

define(
  "O1-C28-HOLD-INSTALLED",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    typeof (candidate.holdId ?? candidate.hold_id) === "string" &&
    (candidate.state === "active" ||
      candidate.state === "evidence_recorded" ||
      candidate.state === "resolved_pending_bridge" ||
      candidate.state === "cleared") &&
    (
      candidate.scopeKey === "session" ||
      objectValue(candidate.mutationScope ?? candidate.mutation_scope)?.kind === "session"
    ) &&
    arrayValue(candidate.originIdempotencyKeys ?? candidate.origin_invocation_ids).length > 0),
);
define(
  "O1-C28-FRESH-ID-BLOCKED",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.stepId === "o1-c28.fresh-id" || candidate.kind === "blocked") &&
    /hold|journal_indeterminate|conflict/i.test(String(candidate.reason ?? candidate.faultClass ?? candidate.message ?? ""))),
);
define(
  "O1-C28-BATCH-WRITE-BLOCKED",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.stepId === "o1-c28.batch" || candidate.kind === "blocked") &&
    /hold|journal_indeterminate|conflict/i.test(String(candidate.reason ?? candidate.faultClass ?? candidate.message ?? ""))),
);
define(
  "O1-C28-INCONCLUSIVE-READ-RETAINS",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.kind === "inconclusive_recorded" || candidate.conclusion === "inconclusive") &&
    candidate.state !== "cleared"),
);
define(
  "O1-C28-CONCLUSIVE-READ-CLEARS",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.state === "cleared" &&
    (
      candidate.decision === "postcondition_verified" ||
      objectValue(candidate.resolution)?.decision === "postcondition_verified"
    )),
);
define(
  "O1-C28-LATE-TERMINAL-TRANSITION",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.basis === "late_terminal" &&
    typeof (candidate.evidenceDigest ?? candidate.evidence_digest) === "string" &&
    (candidate.state === "evidence_recorded" || candidate.state === "cleared")),
);
define(
  "O1-C28-INVALID-CLEARANCE-BLOCKED",
  safe((context) =>
    semanticControl(context, "o1-c28.invalid", (result) =>
      result.kind === "rejected" &&
      ["foreign_hold", "scope_mismatch", "journal_binding_mismatch", "evidence_digest_mismatch"]
        .includes(String(result.reason))) &&
    !hasDomainObject(context, ["fixture_snapshot", "fixture_execution_count"], (candidate) =>
      candidate.invalidClearanceDispatched === true)),
);

define(
  "O1-C29-MIXED-NONATOMIC-REDELIVERY",
  semanticEvent(["bridge_snapshot", "wire_event"], (candidate) =>
    candidate.atomic === false &&
    candidate.transaction_state === "not_applicable" &&
    arrayValue(candidate.steps).some((step) => objectValue(step)?.replayed === true) &&
    arrayValue(candidate.steps).some((step) =>
      ["pending", "not_started", "indeterminate"].includes(String(objectValue(step)?.status)))),
);
define(
  "O1-C29-ATOMIC-TERMINAL-REPLAY",
  safe((context) =>
    semanticControl(context, "o1-c29.atomic-replay", (result) =>
      result.atomic === true && result.replayed === true && result.transaction_state === "committed") &&
    snapshotHas(context, "fixture_execution_count", (candidate) =>
      Object.entries(candidate).some(([key, value]) => /atomic-terminal/i.test(key) && value === 1))),
);
define(
  "O1-C29-ATOMIC-INDETERMINATE-RECOVERY",
  semanticEvent(["bridge_snapshot", "gateway_snapshot", "wire_event"], (candidate) =>
    candidate.atomic === true &&
    candidate.status === "indeterminate" &&
    candidate.transaction_state === "indeterminate" &&
    arrayValue(candidate.steps).every((step) => objectValue(step)?.status === "indeterminate")),
);
define(
  "O1-C29-NESTED-OUTCOME-FIELDS",
  semanticEvent(["bridge_snapshot", "wire_event"], (candidate) =>
    typeof candidate.fault_class === "string" &&
    (candidate.outcome === "known" || candidate.outcome === "indeterminate") &&
    typeof candidate.retryable === "boolean"),
);
define(
  "O1-C29-NESTED-VERIFICATION-FIELDS",
  semanticEvent(["bridge_snapshot", "wire_event"], (candidate) =>
    candidate.outcome === "indeterminate" &&
    candidate.verification_required === true &&
    typeof candidate.verification_hold_id === "string" &&
    objectValue(candidate.mutation_scope) !== null),
);
define(
  "O1-C29-AFFECTED-SCOPE-HOLDS",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    typeof (candidate.holdId ?? candidate.hold_id) === "string" &&
    arrayValue(candidate.originIdempotencyKeys ?? candidate.origin_invocation_ids).length > 0 &&
    typeof (candidate.scopeKey ?? objectValue(candidate.mutationScope)?.kind) === "string"),
);

for (const [suffix, assertion] of [
  ["property-order", "PROPERTY-ORDER"],
  ["number-formatting", "NUMBER-FORMATTING"],
  ["unicode", "UNICODE"],
  ["escapes", "ESCAPES"],
] as const) {
  define(
    `O1-C30-${assertion}`,
    exactSchemaAccepted(`o1-c30.${suffix}`, "invoke_batch"),
  );
}
define("O1-C30-STEP-OMISSION", exactSchemaRejected("o1-c30.step-omission", /steps|minItems|non-empty|required|invalid/i));
define("O1-C30-PARAMS-DIGEST-MISMATCH", exactSchemaRejected(
  "o1-c30.params-digest-mismatch",
  /params_digest|digest|invalid/i,
));
define("O1-C30-PER-STEP-DIGEST", exactSchemaRejected(
  "o1-c30.per-step-digest",
  /params_digest|step|digest|invalid/i,
));
define("O1-C30-BATCH-DIGEST", exactSchemaRejected(
  "o1-c30.batch-digest",
  /batch_digest|digest|invalid/i,
));
for (const [suffix, assertion, detail] of [
  ["changed-policy", "CHANGED-POLICY", /binding mismatch|changed policy|policy binding/i],
  ["changed-scope", "CHANGED-SCOPE", /binding mismatch|changed mutation scope|scope binding/i],
  ["changed-clearance", "CHANGED-CLEARANCE", /binding mismatch|changed recovery clearance|clearance binding/i],
] as const) {
  define(
    `O1-C30-${assertion}`,
    safe((context) =>
      rawFault(context, `o1-c30.${suffix}`, "protocol", detail) ||
      hasDomainObject(context, ["gateway_snapshot", "bridge_snapshot"], (candidate) =>
        candidate.reason === "binding_mismatch" &&
        candidate.changedField === suffix.replace("changed-", ""))),
  );
}
define(
  "O1-C30-HARMLESS-RESERIALIZATION",
  exactSchemaAccepted("o1-c30.harmless-reserialization", "invoke_batch"),
);

for (const [suffix, assertion, type] of [
  ["heartbeat_ack_positive", "HEARTBEAT-ACK-POSITIVE", "heartbeat_ack"],
  ["session_register_positive", "REGISTER-POSITIVE", "session_register"],
  ["session_unregister_positive", "UNREGISTER-POSITIVE", "session_unregister"],
  ["session_resume_positive", "RESUME-POSITIVE", "session_resume"],
  ["cancel_positive", "CANCEL-POSITIVE", "cancel"],
  ["manifest_positive", "MANIFEST-POSITIVE", "manifest_check"],
] as const) {
  define(`O1-C31-${assertion}`, exactSchemaAccepted(`o1-c31.${suffix}`, type));
}
define(
  "O1-C31-GOODBYE-POSITIVE",
  safe((context) => rawGoodbyeAccepted(context, "o1-c31.goodbye_positive")),
);
for (const [suffix, assertion] of [
  ["heartbeat_ack_negative", "HEARTBEAT-ACK-NEGATIVE"],
  ["session_register_negative", "REGISTER-NEGATIVE"],
  ["session_unregister_negative", "UNREGISTER-NEGATIVE"],
  ["session_resume_negative", "RESUME-NEGATIVE"],
  ["cancel_negative", "CANCEL-NEGATIVE"],
  ["goodbye_negative", "GOODBYE-NEGATIVE"],
  ["manifest_negative", "MANIFEST-NEGATIVE"],
] as const) {
  define(`O1-C31-${assertion}`, exactSchemaRejected(`o1-c31.${suffix}`));
}

define("O1-C32-BASE64-ALPHABET", exactSchemaRejected("o1-c32.base64_alphabet", /base64|alphabet|invalid/i));
define("O1-C32-BASE64-PADDING", exactSchemaRejected("o1-c32.base64_padding", /base64|padding|invalid/i));
define("O1-C32-STREAM-IDENTITY", exactSchemaRejected("o1-c32.stream_identity", /stream|artifact|identity|invalid/i));
define(
  "O1-C32-STREAM-INDEXING",
  safe((context) =>
    rawFault(context, "o1-c32.stream_indexing", "protocol", /chunk index|gap|zero|contiguous/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "chunk_gap" &&
      candidate.expectedChunkIndex === 0 &&
      candidate.receivedChunkIndex === 1)),
);
define("O1-C32-DECODED-LIMIT", exactSchemaRejected("o1-c32.decoded_limit", /decoded|chunk|1 MiB|1048576|oversize/i));
define(
  "O1-C32-RECONSTRUCTION-SIZE",
  safe((context) =>
    rawFault(context, "o1-c32.reconstruction_size", "protocol", /size|total_size|reconstruct/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "descriptor_size" && candidate.complete === false)),
);
define(
  "O1-C32-CONTENT-DIGEST",
  safe((context) =>
    rawFault(context, "o1-c32.content_digest", "protocol", /digest|sha256|content/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "descriptor_digest" && candidate.complete === false)),
);

export const RAW_PRODUCTION_EXTERNAL_DEPENDENCIES: ReadonlyMap<string, string> = new Map([
  ["O1-C33-LOOPBACK-ACCEPTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-WILDCARD-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-LAN-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-HOSTNAME-REMOTE-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-OVERRIDE-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C40-RAW-PATH-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-LOCAL-PATH-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-TRAVERSAL-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-REPARSE-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ARTIFACT-ID-MAPPING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ARTIFACT-INDEX-MAPPING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-INDEPENDENT-STREAMS", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-DESCRIPTOR-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-DIGEST-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-SIZE-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-RETRANSMISSION-IDENTITY", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ALL-OR-NOTHING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-NO-NORTH-CLAIM", "supervisor.product-artifact-evidence/v1"],
]);

function exactSupervisorEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  schemaVersion: string,
  stepId: string,
): ObjectValue | null {
  const matches = observations(context).filter(({ payload }) => {
    const candidate = objectValue(payload);
    return candidate?.schemaVersion === schemaVersion && candidate.stepId === stepId;
  });
  return matches.length === 1 ? objectValue(matches[0]!.payload) : null;
}

function exactArray(value: unknown, length: number): readonly unknown[] | null {
  return Array.isArray(value) && value.length === length ? value : null;
}

function targetIs(value: unknown, host: string, port?: number): boolean {
  const target = objectValue(value);
  return target !== null &&
    target.host === host &&
    (port === undefined || target.port === port);
}

function rejectedBeforeProbe(
  attempt: ObjectValue | null,
  host: string,
): boolean {
  if (
    attempt === null ||
    attempt.sessionCount !== 0 ||
    exactArray(attempt.acceptedTargets, 0) === null ||
    attempt.tempRegistryReads !== 0 ||
    attempt.filesystemLocksCreated !== 0
  ) {
    return false;
  }
  const probed = exactArray(attempt.probedTargets, 1);
  const rejected = exactArray(attempt.rejectedTargets, 1);
  const rejection = rejected === null ? null : objectValue(rejected[0]);
  return probed !== null &&
    targetIs(probed[0], host) &&
    rejection !== null &&
    targetIs(rejection.target, host) &&
    typeof rejection.reason === "string" &&
    /numeric IP loopback required before probe/u.test(rejection.reason);
}

function fixtureBindRejected(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  host: string,
  allowUnsafeBind: boolean,
  failureClass: string,
): boolean {
  const evidence = exactSupervisorEvidence(
    context,
    "supervisor.loopback-probe/v1",
    stepId,
  );
  return evidence !== null &&
    evidence.probeKind === "fixture_bind_process" &&
    evidence.processSpawned === true &&
    evidence.requestedHost === host &&
    evidence.allowUnsafeBind === allowUnsafeBind &&
    evidence.exitCode === 1 &&
    evidence.timedOut === false &&
    evidence.outputExceeded === false &&
    evidence.readyObserved === false &&
    evidence.survivingProcess === false &&
    evidence.failureClass === failureClass &&
    numberValue(evidence.stderrBytes) !== null &&
    Number(evidence.stderrBytes) > 0 &&
    typeof evidence.stdoutSha256 === "string" &&
    SHA256_PATTERN.test(evidence.stdoutSha256) &&
    typeof evidence.stderrSha256 === "string" &&
    SHA256_PATTERN.test(evidence.stderrSha256) &&
    typeof evidence.executableSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(evidence.executableSha256);
}

define(
  "O1-C33-LOOPBACK-ACCEPTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.loopback",
    );
    const attempt = objectValue(evidence?.attempt);
    const probed = exactArray(attempt?.probedTargets, 1);
    const accepted = exactArray(attempt?.acceptedTargets, 1);
    return evidence !== null &&
      evidence.probeKind === "product_discovery" &&
      evidence.targetClass === "numeric_loopback" &&
      targetIs(evidence.requestedTarget, "127.0.0.1") &&
      attempt !== null &&
      attempt.sessionCount === 1 &&
      attempt.tempRegistryReads === 0 &&
      attempt.filesystemLocksCreated === 0 &&
      probed !== null &&
      accepted !== null &&
      exactArray(attempt.rejectedTargets, 0) !== null &&
      targetIs(probed[0], "127.0.0.1") &&
      targetIs(accepted[0], "127.0.0.1");
  }),
);
define(
  "O1-C33-WILDCARD-REJECTED",
  safe((context) =>
    fixtureBindRejected(
      context,
      "o1-c33.wildcard",
      "0.0.0.0",
      false,
      "numeric_loopback_required",
    )),
);
define(
  "O1-C33-LAN-REJECTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.lan",
    );
    return evidence !== null &&
      evidence.probeKind === "product_discovery" &&
      evidence.targetClass === "non_loopback_lan" &&
      targetIs(evidence.requestedTarget, "192.0.2.10", 48_298) &&
      rejectedBeforeProbe(objectValue(evidence.attempt), "192.0.2.10");
  }),
);
define(
  "O1-C33-HOSTNAME-REMOTE-REJECTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.hostname",
    );
    const controlled = objectValue(evidence?.controlledResolution);
    const addresses = exactArray(controlled?.addresses, 1);
    return evidence !== null &&
      evidence.probeKind === "hostname_resolved_remote" &&
      evidence.targetClass === "hostname" &&
      evidence.requestedHostname === "raw-nonloopback.invalid" &&
      controlled?.source === "parent_static_test_net" &&
      addresses?.[0] === "192.0.2.10" &&
      rejectedBeforeProbe(
        objectValue(evidence.hostnameAttempt),
        "raw-nonloopback.invalid",
      ) &&
      rejectedBeforeProbe(
        objectValue(evidence.resolvedAddressAttempt),
        "192.0.2.10",
      );
  }),
);
define(
  "O1-C33-OVERRIDE-REJECTED",
  safe((context) =>
    fixtureBindRejected(
      context,
      "o1-c33.override",
      "127.0.0.1",
      true,
      "unsafe_override_forbidden",
    )),
);

function productEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario: string,
): ObjectValue | null {
  const evidence = exactSupervisorEvidence(
    context,
    "supervisor.product-artifact-evidence/v1",
    `o1-c40.${scenario}`,
  );
  return evidence?.scenario === scenario ? evidence : null;
}

function zeroFilesystemDelta(evidence: ObjectValue): boolean {
  const delta = objectValue(evidence.filesystemDelta);
  return delta?.fileCount === 0 && delta.totalBytes === 0;
}

function rejectedArtifactSurface(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario: "raw_path" | "traversal_path" | "reparse_path",
  surfaceKind: string,
  reparsePointObserved: boolean,
): boolean {
  const evidence = productEvidence(context, scenario);
  const surface = objectValue(evidence?.surface);
  const outcome = objectValue(evidence?.bridgeOutcome);
  const spool = objectValue(evidence?.bridgeSpool);
  return evidence !== null &&
    surface?.kind === surfaceKind &&
    surface.created === true &&
    surface.resolvedInsideSpool === false &&
    surface.reparsePointObserved === reparsePointObserved &&
    typeof surface.sourcePathSha256 === "string" &&
    SHA256_PATTERN.test(surface.sourcePathSha256) &&
    outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
    outcome.outcomeKind === "error" &&
    outcome.faultClass === "parameter" &&
    outcome.addinContacted === true &&
    outcome.replayed === false &&
    spool?.rootPathRedacted === true &&
    spool.rawPathExposed === false &&
    spool.carrierCountForInvocation === 0 &&
    exactArray(spool.carriers, 0) !== null &&
    zeroFilesystemDelta(evidence);
}

function carrierEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario = "valid_multifile",
): {
  evidence: ObjectValue;
  outcome: ObjectValue;
  carrier: ObjectValue;
  references: readonly unknown[];
  descriptors: readonly unknown[];
  partials: readonly unknown[];
  spoolCarrier: ObjectValue;
  filesystemFiles: readonly unknown[];
} | null {
  const evidence = productEvidence(context, scenario);
  const outcome = objectValue(evidence?.bridgeOutcome);
  const carrier = objectValue(outcome?.carrier);
  const references = exactArray(carrier?.references, 2);
  const descriptors = exactArray(carrier?.descriptors, 2);
  const partials = exactArray(carrier?.partials, 4);
  const spool = objectValue(evidence?.bridgeSpool);
  const spoolCarriers = exactArray(spool?.carriers, 1);
  const spoolCarrier = spoolCarriers === null ? null : objectValue(spoolCarriers[0]);
  const filesystem = objectValue(evidence?.filesystemAfter);
  const filesystemFiles = arrayValue(filesystem?.files);
  if (
    evidence === null ||
    outcome === null ||
    carrier === null ||
    references === null ||
    descriptors === null ||
    partials === null ||
    spoolCarrier === null ||
    spool?.rootPathRedacted !== true ||
    spool.rawPathExposed !== false ||
    spool.carrierCountForInvocation !== 1 ||
    filesystem?.schemaVersion !== "supervisor.product-artifact-filesystem/v1" ||
    filesystem.rootPathRedacted !== true
  ) {
    return null;
  }
  return {
    evidence,
    outcome,
    carrier,
    references,
    descriptors,
    partials,
    spoolCarrier,
    filesystemFiles,
  };
}

function descriptorRows(facts: NonNullable<ReturnType<typeof carrierEvidence>>): ObjectValue[] | null {
  const rows = facts.descriptors.map(objectValue);
  return rows.every((entry): entry is ObjectValue => entry !== null) ? rows : null;
}

function partialRows(facts: NonNullable<ReturnType<typeof carrierEvidence>>): ObjectValue[] | null {
  const rows = facts.partials.map(objectValue);
  return rows.every((entry): entry is ObjectValue => entry !== null) ? rows : null;
}

define(
  "O1-C40-RAW-PATH-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "raw_path",
      "outside_regular_file",
      false,
    )),
);
define(
  "O1-C40-LOCAL-PATH-REJECTED",
  safe((context) => {
    const evidence = productEvidence(context, "local_path");
    const surface = objectValue(evidence?.surface);
    const outcome = objectValue(evidence?.bridgeOutcome);
    const result = objectValue(outcome?.sanitizedResult);
    const files = exactArray(result?.files, 1);
    const reference = files === null ? null : objectValue(files[0]);
    const spool = objectValue(evidence?.bridgeSpool);
    return evidence !== null &&
      surface?.kind === "managed_regular_file" &&
      surface.created === true &&
      surface.lexicalInsideSpool === true &&
      surface.resolvedInsideSpool === true &&
      surface.reparsePointObserved === false &&
      outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
      outcome.outcomeKind === "result" &&
      outcome.status === "completed" &&
      result?.rawPathFieldCount === 0 &&
      result.localPathStringCount === 0 &&
      reference !== null &&
      typeof reference.artifactId === "string" &&
      reference.artifactIndex === 0 &&
      spool?.rootPathRedacted === true &&
      spool.rawPathExposed === false &&
      spool.carrierCountForInvocation === 1;
  }),
);
define(
  "O1-C40-TRAVERSAL-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "traversal_path",
      "traversal_regular_file",
      false,
    )),
);
define(
  "O1-C40-REPARSE-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "reparse_path",
      "managed_reparse_file",
      true,
    )),
);
define(
  "O1-C40-ARTIFACT-ID-MAPPING",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    if (facts === null || descriptors === null) return false;
    const references = facts.references.map(objectValue);
    const ids = descriptors.map(({ artifactId }) => artifactId);
    return references.every((entry): entry is ObjectValue => entry !== null) &&
      ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/u.test(id)) &&
      new Set(ids).size === 2 &&
      references.every((reference, index) =>
        reference.artifactId === ids[index] &&
        reference.artifactIndex === index);
  }),
);
define(
  "O1-C40-ARTIFACT-INDEX-MAPPING",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    return descriptors !== null &&
      descriptors.every((descriptor, index) => descriptor.artifactIndex === index);
  }),
);
define(
  "O1-C40-INDEPENDENT-STREAMS",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const partials = facts === null ? null : partialRows(facts);
    if (descriptors === null || partials === null) return false;
    const streamIds = descriptors.map(({ streamId }) => streamId);
    if (new Set(streamIds).size !== 2) return false;
    return descriptors.every((descriptor) => {
      const stream = partials.filter(({ streamId }) => streamId === descriptor.streamId);
      return stream.length === 2 &&
        stream.map(({ chunkIndex }) => chunkIndex).join(",") === "0,1" &&
        stream.every((partial) =>
          partial.artifactId === descriptor.artifactId &&
          partial.artifactIndex === descriptor.artifactIndex &&
          partial.invocationId === facts!.carrier.invocationId);
    });
  }),
);
define(
  "O1-C40-DESCRIPTOR-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const streams = facts === null ? null : exactArray(facts.spoolCarrier.streams, 2);
    if (descriptors === null || streams === null) return false;
    return descriptors.every((descriptor, index) => {
      const stream = objectValue(streams[index]);
      return stream !== null &&
        stream.artifactId === descriptor.artifactId &&
        stream.artifactIndex === descriptor.artifactIndex &&
        stream.streamId === descriptor.streamId &&
        stream.filename === descriptor.filename &&
        stream.contentType === descriptor.contentType &&
        stream.totalChunks === descriptor.totalChunks &&
        stream.totalSize === descriptor.totalSize &&
        stream.sha256 === descriptor.sha256;
    });
  }),
);
define(
  "O1-C40-DIGEST-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    if (descriptors === null) return false;
    return descriptors.every((descriptor) =>
      typeof descriptor.sha256 === "string" &&
      SHA256_PATTERN.test(descriptor.sha256) &&
      facts!.filesystemFiles.filter((file) => {
        const row = objectValue(file);
        return row !== null &&
          row.sha256 === descriptor.sha256 &&
          row.bytes === descriptor.totalSize &&
          row.regularFile === true &&
          row.reparsePoint === false;
      }).length === 1);
  }),
);
define(
  "O1-C40-SIZE-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const partials = facts === null ? null : partialRows(facts);
    if (facts === null || descriptors === null || partials === null) return false;
    const combined = descriptors.reduce((sum, descriptor) =>
      sum + Number(descriptor.totalSize), 0);
    return combined === 2_097_154 &&
      descriptors.every((descriptor) =>
        Number(descriptor.totalSize) === partials
          .filter(({ streamId }) => streamId === descriptor.streamId)
          .reduce((sum, partial) => sum + Number(partial.decodedBytes), 0)) &&
      objectValue(facts.evidence.filesystemDelta)?.totalBytes === combined;
  }),
);
define(
  "O1-C40-RETRANSMISSION-IDENTITY",
  safe((context) => {
    const first = carrierEvidence(context);
    const replay = carrierEvidence(context, "retransmission");
    if (first === null || replay === null) return false;
    const replayDelta = objectValue(replay.evidence.filesystemDelta);
    return first.outcome.replayed === false &&
      first.outcome.addinContacted === true &&
      replay.outcome.replayed === true &&
      replay.outcome.addinContacted === false &&
      first.carrier.invocationId === replay.carrier.invocationId &&
      JSON.stringify(first.carrier) === JSON.stringify(replay.carrier) &&
      JSON.stringify(first.spoolCarrier) === JSON.stringify(replay.spoolCarrier) &&
      replayDelta?.fileCount === 0 &&
      replayDelta.totalBytes === 0;
  }),
);
define(
  "O1-C40-ALL-OR-NOTHING",
  safe((context) => {
    const evidence = productEvidence(context, "invalid_member");
    const outcome = objectValue(evidence?.bridgeOutcome);
    const spool = objectValue(evidence?.bridgeSpool);
    return evidence !== null &&
      outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
      outcome.outcomeKind === "error" &&
      outcome.faultClass === "parameter" &&
      !Object.prototype.hasOwnProperty.call(outcome, "carrier") &&
      spool?.carrierCountForInvocation === 0 &&
      exactArray(spool.carriers, 0) !== null &&
      zeroFilesystemDelta(evidence);
  }),
);
define(
  "O1-C40-NO-NORTH-CLAIM",
  safe((context) =>
    [
      "raw_path",
      "local_path",
      "traversal_path",
      "reparse_path",
      "valid_multifile",
      "retransmission",
      "invalid_member",
    ].every((scenario) => {
      const evidence = productEvidence(context, scenario);
      return evidence !== null &&
        evidence.evidenceScope === "rbp_only" &&
        evidence.northClientObservationCount === 0 &&
        exactArray(evidence.northClientSurfaces, 0) !== null;
    })),
);

define(
  "O1-C34-DOCUMENT-SCHEMA",
  safe((context) =>
    rawHasResponseType(context, "o1-c34.document-schema", "session_registered") &&
    snapshotHas(context, "gateway_snapshot", (candidate) => {
      if (
        typeof candidate.document_id !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.is_workshared !== "boolean" ||
        typeof candidate.is_active !== "boolean"
      ) {
        return false;
      }
      return candidate.path_digest === null ||
        (typeof candidate.path_digest === "string" && SHA256_PATTERN.test(candidate.path_digest));
    })),
);
define(
  "O1-C34-SEAT-SPOOF-REJECTED",
  safe((context) =>
    rawFault(context, "o1-c34.seat-spoof", "auth", /seat|identity|claim|principal/i) &&
    hasDomainObject(context, ["gateway_snapshot", "wire_event"], (candidate) =>
      candidate.auditEvent === "identity_claim_rejected" && candidate.claim === "seat")),
);
define(
  "O1-C34-USER-SPOOF-REJECTED",
  safe((context) =>
    rawFault(context, "o1-c34.user-spoof", "auth", /user|identity|claim|principal/i) &&
    hasDomainObject(context, ["gateway_snapshot", "wire_event"], (candidate) =>
      candidate.auditEvent === "identity_claim_rejected" && candidate.claim === "user")),
);

define(
  "O1-C35-MAX-SAFE-SEQ",
  safe((context) =>
    rawPostSchema(context, "o1-c35.max_safe_seq", "doc_context_update") ||
    snapshotHas(context, "gateway_snapshot", (candidate) =>
      candidate.lastRxSeq === 9_007_199_254_740_991)),
);
define("O1-C35-UNSAFE-SEQ", exactSchemaRejected("o1-c35.unsafe_two_pow_53", /safe integer|sequence|maximum|invalid/i));
define(
  "O1-C35-NO-WRAP-RENEWAL",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    (candidate.reason === "sequence_exhaustion" || candidate.renewalReason === "sequence_exhaustion") &&
    (candidate.renewed === true || candidate.phase === "renewing") &&
    candidate.wrapped !== true),
);
define(
  "O1-C35-DUPLICATE",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    candidate.kind === "duplicate" &&
    (candidate.executed === false || candidate.dispatchCount === 0)),
);
define(
  "O1-C35-GAP",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    (candidate.kind === "gap" || candidate.reason === "forward_sequence_gap") &&
    numberValue(candidate.expectedSeq) !== null &&
    numberValue(candidate.receivedSeq) !== null &&
    candidate.accepted !== true),
);

define(
  "O1-C36-WSS-LIFECYCLE",
  safe((context) =>
    transportOpened(context, "wss") &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      Array.isArray(candidate.sessions) &&
      candidate.sessions.length > 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.runLoopActive === true)),
);
define(
  "O1-C36-HTTP-SSE-LIFECYCLE",
  safe((context) =>
    transportOpened(context, "streamable_http_sse") &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      Array.isArray(candidate.sessions) &&
      candidate.sessions.length > 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.runLoopActive === true) &&
    hasDomainObject(context, ["wire_event", "bridge_snapshot"], (candidate) =>
      (
        candidate.createStatus === 201 &&
        candidate.eventsStatus === 200 &&
        candidate.messagesStatus === 202
      ) ||
      (
        candidate.kind === "streamable_http_sse" &&
        candidate.open === true &&
        typeof candidate.connectionId === "string"
      ))),
);
define(
  "O1-C36-JOURNAL-PARITY",
  safe((context) => {
    const bridgeCanonical = snapshots(context, "bridge_snapshot").some((snapshot) =>
      Array.isArray(snapshot.invocations) &&
      snapshot.invocations.length === 0 &&
      Array.isArray(snapshot.holds) &&
      snapshot.holds.length === 0);
    const gatewayCanonical = snapshots(context, "gateway_snapshot").some((snapshot) => {
      const sessions = objectValue(snapshot.sessions);
      const holds = arrayValue(objectValue(snapshot.mutationHolds)?.holds);
      if (sessions === null || Object.keys(sessions).length === 0 || holds.length !== 0) return false;
      return Object.values(sessions).every((value) => {
        const session = objectValue(value);
        return session !== null &&
          session.inFlight === null &&
          Object.keys(objectValue(session.terminalOutcomes) ?? {}).length === 0 &&
          Object.keys(objectValue(session.omittedPayloadRecoveries) ?? {}).length === 0 &&
          Object.keys(objectValue(session.expiredOrigins) ?? {}).length === 0;
      });
    });
    return bridgeCanonical && gatewayCanonical;
  }),
);
define(
  "O1-C36-RESUME-PARITY",
  safe((context) => {
    const bridgeCanonical = snapshots(context, "bridge_snapshot").some((snapshot) => {
      const sessions = arrayValue(snapshot.sessions);
      const peerSessions = arrayValue(objectValue(snapshot.peer)?.sessions);
      return sessions.length > 0 &&
        peerSessions.length === sessions.length &&
        sessions.every((value) => typeof objectValue(value)?.rsid === "string") &&
        peerSessions.every((value) => {
          const session = objectValue(value);
          return session?.phase === "registered" &&
            session.resumeAllowed === true &&
            session.dispatchAllowed === true;
        });
    });
    const gatewayCanonical = snapshots(context, "gateway_snapshot").some((snapshot) => {
      const sessions = objectValue(snapshot.sessions);
      return sessions !== null &&
        Object.keys(sessions).length > 0 &&
        Object.values(sessions).every((value) => {
          const session = objectValue(value);
          return session?.revoked === false &&
            session.resumeTokenRedacted === true &&
            objectValue(session.lifecycle)?.phase === "registered";
        });
    });
    return bridgeCanonical && gatewayCanonical;
  }),
);
define(
  "O1-C36-OPENING-ERRORS",
  semanticEvent(["wire_event", "bridge_snapshot"], (candidate) =>
    candidate.status === 503 &&
    String(candidate.retryAfter ?? candidate.retry_after) === "1" &&
    candidate.retryable === true),
);
define(
  "O1-C36-PROXY-BUFFERING",
  safe((context) =>
    snapshotHas(context, "gateway_snapshot", (candidate) =>
      Array.isArray(candidate.bufferedSseConnections) &&
      candidate.bufferedSseConnections.length === 0 &&
      candidate.heldOutboundFrames === 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.kind === "streamable_http_sse" && candidate.open === true)),
);

for (const reason of ["REVIT-EXITED", "BRIDGE-SHUTDOWN", "SESSION-REPLACED", "OPERATOR-REQUESTED"] as const) {
  const token = reason.toLowerCase().replaceAll("-", "_");
  define(
    `O1-C37-${reason}-RESUME`,
    semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
      (candidate.reason === token || candidate.revocationReason === token) &&
      (candidate.revoked === true || candidate.resumeAuthorized === false)),
  );
  define(
    `O1-C37-${reason}-DISPATCH`,
    semanticEvent(["gateway_snapshot", "control_result", "wire_event"], (candidate) =>
      (candidate.reason === token || candidate.revocationReason === token) &&
      (candidate.dispatchAuthorized === false ||
        /revoked|not registered|unknown session/i.test(String(candidate.message ?? candidate.error ?? "")))),
  );
  define(
    `O1-C37-${reason}-INDETERMINATE`,
    semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
      (candidate.reason === token || candidate.unregisterReason === token) &&
      candidate.state === "indeterminate" &&
      candidate.dispatchMayHaveStarted === true),
  );
}

define(
  "O1-C38-VALID-GUARDED-REASON",
  semanticEvent(["bridge_snapshot", "wire_event"], (candidate) =>
    candidate.status === "guarded" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(String(candidate.guarded_reason ?? candidate.guardedReason ?? ""))),
);
define(
  "O1-C38-MISSING-GUARDED-REASON",
  exactSchemaRejected("o1-c38.missing-reason", /guarded_reason|required|guarded|invalid/i),
);
define(
  "O1-C38-FIRST-DELIVERY-STOPS",
  safe((context) =>
    semanticControl(context, "o1-c38.first-delivery", (result) =>
      result.atomic === false &&
      result.status === "guarded" &&
      result.failed_step_index === 0) &&
    fixtureCount(context, /O1-C38:guarded:0|guarded:0/i, 1)),
);
define(
  "O1-C38-SUCCESSORS-NOT-STARTED",
  safe((context) =>
    hasDomainObject(context, ["bridge_snapshot", "wire_event"], (candidate) =>
      candidate.status === "not_started" &&
      numberValue(candidate.index) !== null &&
      (candidate.index as number) > 0) &&
    !snapshotHas(context, "fixture_execution_count", (candidate) =>
      Object.entries(candidate).some(([key, value]) =>
        /O1-C38:guarded:[12]|guarded:[12]/i.test(key) && typeof value === "number" && value > 0))),
);

define(
  "O1-C39-REPLAY-ONLY",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    candidate.payload_omitted === true &&
    candidate.replayed === true &&
    typeof candidate.result_digest === "string"),
);
define("O1-C39-NONREPLAY-REJECTED", exactSchemaRejected("o1-c39.nonreplay", /payload_omitted|replayed|replay|invalid/i));
define("O1-C39-DIGEST-REQUIRED", exactSchemaRejected("o1-c39.missing_digest", /payload_omitted|result_digest|required|invalid/i));
define("O1-C39-RESULT-ABSENT", exactSchemaRejected("o1-c39.inline_result", /payload_omitted|result|forbid|invalid/i));
define(
  "O1-C39-AUDITED-READ-RECOVERY",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.state === "recovered" &&
    typeof candidate.auditId === "string" &&
    typeof candidate.recoveryInvocationId === "string" &&
    typeof candidate.recoveryResultDigest === "string" &&
    candidate.mutating === false),
);

const expectedRawAssertionIds = RAW_PRODUCTION_CASES.flatMap((caseId) =>
  canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
const expectedRawAssertionSet = new Set(expectedRawAssertionIds);
const observedRawAssertionIds = entries.map(([assertionId]) => assertionId);
const unknownRawAssertionIds = observedRawAssertionIds.filter((assertionId) =>
  !expectedRawAssertionSet.has(assertionId));
const missingRawAssertionIds = expectedRawAssertionIds.filter((assertionId) =>
  !observedRawAssertionIds.includes(assertionId));
if (
  unknownRawAssertionIds.length > 0 ||
  missingRawAssertionIds.length > 0 ||
  new Set(observedRawAssertionIds).size !== observedRawAssertionIds.length
) {
  throw new Error([
    "raw production oracle registry does not exactly cover C25-C40",
    `missing: ${missingRawAssertionIds.join(", ") || "none"}`,
    `unknown: ${unknownRawAssertionIds.join(", ") || "none"}`,
  ].join("; "));
}

export const RAW_PRODUCTION_ORACLES: CanonicalAssertionOracleRegistry = new Map(entries);
