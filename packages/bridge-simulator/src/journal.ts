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
>;

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

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
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

      return records.map((record) => {
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

  public saveSequenceWithArtifact(
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

  public ackedArtifactCarriers(rsid: string, ack: number): readonly {
    readonly seq: number;
    readonly carrierJson: string;
  }[] {
    this.#assertOpen();
    return this.#db
      .prepare("SELECT seq,carrier_json AS carrierJson FROM artifact_outbox WHERE rsid=? AND seq<=? ORDER BY seq")
      .all(rsid, ack) as Array<{ readonly seq: number; readonly carrierJson: string }>;
  }

  public markArtifactCarrierCleaned(rsid: string, seq: number, atMs = Date.now()): void {
    this.#durable("artifact_cleaned", `${rsid}/${seq}`, atMs, () => {
      this.#db.prepare("DELETE FROM artifact_outbox WHERE rsid=? AND seq=?").run(rsid, seq);
    });
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
      const uncertain = records.flatMap((record) => {
        if (
          !record.binding.mutating ||
          record.terminalOutcome !== null ||
          record.lateTerminalOutcome !== null ||
          record.state === "indeterminate"
        ) return [];
        if (record.binding.mutationScope === null) throw new Error("mutation journal lost its scope");
        return [{
          originIdempotencyKey: makeIdempotencyKey(rsid, record.binding.invocationId),
          mutationScope: record.binding.mutationScope,
        }];
      });
      let promotionHolds: readonly MutationHold[] = [];
      if (uncertain.length > 0) {
        const installed = installMutationHolds(ledger, rsid, uncertain);
        if (installed.kind === "blocked") {
          return { kind: "blocked", holds: installed.conflictingHolds };
        }
        ledger = installed.ledger;
        promotionHolds = installed.holds;
        this.#storeLedger(ledger, atMs);
      }
      const decisions: BatchInvocationDecision[] = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index] as InvocationJournalRecord;
        const binding = input.bindings[index] as InvocationJournalBinding;
        const key = makeIdempotencyKey(rsid, record.binding.invocationId);
        const promotionHoldId = promotionHolds.find((hold) =>
          hold.originIdempotencyKeys.includes(key),
        )?.holdId ?? null;
        const decision = decideJournalRedelivery(record, binding, promotionHoldId);
        if (decision.kind === "protocol_fault") {
          return { kind: "protocol_fault", reason: decision.reason };
        }
        if (decision.record !== record) this.#saveInvocation(decision.record, atMs);
        decisions.push(decision);
      }
      return { kind: "accepted", decisions };
    });
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
