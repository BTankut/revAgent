import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@revagent/protocol";

import {
  coherentC39RecoveryAudit,
  coherentDocumentContextAudit,
  conformanceConnectionCapabilitiesForBinding,
  createProductionConformanceRecoveryAuthority,
  createOrderedConformanceHostShutdown,
  MAX_DOCUMENT_CONTEXT_OBSERVATIONS,
  MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES,
  runProductionConformanceHostCli,
  validateConformanceDeviceProvision,
  type DocumentContextObservationSnapshot,
} from "./productionConformanceHostCli.js";
import { GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE } from "./omittedPayloadRecovery.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { GATEWAY_RECOVERY_NAMESPACE } from "./recoveryAuthority.js";
import type { MutationProbeVerificationWorkflow } from "./productionConformanceVerification.js";
import { GATEWAY_AUTH_CONTRACT_VERSION, type AuthContext } from "./authContext.js";
import { GatewayDispatcher, type GatewayExecutor } from "./dispatch.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { GatewayToolRegistry, M2_BOOTSTRAP_TOOL_RECORDS } from "./registry.js";
import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  SqliteConformanceProtocolStore,
  createConformanceSupportingPorts,
} from "./conformanceEphemeralAdapters.js";
import {
  buildSessionHistoryPagePlan,
  GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
  sessionCanonicalDigest,
  type SessionHistoryEntry,
  type SessionTreeKind,
} from "./sessionHistoryStore.js";

const epoch = "123e4567-e89b-42d3-a456-426614174000";
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const contextDigest = "c".repeat(64);
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  rsidHash: digest("a"), observedSequence: 7, contextDigest,
  routeDigest: digest("b"), recordDigest: digest("d"),
  sessionBindingDigest: digest("e"), connectionDigest: digest("f"),
  sessionRecordVersion: 9, ...overrides,
});
const observation: DocumentContextObservationSnapshot["rows"][number] = Object.freeze({ stage: "accepted" as const, sequence: 7, contextDigest,
  ordinal: 2, observedAtUtc: "2026-08-24T00:00:00.000Z" });
