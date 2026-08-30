import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  dataEnvelopeImmutableDigest,
  makeMutationHoldId,
  makeParamsDigest,
  markJournalExecuting,
  markJournalIndeterminate,
  mutationScopeKey,
  recordJournalTerminal,
  type HelloEnvelope,
  type InvokeEnvelope,
  type JsonValue,
  type MutationScope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import {
  GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
  GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE,
  GATEWAY_RBP_SESSION_V2_NAMESPACE,
  GATEWAY_RBP_UNREGISTER_NAMESPACE,
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
  type DispatchTransportHandoff,
} from "./bridgeSession.js";
import type {
  GatewayAtomicBatchExecutorRequest,
  GatewayExecutorRequest,
  GatewayJsonObject,
  GatewayJsonValue,
} from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { createPreProductionRuntimeAdapters } from "./preProductionRuntimeAdapters.js";
import {
  GatewayRecoveryAuthority,
  type GatewayBridgeEvidenceLookup,
  type GatewayBridgeCumulativeAckReceipt,
  type GatewayDurableBridgeEvidencePort,
  type GatewayRecoveryPendingDispatch,
} from "./recoveryAuthority.js";
import {
  GATEWAY_STORE_CONTRACT_VERSION,
  type GatewayProtocolStore,
  type GatewayStartupLease,
  type StoreExpectation,
  type StoreOutcome,
  type StoreTransaction,
  type StoredRecord,
} from "./store.js";
import { createMemoryObjectStore, createRestartableTestStore } from "./testAdapters.js";
import {
  GatewayServingOwnership,
  bindBundledTestServingOwnership,
} from "./gatewayServingOwnership.js";
import {
  buildSessionHistoryPagePlan,
  GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
  GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE,
  GATEWAY_SESSION_MIGRATION_V3_NAMESPACE,
  sessionCanonicalDigest,
  type SessionHistoryEntry,
  type SessionTreeKind,
} from "./sessionHistoryStore.js";

const TENANT_ID = "tenant-unregister";
const USER_ID = "user-unregister";
const DEVICE_ID = "device-unregister";
const DEVICE_TOKEN = "device-token-unregister";
const OTHER_USER_ID = "other-user-unregister";
const OTHER_DEVICE_ID = "other-device-unregister";
const OTHER_DEVICE_TOKEN = "other-device-token-unregister";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function tokenDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * RecoveryAuthority composition fixtures require a complete syntactic receipt
 * when their subject is the downstream recovery protocol rather than the
 * Bridge producer.  This helper is deliberately confined to the WP-10 import,
 * retained-origin redelivery, and legacy-only clearance scenarios below;
 * production binding, integrity, replay, and cross-scope tests must obtain
 * acceptance from GatewayBridgeSessionAuthority.inspectDispatch instead.
 */
function syntacticRecoveryAcceptanceFixture(
  pending: GatewayRecoveryPendingDispatch,
  durableSequenceVersion: number,
): GatewayBridgeCumulativeAckReceipt {
  const correlationId = pending.envelope.type === "invoke"
    ? pending.envelope.payload.invocation_id
    : pending.envelope.payload.batch_id;
  return {
    source: "durable_rbp_sequence",
    receiptVersion: 1,
    tenantId: TENANT_ID,
    rsid: pending.envelope.rsid,
    sessionBindingId: pending.sessionBindingId,
    acceptedConnectionId: pending.preparedConnectionId,
    authorizedSessionVersion: pending.authorizedSessionVersion,
    invocationId: correlationId,
    correlationId,
    proofDigest: makeParamsDigest({
      kind: "test-cumulative-ack-proof",
      envelopeDigest: pending.envelopeDigest,
      gatewaySequence: pending.gatewaySequence,
    }),
    routeSnapshotDigest: makeParamsDigest({
      kind: "test-cumulative-ack-route",
      rsid: pending.envelope.rsid,
      sessionBindingId: pending.sessionBindingId,
      connectionId: pending.preparedConnectionId,
    }),
    egressEpoch: pending.gatewaySequence - 1,
    leaseTicket: pending.gatewaySequence,
    intent: "dispatch",
    gatewaySequence: pending.gatewaySequence,
    cumulativeAck: pending.gatewaySequence,
    envelopeDigest: pending.envelopeDigest,
    durableSequenceVersion,
    acceptedAtMs: pending.preparedAtMs,
  };
}

function identity(tenantId = TENANT_ID): IdentityPort {
  return {
    kind: "fake" as const,
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside this fixture",
      };
    },
    async authenticateDevice(input) {
      const authenticatedToken = input.deviceToken === OTHER_DEVICE_TOKEN
        ? OTHER_DEVICE_TOKEN
        : DEVICE_TOKEN;
      const actor = input.deviceToken === DEVICE_TOKEN
        ? { userId: USER_ID, deviceId: DEVICE_ID, seatId: "seat-unregister" }
        : input.deviceToken === OTHER_DEVICE_TOKEN
          ? {
              userId: OTHER_USER_ID,
              deviceId: OTHER_DEVICE_ID,
              seatId: "seat-other-unregister",
            }
          : null;
      if (actor === null) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "device identity is unavailable",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: { type: "device", tenantId, ...actor },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedSessionCapabilities: ["partial_progress", "batch_atomic"],
        deviceTokenDigest: tokenDigest(authenticatedToken),
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(deviceId = DEVICE_ID): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["partial_progress", "batch_atomic"],
      bridge_version: "wp02-unregister-test",
      device_id: deviceId,
      machine: { hostname: "petrucci", os: "windows" },
      addin_versions: ["wp02-unregister-test"],
    },
  };
}

function registration(): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: "wp02-unregister-local",
      user_hint: { name: "fixture" },
      machine: {
        hostname: "petrucci",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2022", build: "fixture", pid: 4321 },
      addin_version: "wp02-unregister-test",
      result_contract_version: 1,
      session_capabilities: ["partial_progress", "batch_atomic"],
      bridge_version: "wp02-unregister-test",
      documents: [],
      port: 48884,
    },
  };
}

function unregister(
  rsid: string,
  reason: Extract<RbpEnvelope, { type: "session_unregister" }>["payload"]["reason"] = "revit_exited",
): Extract<RbpEnvelope, { type: "session_unregister" }> {
  return {
    v: 1,
    type: "session_unregister",
    id: id(),
    ts: new Date().toISOString(),
    payload: { rsid, reason },
  };
}

function resume(
  rsid: string,
  resumeToken: string,
): Extract<RbpEnvelope, { type: "session_resume" }> {
  return {
    v: 1,
    type: "session_resume",
    id: id(),
    ts: new Date().toISOString(),
    payload: { rsid, resume_token: resumeToken, last_rx_seq: 0 },
  };
}

interface TestChannel extends BridgeConnectionChannel {
  readonly frames: RbpEnvelope[];
}

function channel(
  onSend?: (frame: RbpEnvelope) => Promise<void> | void,
): TestChannel {
  const frames: RbpEnvelope[] = [];
  return {
    frames,
    async send(serialized): Promise<void> {
      const frame = JSON.parse(serialized) as RbpEnvelope;
      frames.push(frame);
      await onSend?.(frame);
    },
    async close(): Promise<void> {},
  };
}

function queuedDispatchChannel(input: {
  readonly queued: Deferred<AbortSignal>;
  readonly releaseRevalidate: Deferred<void>;
  readonly cancelled: Deferred<void>;
}): TestChannel {
  const frames: RbpEnvelope[] = [];
  return {
    frames,
    async send(serialized): Promise<void> {
      frames.push(JSON.parse(serialized) as RbpEnvelope);
    },
    sendDispatchStarted(serialized: string, handoff: DispatchTransportHandoff) {
      const started = deferred();
      const completion = deferred();
      const controller = new AbortController();
      void (async () => {
        input.queued.resolve(controller.signal);
        try {
          await input.releaseRevalidate.promise;
          await handoff.revalidate(controller.signal);
          if (controller.signal.aborted) throw new Error("test dispatch cancelled");
          frames.push(JSON.parse(serialized) as RbpEnvelope);
          started.resolve();
          completion.resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          started.reject(failure);
          completion.reject(failure);
        }
      })();
      void started.promise.catch(() => undefined);
      void completion.promise.catch(() => undefined);
      return {
        started: started.promise,
        completion: completion.promise,
        async cancel(): Promise<boolean> {
          controller.abort();
          input.cancelled.resolve();
          return await handoff.cancelBeforeStart();
        },
      };
    },
    async close(): Promise<void> {},
  };
}

function registeredFrame(channel: TestChannel): SessionRegisteredEnvelope {
  const frame = channel.frames.find(
    (candidate): candidate is SessionRegisteredEnvelope =>
      candidate.type === "session_registered",
  );
  if (frame === undefined) throw new Error("session_registered was not emitted");
  return frame;
}

async function openConnection(
  authority: GatewayBridgeSessionAuthority,
  input: {
    readonly token?: string;
    readonly deviceId?: string;
    readonly channel?: TestChannel;
  } = {},
): Promise<{ readonly connectionId: string; readonly channel: TestChannel }> {
  const openedChannel = input.channel ?? channel();
  const opened = await authority.openConnection({
    deviceToken: input.token ?? DEVICE_TOKEN,
    binding: "wss",
    hello: hello(input.deviceId ?? DEVICE_ID),
    channel: openedChannel,
  });
  return { connectionId: opened.connectionId, channel: openedChannel };
}

async function register(authority: GatewayBridgeSessionAuthority) {
  const opened = await openConnection(authority);
  await authority.receive(opened.connectionId, registration());
  const registered = registeredFrame(opened.channel);
  return {
    ...opened,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
  };
}

async function createComposedRecovery(
  store: ControlledStoreHarness,
  bridge: GatewayBridgeSessionAuthority,
  bridgeEvidence: GatewayDurableBridgeEvidencePort = bridge,
  decisionConclusion: "inconclusive" | "postcondition_verified" = "inconclusive",
): Promise<{
  readonly authority: GatewayRecoveryAuthority;
  readonly port: GatewayProtocolStore;
}> {
  const port = store.createPort();
  const opened = await port.open();
  if (!opened.ok) throw new Error(opened.message);
  return {
    port,
    authority: new GatewayRecoveryAuthority(port, {
      bridgeEvidence,
      evidenceDecision: {
        async decideEvidence() {
          return {
            kind: "decided" as const,
            conclusion: decisionConclusion,
            authorityReference: "wp02-composed-recovery",
            decisionVersion: 1,
            decidedAtMs: Date.now(),
          };
        },
      },
      clock: Date.now,
      newId: gatewayUuidV7,
    }),
  };
}

function request(
  rsid: string,
  mutating: boolean,
  mutationScope: MutationScope | null = mutating ? { kind: "session" } : null,
  invocationId = id(),
): GatewayExecutorRequest {
  const args: GatewayJsonObject = { probe: "wp02-unregister" };
  const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
    principalKey: `${TENANT_ID}:${USER_ID}`,
    transportMcpSessionId: "mcp-unregister",
    identityMcpSessionId: null,
    nowMs: Date.now(),
  });
  return {
    toolName: mutating ? "core.set_parameter" : "core.get_status",
    toolVersion: "1.0.0",
    executorMethod: mutating ? "set_element_parameter" : "get_revit_mcp_status",
    policyClass: "auto",
    mutationScopePolicy: !mutating
      ? "none"
      : mutationScope?.kind === "document" ? "document" : "session",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: `${TENANT_ID}:${USER_ID}`,
      actor: { tenantId: TENANT_ID, userId: USER_ID, role: "user" },
      gatewaySessionId: "gateway-unregister",
      oauthClientId: "oauth-unregister",
      mcpSessionId: "mcp-unregister",
      effectiveMcpRequestScope,
      rsid,
      toolName: mutating ? "core.set_parameter" : "core.get_status",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: !mutating
        ? "none"
        : mutationScope?.kind === "document" ? "document" : "session",
      mutating,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "document-unregister" },
      paramsDigest: makeParamsDigest(args as unknown as JsonValue),
      mutationScope,
      startedAtMs: Date.now(),
    },
  };
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TestWrite {
  readonly namespace: string;
  readonly key: string;
  readonly value: GatewayJsonValue | null;
  readonly expect: StoreExpectation;
}

type TestFaultMode =
  | "conflict"
  | "unavailable"
  | "durability_uncertain_applied"
  | "durability_uncertain_not_applied"
  | "durability_uncertain_applied_readback_unavailable"
  | "partial_applied";

