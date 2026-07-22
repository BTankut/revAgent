import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeJson,
  makeBatchDigest,
  makeParamsDigest,
  parseRbpFrame,
  rbpEnvelopeErrors,
  RBP_MAX_CONTROL_FRAME_BYTES,
  RBP_MAX_DOC_CONTEXT_FRAME_BYTES,
  RBP_MAX_INLINE_RESULT_BYTES,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  RbpFrameError,
  reconnectBackoffLimitMs,
  reconnectFullJitterDelayMs,
  shouldResetReconnectBackoff,
  validateRbpEnvelope,
} from "../dist/src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = resolve(packageRoot, "conformance/fixtures");

async function readFixture(name) {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function messageId(index) {
  return `0197a3c2-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
}

function materialize(vector, index) {
  const envelope = {
    type: vector.type,
    id: messageId(index),
    ts: "2026-07-22T12:00:00.000Z",
    payload: clone(vector.payload),
  };

  if (vector.scope !== "pre_negotiation") {
    envelope.v = 1;
  }

  if (vector.scope === "data") {
    envelope.rsid = "rs_7f3a";
    envelope.seq = index + 1;
    envelope.ack = 0;
  }

  return envelope;
}

function materializeNegative(vector, bases) {
  const envelope = clone(bases.get(vector.base));
  Object.assign(envelope, vector.patch ?? {});
  Object.assign(envelope.payload, vector.payload_patch ?? {});

  for (const field of vector.remove ?? []) {
    delete envelope[field];
  }
  for (const field of vector.payload_remove ?? []) {
    delete envelope.payload[field];
  }

  return envelope;
}

const wireEncoder = new TextEncoder();
const sizedValueMarker = "__RBP_CONFORMANCE_SIZED_VALUE__";

function withSizedJsonString(envelope, serializedValueBytes) {
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

function withExactFrameSize(envelope, frameBytes) {
  envelope.conformance_padding = "";
  const emptyBytes = wireEncoder.encode(JSON.stringify(envelope)).byteLength;
  if (emptyBytes > frameBytes) {
    throw new Error("base envelope exceeds requested frame size");
  }
  envelope.conformance_padding = "x".repeat(frameBytes - emptyBytes);
  const frame = wireEncoder.encode(JSON.stringify(envelope));
  if (frame.byteLength !== frameBytes) {
    throw new Error(`expected ${frameBytes} frame bytes, got ${frame.byteLength}`);
  }
  return frame;
}

function requireFrameError(frame, code, path) {
  try {
    parseRbpFrame(frame);
  } catch (error) {
    if (
      error instanceof RbpFrameError &&
      error.code === code &&
      (path === undefined || error.path === path)
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`frame unexpectedly passed; expected ${code}`);
}

const envelopeFixture = await readFixture("envelopes.json");
const bases = new Map();

for (const [index, vector] of envelopeFixture.positive.entries()) {
  const envelope = materialize(vector, index);
  bases.set(vector.name, envelope);
  if (!validateRbpEnvelope(envelope)) {
    throw new Error(
      `positive envelope vector ${vector.name} failed: ${JSON.stringify(rbpEnvelopeErrors())}`,
    );
  }
}

for (const vector of envelopeFixture.negative) {
  const envelope = materializeNegative(vector, bases);
  if (validateRbpEnvelope(envelope)) {
    throw new Error(`negative envelope vector ${vector.name} unexpectedly passed`);
  }
}

const frameLimits = await readFixture("frame-limits.json");
const expectedLimits = {
  invocation_params: RBP_MAX_INVOCATION_PARAMS_BYTES,
  inline_result: RBP_MAX_INLINE_RESULT_BYTES,
  control_frame: RBP_MAX_CONTROL_FRAME_BYTES,
  doc_context_update_frame: RBP_MAX_DOC_CONTEXT_FRAME_BYTES,
};
for (const [name, limit] of Object.entries(expectedLimits)) {
  if (frameLimits[name].limit_bytes !== limit) {
    throw new Error(`frame limit fixture drift for ${name}`);
  }
}

const invokeAtLimit = clone(bases.get("invoke"));
invokeAtLimit.payload.params = sizedValueMarker;
parseRbpFrame(
  withSizedJsonString(invokeAtLimit, frameLimits.invocation_params.accepted_bytes),
);
requireFrameError(
  withSizedJsonString(invokeAtLimit, frameLimits.invocation_params.rejected_bytes),
  "frame_too_large",
  "/payload/params",
);

const objectOnlyOversize = clone(bases.get("invoke"));
objectOnlyOversize.payload.params = "x".repeat(4_194_305);
if (!validateRbpEnvelope(objectOnlyOversize)) {
  throw new Error("parsed-object validation must remain byte-limit agnostic");
}
requireFrameError(
  wireEncoder.encode(JSON.stringify(objectOnlyOversize)),
  "frame_too_large",
  "/payload/params",
);

const resultAtLimit = clone(bases.get("invocation_result"));
resultAtLimit.payload.result = sizedValueMarker;
parseRbpFrame(withSizedJsonString(resultAtLimit, frameLimits.inline_result.accepted_bytes));
requireFrameError(
  withSizedJsonString(resultAtLimit, frameLimits.inline_result.rejected_bytes),
  "frame_too_large",
  "/payload/result",
);

const controlAtLimit = clone(bases.get("hello"));
parseRbpFrame(withExactFrameSize(controlAtLimit, frameLimits.control_frame.accepted_bytes));
requireFrameError(
  withExactFrameSize(controlAtLimit, frameLimits.control_frame.rejected_bytes),
  "frame_too_large",
  "/",
);

const contextAtLimit = clone(bases.get("doc_context_update"));
parseRbpFrame(
  withExactFrameSize(contextAtLimit, frameLimits.doc_context_update_frame.accepted_bytes),
);
requireFrameError(
  withExactFrameSize(contextAtLimit, frameLimits.doc_context_update_frame.rejected_bytes),
  "frame_too_large",
  "/",
);

requireFrameError(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "utf8_bom");
requireFrameError(new Uint8Array([0xc3, 0x28]), "invalid_utf8");
requireFrameError(wireEncoder.encode("{"), "invalid_json");
const duplicateKeyFrame = JSON.stringify(bases.get("hello")).replace(
  '{"type":"hello"',
  '{"type":"hello","type":"hello"',
);
requireFrameError(wireEncoder.encode(duplicateKeyFrame), "duplicate_key");

const digestFixture = await readFixture("params-digest.json");
for (const vector of digestFixture.vectors) {
  const canonical = canonicalizeJson(vector.params);
  if (canonical !== vector.canonical) {
    throw new Error(
      `params digest vector ${vector.name} canonical mismatch: ${canonical} != ${vector.canonical}`,
    );
  }
  const digest = makeParamsDigest(vector.params);
  if (digest !== vector.digest) {
    throw new Error(`params digest vector ${vector.name} mismatch: ${digest} != ${vector.digest}`);
  }
}

const batchDigestFixture = await readFixture("batch-digest.json");
for (const vector of batchDigestFixture.vectors) {
  const digest = makeBatchDigest(vector.input);
  if (digest !== vector.digest) {
    throw new Error(`batch digest vector ${vector.name} mismatch: ${digest} != ${vector.digest}`);
  }
}

const backoffFixture = await readFixture("reconnect-backoff.json");
for (const vector of backoffFixture.limits) {
  const actual = reconnectBackoffLimitMs(vector.attempt_index);
  if (actual !== vector.limit_ms) {
    throw new Error(
      `backoff limit vector n=${vector.attempt_index} mismatch: ${actual} != ${vector.limit_ms}`,
    );
  }
}
for (const vector of backoffFixture.jitter) {
  const actual = reconnectFullJitterDelayMs(vector.attempt_index, () => vector.sample);
  if (actual !== vector.delay_ms) {
    throw new Error(
      `backoff jitter vector n=${vector.attempt_index} mismatch: ${actual} != ${vector.delay_ms}`,
    );
  }
}
for (const vector of backoffFixture.reset) {
  const actual = shouldResetReconnectBackoff(vector.steady_ms);
  if (actual !== vector.reset) {
    throw new Error(
      `backoff reset vector ${vector.steady_ms} mismatch: ${actual} != ${vector.reset}`,
    );
  }
}

console.log(
  JSON.stringify({
    success: true,
    envelopePositive: envelopeFixture.positive.length,
    envelopeNegative: envelopeFixture.negative.length,
    frameLimits: Object.keys(frameLimits).length,
    rawFrameSyntax: 4,
    paramsDigest: digestFixture.vectors.length,
    batchDigest: batchDigestFixture.vectors.length,
    reconnectBackoff:
      backoffFixture.limits.length + backoffFixture.jitter.length + backoffFixture.reset.length,
  }),
);
