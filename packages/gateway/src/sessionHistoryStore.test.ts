import { describe, expect, it } from "vitest";

import type { GatewayJsonValue } from "./dispatch.js";
import {
  GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
  GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE,
  SESSION_HISTORY_BRANCH_MAX_REFS,
  SESSION_HISTORY_LEAF_MAX_ENTRIES,
  SESSION_MIGRATION_RESERVATION_BATCH,
  SESSION_MIGRATION_SWAP_BATCH,
  SessionHistoryStore,
  SessionPrivateBlobStore,
  buildSessionHistoryPagePlan,
  planSessionMigrationCapacity,
  sessionCanonicalDigest,
  sessionRecordValueBytes,
  stageMigrationReservationBatch,
  stageMigrationSlotSwaps,
  verifyMigrationReservationInventory,
  type DurableRbpSessionV3,
  type SessionHistoryEntry,
  type SessionMigrationTargetRecord,
} from "./sessionHistoryStore.js";
import { createRestartableTestStore } from "./testAdapters.js";
import { createPreProductionRuntimeAdapters } from "./preProductionRuntimeAdapters.js";
import {
  DEFAULT_SESSION_RETENTION_MS,
  completeSessionRetention,
  createSessionRetentionClosure,
  evaluateSessionRetention,
} from "./sessionRetention.js";

const asJson = (value: unknown): GatewayJsonValue => value as GatewayJsonValue;

function entries(count: number): readonly SessionHistoryEntry[] {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    key: `k-${String(index).padStart(4, "0")}`,
    value: asJson({ ordinal: index, payload: `value-${index}` }),
  }));
}

function digest(label: string): `sha256:${string}` {
  return sessionCanonicalDigest(asJson({ label }));
}

