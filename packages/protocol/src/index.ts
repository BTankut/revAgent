export type * from "./generated/envelope.js";
export {
  parseRbpFrame,
  RBP_MAX_CONTROL_FRAME_BYTES,
  RBP_MAX_DOC_CONTEXT_FRAME_BYTES,
  RBP_MAX_INLINE_RESULT_BYTES,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  RbpFrameError,
  type RbpFrameErrorCode,
} from "./parseFrame.js";
export {
  canonicalizeJson,
  makeBatchDigest,
  makeParamsDigest,
  type BatchDigestInput,
  type BatchDigestStep,
  type JsonValue,
} from "./paramsDigest.js";
export {
  RBP_RECONNECT_CAP_MS,
  RBP_RECONNECT_FACTOR,
  RBP_RECONNECT_INITIAL_MS,
  RBP_RECONNECT_RESET_AFTER_STEADY_MS,
  reconnectBackoffLimitMs,
  reconnectFullJitterDelayMs,
  shouldResetReconnectBackoff,
} from "./reconnectBackoff.js";
export { validateRbpEnvelope, rbpEnvelopeErrors } from "./validateEnvelope.js";

export const RBP_PROTOCOL_VERSION = 1 as const;
export const RBP_SPEC_DRAFT_VERSION = "1.0-rc.1" as const;

export function makeIdempotencyKey(rsid: string, invocationId: string): string {
  if (rsid.length === 0 || invocationId.length === 0) {
    throw new Error("rsid and invocationId are required");
  }

  return `${rsid}/${invocationId}`;
}