class ControlledStoreHarness {
  readonly #records = new Map<string, StoredRecord<GatewayJsonValue>>();
  readonly #privateObjects = createMemoryObjectStore();
  readonly #faults: Array<{
    readonly mode: TestFaultMode;
    readonly predicate: (writes: readonly TestWrite[]) => boolean;
    remaining: number;
  }> = [];
  readonly #preFailures: Array<"unavailable"> = [];
  readonly #afterCommit: Array<{
    readonly predicate: (writes: readonly TestWrite[]) => boolean;
    readonly entered: Deferred;
    readonly release: Deferred;
    active: boolean;
  }> = [];
  #nextVersion = 0;
  public listCalls = 0;
  public forbidList = false;
  public readonly commits: TestWrite[][] = [];

  #recordKey(namespace: string, tenantId: string, key: string): string {
    return `${tenantId}\u0000${namespace}\u0000${key}`;
  }

  public createPort(): GatewayProtocolStore {
    let opened = false;
    let startupTail = Promise.resolve();
    let startupEpoch = 0;
    const records = this.#records;
    const port: GatewayProtocolStore = {
      kind: "memory" as const,
      contractVersion: GATEWAY_STORE_CONTRACT_VERSION,
      startupCoordinator: Object.freeze({
        contractVersion: "revagent.protocol-store-startup/v1" as const,
        async runExclusive<T>(work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> {
          const prior = startupTail;
          let release!: () => void;
          startupTail = new Promise<void>((resolve) => { release = resolve; });
          await prior;
          startupEpoch += 1;
          let current = true;
          const lease: GatewayStartupLease = Object.freeze({
            contractVersion: "revagent.protocol-store-startup-lease/v1" as const,
            identity: `unregister-test:${startupEpoch}`,
            epoch: startupEpoch,
            isCurrent: () => current,
          });
          try { return await work(lease); } finally { current = false; release(); }
        },
        async listTenantIds(limit: number): Promise<StoreOutcome<readonly string[]>> {
          const ids = [...new Set([...records.values()].map((record) => record.tenantId))].sort();
          return !opened || ids.length > limit
            ? { ok: false as const, code: "unavailable", message: "startup inventory unavailable" }
            : { ok: true as const, value: ids };
        },
        async listKeys(tenantId: string, namespace: string, limit: number): Promise<StoreOutcome<readonly string[]>> {
          const keys = [...records.values()].filter((record) => record.tenantId === tenantId && record.namespace === namespace).map((record) => record.key).sort();
          return !opened || keys.length > limit
            ? { ok: false as const, code: "unavailable", message: "startup inventory unavailable" }
            : { ok: true as const, value: keys };
        },
      }),
      async open(): Promise<StoreOutcome<void>> {
        opened = true;
        return { ok: true as const, value: undefined };
      },
      transact: async <T>(
        scope: { readonly tenantId: string },
        fn: (tx: StoreTransaction) => Promise<T> | T,
      ): Promise<StoreOutcome<T>> => {
        if (!opened) {
          return { ok: false as const, code: "unavailable", message: "closed fixture port" };
        }
        if (this.#preFailures.shift() === "unavailable") {
          return { ok: false as const, code: "unavailable", message: "injected readback failure" };
        }
        const staged: TestWrite[] = [];
        const tx: StoreTransaction = {
          read: async <TValue extends GatewayJsonValue>(namespace: string, key: string) => {
            return (this.#records.get(
              this.#recordKey(namespace, scope.tenantId, key),
            ) as StoredRecord<TValue> | undefined) ?? null;
          },
          list: async (namespace: string) => {
            this.listCalls += 1;
            if (this.forbidList) throw new Error("tenant-wide list forbidden");
            return [...this.#records.values()].filter(
              (record) =>
                record.namespace === namespace && record.tenantId === scope.tenantId,
            );
          },
          stage: (write) => {
            staged.push(structuredClone(write));
          },
        };
        let value: T;
        try {
          value = await fn(tx);
        } catch (error) {
          return {
            ok: false as const,
            code: "invalid_record",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const fault = this.#faults.find(
          (candidate) => candidate.remaining > 0 && candidate.predicate(staged),
        );
        if (fault !== undefined) {
          fault.remaining -= 1;
          if (fault.mode === "conflict" || fault.mode === "unavailable") {
            return { ok: false as const, code: fault.mode, message: `injected ${fault.mode}` };
          }
          if (fault.mode === "durability_uncertain_not_applied") {
            return {
              ok: false as const,
              code: "durability_uncertain",
              message: "injected uncertain absence",
            };
          }
        }
        for (const write of staged) {
          const existing = this.#records.get(
            this.#recordKey(write.namespace, scope.tenantId, write.key),
          );
          if (write.expect.kind === "absent" && existing !== undefined) {
            return { ok: false as const, code: "conflict", message: "expected absence" };
          }
          if (
            write.expect.kind === "version" &&
            existing?.version !== write.expect.version
          ) {
            return { ok: false as const, code: "conflict", message: "expected version" };
          }
        }
        const applied = fault?.mode === "partial_applied" ? staged.slice(0, 1) : staged;
        for (const write of applied) {
          const composite = this.#recordKey(write.namespace, scope.tenantId, write.key);
          const existing = this.#records.get(composite);
          if (write.value === null) {
            this.#records.delete(composite);
            continue;
          }
          this.#nextVersion += 1;
          this.#records.set(composite, {
            namespace: write.namespace,
            tenantId: scope.tenantId,
            key: write.key,
            value: structuredClone(write.value),
            version: (existing?.version ?? 0) + 1,
            updatedAtMs: 0,
          });
        }
        if (applied.length > 0) this.commits.push(structuredClone(applied));
        for (const barrier of this.#afterCommit) {
          if (barrier.active && barrier.predicate(staged)) {
            barrier.active = false;
            barrier.entered.resolve();
            await barrier.release.promise;
          }
        }
        if (fault?.mode === "durability_uncertain_applied_readback_unavailable") {
          this.#preFailures.push("unavailable");
        }
        if (
          fault?.mode === "durability_uncertain_applied" ||
          fault?.mode === "durability_uncertain_applied_readback_unavailable" ||
          fault?.mode === "partial_applied"
        ) {
          return {
            ok: false as const,
            code: "durability_uncertain",
            message: `injected ${fault.mode}`,
          };
        }
        return { ok: true as const, value };
      },
      async close(): Promise<StoreOutcome<void>> {
        opened = false;
        return { ok: true as const, value: undefined };
      },
    };
    bindBundledTestServingOwnership(port, new GatewayServingOwnership({
      protocolStore: port,
      privateObjectStore: this.#privateObjects,
      profile: "bundled_test",
    }));
    return port;
  }

  public armFault(
    mode: TestFaultMode,
    predicate: (writes: readonly TestWrite[]) => boolean,
    remaining = 1,
  ): void {
    this.#faults.push({ mode, predicate, remaining });
  }

  public holdAfterCommit(
    predicate: (writes: readonly TestWrite[]) => boolean,
  ): { readonly entered: Promise<void>; release(): void } {
    const entered = deferred();
    const release = deferred();
    this.#afterCommit.push({ predicate, entered, release, active: true });
    return { entered: entered.promise, release: () => release.resolve() };
  }

  public snapshot(): readonly StoredRecord<GatewayJsonValue>[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  public rewrite(
    tenantId: string,
    namespace: string,
    key: string,
    mutate: (value: GatewayJsonValue) => GatewayJsonValue,
  ): void {
    const composite = this.#recordKey(namespace, tenantId, key);
    const current = this.#records.get(composite);
    if (current === undefined && namespace === "gateway.rbp-session/v1") {
      this.#rewriteNormalizedSession(tenantId, key, mutate);
      return;
    }
    if (current === undefined) throw new Error(`missing fixture record ${namespace}/${key}`);
    this.#nextVersion += 1;
    this.#records.set(composite, {
      ...current,
      value: structuredClone(mutate(current.value)),
      version: current.version + 1,
    });
  }

  /** Migration-aware fixture seam: v1-shaped mutators are projected onto the
   * v3 root and immutable history lanes with fresh page/root/marker proofs.
   * Production never receives this compatibility view. */
  #rewriteNormalizedSession(
    tenantId: string,
    rsid: string,
    mutate: (value: GatewayJsonValue) => GatewayJsonValue,
  ): void {
    const rootKey = this.#recordKey(GATEWAY_RBP_SESSION_V3_NAMESPACE, tenantId, rsid);
    const markerKey = this.#recordKey(GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, tenantId, rsid);
    const root = this.#records.get(rootKey);
    const marker = this.#records.get(markerKey);
    if (root === undefined || marker === undefined) throw new Error(`missing v3 fixture session ${rsid}`);
    const rootValue = structuredClone(root.value) as GatewayJsonObject;
    const currentLegacy = sessionForLegacyProof(this, rsid);
    const legacy = mutate(structuredClone(currentLegacy)) as GatewayJsonObject;
    const put = (recordKey: string, record: StoredRecord<GatewayJsonValue>, value: GatewayJsonValue): StoredRecord<GatewayJsonValue> => {
      const next = { ...record, value: structuredClone(value), version: record.version + 1 };
      this.#records.set(recordKey, next);
      return next;
    };
    // A v1 oracle may intentionally omit a historical field. A v3 aggregate
    // cannot encode `undefined`, so retain the currently proved member unless
    // the mutator supplied a replacement.
    const supplied = (key: string, fallback: unknown): unknown =>
      Object.hasOwn(legacy, key) && legacy[key] !== undefined
        ? legacy[key]
        : fallback;
    const currentSequenceHead = rootValue.sequenceHead as GatewayJsonObject;
    const sequence = supplied("sequence", currentSequenceHead.sequence) as GatewayJsonObject;
    const {
      outbox: _outbox,
      acceptedInbound: _acceptedInbound,
      ...sequenceHead
    } = sequence;
    const laneValues = new Map<SessionTreeKind, readonly GatewayJsonValue[]>([
      ["evidence", (supplied("evidence", currentLegacy.evidence) as GatewayJsonValue[]) ?? []],
      ["receipts", (sequence.acceptedInbound as GatewayJsonValue[]) ?? []],
      ["outbox", (sequence.outbox as GatewayJsonValue[]) ?? []],
      ["pending", legacy.pending === null || legacy.pending === undefined
        ? []
        : [legacy.pending as GatewayJsonValue]],
      ["indices", [
        { role: "egress", value: supplied("egressFence", currentLegacy.egressFence) } as GatewayJsonValue,
        { role: "conflict-index", value: supplied("normalizedConflictIndex", currentLegacy.normalizedConflictIndex) } as GatewayJsonValue,
      ]],
    ]);
    const nextTrees: GatewayJsonObject[] = [];
    for (const treeKind of ["evidence", "receipts", "outbox", "pending", "indices"] as const) {
      const values = laneValues.get(treeKind) ?? [];
      const entries: SessionHistoryEntry[] = values.map((value, index) => ({
        key: String(index).padStart(12, "0"),
        value,
      }));
      const plan = buildSessionHistoryPagePlan({ tenantId, rsid, treeKind, entries });
      if (plan.pages.length > 1) throw new Error("fixture v3 lane exceeded one page");
      const plannedKeys = new Set(plan.pages.map((page) => page.key));
      for (const record of [...this.#records.values()]) {
        if (record.namespace !== GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE ||
            record.tenantId !== tenantId || !record.key.startsWith(`${rsid}/${treeKind}/`) ||
            plannedKeys.has(record.key)) continue;
        this.#records.delete(this.#recordKey(record.namespace, tenantId, record.key));
      }
      let rootRef: GatewayJsonObject | null = null;
      for (const page of plan.pages) {
        const pageKey = this.#recordKey(GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE, tenantId, page.key);
        const current = this.#records.get(pageKey);
        const nextVersion = (current?.version ?? 0) + 1;
        this.#records.set(pageKey, {
          namespace: GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
          tenantId,
          key: page.key,
          value: structuredClone(page.value as unknown as GatewayJsonValue),
          version: nextVersion,
          updatedAtMs: 0,
        });
        rootRef = {
          ...(plan.tree.root as unknown as GatewayJsonObject),
          version: nextVersion,
          digest: sessionCanonicalDigest(page.value as unknown as GatewayJsonValue),
        };
      }
      nextTrees.push({ treeKind, root: rootRef, entryCount: values.length });
    }
    const nextRootValue = {
      ...rootValue,
      rootVersion: Number(rootValue.rootVersion) + 1,
      identity: {
        userId: supplied("userId", (rootValue.identity as GatewayJsonObject).userId),
        deviceId: supplied("deviceId", (rootValue.identity as GatewayJsonObject).deviceId),
        seatId: supplied("seatId", (rootValue.identity as GatewayJsonObject).seatId),
        identityAuthority: supplied("identityAuthority", (rootValue.identity as GatewayJsonObject).identityAuthority),
      },
      binding: {
        sessionBindingId: supplied("sessionBindingId", (rootValue.binding as GatewayJsonObject).sessionBindingId),
        sessionVersion: supplied("sessionVersion", (rootValue.binding as GatewayJsonObject).sessionVersion),
        connectionId: supplied("connectionId", (rootValue.binding as GatewayJsonObject).connectionId),
        binding: supplied("binding", (rootValue.binding as GatewayJsonObject).binding),
        resumeTokenDigest: supplied("resumeTokenDigest", (rootValue.binding as GatewayJsonObject).resumeTokenDigest),
        resumeExpiresAtMs: supplied("resumeExpiresAtMs", (rootValue.binding as GatewayJsonObject).resumeExpiresAtMs),
        grantedCapabilities: supplied("grantedCapabilities", (rootValue.binding as GatewayJsonObject).grantedCapabilities),
      },
      lifecycle: {
        ...(rootValue.lifecycle as GatewayJsonObject),
        connectionLifecycle: supplied("connectionLifecycle", (rootValue.lifecycle as GatewayJsonObject).connectionLifecycle),
        sessionLifecycle: supplied("sessionLifecycle", (rootValue.lifecycle as GatewayJsonObject).sessionLifecycle),
        lastHeartbeatAtMs: supplied("lastHeartbeatAtMs", (rootValue.lifecycle as GatewayJsonObject).lastHeartbeatAtMs),
        liveDocumentRoute: supplied("liveDocumentRoute", (rootValue.lifecycle as GatewayJsonObject).liveDocumentRoute),
        recordVersion: supplied("recordVersion", (rootValue.lifecycle as GatewayJsonObject).recordVersion),
        createdAtMs: supplied("createdAtMs", (rootValue.lifecycle as GatewayJsonObject).createdAtMs),
        updatedAtMs: supplied("updatedAtMs", (rootValue.lifecycle as GatewayJsonObject).updatedAtMs),
      },
      sequenceHead: {
        ...currentSequenceHead,
        sequence: sequenceHead,
        d2ConformanceOriginResend: supplied(
          "d2ConformanceOriginResend",
          currentSequenceHead.d2ConformanceOriginResend,
        ),
      },
      trees: nextTrees.sort((left, right) => String(left.treeKind).localeCompare(String(right.treeKind))),
    } as GatewayJsonValue;
    const nextRoot = put(rootKey, root, nextRootValue);
    const markerValue = structuredClone(marker.value) as GatewayJsonObject;
    put(markerKey, marker, {
      ...markerValue,
      rootVersion: (nextRoot.value as GatewayJsonObject).rootVersion,
      rootDigest: sessionCanonicalDigest(nextRoot.value),
      treesDigest: sessionCanonicalDigest((nextRoot.value as GatewayJsonObject).trees as GatewayJsonValue),
    } as GatewayJsonValue);
  }

  public seed(
    tenantId: string,
    namespace: string,
    key: string,
    value: GatewayJsonValue,
  ): void {
    const composite = this.#recordKey(namespace, tenantId, key);
    if (this.#records.has(composite)) throw new Error("fixture seed collision");
    this.#nextVersion += 1;
    this.#records.set(composite, {
      namespace,
      tenantId,
      key,
      value: structuredClone(value),
      version: 1,
      updatedAtMs: 0,
    });
  }

  public remove(tenantId: string, namespace: string, key: string): void {
    this.#records.delete(this.#recordKey(namespace, tenantId, key));
  }
}

function sessionWrite(
  writes: readonly TestWrite[],
): Record<string, unknown> | null {
  const legacy = writes.find(
    (write) => write.namespace === "gateway.rbp-session/v1" && write.value !== null,
  )?.value;
  if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
    return legacy as Record<string, unknown>;
  }
  const root = writes.find(
    (write) => write.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && write.value !== null,
  )?.value as Record<string, unknown> | undefined;
  const pages = writes.filter((write) =>
    write.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE && write.value !== null,
  ).map((write) => write.value as GatewayJsonObject);
  const indices = pages.find((page) => page.treeKind === "indices");
  const indexEntries = (indices?.entries ?? []) as GatewayJsonObject[];
  const egress = indexEntries.find((entry) =>
    (entry.value as GatewayJsonObject | undefined)?.role === "egress",
  )?.value as GatewayJsonObject | undefined;
  if (root === undefined || egress?.value === undefined) return null;
  const pendingPage = pages.find((page) => page.treeKind === "pending");
  const pending = ((pendingPage?.entries ?? []) as GatewayJsonObject[])[0]?.value;
  return { pending, egressFence: egress.value };
}

function leaseTransition(
  operation: "dispatch" | "resume_ack" | "resume_retransmit",
  phase: "reserved" | "started",
): (writes: readonly TestWrite[]) => boolean {
  return (writes) => {
    const session = sessionWrite(writes);
    const fence = session?.egressFence as Record<string, unknown> | undefined;
    const lease = fence?.lease as Record<string, unknown> | undefined;
    return lease?.operation === operation && lease.phase === phase;
  };
}

function tombstoneWrite(writes: readonly TestWrite[]): boolean {
  return writes.some(
    (write) => write.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
  );
}

function revocationPendingWrite(writes: readonly TestWrite[]): boolean {
  const session = sessionWrite(writes);
  const fence = session?.egressFence as Record<string, unknown> | undefined;
  return fence?.state === "revocation_pending";
}

function openLeaseReleaseWrite(writes: readonly TestWrite[]): boolean {
  const session = sessionWrite(writes);
  const fence = session?.egressFence as Record<string, unknown> | undefined;
  return session !== null && fence?.state === "open" && fence.lease === null && session.pending !== null;
}

function scopeDigest(scope: MutationScope): `sha256:${string}` {
  return tokenDigest(mutationScopeKey(scope));
}

interface NormalizedSeedMutation {
  readonly hold?: (value: Record<string, unknown>) => Record<string, unknown>;
  readonly conflict?: (value: Record<string, unknown>) => Record<string, unknown>;
  readonly holdKey?: string;
  readonly conflictKey?: string;
  readonly index?: boolean;
}

