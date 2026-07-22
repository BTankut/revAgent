import { Buffer } from "node:buffer";
import type { Socket } from "node:net";

import {
  DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
  encodeJsonFrame,
  readFixtureFrames,
  type JsonObject,
} from "../src/index.js";

export const DIGEST = `sha256:${"0".repeat(64)}`;

export function uuid7(suffix: number): string {
  return `0197a3c2-0000-7000-8000-${suffix.toString().padStart(12, "0")}`;
}

export function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

export function exactJsonPadding(targetBytes: number, field = "padding"): JsonObject {
  const empty = { [field]: "" };
  const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
  const remaining = targetBytes - overhead;
  if (remaining < 0) throw new Error("Target is smaller than JSON object overhead");
  const padding = "ğ".repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "x");
  const value = { [field]: padding };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") !== targetBytes) {
    throw new Error("Unable to construct exact UTF-8 JSON payload");
  }
  return value;
}

export async function writeAndRead(
  socket: Socket,
  value: JsonObject,
  chunks?: readonly number[],
): Promise<JsonObject> {
  const response = readFixtureFrames(socket, 1);
  const frame = encodeJsonFrame(value, DEFAULT_MAX_REQUEST_PAYLOAD_BYTES);
  if (!chunks || chunks.length === 0) {
    socket.write(frame);
  } else {
    let offset = 0;
    for (const size of chunks) {
      socket.write(frame.subarray(offset, Math.min(frame.byteLength, offset + size)));
      offset += size;
    }
    if (offset < frame.byteLength) socket.write(frame.subarray(offset));
  }
  return (await response)[0] as JsonObject;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
