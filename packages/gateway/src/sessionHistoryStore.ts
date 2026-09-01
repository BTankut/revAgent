import { createHash } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import type { GatewayJsonValue } from "./dispatch.js";
import type {
  GatewayPrivateObjectBinding,
  GatewayProtocolStore,
  OwnedPrivateObjectStorePort,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import type { GatewayServingOwnership } from "./gatewayServingOwnership.js";

export const GATEWAY_RBP_SESSION_V3_NAMESPACE = "gateway.rbp-session/v3" as const;
export const GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE =
  "gateway.rbp-session-cutover/v3" as const;
export const GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE =
  "gateway.session-history-page/v1" as const;
export const GATEWAY_SESSION_BLOB_INTENT_NAMESPACE =
  "gateway.session-blob-intent/v1" as const;
export const GATEWAY_SESSION_MIGRATION_V3_NAMESPACE =
  "gateway.rbp-session-migration/v3" as const;
export const GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE =
  "gateway.session-migration-reservation-slot/v1" as const;

export const SESSION_ROOT_MAX_BYTES = 64 * 1024;
export const SESSION_MARKER_MAX_BYTES = 16 * 1024;
export const SESSION_HISTORY_PAGE_MAX_BYTES = 512 * 1024;
export const SESSION_HISTORY_LEAF_MAX_ENTRIES = 64;
export const SESSION_HISTORY_BRANCH_MAX_REFS = 32;
export const SESSION_HISTORY_MAX_HEIGHT = 4;
export const SESSION_MAINTENANCE_MAX_WRITES = 64;
export const SESSION_MIGRATION_RESERVATION_BATCH = 63;
export const SESSION_MIGRATION_SWAP_BATCH = 31;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type SessionTreeKind =
  | "aliases"
  | "evidence"
  | "pending"
  | "receipts"
  | "outbox"
  | "conflicts"
  | "indices";

export interface SessionHistoryEntry {
  readonly key: string;
  readonly value: GatewayJsonValue;
}

export interface SessionHistoryEntryProof extends SessionHistoryEntry {
  readonly digest: `sha256:${string}`;
}

export interface SessionHistoryPageRef {
  readonly namespace: typeof GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE;
  readonly key: string;
  readonly version: number;
  readonly digest: `sha256:${string}`;
  readonly firstKey: string;
  readonly lastKey: string;
  readonly count: number;
  readonly height: number;
}

export interface SessionHistoryLeafPage {
  readonly schema: typeof GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE;
  readonly generation: 1;
  readonly tenantId: string;
  readonly rsid: string;
  readonly treeKind: SessionTreeKind;
  readonly pageId: string;
  readonly height: 1;
  readonly entries: readonly SessionHistoryEntryProof[];
}

export interface SessionHistoryBranchPage {
  readonly schema: typeof GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE;
  readonly generation: 1;
  readonly tenantId: string;
  readonly rsid: string;
  readonly treeKind: SessionTreeKind;
  readonly pageId: string;
  readonly height: number;
  readonly children: readonly SessionHistoryPageRef[];
}

export type SessionHistoryPage = SessionHistoryLeafPage | SessionHistoryBranchPage;

export interface SessionHistoryTreeRef {
  readonly treeKind: SessionTreeKind;
  readonly root: SessionHistoryPageRef | null;
  readonly entryCount: number;
}

export interface SessionHistoryPagePlan {
  readonly tree: SessionHistoryTreeRef;
  readonly pages: readonly Readonly<{
    readonly key: string;
    readonly value: SessionHistoryPage;
    readonly digest: `sha256:${string}`;
  }>[];
}

export interface SessionMigrationProofV3 {
  readonly sourceGeneration: 1 | 2 | 3;
  readonly sourceDigest: `sha256:${string}`;
  readonly equivalenceDigest: `sha256:${string}`;
  readonly targetPlanDigest: `sha256:${string}`;
  readonly sourceCleanupReceiptDigest: `sha256:${string}`;
}

export interface SessionRetentionClosureV1 {
  readonly schema: "revagent.gateway.session-gc-closure/v1";
  readonly closureId: string;
  readonly planDigest: `sha256:${string}`;
  readonly state: "claimed" | "deleting" | "proving_empty" | "complete";
  readonly eligibilityCutoffMs: number;
  readonly roots: readonly SessionHistoryTreeRef[];
  readonly objectIntents: readonly SessionRetentionObjectIntentRef[];
  readonly dependencyClosureDigest: `sha256:${string}`;
  readonly unregisterRef: SessionRetentionClosureDependencyRef | null;
  readonly dependencyRefs: readonly SessionRetentionClosureDependencyRef[];
  readonly frozenAuthority: SessionRetentionFrozenAuthority;
  readonly creator: {
    readonly ownerIdentity: string;
    readonly ownerEpoch: number;
  };
  readonly claim: {
    readonly ownerIdentity: string;
    readonly ownerEpoch: number;
    readonly token: string;
    readonly generation: number;
    readonly expiresAtMs: number;
  };
  readonly cursor: {
    readonly lane: string;
    readonly treeKind: SessionTreeKind | null;
    readonly path: readonly Readonly<{ readonly pageId: string; readonly childIndex: number }>[];
    readonly leafEntryIndex: number;
    readonly blobSlotIndex: number;
    readonly lastProcessedKey: string | null;
    readonly objectInventoryAfterKey: string | null;
  };
  readonly counts: {
    readonly plannedEntries: number;
    readonly plannedRecords: number;
    readonly plannedObjects: number;
    readonly processedEntries: number;
    readonly deletedRecords: number;
    readonly deletedObjects: number;
    readonly positiveAbsences: number;
  };
  readonly completionDigest: `sha256:${string}` | null;
}

export interface SessionRetentionClosureDependencyRef {
  readonly role: string;
  readonly namespace: string;
  readonly key: string;
  readonly version: number;
  readonly digest: `sha256:${string}`;
  readonly state: string;
}

export interface SessionRetentionFrozenAuthority {
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
  readonly lifecyclePhase: string;
  readonly dispatchAllowed: boolean;
  readonly resumable: boolean;
  readonly resumeExpiresAtMs: number;
  readonly retirementAnchorMs: number;
  readonly lastObservedNowMs: number;
  readonly producerState: "settled";
  readonly pendingDispatch: false;
  readonly unfinishedBatch: false;
  readonly activeEgressLease: false;
  readonly unresolvedHold: false;
  readonly c39Dependency: false;
  readonly migrationDependency: false;
  readonly indicesComplete: true;
  readonly dependencyInventoryComplete: true;
}

export interface SessionRetentionObjectIntentRef {
  readonly namespace: typeof GATEWAY_SESSION_BLOB_INTENT_NAMESPACE;
  readonly key: string;
  readonly version: number;
  readonly digest: `sha256:${string}`;
  readonly ownerIdentity: string;
  readonly ownerEpoch: number;
  readonly binding: GatewayPrivateObjectBinding;
}

export interface DurableRbpSessionV3 {
  readonly schema: typeof GATEWAY_RBP_SESSION_V3_NAMESPACE;
  readonly generation: 3;
  readonly rootVersion: number;
  readonly tenantId: string;
  readonly rsid: string;
  readonly identity: GatewayJsonValue;
  readonly binding: GatewayJsonValue;
  readonly lifecycle: GatewayJsonValue;
  readonly sequenceHead: GatewayJsonValue;
  readonly migrationProof: SessionMigrationProofV3;
  readonly durabilityProfile: GatewayJsonValue;
  readonly trees: readonly SessionHistoryTreeRef[];
  readonly singletonRefs: readonly SessionHistoryPageRef[];
  readonly antiDowngradeRefs: readonly SessionHistoryPageRef[];
  readonly retentionClosure: SessionRetentionClosureV1 | null;
  readonly retiredAuthorityDigest: `sha256:${string}` | null;
  readonly completionDigest: `sha256:${string}` | null;
}

export interface DurableSessionCutoverV3 {
  readonly schema: typeof GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE;
  readonly generation: 3;
  readonly tenantId: string;
  readonly rsid: string;
  readonly rootVersion: number;
  readonly rootDigest: `sha256:${string}`;
  readonly treesDigest: `sha256:${string}`;
  readonly migratedAtMs: number;
}

export interface SessionMigrationTargetRecord {
  readonly namespace: string;
  readonly key: string;
  readonly expect: StoreExpectation;
  readonly value: GatewayJsonValue;
  readonly role: "target_record" | "new_permanent_sentinel";
  readonly mutableMaxBytes?: number;
}

export interface SessionMigrationPrivateObjectPlan {
  readonly purpose: string;
  readonly owner: string;
  readonly blobId: string;
  readonly storageKey: string;
  readonly byteLength: number;
  readonly digest: `sha256:${string}`;
  readonly contentType: string;
}

export interface SessionMigrationReservationSlot {
  readonly schema: typeof GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly migrationId: string;
  readonly ordinal: number;
  readonly targetNamespace: string;
  readonly targetKey: string;
  readonly targetExpectation: StoreExpectation;
  readonly targetValueByteLength: number;
  readonly targetValueDigest: `sha256:${string}`;
  readonly role: SessionMigrationTargetRecord["role"];
  readonly reservedValueByteLength: number;
  readonly padding: string;
}

export interface SessionMigrationCapacityPlan {
  readonly version: 1;
  readonly tenantId: string;
  readonly rsid: string;
  readonly migrationId: string;
  readonly sourceSnapshotDigest: `sha256:${string}`;
  readonly planDigest: `sha256:${string}`;
  readonly orderedTargets: readonly Readonly<{
    readonly ordinal: number;
    readonly namespace: string;
    readonly key: string;
    readonly expectation: StoreExpectation;
    readonly valueByteLength: number;
    readonly valueDigest: `sha256:${string}`;
    readonly role: SessionMigrationTargetRecord["role"];
  }>[];
  readonly orderedPrivateObjects: readonly SessionMigrationPrivateObjectPlan[];
  readonly orderedMutableMaxima: readonly Readonly<{
    readonly namespace: string;
    readonly key: string;
    readonly reservedMaxBytes: number;
  }>[];
  readonly totals: {
    readonly targetRecordCount: number;
    readonly targetRecordValueBytes: number;
    readonly targetPrivateObjectCount: number;
    readonly targetPrivateObjectBytes: number;
    readonly sentinelNewRecordCount: number;
    readonly slotCount: number;
    readonly slotValueBytes: number;
  };
  readonly slots: readonly SessionMigrationReservationSlot[];
}

export interface SessionV3AuditProjection {
  readonly status: "no_candidate" | "candidate" | "multiple" | "not_current";
  readonly candidateCount: 0 | 1 | 2;
  readonly tenantId: string | null;
  readonly rsid: string | null;
  readonly rootVersion: number | null;
  readonly rootDigest: `sha256:${string}` | null;
  readonly treesDigest: `sha256:${string}` | null;
  readonly retired: boolean;
  readonly readiness: Readonly<{
    readonly binding: string;
    readonly sessionBindingId: string;
    readonly sessionVersion: number;
    readonly connectionId: string;
    readonly localSessionKey: string;
    readonly phase: string;
    readonly dispatchAllowed: boolean;
    readonly sessionGrantedCapabilities: readonly string[];
    readonly connectionGrantedCapabilities: readonly string[];
    readonly liveDocumentRoute: Readonly<{
      readonly sessionDocumentId: string;
    }> | null;
  }> | null;
}

export interface SessionBlobIntentV1 {
  readonly schema: typeof GATEWAY_SESSION_BLOB_INTENT_NAMESPACE;
  readonly state: "writing" | "active" | "deleting";
  readonly tenantId: string;
  readonly rsid: string;
  readonly purpose: GatewayPrivateObjectBinding["purpose"];
  readonly ownerIdentity: string;
  readonly ownerEpoch: number;
  readonly binding: GatewayPrivateObjectBinding;
  readonly deletionClaim: Readonly<{ readonly id: string; readonly version: number }> | null;
}

export interface SessionBlobDescriptorV1 {
  readonly schema: "revagent.gateway.session-blob-descriptor/v1";
  readonly intentNamespace: typeof GATEWAY_SESSION_BLOB_INTENT_NAMESPACE;
  readonly intentKey: string;
  readonly intentVersion: number;
  readonly binding: GatewayPrivateObjectBinding;
}

function asJson(value: unknown): GatewayJsonValue {
  return value as GatewayJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sessionRecordValueBytes(value: GatewayJsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function sessionCanonicalDigest(value: GatewayJsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value as JsonValue))
    .digest("hex")}`;
}

export function sessionPrivateStorageKey(input: {
  readonly tenantId: string;
  readonly rsid: string;
  readonly purpose: GatewayPrivateObjectBinding["purpose"];
  readonly digest: `sha256:${string}`;
}): `sha256:${string}` {
  if (!boundedToken(input.tenantId) || !boundedToken(input.rsid) ||
      !DIGEST_PATTERN.test(input.digest)) {
    throw new Error("private session storage identity is invalid");
  }
  return sessionCanonicalDigest(asJson({
    domain: "revagent/gateway/session-private-object-storage-key/v1",
    tenantId: input.tenantId,
    rsid: input.rsid,
    purpose: input.purpose,
    digest: input.digest,
  }));
}

function boundedToken(value: string, maxBytes = 512): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function pageId(input: {
  readonly tenantId: string;
  readonly rsid: string;
  readonly treeKind: SessionTreeKind;
  readonly height: number;
  readonly ordinal: number;
  readonly firstKey: string;
  readonly lastKey: string;
}): string {
  return `p-${createHash("sha256")
    .update("revagent/gateway/session-history-page-id/v1\0")
    .update(JSON.stringify(input))
    .digest("hex")}`;
}

function pageRef(
  key: string,
  value: SessionHistoryPage,
  version = 1,
): SessionHistoryPageRef {
  const entries = "entries" in value ? value.entries : value.children;
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) throw new Error("history page is empty");
  const firstKey = "entries" in value
    ? value.entries[0]!.key
    : value.children[0]!.firstKey;
  const lastKey = "entries" in value
    ? value.entries[value.entries.length - 1]!.key
    : value.children[value.children.length - 1]!.lastKey;
  return Object.freeze({
    namespace: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
    key,
    version,
    digest: sessionCanonicalDigest(asJson(value)),
    firstKey,
    lastKey,
    count: "entries" in value
      ? value.entries.length
      : value.children.reduce((sum, child) => sum + child.count, 0),
    height: value.height,
  });
}

export function buildSessionHistoryPagePlan(input: {
  readonly tenantId: string;
  readonly rsid: string;
  readonly treeKind: SessionTreeKind;
  readonly entries: readonly SessionHistoryEntry[];
}): SessionHistoryPagePlan {
  if (!boundedToken(input.tenantId) || !boundedToken(input.rsid)) {
    throw new Error("session history identity is invalid");
  }
  const sorted = [...input.entries].sort((left, right) => left.key.localeCompare(right.key));
  if (sorted.some((entry, index) => !boundedToken(entry.key) ||
      (index > 0 && sorted[index - 1]!.key === entry.key))) {
    throw new Error("session history keys are invalid or duplicated");
  }
  if (sorted.length === 0) {
    return Object.freeze({
      tree: Object.freeze({ treeKind: input.treeKind, root: null, entryCount: 0 }),
      pages: Object.freeze([]),
    });
  }

  const pages: Array<Readonly<{
    readonly key: string;
    readonly value: SessionHistoryPage;
    readonly digest: `sha256:${string}`;
  }>> = [];
  let level: SessionHistoryPageRef[] = [];
  for (let offset = 0; offset < sorted.length; offset += SESSION_HISTORY_LEAF_MAX_ENTRIES) {
    const slice = sorted.slice(offset, offset + SESSION_HISTORY_LEAF_MAX_ENTRIES);
    const proofs = slice.map((entry) => Object.freeze({
      ...entry,
      digest: sessionCanonicalDigest(entry.value),
    }));
    const id = pageId({
      tenantId: input.tenantId,
      rsid: input.rsid,
      treeKind: input.treeKind,
      height: 1,
      ordinal: offset / SESSION_HISTORY_LEAF_MAX_ENTRIES,
      firstKey: slice[0]!.key,
      lastKey: slice[slice.length - 1]!.key,
    });
    const value: SessionHistoryLeafPage = Object.freeze({
      schema: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
      generation: 1,
      tenantId: input.tenantId,
      rsid: input.rsid,
      treeKind: input.treeKind,
      pageId: id,
      height: 1,
      entries: Object.freeze(proofs),
    });
    if (sessionRecordValueBytes(asJson(value)) > SESSION_HISTORY_PAGE_MAX_BYTES) {
      throw new Error("session history leaf exceeds its encoded cap");
    }
    const key = `${input.rsid}/${input.treeKind}/${id}`;
    const ref = pageRef(key, value);
    pages.push(Object.freeze({ key, value, digest: ref.digest }));
    level.push(ref);
  }

  let height = 2;
  while (level.length > 1) {
    if (height > SESSION_HISTORY_MAX_HEIGHT) {
      throw new Error("session history tree exceeds its height cap");
    }
    const next: SessionHistoryPageRef[] = [];
    for (let offset = 0; offset < level.length; offset += SESSION_HISTORY_BRANCH_MAX_REFS) {
      const children = level.slice(offset, offset + SESSION_HISTORY_BRANCH_MAX_REFS);
      const id = pageId({
        tenantId: input.tenantId,
        rsid: input.rsid,
        treeKind: input.treeKind,
        height,
        ordinal: offset / SESSION_HISTORY_BRANCH_MAX_REFS,
        firstKey: children[0]!.firstKey,
        lastKey: children[children.length - 1]!.lastKey,
      });
      const value: SessionHistoryBranchPage = Object.freeze({
        schema: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
        generation: 1,
        tenantId: input.tenantId,
        rsid: input.rsid,
        treeKind: input.treeKind,
        pageId: id,
        height,
        children: Object.freeze(children),
      });
      if (sessionRecordValueBytes(asJson(value)) > SESSION_HISTORY_PAGE_MAX_BYTES) {
        throw new Error("session history branch exceeds its encoded cap");
      }
      const key = `${input.rsid}/${input.treeKind}/${id}`;
      const ref = pageRef(key, value);
      pages.push(Object.freeze({ key, value, digest: ref.digest }));
      next.push(ref);
    }
    level = next;
    height += 1;
  }
  return Object.freeze({
    tree: Object.freeze({
      treeKind: input.treeKind,
      root: level[0]!,
      entryCount: sorted.length,
    }),
    pages: Object.freeze(pages),
  });
}

function exactPaddingSlot(input: Omit<SessionMigrationReservationSlot, "reservedValueByteLength" | "padding"> & {
  readonly minimumBytes: number;
}): SessionMigrationReservationSlot {
  const { minimumBytes, ...fixed } = input;
  let reservedValueByteLength = input.minimumBytes;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const base = {
      ...fixed,
      reservedValueByteLength,
      padding: "",
    } as unknown as SessionMigrationReservationSlot;
    const baseBytes = sessionRecordValueBytes(asJson(base));
    const next = Math.max(minimumBytes, baseBytes);
    if (next === reservedValueByteLength) {
      const padding = "x".repeat(reservedValueByteLength - baseBytes);
      const slot = Object.freeze({ ...base, padding });
      if (sessionRecordValueBytes(asJson(slot)) !== reservedValueByteLength) {
        throw new Error("migration reservation padding is not exact");
      }
      return slot;
    }
    reservedValueByteLength = next;
  }
  throw new Error("migration reservation size did not converge");
}

export function planSessionMigrationCapacity(input: {
  readonly tenantId: string;
  readonly rsid: string;
  readonly migrationId: string;
  readonly sourceSnapshotDigest: `sha256:${string}`;
  readonly targets: readonly SessionMigrationTargetRecord[];
  readonly privateObjects: readonly SessionMigrationPrivateObjectPlan[];
}): SessionMigrationCapacityPlan {
  if (!boundedToken(input.tenantId) || !boundedToken(input.rsid) ||
      !boundedToken(input.migrationId) || !DIGEST_PATTERN.test(input.sourceSnapshotDigest)) {
    throw new Error("migration capacity identity is invalid");
  }
  const targets = [...input.targets].sort((left, right) =>
    left.namespace.localeCompare(right.namespace) || left.key.localeCompare(right.key));
  const targetIds = new Set<string>();
  const orderedTargets = targets.map((target, ordinal) => {
    const id = `${target.namespace}\u0000${target.key}`;
    if (targetIds.has(id) || !boundedToken(target.namespace) || !boundedToken(target.key)) {
      throw new Error("migration target is duplicated or invalid");
    }
    targetIds.add(id);
    const valueByteLength = sessionRecordValueBytes(target.value);
    const reserved = Math.max(valueByteLength, target.mutableMaxBytes ?? valueByteLength);
    if (reserved > 2 * 1024 * 1024) throw new Error("migration target exceeds record cap");
    return Object.freeze({
      ordinal,
      namespace: target.namespace,
      key: target.key,
      expectation: target.expect,
      valueByteLength,
      valueDigest: sessionCanonicalDigest(target.value),
      role: target.role,
      reserved,
    });
  });
  const privateObjects = [...input.privateObjects].sort((left, right) =>
    left.purpose.localeCompare(right.purpose) || left.storageKey.localeCompare(right.storageKey));
  if (privateObjects.some((value, index) => !DIGEST_PATTERN.test(value.digest) ||
      value.byteLength < 0 || value.byteLength > 48 * 1024 * 1024 ||
      (index > 0 && privateObjects[index - 1]!.storageKey === value.storageKey))) {
    throw new Error("migration private-object plan is invalid");
  }
  const orderedMutableMaxima = orderedTargets
    .map((target) => Object.freeze({
      namespace: target.namespace,
      key: target.key,
      reservedMaxBytes: target.reserved,
    }));
  const plannedTargets = Object.freeze(orderedTargets.map((target) => ({
    ordinal: target.ordinal,
    namespace: target.namespace,
    key: target.key,
    expectation: target.expectation,
    valueByteLength: target.valueByteLength,
    valueDigest: target.valueDigest,
    role: target.role,
  })));
  const digestInput = Object.freeze({
    domain: "revagent/gateway/session-migration-capacity-plan/v1",
    tenantId: input.tenantId,
    rsid: input.rsid,
    migrationId: input.migrationId,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    orderedTargets: plannedTargets,
    orderedPrivateObjects: privateObjects,
    orderedMutableMaxima,
    totals: {
      targetRecordCount: orderedTargets.length,
      targetRecordValueBytes: orderedTargets.reduce((sum, target) => sum + target.valueByteLength, 0),
      targetPrivateObjectCount: privateObjects.length,
      targetPrivateObjectBytes: privateObjects.reduce((sum, value) => sum + value.byteLength, 0),
      sentinelNewRecordCount: orderedTargets.filter((target) => target.role === "new_permanent_sentinel").length,
    },
  });
  const planDigest = sessionCanonicalDigest(asJson(digestInput));
  const slots = orderedTargets.map((target) => exactPaddingSlot({
    schema: GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE,
    tenantId: input.tenantId,
    rsid: input.rsid,
    migrationId: input.migrationId,
    ordinal: target.ordinal,
    targetNamespace: target.namespace,
    targetKey: target.key,
    targetExpectation: target.expectation,
    targetValueByteLength: target.valueByteLength,
    targetValueDigest: target.valueDigest,
    role: target.role,
    minimumBytes: target.reserved,
  }));
  return Object.freeze({
    version: 1,
    tenantId: input.tenantId,
    rsid: input.rsid,
    migrationId: input.migrationId,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    planDigest,
    orderedTargets: plannedTargets,
    orderedPrivateObjects: Object.freeze(privateObjects),
    orderedMutableMaxima: Object.freeze(orderedMutableMaxima),
    totals: Object.freeze({
      ...digestInput.totals,
      slotCount: slots.length,
      slotValueBytes: slots.reduce((sum, slot) => sum + slot.reservedValueByteLength, 0),
    }),
    slots: Object.freeze(slots),
  });
}

export function stageMigrationReservationBatch(
  tx: StoreTransaction,
  plan: SessionMigrationCapacityPlan,
  afterOrdinal: number,
): number {
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1) {
    throw new Error("migration reservation cursor is invalid");
  }
  const batch = plan.slots
    .filter((slot) => slot.ordinal > afterOrdinal)
    .slice(0, SESSION_MIGRATION_RESERVATION_BATCH);
  for (const slot of batch) {
    tx.stage({
      namespace: GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE,
      key: `${plan.rsid}/${plan.migrationId}/${String(slot.ordinal).padStart(4, "0")}`,
      value: asJson(slot),
      expect: { kind: "absent" },
    });
  }
  return batch.length === 0 ? afterOrdinal : batch[batch.length - 1]!.ordinal;
}

export function verifyMigrationReservationInventory(
  rows: readonly StoredRecord<GatewayJsonValue>[],
  plan: SessionMigrationCapacityPlan,
  consumedOrdinals: ReadonlySet<number> = new Set(),
): void {
  const expected = plan.slots.filter((slot) => !consumedOrdinals.has(slot.ordinal));
  const scoped = rows.filter((row) =>
    row.namespace === GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE &&
    row.tenantId === plan.tenantId &&
    row.key.startsWith(`${plan.rsid}/${plan.migrationId}/`));
  if (scoped.length !== expected.length) {
    throw new Error("migration reservation inventory cardinality changed");
  }
  for (const slot of expected) {
    const key = `${plan.rsid}/${plan.migrationId}/${String(slot.ordinal).padStart(4, "0")}`;
    const matches = scoped.filter((row) => row.key === key);
    if (matches.length !== 1 || matches[0]!.version < 1 ||
        sessionRecordValueBytes(matches[0]!.value) !== slot.reservedValueByteLength ||
        JSON.stringify(matches[0]!.value) !== JSON.stringify(slot)) {
      throw new Error("migration reservation inventory proof changed");
    }
  }
}

export function stageMigrationSlotSwaps(
  tx: StoreTransaction,
  input: {
    readonly plan: SessionMigrationCapacityPlan;
    readonly targets: readonly SessionMigrationTargetRecord[];
    readonly afterOrdinal: number;
  },
): number {
  const byId = new Map(input.targets.map((target) =>
    [`${target.namespace}\u0000${target.key}`, target]));
  const batch = input.plan.orderedTargets
    .filter((target) => target.ordinal > input.afterOrdinal)
    .slice(0, SESSION_MIGRATION_SWAP_BATCH);
  for (const planned of batch) {
    const target = byId.get(`${planned.namespace}\u0000${planned.key}`);
    if (target === undefined || sessionCanonicalDigest(target.value) !== planned.valueDigest ||
        sessionRecordValueBytes(target.value) !== planned.valueByteLength) {
      throw new Error("migration target no longer matches its capacity plan");
    }
    tx.stage({
      namespace: GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE,
      key: `${input.plan.rsid}/${input.plan.migrationId}/${String(planned.ordinal).padStart(4, "0")}`,
      value: null,
      expect: { kind: "any" },
    });
    tx.stage({
      namespace: planned.namespace,
      key: planned.key,
      value: target.value,
      expect: target.expect,
    });
  }
  return batch.length === 0 ? input.afterOrdinal : batch[batch.length - 1]!.ordinal;
}

export class SessionPrivateBlobStore {
  public constructor(
    readonly protocolStore: GatewayProtocolStore,
    readonly servingOwnership: GatewayServingOwnership,
    readonly privateObjects: OwnedPrivateObjectStorePort,
  ) {}

  public async spill(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly purpose: GatewayPrivateObjectBinding["purpose"];
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<SessionBlobDescriptorV1> {
    const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` as const;
    const storageKey = sessionPrivateStorageKey({
      tenantId: input.tenantId,
      rsid: input.rsid,
      purpose: input.purpose,
      digest,
    });
    const binding: GatewayPrivateObjectBinding = Object.freeze({
      tenantId: input.tenantId,
      rsid: input.rsid,
      purpose: input.purpose,
      storageKey,
      byteLength: input.bytes.byteLength,
      digest,
      contentType: input.contentType,
    });
    if (binding.byteLength <= 65_536 ||
        binding.byteLength > this.privateObjects.maxObjectBytes ||
        !this.privateObjects.isCurrent()) {
      throw new Error("private session blob is outside the spill domain");
    }
    const intentKey = `${input.rsid}/${input.purpose}/${digest.slice(7)}`;
    const intended: SessionBlobIntentV1 = Object.freeze({
      schema: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
      state: "writing" as const,
      tenantId: input.tenantId,
      rsid: input.rsid,
      purpose: input.purpose,
      ownerIdentity: this.privateObjects.ownerIdentity,
      ownerEpoch: this.privateObjects.ownerEpoch,
      binding,
      deletionClaim: null,
    });
    const reserved = await this.protocolStore.transact({ tenantId: input.tenantId }, async (tx) => {
      const prior = await tx.read<GatewayJsonValue>(GATEWAY_SESSION_BLOB_INTENT_NAMESPACE, intentKey);
      if (prior === null) {
        tx.stage({
          namespace: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
          key: intentKey,
          value: asJson(intended),
          expect: { kind: "absent" },
        });
        return Object.freeze({ version: 1, value: intended });
      }
      const value = prior.value as unknown as SessionBlobIntentV1;
      if (value.schema !== GATEWAY_SESSION_BLOB_INTENT_NAMESPACE ||
          value.tenantId !== input.tenantId || value.rsid !== input.rsid ||
          value.purpose !== input.purpose ||
          JSON.stringify(value.binding) !== JSON.stringify(binding) ||
          value.state === "deleting") {
        throw new Error("private session blob intent conflicts");
      }
      return Object.freeze({ version: prior.version, value });
    });
    if (!reserved.ok) throw new Error(reserved.message);
    const ticket = this.servingOwnership.mintPrivateObjectIntent({
      binding,
      intentNamespace: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
      intentKey,
      intentVersion: reserved.value.version,
    });
    const stored = await this.privateObjects.put(ticket, input.bytes);
    if (!stored.ok || stored.value.storageKey !== binding.storageKey) {
      throw new Error("private session blob write is unavailable");
    }
    const verified = await this.privateObjects.get(binding);
    if (!verified.ok || verified.value.bytes.byteLength !== binding.byteLength) {
      throw new Error("private session blob readback is unavailable");
    }
    const activated = await this.protocolStore.transact({ tenantId: input.tenantId }, async (tx) => {
      const current = await tx.read<GatewayJsonValue>(GATEWAY_SESSION_BLOB_INTENT_NAMESPACE, intentKey);
      if (current === null) throw new Error("private session blob intent disappeared");
      const value = current.value as unknown as SessionBlobIntentV1;
      if (JSON.stringify(value.binding) !== JSON.stringify(binding) ||
          (value.state !== "writing" && value.state !== "active")) {
        throw new Error("private session blob intent changed");
      }
      if (value.state === "writing") {
        tx.stage({
          namespace: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
          key: intentKey,
          value: asJson(Object.freeze({ ...value, state: "active" as const })),
          expect: { kind: "version", version: current.version },
        });
        return current.version + 1;
      }
      return current.version;
    });
    if (!activated.ok) throw new Error(activated.message);
    return Object.freeze({
      schema: "revagent.gateway.session-blob-descriptor/v1",
      intentNamespace: GATEWAY_SESSION_BLOB_INTENT_NAMESPACE,
      intentKey,
      intentVersion: activated.value,
      binding,
    });
  }

  public async hydrate(descriptor: SessionBlobDescriptorV1): Promise<Uint8Array> {
    const intent = await this.protocolStore.transact(
      { tenantId: descriptor.binding.tenantId },
      async (tx) => await tx.read<GatewayJsonValue>(descriptor.intentNamespace, descriptor.intentKey),
    );
    if (!intent.ok || intent.value === null || intent.value.version !== descriptor.intentVersion) {
      throw new Error("private session blob descriptor is stale");
    }
    const value = intent.value.value as unknown as SessionBlobIntentV1;
    if (value.state !== "active" ||
        JSON.stringify(value.binding) !== JSON.stringify(descriptor.binding)) {
      throw new Error("private session blob intent is not active");
    }
    const result = await this.privateObjects.get(descriptor.binding);
    if (!result.ok) throw new Error("private session blob is unavailable");
    return new Uint8Array(result.value.bytes);
  }

  public async delete(descriptor: SessionBlobDescriptorV1, claimId: string): Promise<void> {
    const claimed = await this.protocolStore.transact(
      { tenantId: descriptor.binding.tenantId },
      async (tx) => {
        const current = await tx.read<GatewayJsonValue>(descriptor.intentNamespace, descriptor.intentKey);
        if (current === null) return null;
        const value = current.value as unknown as SessionBlobIntentV1;
        if (JSON.stringify(value.binding) !== JSON.stringify(descriptor.binding)) {
          throw new Error("private session blob deletion descriptor changed");
        }
        const next: SessionBlobIntentV1 = Object.freeze({
          ...value,
          state: "deleting" as const,
          deletionClaim: Object.freeze({ id: claimId, version: current.version + 1 }),
        });
        tx.stage({
          namespace: descriptor.intentNamespace,
          key: descriptor.intentKey,
          value: asJson(next),
          expect: { kind: "version", version: current.version },
        });
        return Object.freeze({ value: next, version: current.version + 1 });
      },
    );
    if (!claimed.ok) throw new Error(claimed.message);
    if (claimed.value === null) return;
    const ticket = this.servingOwnership.mintPrivateObjectIntent({
      binding: descriptor.binding,
      intentNamespace: descriptor.intentNamespace,
      intentKey: descriptor.intentKey,
      intentVersion: claimed.value.version,
    });
    const removed = await this.privateObjects.delete(ticket);
    if (!removed.ok) throw new Error("private session blob deletion is unavailable");
    const absent = await this.privateObjects.getOptional(descriptor.binding);
    if (!absent.ok || absent.value !== null) {
      throw new Error("private session blob positive absence was not proved");
    }
    const finalized = await this.protocolStore.transact(
      { tenantId: descriptor.binding.tenantId },
      async (tx) => {
        const current = await tx.read<GatewayJsonValue>(descriptor.intentNamespace, descriptor.intentKey);
        if (current === null) return;
        const value = current.value as unknown as SessionBlobIntentV1;
        if (value.state !== "deleting" || value.deletionClaim?.id !== claimId ||
            JSON.stringify(value.binding) !== JSON.stringify(descriptor.binding)) {
          throw new Error("private session blob deletion claim changed");
        }
        tx.stage({
          namespace: descriptor.intentNamespace,
          key: descriptor.intentKey,
          value: null,
          expect: { kind: "version", version: current.version },
        });
      },
    );
    if (!finalized.ok) throw new Error(finalized.message);
  }
}

