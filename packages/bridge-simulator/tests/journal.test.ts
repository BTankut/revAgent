import { join } from "node:path";

import {
  acceptInboundData,
  applyCumulativeAck,
  createRbpSequenceState,
  makeParamsDigest,
  queueOutboundData,
  type DataEnvelopeSnapshot,
  type InvocationJournalBinding,
  type JsonValue,
  type MutationScope,
} from "@revagent/protocol";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { atomicBatch, readInvoke, temporaryRoot, uuid } from "./helpers.js";

const RESULT_DIGEST = `sha256:${"1".repeat(64)}`;

function dataEnvelope(envelope: unknown): DataEnvelopeSnapshot {
  return envelope as DataEnvelopeSnapshot;
}

function binding(input: {
  readonly rsid: string;
  readonly invocationId?: string;
  readonly mutating: boolean;
  readonly scope?: MutationScope;
  readonly verification?: InvocationJournalBinding["verification"];
  readonly clearances?: InvocationJournalBinding["recoveryClearances"];
}): InvocationJournalBinding {
  return {
    rsid: input.rsid,
    invocationId: input.invocationId ?? uuid(),
    method: input.mutating ? "set_element_parameter" : "inspect_schedules",
    mutating: input.mutating,
    mutationScope: input.mutating ? input.scope ?? { kind: "document", document_id: "doc-01" } : null,
    paramsDigest: makeParamsDigest({ element_id: 42 }),
    policy: input.mutating
      ? { class: "confirm", decision: "confirmed", confirmation_id: "confirmation" }
      : { class: "auto", decision: "auto", confirmation_id: null },
    verification: input.verification ?? null,
    recoveryClearances: input.clearances ?? [],
  };
}

