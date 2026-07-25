import {
  parseRbpFrame,
  rbpEnvelopeErrors,
  RbpFrameError,
  validateRbpEnvelope,
} from "@revagent/protocol";

import type { HelloAckEnvelope, HelloEnvelope } from "./types.js";
import { assertImplementedProtocolVersion } from "./versionAdapter.js";

export function parseHelloFrame(frame: Uint8Array): HelloEnvelope {
  try {
    const envelope = parseRbpFrame(frame);
    if (envelope.type !== "hello") {
      throw new RbpFrameError("invalid_envelope", "first RBP frame must be hello");
    }
    return envelope;
  } catch (error) {
    /*
     * The RBP/1 generated schema intentionally freezes hello's ordinary
     * positive vector at 1/1. Connection negotiation must nevertheless read
     * a well-formed foreign version window so the server can issue 4426/426.
     * parseRbpFrame has already enforced strict UTF-8, duplicate-key rejection,
     * JSON object framing, and byte limits before reporting invalid_envelope.
     */
    if (!(error instanceof RbpFrameError) || error.code !== "invalid_envelope") {
      throw error;
    }
    const candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
    if (typeof candidate !== "object" || candidate === null) {
      throw error;
    }
    const record = candidate as Record<string, unknown>;
    const payload = record.payload;
    if (record.type !== "hello" || typeof payload !== "object" || payload === null) {
      throw error;
    }
    const payloadRecord = payload as Record<string, unknown>;
    const minimum = payloadRecord.min_protocol;
    const maximum = payloadRecord.max_protocol;
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      (minimum as number) < 1 ||
      (maximum as number) < (minimum as number)
    ) {
      throw error;
    }
    const validationCopy = structuredClone(record);
    const validationPayload = validationCopy.payload as Record<string, unknown>;
    validationPayload.min_protocol = 1;
    validationPayload.max_protocol = 1;
    if (!validateRbpEnvelope(validationCopy as unknown as HelloEnvelope)) {
      throw new RbpFrameError(
        "invalid_envelope",
        "invalid hello schema",
        { validationErrors: [...rbpEnvelopeErrors()] },
      );
    }
    return record as unknown as HelloEnvelope;
  }
}

export function serializeHelloAck(envelope: HelloAckEnvelope): string {
  if (envelope.type !== "hello_ack") {
    throw new TypeError("invalid hello_ack envelope");
  }
  assertImplementedProtocolVersion(envelope.payload.protocol);
  const validationCopy = structuredClone(envelope);
  validationCopy.payload.protocol = 1;
  if (!validateRbpEnvelope(validationCopy)) {
    throw new TypeError("invalid hello_ack envelope");
  }
  return JSON.stringify(envelope);
}
