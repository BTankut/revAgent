import manifestJson from "../manifest/v1.0-rc.1.json" with { type: "json" };
import type { ConformanceManifest, ManifestIdentity, ValidationIssue } from "./types.js";
import { sha256Json } from "./stableJson.js";
import { validateSchema } from "./schemas.js";

export const EXPECTED_CASE_TITLES = [
  "Authenticated hello/version/capability negotiation",
  "Version mismatch with manifest pointer and bounded reconnect behavior",
  "Revoked device credential refusal",
  "Multi-session discovery through bounded scan; explicit proof that no temp registry file is read",
  "Registration and context snapshot",
  "Heartbeat transitions at 35/65 seconds and reconnect on missing acknowledgement",
  "Gateway restart plus session resume and bidirectional retransmission",
  "Terminal journal replay with exactly one add-in execution",
  "Indeterminate mutating invocation returns journal_indeterminate with zero re-executions",
  "Indeterminate read invocation executes at most once more",
  "Canonical-key params-digest mismatch fails as protocol",
  "Authoritative window=1 rejection on one rsid, with parallel success across two rsid values",
  "Proof that normal invokes do not send mcp_status preflight traffic",
  "Failure enrichment using mcp_status after a simulated busy/timeout path",
  "Ordered chunking, digest verification, progress, and backpressure",
  "Params/result oversize rejection at the correct boundary",
  "Cancellation with late real outcome preserved in the journal",
  "Error mapping for method-not-found, invalid params, add-in exception, guarded result, and failure-shaped result",
  "Exact 4-byte big-endian add-in framing vectors, including split/coalesced reads and the former 8192-byte case",
  "atomic:false batch fan-out and failure index",
  "atomic:true rejection without batch_atomic",
  "atomic:true one-frame execute_batch success/rollback with batch_atomic",
  "get_document_context propagation within 15 seconds without ExternalEvent polling",
  "Duplicate/reordered data-frame handling across reconnect",
  "Cross-device/cross-rsid resume and invocation authorization negatives",
  "Gateway N/N-1 compatibility plus within-version additive-change vectors",
  "Reconnect full-jitter bounds, 60-second cap, and reset only after 120 seconds continuously steady",
  "Pending-expiry mutation installs the (rsid,mutation_scope) conflict hold; fresh-id invoke and batch writes are blocked; correlated read and late-terminal evidence exercise every retained/cleared transition and an invalid or inconclusive clearance never opens dispatch",
  "Mixed terminal/non-terminal atomic:false batch redelivery plus atomic terminal replay/indeterminate recovery; every nested error carries explicit outcome/verification fields and affected scope holds",
  "RFC 8785 params_digest, explicit per-step digest, and batch_digest golden vectors cover property order, number formatting, Unicode, escapes, step omission, params/digest mismatch, and changed policy/scope/clearance",
  "heartbeat_ack, registration/unregistration/resume, cancel, goodbye, and manifest payload-schema positive/negative vectors",
  "Chunk Base64 alphabet/padding, per-stream identity/indexing, decoded-byte limits, reconstruction size, and decoded-content digest",
  "Loopback-only discovery/connect rejection for wildcard, LAN, hostname-resolved remote, and override targets",
  "Session document-schema and seat/user spoof rejection against authenticated enrollment",
  "Maximum-safe seq acceptance, unsafe 2^53 rejection, no-wrap renewal, duplicate, and gap behavior",
  "WSS-primary and the exact Streamable HTTP/SSE create/events/messages lifecycle produce identical journal/resume outcomes, including opening-error and proxy-buffering vectors",
  "Every session_unregister reason revokes resume, prevents new dispatch, and preserves a possibly dispatched mutation as indeterminate",
  "status:\"guarded\" requires a valid guarded_reason; first-delivery atomic:false stops on that guarded step and marks all successors not_started",
  "payload_omitted positive/negative vectors enforce replay-only use, required digest, absent result, and audited read-based recovery",
  "GAP-7 RBP artifact vectors reject raw/local/traversal/reparse paths and prove multi-file artifact_id/artifact_index mapping, independent chunk streams, descriptor/digest/size verification, retransmission identity, and all-or-nothing invalid-member rejection; no north-client claim is made",
] as const;

const EXPECTED_ASSERTION_COUNTS = [
  3, 2, 1, 2, 2, 3, 4, 2, 2, 1,
  1, 2, 1, 3, 4, 2, 2, 5, 4, 2,
  2, 3, 2, 2, 3, 4, 4, 7, 6, 12,
  14, 7, 5, 3, 5, 6, 12, 4, 5, 13,
] as const;