function seedNormalizedHold(
  store: ControlledStoreHarness,
  rsid: string,
  scope: MutationScope,
  origins: readonly string[],
  mutate: NormalizedSeedMutation = {},
): { readonly holdId: string; readonly digest: `sha256:${string}` } {
  const canonicalScope = mutationScopeKey(scope);
  const holdId = makeMutationHoldId(rsid, scope, origins);
  const digest = scopeDigest(scope);
  const nowMs = Date.now();
  const hold = mutate.hold?.({
    schema: "gateway.mutation-hold/v1",
    tenantId: TENANT_ID,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    recordVersion: 1,
    holdId,
    rsid,
    mutationScopeJcs: canonicalScope,
    originIdempotencyKeys: [...origins],
    state: "active",
    evidenceIds: [],
    evidenceDigests: [],
    resolutionIds: [],
  }) ?? {
    schema: "gateway.mutation-hold/v1",
    tenantId: TENANT_ID,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    recordVersion: 1,
    holdId,
    rsid,
    mutationScopeJcs: canonicalScope,
    originIdempotencyKeys: [...origins],
    state: "active",
    evidenceIds: [],
    evidenceDigests: [],
    resolutionIds: [],
  };
  const conflict = mutate.conflict?.({
    schema: "gateway.mutation-conflict/v1",
    tenantId: TENANT_ID,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    recordVersion: 1,
    rsid,
    scopeDigest: digest,
    holdId,
    mutationScopeJcs: canonicalScope,
    active: true,
  }) ?? {
    schema: "gateway.mutation-conflict/v1",
    tenantId: TENANT_ID,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    recordVersion: 1,
    rsid,
    scopeDigest: digest,
    holdId,
    mutationScopeJcs: canonicalScope,
    active: true,
  };
  store.seed(
    TENANT_ID,
    "gateway.mutation-hold/v1",
    mutate.holdKey ?? holdId,
    hold as GatewayJsonValue,
  );
  store.seed(
    TENANT_ID,
    "gateway.mutation-conflict/v1",
    mutate.conflictKey ?? `${rsid}/${digest}`,
    conflict as GatewayJsonValue,
  );
  if (mutate.index !== false) {
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", rsid, (value) => ({
      ...(value as GatewayJsonObject),
      normalizedConflictIndex: {
        version: 1,
        state: "complete",
        scopeDigests: [digest],
      },
    }));
  }
  return { holdId, digest };
}

function seedLegacyHold(
  store: ControlledStoreHarness,
  rsid: string,
  scope: MutationScope,
  origins: readonly string[],
  options: {
    readonly state?: "active" | "evidence_recorded" | "resolved_pending_bridge" | "cleared";
    readonly resolution?: GatewayJsonObject | null;
    readonly clearedBy?: string | null;
  } = {},
): string {
  const holdId = makeMutationHoldId(rsid, scope, origins);
  store.seed(TENANT_ID, "gateway.recovery-authority/v1", rsid, {
    contractVersion: "revagent.gateway-recovery/v1",
    rsid,
    invocationWindow: null,
    evidenceDecisions: [],
    ledger: {
      holds: [{
        rsid,
        mutationScope: scope,
        scopeKey: mutationScopeKey(scope),
        holdId,
        originIdempotencyKeys: [...origins],
        state: options.state ?? "active",
        evidenceAttempts: [],
        selectedEvidence: null,
        resolution: options.resolution ?? null,
        clearedBy: options.clearedBy ?? null,
      }],
    },
    resolutionPlan: null,
    pendingDispatch: null,
    dispatchHistory: [],
  } as unknown as GatewayJsonValue);
  return holdId;
}

function seedLegacyHolds(
  store: ControlledStoreHarness,
  rsid: string,
  count: number,
): void {
  const holds = Array.from({ length: count }, (_, index) => {
    const scope: MutationScope = { kind: "document", document_id: `legacy-doc-${index.toString().padStart(3, "0")}` };
    const origins = [`${rsid}/${id()}`];
    return {
      rsid, mutationScope: scope, scopeKey: mutationScopeKey(scope),
      holdId: makeMutationHoldId(rsid, scope, origins), originIdempotencyKeys: origins,
      state: "active", evidenceAttempts: [], selectedEvidence: null, resolution: null, clearedBy: null,
    };
  }).sort((left, right) => left.holdId.localeCompare(right.holdId));
  store.seed(TENANT_ID, "gateway.recovery-authority/v1", rsid, {
    contractVersion: "revagent.gateway-recovery/v1", rsid, invocationWindow: null,
    evidenceDecisions: [], ledger: { holds }, resolutionPlan: null,
    pendingDispatch: null, dispatchHistory: [],
  } as unknown as GatewayJsonValue);
}

function legacyResolutionFixture(label: string): GatewayJsonObject {
  return {
    resolutionId: id(),
    basis: "verification_read",
    verificationInvocationId: id(),
    evidenceDigest: makeParamsDigest({ label, kind: "evidence" }),
    decision: "postcondition_verified",
    auditId: id(),
    authorizedDispatchIdentity: makeParamsDigest({ label, kind: "dispatch" }),
    journalBindingDigest: makeParamsDigest({ label, kind: "binding" }),
    journalOutcomeDigest: makeParamsDigest({ label, kind: "outcome" }),
    terminalKind: "terminal",
    terminalStatus: "completed",
  };
}

/**
 * Return the serving-session shape for legacy-proof fixtures without making a
 * v2 aggregate look like an unmarked v1 source.  New registrations are
 * already v2-authoritative; older cutover oracles still need the same fields
 * in order to calculate a legacy recovery proof.
 */
function sessionForLegacyProof(
  store: ControlledStoreHarness,
  rsid: string,
): GatewayJsonObject {
  const v1 = store.snapshot().find(
    (record) =>
      record.namespace === "gateway.rbp-session/v1" &&
      record.tenantId === TENANT_ID &&
      record.key === rsid,
  )?.value as GatewayJsonObject | undefined;
  if (v1 !== undefined) return v1;

  const v3 = store.snapshot().find((record) =>
    record.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE &&
    record.tenantId === TENANT_ID && record.key === rsid,
  )?.value as GatewayJsonObject | undefined;
  if (v3 !== undefined) {
    const pages = store.snapshot().filter((record) =>
      record.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE &&
      record.tenantId === TENANT_ID && record.key.startsWith(`${rsid}/`) &&
      Array.isArray((record.value as GatewayJsonObject).entries));
    const lane = (kind: string): GatewayJsonValue[] => pages
      .filter((record) => (record.value as GatewayJsonObject).treeKind === kind)
      .flatMap((record) => ((record.value as GatewayJsonObject).entries as GatewayJsonObject[])
        .map((entry) => ({ key: String(entry.key), value: entry.value as GatewayJsonValue })))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => entry.value);
    const indices = lane("indices") as GatewayJsonObject[];
    const byRole = (role: string) => indices.find((value) => value.role === role)?.value;
    const head = v3.sequenceHead as GatewayJsonObject;
    return {
      schema: "gateway.rbp-session/v1",
      tenantId: TENANT_ID,
      rsid,
      ...(v3.identity as GatewayJsonObject),
      ...(v3.binding as GatewayJsonObject),
      ...(v3.lifecycle as GatewayJsonObject),
      sequence: {
        ...(head.sequence as GatewayJsonObject),
        outbox: lane("outbox"),
        acceptedInbound: lane("receipts"),
      },
      pending: lane("pending")[0] ?? null,
      evidence: lane("evidence"),
      egressFence: byRole("egress"),
      normalizedConflictIndex: byRole("conflict-index"),
      d2ConformanceOriginResend: head.d2ConformanceOriginResend ?? null,
    };
  }

  const root = store.snapshot().find(
    (record) =>
      record.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE &&
      record.tenantId === TENANT_ID &&
      record.key === rsid,
  )?.value as GatewayJsonObject | undefined;
  const egress = store.snapshot().find(
    (record) =>
      record.namespace === "gateway.rbp-session-egress/v2" &&
      record.tenantId === TENANT_ID &&
      record.key === `${rsid}/egress`,
  )?.value as GatewayJsonObject | undefined;
  const index = store.snapshot().find(
    (record) =>
      record.namespace === "gateway.rbp-session-conflict-index/v2" &&
      record.tenantId === TENANT_ID &&
      record.key === `${rsid}/conflict-index`,
  )?.value as GatewayJsonObject | undefined;
  if (root === undefined || egress === undefined || index === undefined) {
    throw new Error(`missing serving-session fixture ${rsid}`);
  }
  return {
    schema: "gateway.rbp-session/v1",
    tenantId: TENANT_ID,
    rsid,
    ...(root.identity as GatewayJsonObject),
    ...(root.binding as GatewayJsonObject),
    ...(root.lifecycle as GatewayJsonObject),
    ...(root.sequence as GatewayJsonObject),
    evidence: [],
    egressFence: egress.fence,
    normalizedConflictIndex: index.index,
  };
}

/** Seed only pre-marker authority: a v1 serving row and optional v1 recovery
 * source.  No v2 root, child, or marker may survive this conversion. */
function preMarker(
  store: ControlledStoreHarness,
  rsid: string,
): GatewayJsonObject {
  const source = sessionForLegacyProof(store, rsid);
  const { recordVersion: _recordVersion, ...legacy } = source;
  for (const [namespace, key] of [
    [GATEWAY_RBP_SESSION_V2_NAMESPACE, rsid],
    [GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid],
    ["gateway.rbp-session-egress/v2", `${rsid}/egress`],
    ["gateway.rbp-session-conflict-index/v2", `${rsid}/conflict-index`],
    ["gateway.hold-cutover/v1", rsid],
    [GATEWAY_RBP_SESSION_V3_NAMESPACE, rsid],
    [GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, rsid],
    [GATEWAY_SESSION_MIGRATION_V3_NAMESPACE, rsid],
  ] as const) {
    store.remove(TENANT_ID, namespace, key);
  }
  for (const row of store.snapshot().filter((record) =>
    (record.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE ||
      record.namespace === GATEWAY_SESSION_MIGRATION_RESERVATION_NAMESPACE) &&
    record.key.startsWith(`${rsid}/`))) {
    store.remove(TENANT_ID, row.namespace, row.key);
  }
  store.seed(TENANT_ID, "gateway.rbp-session/v1", rsid, legacy as GatewayJsonObject);
  return legacy as GatewayJsonObject;
}

function seedValidCutover(
  store: ControlledStoreHarness,
  rsid: string,
  mutate?: (value: Record<string, unknown>) => Record<string, unknown>,
): void {
  const nowMs = Date.now();
  const session = sessionForLegacyProof(store, rsid);
  if (session.pending !== null) {
    throw new Error("cutover fixture requires an idle durable session");
  }
  const recovery = store.snapshot().find(
    (record) =>
      record.namespace === "gateway.recovery-authority/v1" &&
      record.tenantId === TENANT_ID &&
      record.key === rsid,
  )?.value as GatewayJsonObject | undefined;
  const ledger = recovery?.ledger as GatewayJsonObject | undefined;
  const holds = ((ledger?.holds ?? []) as GatewayJsonObject[])
    .map((hold) => ({
      cleared_by: hold.clearedBy,
      evidence_attempts: hold.evidenceAttempts,
      hold_id: hold.holdId,
      mutation_scope: hold.mutationScope,
      origin_idempotency_keys: hold.originIdempotencyKeys,
      resolution: hold.resolution,
      selected_evidence: hold.selectedEvidence,
      state: hold.state,
    }))
    .sort((left, right) => String(left.hold_id).localeCompare(String(right.hold_id)));
  const legacyDigest = tokenDigest(canonicalizeJson({
    holds,
    pending: null,
    rsid,
  } as unknown as JsonValue));
  const conflictIndex = session.normalizedConflictIndex as GatewayJsonObject;
  const normalizedDigests = (conflictIndex.scopeDigests ?? []) as string[];
  const normalizedResolutionCount = recovery === undefined
    ? normalizedDigests.reduce((count, digest) => {
        const conflict = store.snapshot().find(
          (record) =>
            record.namespace === "gateway.mutation-conflict/v1" &&
            record.tenantId === TENANT_ID &&
            record.key === `${rsid}/${digest}`,
        )?.value as GatewayJsonObject | undefined;
        const hold = conflict === undefined
          ? undefined
          : store.snapshot().find(
              (record) =>
                record.namespace === "gateway.mutation-hold/v1" &&
                record.tenantId === TENANT_ID &&
                record.key === conflict.holdId,
            )?.value as GatewayJsonObject | undefined;
        return count + (((hold?.resolutionIds ?? []) as string[]).length);
      }, 0)
    : 0;
  const importedHoldCount = recovery === undefined
    ? normalizedDigests.length
    : holds.length;
  const marker = {
    schema: "gateway.hold-cutover/v1",
    tenantId: TENANT_ID,
    rsid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    recordVersion: 1,
    legacyDigest,
    importedHoldCount,
    importedConflictCount: importedHoldCount,
    importedResolutionCount: recovery === undefined
      ? normalizedResolutionCount
      : holds.filter((hold) => hold.resolution !== null).length,
    targetGeneration: "normalized-v1",
    state: "normalized_authoritative",
    cutoverAtMs: nowMs,
  };
  const next = (mutate?.(marker) ?? marker) as GatewayJsonValue;
  const existing = store.snapshot().find(
    (record) =>
      record.namespace === "gateway.hold-cutover/v1" &&
      record.tenantId === TENANT_ID &&
      record.key === rsid,
  );
  if (existing === undefined) {
    store.seed(TENANT_ID, "gateway.hold-cutover/v1", rsid, next);
  } else {
    store.rewrite(TENANT_ID, "gateway.hold-cutover/v1", rsid, () => next);
  }
}

const CUTOVER_CORRUPTIONS: ReadonlyArray<[
  string,
  (value: Record<string, unknown>) => Record<string, unknown>,
]> = [
  ["schema", (value) => ({ ...value, schema: "gateway.hold-cutover/v0" })],
  ["tenant", (value) => ({ ...value, tenantId: "tenant-foreign" })],
  ["recordVersion", (value) => ({ ...value, recordVersion: 0 })],
  ["legacyDigest", (value) => ({ ...value, legacyDigest: "sha256:bad" })],
  ["counts", (value) => ({ ...value, importedHoldCount: -1 })],
  ["targetGeneration", (value) => ({ ...value, targetGeneration: "normalized-v2" })],
  ["state", (value) => ({ ...value, state: "pending" })],
  ["timestamps", (value) => ({ ...value, cutoverAtMs: Number(value.updatedAtMs) + 1 })],
  ["extraField", (value) => ({ ...value, unexpected: true })],
];

const NORMALIZED_CORRUPTIONS: ReadonlyArray<[
  string,
  NormalizedSeedMutation,
]> = [
  ["hold schema", { hold: (value) => ({ ...value, schema: "gateway.mutation-hold/v0" }) }],
  ["hold tenant", { hold: (value) => ({ ...value, tenantId: "tenant-foreign" }) }],
  ["hold recordVersion", { hold: (value) => ({ ...value, recordVersion: 0 }) }],
  ["hold timestamps", { hold: (value) => ({ ...value, createdAtMs: 2, updatedAtMs: 1 }) }],
  ["hold canonical scope", {
    hold: (value) => ({ ...value, mutationScopeJcs: '{"kind":"document","document_id":"doc-a"}' }),
  }],
  ["hold origin prefix", {
    hold: (value) => ({ ...value, originIdempotencyKeys: ["foreign/invocation"] }),
  }],
  ["hold identity", { hold: (value) => ({ ...value, holdId: `vh:${"f".repeat(64)}` }) }],
  ["hold evidence order", { hold: (value) => ({ ...value, evidenceIds: ["z", "a"] }) }],
  ["hold evidence digest", { hold: (value) => ({ ...value, evidenceDigests: ["bad"] }) }],
  ["hold resolution id", { hold: (value) => ({ ...value, resolutionIds: ["bad"] }) }],
  ["conflict schema", {
    conflict: (value) => ({ ...value, schema: "gateway.mutation-conflict/v0" }),
  }],
  ["conflict tenant", { conflict: (value) => ({ ...value, tenantId: "tenant-foreign" }) }],
  ["conflict recordVersion", { conflict: (value) => ({ ...value, recordVersion: 999_999 }) }],
  ["conflict digest", {
    conflict: (value) => ({ ...value, scopeDigest: `sha256:${"e".repeat(64)}` }),
  }],
  ["conflict scope", {
    conflict: (value) => ({ ...value, mutationScopeJcs: mutationScopeKey({ kind: "session" }) }),
  }],
  ["conflict hold reference", {
    conflict: (value) => ({ ...value, holdId: `vh:${"d".repeat(64)}` }),
  }],
  ["active-state agreement", { conflict: (value) => ({ ...value, active: false }) }],
  ["hold record key", { holdKey: `vh:${"c".repeat(64)}` }],
  ["conflict record key", { conflictKey: "wrong/conflict-key" }],
];

