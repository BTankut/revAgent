import type { Buffer } from "node:buffer";
import { connect, type Socket } from "node:net";

import { FrameDecoder, MAX_RESPONSE_PAYLOAD_BYTES, encodeJsonFrame } from "./framing.js";
import type { FixtureAddress, JsonObject } from "./types.js";

export async function connectFixture(address: FixtureAddress): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: address.host, port: address.port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function readFixtureFrames(
  socket: Socket,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<JsonObject[]> {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new RangeError("expectedCount must be a positive integer");
  }
  return new Promise<JsonObject[]>((resolve, reject) => {
    const decoder = new FrameDecoder(MAX_RESPONSE_PAYLOAD_BYTES);
    const responses: JsonObject[] = [];
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for fixture response")), timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve(responses);
    };
    const onData = (chunk: Buffer): void => {
      try {
        for (const payload of decoder.push(chunk)) {
          responses.push(JSON.parse(payload.toString("utf8")) as JsonObject);
        }
        if (responses.length >= expectedCount) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => {
      if (responses.length < expectedCount) finish(new Error("Fixture socket closed before response"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function fixtureRequest(
  socket: Socket,
  request: JsonObject,
  maxRequestPayloadBytes: number,
): Promise<JsonObject> {
  const responsePromise = readFixtureFrames(socket, 1);
  socket.write(encodeJsonFrame(request, maxRequestPayloadBytes));
  const responses = await responsePromise;
  const response = responses[0];
  if (!response) throw new Error("Fixture returned no response");
  return response;
}
