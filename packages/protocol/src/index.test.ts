import { describe, expect, it } from "vitest";

import {
  makeIdempotencyKey,
  RBP_PROTOCOL_VERSION,
  validateRbpEnvelope,
} from "./index.js";

describe("RBP/1 protocol scaffold", () => {
  const dataMessageTypes = [
    "invoke",
    "invoke_batch",
    "result",
    "partial",
    "error",
    "cancel",
    "doc_context_update",
  ] as const;

  it("uses the RES-21 canonical idempotency key", () => {
    expect(makeIdempotencyKey("rs_123", "inv_456")).toBe("rs_123/inv_456");
  });

  it("validates a minimal control envelope", () => {
    expect(
      validateRbpEnvelope({
        v: RBP_PROTOCOL_VERSION,
        type: "hello",
        id: "0197a3c2-0000-7000-8000-000000000001",
        ts: "2026-07-22T12:00:00.000Z",
        payload: {},
      }),
    ).toBe(true);
  });

  it("rejects an unknown protocol version", () => {
    expect(
      validateRbpEnvelope({
        v: 2,
        type: "hello",
        id: "message-id",
        ts: "2026-07-22T12:00:00.000Z",
        payload: {},
      }),
    ).toBe(false);
  });

  it.each(dataMessageTypes)("requires rsid and seq on %s", (type) => {
    const envelope = {
      v: RBP_PROTOCOL_VERSION,
      type,
      id: `message-${type}`,
      rsid: "rs_123",
      seq: 1,
      ts: "2026-07-22T12:00:00.000Z",
      payload: {},
    };

    expect(validateRbpEnvelope(envelope)).toBe(true);
    expect(validateRbpEnvelope({ ...envelope, rsid: undefined })).toBe(false);
    expect(validateRbpEnvelope({ ...envelope, seq: undefined })).toBe(false);
    expect(validateRbpEnvelope({ ...envelope, seq: 0 })).toBe(false);
  });

  it("rejects sequence values outside the JSON-safe integer range", () => {
    expect(
      validateRbpEnvelope({
        v: RBP_PROTOCOL_VERSION,
        type: "invoke",
        id: "unsafe-sequence",
        rsid: "rs_123",
        seq: 9_007_199_254_740_992,
        ts: "2026-07-22T12:00:00.000Z",
        payload: {},
      }),
    ).toBe(false);
  });
});
