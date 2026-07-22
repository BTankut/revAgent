import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  FrameDecoder,
  MAX_RESPONSE_PAYLOAD_BYTES,
  MIN_REQUEST_PAYLOAD_BYTES,
  PayloadLimitError,
  encodeFrame,
  jsonPayloadBytes,
} from "../src/index.js";
import { exactJsonPadding } from "./helpers.js";

describe("four-byte big-endian framing", () => {
  it("encodes the exact UTF-8 payload byte count in network order", () => {
    const payload = jsonPayloadBytes({ text: "ğ" });
    const frame = encodeFrame(payload);

    expect(frame.readUInt32BE(0)).toBe(payload.byteLength);
    expect(frame.subarray(4)).toEqual(payload);
    expect(frame.subarray(0, 4)).toEqual(
      Buffer.from([0, 0, 0, payload.byteLength]),
    );
  });

  it("reassembles split headers, split payloads, and the former 8192-byte case", () => {
    const payload = jsonPayloadBytes(exactJsonPadding(8192));
    const frame = encodeFrame(payload);
    const decoder = new FrameDecoder(MIN_REQUEST_PAYLOAD_BYTES);
    const chunks = [frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3, 4099), frame.subarray(4099)];
    const decoded = chunks.flatMap((chunk) => decoder.push(chunk));

    expect(payload.byteLength).toBe(8192);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(payload);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("separates coalesced frames without duplicating either payload", () => {
    const first = jsonPayloadBytes({ id: 1 });
    const second = jsonPayloadBytes({ id: 2, text: "ğ" });
    const decoder = new FrameDecoder(1024);

    expect(decoder.push(Buffer.concat([encodeFrame(first), encodeFrame(second)]))).toEqual([
      first,
      second,
    ]);
  });

  it("accepts exact request max and rejects UTF-8 max-plus-one from the header", () => {
    const exact = jsonPayloadBytes(exactJsonPadding(MIN_REQUEST_PAYLOAD_BYTES));
    const plusOne = jsonPayloadBytes(exactJsonPadding(MIN_REQUEST_PAYLOAD_BYTES + 1));

    expect(encodeFrame(exact, MIN_REQUEST_PAYLOAD_BYTES).readUInt32BE(0)).toBe(
      MIN_REQUEST_PAYLOAD_BYTES,
    );
    expect(() => encodeFrame(plusOne, MIN_REQUEST_PAYLOAD_BYTES)).toThrow(PayloadLimitError);

    const decoder = new FrameDecoder(MIN_REQUEST_PAYLOAD_BYTES);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MIN_REQUEST_PAYLOAD_BYTES + 1);
    expect(() => decoder.push(header)).toThrow(PayloadLimitError);
    expect(decoder.closed).toBe(true);
  });

  it("enforces exact aggregate response max and max-plus-one with multibyte UTF-8", () => {
    const exact = jsonPayloadBytes(exactJsonPadding(MAX_RESPONSE_PAYLOAD_BYTES));
    const plusOne = jsonPayloadBytes(exactJsonPadding(MAX_RESPONSE_PAYLOAD_BYTES + 1));

    expect(encodeFrame(exact, MAX_RESPONSE_PAYLOAD_BYTES).byteLength).toBe(
      MAX_RESPONSE_PAYLOAD_BYTES + 4,
    );
    expect(() => encodeFrame(plusOne, MAX_RESPONSE_PAYLOAD_BYTES)).toThrow(PayloadLimitError);
  });

  it("returns earlier complete frames before a coalesced oversize header fails closed", () => {
    const valid = encodeFrame(jsonPayloadBytes({ ok: true }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1025);
    const decoder = new FrameDecoder(1024);

    try {
      decoder.push(Buffer.concat([valid, header]));
      throw new Error("Expected payload limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect((error as PayloadLimitError).completedFrames).toEqual([jsonPayloadBytes({ ok: true })]);
    }
  });
});
