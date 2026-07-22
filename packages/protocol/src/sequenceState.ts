import { createHash } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "./paramsDigest.js";

export const RBP_MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface DataEnvelopeSnapshot {
  readonly v: 1;
  readonly type: string;
  readonly id: string;
  readonly rsid: string;
  readonly seq: number;
  readonly ack?: number;
  readonly ts?: string;
  readonly payload: JsonValue;
}

export interface OutboundDataDraft {
  readonly v?: 1;
  readonly type: string;
  readonly id: string;
  readonly ack?: number;
  readonly ts?: string;
  readonly payload: JsonValue;
}

export interface RetainedOutboundData {
  readonly immutableDigest: `sha256:${string}`;
  readonly envelope: DataEnvelopeSnapshot;
}

export interface AcceptedInboundData {
  readonly seq: number;
  readonly immutableDigest: `sha256:${string}`;
}

/**
 * JSON-serializable protocol state for one rsid and one local send/receive pair.
 * A durable caller is responsible for persisting state before exposing an ack.
 */
export interface RbpSequenceState {
  readonly rsid: string;
  readonly nextTxSeq: number | null;
  readonly highestTxSeq: number;
  readonly lastRxSeq: number;
  readonly lastPeerAck: number;
  readonly outbox: readonly RetainedOutboundData[];
  readonly acceptedInbound: readonly AcceptedInboundData[];
}

export type QueueOutboundResult =
  | {
      readonly kind: "queued";
      readonly state: RbpSequenceState;
      readonly envelope: DataEnvelopeSnapshot;
      readonly renewalRequired: boolean;
    }
  | {
      readonly kind: "renewal_required";
      readonly state: RbpSequenceState;
      readonly outboxDrained: boolean;
    };

export type AckResult =
  | {
      readonly kind: "advanced" | "duplicate" | "stale";
      readonly state: RbpSequenceState;
      readonly acknowledgedSeqs: readonly number[];
    }
  | {
      readonly kind: "protocol_fault";
      readonly state: RbpSequenceState;
      readonly reason: "unsafe_ack" | "ack_beyond_sent";
    };

export type InboundDataResult =
  | {
      readonly kind: "accepted";
      readonly state: RbpSequenceState;
      readonly ack: number;
    }
  | {
      readonly kind: "duplicate";
      readonly state: RbpSequenceState;
      readonly ack: number;
    }
  | {
      readonly kind: "gap";
      readonly state: RbpSequenceState;
      readonly ack: number;
      readonly expectedSeq: number | null;
      readonly receivedSeq: number;
    }
  | {
      readonly kind: "protocol_fault";
      readonly state: RbpSequenceState;
      readonly ack: number;
      readonly reason:
        | "wrong_rsid"
        | "unsafe_sequence"
        | "unsafe_ack"
        | "ack_beyond_sent"
        | "sequence_exhausted"
        | "duplicate_identity_mismatch";
    };

export interface DispatchWindowEntry {
  readonly rsid: string;
  readonly invocationId: string;
  readonly kind: "invoke" | "invoke_batch";
}

export interface DispatchWindowLedger {
  readonly active: readonly DispatchWindowEntry[];
}

export type OpenDispatchWindowResult =
  | {
      readonly kind: "opened";
      readonly ledger: DispatchWindowLedger;
    }
  | {
      readonly kind: "protocol_fault";
      readonly ledger: DispatchWindowLedger;
      readonly active: DispatchWindowEntry;
    };

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function isSafeSequence(value: number, allowZero: boolean): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= RBP_MAX_SAFE_SEQUENCE
  );
}

function snapshotEnvelope(envelope: DataEnvelopeSnapshot): DataEnvelopeSnapshot {
  return {
    v: 1,
    type: envelope.type,
    id: envelope.id,
    rsid: envelope.rsid,
    seq: envelope.seq,
    ...(envelope.ack === undefined ? {} : { ack: envelope.ack }),
    ...(envelope.ts === undefined ? {} : { ts: envelope.ts }),
    payload: structuredClone(envelope.payload),
  };
}