describe("GatewayBridgeSessionAuthority durable unregister", () => {
  const authorities: GatewayBridgeSessionAuthority[] = [];

  afterEach(async () => {
    // Corruption oracles deliberately leave the aggregate fail-closed. Their
    // close path is not an additional assertion and must not mask the oracle.
    await Promise.allSettled(authorities.splice(0).map(async (authority) => authority.close()));
  });

  it("makes a newly registered aggregate v3-authoritative without a v1 session row", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);

    const records = restartable.snapshot().records;
    expect(records.some((row) =>
      row.namespace === "gateway.rbp-session/v1" && row.key === session.rsid,
    )).toBe(false);
    expect(records.some((row) =>
      row.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && row.key === session.rsid,
    )).toBe(true);
    expect(records.some((row) =>
      row.namespace === "gateway.hold-cutover/v1" && row.key === session.rsid,
    )).toBe(false);

    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    const restarted = new GatewayBridgeSessionAuthority(restartable.restart(), identity());
    authorities.push(restarted);
    await restarted.open();
    const fresh = await openConnection(restarted);
    await expect(
      restarted.receive(fresh.connectionId, resume(session.rsid, session.resumeToken)),
    ).resolves.toBeUndefined();
  });

  it("physically reserves and atomically publishes v3 root, pages, and marker from v1", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    await original.close();
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);

    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await restarted.open();

    const records = store.snapshot();
    expect(records.some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(records.some((record) =>
      record.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE && record.key.startsWith(`${session.rsid}/`),
    )).toBe(true);
    expect(records.some((record) =>
      record.namespace === GATEWAY_SESSION_MIGRATION_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(records.some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(records.some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(records.find((record) =>
      record.namespace === "gateway.rbp-session/v1" && record.key === session.rsid,
    )?.value).toMatchObject({
      schema: "gateway.rbp-session-retired/v1", state: "retired", targetGeneration: 3,
    });
    expect(records.some((record) =>
      record.namespace === "gateway.recovery-authority/v1" && record.key === session.rsid,
    )).toBe(false);
    expect(records.find((record) =>
      record.namespace === GATEWAY_SESSION_MIGRATION_V3_NAMESPACE && record.key === session.rsid,
    )?.value).toMatchObject({ state: "source_retired" });
    expect(records.find((record) =>
      record.namespace === "gateway.hold-cutover/v1" && record.key === session.rsid,
    )?.value).toMatchObject({ state: "normalized_authoritative" });
    expect(records.some((record) =>
      record.namespace === "gateway.session-blob-intent/v1" &&
      (record.value as GatewayJsonObject).purpose === "migration-source-snapshot",
    )).toBe(false);
  });

  it("restarts after the migration source intent commits before its private put", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    await original.close();
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);
    store.armFault("durability_uncertain_applied", (writes) =>
      writes.some((write) => write.namespace === "gateway.session-blob-intent/v1" &&
        (write.value as GatewayJsonObject | null)?.state === "writing") &&
      writes.some((write) => write.namespace === GATEWAY_SESSION_MIGRATION_V3_NAMESPACE &&
        (write.value as GatewayJsonObject | null)?.state === "source_writing"));

    const interrupted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(interrupted);
    await expect(interrupted.open()).rejects.toMatchObject({ code: "unavailable" });
    const writing = store.snapshot().find((record) =>
      record.namespace === "gateway.session-blob-intent/v1" && record.key.startsWith(`${session.rsid}/`));
    expect(writing?.value).toMatchObject({ state: "writing", purpose: "migration-source-snapshot" });

    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await restarted.open();
    expect(store.snapshot().find((record) =>
      record.namespace === GATEWAY_SESSION_MIGRATION_V3_NAMESPACE && record.key === session.rsid,
    )?.value).toMatchObject({ state: "source_retired" });
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(store.snapshot().some((record) =>
      record.namespace === "gateway.session-blob-intent/v1" && record.key.startsWith(`${session.rsid}/`),
    )).toBe(false);
  });

  it("admits exactly 64 legacy scopes through bounded 64-write migration steps and cuts over last", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);
    seedLegacyHolds(store, session.rsid, 64);
    expect(((store.snapshot().find((record) => record.namespace === "gateway.recovery-authority/v1")?.value as GatewayJsonObject).ledger as GatewayJsonObject).holds).toHaveLength(64);
    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await restarted.open();

    expect(store.snapshot().filter((record) => record.namespace === "gateway.mutation-hold/v1")).toHaveLength(64);
    expect(store.commits.every((writes) => writes.length <= 64)).toBe(true);
    expect(store.commits.map((writes) => writes.length)).toContain(64);
    const records = store.snapshot();
    expect(records.filter((record) => record.namespace === "gateway.mutation-hold/v1")).toHaveLength(64);
    expect(records.some((record) => record.namespace === GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE)).toBe(true);
    expect(records.some((record) => record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE)).toBe(true);
  });

  it("rejects 65 legacy scopes before any migration write", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);
    seedLegacyHolds(store, session.rsid, 65);
    const commitsBeforeOpen = store.commits.length;

    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await expect(restarted.open()).rejects.toMatchObject({ code: "unavailable" });
    expect(store.commits).toHaveLength(commitsBeforeOpen);
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE && record.key === session.rsid,
    )).toBe(false);
  });

  it("retains a mixed partial reservation and serves neither generation", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);
    seedLegacyHolds(store, session.rsid, 64);
    store.armFault("partial_applied", (writes) => writes.length === 64);

    const interrupted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(interrupted);
    await expect(interrupted.open()).rejects.toMatchObject({ code: "unavailable" });
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_SESSION_MIGRATION_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(true);
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(false);

    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await expect(restarted.open()).rejects.toMatchObject({ code: "unavailable" });
    const source = store.snapshot().find((record) =>
      record.namespace === "gateway.recovery-authority/v1" && record.key === session.rsid,
    )?.value as GatewayJsonObject;
    expect(((source.ledger as GatewayJsonObject).holds as GatewayJsonValue[])).toHaveLength(64);
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(false);
  });

  it("fails closed when a staged migration source drifts before restart", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    authorities.splice(authorities.indexOf(original), 1);
    preMarker(store, session.rsid);
    seedLegacyHolds(store, session.rsid, 64);
    store.armFault("partial_applied", (writes) => writes.length === 64);
    const interrupted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(interrupted);
    await expect(interrupted.open()).rejects.toMatchObject({ code: "unavailable" });
    store.rewrite(TENANT_ID, "gateway.recovery-authority/v1", session.rsid, (value) => ({
      ...(value as GatewayJsonObject), invocationWindow: { drift: true },
    }));

    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await expect(restarted.open()).rejects.toMatchObject({ code: "unavailable" });
    expect(store.snapshot().some((record) =>
      record.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && record.key === session.rsid,
    )).toBe(false);
  });

  it("never resumes an old token on the same socket or after restart", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);

    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(
      authority.receive(session.connectionId, resume(session.rsid, session.resumeToken)),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });

    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    const restarted = new GatewayBridgeSessionAuthority(restartable.restart(), identity());
    authorities.push(restarted);
    await restarted.open();
    const fresh = await openConnection(restarted);
    await expect(
      restarted.receive(fresh.connectionId, resume(session.rsid, session.resumeToken)),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });
  });

  it("makes an exact same-owner unregister replay a durable no-op", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    await authority.receive(session.connectionId, unregister(session.rsid, "bridge_shutdown"));

    const replay = await openConnection(authority);
    const commitsBeforeReplay = store.commits.length;
    await expect(
      authority.receive(replay.connectionId, unregister(session.rsid, "bridge_shutdown")),
    ).resolves.toBeUndefined();
    expect(store.commits).toHaveLength(commitsBeforeReplay);
  });

  it("rejects changed-reason and cross-owner unregister replays with 4403", async () => {
    const authority = new GatewayBridgeSessionAuthority(createRestartableTestStore().store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    await authority.receive(session.connectionId, unregister(session.rsid, "revit_exited"));

    const sameOwner = await openConnection(authority);
    await expect(
      authority.receive(sameOwner.connectionId, unregister(session.rsid, "bridge_shutdown")),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });

    const otherOwner = await openConnection(authority, {
      token: OTHER_DEVICE_TOKEN,
      deviceId: OTHER_DEVICE_ID,
    });
    await expect(
      authority.receive(otherOwner.connectionId, unregister(session.rsid, "revit_exited")),
    ).rejects.toMatchObject({ code: "auth", closeCode: 4403 });
  });

  it("closes a pending read but persists an indeterminate mutation hold", async () => {
    const store = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(store.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);

    const read = authority.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(read).resolves.toMatchObject({
      state: "failed",
      error: { code: "revit_timeout" },
    });
    const readTombstone = store.snapshot().records.find(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    );
    expect(readTombstone?.value).toMatchObject({
      pendingDisposition: "read_closed",
      holdIds: [],
    });

    const second = await register(authority);
    const mutation = authority.createExecutor().execute(request(second.rsid, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(second.connectionId, unregister(second.rsid));
    await expect(mutation).resolves.toMatchObject({
      state: "failed",
      error: { code: "journal_indeterminate" },
    });
    const tombstones = store.snapshot().records.filter(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    );
    expect(tombstones.at(-1)?.value).toMatchObject({
      pendingDisposition: "mutation_indeterminate",
      holdIds: [expect.stringMatching(/^vh:[0-9a-f]{64}$/)],
      recordVersion: 1,
      sessionBindingId: expect.any(String),
      acceptedConnectionId: second.connectionId,
      cleanupState: "retained",
    });
    expect(store.snapshot().records.some(
      (record) => record.namespace === "gateway.mutation-hold/v1",
    )).toBe(true);
    expect(store.snapshot().records.some(
      (record) => record.namespace === "gateway.mutation-conflict/v1",
    )).toBe(true);
  });

  it("keeps final tombstone authority beside the v3 session root and marker", async () => {
    const store = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(store.store, identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    expect(store.snapshot().records.some(
      (record) => record.namespace === "gateway.rbp-session/v1" && record.key === session.rsid,
    )).toBe(false);

    await authority.receive(session.connectionId, unregister(session.rsid));

    const rows = store.snapshot().records.filter((record) => record.key === session.rsid);
    expect(rows.map((record) => record.namespace)).toEqual(expect.arrayContaining([
      GATEWAY_RBP_SESSION_V3_NAMESPACE,
      GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
      GATEWAY_RBP_UNREGISTER_NAMESPACE,
    ]));
    expect(rows.find((record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE)?.value)
      .toMatchObject({ recordVersion: 1, tenantId: TENANT_ID, rsid: session.rsid });
  });

  it("cancels a reserved mutation as known-not-dispatched without creating a hold", async () => {
    const store = new ControlledStoreHarness();
    const queued = deferred<AbortSignal>();
    const releaseRevalidate = deferred();
    const cancelled = deferred();
    const senderChannel = queuedDispatchChannel({ queued, releaseRevalidate, cancelled });
    const sender = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(sender, revoker);
    await sender.open();
    await revoker.open();
    const opened = await openConnection(sender, { channel: senderChannel });
    await sender.receive(opened.connectionId, registration());
    const registered = registeredFrame(senderChannel);
    const session = { connectionId: opened.connectionId, channel: senderChannel, rsid: registered.payload.rsid };
    const revokerConnection = await openConnection(revoker);

    const execution = sender.createExecutor().execute(request(session.rsid, true));
    const signal = await Promise.race([
      queued.promise,
      new Promise<AbortSignal>((_, reject) => setTimeout(() => reject(new Error("dispatch did not queue")), 1_000)),
    ]);
    expect(signal.aborted).toBe(false);
    await revoker.receive(
      revokerConnection.connectionId,
      unregister(session.rsid),
    );
    releaseRevalidate.resolve();
    await cancelled.promise;
    expect(signal.aborted).toBe(true);

    await expect(execution).resolves.toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(0);
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(true);
    expect(store.snapshot().some(
      (record) =>
        record.namespace === "gateway.mutation-hold/v1" ||
        record.namespace === "gateway.mutation-conflict/v1",
    )).toBe(false);
    const tombstone = store.snapshot().find(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )?.value as GatewayJsonObject;
    expect(tombstone).toMatchObject({ pendingDisposition: "none", holdIds: [] });
    expect(() => sender.buildEnvelope(request(session.rsid, false))).toThrow();
  });

  it("does not finalize a tombstone until a remotely started dispatch send releases", async () => {
    const store = new ControlledStoreHarness();
    const sendStarted = deferred();
    const sendRelease = deferred();
    const senderChannel = channel(async (frame) => {
      if (frame.type === "invoke") {
        sendStarted.resolve();
        await sendRelease.promise;
      }
    });
    const sender = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(sender, revoker);
    await sender.open();
    await revoker.open();
    const opened = await openConnection(sender, { channel: senderChannel });
    await sender.receive(opened.connectionId, registration());
    const registered = registeredFrame(senderChannel);
    const revokerConnection = await openConnection(revoker);
    const pendingCommit = store.holdAfterCommit((writes) => {
      const sessionValue = sessionWrite(writes);
      const fence = sessionValue?.egressFence as Record<string, unknown> | undefined;
      return fence?.state === "revocation_pending";
    });

    const execution = sender.createExecutor().execute(
      request(registered.payload.rsid, false),
    );
    await sendStarted.promise;
    const unregistering = revoker.receive(
      revokerConnection.connectionId,
      unregister(registered.payload.rsid),
    );
    await pendingCommit.entered;
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    pendingCommit.release();
    sendRelease.resolve();
    await unregistering;
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(true);

    await sender.close();
    authorities.splice(authorities.indexOf(sender), 1);
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("keeps the active map and waiter until final tombstone commit is exactly read back", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    let outcomeResolved = false;
    const execution = authority.createExecutor().execute(request(session.rsid, false));
    void execution.then(() => { outcomeResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalCommit = store.holdAfterCommit(tombstoneWrite);
    const unregistering = authority.receive(
      session.connectionId,
      unregister(session.rsid),
    );
    await finalCommit.entered;
    expect(outcomeResolved).toBe(false);
    expect(() => authority.buildEnvelope(request(session.rsid, false))).not.toThrow();
    finalCommit.release();
    await unregistering;
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    expect(outcomeResolved).toBe(true);
    expect(() => authority.buildEnvelope(request(session.rsid, false))).toThrow();
  });

  it("settles local authority after phase-one uncertainty observes a concurrent final tombstone", async () => {
    const store = new ControlledStoreHarness();
    const owner = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const peer = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(owner, peer);
    await owner.open();
    await peer.open();
    const session = await register(owner);
    const execution = owner.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const uncertainCommit = store.holdAfterCommit(revocationPendingWrite);
    store.armFault(
      "durability_uncertain_applied",
      revocationPendingWrite,
    );
    const ownerUnregister = owner.receive(
      session.connectionId,
      unregister(session.rsid),
    );
    await uncertainCommit.entered;
    const peerConnection = await openConnection(peer);
    await peer.receive(peerConnection.connectionId, unregister(session.rsid));
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(true);
    uncertainCommit.release();
    await ownerUnregister;
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    expect(() => owner.buildEnvelope(request(session.rsid, false))).toThrow();
  });

  it("fences resume_ack when revocation wins after its reservation", async () => {
    const store = new ControlledStoreHarness();
    const registrant = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const resumer = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(registrant, resumer);
    await registrant.open();
    await resumer.open();
    const session = await register(registrant);
    const resumeChannel = channel();
    const resumeConnection = await openConnection(resumer, { channel: resumeChannel });
    const reservation = store.holdAfterCommit(leaseTransition("resume_ack", "reserved"));

    const resuming = resumer.receive(
      resumeConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    await reservation.entered;
    await registrant.receive(session.connectionId, unregister(session.rsid));
    reservation.release();

    await expect(resuming).rejects.toMatchObject({ closeCode: 1011 });
    expect(resumeChannel.frames.some((frame) => frame.type === "resume_ack")).toBe(false);
  });

  it("drains a started resume_ack before the final tombstone", async () => {
    const store = new ControlledStoreHarness();
    const ackStarted = deferred();
    const ackRelease = deferred();
    const resumeChannel = channel(async (frame) => {
      if (frame.type === "resume_ack") {
        ackStarted.resolve();
        await ackRelease.promise;
      }
    });
    const registrant = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const resumer = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(registrant, resumer, revoker);
    await registrant.open();
    await resumer.open();
    await revoker.open();
    const session = await register(registrant);
    const resumeConnection = await openConnection(resumer, { channel: resumeChannel });
    const resuming = resumer.receive(
      resumeConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    const resumingFault = expect(resuming).rejects.toMatchObject({
      name: "GatewayRbpFault",
      code: "unavailable",
      httpStatus: 503,
      closeCode: 1011,
      message: "dispatch completed after durable revocation",
    });
    let pendingCommit: ReturnType<ControlledStoreHarness["holdAfterCommit"]> | null = null;
    let unregistering: Promise<void> | null = null;
    let unregisteringResolution: Promise<unknown> | null = null;
    try {
      await ackStarted.promise;
      const allowedStartedFrameCount = resumeChannel.frames.length;
      expect(resumeChannel.frames.filter((frame) => frame.type === "resume_ack")).toHaveLength(1);
      const revokerConnection = await openConnection(revoker);
      pendingCommit = store.holdAfterCommit(revocationPendingWrite);
      unregistering = revoker.receive(
        revokerConnection.connectionId,
        unregister(session.rsid),
      );
      unregisteringResolution = expect(unregistering).resolves.toBeUndefined();
      await pendingCommit.entered;
      expect(store.snapshot().some(
        (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
      )).toBe(false);
      pendingCommit.release();
      ackRelease.resolve();
      await resumingFault;
      if (unregisteringResolution === null) {
        throw new Error("unregister resolution was not captured");
      }
      await unregisteringResolution;
      expect(store.snapshot().some(
        (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
      )).toBe(true);
      // The one ACK that started before durable revocation is permitted to
      // drain; revocation must not emit any further resume frame.
      expect(resumeChannel.frames).toHaveLength(allowedStartedFrameCount);
      expect(resumeChannel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(0);
      expect(resumeChannel.frames.filter(
        (frame) => frame.type === "result" || frame.type === "error",
      )).toHaveLength(0);
      expect((sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject).lease)
        .toBeNull();
      const restartChannel = channel();
      const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(restarted);
      await restarted.open();
      const restartConnection = await openConnection(restarted, { channel: restartChannel });
      await expect(
        restarted.receive(restartConnection.connectionId, resume(session.rsid, session.resumeToken)),
      ).rejects.toMatchObject({ closeCode: 4403 });
      expect(resumeChannel.frames).toHaveLength(allowedStartedFrameCount);
      expect(restartChannel.frames).toHaveLength(0);
    } finally {
      pendingCommit?.release();
      ackRelease.resolve();
      await Promise.allSettled([
        resuming,
        ...(unregistering === null ? [] : [unregistering]),
      ]);
    }
  });

  it("uses a fresh durable lease for a retransmit and lets revocation cancel it", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const resumer = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original, resumer, revoker);
    await original.open();
    await resumer.open();
    await revoker.open();
    const session = await register(original);
    const execution = original.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(true);
    await original.detach(session.connectionId);

    const resumeChannel = channel();
    const resumeConnection = await openConnection(resumer, { channel: resumeChannel });
    const retransmitReservation = store.holdAfterCommit(
      leaseTransition("resume_retransmit", "reserved"),
    );
    const resuming = resumer.receive(
      resumeConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    await retransmitReservation.entered;
    const revokerConnection = await openConnection(revoker);
    await revoker.receive(revokerConnection.connectionId, unregister(session.rsid));
    retransmitReservation.release();

    await expect(resuming).rejects.toMatchObject({ closeCode: 1011 });
    expect(resumeChannel.frames.some((frame) => frame.type === "resume_ack")).toBe(true);
    expect(resumeChannel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    await original.close();
    authorities.splice(authorities.indexOf(original), 1);
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("drains a started retransmit before the final tombstone", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const retransmitStarted = deferred();
    const retransmitRelease = deferred();
    const resumeChannel = channel(async (frame) => {
      if (frame.type === "invoke") {
        retransmitStarted.resolve();
        await retransmitRelease.promise;
      }
    });
    const resumer = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original, resumer, revoker);
    await original.open();
    await resumer.open();
    await revoker.open();
    const session = await register(original);
    const execution = original.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const originalInvokeCount = session.channel.frames.filter((frame) => frame.type === "invoke").length;
    expect(originalInvokeCount).toBe(1);
    await original.detach(session.connectionId);
    const resumeConnection = await openConnection(resumer, { channel: resumeChannel });
    const resuming = resumer.receive(
      resumeConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    const resumingFault = expect(resuming).rejects.toMatchObject({
      name: "GatewayRbpFault",
      code: "unavailable",
      httpStatus: 503,
      closeCode: 1011,
      message: "dispatch completed after durable revocation",
    });
    let pendingCommit: ReturnType<ControlledStoreHarness["holdAfterCommit"]> | null = null;
    let unregistering: Promise<void> | null = null;
    let unregisteringResolution: Promise<unknown> | null = null;
    try {
      await retransmitStarted.promise;
      const retransmitInvokeCount = resumeChannel.frames.filter((frame) => frame.type === "invoke").length;
      const allowedStartedFrameCount = resumeChannel.frames.length;
      expect(retransmitInvokeCount).toBe(1);
      const revokerConnection = await openConnection(revoker);
      pendingCommit = store.holdAfterCommit(revocationPendingWrite);
      unregistering = revoker.receive(
        revokerConnection.connectionId,
        unregister(session.rsid),
      );
      unregisteringResolution = expect(unregistering).resolves.toBeUndefined();
      await pendingCommit.entered;
      expect(store.snapshot().some(
        (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
      )).toBe(false);
      pendingCommit.release();
      retransmitRelease.resolve();
      await resumingFault;
      if (unregisteringResolution === null) {
        throw new Error("unregister resolution was not captured");
      }
      await unregisteringResolution;
      expect(store.snapshot().some(
        (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
      )).toBe(true);
      expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(
        originalInvokeCount,
      );
      expect(resumeChannel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(
        retransmitInvokeCount,
      );
      expect(resumeChannel.frames).toHaveLength(allowedStartedFrameCount);
      expect(resumeChannel.frames.filter(
        (frame) => frame.type === "result" || frame.type === "error",
      )).toHaveLength(0);
      expect((sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject).lease)
        .toBeNull();
      const restartChannel = channel();
      const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(restarted);
      await restarted.open();
      const restartConnection = await openConnection(restarted, { channel: restartChannel });
      await expect(
        restarted.receive(restartConnection.connectionId, resume(session.rsid, session.resumeToken)),
      ).rejects.toMatchObject({ closeCode: 4403 });
      expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(
        originalInvokeCount,
      );
      expect(resumeChannel.frames).toHaveLength(allowedStartedFrameCount);
      expect(restartChannel.frames).toHaveLength(0);
    } finally {
      pendingCommit?.release();
      retransmitRelease.resolve();
      await Promise.allSettled([
        resuming,
        ...(unregistering === null ? [] : [unregistering]),
      ]);
    }
    await original.close();
    authorities.splice(authorities.indexOf(original), 1);
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("times out on a non-expiring started lease and a restart replay finalizes after release", async () => {
    const store = new ControlledStoreHarness();
    const sendStarted = deferred();
    const sendRelease = deferred();
    const blockedChannel = channel(async (frame) => {
      if (frame.type === "invoke") {
        sendStarted.resolve();
        await sendRelease.promise;
      }
    });
    const sender = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    let nowMs = Date.now() + 10_000;
    const revoker = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
      wait: async (milliseconds) => { nowMs += milliseconds; },
    });
    authorities.push(sender, revoker);
    await sender.open();
    await revoker.open();
    const opened = await openConnection(sender, { channel: blockedChannel });
    await sender.receive(opened.connectionId, registration());
    const registered = registeredFrame(blockedChannel);
    const execution = sender.createExecutor().execute(
      request(registered.payload.rsid, false),
    );
    await sendStarted.promise;
    const revokerConnection = await openConnection(revoker);

    await expect(
      revoker.receive(
        revokerConnection.connectionId,
        unregister(registered.payload.rsid),
      ),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    const pendingEgress = sessionForLegacyProof(store, registered.payload.rsid)
      .egressFence as GatewayJsonObject;
    expect(pendingEgress.lease).toMatchObject({
      phase: "started",
    });

    const staleRestart = new GatewayBridgeSessionAuthority(
      store.createPort(),
      identity(),
      {
        clock: () => nowMs,
        wait: async (milliseconds) => { nowMs += milliseconds; },
      },
    );
    authorities.push(staleRestart);
    await staleRestart.open();
    const staleConnection = await openConnection(staleRestart);
    await expect(
      staleRestart.receive(
        staleConnection.connectionId,
        unregister(registered.payload.rsid),
      ),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);

    sendRelease.resolve();
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    const releasedEgress = sessionForLegacyProof(store, registered.payload.rsid)
      .egressFence as GatewayJsonObject;
    expect(releasedEgress.lease).toBeNull();
    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
      wait: async (milliseconds) => { nowMs += milliseconds; },
    });
    authorities.push(restarted);
    await restarted.open();
    const replayConnection = await openConnection(restarted);
    await restarted.receive(
      replayConnection.connectionId,
      unregister(registered.payload.rsid),
    );
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(true);
    await sender.close();
    authorities.splice(authorities.indexOf(sender), 1);
  });

  it("reclaims only an expired reservation and rejects the stale promoter", async () => {
    const store = new ControlledStoreHarness();
    let nowMs = Date.now() + 20_000;
    const registrant = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
    });
    const first = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
    });
    const second = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
    });
    authorities.push(registrant, first, second);
    await registrant.open();
    await first.open();
    await second.open();
    const session = await register(registrant);
    const firstChannel = channel();
    const secondChannel = channel();
    const firstConnection = await openConnection(first, { channel: firstChannel });
    const secondConnection = await openConnection(second, { channel: secondChannel });
    const reservation = store.holdAfterCommit(leaseTransition("resume_ack", "reserved"));
    const firstResume = first.receive(
      firstConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    await reservation.entered;
    nowMs += 5_001;
    await second.receive(
      secondConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    reservation.release();
    await expect(firstResume).rejects.toMatchObject({ closeCode: 1011 });
    expect(firstChannel.frames.some((frame) => frame.type === "resume_ack")).toBe(false);
    expect(secondChannel.frames.some((frame) => frame.type === "resume_ack")).toBe(true);
  });

  it("rejects a started lease whose start equals its reservation expiry", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    const reservedAtMs = Date.now();
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      egressFence: {
        version: 1,
        state: "open",
        epoch: 1,
        nextTicket: 2,
        lease: {
          leaseId: id(),
          ticket: 1,
          holderInstanceId: id(),
          connectionId: session.connectionId,
          operation: "dispatch",
          envelopeDigest: tokenDigest("invalid-start-time"),
          phase: "started",
          reservedAtMs,
          reserveExpiresAtMs: reservedAtMs + 5_000,
          startedAtMs: reservedAtMs + 5_000,
        },
        revocation: null,
      },
    }));
    await expect(
      authority.createExecutor().execute(request(session.rsid, false)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    // The deliberately stale child proof is terminal fixture corruption; do
    // not run lifecycle cleanup through an authority that must fail closed.
    authorities.splice(authorities.indexOf(authority), 1);
  });

  it("accepts commit-applied uncertainty only after exact keyed readback", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault("durability_uncertain_applied", revocationPendingWrite);
    store.armFault("durability_uncertain_applied", tombstoneWrite);

    await authority.receive(session.connectionId, unregister(session.rsid));
    const tombstone = store.snapshot().find(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )?.value as GatewayJsonObject;
    expect(tombstone).toMatchObject({
      reason: "revit_exited",
      recordVersion: 1,
    });
    expect(tombstone).not.toHaveProperty("closedReason");
  });

  it("reconciles send reservation uncertainty and retries a confirmed absent promotion", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault(
      "durability_uncertain_applied",
      leaseTransition("dispatch", "reserved"),
    );
    store.armFault(
      "durability_uncertain_not_applied",
      leaseTransition("dispatch", "started"),
    );
    const execution = authority.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("does not send when reservation uncertainty cannot be read back", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault(
      "durability_uncertain_applied_readback_unavailable",
      leaseTransition("dispatch", "reserved"),
    );
    await expect(
      authority.createExecutor().execute(request(session.rsid, false)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(0);
  });

  it("never resends and leaves a started lease blocking after uncertain release", async () => {
    const store = new ControlledStoreHarness();
    let nowMs = Date.now() + 30_000;
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity(), {
      clock: () => nowMs,
      wait: async (milliseconds) => { nowMs += milliseconds; },
    });
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault(
      "durability_uncertain_not_applied",
      openLeaseReleaseWrite,
    );
    await expect(
      authority.createExecutor().execute(request(session.rsid, false)),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "revit_timeout" },
    });
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
    const durable = sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject;
    expect(durable.lease).toMatchObject({
      phase: "started",
      operation: "dispatch",
    });
    await expect(
      authority.receive(session.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
  });

  it("retries confirmed uncertain absence but fails after the eight-attempt bound", async () => {
    const succeeds = new ControlledStoreHarness();
    const successful = new GatewayBridgeSessionAuthority(succeeds.createPort(), identity());
    authorities.push(successful);
    await successful.open();
    const first = await register(successful);
    succeeds.armFault("durability_uncertain_not_applied", revocationPendingWrite);
    await expect(
      successful.receive(first.connectionId, unregister(first.rsid)),
    ).resolves.toBeUndefined();

    const exhaustedStore = new ControlledStoreHarness();
    const exhausted = new GatewayBridgeSessionAuthority(exhaustedStore.createPort(), identity());
    authorities.push(exhausted);
    await exhausted.open();
    const second = await register(exhausted);
    exhaustedStore.armFault(
      "durability_uncertain_not_applied",
      revocationPendingWrite,
      8,
    );
    await expect(
      exhausted.receive(second.connectionId, unregister(second.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(exhaustedStore.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
  });

  it("fails closed when uncertainty readback is unavailable", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault(
      "durability_uncertain_applied_readback_unavailable",
      revocationPendingWrite,
    );

    await expect(
      authority.receive(session.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    const durable = sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject;
    expect(durable.state).toBe("revocation_pending");
  });

  it("rejects a partial hold write instead of repairing it", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    const execution = authority.createExecutor().execute(request(session.rsid, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.armFault(
      "partial_applied",
      (writes) => writes.some(
        (write) => write.namespace === "gateway.mutation-hold/v1",
      ),
    );

    await expect(
      authority.receive(session.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().filter(
      (record) => record.namespace === "gateway.mutation-hold/v1",
    )).toHaveLength(1);
    expect(store.snapshot().filter(
      (record) => record.namespace === "gateway.mutation-conflict/v1",
    )).toHaveLength(0);
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    const poisoned = sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject;
    expect(poisoned.state).toBe(
      "revocation_pending",
    );
    await expect(
      authority.createExecutor().execute(request(session.rsid, true)),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await restarted.open();
    const restartedConnection = await openConnection(restarted);
    await expect(
      restarted.receive(
        restartedConnection.connectionId,
        resume(session.rsid, session.resumeToken),
      ),
    ).rejects.toMatchObject({ closeCode: 4403 });
    await expect(
      restarted.receive(
        restartedConnection.connectionId,
        unregister(session.rsid),
      ),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("gives revocation a bounded eight-conflict retry budget", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.armFault("conflict", revocationPendingWrite, 8);
    await expect(
      authority.receive(session.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    const durable = sessionForLegacyProof(store, session.rsid).egressFence as GatewayJsonObject;
    expect(durable.state).toBe("open");
  });

  it("does not cross a tenant boundary to observe or tombstone an rsid", async () => {
    const store = new ControlledStoreHarness();
    const owner = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    const foreign = new GatewayBridgeSessionAuthority(
      store.createPort(),
      identity("tenant-other"),
    );
    authorities.push(owner, foreign);
    await owner.open();
    await foreign.open();
    const session = await register(owner);
    const foreignConnection = await openConnection(foreign);

    await expect(
      foreign.receive(foreignConnection.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    expect(store.snapshot().filter(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toHaveLength(0);
  });

  it("repairs legacy and drifted session recordVersion from the store CAS version", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();

    const legacy = await register(authority);
    const legacyCreatedAt = (((store.snapshot().find(
      (record) => record.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && record.key === legacy.rsid,
    )?.value as GatewayJsonObject).lifecycle) as GatewayJsonObject).createdAtMs;
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", legacy.rsid, (value) => {
      const rewritten = { ...(value as GatewayJsonObject) };
      delete rewritten.recordVersion;
      return rewritten;
    });
    await authority.detach(legacy.connectionId);
    const repairedLegacy = store.snapshot().find(
      (record) => record.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && record.key === legacy.rsid,
    )!;
    expect(((repairedLegacy.value as GatewayJsonObject).lifecycle as GatewayJsonObject).recordVersion).toBe(
      repairedLegacy.version,
    );
    expect(((repairedLegacy.value as GatewayJsonObject).lifecycle as GatewayJsonObject).createdAtMs).toBe(legacyCreatedAt);

    const drifted = await register(authority);
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", drifted.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      recordVersion: 1,
    }));
    await authority.detach(drifted.connectionId);
    const repairedDrift = store.snapshot().find(
      (record) => record.namespace === GATEWAY_RBP_SESSION_V3_NAMESPACE && record.key === drifted.rsid,
    )!;
    expect(((repairedDrift.value as GatewayJsonObject).lifecycle as GatewayJsonObject).recordVersion).toBe(
      repairedDrift.version,
    );

    const invalid = await register(authority);
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", invalid.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      recordVersion: Number.MAX_SAFE_INTEGER,
    }));
    await expect(authority.detach(invalid.connectionId)).rejects.toMatchObject({
      httpStatus: 503,
      closeCode: 1011,
    });
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", invalid.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      recordVersion: 1,
    }));
  });

  it("recovers a true legacy pending mutation with absent mutationEntries from journal bindings", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const recovery = await createComposedRecovery(store, bridge);
    const mutationRequest = request(
      session.rsid,
      true,
      { kind: "document", document_id: "doc-legacy-pending" },
    );
    const draft = bridge.buildEnvelope(mutationRequest);
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const prepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope: draft.envelope,
      expected: draft.expected,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(`legacy pending was not prepared: ${prepared.kind}`);
    }
    const execution = bridge.execute(mutationRequest, prepared.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The post-cutover fixture remains normalized; a true legacy pending row
    // is covered by the explicit pre-marker migration oracle below.
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({
      error: { code: "journal_indeterminate" },
    });
    const tombstone = store.snapshot().find(
      (record) =>
        record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
        record.key === session.rsid,
    )?.value as GatewayJsonObject;
    expect(tombstone).toMatchObject({
      pendingDisposition: "mutation_indeterminate",
      holdIds: [expect.stringMatching(/^vh:[0-9a-f]{64}$/u)],
    });
    for (const commit of store.commits) {
      for (const write of commit) {
        if (
          write.namespace === "gateway.rbp-session/v1" &&
          write.value !== null &&
          write.expect.kind === "version"
        ) {
          expect((write.value as GatewayJsonObject).recordVersion).toBe(
            write.expect.version + 1,
          );
        }
        if (
          (write.namespace === "gateway.mutation-hold/v1" ||
            write.namespace === "gateway.mutation-conflict/v1" ||
            write.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE) &&
          write.value !== null &&
          write.expect.kind === "absent"
        ) {
          expect((write.value as GatewayJsonObject).recordVersion).toBe(1);
        }
      }
    }
    await recovery.port.close();
  });

  it("preserves nonlexical multi-origin order through RecoveryAuthority and normalized reconciliation", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    let pending: GatewayRecoveryPendingDispatch | null = null;
    const scope = { kind: "document", document_id: "doc-origin-order" } as const;
    const lowerId = id();
    const higherId = id();
    const orderedInvocationIds = [higherId, lowerId];
    const orderedOrigins = orderedInvocationIds.map(
      (invocationId) => `${session.rsid}/${invocationId}`,
    );
    const expectedHoldId = makeMutationHoldId(
      session.rsid,
      scope,
      orderedOrigins,
    );
    const bridgeEvidence: GatewayDurableBridgeEvidencePort = {
      inspectDispatch: async () => {
        if (pending === null) return { kind: "not_durable_yet" as const };
        const retained = pending;
        return {
          kind: "found" as const,
          observation: {
            // This intentionally indeterminate observation has no committed
            // Bridge ACK; custom recovery fixtures must not synthesize one.
            acceptance: null,
            journal: {
              kind: "indeterminate" as const,
              rsid: session.rsid,
              sessionBindingId: retained.sessionBindingId,
              envelopeDigest: retained.envelopeDigest,
              journalRecords: retained.journalRecords.map((journal) =>
                markJournalIndeterminate(markJournalExecuting(journal), expectedHoldId),
              ),
              batchTerminal: null,
              durableJournalVersion: 1,
              recordedAtMs: Date.now(),
            },
          },
        };
      },
      authorizeDispatchTarget: async (tx, expected) =>
        bridge.authorizeDispatchTarget(tx, expected),
      authorizeResumeTarget: async (tx, expected) =>
        bridge.authorizeResumeTarget(tx, expected),
    };
    const recovery = await createComposedRecovery(store, bridge, bridgeEvidence);
    const batch: GatewayAtomicBatchExecutorRequest = {
      batchId: id(),
      atomic: true,
      steps: orderedInvocationIds.map((invocationId) =>
        request(session.rsid, true, scope, invocationId),
      ),
    };
    const draft = bridge.buildAtomicBatchEnvelope(batch);
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const prepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope: draft.envelope,
      expected: draft.expected,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(`ordered batch was not prepared: ${prepared.kind}`);
    }
    pending = prepared.dispatch;
    const execution = bridge.executeAtomicBatch(batch, prepared.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: prepared.dispatch.envelopeDigest,
    })).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [expectedHoldId],
    });
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    const legacyRecord = store.snapshot().find(
      (record) =>
        record.namespace === "gateway.recovery-authority/v1" &&
        record.key === session.rsid,
    )?.value as GatewayJsonObject;
    const legacyHolds = ((legacyRecord.ledger as GatewayJsonObject).holds ?? []) as GatewayJsonObject[];
    expect(legacyHolds[0]).toMatchObject({
      holdId: expectedHoldId,
      originIdempotencyKeys: orderedOrigins,
    });
    const normalized = store.snapshot().find(
      (record) =>
        record.namespace === "gateway.mutation-hold/v1" &&
        record.key === expectedHoldId,
    )?.value as GatewayJsonObject;
    expect(normalized).toMatchObject({
      holdId: expectedHoldId,
      originIdempotencyKeys: orderedOrigins,
    });
    await recovery.port.close();
  });

  it("poisons an unclassifiable legacy mutation before refusing companion installation", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    const execution = authority.createExecutor().execute(request(session.rsid, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => {
      const sessionValue = value as GatewayJsonObject;
      const pending = { ...(sessionValue.pending as GatewayJsonObject) };
      delete pending.mutationEntries;
      return { ...sessionValue, pending };
    });
    await expect(
      authority.receive(session.connectionId, unregister(session.rsid)),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    const poisoned = sessionForLegacyProof(store, session.rsid);
    expect((poisoned.egressFence as GatewayJsonObject).state).toBe(
      "revocation_pending",
    );
    expect((poisoned.normalizedConflictIndex as GatewayJsonObject).state).toBe(
      "overflow",
    );
    expect(store.snapshot().some(
      (record) => record.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
    )).toBe(false);
    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    await expect(execution).resolves.toMatchObject({ state: "failed" });
  });

  it("allows reads and disjoint documents through valid normalized holds", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();

    const blocked = await register(authority);
    seedNormalizedHold(
      store,
      blocked.rsid,
      { kind: "document", document_id: "doc-a" },
      [`${blocked.rsid}/${id()}`],
    );
    await expect(
      authority.createExecutor().execute(
        request(blocked.rsid, true, { kind: "document", document_id: "doc-a" }),
      ),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    await expect(
      authority.createExecutor().execute(
        request(blocked.rsid, true, { kind: "session" }),
      ),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    const read = authority.createExecutor().execute(request(blocked.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blocked.channel.frames.some((frame) => frame.type === "invoke")).toBe(true);
    await authority.receive(blocked.connectionId, unregister(blocked.rsid));
    await expect(read).resolves.toMatchObject({ state: "failed" });

    const disjoint = await register(authority);
    seedNormalizedHold(
      store,
      disjoint.rsid,
      { kind: "document", document_id: "doc-a" },
      [`${disjoint.rsid}/${id()}`],
    );
    const allowed = authority.createExecutor().execute(
      request(disjoint.rsid, true, { kind: "document", document_id: "doc-b" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disjoint.channel.frames.some((frame) => frame.type === "invoke")).toBe(true);
    await authority.receive(disjoint.connectionId, unregister(disjoint.rsid));
    await expect(allowed).resolves.toMatchObject({
      state: "failed",
      error: { code: "journal_indeterminate" },
    });
  });

  it("unions legacy holds until an exact valid cutover suppresses them", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const legacy = await register(authority);
    seedLegacyHold(
      store,
      legacy.rsid,
      { kind: "session" },
      [`${legacy.rsid}/${id()}`],
    );
    await expect(
      authority.createExecutor().execute(
        request(legacy.rsid, true, { kind: "document", document_id: "doc-a" }),
      ),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    const read = authority.createExecutor().execute(request(legacy.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(legacy.connectionId, unregister(legacy.rsid));
    await expect(read).resolves.toMatchObject({ state: "failed" });

    const cutover = await register(authority);
    const cutoverOrigin = `${cutover.rsid}/${id()}`;
    const cutoverResolution = legacyResolutionFixture("cutover-cleared");
    seedLegacyHold(
      store,
      cutover.rsid,
      { kind: "session" },
      [cutoverOrigin],
      {
        state: "cleared",
        resolution: cutoverResolution,
        clearedBy: cutoverResolution.authorizedDispatchIdentity as string,
      },
    );
    seedNormalizedHold(
      store,
      cutover.rsid,
      { kind: "session" },
      [cutoverOrigin],
      {
        hold: (value) => ({
          ...value,
          state: "cleared",
          resolutionIds: [cutoverResolution.resolutionId],
        }),
        conflict: (value) => ({ ...value, active: false }),
      },
    );
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", cutover.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      normalizedConflictIndex: {
        version: 1,
        state: "complete",
        scopeDigests: [],
      },
    }));
    seedValidCutover(store, cutover.rsid);
    const mutation = authority.createExecutor().execute(
      request(cutover.rsid, true, { kind: "document", document_id: "doc-b" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cutover.channel.frames.some((frame) => frame.type === "invoke")).toBe(true);
    await authority.receive(cutover.connectionId, unregister(cutover.rsid));
    await expect(mutation).resolves.toMatchObject({
      error: { code: "journal_indeterminate" },
    });
  });

  it("preserves nonlexical legacy origin ordering while enforcing its scope", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    seedLegacyHold(
      store,
      session.rsid,
      { kind: "document", document_id: "doc-origin-order" },
      [`${session.rsid}/z-origin`, `${session.rsid}/a-origin`],
    );
    await expect(
      authority.createExecutor().execute(
        request(
          session.rsid,
          true,
          { kind: "document", document_id: "doc-origin-order" },
        ),
      ),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
  });

  it.each(CUTOVER_CORRUPTIONS)(
    "fails closed for malformed cutover field %s",
    async (_name, mutateMarker) => {
      const store = new ControlledStoreHarness();
      const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(authority);
      await authority.open();
      const session = await register(authority);
      seedValidCutover(store, session.rsid, mutateMarker);
      await expect(
        authority.createExecutor().execute(
          request(session.rsid, true, { kind: "session" }),
        ),
      ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    },
  );

  it.each(["digest", "count", "index", "pair", "missing_pair"] as const)(
    "fails closed for shape-valid cutover semantic disagreement: %s",
    async (target) => {
      const store = new ControlledStoreHarness();
      const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(authority);
      await authority.open();
      const session = await register(authority);
      const scope = { kind: "document", document_id: "doc-cutover" } as const;
      const origin = `${session.rsid}/${id()}`;
      const semanticResolution = legacyResolutionFixture("semantic-cutover");
      const holdId = seedLegacyHold(store, session.rsid, scope, [origin], {
        state: "cleared",
        resolution: semanticResolution,
        clearedBy: semanticResolution.authorizedDispatchIdentity as string,
      });
      seedNormalizedHold(store, session.rsid, scope, [origin], {
        hold: (value) => ({
          ...value,
          state: "cleared",
          resolutionIds: [semanticResolution.resolutionId],
        }),
        conflict: (value) => ({ ...value, active: false }),
      });
      store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
        ...(value as GatewayJsonObject),
        normalizedConflictIndex: {
          version: 1,
          state: "complete",
          scopeDigests: [],
        },
      }));
      seedValidCutover(store, session.rsid);
      if (target === "digest") {
        store.rewrite(TENANT_ID, "gateway.hold-cutover/v1", session.rsid, (value) => ({
          ...(value as GatewayJsonObject),
          legacyDigest: `sha256:${"b".repeat(64)}`,
        }));
      } else if (target === "count") {
        store.rewrite(TENANT_ID, "gateway.hold-cutover/v1", session.rsid, (value) => ({
          ...(value as GatewayJsonObject),
          importedConflictCount: 2,
        }));
      } else if (target === "index") {
        store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
          ...(value as GatewayJsonObject),
          normalizedConflictIndex: {
            version: 1,
            state: "overflow",
            scopeDigests: [],
          },
        }));
      } else if (target === "pair") {
        store.rewrite(TENANT_ID, "gateway.mutation-hold/v1", holdId, (value) => ({
          ...(value as GatewayJsonObject),
          state: "active",
        }));
      } else {
        store.remove(
          TENANT_ID,
          "gateway.mutation-conflict/v1",
          `${session.rsid}/${scopeDigest(scope)}`,
        );
      }
      const attempt = authority.createExecutor().execute(
        request(session.rsid, true, { kind: "document", document_id: "doc-free" }),
      );
      if (target === "index") {
        await expect(attempt).resolves.toMatchObject({
          error: { code: "executor_unavailable" },
        });
      } else {
        await expect(attempt).rejects.toMatchObject({
          httpStatus: 503,
          closeCode: 1011,
        });
      }
      expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    },
  );

  it("retains nonempty WP-10 import proof after real legacy deletion and restart", async () => {
    const store = new ControlledStoreHarness();
    const original = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(original);
    await original.open();
    const session = await register(original);
    const observations = new Map<string, GatewayBridgeEvidenceLookup>();
    const bridgeEvidence: GatewayDurableBridgeEvidencePort = {
      inspectDispatch: async (_tx, expected) =>
        observations.get(expected.envelopeDigest) ?? {
          kind: "not_durable_yet" as const,
        },
      authorizeDispatchTarget: async (tx, expected) =>
        original.authorizeDispatchTarget(tx, expected),
      authorizeResumeTarget: async (tx, expected) =>
        original.authorizeResumeTarget(tx, expected),
    };
    const recovery = await createComposedRecovery(
      store,
      original,
      bridgeEvidence,
      "postcondition_verified",
    );
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const installActive = async (
      scope: MutationScope,
      label: string,
    ): Promise<{
      readonly holdId: string;
      readonly origin: string;
      readonly scope: MutationScope;
    }> => {
      const mutationRequest = request(session.rsid, true, scope);
      const draft = original.buildEnvelope(mutationRequest);
      const prepared = await recovery.authority.prepareMutationDispatch({
        tenantId: TENANT_ID,
        attemptId,
        sessionBindingId: draft.sessionBindingId,
        connectionId: draft.connectionId,
        envelope: draft.envelope,
        expected: draft.expected,
      });
      if (prepared.kind !== "prepared") {
        throw new Error(`${label} hold was not prepared: ${prepared.kind}`);
      }
      const origin = `${session.rsid}/${mutationRequest.context.invocationId}`;
      const holdId = makeMutationHoldId(session.rsid, scope, [origin]);
      observations.set(prepared.dispatch.envelopeDigest, {
        kind: "found",
        observation: {
          acceptance: syntacticRecoveryAcceptanceFixture(prepared.dispatch, 1),
          journal: {
            kind: "indeterminate",
            rsid: session.rsid,
            sessionBindingId: prepared.dispatch.sessionBindingId,
            envelopeDigest: prepared.dispatch.envelopeDigest,
            journalRecords: prepared.dispatch.journalRecords.map((journal) =>
              markJournalIndeterminate(markJournalExecuting(journal), holdId),
            ),
            batchTerminal: null,
            durableJournalVersion: 1,
            recordedAtMs: Date.now(),
          },
        },
      });
      const reconciled = await recovery.authority.reconcilePendingDispatch({
        tenantId: TENANT_ID,
        rsid: session.rsid,
        envelopeDigest: prepared.dispatch.envelopeDigest,
      });
      if (reconciled.kind !== "indeterminate_recorded") {
        throw new Error(`${label} hold was not installed: ${reconciled.kind}`);
      }
      return { holdId, origin, scope };
    };
    const cleared = await installActive(
      { kind: "document", document_id: "doc-cleared-history" },
      "cleared",
    );
    const verificationRequest = request(session.rsid, false);
    const verificationDraft = original.buildEnvelope(verificationRequest);
    const verification = {
      hold_id: cleared.holdId,
      mutation_scope: cleared.scope,
      purpose: "resolve_indeterminate" as const,
    };
    const verificationEnvelope = {
      ...verificationDraft.envelope,
      payload: { ...verificationDraft.envelope.payload, verification },
    } as unknown as InvokeEnvelope;
    const verificationPrepared = await recovery.authority.prepareVerificationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: verificationDraft.sessionBindingId,
      connectionId: verificationDraft.connectionId,
      envelope: verificationEnvelope,
      expected: {
        rsid: session.rsid,
        invocationId: verificationRequest.context.invocationId,
        binding: {
          ...verificationDraft.expected.bindings[0]!,
          verification,
        },
      },
    });
    if (verificationPrepared.kind !== "prepared") {
      throw new Error(`selected evidence was not prepared: ${verificationPrepared.kind}`);
    }
    observations.set(verificationPrepared.dispatch.envelopeDigest, {
      kind: "found",
      observation: {
        acceptance: syntacticRecoveryAcceptanceFixture(verificationPrepared.dispatch, 2),
        journal: {
          kind: "known_terminal",
          rsid: session.rsid,
          sessionBindingId: verificationPrepared.dispatch.sessionBindingId,
          envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
          journalRecords: verificationPrepared.dispatch.journalRecords.map(
            (journal) => recordJournalTerminal(markJournalExecuting(journal), {
              status: "completed",
              resultDigest: makeParamsDigest({ selected: true }),
              payloadRetained: true,
              payload: { selected: true },
            }),
          ),
          batchTerminal: null,
          durableJournalVersion: 2,
          recordedAtMs: Date.now(),
        },
      },
    });
    await recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
    });
    await recovery.authority.recordVerificationEvidence({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
    });
    const planned = await recovery.authority.planRecoveryClearances({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      mutationScopes: [cleared.scope],
      decisions: [{
        holdId: cleared.holdId,
        decision: "postcondition_verified",
      }],
    });
    if (planned.kind !== "planned") {
      throw new Error(`selected clearance was not planned: ${planned.kind}`);
    }
    const clearanceRequest = request(session.rsid, true, cleared.scope);
    const clearanceDraft = original.buildEnvelope(clearanceRequest);
    const clearanceEnvelope = {
      ...clearanceDraft.envelope,
      payload: {
        ...clearanceDraft.envelope.payload,
        recovery_clearances: planned.plan.clearances,
      },
    } as unknown as InvokeEnvelope;
    const clearancePrepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: clearanceDraft.sessionBindingId,
      connectionId: clearanceDraft.connectionId,
      envelope: clearanceEnvelope,
      expected: {
        ...clearanceDraft.expected,
        bindings: clearanceDraft.expected.bindings.map((binding) => ({
          ...binding,
          recoveryClearances: planned.plan.clearances,
        })),
        recoveryClearances: planned.plan.clearances,
      },
    });
    if (clearancePrepared.kind !== "prepared") {
      throw new Error(`selected clearance was not prepared: ${clearancePrepared.kind}`);
    }
    observations.set(clearancePrepared.dispatch.envelopeDigest, {
      kind: "found",
      observation: {
        acceptance: syntacticRecoveryAcceptanceFixture(clearancePrepared.dispatch, 3),
        journal: {
          kind: "known_terminal",
          rsid: session.rsid,
          sessionBindingId: clearancePrepared.dispatch.sessionBindingId,
          envelopeDigest: clearancePrepared.dispatch.envelopeDigest,
          journalRecords: clearancePrepared.dispatch.journalRecords.map(
            (journal) => recordJournalTerminal(markJournalExecuting(journal), {
              status: "completed",
              resultDigest: makeParamsDigest({ cleared: true }),
              payloadRetained: true,
              payload: { cleared: true },
            }),
          ),
          batchTerminal: null,
          durableJournalVersion: 3,
          recordedAtMs: Date.now(),
        },
      },
    });
    await expect(recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: clearancePrepared.dispatch.envelopeDigest,
    })).resolves.toMatchObject({
      kind: "terminal_recorded",
      clearedHoldIds: [cleared.holdId],
    });
    const active = await installActive(
      { kind: "document", document_id: "doc-active-history" },
      "active",
    );
    const recoveryRecord = store.snapshot().find(
      (record) =>
        record.namespace === "gateway.recovery-authority/v1" &&
        record.key === session.rsid,
    )?.value as GatewayJsonObject;
    const legacyHolds = ((recoveryRecord.ledger as GatewayJsonObject).holds ?? []) as GatewayJsonObject[];
    const clearedRecord = legacyHolds.find((hold) => hold.holdId === cleared.holdId)!;
    const activeRecord = legacyHolds.find((hold) => hold.holdId === active.holdId)!;
    seedNormalizedHold(store, session.rsid, active.scope, [active.origin], {
      index: false,
      hold: (value) => ({ ...value, state: activeRecord.state }),
    });
    seedNormalizedHold(store, session.rsid, cleared.scope, [cleared.origin], {
      index: false,
      hold: (value) => ({
        ...value,
        state: clearedRecord.state,
        resolutionIds: [
          (clearedRecord.resolution as GatewayJsonObject).resolutionId,
        ],
      }),
      conflict: (value) => ({ ...value, active: false }),
    });
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      normalizedConflictIndex: {
        version: 1,
        state: "complete",
        scopeDigests: [scopeDigest(active.scope)],
      },
    }));
    seedValidCutover(store, session.rsid);
    const retainedMarker = store.snapshot().find(
      (record) =>
        record.namespace === "gateway.hold-cutover/v1" &&
        record.key === session.rsid,
    )?.value as GatewayJsonObject;
    expect(retainedMarker).toMatchObject({
      importedHoldCount: 2,
      importedConflictCount: 2,
      importedResolutionCount: 1,
      legacyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    store.remove(TENANT_ID, "gateway.recovery-authority/v1", session.rsid);
    await original.detach(session.connectionId);
    const restarted = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(restarted);
    await restarted.open();
    const restartedConnection = await openConnection(restarted);
    await restarted.receive(
      restartedConnection.connectionId,
      resume(session.rsid, session.resumeToken),
    );
    await expect(
      restarted.createExecutor().execute(request(session.rsid, true, active.scope)),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    const disjoint = restarted.createExecutor().execute(
      request(
        session.rsid,
        true,
        { kind: "document", document_id: "doc-disjoint-after-delete" },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restartedConnection.channel.frames.some(
      (frame) => frame.type === "invoke",
    )).toBe(true);
    await restarted.receive(
      restartedConnection.connectionId,
      unregister(session.rsid),
    );
    await expect(disjoint).resolves.toMatchObject({ state: "failed" });
    await recovery.port.close();
  });

  it.each(["marker", "dangling"] as const)(
    "fails closed for normalized-only cutover disagreement: %s",
    async (target) => {
      const store = new ControlledStoreHarness();
      const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(authority);
      await authority.open();
      const session = await register(authority);
      const seeded = seedNormalizedHold(
        store,
        session.rsid,
        { kind: "document", document_id: "doc-normalized-only" },
        [`${session.rsid}/${id()}`],
      );
      seedValidCutover(store, session.rsid);
      if (target === "marker") {
        store.rewrite(TENANT_ID, "gateway.hold-cutover/v1", session.rsid, (value) => ({
          ...(value as GatewayJsonObject),
          rsid: "different-rsid",
        }));
      } else {
        store.remove(TENANT_ID, "gateway.mutation-hold/v1", seeded.holdId);
      }
      await expect(
        authority.createExecutor().execute(
          request(
            session.rsid,
            true,
            { kind: "document", document_id: "doc-disjoint-after-cutover" },
          ),
        ),
      ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
      expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    },
  );

  it("keeps overflow bounded and refuses a new unrecoverable document scope before send", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    const digests = Array.from({ length: 256 }, (_, index) =>
      seedNormalizedHold(
        store,
        session.rsid,
        { kind: "document", document_id: `doc-overflow-${index.toString().padStart(3, "0")}` },
        [`${session.rsid}/${gatewayUuidV7(Date.now() + index + 1)}`],
        { index: false },
      ).digest,
    ).sort();
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
      ...(value as GatewayJsonObject),
      normalizedConflictIndex: {
        version: 1,
        state: "overflow",
        scopeDigests: digests,
      },
    }));
    await expect(
      authority.createExecutor().execute(
        request(session.rsid, true, { kind: "session" }),
      ),
    ).resolves.toMatchObject({
      error: { code: "executor_unavailable" },
    });
    await expect(
      authority.createExecutor().execute(
        request(session.rsid, true, { kind: "document", document_id: "doc-free" }),
      ),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    await authority.receive(session.connectionId, unregister(session.rsid));
  });

  it("refuses a 65-scope mutation batch before reserving or sending", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const recovery = await createComposedRecovery(store, bridge);
    const batch: GatewayAtomicBatchExecutorRequest = {
      batchId: id(),
      atomic: true,
      steps: Array.from({ length: 65 }, (_, index) =>
        request(
          session.rsid,
          true,
          { kind: "document", document_id: `doc-capacity-${index.toString().padStart(2, "0")}` },
        ),
      ),
    };
    const draft = bridge.buildAtomicBatchEnvelope(batch);
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const prepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope: draft.envelope,
      expected: draft.expected,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(`capacity batch was not prepared: ${prepared.kind}`);
    }
    await expect(
      bridge.executeAtomicBatch(batch, prepared.dispatch),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    expect(session.channel.frames.some((frame) => frame.type === "invoke_batch")).toBe(false);
    const durable = sessionForLegacyProof(store, session.rsid);
    expect(durable.pending).toBeNull();
    expect((durable.egressFence as GatewayJsonObject).lease).toBeNull();
    await recovery.port.close();
  });

  it("persists exactly 64 scopes through the real 128-write-limit adapter", async () => {
    const runtime = createPreProductionRuntimeAdapters({
      protocolStore: {
        maxTransactionWrites: 128,
        maxRecords: 2_048,
      },
    });
    const bridge = new GatewayBridgeSessionAuthority(runtime.protocolStore, identity(), {
      servingOwnership: runtime.servingOwnership,
    });
    authorities.push(bridge);
    await bridge.open();
    const recovery = new GatewayRecoveryAuthority(runtime.servingOwnership.protocolStore, {
      bridgeEvidence: bridge,
      evidenceDecision: {
        async decideEvidence() {
          return {
            kind: "decided" as const,
            conclusion: "inconclusive" as const,
            authorityReference: "wp02-64-scope",
            decisionVersion: 1,
            decidedAtMs: Date.now(),
          };
        },
      },
      clock: Date.now,
      newId: gatewayUuidV7,
    });
    const session = await register(bridge);
    const steps = Array.from({ length: 64 }, (_, index) =>
      request(
        session.rsid,
        true,
        { kind: "document", document_id: `doc-limit-${index.toString().padStart(2, "0")}` },
      ),
    );
    const batch: GatewayAtomicBatchExecutorRequest = {
      batchId: id(),
      atomic: true,
      steps,
    };
    const draft = bridge.buildAtomicBatchEnvelope(batch);
    const attemptId = id();
    await recovery.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const prepared = await recovery.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope: draft.envelope,
      expected: draft.expected,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(`64-scope batch was not prepared: ${prepared.kind}`);
    }
    const execution = bridge.executeAtomicBatch(batch, prepared.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.some((frame) => frame.type === "invoke_batch")).toBe(true);
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    const expectedHolds = steps.map((step) =>
      makeMutationHoldId(
        session.rsid,
        step.context.mutationScope!,
        [`${session.rsid}/${step.context.invocationId}`],
      ),
    ).sort();
    const verified = await runtime.protocolStore.transact(
      { tenantId: TENANT_ID },
      async (tx) => {
        const tombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          session.rsid,
        );
        const pairs = await Promise.all(steps.map(async (step, index) => {
          const holdId = expectedHolds.find((candidate) =>
            candidate === makeMutationHoldId(
              session.rsid,
              step.context.mutationScope!,
              [`${session.rsid}/${step.context.invocationId}`],
            ),
          )!;
          const digest = scopeDigest(step.context.mutationScope!);
          return {
            hold: await tx.read<GatewayJsonValue>(
              "gateway.mutation-hold/v1",
              holdId,
            ),
            conflict: await tx.read<GatewayJsonValue>(
              "gateway.mutation-conflict/v1",
              `${session.rsid}/${digest}`,
            ),
            index,
          };
        }));
        return { tombstone, pairs };
      },
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.message);
    expect((verified.value.tombstone?.value as GatewayJsonObject).holdIds).toEqual(
      expectedHolds,
    );
    expect(verified.value.pairs.every(
      (pair) => pair.hold !== null && pair.conflict !== null,
    )).toBe(true);
  });

  it("uses no tenant-wide list for dispatch or unregister authority", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const session = await register(authority);
    store.forbidList = true;
    const execution = authority.createExecutor().execute(request(session.rsid, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    expect(store.listCalls).toBe(0);
  });

  it("composes GatewayRecoveryAuthority verification reads through a live scoped hold", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const scope = { kind: "document", document_id: "doc-verify" } as const;
    const origin = `${session.rsid}/${id()}`;
    const holdId = seedLegacyHold(store, session.rsid, scope, [origin]);
    seedNormalizedHold(store, session.rsid, scope, [origin]);
    const recovery = await createComposedRecovery(store, bridge);
    const attemptId = id();
    await expect(recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    })).resolves.toMatchObject({ kind: "acquired" });
    const readRequest = request(session.rsid, false);
    const draft = bridge.buildEnvelope(readRequest);
    const verification = {
      hold_id: holdId,
      mutation_scope: scope,
      purpose: "resolve_indeterminate" as const,
    };
    const envelope = {
      ...draft.envelope,
      payload: { ...draft.envelope.payload, verification },
    } as unknown as InvokeEnvelope;
    const binding = {
      ...draft.expected.bindings[0]!,
      verification,
    };
    const prepared = await recovery.authority.prepareVerificationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope,
      expected: {
        rsid: session.rsid,
        invocationId: readRequest.context.invocationId,
        binding,
      },
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(`verification was not prepared: ${prepared.kind}`);
    }
    const execution = bridge.execute(readRequest, prepared.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(true);
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    await recovery.port.close();
  });

  it("composes exact retained origin redelivery without generic session-wide denial", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    let retained: GatewayRecoveryPendingDispatch | null = null;
    const bridgeEvidence: GatewayDurableBridgeEvidencePort = {
      inspectDispatch: async () => {
        if (retained === null) return { kind: "not_durable_yet" as const };
        const pending = retained;
        const originKey = `${session.rsid}/${originalRequest.context.invocationId}`;
        const holdId = makeMutationHoldId(session.rsid, { kind: "session" }, [originKey]);
        return {
          kind: "found" as const,
          observation: {
            acceptance: syntacticRecoveryAcceptanceFixture(pending, 1),
            journal: {
              kind: "indeterminate" as const,
              rsid: session.rsid,
              sessionBindingId: pending.sessionBindingId,
              envelopeDigest: pending.envelopeDigest,
              journalRecords: pending.journalRecords.map((journal) =>
                markJournalIndeterminate(markJournalExecuting(journal), holdId),
              ),
              batchTerminal: null,
              durableJournalVersion: 1,
              recordedAtMs: Date.now(),
            },
          },
        };
      },
      authorizeDispatchTarget: async (tx, expected) =>
        bridge.authorizeDispatchTarget(tx, expected),
      authorizeResumeTarget: async (tx, expected) =>
        bridge.authorizeResumeTarget(tx, expected),
    };
    const recovery = await createComposedRecovery(store, bridge, bridgeEvidence);
    const originalRequest = request(session.rsid, true, { kind: "session" });
    const originalDraft = bridge.buildEnvelope(originalRequest);
    const firstAttempt = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId: firstAttempt,
    });
    const first = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId: firstAttempt,
      sessionBindingId: originalDraft.sessionBindingId,
      connectionId: originalDraft.connectionId,
      envelope: originalDraft.envelope,
      expected: originalDraft.expected,
    });
    expect(first.kind).toBe("prepared");
    if (first.kind !== "prepared") throw new Error(`origin not prepared: ${first.kind}`);
    retained = first.dispatch;
    const originKey = `${session.rsid}/${originalRequest.context.invocationId}`;
    const holdId = makeMutationHoldId(session.rsid, { kind: "session" }, [originKey]);
    await expect(recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: first.dispatch.envelopeDigest,
    })).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });
    seedNormalizedHold(store, session.rsid, { kind: "session" }, [originKey]);
    store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => {
      const sessionValue = value as GatewayJsonObject;
      const sequence = sessionValue.sequence as GatewayJsonObject;
      return {
        ...sessionValue,
        sequence: {
          ...sequence,
          nextTxSeq: 2,
          highestTxSeq: 1,
          outbox: [],
        },
      };
    });
    const redeliveryEnvelope: InvokeEnvelope = {
      ...originalDraft.envelope,
      id: id(),
      seq: 2,
      ts: new Date().toISOString(),
    };
    const redeliveryAttempt = firstAttempt;
    const redelivery = await recovery.authority.prepareOriginRedelivery({
      tenantId: TENANT_ID,
      attemptId: redeliveryAttempt,
      rsid: session.rsid,
      idempotencyKey: originKey,
      sessionBindingId: originalDraft.sessionBindingId,
      connectionId: originalDraft.connectionId,
      envelope: redeliveryEnvelope,
      expected: originalDraft.expected,
    });
    if (redelivery.kind !== "prepared") {
      throw new Error(`redelivery was not prepared: ${JSON.stringify(redelivery)}`);
    }
    expect(redelivery.kind).toBe("prepared");
    const execution = bridge.execute(originalRequest, redelivery.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    await recovery.port.close();
  });

  it("has GatewayRecoveryAuthority refuse caller clearance bytes without a resolution plan", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const scope = { kind: "document", document_id: "doc-clearance" } as const;
    const origin = `${session.rsid}/${id()}`;
    const holdId = seedLegacyHold(store, session.rsid, scope, [origin]);
    seedNormalizedHold(store, session.rsid, scope, [origin]);
    const recovery = await createComposedRecovery(store, bridge);
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const mutationRequest = request(session.rsid, true, scope);
    const draft = bridge.buildEnvelope(mutationRequest);
    const clearance = {
      hold_id: holdId,
      mutation_scope: scope,
      resolution_id: id(),
      basis: "verification_read" as const,
      verification_invocation_id: id(),
      evidence_digest: makeParamsDigest({ caller: "untrusted" }),
      decision: "postcondition_verified" as const,
      audit_id: id(),
    };
    const envelope = {
      ...draft.envelope,
      payload: {
        ...draft.envelope.payload,
        recovery_clearances: [clearance],
      },
    } as unknown as InvokeEnvelope;
    const expected = {
      ...draft.expected,
      bindings: draft.expected.bindings.map((binding) => ({
        ...binding,
        recoveryClearances: [clearance],
      })),
      recoveryClearances: [clearance],
    };
    const prepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope,
      expected,
    });
    expect(prepared.kind).not.toBe("prepared");
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    await recovery.port.close();
  });

  it("allows an authenticated legacy-only clearance while normalized clearance remains deferred", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const observations = new Map<string, GatewayBridgeEvidenceLookup>();
    const bridgeEvidence: GatewayDurableBridgeEvidencePort = {
      inspectDispatch: async (_tx, expected) =>
        observations.get(expected.envelopeDigest) ?? {
          kind: "not_durable_yet" as const,
        },
      authorizeDispatchTarget: async (tx, expected) =>
        bridge.authorizeDispatchTarget(tx, expected),
      authorizeResumeTarget: async (tx, expected) =>
        bridge.authorizeResumeTarget(tx, expected),
    };
    const recovery = await createComposedRecovery(
      store,
      bridge,
      bridgeEvidence,
      "postcondition_verified",
    );
    const attemptId = id();
    await recovery.authority.acquireInvocationWindow({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      attemptId,
    });
    const scope = { kind: "document", document_id: "doc-legacy-clearance" } as const;
    const originRequest = request(session.rsid, true, scope);
    const originDraft = bridge.buildEnvelope(originRequest);
    const originPrepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: originDraft.sessionBindingId,
      connectionId: originDraft.connectionId,
      envelope: originDraft.envelope,
      expected: originDraft.expected,
    });
    expect(originPrepared.kind).toBe("prepared");
    if (originPrepared.kind !== "prepared") {
      throw new Error(`legacy origin was not prepared: ${originPrepared.kind}`);
    }
    const originKey = `${session.rsid}/${originRequest.context.invocationId}`;
    const holdId = makeMutationHoldId(session.rsid, scope, [originKey]);
    const indeterminateJournals = originPrepared.dispatch.journalRecords.map(
      (journal) => markJournalIndeterminate(markJournalExecuting(journal), holdId),
    );
    observations.set(originPrepared.dispatch.envelopeDigest, {
      kind: "found",
      observation: {
        acceptance: syntacticRecoveryAcceptanceFixture(originPrepared.dispatch, 1),
        journal: {
          kind: "indeterminate",
          rsid: session.rsid,
          sessionBindingId: originPrepared.dispatch.sessionBindingId,
          envelopeDigest: originPrepared.dispatch.envelopeDigest,
          journalRecords: indeterminateJournals,
          batchTerminal: null,
          durableJournalVersion: 1,
          recordedAtMs: Date.now(),
        },
      },
    });
    await expect(recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: originPrepared.dispatch.envelopeDigest,
    })).resolves.toMatchObject({ kind: "indeterminate_recorded" });

    const verificationRequest = request(session.rsid, false);
    const verificationDraft = bridge.buildEnvelope(verificationRequest);
    const verification = {
      hold_id: holdId,
      mutation_scope: scope,
      purpose: "resolve_indeterminate" as const,
    };
    const verificationEnvelope = {
      ...verificationDraft.envelope,
      payload: { ...verificationDraft.envelope.payload, verification },
    } as unknown as InvokeEnvelope;
    const verificationPrepared = await recovery.authority.prepareVerificationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: verificationDraft.sessionBindingId,
      connectionId: verificationDraft.connectionId,
      envelope: verificationEnvelope,
      expected: {
        rsid: session.rsid,
        invocationId: verificationRequest.context.invocationId,
        binding: {
          ...verificationDraft.expected.bindings[0]!,
          verification,
        },
      },
    });
    expect(verificationPrepared.kind).toBe("prepared");
    if (verificationPrepared.kind !== "prepared") {
      throw new Error(`verification was not prepared: ${verificationPrepared.kind}`);
    }
    const terminalJournals = verificationPrepared.dispatch.journalRecords.map(
      (journal) => recordJournalTerminal(markJournalExecuting(journal), {
        status: "completed",
        resultDigest: makeParamsDigest({ verified: true }),
        payloadRetained: true,
        payload: { verified: true },
      }),
    );
    observations.set(verificationPrepared.dispatch.envelopeDigest, {
      kind: "found",
      observation: {
        acceptance: syntacticRecoveryAcceptanceFixture(verificationPrepared.dispatch, 2),
        journal: {
          kind: "known_terminal",
          rsid: session.rsid,
          sessionBindingId: verificationPrepared.dispatch.sessionBindingId,
          envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
          journalRecords: terminalJournals,
          batchTerminal: null,
          durableJournalVersion: 2,
          recordedAtMs: Date.now(),
        },
      },
    });
    await expect(recovery.authority.reconcilePendingDispatch({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
    })).resolves.toMatchObject({ kind: "verification_evidence_ready" });
    await expect(recovery.authority.recordVerificationEvidence({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      envelopeDigest: verificationPrepared.dispatch.envelopeDigest,
    })).resolves.toMatchObject({
      kind: "recorded",
      hold: { holdId, state: "evidence_recorded" },
    });
    const planned = await recovery.authority.planRecoveryClearances({
      tenantId: TENANT_ID,
      rsid: session.rsid,
      mutationScopes: [scope],
      decisions: [{ holdId, decision: "postcondition_verified" }],
    });
    expect(planned.kind).toBe("planned");
    if (planned.kind !== "planned") {
      throw new Error(`clearance was not planned: ${planned.kind}`);
    }
    const clearedRequest = request(session.rsid, true, scope);
    const clearedDraft = bridge.buildEnvelope(clearedRequest);
    const clearedEnvelope = {
      ...clearedDraft.envelope,
      payload: {
        ...clearedDraft.envelope.payload,
        recovery_clearances: planned.plan.clearances,
      },
    } as unknown as InvokeEnvelope;
    const clearedPrepared = await recovery.authority.prepareMutationDispatch({
      tenantId: TENANT_ID,
      attemptId,
      sessionBindingId: clearedDraft.sessionBindingId,
      connectionId: clearedDraft.connectionId,
      envelope: clearedEnvelope,
      expected: {
        ...clearedDraft.expected,
        bindings: clearedDraft.expected.bindings.map((binding) => ({
          ...binding,
          recoveryClearances: planned.plan.clearances,
        })),
        recoveryClearances: planned.plan.clearances,
      },
    });
    expect(clearedPrepared.kind).toBe("prepared");
    if (clearedPrepared.kind !== "prepared") {
      throw new Error(`legacy clearance was not prepared: ${clearedPrepared.kind}`);
    }
    const execution = bridge.execute(clearedRequest, clearedPrepared.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
    await bridge.receive(session.connectionId, unregister(session.rsid));
    await expect(execution).resolves.toMatchObject({ state: "failed" });
    await recovery.port.close();
  });

  it("keeps normalized resolved_pending_bridge authority blocking until WP-03", async () => {
    const store = new ControlledStoreHarness();
    const bridge = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(bridge);
    await bridge.open();
    const session = await register(bridge);
    const scope = { kind: "document", document_id: "doc-wp03-deferred" } as const;
    const invocationId = id();
    const origin = `${session.rsid}/${invocationId}`;
    const seeded = seedNormalizedHold(store, session.rsid, scope, [origin], {
      hold: (value) => ({ ...value, state: "resolved_pending_bridge" }),
    });
    const requestWithClearance = request(session.rsid, true, scope, invocationId);
    const draft = bridge.buildEnvelope(requestWithClearance);
    const clearance = {
      hold_id: seeded.holdId,
      mutation_scope: scope,
      resolution_id: id(),
      basis: "verification_read" as const,
      verification_invocation_id: id(),
      evidence_digest: makeParamsDigest({ trusted: true }),
      decision: "postcondition_verified" as const,
      audit_id: id(),
    };
    const envelope = {
      ...draft.envelope,
      payload: {
        ...draft.envelope.payload,
        recovery_clearances: [clearance],
      },
    } as unknown as InvokeEnvelope;
    const prepared = {
      kind: "mutation",
      envelope,
      envelopeDigest: dataEnvelopeImmutableDigest(
        envelope as unknown as Parameters<typeof dataEnvelopeImmutableDigest>[0],
      ),
      gatewaySequence: envelope.seq,
      sessionBindingId: draft.sessionBindingId,
      preparedConnectionId: draft.connectionId,
      authorizedSessionVersion: 1,
      mutationEntries: [{
        invocationId,
        idempotencyKey: origin,
        mutationScope: scope,
        journalBindingDigest: makeParamsDigest({ binding: origin }),
      }],
      journalRecords: [],
      recoveryHoldIds: [seeded.holdId],
      recoveryClearances: [clearance],
      originRedelivery: false,
    } as unknown as GatewayRecoveryPendingDispatch;
    await expect(
      bridge.execute(requestWithClearance, prepared),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
  });

  it("rejects forged redelivery metadata and caller-authored clearance bytes", async () => {
    const store = new ControlledStoreHarness();
    const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
    authorities.push(authority);
    await authority.open();
    const exact = await register(authority);
    const exactInvocationId = id();
    const exactRequest = request(
      exact.rsid,
      true,
      { kind: "session" },
      exactInvocationId,
    );
    seedNormalizedHold(
      store,
      exact.rsid,
      { kind: "session" },
      [`${exact.rsid}/${exactInvocationId}`],
    );
    const exactDraft = authority.buildEnvelope(exactRequest);
    await expect(
      authority.execute(
        exactRequest,
        {
          envelope: exactDraft.envelope,
          journalRecords: [],
          originRedelivery: true,
        } as unknown as GatewayRecoveryPendingDispatch,
      ),
    ).rejects.toMatchObject({ code: "protocol", closeCode: 4400 });
    expect(exact.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    await authority.receive(exact.connectionId, unregister(exact.rsid));

    const fresh = await register(authority);
    seedNormalizedHold(
      store,
      fresh.rsid,
      { kind: "session" },
      [`${fresh.rsid}/${id()}`],
    );
    const freshRequest = request(fresh.rsid, true, { kind: "session" });
    await expect(
      authority.createExecutor().execute(freshRequest),
    ).resolves.toMatchObject({ error: { code: "executor_unavailable" } });
    const clearanceDraft = authority.buildEnvelope(freshRequest);
    const clearanceEnvelope = structuredClone(clearanceDraft.envelope) as InvokeEnvelope;
    (clearanceEnvelope.payload as unknown as { recovery_clearances: unknown[] })
      .recovery_clearances = [{ hold_id: "caller-bytes-cannot-clear" }];
    await expect(
      authority.execute(
        freshRequest,
        {
          envelope: clearanceEnvelope,
          journalRecords: [],
          originRedelivery: false,
        } as unknown as GatewayRecoveryPendingDispatch,
      ),
    ).rejects.toMatchObject({ code: "protocol", closeCode: 4400 });
  });

  it.each(NORMALIZED_CORRUPTIONS)(
    "fails closed for normalized hold/conflict corruption: %s",
    async (_name, corruption) => {
      const store = new ControlledStoreHarness();
      const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(authority);
      await authority.open();
      const session = await register(authority);
      seedNormalizedHold(
        store,
        session.rsid,
        { kind: "document", document_id: "doc-a" },
        [`${session.rsid}/${id()}`],
        corruption,
      );
      await expect(
        authority.createExecutor().execute(
          request(session.rsid, true, { kind: "document", document_id: "doc-a" }),
        ),
      ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    },
  );

  it.each(["tombstone_hold", "session_index"] as const)(
    "rejects cross-record unregister corruption in %s",
    async (target) => {
      const store = new ControlledStoreHarness();
      const authority = new GatewayBridgeSessionAuthority(store.createPort(), identity());
      authorities.push(authority);
      await authority.open();
      const session = await register(authority);
      const execution = authority.createExecutor().execute(request(session.rsid, true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await authority.receive(session.connectionId, unregister(session.rsid));
      await expect(execution).resolves.toMatchObject({ state: "failed" });
      if (target === "tombstone_hold") {
        store.rewrite(
          TENANT_ID,
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          session.rsid,
          (value) => ({
            ...(value as GatewayJsonObject),
            holdIds: [`vh:${"f".repeat(64)}`],
          }),
        );
      } else {
        store.rewrite(TENANT_ID, "gateway.rbp-session/v1", session.rsid, (value) => ({
          ...(value as GatewayJsonObject),
          normalizedConflictIndex: {
            version: 1,
            state: "complete",
            scopeDigests: [],
          },
        }));
      }
      const replay = await openConnection(authority);
      await expect(
        authority.receive(replay.connectionId, unregister(session.rsid)),
      ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    },
  );
});
