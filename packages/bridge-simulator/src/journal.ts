import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  authorizeMutationDispatch,
  createMutationHoldLedger,
  createReceivedJournalRecord,
  createRbpSequenceState,
  decideJournalRedelivery,
  handleJournalSessionUnregister,
  installMutationHolds,
  journalRecordIsIntact,
  makeJournalBindingDigest,
  makeIdempotencyKey,
  markJournalExecuting,
  markJournalIndeterminate,
  mutationScopeKey,
  recordJournalTerminal,
  recordLateTerminalEvidence,
  recordVerificationEvidence,
  recoveryClearanceForHold,
  requestJournalCancellation,
  resolveMutationHold,
  type HoldEvidenceConclusion,
  type HoldResolutionDecision,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type JournalRedeliveryDecision,
  type MutationHold,
  type MutationHoldLedger,
  type RecoveryClearance,
  type RbpSequenceState,
  type TerminalJournalOutcome,
  type UnregisterJournalDecision,
} from "@revagent/protocol";
import Database from "better-sqlite3";

export interface JournalDurabilityProfile {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly fullFsyncRequested: true;
}

export interface DurabilityEvent {
  readonly sequence: number;
  readonly action: string;
  readonly subject: string;
  readonly atMs: number;
}

export type AcceptInvocationResult =
  | { readonly kind: "accepted"; readonly record: InvocationJournalRecord }
  | { readonly kind: "blocked"; readonly holds: readonly MutationHold[] }
  | { readonly kind: "protocol_fault"; readonly reason: string }
  | Exclude<JournalRedeliveryDecision, { readonly kind: "protocol_fault" }>;

export type BatchInvocationDecision = Exclude<
  AcceptInvocationResult,
  { readonly kind: "blocked" | "protocol_fault" }
> | { readonly kind: "not_started"; readonly record: InvocationJournalRecord };

export type AcceptBatchInvocationsResult =
  | { readonly kind: "accepted"; readonly decisions: readonly BatchInvocationDecision[] }
  | { readonly kind: "blocked"; readonly holds: readonly MutationHold[] }
  | { readonly kind: "protocol_fault"; readonly reason: string };

interface InvocationRow {
  readonly record_json: string;
  readonly binding_digest: string;
  readonly state: string;
}

interface HoldRow {
  readonly hold_json: string;
}

interface SequenceRow {
  readonly sequence_json: string;
}

export interface BatchCoordinationState {
  readonly batchId: string;
  readonly rsid: string;
  readonly batchDigest: string;
  readonly state: "received" | "dispatched" | "terminal" | "indeterminate";
  readonly terminalJson: string | null;
}

export interface DurableDeliveryDraft {
  readonly deliveryId: string;
  readonly ordinal: number;
  readonly draftJson: string;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function deliveryCarrierFromDraft(draftJson: string): { readonly identity: string; readonly carrierJson: string } | null {
  const draft = parseJson<unknown>(draftJson, "durable delivery draft");
  if (typeof draft !== "object" || draft === null || !("deliveryCarrier" in draft)) return null;
  const carrier = draft.deliveryCarrier;
  if (
    typeof carrier !== "object" || carrier === null ||
    !("rsid" in carrier) || typeof carrier.rsid !== "string" ||
    !("invocationId" in carrier) || typeof carrier.invocationId !== "string"
  ) return null;
  return {
    identity: `${carrier.rsid}/${carrier.invocationId}`,
    carrierJson: JSON.stringify(carrier),
  };
}

function assertSafeTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
}

export class DurableBridgeJournal {
  readonly #path: string;
  readonly #db: Database.Database;
  readonly #busyTimeoutMs: number;
  #closed = false;

  public constructor(path: string, options: { readonly busyTimeoutMs?: number } = {}) {
    if (path.length === 0) throw new Error("journal path is required");
    this.#path = path === ":memory:" ? path : resolve(path);
    this.#busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true });
    this.#db = new Database(this.#path);
    this.#db.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("fullfsync = ON");
    this.#db.pragma("checkpoint_fullfsync = ON");
    this.#migrate();
    this.classifyInterruptedAtomicBatches(Date.now());
    this.classifyInterruptedMutations(Date.now());
  }

  public get path(): string {
    return this.#path;
  }

