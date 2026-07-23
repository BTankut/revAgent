import type { RbpEnvelope } from "@revagent/protocol";
import {
  parseRbpFrame,
  rbpEnvelopeErrors,
  RbpFrameError,
  validateRbpEnvelope,
} from "@revagent/protocol";

export const GATEWAY_IMPLEMENTED_PROTOCOLS = [2, 1] as const;
export type GatewayImplementedProtocol = (typeof GATEWAY_IMPLEMENTED_PROTOCOLS)[number];

export interface ParsedNegotiatedRbpFrame {
  /**
   * Exact outer version observed on the wire. Pre-negotiation envelopes do
   * not carry this field and therefore report null.
   */
  readonly wireProtocol: number | null;
  /**
   * Canonical RBP/1 representation used by the shared journal, sequencing,
   * digest, and persistence implementations.
   */
  readonly envelope: RbpEnvelope;
}

function isImplementedProtocol(value: number): value is GatewayImplementedProtocol {
  return (GATEWAY_IMPLEMENTED_PROTOCOLS as readonly number[]).includes(value);
}

export function assertImplementedProtocolVersion(
  value: number,
): asserts value is GatewayImplementedProtocol {
  if (!isImplementedProtocol(value)) {
    throw new TypeError(`Gateway has no wire compatibility adapter for RBP/${value}`);
  }
}

export function assertImplementedProtocolWindow(versions: readonly number[]): void {
  for (const version of versions) {
    assertImplementedProtocolVersion(version);
  }
}

function wireProtocol(envelope: RbpEnvelope): number | null {
  if (!("v" in envelope)) return null;
  return typeof envelope.v === "number" ? envelope.v : null;
}

/**
 * Parses a post-negotiation frame without weakening the RBP/1 boundary.
 *
 * RBP/2 is the additive compatibility wire for this Gateway generation. The
 * raw RBP parser first enforces UTF-8, duplicate-key rejection, JSON framing,
 * and byte limits. Only its expected outer-version schema failure is adapted:
 * the exact frame is then validated as the canonical RBP/1 shape after
 * replacing the outer `v`. Persistent state never stores the compatibility
 * wire version.
 */
export function parseNegotiatedRbpFrame(
  frame: Uint8Array,
  selectedProtocol: number,
): ParsedNegotiatedRbpFrame {
  assertImplementedProtocolVersion(selectedProtocol);
  try {
    const envelope = parseRbpFrame(frame);
    return { wireProtocol: wireProtocol(envelope), envelope };
  } catch (error) {
    if (
      selectedProtocol === 1 ||
      !(error instanceof RbpFrameError) ||
      error.code !== "invalid_envelope"
    ) {
      throw error;
    }

    const candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame),
    ) as unknown;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      (candidate as Record<string, unknown>).v !== selectedProtocol
    ) {
      throw error;
    }

    const canonical = structuredClone(candidate) as Record<string, unknown>;
    canonical.v = 1;
    if (!validateRbpEnvelope(canonical)) {
      throw new RbpFrameError(
        "invalid_envelope",
        "RBP envelope validation failed after compatibility normalization",
        { validationErrors: [...rbpEnvelopeErrors()] },
      );
    }
    return {
      wireProtocol: selectedProtocol,
      envelope: canonical as unknown as RbpEnvelope,
    };
  }
}

/**
 * Serializes one canonical persisted envelope for its negotiated wire.
 * Callers retain the original RBP/1 object; only the emitted copy is adapted.
 */
export function serializeNegotiatedRbpEnvelope(
  envelope: RbpEnvelope,
  selectedProtocol: number,
): string {
  assertImplementedProtocolVersion(selectedProtocol);
  if (
    !("v" in envelope) ||
    envelope.v !== 1 ||
    !validateRbpEnvelope(envelope)
  ) {
    throw new TypeError("negotiated output must be a canonical RBP/1 envelope");
  }
  if (selectedProtocol === 1) return JSON.stringify(envelope);
  return JSON.stringify({ ...envelope, v: selectedProtocol });
}
