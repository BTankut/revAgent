import { RbpFrameError, type RbpEnvelope } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  normalizeSupportedProtocols,
  parseVersionHint,
} from "../src/negotiation.js";
import {
  assertImplementedProtocolWindow,
  parseNegotiatedRbpFrame,
  serializeNegotiatedRbpEnvelope,
} from "../src/versionAdapter.js";
import {
  controlEnvelope,
  sessionRegister,
} from "./helpers.js";

const encoder = new TextEncoder();

function wireVersion(envelope: RbpEnvelope, version: number): Record<string, unknown> {
  return { ...structuredClone(envelope), v: version };
}

describe("Gateway protocol compatibility adapter", () => {
  it("accepts only the bootstrap exception or an exact contiguous N/N-1 window", () => {
    expect(normalizeSupportedProtocols([1])).toEqual([1]);
    expect(normalizeSupportedProtocols([1, 2, 1])).toEqual([2, 1]);
    expect(() => normalizeSupportedProtocols([2])).toThrow(/exactly the contiguous/u);
    expect(() => normalizeSupportedProtocols([3, 1])).toThrow(/contiguous/u);
    expect(() => normalizeSupportedProtocols([3, 2, 1])).toThrow(/exactly/u);
    expect(() => normalizeSupportedProtocols([2, 0, 1])).toThrow(/positive safe/u);
    expect(() => assertImplementedProtocolWindow([3, 2])).toThrow(/no wire compatibility adapter/u);
    expect(parseVersionHint("2,1")).toEqual([2, 1]);
    expect(parseVersionHint("2,invalid,1")).toEqual([]);
  });

  it("normalizes an RBP/2 frame to the canonical RBP/1 state shape", () => {
    const canonical = controlEnvelope("session_register", sessionRegister(), 901);
    const wire = wireVersion(canonical, 2);
    const parsed = parseNegotiatedRbpFrame(
      encoder.encode(JSON.stringify(wire)),
      2,
    );

    expect(parsed).toEqual({
      wireProtocol: 2,
      envelope: canonical,
    });
    expect(wire.v).toBe(2);
    expect(parsed.envelope).not.toBe(wire);
  });

  it("preserves strict raw-boundary and schema rejection on the RBP/2 path", () => {
    const canonical = controlEnvelope("session_register", sessionRegister(), 902);
    const wire = JSON.stringify(wireVersion(canonical, 2));
    const duplicate = wire.replace('"v":2', '"v":2,"v":2');
    expect(() => parseNegotiatedRbpFrame(encoder.encode(duplicate), 2)).toThrow(
      expect.objectContaining<RbpFrameError>({ code: "duplicate_key" }),
    );

    const malformed = wireVersion(canonical, 2);
    delete (malformed.payload as Record<string, unknown>).machine;
    expect(() =>
      parseNegotiatedRbpFrame(encoder.encode(JSON.stringify(malformed)), 2)
    ).toThrow(expect.objectContaining<RbpFrameError>({ code: "invalid_envelope" }));
  });

  it("serializes an outbound copy at the selected wire version without mutating persistence", () => {
    const canonical = controlEnvelope("session_register", sessionRegister(), 903);
    const serialized = serializeNegotiatedRbpEnvelope(canonical, 2);

    expect(JSON.parse(serialized)).toMatchObject({
      v: 2,
      type: "session_register",
    });
    expect(canonical.v).toBe(1);
    expect(() => serializeNegotiatedRbpEnvelope(canonical, 3)).toThrow(
      /no wire compatibility adapter/u,
    );
  });
});
