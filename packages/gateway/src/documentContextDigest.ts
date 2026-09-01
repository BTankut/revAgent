import { createHash } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

/**
 * Cross-runtime, diagnostic-only correlate for one admitted RBP document
 * context payload.  The C# worker emits the bare lower-case hexadecimal
 * value; the Gateway stores that form as well so neither side can silently
 * apply a second wire representation.
 *
 * RBP raw frame admission is deliberately outside this module. Production
 * ingress calls `parseRbpFrame`, whose recursive span parser rejects duplicate
 * object keys before this function ever sees a parsed value. A caller with
 * only `JSON.parse` output must not use this function as an admission check.
 */
export const DOCUMENT_CONTEXT_DIGEST_DOMAIN = "revagent:doc-context-payload:v1\n";
export const DOCUMENT_CONTEXT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export function isDocumentContextDigest(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_CONTEXT_DIGEST_PATTERN.test(value);
}

export function documentContextDigest(payload: JsonValue): string {
  const canonical = canonicalizeJson(payload);
  return createHash("sha256")
    .update(DOCUMENT_CONTEXT_DIGEST_DOMAIN, "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}
