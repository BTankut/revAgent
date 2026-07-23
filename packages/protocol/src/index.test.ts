import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  makeBatchDigest,
  makeIdempotencyKey,
  makeMutationHoldId,
  makeParamsDigest,
  parseRbpFrame,
  rbpEnvelopeErrors,
  RBP_MAX_CONTROL_FRAME_BYTES,
  RBP_MAX_DOC_CONTEXT_FRAME_BYTES,
  RBP_MAX_INLINE_RESULT_BYTES,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  RBP_PROTOCOL_VERSION,
  RbpFrameError,
  reconnectBackoffLimitMs,
  reconnectFullJitterDelayMs,
  shouldResetReconnectBackoff,
  type JsonValue,
  type BatchDigestInput,
  validateRbpEnvelope,
} from "./index.js";

interface EnvelopeVector {
  name: string;
  scope: "pre_negotiation" | "control" | "data";
  type: string;
  payload: Record<string, unknown>;
}

interface NegativeEnvelopeVector {
  name: string;
  base: string;
  patch?: Record<string, unknown>;
  payload_patch?: Record<string, unknown>;
  remove?: string[];
  payload_remove?: string[];
}

interface EnvelopeFixture {
  positive: EnvelopeVector[];
  negative: NegativeEnvelopeVector[];
}

interface DigestFixture {
  vectors: Array<{
    name: string;
    params: JsonValue;
    canonical: string;
    digest: string;
  }>;
}

interface BatchDigestFixture {
  vectors: Array<{
    name: string;
    input: BatchDigestInput;
    digest: string;
  }>;
}

interface BackoffFixture {
  limits: Array<{ attempt_index: number; limit_ms: number }>;
  jitter: Array<{ attempt_index: number; sample: number; delay_ms: number }>;
  reset: Array<{ steady_ms: number; reset: boolean }>;
}

interface FrameLimitFixture {
  invocation_params: ByteLimitVector;
  inline_result: ByteLimitVector;
  control_frame: ByteLimitVector;
  doc_context_update_frame: ByteLimitVector;
}