const snapshot = (rows: DocumentContextObservationSnapshot["rows"] = [observation], highWaterOrdinal = 2, processEpoch = epoch): DocumentContextObservationSnapshot =>
  Object.freeze({ processEpoch, highWaterOrdinal, rows: Object.freeze(rows) });

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("WP-12 exact route-rebind conformance provisioning", () => {
  it.each([
    ["wss", ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1"]],
    ["streamable_http_sse", ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1", "transport_streamable_http"]],
  ] as const)("requires only the exact %s connection grant set", (binding, expected) => {
    expect(conformanceConnectionCapabilitiesForBinding(binding)).toEqual(expected);
    expect(validateConformanceDeviceProvision({
      binding,
      connectionCapabilities: expected,
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    })).toEqual({
      binding,
      connectionCapabilities: expected,
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
    expect(validateConformanceDeviceProvision({
      binding,
      connectionCapabilities: expected.filter((capability) => capability !== "route_rebind_proof_v1"),
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    })).toBeNull();
    expect(validateConformanceDeviceProvision({
      binding,
      connectionCapabilities: [...expected, "unapproved_extra"],
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    })).toBeNull();
  });
});

describe("WP-12 C39 observed recovery audit", () => {
  const origin = "0197a3c2-0000-7000-8000-000000000901";
  const recovery = "0197a3c2-0000-7000-8000-000000000902";
  const binding = "0197a3c2-0000-7000-8000-000000000903";
  const owner = Object.freeze({ tenantId: "conformance", userId: "user", principalKey: "principal",
    effectiveMcpSessionId: "mcp", sessionBindingId: binding, sessionBindingVersion: 1,
    rsid: "rsid", recoveryInvocationId: recovery, originInvocationId: origin,
    originResultDigest: digest("a") });
  type AuditFixtureRecord = { namespace: string; key: string; value: unknown; version: number };
  const routeAuthority = Object.freeze({
    version: 1,
    provenance: "session_resume_route_rebind_v1",
    routeAuthorityCheckpoint: digest("1"),
    connectionDigest: digest("2"),
    serverProofDigest: digest("3"),
    authorityGenerationDigest: digest("4"),
    resultantSessionBindingId: binding,
    resultantSessionVersion: 1,
    proofCasRecordVersion: 1,
  });
  const lane = (treeKind: SessionTreeKind, values: readonly JsonValue[]) =>
    buildSessionHistoryPagePlan({
      tenantId: "conformance",
      rsid: "rsid",
      treeKind,
      entries: values.map((value, index): SessionHistoryEntry => ({
        key: String(index).padStart(12, "0"),
        value,
      })),
    });
  const rootRow = (records: AuditFixtureRecord[]) => records.find((row) =>
    row.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE)!;
  const pageRow = (records: AuditFixtureRecord[], treeKind: SessionTreeKind) => records.find((row) =>
    row.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE &&
    (row.value as Record<string, unknown>).treeKind === treeKind)!;
  const refreshV3 = (records: AuditFixtureRecord[]): AuditFixtureRecord[] => {
    const rootRecord = rootRow(records);
    const root = rootRecord.value as Record<string, unknown>;
    for (const pageRecord of records.filter((row) => row.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE)) {
      const page = pageRecord.value as Record<string, unknown>;
      if (Array.isArray(page.entries)) {
        page.entries = page.entries.map((entry) => ({
          ...(entry as Record<string, unknown>),
          digest: sessionCanonicalDigest((entry as Record<string, unknown>).value as JsonValue),
        }));
      }
    }
    root.trees = (root.trees as Record<string, unknown>[]).map((tree) => {
      if (tree.root === null) return tree;
      const page = pageRow(records, tree.treeKind as SessionTreeKind);
      const value = page.value as Record<string, unknown>;
      const entries = value.entries as Record<string, unknown>[];
      return {
        ...tree,
        entryCount: entries.length,
        root: {
          ...(tree.root as Record<string, unknown>),
          version: page.version,
          digest: sessionCanonicalDigest(value as JsonValue),
          firstKey: entries[0]!.key,
          lastKey: entries.at(-1)!.key,
          count: entries.length,
        },
      };
    });
    const marker = records.find((row) =>
      row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE)!;
    marker.value = {
      ...(marker.value as Record<string, unknown>),
      rootVersion: root.rootVersion,
      rootDigest: sessionCanonicalDigest(root as JsonValue),
      treesDigest: sessionCanonicalDigest(root.trees as JsonValue),
    };
    return records;
  };
  const replaceLane = (
    records: AuditFixtureRecord[],
    treeKind: SessionTreeKind,
    values: readonly JsonValue[],
  ): AuditFixtureRecord[] => {
    const plan = lane(treeKind, values);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const row = records[index]!;
      if (row.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE &&
          (row.value as Record<string, unknown>).treeKind === treeKind) records.splice(index, 1);
    }
    records.push(...plan.pages.map((page) => ({
      namespace: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
      key: page.key,
      version: 1,
      value: structuredClone(page.value),
    })));
    const root = rootRow(records).value as Record<string, unknown>;
    root.trees = (root.trees as Record<string, unknown>[]).map((tree) =>
      tree.treeKind === treeKind ? structuredClone(plan.tree) : tree);
    return refreshV3(records);
  };
  /** A real v3 projection: root+marker authenticate immutable evidence/receipt pages. */
  const observed = (overrides: Record<string, unknown> = {}) => {
    const originEvidence = { terminalInvocationId: origin, terminalSessionBindingId: binding, terminalSessionVersion: 1,
        effectiveMcpSessionId: "mcp", payloadOmittedRecoveryEvidenceVersion: 1, payloadOmittedRecoveryEligible: true,
        terminalDigest: digest("b"), terminalCarrierDigest: digest("d"),
        terminalTruth: { state: "completed", resultDigest: digest("a"), payloadRetained: false } };
    const recoveryEvidence = { terminalInvocationId: recovery, terminalSessionBindingId: binding, terminalSessionVersion: 1,
        effectiveMcpSessionId: "mcp", terminalDigest: digest("e"), terminalCarrierDigest: digest("b"),
        c39RouteAuthority: routeAuthority,
        terminalTruth: { state: "completed", resultDigest: digest("a"), payloadRetained: true } };
    const plans = [
      lane("evidence", [originEvidence, recoveryEvidence] as unknown as JsonValue[]),
      lane("receipts", [{ seq: 4, immutableDigest: digest("f") }, { seq: 5, immutableDigest: digest("b") }]),
      lane("outbox", []), lane("pending", []), lane("indices", []),
    ];
    const root = {
      schema: GATEWAY_RBP_SESSION_V3_NAMESPACE, generation: 3, rootVersion: 7,
      tenantId: "conformance", rsid: "rsid", identity: { userId: "user" },
      binding: { sessionBindingId: "0197a3c2-0000-7000-8000-000000000904", sessionVersion: 6 },
      lifecycle: {}, sequenceHead: { sequence: { rsid: "rsid", lastRxSeq: 5 } },
      migrationProof: { sourceGeneration: 2, sourceDigest: digest("5"), equivalenceDigest: digest("6"),
        targetPlanDigest: digest("7"), sourceCleanupReceiptDigest: digest("8") },
      durabilityProfile: {}, trees: plans.map((plan) => plan.tree).sort((left, right) => left.treeKind.localeCompare(right.treeKind)),
      singletonRefs: [], antiDowngradeRefs: [], retentionClosure: null,
      retiredAuthorityDigest: null, completionDigest: null,
    };
    const records: AuditFixtureRecord[] = [
      { namespace: GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE, key: origin, version: 1, value: {
        schema: GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE, recordVersion: 1, tenantId: "conformance",
        owner: { userId: "user", effectiveMcpSessionId: "mcp", rsid: "rsid", sessionBindingId: binding, sessionVersion: 1 },
        originInvocationId: origin, originResultDigest: digest("a"), carrierRecoveryInvocationId: recovery,
        terminalEvidenceDigest: digest("b"), state: "completed", expiresAtMs: 1000,
        resultReferenceDigest: digest("c"), createdAtMs: 1, updatedAtMs: 2,
      } },
      { namespace: "gateway.recovery-chunk/v1", key: "chunk", version: 1, value: { schemaVersion: "revagent-gateway-recovery/v1", state: "active", owner,
        bridgeSequence: 4, chunkIndex: 0, kid: "kid", storageKey: digest("d"), plainDigest: digest("e"), resultRefDigest: digest("c"), plainLength: 3, expiresAtMs: 1000 } },
      { namespace: "gateway.recovery-completion/v1", key: "completion", version: 1, value: { schemaVersion: "revagent-gateway-recovery/v1", state: "active", owner,
        refId: "ref", expiresAtMs: 1000, activatedSessionBindingId: binding, activatedSessionBindingVersion: 1 } },
      { namespace: "gateway_resource_v1", key: "resource", version: 1, value: { kind: "result_ref", refId: "ref", digest: digest("c"), expiresAtMs: 1000, lifecycle: "active", byteSize: 3,
        protectedRecovery: { schemaVersion: "revagent-gateway-recovery/v1", owner, kid: "kid", storageKey: digest("d"), plainDigest: digest("a"), resultRefDigest: digest("c"), plainLength: 3, bridgeSequence: 4, chunkIndex: 1, activatedSessionBindingId: binding, activatedSessionBindingVersion: 1 } } },
      { namespace: GATEWAY_RBP_SESSION_V3_NAMESPACE, key: "rsid", version: 7, value: root },
      { namespace: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, key: "rsid", version: 1, value: {
        schema: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, generation: 3, tenantId: "conformance",
        rsid: "rsid", rootVersion: 7, rootDigest: sessionCanonicalDigest(root as JsonValue),
        treesDigest: sessionCanonicalDigest(root.trees as JsonValue), migratedAtMs: 1,
      } },
      ...plans.flatMap((plan) => plan.pages.map((page) => ({
        namespace: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
        key: page.key,
        version: 1,
        value: page.value,
      }))),
      ...Object.entries(overrides).map(([namespace, value]) => ({ namespace, key: `extra-${namespace}`, version: 1, value })),
    ];
    return records;
  };
  const multiObserved = (): Array<{ namespace: string; key: string; value: unknown; version: number }> => {
    const records: Array<{ namespace: string; key: string; value: unknown; version: number }> = structuredClone(observed());
    const chunk = records.find((row) => row.namespace === "gateway.recovery-chunk/v1")!;
    const chunkValue = chunk.value as Record<string, unknown>;
    chunk.value = { ...chunkValue, plainLength: 2 };
    const resource = records.find((row) => row.namespace === "gateway_resource_v1")!;
    const resourceValue = resource.value as Record<string, unknown>;
    resource.value = { ...resourceValue, byteSize: 3, protectedRecovery: {
      ...(resourceValue.protectedRecovery as Record<string, unknown>), plainLength: 3,
      bridgeSequence: 6, chunkIndex: 2,
    } };
    const session = rootRow(records);
    const sessionValue = session.value as Record<string, unknown>;
    const sequenceHead = sessionValue.sequenceHead as Record<string, unknown>;
    session.value = { ...sessionValue, sequenceHead: { ...sequenceHead, sequence: {
      ...(sequenceHead.sequence as Record<string, unknown>), lastRxSeq: 7,
    } } };
    replaceLane(records, "receipts", [
      { seq: 4, immutableDigest: digest("f") }, { seq: 5, immutableDigest: digest("d") },
      { seq: 6, immutableDigest: digest("a") }, { seq: 7, immutableDigest: digest("b") },
    ]);
    records.push(
      { namespace: "gateway.recovery-chunk/v1", key: "chunk-1", version: 1, value: {
        ...chunkValue, bridgeSequence: 6, chunkIndex: 1, plainDigest: digest("f"), plainLength: 1,
      } },
      { namespace: "gateway.carrier-ack/v1", key: "ack-1", version: 1, value: {
        schemaVersion: "revagent-gateway-carrier/v1", rsid: "rsid", invocationId: recovery,
        tenantId: "conformance", effectiveMcpSessionId: "mcp", seq: 6, state: "chunk_durable",
      } },
    );
    return refreshV3(records);
  };

  it("emits one redacted row only for one fully correlated active recovery", () => {
    const result = coherentC39RecoveryAudit({ records: observed(), nowMs: 10 });
    expect(result.status).toBe("joined");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ state: "active", originDigest: digest("a"), resultRefDigest: digest("c"), partials: [{ seq: 4, chunkIndex: 0, plainDigest: digest("e"), byteLength: 3, state: "active" }], terminal: { seq: 5, originDigest: digest("a"), state: "completed" } });
    expect(result.rows[0]).toMatchObject({
      recoveryIdHash: "sha256:eda0e151b2ab8886f85b740e68a9ff27519a32e10b958d19af9df687648bd2ca",
      originIdHash: "sha256:c737914ebf0c9eff1380d927d640ec613d0005a7194476553a514e720acddbf5",
    });
    expect(result.rows[0]?.recoveryIdHash).not.toBe("sha256:b95a6f59a1a53cd600feaa7253c02e9972ac7a628fd1cdb88f1342eed59aa32e");
    expect(JSON.stringify(result.rows)).not.toContain('"rsid"');
    expect(JSON.stringify(result.rows)).not.toContain("principal");
    expect(JSON.stringify(result.rows)).not.toContain("kid");
    expect(JSON.stringify(result.rows)).not.toContain(origin);
    expect(JSON.stringify(result.rows)).not.toContain(recovery);
  });

  it("fails closed for partial, ambiguous, expired, or cross-owner joins", () => {
    const partial = observed().filter((row) => row.namespace !== "gateway.recovery-chunk/v1");
    expect(coherentC39RecoveryAudit({ records: partial, nowMs: 10 }).rows).toHaveLength(0);
    const ambiguous = [...observed(), observed().find((row) => row.namespace === "gateway.recovery-completion/v1")!];
    expect(coherentC39RecoveryAudit({ records: ambiguous, nowMs: 10 }).rows).toHaveLength(0);
    const expired = observed().map((row) => row.namespace === "gateway.recovery-completion/v1"
      ? { ...row, value: { ...(row.value as Record<string, unknown>), expiresAtMs: 10 } } : row);
    expect(coherentC39RecoveryAudit({ records: expired, nowMs: 10 }).rows).toHaveLength(0);
    const foreign = observed().map((row) => row.namespace === "gateway.recovery-chunk/v1"
      ? { ...row, value: { ...(row.value as Record<string, unknown>), owner: { ...owner, userId: "other" } } } : row);
    expect(coherentC39RecoveryAudit({ records: foreign, nowMs: 10 }).rows).toHaveLength(0);
    const forgedAck = [...observed(), { namespace: "gateway.carrier-ack/v1", key: "forged", version: 1,
      value: { schemaVersion: "revagent-gateway-carrier/v1", rsid: "rsid", invocationId: recovery, seq: 4, state: "chunk_durable" } }];
    expect(coherentC39RecoveryAudit({ records: forgedAck, nowMs: 10 }).status).toBe("joined");
    const wrongDigest = observed().map((row) => row.namespace === "gateway_resource_v1"
      ? { ...row, value: { ...(row.value as Record<string, unknown>), protectedRecovery: { ...((row.value as Record<string, unknown>).protectedRecovery as Record<string, unknown>), plainDigest: digest("f") } } } : row);
    expect(coherentC39RecoveryAudit({ records: wrongDigest, nowMs: 10 }).rows).toHaveLength(0);
    const wrongRef = observed().map((row) => row.namespace === "gateway.recovery-completion/v1"
      ? { ...row, value: { ...(row.value as Record<string, unknown>), refId: "other" } } : row);
    expect(coherentC39RecoveryAudit({ records: wrongRef, nowMs: 10 }).rows).toHaveLength(0);
  });

  it("fails closed on normalized child proof or immutable inbound correlation breaks", () => {
    const invalid = (records: ReturnType<typeof observed>) =>
      expect(coherentC39RecoveryAudit({ records, nowMs: 10 }).status).toBe("no_coherent_row");
    const withRoot = (records: ReturnType<typeof observed>, mutate: (value: Record<string, unknown>) => Record<string, unknown>) =>
      records.map((row) => row.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE
        ? { ...row, value: mutate(row.value as Record<string, unknown>) }
        : row).map((row, _index, next) => row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE
          ? { ...row, value: { ...(row.value as Record<string, unknown>),
              rootDigest: sessionCanonicalDigest(rootRow(next).value as JsonValue),
              treesDigest: sessionCanonicalDigest((rootRow(next).value as Record<string, unknown>).trees as JsonValue) } }
          : row);
    const versionMismatch = withRoot(observed(), (value) => ({ ...value, trees: (value.trees as Record<string, unknown>[]).map((tree) =>
      tree.treeKind === "evidence" ? { ...tree, root: { ...(tree.root as Record<string, unknown>), version: 99 } } : tree) }));
    invalid(versionMismatch);
    const digestMismatch = withRoot(observed(), (value) => ({ ...value, trees: (value.trees as Record<string, unknown>[]).map((tree) =>
      tree.treeKind === "evidence" ? { ...tree, root: { ...(tree.root as Record<string, unknown>), digest: digest("a") } } : tree) }));
    invalid(digestMismatch);
    const originPage = pageRow(observed(), "evidence");
    const unreferencedDuplicate = [...observed(), { ...originPage,
      key: "rsid/evidence/p-unreferenced", version: 5,
      value: { ...(originPage.value as Record<string, unknown>), pageId: "p-unreferenced" } }];
    invalid(unreferencedDuplicate);
    const duplicateChildRef = withRoot(observed(), (value) => {
      const trees = value.trees as Record<string, unknown>[];
      return { ...value, trees: [...trees, trees.find((tree) => tree.treeKind === "evidence")!] };
    });
    invalid(duplicateChildRef);
    const mismatchedTerminal = structuredClone(observed());
    const evidencePage = pageRow(mismatchedTerminal, "evidence");
    const evidenceEntries = (evidencePage.value as Record<string, unknown>).entries as Record<string, unknown>[];
    const originEntry = evidenceEntries.find((entry) =>
      ((entry.value as Record<string, unknown>).terminalInvocationId) === origin)!;
    originEntry.value = { ...(originEntry.value as Record<string, unknown>), terminalInvocationId: recovery };
    invalid(refreshV3(mismatchedTerminal));
    const missingInbound = replaceLane(structuredClone(observed()), "receipts", [
      { seq: 5, immutableDigest: digest("b") },
    ]);
    invalid(missingInbound);
    const duplicateInbound = replaceLane(structuredClone(observed()), "receipts", [
      { seq: 4, immutableDigest: digest("f") }, { seq: 5, immutableDigest: digest("b") },
      { seq: 4, immutableDigest: digest("c") },
    ]);
    invalid(duplicateInbound);
    const terminalDigestMismatch = replaceLane(structuredClone(observed()), "receipts", [
      { seq: 4, immutableDigest: digest("f") }, { seq: 5, immutableDigest: digest("c") },
    ]);
    invalid(terminalDigestMismatch);
    const resourceBridgeSeqMismatch = observed().map((row) => row.namespace === "gateway_resource_v1" ? { ...row, value: {
      ...(row.value as Record<string, unknown>), protectedRecovery: { ...((row.value as Record<string, unknown>).protectedRecovery as Record<string, unknown>), bridgeSequence: 5 },
    } } : row);
    invalid(resourceBridgeSeqMismatch);
    expect(rootRow(observed()).version).toBe(7);
  });

  it("sorts valid shuffled partials deterministically and rejects every sequence/index invariant break", () => {
    const valid = multiObserved();
    const shuffled = [...valid].reverse();
    const expected = coherentC39RecoveryAudit({ records: valid, nowMs: 10 });
    const actual = coherentC39RecoveryAudit({ records: shuffled, nowMs: 10 });
    expect(expected).toEqual(actual);
    expect(expected.rows[0]).toMatchObject({ partials: [
      { seq: 4, chunkIndex: 0, plainDigest: digest("e"), byteLength: 2, state: "active" },
      { seq: 6, chunkIndex: 1, plainDigest: digest("f"), byteLength: 1, state: "active" },
    ], terminal: { seq: 7, originDigest: digest("a"), state: "completed" } });
    const invalid = (records: Array<{ namespace: string; key: string; value: unknown; version: number }>) =>
      expect(coherentC39RecoveryAudit({ records, nowMs: 10 }).status).toBe("no_coherent_row");
    const secondChunk = valid.find((row) => row.key === "chunk-1")!;
    invalid(valid.map((row) => row.key === "chunk-1" ? { ...row, value: { ...(row.value as Record<string, unknown>), chunkIndex: 2 } } : row));
    invalid([...valid, { ...secondChunk, key: "duplicate-same" }]);
    invalid([...valid, { ...secondChunk, key: "duplicate-digest", value: { ...(secondChunk.value as Record<string, unknown>), plainDigest: digest("d") } }]);
    invalid(valid.map((row) => row.key === "chunk-1" ? { ...row, value: { ...(row.value as Record<string, unknown>), bridgeSequence: 4 } } : row));
    invalid(valid.map((row) => row.key === "chunk-1" ? { ...row, value: { ...(row.value as Record<string, unknown>), bridgeSequence: 3 } } : row));
    const shortHead = structuredClone(valid);
    const shortRoot = rootRow(shortHead);
    const shortValue = shortRoot.value as Record<string, unknown>;
    const shortSequenceHead = shortValue.sequenceHead as Record<string, unknown>;
    shortRoot.value = { ...shortValue, sequenceHead: { ...shortSequenceHead, sequence: {
      ...(shortSequenceHead.sequence as Record<string, unknown>), lastRxSeq: 6,
    } } };
    invalid(refreshV3(shortHead));
    invalid(valid.map((row) => row.namespace === "gateway_resource_v1" ? { ...row, value: { ...(row.value as Record<string, unknown>), protectedRecovery: { ...((row.value as Record<string, unknown>).protectedRecovery as Record<string, unknown>), chunkIndex: 1 } } } : row));
    invalid(valid.map((row) => row.namespace === "gateway_resource_v1" ? { ...row, value: { ...(row.value as Record<string, unknown>), byteSize: 4 } } : row));
  });
});

function childExit(child: ReturnType<typeof fork>): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("WP-12 coherent document-context host audit", () => {
  it("emits exactly one digest-only join without changing authority", () => {
    let reads = 0;
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => { reads += 1; return route(); } },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(reads).toBe(2);
    expect(result.currentRoute).toMatchObject({ contextDigest, routeDigest: digest("b"), recordDigest: digest("d"), sessionBindingDigest: digest("e"), connectionDigest: digest("f") });
    expect(result.updates).toHaveLength(1);
    expect(result).toMatchObject({ status: "joined", attemptCount: 1, observationCount: 1 });
    expect(JSON.stringify(result)).not.toContain("document-live");
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATIONS).toBe(32);
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES).toBe(2048);
  });

  it("reports bounded value-free missing and mismatch statuses", () => {
    const status = (result: ReturnType<typeof coherentDocumentContextAudit>, expected: string): void => {
      expect(result).toMatchObject({ status: expected, attemptCount: 3 });
    };
    status(coherentDocumentContextAudit({ authority: { readCurrentDocumentRouteAuditSnapshot: () => null }, processEpoch: epoch,
      snapshotObservations: () => snapshot() }), "route_absent");
    status(coherentDocumentContextAudit({ authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([], 2) }), "observation_missing");
    status(coherentDocumentContextAudit({ authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([{ ...observation, sequence: 8 }], 2) }), "sequence_mismatch");
    status(coherentDocumentContextAudit({ authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([{ ...observation, contextDigest: "d".repeat(64) }], 2) }), "context_digest_mismatch");
    const exhausted = coherentDocumentContextAudit({ authority: { readCurrentDocumentRouteAuditSnapshot: () => route({ contextDigest: "not-a-digest-super-secret" }) }, processEpoch: epoch,
      snapshotObservations: () => snapshot() });
    status(exhausted, "retry_exhausted");
    expect(JSON.stringify(exhausted)).not.toContain("not-a-digest-super-secret");
  });

  it.each([
    ["route_changed", "routeDigest"],
    ["record_or_binding_changed", "recordDigest"],
    ["record_or_binding_changed", "sessionBindingDigest"],
    ["record_or_binding_changed", "connectionDigest"],
    ["record_or_binding_changed", "sessionRecordVersion"],
  ] as const)("reports %s for final-route %s churn", (expected, field) => {
    let reads = 0;
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => {
        reads += 1;
        return reads % 2 === 1 ? route() : route({ [field]: field === "sessionRecordVersion" ? 10 : digest("9") });
      } },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(result).toMatchObject({ status: expected, attemptCount: 3 });
  });

  it("prioritizes epoch churn", () => {
    const epochChurn = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => null }, processEpoch: epoch,
      snapshotObservations: () => snapshot([], 0, "223e4567-e89b-42d3-a456-426614174000"),
    });
    expect(epochChurn.status).toBe("epoch_churn");
  });

  it("classifies ordinary A/B append as churn and exhausts only repeated churn", () => {
    let read = 0;
    const appended = Object.freeze({ ...observation, ordinal: 3, sequence: 8, contextDigest: "d".repeat(64) });
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => (++read % 2 === 1 ? snapshot([observation], 2) : snapshot([observation, appended], 3)),
    });
    expect(result).toMatchObject({ status: "retry_exhausted", lastAttemptStatus: "observation_churn", attemptCount: 3 });
  });

  it("reports cursor eviction only when the A candidate is below B's full retained window", () => {
    let read = 0;
    const candidate = Object.freeze({ ...observation, ordinal: 1 });
    const after = Array.from({ length: MAX_DOCUMENT_CONTEXT_OBSERVATIONS }, (_, index) => Object.freeze({
      ...observation, ordinal: index + 2, sequence: index + 100, contextDigest: "d".repeat(64),
    }));
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => (++read % 2 === 1 ? snapshot([candidate], 1) : snapshot(after, MAX_DOCUMENT_CONTEXT_OBSERVATIONS + 1)),
    });
    expect(result).toMatchObject({ status: "cursor_evicted", lastAttemptStatus: "cursor_evicted", observationCount: MAX_DOCUMENT_CONTEXT_OBSERVATIONS });
  });

  it("retries one observation churn and preserves the existing stable join", () => {
    const appended = Object.freeze({ ...observation, ordinal: 3, sequence: 8, contextDigest: "d".repeat(64) });
    const snapshots = [snapshot([observation], 2), snapshot([observation, appended], 3), snapshot(), snapshot()];
    let read = 0;
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshots[read++] ?? snapshot(),
    });
    expect(result).toMatchObject({ status: "joined", lastAttemptStatus: "joined", attemptCount: 2 });
    expect(result.updates).toHaveLength(1);
  });

  it("fails closed for append A/route/B, post-B route churn, restart, and eviction", () => {
    let snapshotCall = 0;
    const append = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], ++snapshotCall),
    });
    expect(append.updates).toEqual([]);
    let routeRead = 0;
    const afterB = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => (++routeRead % 2 === 1 ? route() : route({ recordDigest: digest("1") })) },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(afterB.updates).toEqual([]);
    const restarted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], 2, "223e4567-e89b-42d3-a456-426614174000"),
    });
    expect(restarted.updates).toEqual([]);
    const evicted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([], 32),
    });
    expect(evicted.updates).toEqual([]);
  });

  it.each(["recordDigest", "sessionBindingDigest", "connectionDigest"])(
    "fails closed when final %s churns",
    (field) => {
      let read = 0;
      const result = coherentDocumentContextAudit({
        authority: { readCurrentDocumentRouteAuditSnapshot: () => (++read % 2 === 1 ? route() : route({ [field]: digest("9") })) },
        processEpoch: epoch, snapshotObservations: () => snapshot(),
      });
      expect(result.updates).toEqual([]);
    },
  );
});

