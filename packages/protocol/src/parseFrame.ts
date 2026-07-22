import type { ErrorObject } from "ajv";

import type { RbpEnvelope } from "./generated/envelope.js";
import { rbpEnvelopeErrors, validateRbpEnvelope } from "./validateEnvelope.js";

export const RBP_MAX_INVOCATION_PARAMS_BYTES = 4 * 1024 * 1024;
export const RBP_MAX_INLINE_RESULT_BYTES = 32 * 1024 * 1024;
export const RBP_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const RBP_MAX_DOC_CONTEXT_FRAME_BYTES = 256 * 1024;

export type RbpFrameErrorCode =
  | "invalid_utf8"
  | "utf8_bom"
  | "invalid_json"
  | "duplicate_key"
  | "invalid_envelope"
  | "frame_too_large";

interface FrameErrorOptions {
  path?: string;
  actualBytes?: number;
  limitBytes?: number;
  validationErrors?: ErrorObject[];
}

export class RbpFrameError extends Error {
  readonly code: RbpFrameErrorCode;
  readonly path?: string;
  readonly actualBytes?: number;
  readonly limitBytes?: number;
  readonly validationErrors?: ErrorObject[];

  constructor(code: RbpFrameErrorCode, message: string, options: FrameErrorOptions = {}) {
    super(message);
    this.name = "RbpFrameError";
    this.code = code;
    this.path = options.path;
    this.actualBytes = options.actualBytes;
    this.limitBytes = options.limitBytes;
    this.validationErrors = options.validationErrors;
  }
}

interface JsonSpanBase {
  start: number;
  end: number;
}

interface JsonObjectSpan extends JsonSpanBase {
  kind: "object";
  properties: Map<string, JsonSpan>;
}

interface JsonArraySpan extends JsonSpanBase {
  kind: "array";
  items: JsonSpan[];
}

interface JsonScalarSpan extends JsonSpanBase {
  kind: "scalar";
}

type JsonSpan = JsonObjectSpan | JsonArraySpan | JsonScalarSpan;

class DuplicateKeyError extends Error {
  constructor(readonly key: string) {
    super(`duplicate JSON object key: ${key}`);
  }
}

class JsonSpanParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): JsonSpan {
    this.skipWhitespace();
    const span = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new Error("unexpected trailing JSON text");
    }
    return span;
  }

  private parseValue(): JsonSpan {
    const start = this.index;
    const character = this.text[this.index];
    if (character === "{") {
      return this.parseObject();
    }
    if (character === "[") {
      return this.parseArray();
    }
    if (character === '"') {
      this.parseString();
      return { kind: "scalar", start, end: this.index };
    }

    while (this.index < this.text.length && !/[\s,}\]]/.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
    return { kind: "scalar", start, end: this.index };
  }

  private parseObject(): JsonObjectSpan {
    const start = this.index;
    this.index += 1;
    this.skipWhitespace();
    const properties = new Map<string, JsonSpan>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { kind: "object", start, end: this.index, properties };
    }

    while (this.index < this.text.length) {
      const key = this.parseString();
      if (properties.has(key)) {
        throw new DuplicateKeyError(key);
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        throw new Error("expected JSON object colon");
      }
      this.index += 1;
      this.skipWhitespace();
      properties.set(key, this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return { kind: "object", start, end: this.index, properties };
      }
      if (this.text[this.index] !== ",") {
        throw new Error("expected JSON object separator");
      }
      this.index += 1;
      this.skipWhitespace();
    }

    throw new Error("unterminated JSON object");
  }

  private parseArray(): JsonArraySpan {
    const start = this.index;
    this.index += 1;
    this.skipWhitespace();
    const items: JsonSpan[] = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { kind: "array", start, end: this.index, items };
    }

    while (this.index < this.text.length) {
      items.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return { kind: "array", start, end: this.index, items };
      }
      if (this.text[this.index] !== ",") {
        throw new Error("expected JSON array separator");
      }
      this.index += 1;
      this.skipWhitespace();
    }

    throw new Error("unterminated JSON array");
  }

  private parseString(): string {
    if (this.text[this.index] !== '"') {
      throw new Error("expected JSON string");
    }
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (character === "\\") {
        this.index += 2;
      } else {
        this.index += 1;
      }
    }
    throw new Error("unterminated JSON string");
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const controlTypes = new Set([
  "hello",
  "hello_ack",
  "session_register",
  "session_registered",
  "session_resume",
  "resume_ack",
  "session_unregister",
  "heartbeat",
  "heartbeat_ack",
  "manifest_check",
  "manifest_info",
  "goodbye",
]);

function objectProperty(span: JsonSpan | undefined, name: string): JsonSpan | undefined {
  return span?.kind === "object" ? span.properties.get(name) : undefined;
}

function spanByteLength(text: string, span: JsonSpan): number {
  return textEncoder.encode(text.slice(span.start, span.end)).byteLength;
}

function assertByteLimit(text: string, span: JsonSpan, path: string, limitBytes: number): void {
  const actualBytes = spanByteLength(text, span);
  if (actualBytes > limitBytes) {
    throw new RbpFrameError(
      "frame_too_large",
      `${path} is ${actualBytes} UTF-8 bytes; limit is ${limitBytes}`,
      { path, actualBytes, limitBytes },
    );
  }
}

