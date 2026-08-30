import { createHash } from "node:crypto";

import { canonicalManifest } from "./manifest.js";
import { validateSchema } from "./schemas.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
import { stableJson } from "./stableJson.js";
import type {
  ArtifactEvidence,
  CaseEvidenceDocument,
  CaseResult,
  EvidenceAssertionRecord,
  ProcessObservationRecord,
  WireTraceRecord,
} from "./types.js";

function retained(relative: string): string {
  return `${canonicalManifest.retainedEvidence.root}/${relative}`;
}

async function artifact(
  store: SecureEvidenceStore,
  kind: ArtifactEvidence["kind"],
  relativePath: string,
  contents: string | Buffer,
  mediaType: string,
): Promise<ArtifactEvidence> {
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return await store.writeAccepted(relativePath, bytes, (candidate) => candidate.acceptExact({
    logicalPath: relativePath,
    absolutePath: store.resolve(relativePath),
    bytes,
    sha256,
  }, {
    kind,
    path: relativePath,
    sha256,
    bytes: bytes.length,
    mediaType,
  }));
}

function assertionRecord(assertion: CaseResult["assertions"][number]): EvidenceAssertionRecord {
  return {
    assertionId: assertion.assertionId,
    subvectorId: assertion.subvectorId,
    statement: assertion.statement,
    category: assertion.category,
    passed: assertion.passed === true,
    expected: structuredClone(assertion.expected),
    actual: structuredClone(assertion.actual),
    observationIds: [...assertion.observationIds],
  };
}

function assertCaseIdentity(
  result: CaseResult,
  observations: readonly ProcessObservationRecord[],
  runId: string,
): void {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === result.caseId);
  if (manifestCase === undefined) throw new Error(`cannot retain evidence for unknown case ${result.caseId}`);
  if (result.status !== "passed" && result.status !== "failed" && result.status !== "error") {
    throw new Error(`${result.caseId} must be terminal before evidence is retained`);
  }
  if (result.startedAt === null || result.finishedAt === null || result.durationMs === null) {
    throw new Error(`${result.caseId} must have a complete interval before evidence is retained`);
  }
  const startedAt = Date.parse(result.startedAt);
  const finishedAt = Date.parse(result.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt - startedAt !== result.durationMs) {
    throw new Error(`${result.caseId} has an invalid interval`);
  }
  if (observations.length === 0) throw new Error(`${result.caseId} has no parent observations`);
  const ids = new Set<string>();
  for (const observation of observations) {
    if (observation.runId !== runId || observation.caseId !== result.caseId) {
      throw new Error(`${observation.observationId} is outside ${runId}/${result.caseId}`);
    }
    if (!manifestCase.bindings.includes(observation.binding)) {
      throw new Error(`${observation.observationId} has an unexpected binding`);
    }
    if (ids.has(observation.observationId)) {
      throw new Error(`duplicate retained observation id ${observation.observationId}`);
    }
    ids.add(observation.observationId);
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at) || at < startedAt || at > finishedAt) {
      throw new Error(`${observation.observationId} falls outside the case interval`);
    }
  }
  for (const assertion of result.assertions) {
    if (assertion.observationIds.length === 0 ||
      assertion.observationIds.some((observationId) => !ids.has(observationId))) {
      throw new Error(`${assertion.assertionId} does not resolve to retained observations`);
    }
  }
}

function caseDocument(input: {
  runId: string;
  result: CaseResult;
  source: CaseEvidenceDocument["source"];
  observations: readonly ProcessObservationRecord[];
}): CaseEvidenceDocument {
  return {
    schemaVersion: "rbp-case-evidence/v2",
    runId: input.runId,
    caseId: input.result.caseId,
    source: input.source,
    evaluationOwner: "parent_runner",
    observations: input.observations.map((observation) => structuredClone(observation)),
    evaluations: input.result.assertions.map(assertionRecord),
  };
}

/**
 * Atomically retain all per-case artifacts and bind every assertion to the
 * parent-evidence document digest. The caller owns the semantic verdict; this
 * writer only validates identity, intervals, references, and bytes.
 */
export async function retainSupervisedCaseEvidence(input: {
  artifactRoot: string;
  runId: string;
  result: CaseResult;
  observations: readonly ProcessObservationRecord[];
}): Promise<ArtifactEvidence[]> {
  assertCaseIdentity(input.result, input.observations, input.runId);
  const store = new SecureEvidenceStore(input.artifactRoot);
  const evidenceDocument = caseDocument({ ...input, source: "case_evidence" });
  const evidenceIssues = validateSchema("caseEvidenceV2", evidenceDocument);
  if (evidenceIssues.length > 0) {
    throw new Error(`parent case evidence is invalid: ${stableJson(evidenceIssues)}`);
  }
  const evidencePath = retained(`runs/${input.runId}/cases/${input.result.caseId}/supervised-evidence-v2.json`);
  const evidenceArtifact = await artifact(
    store,
    "case_evidence",
    evidencePath,
    stableJson(evidenceDocument),
    "application/json",
  );

  const journalDocument = caseDocument({ ...input, source: "journal_snapshot" });
  const journalIssues = validateSchema("caseEvidenceV2", journalDocument);
  if (journalIssues.length > 0) {
    throw new Error(`parent journal evidence is invalid: ${stableJson(journalIssues)}`);
  }
  const journalArtifact = await artifact(
    store,
    "journal_snapshot",
    retained(`runs/${input.runId}/journal/${input.result.caseId}.json`),
    stableJson(journalDocument),
    "application/json",
  );

  const wireArtifacts: ArtifactEvidence[] = [];
  for (const { binding } of input.result.bindings) {
    const trace: WireTraceRecord = {
      schemaVersion: "rbp-wire-trace/v1",
      runId: input.runId,
      caseId: input.result.caseId,
      binding,
      event: "parent_supervised_binding_terminal",
      at: input.result.finishedAt!,
      status: input.result.status,
      assertions: [],
    };
    wireArtifacts.push(await artifact(
      store,
      "wire_trace",
      retained(`runs/${input.runId}/wire/${input.result.caseId}-${binding}.jsonl`),
      `${JSON.stringify(trace)}\n`,
      "application/x-ndjson",
    ));
  }

  input.result.assertions.forEach((assertion) => {
    assertion.evidenceSha256 = evidenceArtifact.sha256;
  });
  const retainedArtifacts = [evidenceArtifact, journalArtifact, ...wireArtifacts];
  input.result.artifacts.push(...retainedArtifacts);
  return retainedArtifacts.map((entry) => structuredClone(entry));
}