interface ByteLimitVector {
  limit_bytes: number;
  accepted_bytes: number;
  rejected_bytes: number;
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../conformance/fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function messageId(index: number): string {
  return `0197a3c2-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
}

function materialize(vector: EnvelopeVector, index: number): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    type: vector.type,
    id: messageId(index),
    ts: "2026-07-22T12:00:00.000Z",
    payload: clone(vector.payload),
  };

  if (vector.scope !== "pre_negotiation") {
    envelope.v = RBP_PROTOCOL_VERSION;
  }

  if (vector.scope === "data") {
    envelope.rsid = "rs_7f3a";
    envelope.seq = index + 1;
    envelope.ack = 0;
  }

  return envelope;
}

function materializeNegative(
  vector: NegativeEnvelopeVector,
  bases: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const base = bases.get(vector.base);
  if (base === undefined) {
    throw new Error(`missing fixture base ${vector.base}`);
  }

  const envelope = clone(base);
  Object.assign(envelope, vector.patch ?? {});
  const payload = envelope.payload as Record<string, unknown>;
  Object.assign(payload, vector.payload_patch ?? {});

  for (const field of vector.remove ?? []) {
    delete envelope[field];
  }
  for (const field of vector.payload_remove ?? []) {
    delete payload[field];
  }

  return envelope;
}

const envelopeFixture = readFixture<EnvelopeFixture>("envelopes.json");
const positiveEnvelopes = envelopeFixture.positive.map(materialize);
const positiveByName = new Map(
  envelopeFixture.positive.map((vector, index) => [vector.name, positiveEnvelopes[index] as Record<string, unknown>]),
);
const wireEncoder = new TextEncoder();
const sizedValueMarker = "__RBP_CONFORMANCE_SIZED_VALUE__";

function withSizedJsonString(
  envelope: Record<string, unknown>,
  serializedValueBytes: number,
): Uint8Array {
  if (serializedValueBytes < 2) {
    throw new Error("a JSON string needs at least two bytes");
  }
  const text = JSON.stringify(envelope);
  const encodedMarker = JSON.stringify(sizedValueMarker);
  const markerIndex = text.indexOf(encodedMarker);
  if (markerIndex === -1) {
    throw new Error("sized value marker not found");
  }
  const replacement = `"${"x".repeat(serializedValueBytes - 2)}"`;
  return wireEncoder.encode(
    `${text.slice(0, markerIndex)}${replacement}${text.slice(markerIndex + encodedMarker.length)}`,
  );
}

function withExactFrameSize(
  envelope: Record<string, unknown>,
  frameBytes: number,
): Uint8Array {
  envelope.conformance_padding = "";
  const empty = wireEncoder.encode(JSON.stringify(envelope));
  if (empty.byteLength > frameBytes) {
    throw new Error("base envelope exceeds requested frame size");
  }
  envelope.conformance_padding = "x".repeat(frameBytes - empty.byteLength);
  const frame = wireEncoder.encode(JSON.stringify(envelope));
  if (frame.byteLength !== frameBytes) {
    throw new Error(`expected ${frameBytes} bytes, got ${frame.byteLength}`);
  }
  return frame;
}

function expectFrameError(
  frame: Uint8Array,
  code: RbpFrameError["code"],
  path?: string,
): void {
  try {
    parseRbpFrame(frame);
    throw new Error("frame unexpectedly passed");
  } catch (error) {
    expect(error).toBeInstanceOf(RbpFrameError);
    expect(error).toMatchObject({ code, ...(path === undefined ? {} : { path }) });
  }
}

describe("RBP/1 envelope and payload schemas", () => {
  it("has a positive payload vector for every message type", () => {
    const expectedTypes = [
      "cancel",
      "doc_context_update",
      "error",
      "goodbye",
      "heartbeat",
      "heartbeat_ack",
      "hello",
      "hello_ack",
      "invoke",
      "invoke_batch",
      "manifest_check",
      "manifest_info",
      "partial",
      "result",
      "resume_ack",
      "session_register",
      "session_registered",
      "session_resume",
      "session_unregister",
    ];
    const actualTypes = [...new Set(envelopeFixture.positive.map((vector) => vector.type))].sort();
    expect(actualTypes).toEqual(expectedTypes);
  });

  it.each(envelopeFixture.positive)("accepts $name", (vector) => {
    const envelope = positiveByName.get(vector.name);
    expect(envelope).toBeDefined();
    expect(validateRbpEnvelope(envelope)).toBe(true);
    expect(rbpEnvelopeErrors()).toEqual([]);
  });

  it.each(envelopeFixture.negative)("rejects $name", (vector) => {
    const envelope = materializeNegative(vector, positiveByName);
    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors().length).toBeGreaterThan(0);
  });

  it("accepts maximum-safe seq and rejects 2^53", () => {
    const invoke = clone(positiveByName.get("invoke"));
    expect(invoke).toBeDefined();
    if (invoke === undefined) {
      return;
    }

    invoke.seq = 9_007_199_254_740_991;
    expect(validateRbpEnvelope(invoke)).toBe(true);

    invoke.seq = 9_007_199_254_740_992;
    expect(validateRbpEnvelope(invoke)).toBe(false);
  });

  it("allows additive fields while preserving control-field prohibitions", () => {
    const hello = clone(positiveByName.get("hello"));
    expect(hello).toBeDefined();
    if (hello === undefined) {
      return;
    }

    hello.future_optional_field = { supported: true };
    (hello.payload as Record<string, unknown>).future_optional_field = "ignored-by-v1";
    expect(validateRbpEnvelope(hello)).toBe(true);

    hello.ack = 0;
    expect(validateRbpEnvelope(hello)).toBe(false);
  });

  it("requires recovery clearances to have unique sorted hold ids", () => {
    const invoke = clone(positiveByName.get("mutating_clearance_invoke"));
    expect(invoke).toBeDefined();
    if (invoke === undefined) {
      return;
    }
    const payload = invoke.payload as Record<string, unknown>;
    const clearance = clone(
      (payload.recovery_clearances as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >,
    );
    const duplicateHold = {
      ...clone(clearance),
      resolution_id: "0197a3c2-0000-7000-8000-000000000104",
      audit_id: "0197a3c2-0000-7000-8000-000000000105",
    };
    payload.recovery_clearances = [clearance, duplicateHold];
    expect(validateRbpEnvelope(invoke)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "rbpSemantic",
          instancePath: "/payload/recovery_clearances/1/hold_id",
        }),
      ]),
    );

    const first = { ...clone(clearance), hold_id: `vh:${"f".repeat(64)}` };
    const second = { ...clone(clearance), hold_id: `vh:${"a".repeat(64)}` };
    payload.recovery_clearances = [first, second];
    expect(validateRbpEnvelope(invoke)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "rbpSemantic",
          instancePath: "/payload/recovery_clearances",
        }),
      ]),
    );
  });
});

describe("RBP/1 batch result semantics", () => {
  function batchPayload(): Record<string, unknown> {
    const envelope = clone(positiveByName.get("batch_result"));
    if (envelope === undefined) {
      throw new Error("missing batch_result fixture");
    }
    return envelope;
  }

  function atomicIndeterminatePayload(): Record<string, unknown> {
    const envelope = clone(positiveByName.get("batch_indeterminate_result"));
    if (envelope === undefined) {
      throw new Error("missing batch_indeterminate_result fixture");
    }
    return envelope;
  }

  it("accepts every possibly executed atomic step as indeterminate", () => {
    const envelope = atomicIndeterminatePayload();
    expect(validateRbpEnvelope(envelope)).toBe(true);

    const payload = envelope.payload as Record<string, unknown>;
    const steps = payload.steps as Array<Record<string, unknown>>;
    const expectedHoldId = makeMutationHoldId(
      "rs_7f3a",
      { kind: "document", document_id: "doc-01" },
      steps.map((step) => `rs_7f3a/${String(step.invocation_id)}`),
    );
    expect(expectedHoldId).toBe(
      "vh:4cf5818836b3d0e890ebc20548b0f863479f3ce996370947ad6c8067f437bad7",
    );
    expect(steps.map((step) => (step.error as Record<string, unknown>).verification_hold_id)).toEqual([
      expectedHoldId,
      expectedHoldId,
      expectedHoldId,
    ]);
  });

  it("keeps the stop-after-first-non-success rule for atomic:false", () => {
    const envelope = atomicIndeterminatePayload();
    const payload = envelope.payload as Record<string, unknown>;
    payload.atomic = false;
    payload.transaction_state = "not_applicable";

    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/steps/1/status" }),
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/steps/2/status" }),
      ]),
    );
  });

  it("keeps the stop-after-first-failure rule for a clean atomic rollback", () => {
    const envelope = clone(positiveByName.get("batch_failed_result"));
    if (envelope === undefined) {
      throw new Error("missing batch_failed_result fixture");
    }
    const payload = envelope.payload as Record<string, unknown>;
    payload.atomic = true;
    payload.transaction_state = "rolled_back";
    (payload.steps as Array<Record<string, unknown>>)[2] = {
      index: 2,
      invocation_id: "0197a3c2-0000-7000-8000-000000000023",
      status: "completed",
      result: {},
      replayed: false,
    };

    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/steps/2/status" }),
      ]),
    );
  });

  it("rejects failed_step_index that is not the first non-success step", () => {
    const envelope = batchPayload();
    (envelope.payload as Record<string, unknown>).failed_step_index = 0;

    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/failed_step_index" }),
      ]),
    );
  });

  it("stops atomic:false after a guarded step", () => {
    const envelope = batchPayload();
    const payload = envelope.payload as Record<string, unknown>;
    payload.status = "guarded";
    payload.failed_step_index = 0;
    payload.steps = [
      {
        index: 0,
        invocation_id: "0197a3c2-0000-7000-8000-000000000021",
        status: "guarded",
        guarded_reason: "confirmation_required",
        result: { guarded: true },
        replayed: false,
      },
      {
        index: 1,
        invocation_id: "0197a3c2-0000-7000-8000-000000000022",
        status: "not_started",
        replayed: false,
      },
    ];
    expect(validateRbpEnvelope(envelope)).toBe(true);

    (payload.steps as Array<Record<string, unknown>>)[1] = {
      index: 1,
      invocation_id: "0197a3c2-0000-7000-8000-000000000022",
      status: "completed",
      result: {},
      replayed: false,
    };
    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/steps/1/status" }),
      ]),
    );
  });

  it("accepts mixed replayed, indeterminate, and not_started batch redelivery", () => {
    const envelope = batchPayload();
    const payload = envelope.payload as Record<string, unknown>;
    payload.status = "indeterminate";
    payload.failed_step_index = 1;
    payload.steps = [
      {
        index: 0,
        invocation_id: "0197a3c2-0000-7000-8000-000000000021",
        status: "completed",
        result: {},
        replayed: true,
      },
      {
        index: 1,
        invocation_id: "0197a3c2-0000-7000-8000-000000000022",
        status: "indeterminate",
        error: {
          retryable: false,
          fault_class: "journal_indeterminate",
          outcome: "indeterminate",
          verification_required: true,
          replayed: false,
          verification_hold_id:
            "vh:3333333333333333333333333333333333333333333333333333333333333333",
          mutation_scope: { kind: "document", document_id: "doc-01" },
          message: "verification required",
        },
        replayed: false,
      },
      {
        index: 2,
        invocation_id: "0197a3c2-0000-7000-8000-000000000023",
        status: "not_started",
        replayed: false,
      },
    ];

    expect(validateRbpEnvelope(envelope)).toBe(true);
  });

  it("couples late terminal hold and digest evidence to the nested error", () => {
    const envelope = clone(positiveByName.get("batch_late_failed_result"));
    expect(envelope).toBeDefined();
    if (envelope === undefined) {
      return;
    }
    const payload = envelope.payload as Record<string, unknown>;
    const step = (payload.steps as Array<Record<string, unknown>>)[0];
    if (step === undefined) {
      throw new Error("missing late failed batch step");
    }
    step.verification_hold_id =
      "vh:5555555555555555555555555555555555555555555555555555555555555555";

    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "rbpSemantic",
          instancePath: "/payload/steps/0/verification_hold_id",
        }),
      ]),
    );
  });

  it("requires committed transaction state for successful atomic batch", () => {
    const envelope = batchPayload();
    const payload = envelope.payload as Record<string, unknown>;
    payload.atomic = true;
    payload.transaction_state = "committed";
    expect(validateRbpEnvelope(envelope)).toBe(true);

    payload.transaction_state = "not_applicable";
    expect(validateRbpEnvelope(envelope)).toBe(false);
  });

  it("accepts a cancelled atomic result with a known committed transaction", () => {
    const envelope = clone(positiveByName.get("batch_cancelled_result"));
    expect(envelope).toBeDefined();
    if (envelope === undefined) return;
    const payload = envelope.payload as Record<string, unknown>;
    payload.atomic = true;
    payload.transaction_state = "committed";
    const step = (payload.steps as Array<Record<string, unknown>>)[0];
    if (step === undefined) throw new Error("missing cancelled batch step");
    (step.error as Record<string, unknown>).effect_state = "committed";

    expect(validateRbpEnvelope(envelope)).toBe(true);

    payload.transaction_state = "indeterminate";
    expect(validateRbpEnvelope(envelope)).toBe(false);
  });

  it("rejects duplicate invocation ids in batch requests and results", () => {
    const request = clone(positiveByName.get("invoke_batch"));
    expect(request).toBeDefined();
    if (request === undefined) {
      return;
    }
    const requestPayload = request.payload as Record<string, unknown>;
    const firstRequestStep = clone(
      (requestPayload.steps as Array<Record<string, unknown>>)[0] as Record<string, unknown>,
    );
    requestPayload.steps = [firstRequestStep, clone(firstRequestStep)];
    expect(validateRbpEnvelope(request)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/steps/1/invocation_id" }),
      ]),
    );

    const result = batchPayload();
    const resultPayload = result.payload as Record<string, unknown>;
    const firstResultStep = clone(
      (resultPayload.steps as Array<Record<string, unknown>>)[0] as Record<string, unknown>,
    );
    resultPayload.steps = [firstResultStep, { ...clone(firstResultStep), index: 1 }];
    expect(validateRbpEnvelope(result)).toBe(false);
  });
});

describe("partial chunk bounds", () => {
  it("enforces the decoded 1 MiB limit, not only encoded text length", () => {
    const envelope = clone(positiveByName.get("partial_chunk"));
    expect(envelope).toBeDefined();
    if (envelope === undefined) {
      return;
    }

    (envelope.payload as Record<string, unknown>).data = "A".repeat(1_398_104);
    expect(validateRbpEnvelope(envelope)).toBe(false);
    expect(rbpEnvelopeErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "rbpSemantic", instancePath: "/payload/data" }),
      ]),
    );
  });
});

describe("raw UTF-8 frame parsing and normative byte limits", () => {
  const limits = readFixture<FrameLimitFixture>("frame-limits.json");

  it("matches the published byte-limit constants", () => {
    expect(RBP_MAX_INVOCATION_PARAMS_BYTES).toBe(limits.invocation_params.limit_bytes);
    expect(RBP_MAX_INLINE_RESULT_BYTES).toBe(limits.inline_result.limit_bytes);
    expect(RBP_MAX_CONTROL_FRAME_BYTES).toBe(limits.control_frame.limit_bytes);
    expect(RBP_MAX_DOC_CONTEXT_FRAME_BYTES).toBe(
      limits.doc_context_update_frame.limit_bytes,
    );
  });

  it("accepts 4 MiB serialized params and rejects the next byte", () => {
    const atLimit = clone(positiveByName.get("invoke"));
    expect(atLimit).toBeDefined();
    if (atLimit === undefined) {
      return;
    }
    (atLimit.payload as Record<string, unknown>).params = sizedValueMarker;
    expect(
      parseRbpFrame(withSizedJsonString(atLimit, limits.invocation_params.accepted_bytes)).type,
    ).toBe("invoke");

    const overLimit = clone(atLimit);
    expectFrameError(
      withSizedJsonString(overLimit, limits.invocation_params.rejected_bytes),
      "frame_too_large",
      "/payload/params",
    );

    const objectOnlyProbe = clone(positiveByName.get("invoke"));
    expect(objectOnlyProbe).toBeDefined();
    if (objectOnlyProbe !== undefined) {
      (objectOnlyProbe.payload as Record<string, unknown>).params = "x".repeat(4_194_305);
      expect(validateRbpEnvelope(objectOnlyProbe)).toBe(true);
      expectFrameError(
        wireEncoder.encode(JSON.stringify(objectOnlyProbe)),
        "frame_too_large",
        "/payload/params",
      );
    }
  }, 30_000);

  it("applies the params limit independently to every batch step", () => {
    const batch = clone(positiveByName.get("invoke_batch"));
    expect(batch).toBeDefined();
    if (batch === undefined) {
      return;
    }
    const steps = (batch.payload as Record<string, unknown>).steps as Array<
      Record<string, unknown>
    >;
    steps[0]!.params = sizedValueMarker;
    expectFrameError(
      withSizedJsonString(batch, limits.invocation_params.rejected_bytes),
      "frame_too_large",
      "/payload/steps/0/params",
    );
  }, 15_000);

  it("accepts a 32 MiB inline result and rejects the next byte", () => {
    const atLimit = clone(positiveByName.get("invocation_result"));
    expect(atLimit).toBeDefined();
    if (atLimit === undefined) {
      return;
    }
    (atLimit.payload as Record<string, unknown>).result = sizedValueMarker;
    expect(
      parseRbpFrame(withSizedJsonString(atLimit, limits.inline_result.accepted_bytes)).type,
    ).toBe("result");
    expectFrameError(
      withSizedJsonString(atLimit, limits.inline_result.rejected_bytes),
      "frame_too_large",
      "/payload/result",
    );
  }, 30_000);

  it("applies the 32 MiB cap to inline mapping plus artifact streams combined", () => {
    const artifactResult = clone(positiveByName.get("artifact_result"));
    expect(artifactResult).toBeDefined();
    if (artifactResult === undefined) {
      return;
    }
    const payload = artifactResult.payload as Record<string, unknown>;
    const artifacts = payload.artifacts as Array<Record<string, unknown>>;
    artifacts[0]!.total_size = RBP_MAX_INLINE_RESULT_BYTES;
    expect(validateRbpEnvelope(artifactResult)).toBe(true);
    expectFrameError(
      wireEncoder.encode(JSON.stringify(artifactResult)),
      "frame_too_large",
      "/payload/result",
    );
  });

  it("enforces exact 64 KiB control and 256 KiB context frame limits", () => {
    const hello = clone(positiveByName.get("hello"));
    const context = clone(positiveByName.get("doc_context_update"));
    expect(hello).toBeDefined();
    expect(context).toBeDefined();
    if (hello === undefined || context === undefined) {
      return;
    }

    expect(parseRbpFrame(withExactFrameSize(hello, limits.control_frame.accepted_bytes)).type).toBe(
      "hello",
    );
    expectFrameError(
      withExactFrameSize(hello, limits.control_frame.rejected_bytes),
      "frame_too_large",
      "/",
    );
    expect(
      parseRbpFrame(withExactFrameSize(context, limits.doc_context_update_frame.accepted_bytes))
        .type,
    ).toBe("doc_context_update");
    expectFrameError(
      withExactFrameSize(context, limits.doc_context_update_frame.rejected_bytes),
      "frame_too_large",
      "/",
    );
  });

  it("rejects BOM, malformed UTF-8, malformed JSON, and duplicate keys", () => {
    expectFrameError(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "utf8_bom");
    expectFrameError(new Uint8Array([0xc3, 0x28]), "invalid_utf8");
    expectFrameError(wireEncoder.encode("{"), "invalid_json");

    const hello = clone(positiveByName.get("hello"));
    expect(hello).toBeDefined();
    if (hello !== undefined) {
      const duplicate = JSON.stringify(hello).replace(
        '{"type":"hello"',
        '{"type":"hello","type":"hello"',
      );
      expectFrameError(wireEncoder.encode(duplicate), "duplicate_key");
    }
  });
});

describe("RES-21 key and RFC 8785 params digest", () => {
  const digestFixture = readFixture<DigestFixture>("params-digest.json");

  it("uses the exact rsid/invocation_id composite key", () => {
    expect(makeIdempotencyKey("rs_123", "inv_456")).toBe("rs_123/inv_456");
    expect(() => makeIdempotencyKey("", "inv_456")).toThrow();
  });

  it.each(digestFixture.vectors)("matches $name", (vector) => {
    expect(canonicalizeJson(vector.params)).toBe(vector.canonical);
    expect(makeParamsDigest(vector.params)).toBe(vector.digest);
  });

  it("does not normalize Unicode and rejects non-I-JSON primitives", () => {
    expect(makeParamsDigest({ value: "é" })).not.toBe(makeParamsDigest({ value: "é" }));
    expect(() => canonicalizeJson(Number.NaN as unknown as JsonValue)).toThrow(/finite/);
    expect(() => canonicalizeJson("\ud800")).toThrow(/surrogate/);

    const sparse = new Array<JsonValue>(1);
    expect(() => canonicalizeJson(sparse)).toThrow(/undefined array item/);

    const symbolMember = { value: 1 } as Record<PropertyKey, unknown>;
    symbolMember[Symbol("hidden")] = true;
    expect(() => canonicalizeJson(symbolMember as JsonValue)).toThrow(/symbol-keyed/);
  });
});

describe("RBP/1 batch digest", () => {
  const fixture = readFixture<BatchDigestFixture>("batch-digest.json");

  it.each(fixture.vectors)("matches $name", (vector) => {
    expect(makeBatchDigest(vector.input)).toBe(vector.digest);
  });

  it("binds atomic, policy, scope, and recovery clearance semantics", () => {
    const base = fixture.vectors[0];
    expect(base).toBeDefined();
    if (base === undefined) {
      return;
    }

    const atomic = clone(base.input);
    atomic.atomic = !atomic.atomic;
    expect(makeBatchDigest(atomic)).not.toBe(base.digest);

    const policy = clone(base.input);
    policy.steps[0]!.policy.decision = "changed";
    expect(makeBatchDigest(policy)).not.toBe(base.digest);

    const scope = clone(base.input);
    scope.steps[0]!.mutation_scope = { kind: "session" };
    expect(makeBatchDigest(scope)).not.toBe(base.digest);

    const clearance = clone(base.input);
    clearance.recovery_clearances = [{ hold_id: "vh:test" }];
    expect(makeBatchDigest(clearance)).not.toBe(base.digest);
  });
});

describe("reconnect full-jitter contract", () => {
  const fixture = readFixture<BackoffFixture>("reconnect-backoff.json");

  it.each(fixture.limits)("uses the limit for attempt n=$attempt_index", (vector) => {
    expect(reconnectBackoffLimitMs(vector.attempt_index)).toBe(vector.limit_ms);
  });

  it.each(fixture.jitter)("maps deterministic sample for attempt n=$attempt_index", (vector) => {
    expect(reconnectFullJitterDelayMs(vector.attempt_index, () => vector.sample)).toBe(
      vector.delay_ms,
    );
  });

  it.each(fixture.reset)("evaluates steady reset at $steady_ms ms", (vector) => {
    expect(shouldResetReconnectBackoff(vector.steady_ms)).toBe(vector.reset);
  });

  it("defines the first automatic wait as attempt index n=0", () => {
    expect(reconnectBackoffLimitMs(0)).toBe(1000);
    expect(reconnectFullJitterDelayMs(0, () => 0)).toBe(0);
    expect(reconnectFullJitterDelayMs(0, () => 0.999999)).toBe(1000);
  });

  it("rejects invalid attempt indices and random samples", () => {
    expect(() => reconnectBackoffLimitMs(-1)).toThrow();
    expect(() => reconnectBackoffLimitMs(0.5)).toThrow();
    expect(() => reconnectFullJitterDelayMs(0, () => 1)).toThrow();
  });
});