export function dataEnvelopeImmutableDigest(
  envelope: Pick<DataEnvelopeSnapshot, "v" | "type" | "id" | "rsid" | "seq" | "payload">,
): `sha256:${string}` {
  const canonical = canonicalizeJson({
    id: envelope.id,
    payload: envelope.payload,
    rsid: envelope.rsid,
    seq: envelope.seq,
    type: envelope.type,
    v: envelope.v,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createRbpSequenceState(rsid: string): RbpSequenceState {
  assertNonEmpty(rsid, "rsid");
  return {
    rsid,
    nextTxSeq: 1,
    highestTxSeq: 0,
    lastRxSeq: 0,
    lastPeerAck: 0,
    outbox: [],
    acceptedInbound: [],
  };
}

export function queueOutboundData(
  state: RbpSequenceState,
  draft: OutboundDataDraft,
): QueueOutboundResult {
  assertNonEmpty(draft.type, "type");
  assertNonEmpty(draft.id, "id");
  if (draft.v !== undefined && draft.v !== 1) {
    throw new RangeError("RBP/1 outbound data must use v=1");
  }
  if (draft.ack !== undefined && !isSafeSequence(draft.ack, true)) {
    throw new RangeError("ack must be a JSON-safe non-negative integer");
  }
  if (draft.ack !== undefined && draft.ack > state.lastRxSeq) {
    throw new RangeError("outbound ack cannot exceed lastRxSeq");
  }

  const seq = state.nextTxSeq;
  if (seq === null) {
    return {
      kind: "renewal_required",
      state,
      outboxDrained: state.outbox.length === 0,
    };
  }

  const envelope = snapshotEnvelope({
    v: 1,
    type: draft.type,
    id: draft.id,
    rsid: state.rsid,
    seq,
    ...(draft.ack === undefined ? {} : { ack: draft.ack }),
    ...(draft.ts === undefined ? {} : { ts: draft.ts }),
    payload: draft.payload,
  });
  const retained: RetainedOutboundData = {
    immutableDigest: dataEnvelopeImmutableDigest(envelope),
    envelope,
  };
  const nextTxSeq = seq === RBP_MAX_SAFE_SEQUENCE ? null : seq + 1;

  return {
    kind: "queued",
    envelope: snapshotEnvelope(envelope),
    renewalRequired: nextTxSeq === null,
    state: {
      ...state,
      nextTxSeq,
      highestTxSeq: seq,
      outbox: [...state.outbox, retained],
    },
  };
}

export function applyCumulativeAck(state: RbpSequenceState, ack: number): AckResult {
  if (!isSafeSequence(ack, true)) {
    return { kind: "protocol_fault", state, reason: "unsafe_ack" };
  }
  if (ack > state.highestTxSeq) {
    return { kind: "protocol_fault", state, reason: "ack_beyond_sent" };
  }
  if (ack < state.lastPeerAck) {
    return { kind: "stale", state, acknowledgedSeqs: [] };
  }
  if (ack === state.lastPeerAck) {
    return { kind: "duplicate", state, acknowledgedSeqs: [] };
  }

  const acknowledgedSeqs = state.outbox
    .filter((entry) => entry.envelope.seq <= ack)
    .map((entry) => entry.envelope.seq);
  return {
    kind: "advanced",
    acknowledgedSeqs,
    state: {
      ...state,
      lastPeerAck: ack,
      outbox: state.outbox.filter((entry) => entry.envelope.seq > ack),
    },
  };
}

export function acceptInboundData(
  state: RbpSequenceState,
  incoming: DataEnvelopeSnapshot,
): InboundDataResult {
  if (incoming.rsid !== state.rsid) {
    return { kind: "protocol_fault", state, ack: state.lastRxSeq, reason: "wrong_rsid" };
  }
  let stateAfterAck = state;
  if (incoming.ack !== undefined) {
    const ackResult = applyCumulativeAck(state, incoming.ack);
    if (ackResult.kind === "protocol_fault") {
      return {
        kind: "protocol_fault",
        state,
        ack: state.lastRxSeq,
        reason: ackResult.reason,
      };
    }
    stateAfterAck = ackResult.state;
  }
  if (!isSafeSequence(incoming.seq, false)) {
    return {
      kind: "protocol_fault",
      state: stateAfterAck,
      ack: stateAfterAck.lastRxSeq,
      reason: "unsafe_sequence",
    };
  }

  const digest = dataEnvelopeImmutableDigest(incoming);
  if (incoming.seq <= stateAfterAck.lastRxSeq) {
    const retained = stateAfterAck.acceptedInbound.find((entry) => entry.seq === incoming.seq);
    if (retained?.immutableDigest === digest) {
      return { kind: "duplicate", state: stateAfterAck, ack: stateAfterAck.lastRxSeq };
    }
    return {
      kind: "protocol_fault",
      state: stateAfterAck,
      ack: stateAfterAck.lastRxSeq,
      reason: "duplicate_identity_mismatch",
    };
  }

  if (stateAfterAck.lastRxSeq === RBP_MAX_SAFE_SEQUENCE) {
    return {
      kind: "protocol_fault",
      state: stateAfterAck,
      ack: stateAfterAck.lastRxSeq,
      reason: "sequence_exhausted",
    };
  }

  const expectedSeq = stateAfterAck.lastRxSeq + 1;
  if (incoming.seq !== expectedSeq) {
    return {
      kind: "gap",
      state: stateAfterAck,
      ack: stateAfterAck.lastRxSeq,
      expectedSeq,
      receivedSeq: incoming.seq,
    };
  }

  return {
    kind: "accepted",
    ack: incoming.seq,
    state: {
      ...stateAfterAck,
      lastRxSeq: incoming.seq,
      acceptedInbound: [
        ...stateAfterAck.acceptedInbound,
        { seq: incoming.seq, immutableDigest: digest },
      ],
    },
  };
}

/** Returns immutable retransmission snapshots in ascending sequence order. */
export function retransmitOutbox(
  state: RbpSequenceState,
  refresh: { readonly ack?: number; readonly ts?: string } = {},
): readonly DataEnvelopeSnapshot[] {
  if (refresh.ack !== undefined && !isSafeSequence(refresh.ack, true)) {
    throw new RangeError("ack must be a JSON-safe non-negative integer");
  }
  if (refresh.ack !== undefined && refresh.ack > state.lastRxSeq) {
    throw new RangeError("retransmission ack cannot exceed lastRxSeq");
  }

  return [...state.outbox]
    .sort((left, right) => left.envelope.seq - right.envelope.seq)
    .map((entry) =>
      snapshotEnvelope({
        ...entry.envelope,
        ...(refresh.ack === undefined ? {} : { ack: refresh.ack }),
        ...(refresh.ts === undefined ? {} : { ts: refresh.ts }),
      }),
    );
}

export function sequenceRenewalStatus(state: RbpSequenceState):
  | "not_required"
  | "drain_required"
  | "ready_for_new_rsid" {
  if (state.nextTxSeq !== null) {
    return "not_required";
  }
  return state.outbox.length === 0 ? "ready_for_new_rsid" : "drain_required";
}

export function createDispatchWindowLedger(): DispatchWindowLedger {
  return { active: [] };
}

export function openDispatchWindow(
  ledger: DispatchWindowLedger,
  entry: DispatchWindowEntry,
): OpenDispatchWindowResult {
  assertNonEmpty(entry.rsid, "rsid");
  assertNonEmpty(entry.invocationId, "invocationId");
  const active = ledger.active.find((candidate) => candidate.rsid === entry.rsid);
  if (active !== undefined) {
    return { kind: "protocol_fault", ledger, active };
  }
  return { kind: "opened", ledger: { active: [...ledger.active, { ...entry }] } };
}

export function closeDispatchWindow(
  ledger: DispatchWindowLedger,
  rsid: string,
  invocationId: string,
): DispatchWindowLedger {
  const active = ledger.active.find((candidate) => candidate.rsid === rsid);
  if (active === undefined) {
    throw new Error(`no active dispatch window for ${rsid}`);
  }
  if (active.invocationId !== invocationId) {
    throw new Error(`dispatch window for ${rsid} belongs to ${active.invocationId}`);
  }
  return { active: ledger.active.filter((candidate) => candidate.rsid !== rsid) };
}
