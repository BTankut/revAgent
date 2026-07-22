import { Buffer } from "node:buffer";

export const FRAME_HEADER_BYTES = 4;
export const DEFAULT_MAX_REQUEST_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MIN_REQUEST_PAYLOAD_BYTES = 1024 * 1024;
export const ABSOLUTE_MAX_REQUEST_PAYLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_RESPONSE_PAYLOAD_BYTES = 32 * 1024 * 1024;

export class PayloadLimitError extends Error {
  public readonly advertisedBytes: number;
  public readonly maxPayloadBytes: number;
  public readonly completedFrames: readonly Buffer[];

  public constructor(
    advertisedBytes: number,
    maxPayloadBytes: number,
    completedFrames: readonly Buffer[] = [],
  ) {
    super(`Payload length ${advertisedBytes} exceeds cap ${maxPayloadBytes}`);
    this.name = "PayloadLimitError";
    this.advertisedBytes = advertisedBytes;
    this.maxPayloadBytes = maxPayloadBytes;
    this.completedFrames = completedFrames;
  }
}

export function jsonPayloadBytes(value: unknown): Buffer {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("JSON payload is not serializable");
  }
  return Buffer.from(serialized, "utf8");
}

export function encodeFrame(
  payload: Uint8Array,
  maxPayloadBytes = 0xffff_ffff,
): Buffer {
  const bytes = Buffer.from(payload);
  if (bytes.byteLength > maxPayloadBytes || bytes.byteLength > 0xffff_ffff) {
    throw new PayloadLimitError(bytes.byteLength, Math.min(maxPayloadBytes, 0xffff_ffff));
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bytes.byteLength);
  frame.writeUInt32BE(bytes.byteLength, 0);
  bytes.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(value: unknown, maxPayloadBytes: number): Buffer {
  return encodeFrame(jsonPayloadBytes(value), maxPayloadBytes);
}

/** Incremental decoder that preserves frame boundaries across arbitrary TCP reads. */
export class FrameDecoder {
  readonly #maxPayloadBytes: number;
  #buffer = Buffer.alloc(0);
  #closed = false;

  public constructor(maxPayloadBytes: number) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
      throw new RangeError("maxPayloadBytes must be a non-negative safe integer");
    }
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  public get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public push(chunk: Uint8Array): Buffer[] {
    if (this.#closed) {
      throw new Error("FrameDecoder is closed after a fatal frame error");
    }
    if (chunk.byteLength > 0) {
      this.#buffer =
        this.#buffer.byteLength === 0
          ? Buffer.from(chunk)
          : Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    }

    const frames: Buffer[] = [];
    while (this.#buffer.byteLength >= FRAME_HEADER_BYTES) {
      const payloadLength = this.#buffer.readUInt32BE(0);
      if (payloadLength > this.#maxPayloadBytes) {
        this.#closed = true;
        this.#buffer = Buffer.alloc(0);
        throw new PayloadLimitError(payloadLength, this.#maxPayloadBytes, frames);
      }
      const frameBytes = FRAME_HEADER_BYTES + payloadLength;
      if (this.#buffer.byteLength < frameBytes) break;
      frames.push(Buffer.from(this.#buffer.subarray(FRAME_HEADER_BYTES, frameBytes)));
      this.#buffer = this.#buffer.subarray(frameBytes);
    }
    return frames;
  }
}
