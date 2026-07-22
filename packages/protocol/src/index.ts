export type { RbpEnvelope } from "./generated/envelope.js";
export { validateRbpEnvelope, rbpEnvelopeErrors } from "./validateEnvelope.js";

export const RBP_PROTOCOL_VERSION = 1 as const;
export const RBP_SPEC_DRAFT_VERSION = "0.9" as const;

export function makeIdempotencyKey(rsid: string, invocationId: string): string {
  if (rsid.length === 0 || invocationId.length === 0) {
    throw new Error("rsid and invocationId are required");
  }

  return `${rsid}/${invocationId}`;
}
