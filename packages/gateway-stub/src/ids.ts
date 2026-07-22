import { createHash } from "node:crypto";

import type { PersistedGatewayState } from "./types.js";

const TIME_MASK = (1n << 48n) - 1n;
const RANDOM_A_MASK = (1n << 12n) - 1n;
const RANDOM_B_MASK = (1n << 62n) - 1n;

function hex(value: bigint, width: number): string {
  return value.toString(16).padStart(width, "0").slice(-width);
}

/**
 * Produces a schema-valid UUIDv7 whose entropy field is a persisted monotonic
 * counter. The test stub needs reproducible identities, not cryptographic
 * unpredictability; production identity generation remains outside O1-T5.
 */
export function allocateUuidV7(state: PersistedGatewayState, nowMs: number): string {
  const sequence = BigInt(state.nextId);
  state.nextId += 1;
  const time = BigInt(Math.max(0, Math.trunc(nowMs))) & TIME_MASK;
  const randomA = sequence & RANDOM_A_MASK;
  const randomB = (sequence >> 12n) & RANDOM_B_MASK;
  const variantAndHigh = 0x8000n | ((randomB >> 48n) & 0x3fffn);
  const low = randomB & ((1n << 48n) - 1n);
  const timeHex = hex(time, 12);

  return `${timeHex.slice(0, 8)}-${timeHex.slice(8)}-7${hex(randomA, 3)}-${hex(variantAndHigh, 4)}-${hex(low, 12)}`;
}

export function sha256Digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function opaqueId(prefix: string, material: string): string {
  return `${prefix}_${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}
