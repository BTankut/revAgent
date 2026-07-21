import { describe, expect, it } from "vitest";

import {
  makeIdempotencyKey,
  RBP_PROTOCOL_VERSION,
  validateRbpEnvelope,
} from "./index.js";

describe("RBP/1 protocol scaffold", () => {
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
});
