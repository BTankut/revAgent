import { describe, expect, it } from "vitest";

import type { GatewayJsonValue } from "./dispatch.js";
import {
  DEFAULT_SESSION_RETENTION_MS,
  MINIMUM_SESSION_RETENTION_MS,
  completeSessionRetention,
  createSessionRetentionClosure,
  evaluateSessionRetention,
  takeOverSessionRetentionClaim,
  type SessionRetentionCandidate,
} from "./sessionRetention.js";
import {
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
  type DurableRbpSessionV3,
} from "./sessionHistoryStore.js";

const asJson = (value: unknown): GatewayJsonValue => value as GatewayJsonValue;

function candidate(overrides: Partial<SessionRetentionCandidate> = {}): SessionRetentionCandidate {
  const resumeExpiresAtMs = 10_000;
  return {
    tenantId: "tenant-a",
    rsid: "rsid-a",
    sessionBindingId: "binding-a",
    sessionBindingVersion: 2,
    lifecyclePhase: "terminal_retained",
    dispatchAllowed: false,
    resumable: false,
    resumeExpiresAtMs,
    retirementAnchorMs: resumeExpiresAtMs,
    lastObservedNowMs: resumeExpiresAtMs,
    producerState: "settled",
    pendingDispatch: false,
    unfinishedBatch: false,
    activeEgressLease: false,
    unresolvedHold: false,
    c39Dependency: false,
    migrationDependency: false,
    indicesComplete: true,
    dependencyInventoryComplete: true,
    unregisterRef: null,
    dependencyRefs: [],
    treeRoots: [],
    privateObjects: [{
      namespace: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
      key: "rsid-a/outbound-envelope/blob-a",
      version: 1,
      digest: `sha256:${"1".repeat(64)}`,
      ownerIdentity: "owner-a",
      ownerEpoch: 1,
      binding: {
        tenantId: "tenant-a", rsid: "rsid-a", purpose: "outbound-envelope",
        storageKey: `sha256:${"2".repeat(64)}`, byteLength: 65_537,
        digest: `sha256:${"2".repeat(64)}`,
        contentType: "application/vnd.revagent.rbp-envelope+json",
      },
    }],
    plannedEntries: 3,
    plannedRecords: 2,
    plannedObjects: 1,
    ...overrides,
  };
}