function parsePage(
  stored: StoredRecord<GatewayJsonValue>,
  expected: SessionHistoryPageRef,
  tenantId: string,
  rsid: string,
  treeKind: SessionTreeKind,
): SessionHistoryPage {
  const value = stored.value as unknown as SessionHistoryPage;
  if (stored.namespace !== expected.namespace || stored.key !== expected.key ||
      stored.tenantId !== tenantId || stored.version !== expected.version ||
      !value || value.schema !== GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE ||
      value.generation !== 1 || value.tenantId !== tenantId || value.rsid !== rsid ||
      value.treeKind !== treeKind || value.pageId.length === 0 ||
      sessionCanonicalDigest(stored.value) !== expected.digest ||
      sessionRecordValueBytes(stored.value) > SESSION_HISTORY_PAGE_MAX_BYTES) {
    throw new Error("session history page proof is stale or malformed");
  }
  return value;
}

export class SessionHistoryStore {
  public constructor(readonly store: GatewayProtocolStore) {}

  public async readTree(
    tx: Pick<StoreTransaction, "read">,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly tree: SessionHistoryTreeRef;
    },
  ): Promise<readonly SessionHistoryEntry[]> {
    if (input.tree.root === null) return Object.freeze([]);
    const output: SessionHistoryEntry[] = [];
    const visit = async (ref: SessionHistoryPageRef): Promise<void> => {
      const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (stored === null) throw new Error("session history page is missing");
      const page = parsePage(stored, ref, input.tenantId, input.rsid, input.tree.treeKind);
      if ("entries" in page) {
        for (const entry of page.entries) {
          if (sessionCanonicalDigest(entry.value) !== entry.digest) {
            throw new Error("session history entry digest is invalid");
          }
          output.push(Object.freeze({ key: entry.key, value: entry.value }));
        }
      } else {
        for (const child of page.children) await visit(child);
      }
    };
    await visit(input.tree.root);
    if (output.length !== input.tree.entryCount ||
        output.some((entry, index) => index > 0 && output[index - 1]!.key >= entry.key)) {
      throw new Error("session history tree cardinality or order is invalid");
    }
    return Object.freeze(output);
  }

  public async readAuthoritative(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
  ): Promise<Readonly<{
    readonly root: StoredRecord<GatewayJsonValue>;
    readonly value: DurableRbpSessionV3;
    readonly marker: StoredRecord<GatewayJsonValue>;
  }> | null> {
    const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, rsid);
    if (marker === null) return null;
    const root = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_V3_NAMESPACE, rsid);
    if (root === null) throw new Error("v3 session marker has no root");
    const value = root.value as unknown as DurableRbpSessionV3;
    const cutover = marker.value as unknown as DurableSessionCutoverV3;
    if (!value || value.schema !== GATEWAY_RBP_SESSION_V3_NAMESPACE || value.generation !== 3 ||
        value.tenantId !== tenantId || value.rsid !== rsid ||
        !cutover || cutover.schema !== GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE ||
        cutover.generation !== 3 || cutover.tenantId !== tenantId || cutover.rsid !== rsid ||
        cutover.rootVersion !== value.rootVersion ||
        cutover.rootDigest !== sessionCanonicalDigest(root.value) ||
        cutover.treesDigest !== sessionCanonicalDigest(asJson(value.trees)) ||
        sessionRecordValueBytes(root.value) > SESSION_ROOT_MAX_BYTES ||
        sessionRecordValueBytes(marker.value) > SESSION_MARKER_MAX_BYTES) {
      throw new Error("v3 root/marker proof is malformed or stale");
    }
    return Object.freeze({ root, value, marker });
  }

  public async stageNew(
    tx: StoreTransaction,
    input: {
      readonly root: DurableRbpSessionV3;
      readonly pagePlans: readonly SessionHistoryPagePlan[];
      readonly migratedAtMs: number;
    },
  ): Promise<void> {
    const pages = input.pagePlans.flatMap((plan) => plan.pages);
    if (pages.length + 2 > 128) throw new Error("initial v3 write requires bounded migration");
    for (const page of pages) {
      tx.stage({
        namespace: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
        key: page.key,
        value: asJson(page.value),
        expect: { kind: "absent" },
      });
    }
    if (sessionRecordValueBytes(asJson(input.root)) > SESSION_ROOT_MAX_BYTES) {
      throw new Error("v3 root exceeds its encoded cap");
    }
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      key: input.root.rsid,
      value: asJson(input.root),
      expect: { kind: "absent" },
    });
    const marker: DurableSessionCutoverV3 = Object.freeze({
      schema: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
      generation: 3,
      tenantId: input.root.tenantId,
      rsid: input.root.rsid,
      rootVersion: input.root.rootVersion,
      rootDigest: sessionCanonicalDigest(asJson(input.root)),
      treesDigest: sessionCanonicalDigest(asJson(input.root.trees)),
      migratedAtMs: input.migratedAtMs,
    });
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
      key: input.root.rsid,
      value: asJson(marker),
      expect: { kind: "absent" },
    });
  }

  async #stageRootMarker(
    tx: StoreTransaction,
    current: NonNullable<Awaited<ReturnType<SessionHistoryStore["readAuthoritative"]>>>,
    next: DurableRbpSessionV3,
    updatedAtMs: number,
  ): Promise<void> {
    if (sessionRecordValueBytes(asJson(next)) > SESSION_ROOT_MAX_BYTES) {
      throw new Error("v3 root exceeds its encoded cap");
    }
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_V3_NAMESPACE,
      key: next.rsid,
      value: asJson(next),
      expect: { kind: "version", version: current.root.version },
    });
    const marker: DurableSessionCutoverV3 = Object.freeze({
      schema: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
      generation: 3,
      tenantId: next.tenantId,
      rsid: next.rsid,
      rootVersion: next.rootVersion,
      rootDigest: sessionCanonicalDigest(asJson(next)),
      treesDigest: sessionCanonicalDigest(asJson(next.trees)),
      migratedAtMs: updatedAtMs,
    });
    tx.stage({
      namespace: GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
      key: next.rsid,
      value: asJson(marker),
      expect: { kind: "version", version: current.marker.version },
    });
  }

  public async claimRetention(
    tx: StoreTransaction,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly closure: SessionRetentionClosureV1;
      readonly updatedAtMs: number;
    },
  ): Promise<DurableRbpSessionV3> {
    const current = await this.readAuthoritative(tx, input.tenantId, input.rsid);
    if (current === null || current.value.retentionClosure !== null ||
        current.value.retiredAuthorityDigest !== null) {
      throw new Error("v3 retention claim is not available");
    }
    const roots = [...current.value.trees].sort((left, right) =>
      left.treeKind.localeCompare(right.treeKind));
    if (JSON.stringify(roots) !== JSON.stringify(input.closure.roots)) {
      throw new Error("v3 retention claim roots changed before CAS");
    }
    const next: DurableRbpSessionV3 = Object.freeze({
      ...current.value,
      rootVersion: current.value.rootVersion + 1,
      retentionClosure: input.closure,
    });
    await this.#stageRootMarker(tx, current, next, input.updatedAtMs);
    return next;
  }

  public async updateRetentionClaim(
    tx: StoreTransaction,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly closure: SessionRetentionClosureV1;
      readonly updatedAtMs: number;
    },
  ): Promise<DurableRbpSessionV3> {
    const current = await this.readAuthoritative(tx, input.tenantId, input.rsid);
    const prior = current?.value.retentionClosure;
    if (current === null || prior == null || prior.state === "complete" ||
        prior.planDigest !== input.closure.planDigest ||
        JSON.stringify(prior.creator) !== JSON.stringify(input.closure.creator) ||
        input.closure.claim.generation !== prior.claim.generation + 1) {
      throw new Error("v3 retention claim takeover changed its immutable plan");
    }
    const next: DurableRbpSessionV3 = Object.freeze({
      ...current.value,
      rootVersion: current.value.rootVersion + 1,
      retentionClosure: input.closure,
    });
    await this.#stageRootMarker(tx, current, next, input.updatedAtMs);
    return next;
  }

  async #capturedPages(
    tx: Pick<StoreTransaction, "read">,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly roots: readonly SessionHistoryTreeRef[];
    },
  ): Promise<Readonly<{
    readonly leaves: readonly SessionHistoryPageRef[];
    readonly branches: readonly SessionHistoryPageRef[];
  }>> {
    const leaves: SessionHistoryPageRef[] = [];
    const branches: SessionHistoryPageRef[] = [];
    const visit = async (ref: SessionHistoryPageRef, treeKind: SessionTreeKind): Promise<void> => {
      const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (stored === null) {
        // Only leaves are removed before the branch inventory is exhausted.
        if (ref.height === 1) {
          leaves.push(ref);
          return;
        }
        throw new Error("captured branch disappeared before final branch batch");
      }
      const page = parsePage(stored, ref, input.tenantId, input.rsid, treeKind);
      if ("entries" in page) leaves.push(ref);
      else {
        for (const child of page.children) await visit(child, treeKind);
        branches.push(ref);
      }
    };
    for (const tree of [...input.roots].sort((left, right) =>
      left.treeKind.localeCompare(right.treeKind))) {
      if (tree.root !== null) await visit(tree.root, tree.treeKind);
    }
    return Object.freeze({ leaves: Object.freeze(leaves), branches: Object.freeze(branches) });
  }

  public async listCapturedPageRefs(
    tx: Pick<StoreTransaction, "read">,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly roots: readonly SessionHistoryTreeRef[];
    },
  ): Promise<readonly SessionHistoryPageRef[]> {
    const captured = await this.#capturedPages(tx, input);
    return Object.freeze([...captured.leaves, ...captured.branches]);
  }

  public async deleteRetentionPageBatch(
    tx: StoreTransaction,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly claimToken: string;
      readonly ownerIdentity: string;
      readonly ownerEpoch: number;
      readonly updatedAtMs: number;
      readonly maxOperations: number;
      readonly servingOwnership?: GatewayServingOwnership;
      readonly privateObjects?: OwnedPrivateObjectStorePort;
    },
  ): Promise<Readonly<{
    readonly root: DurableRbpSessionV3;
    readonly deletedRecords: number;
    readonly processedEntries: number;
    readonly pagesExhausted: boolean;
    readonly operations: number;
  }>> {
    const current = await this.readAuthoritative(tx, input.tenantId, input.rsid);
    const closure = current?.value.retentionClosure;
    if (current === null || closure == null || closure.state === "complete" ||
        closure.claim.token !== input.claimToken ||
        closure.claim.ownerIdentity !== input.ownerIdentity ||
        closure.claim.ownerEpoch !== input.ownerEpoch) {
      throw new Error("v3 retention page claim is stale");
    }
    if (!Number.isSafeInteger(input.maxOperations) || input.maxOperations < 3 ||
        input.maxOperations > SESSION_MAINTENANCE_MAX_WRITES) {
      throw new Error("v3 retention operation budget is invalid");
    }
    const binding = isRecord(current.value.binding) ? current.value.binding : null;
    const lifecycle = isRecord(current.value.lifecycle) ? current.value.lifecycle : null;
    const sessionLifecycle = lifecycle !== null && isRecord(lifecycle.sessionLifecycle)
      ? lifecycle.sessionLifecycle
      : lifecycle;
    const frozen = closure.frozenAuthority;
    const lifecyclePhase = sessionLifecycle?.phase === "unregistered"
      ? "unregistered"
      : sessionLifecycle?.phase;
    if (binding === null || lifecycle === null || sessionLifecycle === null ||
        binding.sessionBindingId !== frozen.sessionBindingId ||
        binding.sessionVersion !== frozen.sessionBindingVersion ||
        binding.resumeExpiresAtMs !== frozen.resumeExpiresAtMs ||
        lifecyclePhase !== frozen.lifecyclePhase ||
        sessionLifecycle.dispatchAllowed !== frozen.dispatchAllowed ||
        sessionLifecycle.resumeAllowed !== frozen.resumable ||
        lifecycle.updatedAtMs !== frozen.retirementAnchorMs) {
      throw new Error("retention frozen root authority changed before deletion");
    }
    const verifyDependency = async (
      ref: SessionRetentionClosureDependencyRef,
      label: string,
    ): Promise<void> => {
      const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (stored === null || stored.version !== ref.version ||
          sessionCanonicalDigest(stored.value) !== ref.digest) {
        throw new Error(`retention captured ${label} changed or disappeared`);
      }
    };
    if (closure.unregisterRef !== null) {
      await verifyDependency(closure.unregisterRef, "unregister dependency");
    }
    for (const ref of closure.dependencyRefs) {
      await verifyDependency(ref, "dependency");
    }
    if (closure.cursor.blobSlotIndex < closure.objectIntents.length) {
      if (input.servingOwnership === undefined || input.privateObjects === undefined) {
        throw new Error("retention private object owner is unavailable");
      }
      const ref = closure.objectIntents[closure.cursor.blobSlotIndex]!;
      const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (stored === null || !isRecord(stored.value)) {
        throw new Error("retention private intent disappeared");
      }
      const intent = stored.value as unknown as SessionBlobIntentV1;
      if (intent.schema !== GATEWAY_SESSION_BLOB_INTENT_NAMESPACE ||
          intent.tenantId !== input.tenantId || intent.rsid !== input.rsid ||
          JSON.stringify(intent.binding) !== JSON.stringify(ref.binding)) {
        throw new Error("retention private intent identity changed");
      }
      if (intent.state === "active") {
        if (stored.version !== ref.version ||
            sessionCanonicalDigest(stored.value) !== ref.digest ||
            intent.ownerIdentity !== ref.ownerIdentity || intent.ownerEpoch !== ref.ownerEpoch ||
            intent.deletionClaim !== null) {
          throw new Error("retention private intent proof changed");
        }
        const nextIntent: SessionBlobIntentV1 = Object.freeze({
          ...intent,
          state: "deleting" as const,
          deletionClaim: Object.freeze({
            id: closure.claim.token,
            version: closure.claim.generation,
          }),
        });
        tx.stage({
          namespace: ref.namespace,
          key: ref.key,
          value: asJson(nextIntent),
          expect: { kind: "version", version: stored.version },
        });
        const nextClosure: SessionRetentionClosureV1 = Object.freeze({
          ...closure,
          state: "deleting" as const,
          cursor: Object.freeze({ ...closure.cursor, lane: "private_object_delete" }),
        });
        const next: DurableRbpSessionV3 = Object.freeze({
          ...current.value,
          rootVersion: current.value.rootVersion + 1,
          retentionClosure: nextClosure,
        });
        await this.#stageRootMarker(tx, current, next, input.updatedAtMs);
        return Object.freeze({
          root: next,
          deletedRecords: 0,
          processedEntries: 0,
          pagesExhausted: false,
          operations: 3,
        });
      }
      if (intent.state !== "deleting" || intent.deletionClaim?.id !== closure.claim.token ||
          intent.deletionClaim.version !== closure.claim.generation) {
        throw new Error("retention private deletion claim changed");
      }
      const ticket = input.servingOwnership.mintPrivateObjectIntent({
        binding: intent.binding,
        intentNamespace: ref.namespace,
        intentKey: ref.key,
        intentVersion: stored.version,
      });
      const deleted = await input.privateObjects.delete(ticket);
      if (!deleted.ok) throw new Error("retention private delete is unavailable");
      const absent = await input.privateObjects.getOptional(intent.binding);
      if (!absent.ok || absent.value !== null) {
        throw new Error("retention private positive absence is unavailable");
      }
      tx.stage({
        namespace: ref.namespace,
        key: ref.key,
        value: null,
        expect: { kind: "version", version: stored.version },
      });
      const nextClosure: SessionRetentionClosureV1 = Object.freeze({
        ...closure,
        state: "deleting" as const,
        cursor: Object.freeze({
          ...closure.cursor,
          lane: "private_pending_bytes",
          blobSlotIndex: closure.cursor.blobSlotIndex + 1,
          lastProcessedKey: ref.key,
        }),
        counts: Object.freeze({
          ...closure.counts,
          deletedRecords: closure.counts.deletedRecords + 1,
          deletedObjects: closure.counts.deletedObjects + 1,
          positiveAbsences: closure.counts.positiveAbsences + 1,
        }),
      });
      const next: DurableRbpSessionV3 = Object.freeze({
        ...current.value,
        rootVersion: current.value.rootVersion + 1,
        retentionClosure: nextClosure,
      });
      await this.#stageRootMarker(tx, current, next, input.updatedAtMs);
      return Object.freeze({
        root: next,
        deletedRecords: 1,
        processedEntries: 0,
        pagesExhausted: false,
        operations: 3,
      });
    }
    const captured = await this.#capturedPages(tx, {
      tenantId: input.tenantId,
      rsid: input.rsid,
      roots: closure.roots,
    });
    const missingLeaves: SessionHistoryPageRef[] = [];
    const presentLeaves: Array<Readonly<{
      readonly ref: SessionHistoryPageRef;
      readonly stored: StoredRecord<GatewayJsonValue>;
    }>> = [];
    for (const ref of captured.leaves) {
      const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (stored === null) missingLeaves.push(ref);
      else presentLeaves.push(Object.freeze({ ref, stored }));
    }
    const deletedPageRecords = closure.counts.deletedRecords - closure.counts.deletedObjects;
    const deletedPageEntries = missingLeaves.reduce((sum, ref) => sum + ref.count, 0);
    if (deletedPageRecords < 0 || missingLeaves.length !== deletedPageRecords ||
        deletedPageEntries !== closure.counts.processedEntries) {
      throw new Error("captured leaf absence is outside the durable completed prefix");
    }
    let deletedRecords = 0;
    let processedEntries = 0;
    let lastProcessedKey = closure.cursor.lastProcessedKey;
    const leafBatch = presentLeaves.slice(0, input.maxOperations - 2);
    for (const item of leafBatch) {
      if (item.stored.version !== item.ref.version ||
          sessionCanonicalDigest(item.stored.value) !== item.ref.digest) {
        throw new Error("captured leaf changed during retention");
      }
      tx.stage({
        namespace: item.ref.namespace,
        key: item.ref.key,
        value: null,
        expect: { kind: "version", version: item.stored.version },
      });
      deletedRecords += 1;
      processedEntries += item.ref.count;
      lastProcessedKey = item.ref.key;
    }
    const leavesExhausted = presentLeaves.length === leafBatch.length;
    if (leavesExhausted && captured.branches.length > input.maxOperations - 2 - deletedRecords) {
      throw new Error("captured branch final batch exceeds the maintenance budget");
    }
    if (leavesExhausted) {
      for (const ref of captured.branches) {
        const stored = await tx.read<GatewayJsonValue>(ref.namespace, ref.key);
        if (stored === null || stored.version !== ref.version ||
            sessionCanonicalDigest(stored.value) !== ref.digest) {
          throw new Error("captured branch changed during retention");
        }
        tx.stage({
          namespace: ref.namespace,
          key: ref.key,
          value: null,
          expect: { kind: "version", version: stored.version },
        });
        deletedRecords += 1;
        lastProcessedKey = ref.key;
      }
    }
    const nextClosure: SessionRetentionClosureV1 = Object.freeze({
      ...closure,
      state: leavesExhausted ? "proving_empty" as const : "deleting" as const,
      cursor: Object.freeze({ ...closure.cursor, lastProcessedKey }),
      counts: Object.freeze({
        ...closure.counts,
        processedEntries: closure.counts.processedEntries + processedEntries,
        deletedRecords: closure.counts.deletedRecords + deletedRecords,
      }),
    });
    const next: DurableRbpSessionV3 = Object.freeze({
      ...current.value,
      rootVersion: current.value.rootVersion + 1,
      retentionClosure: nextClosure,
    });
    await this.#stageRootMarker(tx, current, next, input.updatedAtMs);
    return Object.freeze({
      root: next,
      deletedRecords,
      processedEntries,
      pagesExhausted: leavesExhausted,
      operations: deletedRecords + 2,
    });
  }

  public async finalizeRetiredRoot(
    tx: StoreTransaction,
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly claimToken: string;
      readonly retiredBinding: GatewayJsonValue;
      readonly retiredLifecycle: GatewayJsonValue;
      readonly retiredSequenceHead: GatewayJsonValue;
      readonly closureReceipt: GatewayJsonValue;
      readonly dependencyClosureDigest: `sha256:${string}`;
      readonly retiredAuthorityDigest: `sha256:${string}`;
      readonly completionDigest: `sha256:${string}`;
      readonly completedAtMs: number;
    },
  ): Promise<DurableRbpSessionV3> {
    const current = await this.readAuthoritative(tx, input.tenantId, input.rsid);
    const closure = current?.value.retentionClosure;
    if (current === null || closure == null || closure.state !== "proving_empty" ||
        closure.claim.token !== input.claimToken ||
        closure.dependencyClosureDigest !== input.dependencyClosureDigest ||
        closure.counts.plannedEntries !== closure.counts.processedEntries ||
        closure.counts.plannedRecords !== closure.counts.deletedRecords ||
        closure.counts.plannedObjects !== closure.counts.deletedObjects ||
        closure.counts.positiveAbsences !== closure.counts.plannedObjects) {
      throw new Error("v3 retention final proof is incomplete");
    }
    const nextClosure: SessionRetentionClosureV1 = Object.freeze({
      ...closure,
      state: "complete" as const,
      roots: Object.freeze([]),
      objectIntents: Object.freeze([]),
      cursor: Object.freeze({
        ...closure.cursor,
        lane: "complete",
        treeKind: null,
        path: Object.freeze([]),
        leafEntryIndex: 0,
        blobSlotIndex: closure.counts.plannedObjects,
        lastProcessedKey: null,
        objectInventoryAfterKey: null,
      }),
      completionDigest: input.completionDigest,
    });
    const next: DurableRbpSessionV3 = Object.freeze({
      ...current.value,
      rootVersion: current.value.rootVersion + 1,
      binding: input.retiredBinding,
      lifecycle: input.retiredLifecycle,
      trees: Object.freeze(current.value.trees.map((tree) => Object.freeze({
        treeKind: tree.treeKind,
        root: null,
        entryCount: 0,
      }))),
      singletonRefs: Object.freeze([]),
      retentionClosure: nextClosure,
      retiredAuthorityDigest: input.retiredAuthorityDigest,
      completionDigest: input.completionDigest,
      sequenceHead: asJson({
        ...input.retiredSequenceHead as object,
        closureReceipt: input.closureReceipt,
      }),
    });
    await this.#stageRootMarker(tx, current, next, input.completedAtMs);
    return next;
  }

  public async snapshotAudit(
    tenantId: string,
    rsid: string,
    current: boolean,
  ): Promise<StoreOutcome<SessionV3AuditProjection>> {
    return await this.store.transact({ tenantId }, async (tx) => {
      const authoritative = await this.readAuthoritative(tx, tenantId, rsid);
      if (authoritative === null) {
        return Object.freeze({
          status: "no_candidate" as const,
          candidateCount: 0 as const,
          tenantId: null,
          rsid: null,
          rootVersion: null,
          rootDigest: null,
          treesDigest: null,
          retired: false,
          readiness: null,
        });
      }
      const retired = authoritative.value.retentionClosure?.state === "complete";
      if (retired) {
        return Object.freeze({
          status: current ? "candidate" as const : "not_current" as const,
          candidateCount: 1 as const,
          tenantId,
          rsid,
          rootVersion: authoritative.value.rootVersion,
          rootDigest: sessionCanonicalDigest(authoritative.root.value),
          treesDigest: sessionCanonicalDigest(asJson(authoritative.value.trees)),
          retired: true,
          readiness: null,
        });
      }
      const binding = authoritative.value.binding as Record<string, unknown>;
      const lifecycle = authoritative.value.lifecycle as Record<string, unknown>;
      const sessionLifecycle = lifecycle.sessionLifecycle as Record<string, unknown> | undefined;
      const connectionLifecycle = lifecycle.connectionLifecycle as Record<string, unknown> | undefined;
      const sessionGrants = binding.grantedCapabilities;
      const connectionGrants = connectionLifecycle?.grantedCapabilities;
      const liveDocumentRoute = lifecycle.liveDocumentRoute;
      if (typeof binding.binding !== "string" || typeof binding.sessionBindingId !== "string" ||
          !Number.isSafeInteger(binding.sessionVersion) || Number(binding.sessionVersion) < 1 ||
          typeof binding.connectionId !== "string" || sessionLifecycle === undefined ||
          typeof sessionLifecycle.localSessionKey !== "string" || typeof sessionLifecycle.phase !== "string" ||
          typeof sessionLifecycle.dispatchAllowed !== "boolean" || connectionLifecycle === undefined ||
          !Array.isArray(sessionGrants) || !sessionGrants.every((value) => typeof value === "string") ||
          !Array.isArray(connectionGrants) || !connectionGrants.every((value) => typeof value === "string")) {
        throw new Error("v3 session readiness projection is malformed");
      }
      if (liveDocumentRoute !== null && (typeof liveDocumentRoute !== "object" ||
          Array.isArray(liveDocumentRoute) ||
          typeof (liveDocumentRoute as Record<string, unknown>).sessionDocumentId !== "string")) {
        throw new Error("v3 session readiness route is malformed");
      }
      return Object.freeze({
        status: current ? "candidate" as const : "not_current" as const,
        candidateCount: 1 as const,
        tenantId,
        rsid,
        rootVersion: authoritative.value.rootVersion,
        rootDigest: sessionCanonicalDigest(authoritative.root.value),
        treesDigest: sessionCanonicalDigest(asJson(authoritative.value.trees)),
        retired: false,
        readiness: Object.freeze({
          binding: binding.binding,
          sessionBindingId: binding.sessionBindingId,
          sessionVersion: Number(binding.sessionVersion),
          connectionId: binding.connectionId,
          localSessionKey: sessionLifecycle.localSessionKey,
          phase: sessionLifecycle.phase,
          dispatchAllowed: sessionLifecycle.dispatchAllowed,
          sessionGrantedCapabilities: Object.freeze([...sessionGrants]),
          connectionGrantedCapabilities: Object.freeze([...connectionGrants]),
          liveDocumentRoute: liveDocumentRoute === null
            ? null
            : Object.freeze({
                sessionDocumentId: (liveDocumentRoute as Record<string, unknown>).sessionDocumentId as string,
              }),
        }),
      });
    });
  }
}
