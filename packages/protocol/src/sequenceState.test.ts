import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  acceptInboundData,
  applyCumulativeAck,
  closeDispatchWindow,
  createDispatchWindowLedger,
  createRbpSequenceState,
  dataEnvelopeImmutableDigest,
  openDispatchWindow,
  queueOutboundData,
  RBP_MAX_SAFE_SEQUENCE,
  retransmitOutbox,
  sequenceRenewalStatus,
  type DataEnvelopeSnapshot,
  type RbpSequenceState,
} from "./index.js";

function inbound(rsid: string, seq: number, value: number, ack?: number): DataEnvelopeSnapshot {
  return {
    v: 1,
    type: "invoke",
    id: `id-${seq}`,
    rsid,
    seq,
    ...(ack === undefined ? {} : { ack }),
    payload: { value },
  };
}

function queueCount(count: number): RbpSequenceState {
  let state = createRbpSequenceState("rs-a");
  for (let index = 0; index < count; index += 1) {
    const queued = queueOutboundData(state, {
      type: "result",
      id: `id-${index + 1}`,
      payload: { index },
    });
    if (queued.kind !== "queued") {
      throw new Error("unexpected sequence exhaustion");
    }
    state = queued.state;
  }
  return state;
}

describe("per-rsid seq/ack bookkeeping", () => {
  it("retains unacknowledged data and refreshes only ack/ts during ordered retransmission", () => {
    let state = queueCount(3);
    for (let seq = 1; seq <= 7; seq += 1) {
      const received = acceptInboundData(state, inbound("rs-a", seq, seq));
      if (received.kind !== "accepted") throw new Error("peer data was not accepted");
      state = received.state;
    }
    const before = state.outbox.map((entry) => entry.immutableDigest);
    const acked = applyCumulativeAck(state, 1);
    expect(acked.kind).toBe("advanced");
    state = acked.state;

    const retransmissions = retransmitOutbox(state, {
      ack: 7,
      ts: "2026-07-22T15:00:00.000Z",
    });
    expect(retransmissions.map((frame) => frame.seq)).toEqual([2, 3]);
    expect(retransmissions.every((frame) => frame.ack === 7)).toBe(true);
    expect(retransmissions.map(dataEnvelopeImmutableDigest)).toEqual(before.slice(1));
  });

  it("keeps transmit acknowledgements and receive acknowledgements on separate bounded axes", () => {
    let state = queueCount(2);
    expect(() =>
      queueOutboundData(state, { type: "result", id: "bad-ack", ack: 1, payload: {} }),
    ).toThrow(/lastRxSeq/);
    expect(() => retransmitOutbox(state, { ack: 1 })).toThrow(/lastRxSeq/);

    const peerOne = acceptInboundData(state, inbound("rs-a", 1, 1, 2));
    expect(peerOne.kind).toBe("accepted");
    state = peerOne.state;
    expect(state.lastRxSeq).toBe(1);
    expect(state.lastPeerAck).toBe(2);
    expect(state.outbox).toHaveLength(0);
    expect(
      queueOutboundData(state, { type: "result", id: "bounded-ack", ack: 1, payload: {} }),
    ).toMatchObject({ kind: "queued", envelope: { ack: 1 } });
  });

  it("rejects a peer ack beyond data sent even when its receive sequence is contiguous", () => {
    const state = queueCount(2);
    expect(acceptInboundData(state, inbound("rs-a", 1, 1, 3))).toMatchObject({
      kind: "protocol_fault",
      reason: "ack_beyond_sent",
    });
    expect(state.lastRxSeq).toBe(0);
    expect(state.outbox).toHaveLength(2);
  });

  it("ignores stale cumulative acks and rejects acknowledgements beyond sent data", () => {
    const state = queueCount(3);
    const advanced = applyCumulativeAck(state, 2);
    expect(advanced.kind).toBe("advanced");
    expect(applyCumulativeAck(advanced.state, 1)).toMatchObject({ kind: "stale" });
    expect(applyCumulativeAck(advanced.state, 2)).toMatchObject({ kind: "duplicate" });
    expect(applyCumulativeAck(advanced.state, 4)).toMatchObject({
      kind: "protocol_fault",
      reason: "ack_beyond_sent",
    });
  });

  it("accepts identical duplicates, rejects identity reuse, and never guesses across a gap", () => {
    const initial = createRbpSequenceState("rs-a");
    const first = acceptInboundData(initial, inbound("rs-a", 1, 10));
    expect(first.kind).toBe("accepted");
    const accepted = first.state;

    expect(acceptInboundData(accepted, inbound("rs-a", 1, 10))).toMatchObject({
      kind: "duplicate",
      ack: 1,
    });
    expect(acceptInboundData(accepted, inbound("rs-a", 1, 11))).toMatchObject({
      kind: "protocol_fault",
      reason: "duplicate_identity_mismatch",
    });
    expect(acceptInboundData(accepted, inbound("rs-a", 3, 30))).toMatchObject({
      kind: "gap",
      expectedSeq: 2,
      ack: 1,
    });
  });

  it("accepts the maximum safe value once, never wraps, and requires outbox drain before renewal", () => {
    const nearLimit: RbpSequenceState = {
      ...createRbpSequenceState("rs-limit"),
      nextTxSeq: RBP_MAX_SAFE_SEQUENCE,
      highestTxSeq: RBP_MAX_SAFE_SEQUENCE - 1,
      lastPeerAck: RBP_MAX_SAFE_SEQUENCE - 1,
    };
    const final = queueOutboundData(nearLimit, {
      type: "result",
      id: "id-limit",
      payload: {},
    });
    expect(final.kind).toBe("queued");
    if (final.kind !== "queued") return;
    expect(final.envelope.seq).toBe(RBP_MAX_SAFE_SEQUENCE);
    expect(final.renewalRequired).toBe(true);
    expect(sequenceRenewalStatus(final.state)).toBe("drain_required");
    expect(queueOutboundData(final.state, { type: "result", id: "never-wrap", payload: {} })).toMatchObject({
      kind: "renewal_required",
    });

    const drained = applyCumulativeAck(final.state, RBP_MAX_SAFE_SEQUENCE);
    expect(drained.kind).toBe("advanced");
    expect(sequenceRenewalStatus(drained.state)).toBe("ready_for_new_rsid");
    expect(acceptInboundData(createRbpSequenceState("rs-limit"), inbound("rs-limit", 2 ** 53, 1))).toMatchObject({
      kind: "protocol_fault",
      reason: "unsafe_sequence",
    });
  });

  it("enforces window=1 per rsid while allowing distinct sessions in parallel", () => {
    let ledger = createDispatchWindowLedger();
    const first = openDispatchWindow(ledger, {
      rsid: "rs-a",
      invocationId: "inv-a1",
      kind: "invoke",
    });
    expect(first.kind).toBe("opened");
    ledger = first.ledger;
    expect(
      openDispatchWindow(ledger, { rsid: "rs-a", invocationId: "inv-a2", kind: "invoke_batch" }),
    ).toMatchObject({ kind: "protocol_fault", active: { invocationId: "inv-a1" } });

    const parallel = openDispatchWindow(ledger, {
      rsid: "rs-b",
      invocationId: "inv-b1",
      kind: "invoke",
    });
    expect(parallel.kind).toBe("opened");
    expect(parallel.ledger.active).toHaveLength(2);
    expect(closeDispatchWindow(parallel.ledger, "rs-a", "inv-a1").active).toEqual([
      expect.objectContaining({ rsid: "rs-b" }),
    ]);
  });

  it("preserves cumulative ack and outbox invariants for arbitrary monotonic acknowledgements", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 100 }),
        (sent, rawAcks) => {
          let state = queueCount(sent);
          let observed = 0;
          for (const ack of rawAcks.map((value) => Math.min(value, sent)).sort((a, b) => a - b)) {
            const result = applyCumulativeAck(state, ack);
            expect(result.kind).not.toBe("protocol_fault");
            state = result.state;
            observed = Math.max(observed, ack);
            expect(state.lastPeerAck).toBe(observed);
            expect(state.outbox.every((entry) => entry.envelope.seq > observed)).toBe(true);
          }
        },
      ),
    );
  });

  it("never advances receive state for arbitrary forward gaps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 100_000 }), (seq) => {
        const state = createRbpSequenceState("rs-gap");
        const result = acceptInboundData(state, inbound("rs-gap", seq, seq));
        expect(result.kind).toBe("gap");
        expect(result.state).toBe(state);
        expect(result.state.lastRxSeq).toBe(0);
      }),
    );
  });
});