describe("DurableBridgeJournal", () => {
  it("atomically persists inbound sequence, work, and invocation acceptance across reopen", () => {
    const root = temporaryRoot();
    const path = join(root.path, "journal.db");
    const rsid = uuid();
    const envelope = readInvoke({ rsid, seq: 1 });
    const invocation = binding({
      rsid,
      invocationId: envelope.payload.invocation_id,
      mutating: false,
    });
    const contextJson = JSON.stringify({ invocation_id: envelope.payload.invocation_id });

    let journal = new DurableBridgeJournal(path);
    expect(journal.acceptInboundInvocation({
      envelope: dataEnvelope(envelope),
      binding: invocation,
      dispatchIdentity: "inbound-dispatch",
      contextJson,
    })).toMatchObject({
      kind: "accepted",
      ack: 1,
      work: {
        rsid,
        seq: 1,
        type: "invoke",
        correlationId: envelope.payload.invocation_id,
        contextJson,
        state: "journaled",
      },
      decision: { kind: "accepted" },
    });
    journal.close();

    journal = new DurableBridgeJournal(path);
    expect(journal.loadSequence(rsid)).toMatchObject({ lastRxSeq: 1 });
    expect(journal.getInboundWork(rsid, 1)).toMatchObject({
      type: "invoke",
      correlationId: envelope.payload.invocation_id,
      contextJson,
      state: "journaled",
      replyJson: null,
      deliveryId: null,
    });
    expect(journal.getInvocation(rsid, envelope.payload.invocation_id)).toMatchObject({
      state: "received",
      binding: { rsid, invocationId: envelope.payload.invocation_id },
    });
    journal.close();
    root.cleanup();
  });

  it("distinguishes an identical same-sequence duplicate from changed immutable data", () => {
    const journal = new DurableBridgeJournal(":memory:");
    const rsid = uuid();
    const envelope = readInvoke({ rsid, seq: 1 });
    const invocation = binding({
      rsid,
      invocationId: envelope.payload.invocation_id,
      mutating: false,
    });
    const contextJson = JSON.stringify({ invocation_id: envelope.payload.invocation_id });
    const input = {
      envelope: dataEnvelope(envelope),
      binding: invocation,
      dispatchIdentity: "duplicate-dispatch",
      contextJson,
    } as const;

    expect(journal.acceptInboundInvocation(input).kind).toBe("accepted");
    expect(journal.acceptInboundInvocation(input)).toMatchObject({
      kind: "duplicate",
      ack: 1,
      work: {
        rsid,
        seq: 1,
        correlationId: envelope.payload.invocation_id,
        state: "journaled",
      },
    });
    const changed: DataEnvelopeSnapshot = { ...dataEnvelope(envelope), id: uuid() };
    expect(journal.acceptInboundInvocation({ ...input, envelope: changed })).toMatchObject({
      kind: "protocol_fault",
      ack: 1,
      reason: "duplicate_identity_mismatch",
    });
    expect(journal.listInboundWork(rsid)).toHaveLength(1);
    expect(journal.listInvocations()).toHaveLength(1);
    journal.close();
  });

  it("durably stages a carrier-free terminal reply and removes its plan after ACK", () => {
    const journal = new DurableBridgeJournal(":memory:");
    const rsid = uuid();
    const envelope = readInvoke({ rsid, seq: 1 });
    const invocationId = envelope.payload.invocation_id;
    const replyPayload: JsonValue = {
      invocation_id: invocationId,
      status: "failed",
      fault: { class: "protocol", code: "invalid_params_digest" },
    };
    const reply = {
      v: 1 as const,
      type: "error",
      id: uuid(),
      ack: 1,
      ts: "2026-07-22T00:00:01.000Z",
      payload: replyPayload,
    };
    const replyJson = JSON.stringify(reply);
    const deliveryId = `${rsid}/${invocationId}`;

    expect(journal.acceptInboundTerminalReply({
      envelope: dataEnvelope(envelope),
      correlationId: invocationId,
      contextJson: JSON.stringify({ invocation_id: invocationId }),
      replyJson,
    })).toMatchObject({
      kind: "accepted",
      ack: 1,
      work: { state: "reply_ready", replyJson },
    });
    expect(journal.stageDurableDelivery({
      rsid,
      deliveryId,
      draftJsons: [replyJson],
      terminalOrdinal: 0,
      inboundSeq: 1,
    })).toBe("accepted");
    expect(journal.getInboundWork(rsid, 1)).toMatchObject({
      state: "delivery_ready",
      replyJson,
      deliveryId,
    });
    expect(journal.hasDurableDelivery(rsid, invocationId)).toBe(true);

    const draft = journal.nextDurableDeliveryDraft(rsid);
    expect(draft).toMatchObject({ deliveryId, ordinal: 0, draftJson: replyJson });
    const queued = queueOutboundData(journal.loadSequence(rsid), reply);
    expect(queued.kind).toBe("queued");
    if (queued.kind !== "queued" || draft === null) throw new Error("reply draft was not queueable");
    journal.saveSequenceAndConsumeDeliveryDraft({
      state: queued.state,
      seq: queued.envelope.seq,
      deliveryId: draft.deliveryId,
      ordinal: draft.ordinal,
      draftJson: draft.draftJson,
    });
    expect(journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(journal.hasDurableDelivery(rsid, invocationId)).toBe(true);

    const acknowledged = applyCumulativeAck(journal.loadSequence(rsid), queued.envelope.seq);
    expect(acknowledged.kind).toBe("advanced");
    if (acknowledged.kind !== "advanced") throw new Error("reply ACK did not advance");
    journal.saveSequence(acknowledged.state);
    expect(journal.hasDurableDelivery(rsid, invocationId)).toBe(false);
    expect(journal.getInboundWork(rsid, 1)).toBeNull();
    expect(journal.loadSequence(rsid)).toMatchObject({ lastPeerAck: queued.envelope.seq, outbox: [] });
    journal.close();
  });

  it("fails closed without mutating a v1 journal that has an accepted inbound prefix", () => {
    const root = temporaryRoot();
    const path = join(root.path, "legacy-sequence.db");
    const rsid = uuid();
    const envelope = readInvoke({ rsid, seq: 1 });
    const outboundReply = {
      v: 1 as const,
      type: "error",
      id: uuid(),
      ack: 0,
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        retryable: false,
        fault_class: "protocol",
        outcome: "known",
        verification_required: false,
        replayed: false,
        late_after_indeterminate: false,
        message: "legacy outbound",
      },
    };
    const queued = queueOutboundData(createRbpSequenceState(rsid), outboundReply);
    if (queued.kind !== "queued") throw new Error("legacy outbound reply was not queued");
    const accepted = acceptInboundData(queued.state, dataEnvelope(envelope));
    if (accepted.kind !== "accepted") throw new Error("legacy envelope was not accepted");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(1);
      CREATE TABLE session_sequence(
        rsid TEXT PRIMARY KEY,
        sequence_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    db.prepare(
      "INSERT INTO session_sequence(rsid,sequence_json,updated_at_ms) VALUES(?,?,?)",
    ).run(rsid, JSON.stringify(accepted.state), 1);
    db.close();

    expect(() => new DurableBridgeJournal(path)).toThrow(
      `bridge journal schema v1 session ${rsid} has an accepted inbound prefix; automatic migration is unsafe`,
    );
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT schema_version AS schemaVersion FROM journal_meta",
    ).get()).toEqual({ schemaVersion: 1 });
    expect(JSON.parse((unchanged.prepare(
      "SELECT sequence_json AS sequenceJson FROM session_sequence WHERE rsid=?",
    ).get(rsid) as { sequenceJson: string }).sequenceJson)).toEqual(accepted.state);
    expect(unchanged.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='inbound_work'",
    ).get()).toBeUndefined();
    unchanged.close();
    root.cleanup();
  });

  it("migrates a pristine v1 receive side while preserving its outbound state", () => {
    const root = temporaryRoot();
    const path = join(root.path, "pristine-legacy-sequence.db");
    const rsid = uuid();
    const queued = queueOutboundData(createRbpSequenceState(rsid), {
      v: 1,
      type: "error",
      id: uuid(),
      ack: 0,
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        retryable: false,
        fault_class: "protocol",
        outcome: "known",
        verification_required: false,
        replayed: false,
        late_after_indeterminate: false,
        message: "legacy outbound",
      },
    });
    if (queued.kind !== "queued") throw new Error("legacy outbound reply was not queued");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(1);
      CREATE TABLE session_sequence(
        rsid TEXT PRIMARY KEY,
        sequence_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    db.prepare(
      "INSERT INTO session_sequence(rsid,sequence_json,updated_at_ms) VALUES(?,?,?)",
    ).run(rsid, JSON.stringify(queued.state), 1);
    db.close();

    const journal = new DurableBridgeJournal(path);
    expect(journal.loadSequence(rsid)).toEqual(queued.state);
    journal.close();
    const migrated = new Database(path, { readonly: true });
    expect(migrated.prepare(
      "SELECT schema_version AS schemaVersion FROM journal_meta",
    ).get()).toEqual({ schemaVersion: 3 });
    migrated.close();
    root.cleanup();
  });

  it("migrates a v2 journal to v3 with durable unregister tombstones", () => {
    const root = temporaryRoot();
    const path = join(root.path, "v2-unregister-migration.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(2);
    `);
    db.close();

    const journal = new DurableBridgeJournal(path);
    const rsid = uuid();
    expect(journal.unregisterSession(rsid, "operator_requested", 100)).toEqual([]);
    expect(journal.getPendingSessionUnregister(rsid)).toEqual({
      rsid,
      reason: "operator_requested",
      phase: "pending",
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    journal.close();

    const migrated = new Database(path, { readonly: true });
    expect(migrated.prepare(
      "SELECT schema_version AS schemaVersion FROM journal_meta",
    ).get()).toEqual({ schemaVersion: 3 });
    expect(migrated.prepare(
      "SELECT rsid,reason,phase,created_at_ms AS createdAtMs,updated_at_ms AS updatedAtMs " +
      "FROM pending_session_unregister WHERE rsid=?",
    ).get(rsid)).toEqual({
      rsid,
      reason: "operator_requested",
      phase: "pending",
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    migrated.close();
    root.cleanup();
  });

  it("keeps unregister intent across reopen until an ordered heartbeat fence finalizes it", () => {
    const root = temporaryRoot();
    const path = join(root.path, "pending-unregister.db");
    const rsid = uuid();

    let journal = new DurableBridgeJournal(path);
    expect(journal.unregisterSession(rsid, "revit_exited", 10)).toEqual([]);
    expect(journal.unregisterSession(rsid, "revit_exited", 20)).toEqual([]);
    expect(() => journal.unregisterSession(rsid, "operator_requested", 30)).toThrow(
      `session unregister reason changed for ${rsid}`,
    );
    journal.close();

    journal = new DurableBridgeJournal(path);
    expect(journal.listPendingSessionUnregisters()).toEqual([{
      rsid,
      reason: "revit_exited",
      phase: "pending",
      createdAtMs: 10,
      updatedAtMs: 20,
    }]);
    expect(journal.confirmSessionUnregister(rsid, 40)).toBe(true);
    expect(journal.confirmSessionUnregister(rsid, 50)).toBe(true);
    expect(journal.getPendingSessionUnregister(rsid)).toMatchObject({ phase: "confirmed" });
    expect(journal.completeSessionUnregister(rsid, 60)).toBe(true);
    expect(journal.completeSessionUnregister(rsid, 70)).toBe(false);
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
    journal.close();

    journal = new DurableBridgeJournal(path);
    expect(journal.listPendingSessionUnregisters()).toEqual([]);
    journal.close();
    root.cleanup();
  });

  it("preserves pending rows when opening an early v3 tombstone table without phase", () => {
    const root = temporaryRoot();
    const path = join(root.path, "early-v3-unregister.db");
    const rsid = uuid();
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(3);
      CREATE TABLE pending_session_unregister(
        rsid TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    db.prepare(
      "INSERT INTO pending_session_unregister(rsid,reason,created_at_ms,updated_at_ms) VALUES(?,?,?,?)",
    ).run(rsid, "session_replaced", 10, 20);
    db.close();

    const journal = new DurableBridgeJournal(path);
    expect(journal.getPendingSessionUnregister(rsid)).toEqual({
      rsid,
      reason: "session_replaced",
      phase: "pending",
      createdAtMs: 10,
      updatedAtMs: 20,
    });
    journal.close();
    root.cleanup();
  });

  it("fails closed without downgrading a future journal schema", () => {
    const root = temporaryRoot();
    const path = join(root.path, "future-schema.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(4);
    `);
    db.close();

    const captured: { value: Database.Database | null } = { value: null };
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      captured.value = this;
      return originalPrepare.call(this, source);
    });
    try {
      expect(() => new DurableBridgeJournal(path)).toThrow(
        "unsupported bridge journal schema version: 4",
      );
    } finally {
      prepareSpy.mockRestore();
      captured.value?.close();
    }
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT schema_version AS schemaVersion FROM journal_meta",
    ).get()).toEqual({ schemaVersion: 4 });
    unchanged.close();
    root.cleanup();
  });

  it("rejects ambiguous schema metadata without downgrading either row", () => {
    const root = temporaryRoot();
    const path = join(root.path, "ambiguous-schema.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE journal_meta(schema_version INTEGER NOT NULL) STRICT;
      INSERT INTO journal_meta(schema_version) VALUES(1),(4);
      CREATE TABLE session_sequence(
        rsid TEXT PRIMARY KEY,
        sequence_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    db.close();

    expect(() => new DurableBridgeJournal(path)).toThrow(
      "bridge journal metadata must contain exactly one row; found 2",
    );
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT schema_version AS schemaVersion FROM journal_meta ORDER BY schema_version",
    ).all()).toEqual([{ schemaVersion: 1 }, { schemaVersion: 4 }]);
    unchanged.close();
    root.cleanup();
  });

  it("closes the database when post-migration recovery fails", () => {
    const root = temporaryRoot();
    const path = join(root.path, "recovery-failure.db");
    const initial = new DurableBridgeJournal(path);
    initial.close();
    const seeded = new Database(path);
    seeded.prepare(
      `INSERT INTO batch_coordination(
        batch_id,rsid,batch_digest,binding_json,state,terminal_json,created_at_ms,updated_at_ms
      ) VALUES(?,?,?,?,?,NULL,?,?)`,
    ).run(uuid(), uuid(), "sha256:bad", "{bad json", "dispatched", 1, 1);
    seeded.close();

    let closeCalls = 0;
    const originalClose = Database.prototype.close;
    const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (
      this: Database.Database,
    ) {
      closeCalls += 1;
      return originalClose.call(this);
    });
    try {
      expect(() => new DurableBridgeJournal(path)).toThrow("batch binding contains invalid JSON");
      expect(closeCalls).toBe(1);
    } finally {
      closeSpy.mockRestore();
    }
    const reopened = new Database(path);
    reopened.prepare("DELETE FROM batch_coordination").run();
    reopened.close();
    root.cleanup();
  });

  it("atomically creates inbound sequence, batch coordination, and every step row", () => {
    const root = temporaryRoot();
    const path = join(root.path, "journal.db");
    const rsid = uuid();
    const envelope = atomicBatch(rsid, 1);
    const bindings: InvocationJournalBinding[] = envelope.payload.steps.map((step, batchIndex) => ({
      rsid,
      invocationId: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutationScope: step.mutation_scope,
      paramsDigest: step.params_digest,
      policy: step.policy,
      verification: null,
      recoveryClearances: [],
      batchId: envelope.payload.batch_id,
      batchIndex,
      batchDigest: envelope.payload.batch_digest,
    }));
    const contextJson = JSON.stringify({
      batch_id: envelope.payload.batch_id,
      atomic: envelope.payload.atomic,
      invocation_ids: bindings.map((entry) => entry.invocationId),
    });

    let journal = new DurableBridgeJournal(path);
    expect(journal.acceptInboundBatch({
      envelope: dataEnvelope(envelope),
      batchId: envelope.payload.batch_id,
      batchDigest: envelope.payload.batch_digest,
      bindingJson: JSON.stringify(envelope.payload),
      bindings,
      recoveryClearances: [],
      dispatchIdentity: "atomic-batch-dispatch",
      atomic: true,
      contextJson,
    })).toMatchObject({
      kind: "accepted",
      ack: 1,
      work: {
        type: "invoke_batch",
        correlationId: envelope.payload.batch_id,
        state: "journaled",
      },
      decision: {
        binding: "accepted",
        invocations: { kind: "accepted" },
      },
    });
    journal.close();

    journal = new DurableBridgeJournal(path);
    expect(journal.loadSequence(rsid)).toMatchObject({ lastRxSeq: 1 });
    expect(journal.getInboundWork(rsid, 1)).toMatchObject({
      correlationId: envelope.payload.batch_id,
      contextJson,
      state: "journaled",
    });
    expect(journal.getBatchCoordination(envelope.payload.batch_id)).toMatchObject({
      batchId: envelope.payload.batch_id,
      rsid,
      batchDigest: envelope.payload.batch_digest,
      state: "received",
      terminalJson: null,
    });
    expect(bindings.map((entry) => journal.getInvocation(rsid, entry.invocationId))).toEqual(
      bindings.map((entry) => expect.objectContaining({
        state: "received",
        binding: expect.objectContaining({
          invocationId: entry.invocationId,
          batchId: envelope.payload.batch_id,
          batchIndex: entry.batchIndex,
          batchDigest: envelope.payload.batch_digest,
        }),
      })),
    );
    journal.close();
    root.cleanup();
  });

  it("promotes only possibly dispatched mutations on restart and blocks a fresh id", () => {
    const root = temporaryRoot();
    const path = join(root.path, "journal.db");
    const rsid = uuid();
    const original = binding({ rsid, mutating: true });
    const read = binding({ rsid, mutating: false });
    let journal = new DurableBridgeJournal(path);
    expect(journal.durabilityProfile).toMatchObject({ journalMode: "wal", foreignKeys: 1, fullFsyncRequested: true });
    expect(journal.acceptInvocation(original, "dispatch-one").kind).toBe("accepted");
    journal.markExecuting(rsid, original.invocationId);
    expect(journal.acceptInvocation(read, "read-one").kind).toBe("accepted");
    journal.markExecuting(rsid, read.invocationId);
    journal.close();

    journal = new DurableBridgeJournal(path);
    const mutationRecord = journal.getInvocation(rsid, original.invocationId);
    expect(mutationRecord?.state).toBe("indeterminate");
    expect(mutationRecord?.verificationHoldId).toMatch(/^vh:[0-9a-f]{64}$/u);
    expect(journal.getInvocation(rsid, read.invocationId)?.state).toBe("executing");
    expect(journal.listHolds()).toHaveLength(1);
    const fresh = binding({ rsid, mutating: true });
    expect(journal.acceptInvocation(fresh, "dispatch-two").kind).toBe("blocked");
    const readRecovery = journal.acceptInvocation(read, "read-one");
    expect(readRecovery.kind).toBe("reexecute_read");
    expect(journal.listHolds()).toHaveLength(1);
    journal.close();
    root.cleanup();
  });

  it("requires conclusive evidence, resolution, and exact clearance before mutation resumes", () => {
    const root = temporaryRoot();
    const journal = new DurableBridgeJournal(join(root.path, "journal.db"));
    const rsid = uuid();
    const original = binding({ rsid, mutating: true });
    journal.acceptInvocation(original, "dispatch-one");
    journal.markExecuting(rsid, original.invocationId);
    const indeterminate = journal.markIndeterminate(rsid, original.invocationId);
    const holdId = indeterminate.verificationHoldId as string;
    const verificationId = uuid();
    const verification = binding({
      rsid,
      invocationId: verificationId,
      mutating: false,
      verification: {
        hold_id: holdId,
        mutation_scope: original.mutationScope as MutationScope,
        purpose: "resolve_indeterminate",
      },
    });
    journal.acceptInvocation(verification, "verification-read");
    journal.markExecuting(rsid, verificationId);
    journal.recordTerminal(rsid, verificationId, {
      status: "completed",
      payloadRetained: true,
      payload: { postcondition: "absent" },
      resultDigest: RESULT_DIGEST,
    });
    const inconclusive = journal.recordVerificationAttempt({
      rsid,
      holdId,
      verificationInvocationId: verificationId,
      evidenceDigest: RESULT_DIGEST,
      conclusion: "inconclusive",
    });
    expect(inconclusive.state).toBe("active");
    expect(() => journal.resolveHold({
      rsid,
      holdId,
      basis: "verification_read",
      verificationInvocationId: verificationId,
      evidenceDigest: RESULT_DIGEST,
      decision: "non_execution_proven",
      resolutionId: uuid(),
      auditId: uuid(),
      authorizedDispatchIdentity: "dispatch-two",
    })).toThrow(/invalid_state|inconclusive/u);

    journal.recordVerificationAttempt({
      rsid,
      holdId,
      verificationInvocationId: verificationId,
      evidenceDigest: RESULT_DIGEST,
      conclusion: "non_execution_proven",
    });
    journal.resolveHold({
      rsid,
      holdId,
      basis: "verification_read",
      verificationInvocationId: verificationId,
      evidenceDigest: RESULT_DIGEST,
      decision: "non_execution_proven",
      resolutionId: uuid(),
      auditId: uuid(),
      authorizedDispatchIdentity: "dispatch-two",
    });
    const clearance = journal.clearanceForHold(rsid, holdId);
    const fresh = binding({ rsid, mutating: true, clearances: [clearance] });
    expect(journal.acceptInvocation(fresh, "dispatch-two").kind).toBe("accepted");
    expect(journal.listHolds()[0]?.state).toBe("cleared");
    journal.close();
    root.cleanup();
  });

  it("rejects a redelivery whose params binding changed", () => {
    const journal = new DurableBridgeJournal(":memory:");
    const rsid = uuid();
    const first = binding({ rsid, mutating: false });
    expect(journal.acceptInvocation(first, "same-envelope").kind).toBe("accepted");
    const changed = { ...first, paramsDigest: makeParamsDigest({ element_id: 99 }) };
    expect(journal.acceptInvocation(changed, "same-envelope")).toMatchObject({
      kind: "protocol_fault",
      reason: "binding_mismatch",
    });
    journal.close();
  });

  it("rejects a changed executing mutation binding before installing a false recovery hold", () => {
    const journal = new DurableBridgeJournal(":memory:");
    const rsid = uuid();
    const first = binding({ rsid, mutating: true });
    expect(journal.acceptInvocation(first, "original-dispatch").kind).toBe("accepted");
    journal.markExecuting(rsid, first.invocationId);

    const changed = { ...first, paramsDigest: makeParamsDigest({ element_id: 99 }) };
    expect(journal.acceptInvocation(changed, "changed-redelivery")).toMatchObject({
      kind: "protocol_fault",
      reason: "binding_mismatch",
    });
    expect(journal.listHolds()).toEqual([]);
    expect(journal.getInvocation(rsid, first.invocationId)).toMatchObject({
      state: "executing",
      verificationHoldId: null,
    });

    journal.recordTerminal(rsid, first.invocationId, {
      status: "completed",
      payloadRetained: true,
      payload: { ok: true },
    });
    expect(journal.listHolds()).toEqual([]);
    journal.close();
  });

  it("groups every uncertain atomic mutation origin on one scope hold", () => {
    const root = temporaryRoot();
    const path = join(root.path, "journal.db");
    const rsid = uuid();
    const batchId = uuid();
    const batchDigest = `sha256:${"2".repeat(64)}`;
    const bindings = [0, 1].map((batchIndex) => ({
      ...binding({ rsid, mutating: true }),
      recoveryClearances: [],
      batchId,
      batchIndex,
      batchDigest,
    }));
    let journal = new DurableBridgeJournal(path);
    expect(journal.acceptBatchInvocations({
      bindings,
      recoveryClearances: [],
      dispatchIdentity: "batch-dispatch",
      atomic: true,
    }).kind).toBe("accepted");
    journal.acceptBatchBinding({
      batchId,
      rsid,
      batchDigest,
      bindingJson: JSON.stringify({ atomic: true }),
    });
    journal.markAtomicBatchDispatched({
      batchId,
      rsid,
      batchDigest,
      invocationIds: bindings.map((entry) => entry.invocationId),
    });
    journal.close();

    journal = new DurableBridgeJournal(path);
    const holds = journal.listHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]?.originIdempotencyKeys).toEqual(
      bindings.map((entry) => `${rsid}/${entry.invocationId}`),
    );
    expect(bindings.map((entry) => journal.getInvocation(rsid, entry.invocationId)?.state)).toEqual([
      "indeterminate",
      "indeterminate",
    ]);
    journal.close();
    root.cleanup();
  });

  it("accepts signed late terminal evidence and preserves cancel-before-dispatch semantics", () => {
    const root = temporaryRoot();
    const journal = new DurableBridgeJournal(join(root.path, "journal.db"));
    const rsid = uuid();
    const original = binding({ rsid, mutating: true });
    journal.acceptInvocation(original, "origin");
    journal.markExecuting(rsid, original.invocationId);
    const uncertain = journal.markIndeterminate(rsid, original.invocationId);
    const holdId = uncertain.verificationHoldId as string;
    journal.recordTerminal(rsid, original.invocationId, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: RESULT_DIGEST,
    });
    expect(journal.recordLateEvidence({
      rsid,
      holdId,
      originInvocationId: original.invocationId,
      evidenceDigest: RESULT_DIGEST,
      conclusion: "postcondition_verified",
    }).state).toBe("evidence_recorded");
    journal.resolveHold({
      rsid,
      holdId,
      basis: "late_terminal",
      verificationInvocationId: null,
      evidenceDigest: RESULT_DIGEST,
      decision: "postcondition_verified",
      resolutionId: uuid(),
      auditId: uuid(),
      authorizedDispatchIdentity: "after-late-terminal",
    });
    expect(journal.clearanceForHold(rsid, holdId).basis).toBe("late_terminal");

    const read = binding({ rsid, mutating: false });
    journal.acceptInvocation(read, "cancel-read");
    const ids = new DeterministicUuid7Source();
    const simulator = new BridgeSimulator(
      journal,
      new ArtifactSpool(join(root.path, "spool"), () => ids.next()),
    );
    expect(simulator.cancel(rsid, read.invocationId)).toMatchObject({
      kind: "error",
      faultClass: "cancelled",
      addinContacted: false,
    });
    expect(journal.getInvocation(rsid, read.invocationId)?.state).toBe("cancelled");
    simulator.close();
    journal.close();
    root.cleanup();
  });
});