describe("WP-12 conformance host shutdown", () => {
  it("orders host settlement and SQLite close before one IPC release", async () => {
    const order: string[] = [];
    const shutdown = createOrderedConformanceHostShutdown({
      host: {
        beginShutdown: () => { order.push("begin"); },
        close: async () => { order.push("host"); },
      },
      closeStore: async () => { order.push("store"); },
      releaseIpc: () => { order.push("ipc"); },
    });
    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await first;
    expect(order).toEqual(["begin", "host", "store", "ipc"]);
  });

  it("releases IPC only after the store-close attempt when host close fails", async () => {
    const order: string[] = [];
    const shutdown = createOrderedConformanceHostShutdown({
      host: {
        beginShutdown: () => { order.push("begin"); },
        close: async () => { order.push("host"); throw new Error("host-close-failure"); },
      },
      closeStore: async () => { order.push("store"); },
      releaseIpc: () => { order.push("ipc"); },
    });
    await expect(shutdown()).rejects.toThrow("host-close-failure");
    expect(order).toEqual(["begin", "host", "store", "ipc"]);
  });

  it("uses Node 24 and real better-sqlite3 state for repeated IPC STOP without native cleanup abort", async () => {
    expect(Number(process.versions.node.split(".")[0])).toBe(24);
    const root = await mkdtemp(path.join(tmpdir(), "revagent-wp12-host-shutdown-"));
    const childFile = path.join(root, "shutdown-child.mjs");
    const cliUrl = pathToFileURL(path.join(packageRoot, "dist", "productionConformanceHostCli.js")).href;
    const adaptersUrl = pathToFileURL(path.join(packageRoot, "dist", "conformanceEphemeralAdapters.js")).href;
    const childSource = `
      import { createOrderedConformanceHostShutdown } from ${JSON.stringify(cliUrl)};
      import { SqliteConformanceProtocolStore } from ${JSON.stringify(adaptersUrl)};
      const root = process.argv[2];
      const store = new SqliteConformanceProtocolStore(root);
      const opened = await store.open();
      if (!opened.ok) throw new Error("store open failed");
      const written = await store.transact({ tenantId: "conformance" }, (tx) => {
        tx.stage({ namespace: "shutdown", key: "probe", value: { state: "open" }, expect: { kind: "absent" } });
        return "written";
      });
      if (!written.ok) throw new Error("store write failed");
      const order = [];
      let stops = 0;
      const shutdown = createOrderedConformanceHostShutdown({
        host: {
          beginShutdown() { order.push("begin"); },
          async close() { order.push("host"); await new Promise((resolve) => setTimeout(resolve, 30)); },
        },
        async closeStore() {
          order.push("store");
          const closed = await store.close();
          if (!closed.ok) throw new Error("store close failed");
        },
        releaseIpc() {
          order.push("ipc");
          process.stdout.write(JSON.stringify({ order, stops }) + "\\n");
          if (process.connected) process.disconnect();
        },
      });
      process.on("message", (message) => {
        if (message?.action !== "STOP") return;
        stops += 1;
        void shutdown().catch((error) => {
          process.stderr.write(String(error));
          process.exitCode = 1;
        });
      });
      process.send?.({ ready: true });
    `;
    try {
      await writeFile(childFile, childSource, "utf8");
      const child = fork(childFile, [root], { silent: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("message", (message: unknown) => {
          if ((message as { readonly ready?: unknown }).ready === true) resolve();
          else reject(new Error("unexpected child readiness message"));
        });
      });
      child.send({ action: "STOP" });
      child.send({ action: "STOP" });
      const exited = await childExit(child);
      expect(exited).toEqual({ code: 0, signal: null });
      expect(stderr).not.toContain("RemoveEnvironmentCleanupHook");
      expect(stderr).not.toMatch(/native abort|assertion failed/i);
      expect(JSON.parse(stdout.trim())).toEqual({ order: ["begin", "host", "store", "ipc"], stops: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("WP-12 conformance recovery composition", () => {
  it("rejects every non-literal verification profile before host startup", async () => {
    await expect(runProductionConformanceHostCli([
      "--root", "missing-root",
      "--certificate", "missing-cert",
      "--key", "missing-key",
      "--control-token", "test-token",
      "--port", "0",
      "--verification-profile", "mutation-probe-v2",
    ])).rejects.toThrow(/invalid production conformance verification profile/u);
  });

  it("rejects a structural mutation-probe workflow substitute", () => {
    expect(() => createProductionConformanceRecoveryAuthority({
      protocolStore: {} as never,
      bridgeEvidence: {} as never,
      verificationWorkflow: {
        profile: "mutation-probe-v1",
        evidenceDecision: { async decideEvidence() { return { kind: "rejected", reason: "fake" }; } },
        async recordOrigin() { return true; },
      } as MutationProbeVerificationWorkflow,
    })).toThrow(/factory branded/u);
  });
  it("uses the exact SQLite store and Bridge evidence authority for isolated read windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "revagent-wp12-recovery-composition-"));
    const store = new SqliteConformanceProtocolStore(root);
    const opened = await store.open();
    expect(opened.ok).toBe(true);
    try {
      const identity = new ConformanceCredentialAuthority([
        { tenantId: "tenant-a", userId: "user-a", deviceId: "device-a", token: "token-a" },
      ]);
      const bridgeEvidence = new GatewayBridgeSessionAuthority(store, identity, {
        resourceAuthority: new GatewayResourceAuthority({
          protocolStore: store,
          objectStore: new DigestFileConformanceObjectStore(root),
        }),
      });
      const recovery = createProductionConformanceRecoveryAuthority({
        protocolStore: store,
        bridgeEvidence,
      });
      const rsid = "recovery-read-rsid";
      const firstAttempt = "0197a3c2-0000-7000-8000-000000000101";
      const secondAttempt = "0197a3c2-0000-7000-8000-000000000102";

      await expect(recovery.acquireInvocationWindow({ tenantId: "tenant-a", rsid, attemptId: firstAttempt }))
        .resolves.toEqual({ kind: "acquired" });
      await expect(recovery.acquireInvocationWindow({ tenantId: "tenant-b", rsid, attemptId: secondAttempt }))
        .resolves.toEqual({ kind: "acquired" });
      await expect(recovery.releaseInvocationWindow({ tenantId: "tenant-a", rsid, attemptId: firstAttempt }))
        .resolves.toEqual({ kind: "released" });
      await expect(recovery.releaseInvocationWindow({ tenantId: "tenant-b", rsid, attemptId: secondAttempt }))
        .resolves.toEqual({ kind: "released" });

      const readA = await store.transact({ tenantId: "tenant-a" }, (tx) => tx.read(GATEWAY_RECOVERY_NAMESPACE, rsid));
      const readB = await store.transact({ tenantId: "tenant-b" }, (tx) => tx.read(GATEWAY_RECOVERY_NAMESPACE, rsid));
      expect(readA).toMatchObject({ ok: true, value: { value: { invocationWindow: null, pendingDispatch: null } } });
      expect(readB).toMatchObject({ ok: true, value: { value: { invocationWindow: null, pendingDispatch: null } } });
      expect(JSON.stringify([readA, readB])).not.toContain("token-a");
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("acquires and releases the public core.ui.state read window after success and executor failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "revagent-wp12-recovery-dispatch-"));
    const store = new SqliteConformanceProtocolStore(root);
    expect((await store.open()).ok).toBe(true);
    try {
      const identity = new ConformanceCredentialAuthority([
        { tenantId: "tenant-a", userId: "user-a", deviceId: "device-a", token: "token-a" },
      ]);
      const bridgeEvidence = new GatewayBridgeSessionAuthority(store, identity, {
        resourceAuthority: new GatewayResourceAuthority({
          protocolStore: store,
          objectStore: new DigestFileConformanceObjectStore(root),
        }),
      });
      const recovery = createProductionConformanceRecoveryAuthority({ protocolStore: store, bridgeEvidence });
      const auth: AuthContext = Object.freeze({
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: Object.freeze({ type: "user", tenantId: "tenant-a", userId: "user-a", role: "user", oidcIssuer: "https://issuer.invalid", oidcSubject: "subject-a" }),
        session: Object.freeze({ sessionId: "gateway-session", clientType: "mcp", mcpSessionId: "mcp-session", oauthClientId: "test-client" }),
        principalKey: "tenant-a:user-a", issuedAtMs: 1, expiresAtMs: null,
      });
      const scope = createEffectiveMcpRequestScopeV1({ principalKey: auth.principalKey, transportMcpSessionId: "mcp-session", identityMcpSessionId: null, nowMs: 1 });
      let sequence = 0;
      const dispatch = async (outcome: "success" | "throw") => {
        const executor: GatewayExecutor = {
          binding: "bridge",
          async execute() {
            if (outcome === "throw") throw new Error("fixture executor failure");
            return { state: "completed" as const, result: { state: "read" } };
          },
        };
        const dispatcher = new GatewayDispatcher(new GatewayToolRegistry(M2_BOOTSTRAP_TOOL_RECORDS), [executor], {
          eventSink: createConformanceSupportingPorts().events,
          eventSource: { component: "gateway-production-conformance", version: "wp12", instance: "loopback" },
          recoveryAuthority: recovery,
          newInvocationId: () => `0197a3c2-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
          newAttemptId: () => `0197a3c2-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
          newEventId: () => `0197a3c2-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
          clock: () => 1,
        });
        return dispatcher.dispatch({
          toolName: "core.ui.state", args: {}, auth, mcpSessionId: "mcp-session", effectiveMcpRequestScope: scope,
          resolveRoute: (_auth, effectiveMcpRequestScope) => Object.freeze({
            tenantId: "tenant-a", principalKey: auth.principalKey, mcpSessionId: "mcp-session", effectiveMcpRequestScope,
            rsid: "core-ui-read-rsid", documentIdentity: Object.freeze({ kind: "live" as const, session_document_id: "document-live" }),
          }),
        });
      };
      const successful = await dispatch("success");
      expect(successful).toMatchObject({ ok: true, state: "completed" });
      await expect(dispatch("throw")).resolves.toMatchObject({ ok: false, state: "failed" });
      const record = await store.transact({ tenantId: "tenant-a" }, (tx) => tx.read(GATEWAY_RECOVERY_NAMESPACE, "core-ui-read-rsid"));
      expect(record).toMatchObject({ ok: true, value: { value: { invocationWindow: null, pendingDispatch: null } } });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("has no recovery control-plane fallback, preserves ordinary objects, and isolates C39 protected objects", async () => {
    const source = await readFile(new URL("./productionConformanceHostCli.ts", import.meta.url), "utf8");
    expect(source).toContain("recoveryAuthority,");
    expect(source).not.toContain("recoveryAuthority: {} as never");
    expect(source).toContain('kind: "rejected" as const');
    expect(source).toContain('reason: "conformance_recovery_evidence_denied"');
    expect(source).not.toContain("createReadOnlyRecoveryAuthorityFixture");
    expect(source).toContain("new DigestFileConformanceObjectStore(options.root)");
    expect(source).toContain("new ProtectedConformanceObjectStore(");
    expect(source).toContain("new EncryptedProtectedObjectStore(");
    expect(source).toContain("protectedConformanceObjectStore,");
    expect(source).toContain("c39PartialCarrierCommitFailure");
    expect(source).toContain("onConformancePartialCarrierCommitFailure");
    expect(source).not.toContain("C39_PARTIAL_CARRIER_COMMIT_DIAGNOSTIC=");
  });
});