  public get durabilityProfile(): JournalDurabilityProfile {
    this.#assertOpen();
    return {
      journalMode: String(this.#db.pragma("journal_mode", { simple: true })),
      synchronous: Number(this.#db.pragma("synchronous", { simple: true })),
      foreignKeys: Number(this.#db.pragma("foreign_keys", { simple: true })),
      busyTimeoutMs: this.#busyTimeoutMs,
      fullFsyncRequested: true,
    };
  }

  public close(): void {
    if (this.#closed) return;
    this.#db.pragma("wal_checkpoint(TRUNCATE)");
    this.#db.close();
    this.#closed = true;
  }

  public getInvocation(rsid: string, invocationId: string): InvocationJournalRecord | null {
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT record_json, binding_digest, state FROM invocation_journal WHERE rsid=? AND invocation_id=?")
      .get(rsid, invocationId) as InvocationRow | undefined;
    if (row === undefined) return null;
    const record = parseJson<InvocationJournalRecord>(row.record_json, "invocation journal row");
    if (
      record.bindingDigest !== row.binding_digest ||
      record.state !== row.state ||
      !journalRecordIsIntact(record)
    ) {
      throw new Error("durable invocation journal integrity mismatch");
    }
    return record;
  }

  public listInvocations(): readonly InvocationJournalRecord[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT record_json, binding_digest, state FROM invocation_journal ORDER BY rsid, invocation_id")
      .all() as InvocationRow[];
    return rows.map((row) => {
      const record = parseJson<InvocationJournalRecord>(row.record_json, "invocation journal row");
      if (
        record.bindingDigest !== row.binding_digest ||
        record.state !== row.state ||
        !journalRecordIsIntact(record)
      ) {
        throw new Error("durable invocation journal integrity mismatch");
      }
      return record;
    });
  }

  public listHolds(): readonly MutationHold[] {
    return this.#loadLedger().holds;
  }

  public durabilityEvents(): readonly DurabilityEvent[] {
    this.#assertOpen();
    return this.#db
      .prepare("SELECT sequence, action, subject, at_ms AS atMs FROM durability_events ORDER BY sequence")
      .all() as DurabilityEvent[];
  }

  /**
   * Durably accepts an invocation. Hold authorization/consumption and the
   * received row occur in the same SQLite transaction.
   */
  public acceptInvocation(
    binding: InvocationJournalBinding,
    dispatchIdentity: string,
    atMs = Date.now(),
  ): AcceptInvocationResult {
    assertSafeTime(atMs, "atMs");
    const key = makeIdempotencyKey(binding.rsid, binding.invocationId);
    return this.#durable("accept_received", key, atMs, () => {
      const existing = this.#getInvocationWithinTransaction(binding.rsid, binding.invocationId);
      if (existing !== null) {
        let promotionHoldId: string | null = null;
        if (
          existing.binding.mutating &&
          existing.terminalOutcome === null &&
          existing.lateTerminalOutcome === null &&
          existing.state !== "indeterminate"
        ) {
          const installed = installMutationHolds(this.#loadLedger(), binding.rsid, [
            {
              originIdempotencyKey: key,
              mutationScope: existing.binding.mutationScope as Exclude<
                InvocationJournalBinding["mutationScope"],
                null
              >,
            },
          ]);
          if (installed.kind === "blocked") {
            return { kind: "blocked", holds: installed.conflictingHolds };
          }
          promotionHoldId = installed.holds[0]?.holdId ?? null;
          this.#storeLedger(installed.ledger, atMs);
        }
        const decision = decideJournalRedelivery(existing, binding, promotionHoldId);
        if (decision.kind === "protocol_fault") {
          return { kind: "protocol_fault", reason: decision.reason };
        }
        if (decision.record !== existing) this.#saveInvocation(decision.record, atMs);
        return decision;
      }

      let ledger = this.#loadLedger();
      if (binding.verification != null) {
        const hold = ledger.holds.find(
          (candidate) =>
            candidate.rsid === binding.rsid &&
            candidate.holdId === binding.verification?.hold_id &&
            candidate.scopeKey === mutationScopeKey(binding.verification.mutation_scope) &&
            candidate.state !== "cleared",
        );
        if (hold === undefined) return { kind: "protocol_fault", reason: "foreign_verification_hold" };
      }
      if (binding.mutating) {
        const scope = binding.mutationScope;
        if (scope === null) return { kind: "protocol_fault", reason: "missing_mutation_scope" };
        const authorization = authorizeMutationDispatch(ledger, {
          rsid: binding.rsid,
          mutationScopes: [scope],
          recoveryClearances: binding.recoveryClearances ?? [],
          dispatchIdentity,
        });
        if (authorization.kind === "blocked") {
          return { kind: "blocked", holds: authorization.conflictingHolds };
        }
        if (authorization.kind === "protocol_fault") {
          return { kind: "protocol_fault", reason: authorization.reason };
        }
        ledger = authorization.ledger;
        this.#storeLedger(ledger, atMs);
      }
      const record = createReceivedJournalRecord(binding);
      this.#insertInvocation(record, atMs);
      return { kind: "accepted", record };
    });
  }

  public markExecuting(rsid: string, invocationId: string, atMs = Date.now()): InvocationJournalRecord {
    const key = makeIdempotencyKey(rsid, invocationId);
    return this.#durable("dispatch_owned", key, atMs, () => {
      const record = this.#requireInvocation(rsid, invocationId);
      const executing = markJournalExecuting(record);
      this.#saveInvocation(executing, atMs, atMs);
      return executing;
    });
  }

  public markExecutingMany(
    identities: readonly { readonly rsid: string; readonly invocationId: string }[],
    atMs = Date.now(),
  ): readonly InvocationJournalRecord[] {
    if (identities.length === 0) return [];
    const subject = identities
      .map((entry) => makeIdempotencyKey(entry.rsid, entry.invocationId))
      .sort()
      .join(",");
    return this.#durable("batch_dispatch_owned", subject, atMs, () =>
      identities.map((entry) => {
        const executing = markJournalExecuting(this.#requireInvocation(entry.rsid, entry.invocationId));
        this.#saveInvocation(executing, atMs, atMs);
        return executing;
      }),
    );
  }

  public recordTerminal(
    rsid: string,
    invocationId: string,
    outcome: TerminalJournalOutcome,
    atMs = Date.now(),
  ): InvocationJournalRecord {
    const key = makeIdempotencyKey(rsid, invocationId);
    return this.#durable("terminal_committed", key, atMs, () => {
      const terminal = recordJournalTerminal(this.#requireInvocation(rsid, invocationId), outcome);
      this.#saveInvocation(terminal, atMs, undefined, atMs);
      return terminal;
    });
  }

  public recordTerminals(
    entries: readonly {
      readonly rsid: string;
      readonly invocationId: string;
      readonly outcome: TerminalJournalOutcome;
    }[],
    atMs = Date.now(),
  ): readonly InvocationJournalRecord[] {
    if (entries.length === 0) return [];
    const subject = entries
      .map((entry) => makeIdempotencyKey(entry.rsid, entry.invocationId))
      .sort()
      .join(",");
    return this.#durable("batch_terminal_committed", subject, atMs, () =>
      entries.map((entry) => {
        const terminal = recordJournalTerminal(
          this.#requireInvocation(entry.rsid, entry.invocationId),
          entry.outcome,
        );
        this.#saveInvocation(terminal, atMs, undefined, atMs);
        return terminal;
      }),
    );
  }

  public requestCancellation(
    rsid: string,
    invocationId: string,
    atMs = Date.now(),
  ): { readonly kind: "cancelled_before_dispatch" | "await_real_outcome" | "already_terminal"; readonly record: InvocationJournalRecord } {
    const key = makeIdempotencyKey(rsid, invocationId);
    return this.#durable("cancel_requested", key, atMs, () => {
      const decision = requestJournalCancellation(this.#requireInvocation(rsid, invocationId));
      this.#saveInvocation(
        decision.record,
        atMs,
        undefined,
        decision.kind === "cancelled_before_dispatch" ? atMs : undefined,
      );
      return decision;
    });
  }

  public markIndeterminate(
    rsid: string,
    invocationId: string,
    atMs = Date.now(),
  ): InvocationJournalRecord {
    return this.markIndeterminateMany([{ rsid, invocationId }], atMs)[0] as InvocationJournalRecord;
  }

  /** Installs one hold per conflicting scope with every uncertain origin bound to it. */
  public markIndeterminateMany(
    identities: readonly { readonly rsid: string; readonly invocationId: string }[],
    atMs = Date.now(),
  ): readonly InvocationJournalRecord[] {
    if (identities.length === 0) return [];
    const subject = identities
      .map((entry) => makeIdempotencyKey(entry.rsid, entry.invocationId))
      .sort()
      .join(",");
    return this.#durable("indeterminate_with_hold", subject, atMs, () => {
      const records = identities.map((entry) => this.#requireInvocation(entry.rsid, entry.invocationId));
      const sessionIds = new Set(records.map((record) => record.binding.rsid));
      if (sessionIds.size !== 1) throw new Error("bulk indeterminate promotion must stay within one rsid");
      const rsid = records[0]?.binding.rsid as string;
      const uncertain = records.flatMap((record) => {
        if (!record.binding.mutating) return [];
        if (record.binding.mutationScope === null) throw new Error("mutation journal lost its scope");
        return [{
          originIdempotencyKey: makeIdempotencyKey(rsid, record.binding.invocationId),
          mutationScope: record.binding.mutationScope,
        }];
      });
      let ledger = this.#loadLedger();
      let installedHolds: readonly MutationHold[] = [];
      if (uncertain.length > 0) {
        const installed = installMutationHolds(ledger, rsid, uncertain);
        if (installed.kind === "blocked") {
          const keys = new Set(uncertain.map((entry) => entry.originIdempotencyKey));
          const covered = new Set(installed.conflictingHolds.flatMap((hold) => hold.originIdempotencyKeys));
          if ([...keys].some((key) => !covered.has(key))) {
            throw new Error("another active hold conflicts with origin promotion");
          }
          installedHolds = installed.conflictingHolds;
        } else {
          ledger = installed.ledger;
          installedHolds = installed.holds;
          this.#storeLedger(ledger, atMs);
        }
      }
      return records.map((record) => {
        const key = makeIdempotencyKey(record.binding.rsid, record.binding.invocationId);
        const holdId = record.binding.mutating
          ? installedHolds.find((hold) => hold.originIdempotencyKeys.includes(key))?.holdId ?? null
          : null;
        const indeterminate = markJournalIndeterminate(record, holdId);
        this.#saveInvocation(indeterminate, atMs, undefined, atMs);
        return indeterminate;
      });
    });
  }

  /** Classifies only possibly dispatched mutations. Reads remain recoverable. */
  public classifyInterruptedMutations(atMs = Date.now()): readonly InvocationJournalRecord[] {
    assertSafeTime(atMs, "atMs");
    const candidates = this.listInvocations().filter(
      (record) =>
        record.binding.mutating &&
        record.dispatchMayHaveStarted &&
        (record.state === "received" || record.state === "executing"),
    );
    const grouped = new Map<string, InvocationJournalRecord[]>();
    for (const record of candidates) {
      const records = grouped.get(record.binding.rsid) ?? [];
      records.push(record);
      grouped.set(record.binding.rsid, records);
    }
    return [...grouped.values()].flatMap((records) =>
      this.markIndeterminateMany(
        records.map((record) => ({
          rsid: record.binding.rsid,
          invocationId: record.binding.invocationId,
        })),
        atMs,
      ),
    );
  }

  /**
   * Recovers atomic batches whose one-frame dispatch ownership was durable but
   * whose terminal carrier was not. Mutation holds and the coordination state
   * are committed together, preserving batch input order for hold identity.
   */
  public classifyInterruptedAtomicBatches(atMs = Date.now()): readonly InvocationJournalRecord[] {
    assertSafeTime(atMs, "atMs");
    const batches = this.#db
      .prepare(
        `SELECT batch_id AS batchId,rsid,batch_digest AS batchDigest,binding_json AS bindingJson
         FROM batch_coordination WHERE state='dispatched' ORDER BY created_at_ms,batch_id`,
      )
      .all() as Array<{
        readonly batchId: string;
        readonly rsid: string;
        readonly batchDigest: string;
        readonly bindingJson: string;
      }>;
    const recovered: InvocationJournalRecord[] = [];
    for (const batch of batches) {
      const binding = parseJson<{ readonly atomic?: unknown }>(batch.bindingJson, "batch binding");
      if (binding.atomic !== true) continue;
      recovered.push(...this.#durable("atomic_batch_interrupted", batch.batchId, atMs, () => {
        const rows = this.#db
          .prepare(
            `SELECT record_json,binding_digest,state FROM invocation_journal
             WHERE rsid=? AND batch_id=? ORDER BY batch_index`,
          )
          .all(batch.rsid, batch.batchId) as InvocationRow[];
        const records = rows.map((row) => {
          const record = parseJson<InvocationJournalRecord>(row.record_json, "atomic batch step");
          if (!journalRecordIsIntact(record)) throw new Error("atomic batch journal integrity mismatch");
          return record;
        });
        if (records.length === 0) throw new Error("dispatched atomic batch has no step rows");
        const uncertain = records.flatMap((record) => {
          if (!record.binding.mutating || record.state === "indeterminate") return [];
          if (record.terminalOutcome !== null || record.lateTerminalOutcome !== null) {
            throw new Error("dispatched atomic batch has a contradictory terminal prefix");
          }
          if (record.binding.mutationScope === null) throw new Error("mutation journal lost its scope");
          return [{
            originIdempotencyKey: makeIdempotencyKey(batch.rsid, record.binding.invocationId),
            mutationScope: record.binding.mutationScope,
          }];
        });
        let installedHolds: readonly MutationHold[] = [];
        if (uncertain.length > 0) {
          const installed = installMutationHolds(this.#loadLedger(), batch.rsid, uncertain);
          if (installed.kind === "blocked") {
            const expected = new Set(uncertain.map((entry) => entry.originIdempotencyKey));
            const covered = new Set(installed.conflictingHolds.flatMap((hold) => hold.originIdempotencyKeys));
            if ([...expected].some((key) => !covered.has(key))) {
              throw new Error("another active hold conflicts with atomic recovery");
            }
            installedHolds = installed.conflictingHolds;
          } else {
            installedHolds = installed.holds;
            this.#storeLedger(installed.ledger, atMs);
          }
        }
        const updated = records.map((record) => {
          if (!record.binding.mutating || record.state === "indeterminate") return record;
          const key = makeIdempotencyKey(batch.rsid, record.binding.invocationId);
          const holdId = installedHolds.find((hold) => hold.originIdempotencyKeys.includes(key))?.holdId ?? null;
          const indeterminate = markJournalIndeterminate(record, holdId);
          this.#saveInvocation(indeterminate, atMs, undefined, atMs);
          return indeterminate;
        });
        this.#db
          .prepare("UPDATE batch_coordination SET state='indeterminate',updated_at_ms=? WHERE batch_id=? AND state='dispatched'")
          .run(atMs, batch.batchId);
        return updated;
      }));
    }
    return recovered;
  }

  public classifyPendingExpiry(
    cutoffStartedAtMs: number,
    atMs = Date.now(),
  ): readonly InvocationJournalRecord[] {
    assertSafeTime(cutoffStartedAtMs, "cutoffStartedAtMs");
    assertSafeTime(atMs, "atMs");
    const rows = this.#db
      .prepare(
        `SELECT record_json, binding_digest, state FROM invocation_journal
         WHERE mutating=1 AND dispatch_may_have_started=1
           AND state IN ('received','executing') AND COALESCE(started_at_ms, created_at_ms) <= ?
         ORDER BY rsid, invocation_id`,
      )
      .all(cutoffStartedAtMs) as InvocationRow[];
    const grouped = new Map<string, InvocationJournalRecord[]>();
    for (const row of rows) {
      const record = parseJson<InvocationJournalRecord>(row.record_json, "pending invocation");
      const records = grouped.get(record.binding.rsid) ?? [];
      records.push(record);
      grouped.set(record.binding.rsid, records);
    }
    return [...grouped.values()].flatMap((records) =>
      this.markIndeterminateMany(
        records.map((record) => ({
          rsid: record.binding.rsid,
          invocationId: record.binding.invocationId,
        })),
        atMs,
      ),
    );
  }

  /**
   * Revokes one session without converting a possibly dispatched mutation to
   * a known failure. Hold creation and every affected journal transition are
   * committed together.
   */
  public unregisterSession(
    rsid: string,
    atMs = Date.now(),
  ): readonly UnregisterJournalDecision[] {
    if (rsid.length === 0) throw new TypeError("rsid is required");
    return this.#durable("session_unregister", rsid, atMs, () => {
      const records = this.listInvocations().filter(
        (record) =>
          record.binding.rsid === rsid &&
          record.terminalOutcome === null &&
          record.state !== "indeterminate",
      );
      const uncertain = records.flatMap((record) => {
        if (!record.binding.mutating || !record.dispatchMayHaveStarted) return [];
        if (record.binding.mutationScope === null) throw new Error("mutation journal lost its scope");
        return [{
          originIdempotencyKey: makeIdempotencyKey(rsid, record.binding.invocationId),
          mutationScope: record.binding.mutationScope,
        }];
      });
      let installedHolds: readonly MutationHold[] = [];
      if (uncertain.length > 0) {
        const ledger = this.#loadLedger();
        const installed = installMutationHolds(ledger, rsid, uncertain);
        if (installed.kind === "blocked") {
          const expected = new Set(uncertain.map((entry) => entry.originIdempotencyKey));
          const covered = new Set(
            installed.conflictingHolds.flatMap((hold) => hold.originIdempotencyKeys),
          );
          if ([...expected].some((key) => !covered.has(key))) {
            throw new Error("another active hold conflicts with session unregistration");
          }
          installedHolds = installed.conflictingHolds;
        } else {
          installedHolds = installed.holds;
          this.#storeLedger(installed.ledger, atMs);
        }
      }

      const decisions = records.map((record) => {
        const key = makeIdempotencyKey(rsid, record.binding.invocationId);
        const holdId = record.binding.mutating && record.dispatchMayHaveStarted
          ? installedHolds.find((hold) => hold.originIdempotencyKeys.includes(key))?.holdId ?? null
          : null;
        const decision = handleJournalSessionUnregister(
          record,
          !record.dispatchMayHaveStarted,
          holdId,
        );
        this.#saveInvocation(decision.record, atMs, undefined, atMs);
        return decision;
      });
      this.#queueSessionDeliveryExpiry(rsid, atMs);
      this.#db.prepare("DELETE FROM artifact_outbox WHERE rsid=?").run(rsid);
      this.#db.prepare("DELETE FROM artifact_delivery_plan WHERE rsid=?").run(rsid);
      this.#db.prepare("DELETE FROM session_sequence WHERE rsid=?").run(rsid);
      return decisions;
    });
  }

  public recordVerificationAttempt(input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly verificationInvocationId: string;
    readonly evidenceDigest: string;
    readonly conclusion: HoldEvidenceConclusion;
    readonly atMs?: number;
  }): MutationHold {
    const atMs = input.atMs ?? Date.now();
    return this.#durable("verification_evidence", input.holdId, atMs, () => {
      const ledger = this.#loadLedger();
      const hold = ledger.holds.find(
        (candidate) => candidate.rsid === input.rsid && candidate.holdId === input.holdId,
      );
      if (hold === undefined) throw new Error("verification references a foreign hold");
      const record = this.#requireInvocation(input.rsid, input.verificationInvocationId);
      const result = recordVerificationEvidence(ledger, {
        rsid: input.rsid,
        holdId: input.holdId,
        mutationScope: hold.mutationScope,
        verificationInvocationId: input.verificationInvocationId,
        evidenceDigest: input.evidenceDigest,
        conclusion: input.conclusion,
        journalRecord: record,
      });
      if (result.kind === "rejected") throw new Error(`verification evidence rejected: ${result.reason}`);
      this.#storeLedger(result.ledger, atMs);
      return result.hold;
    });
  }

  public recordLateEvidence(input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly originInvocationId: string;
    readonly evidenceDigest: string;
    readonly conclusion: HoldEvidenceConclusion;
    readonly atMs?: number;
  }): MutationHold {
    const atMs = input.atMs ?? Date.now();
    return this.#durable("late_terminal_evidence", input.holdId, atMs, () => {
      const ledger = this.#loadLedger();
      const record = this.#requireInvocation(input.rsid, input.originInvocationId);
      const result = recordLateTerminalEvidence(ledger, {
        rsid: input.rsid,
        holdId: input.holdId,
        originIdempotencyKey: makeIdempotencyKey(input.rsid, input.originInvocationId),
        evidenceDigest: input.evidenceDigest,
        conclusion: input.conclusion,
        journalRecord: record,
      });
      if (result.kind === "rejected") throw new Error(`late evidence rejected: ${result.reason}`);
      this.#storeLedger(result.ledger, atMs);
      return result.hold;
    });
  }

  public resolveHold(input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly basis: "verification_read" | "late_terminal";
    readonly verificationInvocationId: string | null;
    readonly evidenceDigest: string;
    readonly decision: HoldResolutionDecision;
    readonly resolutionId: string;
    readonly auditId: string;
    readonly authorizedDispatchIdentity: string;
    readonly atMs?: number;
  }): MutationHold {
    const atMs = input.atMs ?? Date.now();
    return this.#durable("hold_resolved", input.holdId, atMs, () => {
      const result = resolveMutationHold(this.#loadLedger(), input);
      if (result.kind === "rejected") throw new Error(`hold resolution rejected: ${result.reason}`);
      this.#storeLedger(result.ledger, atMs);
      return result.hold;
    });
  }

  public clearanceForHold(rsid: string, holdId: string): RecoveryClearance {
    const hold = this.#loadLedger().holds.find(
      (candidate) => candidate.rsid === rsid && candidate.holdId === holdId,
    );
    if (hold === undefined) throw new Error("unknown recovery hold");
    return recoveryClearanceForHold(hold);
  }

  public loadSequence(rsid: string): RbpSequenceState {
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT sequence_json FROM session_sequence WHERE rsid=?")
      .get(rsid) as SequenceRow | undefined;
    return row === undefined
      ? createRbpSequenceState(rsid)
      : parseJson<RbpSequenceState>(row.sequence_json, "sequence row");
  }

  public saveSequence(state: RbpSequenceState, atMs = Date.now()): void {
    this.#durable("sequence_state", state.rsid, atMs, () => {
      this.#db
        .prepare(
          `INSERT INTO session_sequence(rsid,sequence_json,updated_at_ms) VALUES(?,?,?)
           ON CONFLICT(rsid) DO UPDATE SET sequence_json=excluded.sequence_json,updated_at_ms=excluded.updated_at_ms`,
        )
        .run(state.rsid, JSON.stringify(state), atMs);
    });
  }

  public saveSequenceWithCarrier(
    state: RbpSequenceState,
    seq: number,
    carrierJson: string,
    atMs = Date.now(),
  ): void {
    this.#durable("sequence_artifact_state", `${state.rsid}/${seq}`, atMs, () => {
      this.#db
        .prepare(
          `INSERT INTO session_sequence(rsid,sequence_json,updated_at_ms) VALUES(?,?,?)
           ON CONFLICT(rsid) DO UPDATE SET sequence_json=excluded.sequence_json,updated_at_ms=excluded.updated_at_ms`,
        )
        .run(state.rsid, JSON.stringify(state), atMs);
      this.#db
        .prepare("INSERT INTO artifact_outbox(rsid,seq,carrier_json,created_at_ms) VALUES(?,?,?,?)")
        .run(state.rsid, seq, carrierJson, atMs);
    });
  }

  /**
   * Persists an artifact delivery independently from the RBP sequence window.
   * The ordered drafts survive a process restart before any one draft is
   * assigned a sequence number.  Re-staging the same invocation is idempotent:
   * the first durable plan remains authoritative, including sender-owned ids.
   */
  public stageDurableDelivery(input: {
    readonly rsid: string;
    readonly deliveryId: string;
    readonly draftJsons: readonly string[];
    readonly terminalOrdinal: number;
    readonly atMs?: number;
  }): "accepted" | "replayed" {
    const atMs = input.atMs ?? Date.now();
    if (input.draftJsons.length === 0) throw new Error("artifact delivery plan is empty");
    if (input.terminalOrdinal !== input.draftJsons.length - 1) {
      throw new Error("artifact delivery terminal must be the final ordered draft");
    }
    return this.#durable("artifact_delivery_staged", `${input.rsid}/${input.deliveryId}`, atMs, () => {
      const existing = this.#db
        .prepare("SELECT rsid,state,terminal_ordinal FROM artifact_delivery_plan WHERE delivery_id=?")
        .get(input.deliveryId) as {
          readonly rsid: string;
          readonly state: string;
          readonly terminal_ordinal: number;
        } | undefined;
      if (existing !== undefined) {
        if (existing.rsid !== input.rsid || existing.terminal_ordinal !== input.terminalOrdinal) {
          throw new Error("artifact delivery identity mismatch");
        }
        return "replayed";
      }
      this.#db.prepare(
        `INSERT INTO artifact_delivery_plan(
          delivery_id,rsid,state,terminal_ordinal,terminal_seq,created_at_ms,updated_at_ms
        ) VALUES(?,?,'pending',?,NULL,?,?)`,
      ).run(input.deliveryId, input.rsid, input.terminalOrdinal, atMs, atMs);
      const insert = this.#db.prepare(
        "INSERT INTO artifact_delivery_draft(delivery_id,ordinal,draft_json) VALUES(?,?,?)",
      );
      input.draftJsons.forEach((draftJson, ordinal) => {
        parseJson<unknown>(draftJson, "artifact delivery draft");
        insert.run(input.deliveryId, ordinal, draftJson);
      });
      return "accepted";
    });
  }

  public nextDurableDeliveryDraft(rsid: string): DurableDeliveryDraft | null {
    this.#assertOpen();
    const row = this.#db.prepare(
      `SELECT p.delivery_id AS deliveryId,d.ordinal,d.draft_json AS draftJson
       FROM artifact_delivery_plan p
       JOIN artifact_delivery_draft d ON d.delivery_id=p.delivery_id
       WHERE p.rsid=? AND p.state='pending'
       ORDER BY p.created_at_ms,p.delivery_id,d.ordinal
       LIMIT 1`,
    ).get(rsid) as DurableDeliveryDraft | undefined;
    if (row === undefined) return null;
    parseJson<unknown>(row.draftJson, "artifact delivery draft");
    return row;
  }

  public pendingDurableDeliveryDraftCount(rsid?: string): number {
    this.#assertOpen();
    const row = (rsid === undefined
      ? this.#db.prepare("SELECT COUNT(*) AS count FROM artifact_delivery_draft").get()
      : this.#db.prepare(
        `SELECT COUNT(*) AS count
         FROM artifact_delivery_draft d
         JOIN artifact_delivery_plan p ON p.delivery_id=d.delivery_id
         WHERE p.rsid=?`,
      ).get(rsid)) as { readonly count: number };
    return row.count;
  }

  /**
   * Reports whether an invocation already has a durable artifact delivery in
   * either the sequence-independent plan or the terminal outbox.  Checking
   * both stores keeps restart recovery idempotent across the plan migration.
   */
  public hasDurableDelivery(rsid: string, invocationId: string): boolean {
    this.#assertOpen();
    const deliveryId = `${rsid}/${invocationId}`;
    const plan = this.#db
      .prepare("SELECT 1 AS present FROM artifact_delivery_plan WHERE delivery_id=?")
      .get(deliveryId) as { readonly present: number } | undefined;
    if (plan !== undefined) return true;
    const outbox = this.#db
      .prepare("SELECT carrier_json AS carrierJson FROM artifact_outbox")
      .all() as Array<{ readonly carrierJson: string }>;
    return outbox.some((row) => {
      const carrier = parseJson<unknown>(row.carrierJson, "artifact outbox carrier");
      return typeof carrier === "object" && carrier !== null &&
        "rsid" in carrier && carrier.rsid === rsid &&
        "invocationId" in carrier && carrier.invocationId === invocationId;
    });
  }

  public durableDeliveryDisposition(
    rsid: string,
    invocationId: string,
  ): "active" | "acked" | "expired" | null {
    this.#assertOpen();
    if (this.hasDurableDelivery(rsid, invocationId)) return "active";
    const row = this.#db.prepare(
      "SELECT disposition FROM artifact_delivery_tombstone WHERE delivery_id=? AND rsid=?",
    ).get(`${rsid}/${invocationId}`, rsid) as { readonly disposition: "acked" | "expired" } | undefined;
    return row?.disposition ?? null;
  }

  /**
   * Assigns one staged artifact draft its sequence and consumes it in the same
   * FULL-synchronous SQLite transaction.  A crash can therefore reveal either
   * the still-unsequenced draft or the durable outbox frame, never neither.
   */
  public saveSequenceAndConsumeDeliveryDraft(input: {
    readonly state: RbpSequenceState;
    readonly seq: number;
    readonly deliveryId: string;
    readonly ordinal: number;
    readonly draftJson: string;
    readonly terminalCarrierJson?: string;
    readonly atMs?: number;
  }): void {
    const atMs = input.atMs ?? Date.now();
    this.#durable("artifact_delivery_sequenced", `${input.state.rsid}/${input.seq}`, atMs, () => {
      const plan = this.#db.prepare(
        "SELECT rsid,state,terminal_ordinal FROM artifact_delivery_plan WHERE delivery_id=?",
      ).get(input.deliveryId) as {
        readonly rsid: string;
        readonly state: string;
        readonly terminal_ordinal: number;
      } | undefined;
      const draft = this.#db.prepare(
        "SELECT draft_json FROM artifact_delivery_draft WHERE delivery_id=? AND ordinal=?",
      ).get(input.deliveryId, input.ordinal) as { readonly draft_json: string } | undefined;
      const first = this.#db.prepare(
        "SELECT MIN(ordinal) AS ordinal FROM artifact_delivery_draft WHERE delivery_id=?",
      ).get(input.deliveryId) as { readonly ordinal: number | null };
      if (
        plan === undefined || plan.rsid !== input.state.rsid || plan.state !== "pending" ||
        draft?.draft_json !== input.draftJson || first.ordinal !== input.ordinal
      ) {
        throw new Error("artifact delivery draft is not the next durable member");
      }
      const isTerminal = input.ordinal === plan.terminal_ordinal;
      if (isTerminal !== (input.terminalCarrierJson !== undefined)) {
        throw new Error("artifact delivery terminal/carrier binding mismatch");
      }
      this.#db.prepare(
        `INSERT INTO session_sequence(rsid,sequence_json,updated_at_ms) VALUES(?,?,?)
         ON CONFLICT(rsid) DO UPDATE SET sequence_json=excluded.sequence_json,updated_at_ms=excluded.updated_at_ms`,
      ).run(input.state.rsid, JSON.stringify(input.state), atMs);
      this.#db.prepare(
        "DELETE FROM artifact_delivery_draft WHERE delivery_id=? AND ordinal=?",
      ).run(input.deliveryId, input.ordinal);
      if (input.terminalCarrierJson !== undefined) {
        parseJson<unknown>(input.terminalCarrierJson, "artifact terminal carrier");
        this.#db.prepare(
          "INSERT INTO artifact_outbox(rsid,seq,carrier_json,created_at_ms) VALUES(?,?,?,?)",
        ).run(input.state.rsid, input.seq, input.terminalCarrierJson, atMs);
        this.#db.prepare(
          "UPDATE artifact_delivery_plan SET state='queued',terminal_seq=?,updated_at_ms=? WHERE delivery_id=?",
        ).run(input.seq, atMs, input.deliveryId);
      }
    });
  }

  public ackedDeliveryCarriers(rsid: string, ack: number): readonly {
    readonly seq: number;
    readonly carrierJson: string;
  }[] {
    this.#assertOpen();
    return this.#db
      .prepare("SELECT seq,carrier_json AS carrierJson FROM artifact_outbox WHERE rsid=? AND seq<=? ORDER BY seq")
      .all(rsid, ack) as Array<{ readonly seq: number; readonly carrierJson: string }>;
  }

  public deliveryCarriersNeedingCleanup(): readonly {
    readonly rsid: string;
    readonly seq: number;
    readonly carrierJson: string;
  }[] {
    this.#assertOpen();
    const rows = this.#db.prepare(
      "SELECT rsid,seq,carrier_json AS carrierJson FROM artifact_outbox ORDER BY rsid,seq",
    ).all() as Array<{ readonly rsid: string; readonly seq: number; readonly carrierJson: string }>;
    return rows.filter((row) => row.seq <= this.loadSequence(row.rsid).lastPeerAck);
  }

  public markDeliveryCarrierCleaned(rsid: string, seq: number, atMs = Date.now()): void {
    this.#durable("artifact_cleaned", `${rsid}/${seq}`, atMs, () => {
      const plan = this.#db.prepare(
        "SELECT delivery_id AS deliveryId FROM artifact_delivery_plan WHERE rsid=? AND terminal_seq=?",
      ).get(rsid, seq) as { readonly deliveryId: string } | undefined;
      const outbox = this.#db.prepare(
        "SELECT carrier_json AS carrierJson FROM artifact_outbox WHERE rsid=? AND seq=?",
      ).get(rsid, seq) as { readonly carrierJson: string } | undefined;
      const parsed = outbox === undefined ? null : parseJson<unknown>(outbox.carrierJson, "artifact outbox carrier");
      const deliveryId = plan?.deliveryId ?? (
        typeof parsed === "object" && parsed !== null &&
        "rsid" in parsed && parsed.rsid === rsid &&
        "invocationId" in parsed && typeof parsed.invocationId === "string"
          ? `${rsid}/${parsed.invocationId}`
          : null
      );
      if (deliveryId === null) throw new Error("artifact ACK cleanup lost its delivery identity");
      this.#db.prepare(
        `INSERT INTO artifact_delivery_tombstone(delivery_id,rsid,disposition,updated_at_ms)
         VALUES(?,?,'acked',?)
         ON CONFLICT(delivery_id) DO UPDATE SET disposition='acked',updated_at_ms=excluded.updated_at_ms`,
      ).run(deliveryId, rsid, atMs);
      this.#db.prepare("DELETE FROM artifact_outbox WHERE rsid=? AND seq=?").run(rsid, seq);
      this.#db.prepare(
        "DELETE FROM artifact_delivery_plan WHERE rsid=? AND terminal_seq=?",
      ).run(rsid, seq);
    });
  }

  public deliveryCarriersNeedingExpiry(): readonly {
    readonly cleanupId: string;
    readonly carrierJson: string;
  }[] {
    this.#assertOpen();
    return this.#db.prepare(
      "SELECT cleanup_id AS cleanupId,carrier_json AS carrierJson FROM artifact_cleanup_queue ORDER BY cleanup_id",
    ).all() as Array<{ readonly cleanupId: string; readonly carrierJson: string }>;
  }

  public markDeliveryCarrierExpired(cleanupId: string, atMs = Date.now()): void {
    this.#durable("artifact_expired", cleanupId, atMs, () => {
      const cleanup = this.#db.prepare(
        "SELECT rsid FROM artifact_cleanup_queue WHERE cleanup_id=?",
      ).get(cleanupId) as { readonly rsid: string } | undefined;
      if (cleanup === undefined) throw new Error("artifact expiry cleanup identity is missing");
      this.#db.prepare(
        `INSERT INTO artifact_delivery_tombstone(delivery_id,rsid,disposition,updated_at_ms)
         VALUES(?,?,'expired',?)
         ON CONFLICT(delivery_id) DO UPDATE SET disposition='expired',updated_at_ms=excluded.updated_at_ms`,
      ).run(cleanupId, cleanup.rsid, atMs);
      this.#db.prepare("DELETE FROM artifact_cleanup_queue WHERE cleanup_id=?").run(cleanupId);
    });
  }

  public retainedDeliveryCarrierJsons(): readonly string[] {
    this.#assertOpen();
    const retained = new Set<string>();
    const outbox = this.#db.prepare("SELECT carrier_json AS carrierJson FROM artifact_outbox")
      .all() as Array<{ readonly carrierJson: string }>;
    outbox.forEach((row) => retained.add(row.carrierJson));
    const terminalDrafts = this.#db.prepare(
      `SELECT d.draft_json AS draftJson
       FROM artifact_delivery_plan p
       JOIN artifact_delivery_draft d
         ON d.delivery_id=p.delivery_id AND d.ordinal=p.terminal_ordinal`,
    ).all() as Array<{ readonly draftJson: string }>;
    for (const row of terminalDrafts) {
      const carrier = deliveryCarrierFromDraft(row.draftJson);
      if (carrier !== null) retained.add(carrier.carrierJson);
    }
    const expiry = this.#db.prepare("SELECT carrier_json AS carrierJson FROM artifact_cleanup_queue")
      .all() as Array<{ readonly carrierJson: string }>;
    expiry.forEach((row) => retained.add(row.carrierJson));
    return [...retained];
  }

  public acceptBatchBinding(input: {
    readonly batchId: string;
    readonly rsid: string;
    readonly batchDigest: string;
    readonly bindingJson: string;
    readonly atMs?: number;
  }): "accepted" | "replayed" | "protocol_fault" {
    const atMs = input.atMs ?? Date.now();
    return this.#durable("batch_binding", input.batchId, atMs, () => {
      const row = this.#db
        .prepare("SELECT rsid,batch_digest,binding_json FROM batch_coordination WHERE batch_id=?")
        .get(input.batchId) as
        | { readonly rsid: string; readonly batch_digest: string; readonly binding_json: string }
        | undefined;
      if (row !== undefined) {
        return row.rsid === input.rsid &&
          row.batch_digest === input.batchDigest &&
          row.binding_json === input.bindingJson
          ? "replayed"
          : "protocol_fault";
      }
      this.#db
        .prepare(
          "INSERT INTO batch_coordination(batch_id,rsid,batch_digest,binding_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(input.batchId, input.rsid, input.batchDigest, input.bindingJson, "received", atMs, atMs);
      return "accepted";
    });
  }

  public getBatchTerminal(batchId: string): string | null {
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT terminal_json FROM batch_coordination WHERE batch_id=?")
      .get(batchId) as { readonly terminal_json: string | null } | undefined;
    return row?.terminal_json ?? null;
  }

  public getBatchCoordination(batchId: string): BatchCoordinationState | null {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT batch_id AS batchId,rsid,batch_digest AS batchDigest,state,terminal_json AS terminalJson
         FROM batch_coordination WHERE batch_id=?`,
      )
      .get(batchId) as BatchCoordinationState | undefined;
    return row ?? null;
  }

  /**
   * Atomically claims the one-frame add-in dispatch and every ordered step.
   * A durable `dispatched` coordination row is the restart authority; step
   * rows alone are never used to infer a partially dispatched atomic batch.
   */
  public markAtomicBatchDispatched(input: {
    readonly batchId: string;
    readonly rsid: string;
    readonly batchDigest: string;
    readonly invocationIds: readonly string[];
    readonly atMs?: number;
  }): readonly InvocationJournalRecord[] {
    const atMs = input.atMs ?? Date.now();
    if (input.invocationIds.length === 0) throw new Error("atomic batch has no steps");
    return this.#durable("atomic_batch_dispatch_owned", input.batchId, atMs, () => {
      const batch = this.getBatchCoordination(input.batchId);
      if (
        batch === null ||
        batch.rsid !== input.rsid ||
        batch.batchDigest !== input.batchDigest ||
        batch.state !== "received"
      ) {
        throw new Error("atomic batch dispatch does not match a received coordination row");
      }
      const records = input.invocationIds.map((invocationId, index) => {
        const record = this.#requireInvocation(input.rsid, invocationId);
        if (
          record.binding.batchId !== input.batchId ||
          record.binding.batchDigest !== input.batchDigest ||
          record.binding.batchIndex !== index ||
          record.state !== "received" ||
          record.dispatchMayHaveStarted
        ) {
          throw new Error("atomic batch step is not dispatchable in input order");
        }
        const executing = markJournalExecuting(record);
        this.#saveInvocation(executing, atMs, atMs);
        return executing;
      });
      this.#db
        .prepare("UPDATE batch_coordination SET state='dispatched',updated_at_ms=? WHERE batch_id=? AND state='received'")
        .run(atMs, input.batchId);
      return records;
    });
  }

  /** Claims a successor that Section 12.2 permits only after a recovered read
   * in the same atomic:false batch became durably completed. */
  public claimNonAtomicBatchSuccessor(input: {
    readonly binding: InvocationJournalBinding;
    readonly dispatchIdentity: string;
    readonly atMs?: number;
  }):
    | { readonly kind: "claimed"; readonly record: InvocationJournalRecord }
    | { readonly kind: "blocked"; readonly holds: readonly MutationHold[] }
    | { readonly kind: "protocol_fault"; readonly reason: string } {
    const atMs = input.atMs ?? Date.now();
    return this.#durable("claim_batch_successor", input.binding.invocationId, atMs, () => {
      const record = this.#requireInvocation(input.binding.rsid, input.binding.invocationId);
      if (
        !journalRecordIsIntact(record) ||
        record.bindingDigest !== makeJournalBindingDigest(input.binding) ||
        record.binding.batchId === undefined ||
        record.binding.batchIndex === undefined ||
        record.state !== "received" ||
        record.dispatchMayHaveStarted
      ) {
        return { kind: "protocol_fault", reason: "batch_successor_not_dispatchable" };
      }
      const prefix = this.#db
        .prepare(
          `SELECT record_json,binding_digest,state FROM invocation_journal
           WHERE rsid=? AND batch_id=? AND batch_index<? ORDER BY batch_index`,
        )
        .all(input.binding.rsid, record.binding.batchId, record.binding.batchIndex) as InvocationRow[];
      const prefixCompleted = prefix.every((row) => {
        const candidate = parseJson<InvocationJournalRecord>(row.record_json, "batch predecessor");
        return journalRecordIsIntact(candidate) && candidate.terminalOutcome?.status === "completed";
      });
      if (!prefixCompleted) return { kind: "protocol_fault", reason: "batch_predecessor_not_completed" };

      let ledger = this.#loadLedger();
      if (record.binding.mutating) {
        if (record.binding.mutationScope === null) {
          return { kind: "protocol_fault", reason: "missing_mutation_scope" };
        }
        const authorization = authorizeMutationDispatch(ledger, {
          rsid: record.binding.rsid,
          mutationScopes: [record.binding.mutationScope],
          recoveryClearances: [],
          dispatchIdentity: input.dispatchIdentity,
        });
        if (authorization.kind === "blocked") {
          return { kind: "blocked", holds: authorization.conflictingHolds };
        }
        if (authorization.kind === "protocol_fault") {
          return { kind: "protocol_fault", reason: authorization.reason };
        }
        ledger = authorization.ledger;
        this.#storeLedger(ledger, atMs);
      }
      const executing = markJournalExecuting(record);
      this.#saveInvocation(executing, atMs, atMs);
      return { kind: "claimed", record: executing };
    });
  }

  /** Atomically commits every atomic step terminal and its carrier response. */
  public commitBatchTerminal(input: {
    readonly batchId: string;
    readonly rsid: string;
    readonly batchDigest: string;
    readonly terminalJson: string;
    readonly steps?: readonly {
      readonly invocationId: string;
      readonly outcome: TerminalJournalOutcome;
    }[];
    readonly atMs?: number;
  }): void {
    const atMs = input.atMs ?? Date.now();
    this.#durable("batch_terminal", input.batchId, atMs, () => {
      const row = this.#db
        .prepare("SELECT rsid,batch_digest,terminal_json FROM batch_coordination WHERE batch_id=?")
        .get(input.batchId) as {
          readonly rsid: string;
          readonly batch_digest: string;
          readonly terminal_json: string | null;
        } | undefined;
      if (row === undefined || row.rsid !== input.rsid || row.batch_digest !== input.batchDigest) {
        throw new Error("batch terminal does not match its durable binding");
      }
      if (row.terminal_json !== null) {
        if (row.terminal_json !== input.terminalJson) throw new Error("batch terminal identity mismatch");
        return;
      }
      for (const step of input.steps ?? []) {
        const terminal = recordJournalTerminal(
          this.#requireInvocation(input.rsid, step.invocationId),
          step.outcome,
        );
        this.#saveInvocation(terminal, atMs, undefined, atMs);
      }
      this.#db
        .prepare("UPDATE batch_coordination SET state='terminal',terminal_json=?,updated_at_ms=? WHERE batch_id=?")
        .run(input.terminalJson, atMs, input.batchId);
    });
  }

  /**
   * Accepts every step and consumes batch-level clearances in one durable
   * transaction. No prefix of a new batch can become dispatchable alone.
   */
  public acceptBatchInvocations(input: {
    readonly bindings: readonly InvocationJournalBinding[];
    readonly recoveryClearances: readonly RecoveryClearance[];
    readonly dispatchIdentity: string;
    readonly atomic: boolean;
    readonly atMs?: number;
  }): AcceptBatchInvocationsResult {
    const atMs = input.atMs ?? Date.now();
    if (input.bindings.length === 0) {
      return { kind: "protocol_fault", reason: "empty_batch" };
    }
    const subject = input.bindings[0]?.batchId ?? "missing_batch";
    return this.#durable("accept_batch_steps", subject, atMs, () => {
      const rsid = input.bindings[0]?.rsid as string;
      const batchId = input.bindings[0]?.batchId;
      const batchDigest = input.bindings[0]?.batchDigest;
      if (
        batchId === undefined ||
        batchDigest === undefined ||
        input.bindings.some((binding, index) =>
          binding.rsid !== rsid ||
          binding.batchId !== batchId ||
          binding.batchDigest !== batchDigest ||
          binding.batchIndex !== index ||
          binding.recoveryClearances?.length !== 0
        )
      ) {
        return { kind: "protocol_fault", reason: "invalid_batch_journal_binding" };
      }
      const existing = input.bindings.map((binding) =>
        this.#getInvocationWithinTransaction(binding.rsid, binding.invocationId),
      );
      const existingCount = existing.filter((record) => record !== null).length;
      if (existingCount !== 0 && existingCount !== input.bindings.length) {
        return { kind: "protocol_fault", reason: "partial_batch_journal" };
      }

      let ledger = this.#loadLedger();
      if (existingCount === 0) {
        const mutationScopes = input.bindings.flatMap((binding) =>
          binding.mutationScope === null ? [] : [binding.mutationScope],
        );
        if (mutationScopes.length > 0) {
          const authorization = authorizeMutationDispatch(ledger, {
            rsid,
            mutationScopes,
            recoveryClearances: input.recoveryClearances,
            dispatchIdentity: input.dispatchIdentity,
          });
          if (authorization.kind === "blocked") {
            return { kind: "blocked", holds: authorization.conflictingHolds };
          }
          if (authorization.kind === "protocol_fault") {
            return { kind: "protocol_fault", reason: authorization.reason };
          }
          ledger = authorization.ledger;
          this.#storeLedger(ledger, atMs);
        } else if (input.recoveryClearances.length > 0) {
          return { kind: "protocol_fault", reason: "foreign_clearance" };
        }
        const records = input.bindings.map((binding) => createReceivedJournalRecord(binding));
        for (const record of records) this.#insertInvocation(record, atMs);
        return {
          kind: "accepted",
          decisions: records.map((record) => ({ kind: "accepted" as const, record })),
        };
      }

      const records = existing as InvocationJournalRecord[];
      if (records.some((record, index) =>
        !journalRecordIsIntact(record) ||
        record.bindingDigest !== makeJournalBindingDigest(input.bindings[index] as InvocationJournalBinding)
      )) {
        return { kind: "protocol_fault", reason: "batch_binding_mismatch" };
      }

      if (input.atomic) {
        if (records.every((record) => record.state === "received" && !record.dispatchMayHaveStarted)) {
          return {
            kind: "accepted",
            decisions: records.map((record) => ({ kind: "accepted" as const, record })),
          };
        }
        return { kind: "protocol_fault", reason: "atomic_batch_not_safely_received" };
      }

      const decisions: BatchInvocationDecision[] = [];
      let stopped = false;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index] as InvocationJournalRecord;
        const binding = input.bindings[index] as InvocationJournalBinding;
        if (stopped) {
          decisions.push({ kind: "not_started", record });
          continue;
        }
        if (record.terminalOutcome !== null) {
          decisions.push({ kind: "replay_terminal", record, outcome: record.terminalOutcome });
          if (record.terminalOutcome.status !== "completed") stopped = true;
          continue;
        }
        if (record.lateTerminalOutcome !== null) {
          if (record.verificationHoldId === null) throw new Error("late batch evidence lost its hold");
          decisions.push({
            kind: "replay_late_terminal",
            record,
            outcome: record.lateTerminalOutcome,
            verificationHoldId: record.verificationHoldId,
          });
          if (record.lateTerminalOutcome.status !== "completed") stopped = true;
          continue;
        }
        if (record.state === "indeterminate") {
          decisions.push({ kind: "return_indeterminate", record, verificationHoldId: record.verificationHoldId });
          stopped = true;
          continue;
        }

        let promotionHoldId: string | null = null;
        if (record.binding.mutating) {
          if (record.binding.mutationScope === null) throw new Error("mutation journal lost its scope");
          const key = makeIdempotencyKey(rsid, record.binding.invocationId);
          const installed = installMutationHolds(ledger, rsid, [{
            originIdempotencyKey: key,
            mutationScope: record.binding.mutationScope,
          }]);
          if (installed.kind === "blocked") {
            const covering = installed.conflictingHolds.find((hold) => hold.originIdempotencyKeys.includes(key));
            if (covering === undefined) return { kind: "blocked", holds: installed.conflictingHolds };
            promotionHoldId = covering.holdId;
          } else {
            ledger = installed.ledger;
            promotionHoldId = installed.holds[0]?.holdId ?? null;
            this.#storeLedger(ledger, atMs);
          }
        }
        const decision = decideJournalRedelivery(record, binding, promotionHoldId);
        if (decision.kind === "protocol_fault") {
          return { kind: "protocol_fault", reason: decision.reason };
        }
        if (decision.record !== record) this.#saveInvocation(decision.record, atMs);
        decisions.push(decision);
        stopped = true;
      }
      return { kind: "accepted", decisions };
    });
  }

  #queueSessionDeliveryExpiry(rsid: string, atMs: number): void {
    const carriers = new Map<string, string>();
    const outbox = this.#db.prepare(
      "SELECT carrier_json AS carrierJson FROM artifact_outbox WHERE rsid=?",
    ).all(rsid) as Array<{ readonly carrierJson: string }>;
    for (const row of outbox) {
      const carrier = parseJson<unknown>(row.carrierJson, "artifact outbox carrier");
      if (
        typeof carrier === "object" && carrier !== null &&
        "rsid" in carrier && carrier.rsid === rsid &&
        "invocationId" in carrier && typeof carrier.invocationId === "string"
      ) carriers.set(`${rsid}/${carrier.invocationId}`, row.carrierJson);
    }
    const terminalDrafts = this.#db.prepare(
      `SELECT d.draft_json AS draftJson
       FROM artifact_delivery_plan p
       JOIN artifact_delivery_draft d
         ON d.delivery_id=p.delivery_id AND d.ordinal=p.terminal_ordinal
       WHERE p.rsid=?`,
    ).all(rsid) as Array<{ readonly draftJson: string }>;
    for (const row of terminalDrafts) {
      const carrier = deliveryCarrierFromDraft(row.draftJson);
      if (carrier !== null && carrier.identity.startsWith(`${rsid}/`)) {
        carriers.set(carrier.identity, carrier.carrierJson);
      }
    }
    for (const record of this.listInvocations()) {
      if (record.binding.rsid !== rsid) continue;
      for (const terminal of [record.terminalOutcome, record.lateTerminalOutcome]) {
        if (!terminal?.payloadRetained || typeof terminal.payload !== "object" || terminal.payload === null) continue;
        const payload = terminal.payload as Record<string, unknown>;
        for (const key of ["artifact_carrier", "result_carrier"] as const) {
          const carrier = payload[key];
          if (
            typeof carrier !== "object" || carrier === null ||
            !("rsid" in carrier) || carrier.rsid !== rsid ||
            !("invocationId" in carrier) || typeof carrier.invocationId !== "string"
          ) continue;
          const identity = `${rsid}/${carrier.invocationId}`;
          const tombstone = this.#db.prepare(
            "SELECT 1 AS present FROM artifact_delivery_tombstone WHERE delivery_id=?",
          ).get(identity) as { readonly present: number } | undefined;
          if (tombstone === undefined) carriers.set(identity, JSON.stringify(carrier));
        }
      }
    }
    const insert = this.#db.prepare(
      `INSERT INTO artifact_cleanup_queue(cleanup_id,rsid,carrier_json,created_at_ms)
       VALUES(?,?,?,?)
       ON CONFLICT(cleanup_id) DO UPDATE SET carrier_json=excluded.carrier_json`,
    );
    for (const [identity, carrierJson] of carriers) insert.run(identity, rsid, carrierJson, atMs);
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta(
        schema_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO journal_meta(schema_version)
        SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM journal_meta);

      CREATE TABLE IF NOT EXISTS invocation_journal(
        rsid TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        binding_digest TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        method TEXT NOT NULL,
        mutating INTEGER NOT NULL CHECK(mutating IN (0,1)),
        scope_jcs TEXT,
        params_digest TEXT NOT NULL,
        batch_id TEXT,
        batch_index INTEGER,
        state TEXT NOT NULL CHECK(state IN ('received','executing','completed','failed','guarded','cancelled','indeterminate')),
        dispatch_may_have_started INTEGER NOT NULL CHECK(dispatch_may_have_started IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(rsid,invocation_id),
        CHECK(idempotency_key = rsid || '/' || invocation_id),
        CHECK((mutating=0 AND scope_jcs IS NULL) OR (mutating=1 AND scope_jcs IS NOT NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mutation_holds(
        rsid TEXT NOT NULL,
        scope_jcs TEXT NOT NULL,
        hold_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','evidence_recorded','resolved_pending_bridge','cleared')),
        hold_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        cleared_at_ms INTEGER,
        PRIMARY KEY(rsid,hold_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mutation_holds_uncleared_scope
        ON mutation_holds(rsid,scope_jcs) WHERE state <> 'cleared';

      CREATE TABLE IF NOT EXISTS batch_coordination(
        batch_id TEXT PRIMARY KEY,
        rsid TEXT NOT NULL,
        batch_digest TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('received','dispatched','terminal','indeterminate')),
        terminal_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_sequence(
        rsid TEXT PRIMARY KEY,
        sequence_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_outbox(
        rsid TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq >= 1 AND seq <= 9007199254740991),
        carrier_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(rsid,seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_delivery_plan(
        delivery_id TEXT PRIMARY KEY,
        rsid TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','queued')),
        terminal_ordinal INTEGER NOT NULL CHECK(terminal_ordinal >= 0),
        terminal_seq INTEGER CHECK(terminal_seq IS NULL OR (terminal_seq >= 1 AND terminal_seq <= 9007199254740991)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK((state='pending' AND terminal_seq IS NULL) OR (state='queued' AND terminal_seq IS NOT NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_delivery_draft(
        delivery_id TEXT NOT NULL REFERENCES artifact_delivery_plan(delivery_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        draft_json TEXT NOT NULL,
        PRIMARY KEY(delivery_id,ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_cleanup_queue(
        cleanup_id TEXT PRIMARY KEY,
        rsid TEXT NOT NULL,
        carrier_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_delivery_tombstone(
        delivery_id TEXT PRIMARY KEY,
        rsid TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('acked','expired')),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS durability_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    const batchColumns = this.#db.pragma("table_info(batch_coordination)") as Array<{
      readonly name: string;
    }>;
    if (!batchColumns.some((column) => column.name === "terminal_json")) {
      this.#db.exec("ALTER TABLE batch_coordination ADD COLUMN terminal_json TEXT");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("bridge journal is closed");
  }

  #durable<T>(action: string, subject: string, atMs: number, work: () => T): T {
    this.#assertOpen();
    assertSafeTime(atMs, "atMs");
    this.#db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = work();
      this.#db
        .prepare("INSERT INTO durability_events(action,subject,at_ms) VALUES(?,?,?)")
        .run(action, subject, atMs);
      this.#db.exec("COMMIT");
      committed = true;
      this.#syncFiles();
      return result;
    } catch (error) {
      if (!committed) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #syncFiles(): void {
    if (this.#path === ":memory:") return;
    for (const path of [this.#path, `${this.#path}-wal`]) {
      if (!existsSync(path)) continue;
      const descriptor = openSync(path, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    // POSIX permits directory fsync and Ubuntu CI verifies it. Windows does
    // not expose a directory descriptor through node:fs, so FULL/FULLFSYNC
    // plus explicit DB/WAL fsync remains the strongest available ordering.
    if (process.platform !== "win32") {
      const directory = openSync(dirname(this.#path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }

  #getInvocationWithinTransaction(rsid: string, invocationId: string): InvocationJournalRecord | null {
    const row = this.#db
      .prepare("SELECT record_json, binding_digest, state FROM invocation_journal WHERE rsid=? AND invocation_id=?")
      .get(rsid, invocationId) as InvocationRow | undefined;
    if (row === undefined) return null;
    const record = parseJson<InvocationJournalRecord>(row.record_json, "invocation journal row");
    if (!journalRecordIsIntact(record)) throw new Error("durable invocation journal integrity mismatch");
    return record;
  }

  #requireInvocation(rsid: string, invocationId: string): InvocationJournalRecord {
    const record = this.#getInvocationWithinTransaction(rsid, invocationId);
    if (record === null) throw new Error(`missing invocation ${rsid}/${invocationId}`);
    return record;
  }

  #insertInvocation(record: InvocationJournalRecord, atMs: number): void {
    const binding = record.binding;
    this.#db
      .prepare(
        `INSERT INTO invocation_journal(
           rsid,invocation_id,idempotency_key,binding_digest,binding_json,record_json,method,mutating,
           scope_jcs,params_digest,batch_id,batch_index,state,dispatch_may_have_started,
           created_at_ms,started_at_ms,finished_at_ms,updated_at_ms
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        binding.rsid,
        binding.invocationId,
        makeIdempotencyKey(binding.rsid, binding.invocationId),
        record.bindingDigest,
        JSON.stringify(binding),
        JSON.stringify(record),
        binding.method,
        binding.mutating ? 1 : 0,
        binding.mutationScope === null ? null : mutationScopeKey(binding.mutationScope),
        binding.paramsDigest,
        binding.batchId ?? null,
        binding.batchIndex ?? null,
        record.state,
        record.dispatchMayHaveStarted ? 1 : 0,
        atMs,
        null,
        null,
        atMs,
      );
  }

  #saveInvocation(
    record: InvocationJournalRecord,
    atMs: number,
    startedAtMs?: number,
    finishedAtMs?: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE invocation_journal SET record_json=?,state=?,dispatch_may_have_started=?,
         started_at_ms=COALESCE(started_at_ms,?),finished_at_ms=COALESCE(?,finished_at_ms),updated_at_ms=?
         WHERE rsid=? AND invocation_id=?`,
      )
      .run(
        JSON.stringify(record),
        record.state,
        record.dispatchMayHaveStarted ? 1 : 0,
        startedAtMs ?? null,
        finishedAtMs ?? null,
        atMs,
        record.binding.rsid,
        record.binding.invocationId,
      );
  }

  #loadLedger(): MutationHoldLedger {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT hold_json FROM mutation_holds ORDER BY hold_id")
      .all() as HoldRow[];
    if (rows.length === 0) return createMutationHoldLedger();
    return { holds: rows.map((row) => parseJson<MutationHold>(row.hold_json, "mutation hold")) };
  }

  #storeLedger(ledger: MutationHoldLedger, atMs: number): void {
    const statement = this.#db.prepare(
      `INSERT INTO mutation_holds(rsid,scope_jcs,hold_id,state,hold_json,created_at_ms,updated_at_ms,cleared_at_ms)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(rsid,hold_id) DO UPDATE SET
         scope_jcs=excluded.scope_jcs,state=excluded.state,hold_json=excluded.hold_json,
         updated_at_ms=excluded.updated_at_ms,cleared_at_ms=excluded.cleared_at_ms`,
    );
    for (const hold of ledger.holds) {
      const existing = this.#db
        .prepare("SELECT created_at_ms FROM mutation_holds WHERE rsid=? AND hold_id=?")
        .get(hold.rsid, hold.holdId) as { readonly created_at_ms: number } | undefined;
      statement.run(
        hold.rsid,
        hold.scopeKey,
        hold.holdId,
        hold.state,
        JSON.stringify(hold),
        existing?.created_at_ms ?? atMs,
        atMs,
        hold.state === "cleared" ? atMs : null,
      );
    }
  }
}