describe("session retention v6", () => {
  it("retains every nonterminal, live producer, hold, C39 and clock-rollback candidate", () => {
    const decision = evaluateSessionRetention(candidate({
      lifecyclePhase: "registered",
      dispatchAllowed: true,
      resumable: true,
      producerState: "unknown",
      pendingDispatch: true,
      unfinishedBatch: true,
      activeEgressLease: true,
      unresolvedHold: true,
      c39Dependency: true,
      migrationDependency: true,
      indicesComplete: false,
      dependencyInventoryComplete: false,
      lastObservedNowMs: 20_000,
    }), { nowMs: 19_999 });
    expect(decision).toMatchObject({
      kind: "retained",
      reasons: expect.arrayContaining([
        "not_terminal",
        "still_resumable",
        "clock_rollback",
        "producer_not_settled",
        "pending_dispatch",
        "unfinished_batch",
        "active_egress_lease",
        "unresolved_hold",
        "c39_dependency",
        "migration_dependency",
        "missing_or_malformed_index",
        "dependency_inventory_incomplete",
      ]),
    });
  });

  it("enforces the seven-day floor and exact fourteen-day default boundary", () => {
    expect(() => evaluateSessionRetention(candidate(), {
      nowMs: 10_000 + MINIMUM_SESSION_RETENTION_MS,
      retentionMs: MINIMUM_SESSION_RETENTION_MS - 1,
    })).toThrow("seven-day floor");
    expect(evaluateSessionRetention(candidate(), {
      nowMs: 10_000 + DEFAULT_SESSION_RETENTION_MS - 1,
    })).toMatchObject({ kind: "retained", reasons: ["retention_not_elapsed"] });
    expect(evaluateSessionRetention(candidate(), {
      nowMs: 10_000 + DEFAULT_SESSION_RETENTION_MS,
    })).toMatchObject({ kind: "eligible" });
  });

  it("freezes a deterministic dependency digest independent of input ordering", () => {
    const refs = [
      { role: "hold", namespace: "hold", key: "b", version: 1, digest: `sha256:${"1".repeat(64)}` as const, state: "cleared" },
      { role: "receipt", namespace: "receipt", key: "a", version: 2, digest: `sha256:${"2".repeat(64)}` as const, state: "terminal" },
    ];
    const nowMs = 10_000 + DEFAULT_SESSION_RETENTION_MS;
    const first = evaluateSessionRetention(candidate({ dependencyRefs: refs }), { nowMs });
    const second = evaluateSessionRetention(candidate({ dependencyRefs: [...refs].reverse() }), { nowMs });
    expect(first).toStrictEqual(second);
  });

  it("keeps private-object ordering outside the frozen canonical plan digest", () => {
    const nowMs = 10_000 + DEFAULT_SESSION_RETENTION_MS;
    const firstCandidate = candidate();
    const secondCandidate = candidate({
      privateObjects: firstCandidate.privateObjects.map((value) => ({
        ...value,
        key: `${value.key}-different`,
        binding: {
          ...value.binding,
          storageKey: `sha256:${"3".repeat(64)}`,
        },
      })),
    });
    const firstDecision = evaluateSessionRetention(firstCandidate, { nowMs });
    const secondDecision = evaluateSessionRetention(secondCandidate, { nowMs });
    if (firstDecision.kind !== "eligible" || secondDecision.kind !== "eligible") {
      throw new Error("plan digest fixture is not eligible");
    }
    const common = {
      owner: { identity: "owner-a", epoch: 1 },
      preClaimRootRef: asJson({ version: 1, digest: "root" }),
      preClaimMarkerRef: asJson({ version: 1, digest: "marker" }),
      closureId: "closure-a",
      claimExpiresAtMs: nowMs + 1_000,
    } as const;
    const first = createSessionRetentionClosure({
      ...common, candidate: firstCandidate, decision: firstDecision,
    });
    const second = createSessionRetentionClosure({
      ...common, candidate: secondCandidate, decision: secondDecision,
    });
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.objectIntents).not.toStrictEqual(second.objectIntents);
    expect(first.dependencyClosureDigest).toBe(firstDecision.dependencyClosureDigest);
    expect(first.dependencyRefs).toStrictEqual(firstCandidate.dependencyRefs);
  });

  it("keeps creator provenance immutable while a newer inactive-owner claim takes over", () => {
    const decision = evaluateSessionRetention(candidate(), {
      nowMs: 10_000 + DEFAULT_SESSION_RETENTION_MS,
    });
    expect(decision.kind).toBe("eligible");
    const closure = createSessionRetentionClosure({
      candidate: candidate(),
      decision: decision as Extract<typeof decision, { kind: "eligible" }>,
      owner: { identity: "owner-a", epoch: 4 },
      preClaimRootRef: asJson({ version: 3, digest: "root" }),
      preClaimMarkerRef: asJson({ version: 3, digest: "marker" }),
      claimToken: "claim-a",
      claimExpiresAtMs: 100,
    });
    expect(() => takeOverSessionRetentionClaim({
      closure,
      owner: { identity: "owner-b", epoch: 5 },
      nowMs: 100,
      oldOwnerInactive: false,
      claimExpiresAtMs: 200,
    })).toThrow("not authorized");
    const taken = takeOverSessionRetentionClaim({
      closure,
      owner: { identity: "owner-b", epoch: 5 },
      nowMs: 100,
      oldOwnerInactive: true,
      claimExpiresAtMs: 200,
      token: "claim-b",
    });
    expect(taken.creator).toStrictEqual({ ownerIdentity: "owner-a", ownerEpoch: 4 });
    expect(taken.claim).toMatchObject({
      ownerIdentity: "owner-b",
      ownerEpoch: 5,
      token: "claim-b",
      generation: 2,
    });
    expect(taken.planDigest).toBe(closure.planDigest);
  });

  it("creates completion and retired-authority digests only after exact counters exhaust", () => {
    const decision = evaluateSessionRetention(candidate(), {
      nowMs: 10_000 + DEFAULT_SESSION_RETENTION_MS,
    }) as Extract<ReturnType<typeof evaluateSessionRetention>, { kind: "eligible" }>;
    const closure = createSessionRetentionClosure({
      candidate: candidate(),
      decision,
      owner: { identity: "owner-a", epoch: 1 },
      preClaimRootRef: asJson({ version: 1 }),
      preClaimMarkerRef: asJson({ version: 1 }),
      claimExpiresAtMs: 100,
    });
    const root: DurableRbpSessionV3 = {
      schema: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      generation: 3,
      rootVersion: 2,
      tenantId: "tenant-a",
      rsid: "rsid-a",
      identity: asJson({ userId: "user-a" }),
      binding: asJson({ resumeExpiresAtMs: 10_000 }),
      lifecycle: asJson({ phase: "terminal_retained" }),
      sequenceHead: asJson({ nextTxSeq: 4 }),
      migrationProof: {
        sourceGeneration: 2,
        sourceDigest: `sha256:${"1".repeat(64)}`,
        equivalenceDigest: `sha256:${"2".repeat(64)}`,
        targetPlanDigest: `sha256:${"3".repeat(64)}`,
        sourceCleanupReceiptDigest: `sha256:${"4".repeat(64)}`,
      },
      durabilityProfile: asJson({ mode: "private_object" }),
      trees: [],
      singletonRefs: [],
      antiDowngradeRefs: [],
      retentionClosure: closure,
      retiredAuthorityDigest: null,
      completionDigest: null,
    };
    expect(() => completeSessionRetention({
      root,
      closure,
      dependencyClosureDigest: decision.dependencyClosureDigest,
      completedAtMs: 200,
      migrationProof: asJson(root.migrationProof),
      antiDowngradeRefs: asJson([]),
    })).toThrow("counters are not exhausted");
    const exhausted = {
      ...closure,
      counts: {
        ...closure.counts,
        processedEntries: 3,
        deletedRecords: 2,
        deletedObjects: 1,
        positiveAbsences: 1,
      },
    };
    const completed = completeSessionRetention({
      root,
      closure: exhausted,
      dependencyClosureDigest: decision.dependencyClosureDigest,
      completedAtMs: 200,
      migrationProof: asJson(root.migrationProof),
      antiDowngradeRefs: asJson([]),
    });
    expect(completed.retiredAuthorityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completed.completionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completed.completionDigest).not.toBe(completed.retiredAuthorityDigest);
  });
});