function enforceInvocationParams(text: string, root: JsonSpan, envelope: RbpEnvelope): void {
  const payloadSpan = objectProperty(root, "payload");
  if (envelope.type === "invoke") {
    const params = objectProperty(payloadSpan, "params");
    if (params !== undefined) {
      assertByteLimit(text, params, "/payload/params", RBP_MAX_INVOCATION_PARAMS_BYTES);
    }
    return;
  }

  if (envelope.type === "invoke_batch") {
    const steps = objectProperty(payloadSpan, "steps");
    if (steps?.kind !== "array") {
      return;
    }
    for (const [index, step] of steps.items.entries()) {
      const params = objectProperty(step, "params");
      if (params !== undefined) {
        assertByteLimit(
          text,
          params,
          `/payload/steps/${index}/params`,
          RBP_MAX_INVOCATION_PARAMS_BYTES,
        );
      }
    }
  }
}

function enforceInlineResults(text: string, root: JsonSpan, envelope: RbpEnvelope): void {
  if (envelope.type !== "result") {
    return;
  }
  const payloadSpan = objectProperty(root, "payload");
  if (payloadSpan?.kind !== "object") {
    return;
  }
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null || !("kind" in payload)) {
    return;
  }
  if (payload.kind === "invocation") {
    const result = objectProperty(payloadSpan, "result");
    if (result !== undefined) {
      const artifacts = "artifacts" in payload && Array.isArray(payload.artifacts)
        ? payload.artifacts
        : [];
      const artifactBytes = artifacts.reduce(
        (total, artifact) =>
          total +
          (typeof artifact === "object" &&
          artifact !== null &&
          "total_size" in artifact &&
          typeof artifact.total_size === "number"
            ? artifact.total_size
            : 0),
        0,
      );
      const actualBytes = spanByteLength(text, result) + artifactBytes;
      if (actualBytes > RBP_MAX_INLINE_RESULT_BYTES) {
        throw new RbpFrameError(
          "frame_too_large",
          `combined invocation result is ${actualBytes} bytes; limit is ${RBP_MAX_INLINE_RESULT_BYTES}`,
          {
            path: "/payload/result",
            actualBytes,
            limitBytes: RBP_MAX_INLINE_RESULT_BYTES,
          },
        );
      }
    }
    return;
  }

  const steps = objectProperty(payloadSpan, "steps");
  if (steps?.kind !== "array") {
    return;
  }
  for (const [index, step] of steps.items.entries()) {
    const result = objectProperty(step, "result");
    if (result !== undefined) {
      assertByteLimit(
        text,
        result,
        `/payload/steps/${index}/result`,
        RBP_MAX_INLINE_RESULT_BYTES,
      );
    }
  }
}

function enforceFrameLimits(
  frameBytes: number,
  text: string,
  root: JsonSpan,
  envelope: RbpEnvelope,
): void {
  const isControl = controlTypes.has(envelope.type) ||
    (envelope.type === "error" && !("rsid" in envelope));
  if (isControl && frameBytes > RBP_MAX_CONTROL_FRAME_BYTES) {
    throw new RbpFrameError(
      "frame_too_large",
      `control frame is ${frameBytes} UTF-8 bytes; limit is ${RBP_MAX_CONTROL_FRAME_BYTES}`,
      {
        path: "/",
        actualBytes: frameBytes,
        limitBytes: RBP_MAX_CONTROL_FRAME_BYTES,
      },
    );
  }

  if (envelope.type === "doc_context_update" && frameBytes > RBP_MAX_DOC_CONTEXT_FRAME_BYTES) {
    throw new RbpFrameError(
      "frame_too_large",
      `doc_context_update frame is ${frameBytes} UTF-8 bytes; limit is ${RBP_MAX_DOC_CONTEXT_FRAME_BYTES}`,
      {
        path: "/",
        actualBytes: frameBytes,
        limitBytes: RBP_MAX_DOC_CONTEXT_FRAME_BYTES,
      },
    );
  }

  enforceInvocationParams(text, root, envelope);
  enforceInlineResults(text, root, envelope);
}

/**
 * Parses one raw RBP JSON frame. This is the boundary API: it enforces UTF-8,
 * duplicate-key rejection, schema/semantic validation, and normative byte caps.
 */
export function parseRbpFrame(frame: Uint8Array): RbpEnvelope {
  if (!(frame instanceof Uint8Array)) {
    throw new TypeError("frame must be a Uint8Array");
  }
  if (frame[0] === 0xef && frame[1] === 0xbb && frame[2] === 0xbf) {
    throw new RbpFrameError("utf8_bom", "RBP JSON must be UTF-8 without BOM");
  }

  let text: string;
  try {
    text = textDecoder.decode(frame);
  } catch {
    throw new RbpFrameError("invalid_utf8", "RBP frame is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RbpFrameError("invalid_json", "RBP frame is not valid JSON");
  }

  let root: JsonSpan;
  try {
    root = new JsonSpanParser(text).parse();
  } catch (error) {
    if (error instanceof DuplicateKeyError) {
      throw new RbpFrameError("duplicate_key", error.message);
    }
    throw new RbpFrameError("invalid_json", "RBP frame is not valid JSON");
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    enforceFrameLimits(frame.byteLength, text, root, value as RbpEnvelope);
  }

  if (!validateRbpEnvelope(value)) {
    throw new RbpFrameError("invalid_envelope", "RBP envelope validation failed", {
      validationErrors: [...rbpEnvelopeErrors()],
    });
  }

  return value;
}