describe("SessionHistoryStore v3", () => {
  it("builds deterministic immutable B+ pages at the leaf and branch boundaries", () => {
    const input = {
      tenantId: "tenant-a",
      rsid: "rsid-a",
      treeKind: "evidence" as const,
      entries: entries(SESSION_HISTORY_LEAF_MAX_ENTRIES * SESSION_HISTORY_BRANCH_MAX_REFS + 1),
    };
    const first = buildSessionHistoryPagePlan(input);
    const second = buildSessionHistoryPagePlan(input);

    expect(first).toStrictEqual(second);
    expect(first.tree.entryCount).toBe(2_049);
    expect(first.tree.root?.height).toBe(3);
    expect(first.pages.filter((page) => "entries" in page.value)).toHaveLength(33);
    expect(first.pages.every((page) =>
      sessionRecordValueBytes(asJson(page.value)) <= 512 * 1024)).toBe(true);
    expect(new Set(first.pages.map((page) => page.key)).size).toBe(first.pages.length);
  });

  it("hydrates only marker-authenticated point pages and preserves exact order after restart", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const plan = buildSessionHistoryPagePlan({
      tenantId: "tenant-a",
      rsid: "rsid-a",
      treeKind: "receipts",
      entries: entries(129),
    });
    const store = new SessionHistoryStore(restartable.store);
    const root: DurableRbpSessionV3 = Object.freeze({
      schema: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      generation: 3,
      rootVersion: 1,
      tenantId: "tenant-a",
      rsid: "rsid-a",
      identity: asJson({ userId: "user-a" }),
      binding: asJson({
        binding: "wss", sessionBindingId: "binding-a", sessionVersion: 1,
        connectionId: "connection-a", grantedCapabilities: [],
      }),
      lifecycle: asJson({
        connectionLifecycle: { grantedCapabilities: [] },
        sessionLifecycle: {
          localSessionKey: "local-a", phase: "registered", dispatchAllowed: true,
        },
        liveDocumentRoute: null,
      }),
      sequenceHead: asJson({ nextTxSeq: 130, lastRxSeq: 129 }),
      migrationProof: Object.freeze({
        sourceGeneration: 2,
        sourceDigest: digest("source"),
        equivalenceDigest: digest("equivalence"),
        targetPlanDigest: digest("plan"),
        sourceCleanupReceiptDigest: digest("cleanup"),
      }),
      durabilityProfile: asJson({ version: 1, mode: "private_object" }),
      trees: Object.freeze([plan.tree]),
      singletonRefs: Object.freeze([]),
      antiDowngradeRefs: Object.freeze([]),
      retentionClosure: null,
      retiredAuthorityDigest: null,
      completionDigest: null,
    });
    const committed = await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) => {
      await store.stageNew(tx, { root, pagePlans: [plan], migratedAtMs: 1 });
    });
    expect(committed.ok).toBe(true);

    const restartedPort = restartable.restart();
    await restartedPort.open();
    const restarted = new SessionHistoryStore(restartedPort);
    const read = await restartedPort.transact({ tenantId: "tenant-a" }, async (tx) => {
      const authoritative = await restarted.readAuthoritative(tx, "tenant-a", "rsid-a");
      expect(authoritative?.value.rootVersion).toBe(1);
      return await restarted.readTree(tx, {
        tenantId: "tenant-a",
        rsid: "rsid-a",
        tree: authoritative!.value.trees[0]!,
      });
    });
    expect(read.ok && read.value).toStrictEqual(entries(129));
  });

  it("physically reserves 63 slots per batch with exact encoded padding", async () => {
    const targets: SessionMigrationTargetRecord[] = Array.from({ length: 65 }, (_, index) => ({
      namespace: "gateway.target/v1",
      key: `target-${String(index).padStart(3, "0")}`,
      expect: { kind: "absent" as const },
      value: asJson({ index, value: "x".repeat(index % 7) }),
      role: "target_record" as const,
      mutableMaxBytes: 512 + index,
    }));
    const plan = planSessionMigrationCapacity({
      tenantId: "tenant-a",
      rsid: "rsid-a",
      migrationId: "migration-a",
      sourceSnapshotDigest: digest("source"),
      targets,
      privateObjects: [],
    });
    expect(plan.slots).toHaveLength(65);
    expect(plan.slots.every((slot) =>
      sessionRecordValueBytes(asJson(slot)) === slot.reservedValueByteLength)).toBe(true);

    const restartable = createRestartableTestStore();
    await restartable.store.open();
    let cursor = -1;
    const first = await restartable.store.transact({ tenantId: "tenant-a" }, (tx) => {
      cursor = stageMigrationReservationBatch(tx, plan, cursor);
    });
    expect(first.ok).toBe(true);
    expect(cursor).toBe(SESSION_MIGRATION_RESERVATION_BATCH - 1);
    const second = await restartable.store.transact({ tenantId: "tenant-a" }, (tx) => {
      cursor = stageMigrationReservationBatch(tx, plan, cursor);
    });
    expect(second.ok).toBe(true);
    expect(cursor).toBe(64);
    const reservations = restartable.snapshot().records.filter((record) =>
      record.namespace === GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE);
    expect(reservations).toHaveLength(65);
    expect(() => verifyMigrationReservationInventory(reservations, plan)).not.toThrow();
    expect(() => verifyMigrationReservationInventory([
      ...reservations,
      { ...reservations[0]!, key: `${reservations[0]!.key}-extra` },
    ], plan)).toThrow(/cardinality/u);
    expect(() => verifyMigrationReservationInventory(reservations.map((row, index) =>
      index === 64 ? { ...row, value: asJson({ ...(row.value as object), padding: "" }) } : row), plan))
      .toThrow(/proof/u);
  });

  it("consumes at most 31 slots as exact two-write swaps and rejects plan drift", async () => {
    const targets: SessionMigrationTargetRecord[] = Array.from({ length: 33 }, (_, index) => ({
      namespace: "gateway.target/v1",
      key: `target-${String(index).padStart(3, "0")}`,
      expect: { kind: "absent" as const },
      value: asJson({ index }),
      role: "target_record" as const,
    }));
    const plan = planSessionMigrationCapacity({
      tenantId: "tenant-a",
      rsid: "rsid-a",
      migrationId: "migration-a",
      sourceSnapshotDigest: digest("source"),
      targets,
      privateObjects: [],
    });
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    let reserveCursor = -1;
    while (reserveCursor < 32) {
      const outcome = await restartable.store.transact({ tenantId: "tenant-a" }, (tx) => {
        reserveCursor = stageMigrationReservationBatch(tx, plan, reserveCursor);
      });
      expect(outcome.ok).toBe(true);
    }
    let swapCursor = -1;
    const swapped = await restartable.store.transact({ tenantId: "tenant-a" }, (tx) => {
      swapCursor = stageMigrationSlotSwaps(tx, { plan, targets, afterOrdinal: swapCursor });
    });
    expect(swapped.ok).toBe(true);
    expect(swapCursor).toBe(SESSION_MIGRATION_SWAP_BATCH - 1);
    expect(restartable.snapshot().records.filter((record) =>
      record.namespace === "gateway.target/v1")).toHaveLength(31);
    expect(() => stageMigrationSlotSwaps({ stage() {}, read: async () => null, list: async () => [] }, {
      plan,
      targets: targets.map((target, index) => index === 32
        ? { ...target, value: asJson({ index, changed: true }) }
        : target),
      afterOrdinal: 31,
    })).toThrow("no longer matches");
  });

  it("publishes the marker last and returns a bounded strict v3 audit projection", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const store = new SessionHistoryStore(restartable.store);
    const root: DurableRbpSessionV3 = Object.freeze({
      schema: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      generation: 3,
      rootVersion: 1,
      tenantId: "tenant-a",
      rsid: "rsid-a",
      identity: asJson({ userId: "user-a" }),
      binding: asJson({
        binding: "wss", sessionBindingId: "binding-a", sessionVersion: 1,
        connectionId: "connection-a", grantedCapabilities: [],
      }),
      lifecycle: asJson({
        connectionLifecycle: { grantedCapabilities: [] },
        sessionLifecycle: {
          localSessionKey: "local-a", phase: "registered", dispatchAllowed: true,
        },
        liveDocumentRoute: null,
      }),
      sequenceHead: asJson({ nextTxSeq: 1 }),
      migrationProof: {
        sourceGeneration: 1,
        sourceDigest: digest("source"),
        equivalenceDigest: digest("equivalence"),
        targetPlanDigest: digest("plan"),
        sourceCleanupReceiptDigest: digest("cleanup"),
      },
      durabilityProfile: asJson({ version: 1, mode: "private_object" }),
      trees: [],
      singletonRefs: [],
      antiDowngradeRefs: [],
      retentionClosure: null,
      retiredAuthorityDigest: null,
      completionDigest: null,
    });
    await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) => {
      await store.stageNew(tx, { root, pagePlans: [], migratedAtMs: 1 });
    });
    const namespaces = restartable.snapshot().records.map((record) => record.namespace);
    expect(namespaces).toContain(GATEWAY_RBP_SESSION_V3_NAMESPACE);
    expect(namespaces).toContain(GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE);
    expect(namespaces).not.toContain(GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE);
    const audit = await store.snapshotAudit("tenant-a", "rsid-a", true);
    if (!audit.ok) throw new Error(audit.message);
    expect(audit).toMatchObject({
      ok: true,
      value: {
        status: "candidate", candidateCount: 1, rootVersion: 1,
        readiness: { binding: "wss", localSessionKey: "local-a", liveDocumentRoute: null },
      },
    });
  });

  it("deletes immutable leaves in bounded passes and retains a compact authenticated root+marker", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const store = new SessionHistoryStore(restartable.store);
    const plan = buildSessionHistoryPagePlan({
      tenantId: "tenant-a",
      rsid: "rsid-a",
      treeKind: "outbox",
      entries: entries(65 * SESSION_HISTORY_LEAF_MAX_ENTRIES),
    });
    const root: DurableRbpSessionV3 = Object.freeze({
      schema: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      generation: 3,
      rootVersion: 1,
      tenantId: "tenant-a",
      rsid: "rsid-a",
      identity: asJson({ userId: "user-a" }),
      binding: asJson({ sessionBindingId: "binding-a", resumeExpiresAtMs: 10_000 }),
      lifecycle: asJson({ phase: "terminal_retained", dispatchAllowed: false, resumable: false }),
      sequenceHead: asJson({ nextTxSeq: 4_161 }),
      migrationProof: {
        sourceGeneration: 2,
        sourceDigest: digest("source"),
        equivalenceDigest: digest("equivalence"),
        targetPlanDigest: digest("plan"),
        sourceCleanupReceiptDigest: digest("cleanup"),
      },
      durabilityProfile: asJson({ mode: "private_object" }),
      trees: [plan.tree],
      singletonRefs: [],
      antiDowngradeRefs: [],
      retentionClosure: null,
      retiredAuthorityDigest: null,
      completionDigest: null,
    });
    await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) => {
      await store.stageNew(tx, { root, pagePlans: [plan], migratedAtMs: 1 });
    });
    const nowMs = 10_000 + DEFAULT_SESSION_RETENTION_MS;
    const decision = evaluateSessionRetention({
      tenantId: "tenant-a",
      rsid: "rsid-a",
      sessionBindingId: "binding-a",
      sessionBindingVersion: 1,
      lifecyclePhase: "terminal_retained",
      dispatchAllowed: false,
      resumable: false,
      resumeExpiresAtMs: 10_000,
      retirementAnchorMs: 10_000,
      lastObservedNowMs: 10_000,
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
      treeRoots: [plan.tree],
      privateObjects: [],
      plannedEntries: plan.tree.entryCount,
      plannedRecords: plan.pages.length,
      plannedObjects: 0,
    }, { nowMs });
    expect(decision.kind).toBe("eligible");
    const closure = createSessionRetentionClosure({
      candidate: {
        tenantId: "tenant-a", rsid: "rsid-a", sessionBindingId: "binding-a",
        sessionBindingVersion: 1, lifecyclePhase: "terminal_retained",
        dispatchAllowed: false, resumable: false, resumeExpiresAtMs: 10_000,
        retirementAnchorMs: 10_000, lastObservedNowMs: 10_000,
        producerState: "settled", pendingDispatch: false, unfinishedBatch: false,
        activeEgressLease: false, unresolvedHold: false, c39Dependency: false,
        migrationDependency: false, indicesComplete: true,
        dependencyInventoryComplete: true, unregisterRef: null, dependencyRefs: [],
        treeRoots: [plan.tree], privateObjects: [], plannedEntries: plan.tree.entryCount,
        plannedRecords: plan.pages.length, plannedObjects: 0,
      },
      decision: decision as Extract<typeof decision, { kind: "eligible" }>,
      owner: { identity: "owner-a", epoch: 1 },
      preClaimRootRef: asJson({ version: 1, digest: "root" }),
      preClaimMarkerRef: asJson({ version: 1, digest: "marker" }),
      claimToken: "claim-a",
      claimExpiresAtMs: nowMs + 1_000,
    });
    await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) => {
      await store.claimRetention(tx, {
        tenantId: "tenant-a", rsid: "rsid-a", closure, updatedAtMs: nowMs,
      });
    });
    const first = await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) =>
      await store.deleteRetentionPageBatch(tx, {
        tenantId: "tenant-a", rsid: "rsid-a", claimToken: "claim-a",
        ownerIdentity: "owner-a", ownerEpoch: 1, updatedAtMs: nowMs + 1,
        maxOperations: 64,
      }));
    expect(first.ok && first.value.pagesExhausted).toBe(false);
    const second = await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) =>
      await store.deleteRetentionPageBatch(tx, {
        tenantId: "tenant-a", rsid: "rsid-a", claimToken: "claim-a",
        ownerIdentity: "owner-a", ownerEpoch: 1, updatedAtMs: nowMs + 2,
        maxOperations: 64,
      }));
    expect(second.ok && second.value.pagesExhausted).toBe(true);
    const closingRoot = second.ok ? second.value.root : null;
    expect(closingRoot?.retentionClosure?.counts).toMatchObject({
      processedEntries: plan.tree.entryCount,
      deletedRecords: plan.pages.length,
    });
    const completion = completeSessionRetention({
      root: closingRoot!,
      closure: closingRoot!.retentionClosure!,
      dependencyClosureDigest: (decision as Extract<typeof decision, { kind: "eligible" }>).dependencyClosureDigest,
      completedAtMs: nowMs + 3,
      migrationProof: asJson(closingRoot!.migrationProof),
      antiDowngradeRefs: asJson(closingRoot!.antiDowngradeRefs),
    });
    await restartable.store.transact({ tenantId: "tenant-a" }, async (tx) => {
      await store.finalizeRetiredRoot(tx, {
        tenantId: "tenant-a", rsid: "rsid-a", claimToken: "claim-a",
        retiredBinding: completion.retiredBinding,
        retiredLifecycle: completion.retiredLifecycle,
        retiredSequenceHead: completion.retiredSequenceHead,
        closureReceipt: completion.closureReceipt,
        retiredAuthorityDigest: completion.retiredAuthorityDigest,
        completionDigest: completion.completionDigest,
        completedAtMs: completion.completedAtMs,
      });
    });
    expect(restartable.snapshot().records.filter((record) =>
      record.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE)).toHaveLength(0);
    const retiredAudit = await store.snapshotAudit("tenant-a", "rsid-a", true);
    if (!retiredAudit.ok) throw new Error(retiredAudit.message);
    expect(retiredAudit).toMatchObject({
      ok: true,
      value: { status: "candidate", retired: true },
    });
  });

  it("commits private intent before bytes and proves positive absence before descriptor removal", async () => {
    const adapters = createPreProductionRuntimeAdapters();
    await adapters.servingOwnership.protocolStore.open();
    try {
      const privateObjects = adapters.servingOwnership.privateObjectStore();
      expect(privateObjects).not.toBeNull();
      const blobs = new SessionPrivateBlobStore(
        adapters.servingOwnership.protocolStore,
        adapters.servingOwnership,
        privateObjects!,
      );
      const bytes = new Uint8Array(65_537).fill(0x61);
      const descriptor = await blobs.spill({
        tenantId: "tenant-a",
        rsid: "rsid-a",
        purpose: "terminal-payload",
        bytes,
        contentType: "application/json",
      });
      const intent = await adapters.servingOwnership.protocolStore.transact(
        { tenantId: "tenant-a" },
        (tx) => tx.read(descriptor.intentNamespace, descriptor.intentKey),
      );
      expect(intent.ok && intent.value?.value).toMatchObject({
        state: "active",
        binding: { byteLength: 65_537, storageKey: descriptor.binding.storageKey },
      });
      await expect(blobs.hydrate(descriptor)).resolves.toStrictEqual(bytes);
      await expect(privateObjects!.scanOwned({
        tenantId: "tenant-a", rsid: "rsid-a", afterKey: null, limit: 64,
      })).resolves.toMatchObject({ ok: true, value: [descriptor.binding] });

      await blobs.delete(descriptor, "claim-a");
      await expect(privateObjects!.getOptional(descriptor.binding)).resolves.toStrictEqual({
        ok: true,
        value: null,
      });
      const removed = await adapters.servingOwnership.protocolStore.transact(
        { tenantId: "tenant-a" },
        (tx) => tx.read(descriptor.intentNamespace, descriptor.intentKey),
      );
      expect(removed.ok && removed.value).toBeNull();
    } finally {
      await adapters.servingOwnership.protocolStore.close();
    }
  });

  it("deletes private bytes before intent metadata and advances the closure only after positive absence", async () => {
    const adapters = createPreProductionRuntimeAdapters();
    await adapters.servingOwnership.protocolStore.open();
    try {
      const privateObjects = adapters.servingOwnership.privateObjectStore()!;
      const history = new SessionHistoryStore(adapters.servingOwnership.protocolStore);
      const blobs = new SessionPrivateBlobStore(
        adapters.servingOwnership.protocolStore,
        adapters.servingOwnership,
        privateObjects,
      );
      const descriptor = await blobs.spill({
        tenantId: "tenant-a", rsid: "rsid-a", purpose: "terminal-payload",
        bytes: new Uint8Array(65_537).fill(0x62), contentType: "application/json",
      });
      const intent = await adapters.servingOwnership.protocolStore.transact(
        { tenantId: "tenant-a" },
        (tx) => tx.read(descriptor.intentNamespace, descriptor.intentKey),
      );
      if (!intent.ok || intent.value === null) throw new Error("private intent fixture is missing");
      const root: DurableRbpSessionV3 = {
        schema: GATEWAY_RBP_SESSION_V3_NAMESPACE, generation: 3, rootVersion: 1,
        tenantId: "tenant-a", rsid: "rsid-a", identity: asJson({ userId: "user-a" }),
        binding: asJson({
          binding: "wss", sessionBindingId: "binding-a", sessionVersion: 1,
          connectionId: "connection-a", resumeExpiresAtMs: 10_000, grantedCapabilities: [],
        }),
        lifecycle: asJson({
          connectionLifecycle: { grantedCapabilities: [] },
          sessionLifecycle: { localSessionKey: "local-a", phase: "unregistered", dispatchAllowed: false },
          liveDocumentRoute: null,
        }),
        sequenceHead: asJson({ sequence: {
          nextTxSeq: 1, highestTxSeq: 0, lastRxSeq: 0, lastPeerAck: 0,
        } }),
        migrationProof: {
          sourceGeneration: 3, sourceDigest: digest("source"),
          equivalenceDigest: digest("equivalence"), targetPlanDigest: digest("plan"),
          sourceCleanupReceiptDigest: digest("cleanup"),
        },
        durabilityProfile: asJson({ mode: "private_object" }), trees: [],
        singletonRefs: [], antiDowngradeRefs: [], retentionClosure: null,
        retiredAuthorityDigest: null, completionDigest: null,
      };
      await adapters.servingOwnership.protocolStore.transact({ tenantId: "tenant-a" }, async (tx) => {
        await history.stageNew(tx, { root, pagePlans: [], migratedAtMs: 1 });
      });
      const objectRef = {
        namespace: descriptor.intentNamespace,
        key: descriptor.intentKey,
        version: intent.value.version,
        digest: sessionCanonicalDigest(intent.value.value),
        ownerIdentity: privateObjects.ownerIdentity,
        ownerEpoch: privateObjects.ownerEpoch,
        binding: descriptor.binding,
      } as const;
      const nowMs = 10_000 + DEFAULT_SESSION_RETENTION_MS;
      const candidate = {
        tenantId: "tenant-a", rsid: "rsid-a", sessionBindingId: "binding-a",
        sessionBindingVersion: 1, lifecyclePhase: "unregistered", dispatchAllowed: false,
        resumable: false, resumeExpiresAtMs: 10_000, retirementAnchorMs: 10_000,
        lastObservedNowMs: 10_000, producerState: "settled" as const,
        pendingDispatch: false, unfinishedBatch: false, activeEgressLease: false,
        unresolvedHold: false, c39Dependency: false, migrationDependency: false,
        indicesComplete: true, dependencyInventoryComplete: true, unregisterRef: null,
        dependencyRefs: [], treeRoots: [], privateObjects: [objectRef],
        plannedEntries: 0, plannedRecords: 1, plannedObjects: 1,
      };
      const decision = evaluateSessionRetention(candidate, { nowMs });
      if (decision.kind !== "eligible") throw new Error("private closure fixture is retained");
      const closure = createSessionRetentionClosure({
        candidate, decision, owner: { identity: privateObjects.ownerIdentity, epoch: privateObjects.ownerEpoch },
        preClaimRootRef: asJson({ version: 1 }), preClaimMarkerRef: asJson({ version: 1 }),
        claimToken: "claim-private", claimExpiresAtMs: nowMs + 30_000,
      });
      await adapters.servingOwnership.protocolStore.transact({ tenantId: "tenant-a" }, async (tx) => {
        await history.claimRetention(tx, { tenantId: "tenant-a", rsid: "rsid-a", closure, updatedAtMs: nowMs });
      });
      for (let pass = 0; pass < 2; pass += 1) {
        const result = await adapters.servingOwnership.protocolStore.transact({ tenantId: "tenant-a" }, async (tx) =>
          await history.deleteRetentionPageBatch(tx, {
            tenantId: "tenant-a", rsid: "rsid-a", claimToken: "claim-private",
            ownerIdentity: privateObjects.ownerIdentity, ownerEpoch: privateObjects.ownerEpoch,
            updatedAtMs: nowMs + pass + 1,
            maxOperations: 64,
            servingOwnership: adapters.servingOwnership, privateObjects,
          }));
        expect(result.ok).toBe(true);
      }
      await expect(privateObjects.getOptional(descriptor.binding)).resolves.toStrictEqual({ ok: true, value: null });
      const settled = await adapters.servingOwnership.protocolStore.transact(
        { tenantId: "tenant-a" },
        async (tx) => ({
          intent: await tx.read(descriptor.intentNamespace, descriptor.intentKey),
          root: await history.readAuthoritative(tx, "tenant-a", "rsid-a"),
        }),
      );
      expect(settled.ok && settled.value.intent).toBeNull();
      expect(settled.ok && settled.value.root?.value.retentionClosure).toMatchObject({
        cursor: { blobSlotIndex: 1 },
        counts: { deletedObjects: 1, positiveAbsences: 1, deletedRecords: 1 },
      });
    } finally {
      await adapters.servingOwnership.protocolStore.close();
    }
  });
});