function semanticManifestIssues(value: ConformanceManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const assertionIds = new Set<string>();
  const requiredComponentIds = value.requiredComponents.map(({ id }) => id);
  const assertionCaseIds = Object.keys(value.requiredAssertions);

  if (assertionCaseIds.join(",") !== value.cases.map(({ id }) => id).join(",")) {
    issues.push({ path: "/requiredAssertions", code: "manifest.assertion_case_order", message: "required assertion keys must exactly match the ordered case catalog" });
  }

  if (new Set(requiredComponentIds).size !== 3) {
    issues.push({ path: "/requiredComponents", code: "manifest.components", message: "required component ids must be unique" });
  }

  value.cases.forEach((entry, index) => {
    const ordinal = index + 1;
    const expectedId = `O1-C${String(ordinal).padStart(2, "0")}`;
    if (entry.id !== expectedId || entry.ordinal !== ordinal) {
      issues.push({ path: `/cases/${index}`, code: "manifest.order", message: `expected ${expectedId} at ordinal ${ordinal}` });
    }
    if (ids.has(entry.id)) {
      issues.push({ path: `/cases/${index}/id`, code: "manifest.duplicate_case", message: `duplicate case ${entry.id}` });
    }
    ids.add(entry.id);
    if (entry.title !== EXPECTED_CASE_TITLES[index]) {
      issues.push({ path: `/cases/${index}/title`, code: "manifest.title", message: `title does not match spec section 21 case ${ordinal}` });
    }
    if (entry.requiredComponents.join(",") !== "gateway_stub,bridge_simulator,addin_loopback_fixture") {
      issues.push({ path: `/cases/${index}/requiredComponents`, code: "manifest.components", message: "case must require T3/T4/T5 components" });
    }
    if (entry.bindings.join(",") !== "wss,streamable_http_sse") {
      issues.push({ path: `/cases/${index}/bindings`, code: "manifest.bindings", message: "case must run against both Phase-1 RBP bindings" });
    }

    const requiredAssertions = value.requiredAssertions[entry.id] ?? [];
    if (requiredAssertions.length !== EXPECTED_ASSERTION_COUNTS[index]) {
      issues.push({ path: `/requiredAssertions/${entry.id}`, code: "manifest.assertion_count", message: `case requires exactly ${EXPECTED_ASSERTION_COUNTS[index]} canonical assertions` });
    }
    const subvectorIds = new Set<string>();
    requiredAssertions.forEach((assertion, assertionIndex) => {
      const base = `/requiredAssertions/${entry.id}/${assertionIndex}`;
      if (!assertion.id.startsWith(`${entry.id}-`)) {
        issues.push({ path: `${base}/id`, code: "manifest.assertion_case", message: `assertion id must be namespaced by ${entry.id}` });
      }
      if (assertionIds.has(assertion.id)) {
        issues.push({ path: `${base}/id`, code: "manifest.duplicate_assertion", message: `duplicate assertion id ${assertion.id}` });
      }
      assertionIds.add(assertion.id);
      if (subvectorIds.has(assertion.subvectorId)) {
        issues.push({ path: `${base}/subvectorId`, code: "manifest.duplicate_subvector", message: `duplicate sub-vector ${assertion.subvectorId} in ${entry.id}` });
      }
      subvectorIds.add(assertion.subvectorId);
      if (!entry.assertionCategories.includes(assertion.category)) {
        issues.push({ path: `${base}/category`, code: "manifest.assertion_category", message: "canonical assertion category must be declared by its case" });
      }
      if (assertion.expected !== true) {
        issues.push({ path: `${base}/expected`, code: "manifest.assertion_expected", message: "canonical assertion expected semantics must be true" });
      }
    });
  });

  return issues;
}

const schemaIssues = validateSchema("manifest", manifestJson);
const candidate = manifestJson as ConformanceManifest;
const manifestIssues = [...schemaIssues, ...semanticManifestIssues(candidate)];

if (manifestIssues.length > 0) {
  throw new Error(`Invalid canonical conformance manifest: ${manifestIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
}

export const canonicalManifest: ConformanceManifest = candidate;
export const canonicalManifestSha256 = sha256Json(canonicalManifest);
export const canonicalManifestIdentity: ManifestIdentity = {
  id: canonicalManifest.manifestId,
  version: canonicalManifest.manifestVersion,
  sha256: canonicalManifestSha256,
  specVersion: canonicalManifest.spec.version,
};

export function validateCanonicalManifest(value: unknown): ValidationIssue[] {
  const issues = validateSchema("manifest", value);
  return issues.length > 0 ? issues : semanticManifestIssues(value as ConformanceManifest);
}
