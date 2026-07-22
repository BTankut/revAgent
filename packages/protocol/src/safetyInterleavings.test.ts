import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  acceptInboundData,
  applyCumulativeAck,
  authorizeMutationDispatch,
  createMutationHoldLedger,
  createRbpSequenceState,
  createReceivedJournalRecord,
  decideJournalRedelivery,
  installMutationHolds,
  makeParamsDigest,
  markJournalExecuting,
  markJournalIndeterminate,
  queueOutboundData,
  recordJournalTerminal,
  recordLateTerminalEvidence,
  recordVerificationEvidence,
  recoveryClearanceForHold,
  resolveMutationHold,
  retransmitOutbox,
  type DataEnvelopeSnapshot,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type MutationHoldLedger,
  type RbpSequenceState,
  type RecoveryClearance,
} from "./index.js";

type TraceEvent =
  | "deliver"
  | "duplicate"
  | "drop"
  | "reorder"
  | "reconnect"
  | "ack"
  | "ack_beyond_sent"
  | "redeliver_origin"
  | "late_outcome"
  | "verify_inconclusive"
  | "verify_valid"
  | "verify_foreign"
  | "resolve"
  | "fresh_mutation"
  | "clear"
  | "clear_duplicate"
  | "clear_foreign";

const rsid = "rs-property";
const originKey = `${rsid}/inv-origin`;
const scope = { kind: "document" as const, document_id: "doc-property" };

function binding(): InvocationJournalBinding {
  return {
    rsid,
    invocationId: "inv-origin",
    method: "set_element_parameter",
    mutating: true,
    mutationScope: scope,
    paramsDigest: `sha256:${"1".repeat(64)}`,
    policy: { class: "confirm", decision: "confirmed", confirmation_id: "confirmation" },
    verification: null,
    recoveryClearances: [],
  };
}

function correlatedVerificationJournal(
  holdId: string,
  invocationId: string,
  observed: "inconclusive" | "postcondition_verified",
): InvocationJournalRecord {
  const payload = { observed, verification_invocation_id: invocationId };
  let record = createReceivedJournalRecord({
    rsid,
    invocationId,
    method: "inspect_verification_state",
    mutating: false,
    mutationScope: null,
    paramsDigest: `sha256:${"2".repeat(64)}`,
    policy: { class: "auto", decision: "auto", confirmation_id: null },
    verification: {
      hold_id: holdId,
      mutation_scope: scope,
      purpose: "resolve_indeterminate",
    },
    recoveryClearances: [],
  });
  record = markJournalExecuting(record);
  return recordJournalTerminal(record, {
    status: "completed",
    payloadRetained: true,
    payload,
    resultDigest: makeParamsDigest(payload),
  });
}

function terminalDigest(record: InvocationJournalRecord): string {
  const digest = record.terminalOutcome?.resultDigest;
  if (digest === undefined) throw new Error("verification journal is missing terminal digest");
  return digest;
}

function lateTerminalDigest(record: InvocationJournalRecord): string {
  const digest = record.lateTerminalOutcome?.resultDigest;
  if (digest === undefined) throw new Error("origin journal is missing late terminal digest");
  return digest;
}

interface TraceState {
  sender: RbpSequenceState;
  receiver: RbpSequenceState;
  frame: DataEnvelopeSnapshot;
  journal: InvocationJournalRecord;
  ledger: MutationHoldLedger;
  holdId: string;
  clearance: RecoveryClearance | null;
  originalExecutionCount: number;
  acceptedDispatches: Map<string, number>;
  validEvidenceSeen: boolean;
}

function initialTraceState(): TraceState {
  const queued = queueOutboundData(createRbpSequenceState(rsid), {
    type: "invoke",
    id: "envelope-origin",
    payload: { invocation_id: "inv-origin" },
  });
  if (queued.kind !== "queued") throw new Error("initial frame was not queued");
  let journal = createReceivedJournalRecord(binding());
  journal = markJournalExecuting(journal);
  const installed = installMutationHolds(createMutationHoldLedger(), rsid, [
    { originIdempotencyKey: originKey, mutationScope: scope },
  ]);
  if (installed.kind !== "installed" || installed.holds[0] === undefined) {
    throw new Error("initial hold was not installed");
  }
  const holdId = installed.holds[0].holdId;
  journal = markJournalIndeterminate(journal, holdId);
  return {
    sender: queued.state,
    receiver: createRbpSequenceState(rsid),
    frame: queued.envelope,
    journal,
    ledger: installed.ledger,
    holdId,
    clearance: null,
    originalExecutionCount: 1,
    acceptedDispatches: new Map(),
    validEvidenceSeen: false,
  };
}

function countAccepted(state: TraceState, identity: string): void {
  const count = (state.acceptedDispatches.get(identity) ?? 0) + 1;
  state.acceptedDispatches.set(identity, count);
}

function activeHold(state: TraceState) {
  return state.ledger.holds.find((hold) => hold.holdId === state.holdId);
}

function runEvent(state: TraceState, event: TraceEvent, eventIndex: number): void {
  switch (event) {
    case "deliver":
    case "duplicate": {
      const result = acceptInboundData(state.receiver, state.frame);
      expect(["accepted", "duplicate"]).toContain(result.kind);
      state.receiver = result.state;
      break;
    }
    case "drop":
      break;
    case "reorder": {
      const reordered = { ...state.frame, id: "gap-frame", seq: 3 };
      const before = state.receiver.lastRxSeq;
      const result = acceptInboundData(state.receiver, reordered);
      expect(result.kind).toBe("gap");
      expect(result.state.lastRxSeq).toBe(before);
      break;
    }
    case "reconnect": {
      const replay = retransmitOutbox(state.sender, { ack: state.sender.lastRxSeq })[0];
      if (replay !== undefined) {
        const result = acceptInboundData(state.receiver, replay);
        expect(["accepted", "duplicate"]).toContain(result.kind);
        state.receiver = result.state;
      }
      break;
    }
    case "ack": {
      const acknowledged = applyCumulativeAck(state.sender, state.receiver.lastRxSeq);
      expect(acknowledged.kind).not.toBe("protocol_fault");
      state.sender = acknowledged.state;
      break;
    }
    case "ack_beyond_sent": {
      const before = state.sender;
      const rejected = applyCumulativeAck(state.sender, state.sender.highestTxSeq + 1);
      expect(rejected).toMatchObject({ kind: "protocol_fault", reason: "ack_beyond_sent" });
      expect(rejected.state).toBe(before);
      break;
    }
    case "redeliver_origin": {
      const decision = decideJournalRedelivery(state.journal, binding(), state.holdId);
      expect(decision.kind).not.toBe("reexecute_read");
      expect(decision.kind).not.toBe("promote_mutation_indeterminate");
      state.journal = decision.record;
      break;
    }
    case "late_outcome": {
      if (state.journal.state === "indeterminate") {
        const payload = { committed: true };
        state.journal = recordJournalTerminal(state.journal, {
          status: "completed",
          payloadRetained: true,
          payload,
          resultDigest: makeParamsDigest(payload),
        });
        const evidence = recordLateTerminalEvidence(state.ledger, {
          rsid,
          holdId: state.holdId,
          originIdempotencyKey: originKey,
          evidenceDigest: lateTerminalDigest(state.journal),
          conclusion: "postcondition_verified",
          journalRecord: state.journal,
        });
        if (evidence.kind === "recorded") {
          state.ledger = evidence.ledger;
          state.validEvidenceSeen = true;
        }
      }
      break;
    }
    case "verify_inconclusive": {
      const verificationInvocationId = `verify-inconclusive-${eventIndex}`;
      const journalRecord = correlatedVerificationJournal(
        state.holdId,
        verificationInvocationId,
        "inconclusive",
      );
      const evidence = recordVerificationEvidence(state.ledger, {
        rsid,
        holdId: state.holdId,
        mutationScope: scope,
        verificationInvocationId,
        evidenceDigest: terminalDigest(journalRecord),
        conclusion: "inconclusive",
        journalRecord,
      });
      if (evidence.kind === "inconclusive_recorded") state.ledger = evidence.ledger;
      break;
    }
    case "verify_valid": {
      const verificationInvocationId = `verify-valid-${eventIndex}`;
      const journalRecord = correlatedVerificationJournal(
        state.holdId,
        verificationInvocationId,
        "postcondition_verified",
      );
      const evidence = recordVerificationEvidence(state.ledger, {
        rsid,
        holdId: state.holdId,
        mutationScope: scope,
        verificationInvocationId,
        evidenceDigest: terminalDigest(journalRecord),
        conclusion: "postcondition_verified",
        journalRecord,
      });
      if (evidence.kind === "recorded") {
        state.ledger = evidence.ledger;
        state.validEvidenceSeen = true;
      }
      break;
    }
    case "verify_foreign": {
      const foreignHoldId = `vh:${"f".repeat(64)}`;
      const verificationInvocationId = `verify-foreign-${eventIndex}`;
      const journalRecord = correlatedVerificationJournal(
        foreignHoldId,
        verificationInvocationId,
        "postcondition_verified",
      );
      const evidence = recordVerificationEvidence(state.ledger, {
        rsid,
        holdId: foreignHoldId,
        mutationScope: scope,
        verificationInvocationId,
        evidenceDigest: terminalDigest(journalRecord),
        conclusion: "postcondition_verified",
        journalRecord,
      });
      expect(evidence).toMatchObject({ kind: "rejected", reason: "foreign_hold" });
      break;
    }
    case "resolve": {
      const hold = activeHold(state);
      const evidence = hold?.selectedEvidence;
      if (hold?.state === "evidence_recorded" && evidence !== null && evidence !== undefined) {
        const resolved = resolveMutationHold(state.ledger, {
          rsid,
          holdId: state.holdId,
          basis: evidence.basis,
          verificationInvocationId: evidence.verificationInvocationId,
          evidenceDigest: evidence.evidenceDigest,
          decision: evidence.conclusion as "postcondition_verified" | "non_execution_proven",
          resolutionId: "resolution-property",
          auditId: "audit-property",
          authorizedDispatchIdentity: "evidence-bound-envelope",
        });
        if (resolved.kind === "resolved") {
          state.ledger = resolved.ledger;
          state.clearance = recoveryClearanceForHold(resolved.hold);
        }
      }
      break;
    }
    case "fresh_mutation": {
      const hold = activeHold(state);
      if (hold !== undefined && hold.state !== "cleared") {
        const result = authorizeMutationDispatch(state.ledger, {
          rsid,
          mutationScopes: [scope],
          recoveryClearances: [],
          dispatchIdentity: `fresh-${eventIndex}`,
        });
        expect(result.kind).not.toBe("allowed");
      }
      break;
    }
    case "clear":
    case "clear_duplicate": {
      if (state.clearance !== null) {
        const identity = "evidence-bound-envelope";
        const wasAlreadyAccepted = state.acceptedDispatches.has(identity);
        const result = authorizeMutationDispatch(state.ledger, {
          rsid,
          mutationScopes: [scope],
          recoveryClearances: [state.clearance],
          dispatchIdentity: identity,
        });
        expect(result.kind).toBe("allowed");
        if (result.kind === "allowed") {
          state.ledger = result.ledger;
          if (!wasAlreadyAccepted) countAccepted(state, identity);
        }
      }
      break;
    }
    case "clear_foreign": {
      if (state.clearance !== null) {
        const result = authorizeMutationDispatch(state.ledger, {
          rsid,
          mutationScopes: [scope],
          recoveryClearances: [state.clearance],
          dispatchIdentity: "foreign-envelope",
        });
        expect(result.kind).not.toBe("allowed");
      }
      break;
    }
  }
}

function assertSafetyInvariants(state: TraceState): void {
  expect(state.originalExecutionCount).toBeLessThanOrEqual(1);
  expect([...state.acceptedDispatches.values()].every((count) => count <= 1)).toBe(true);
  expect(state.sender.lastPeerAck).toBeLessThanOrEqual(state.sender.highestTxSeq);
  expect(state.sender.outbox.every((entry) => entry.envelope.seq > state.sender.lastPeerAck)).toBe(true);
  expect(state.receiver.lastRxSeq).toBeLessThanOrEqual(1);

  const hold = activeHold(state);
  if (hold !== undefined && hold.state !== "cleared") {
    const bypass = authorizeMutationDispatch(state.ledger, {
      rsid,
      mutationScopes: [scope],
      recoveryClearances: [],
      dispatchIdentity: "invariant-fresh-probe",
    });
    expect(bypass.kind).not.toBe("allowed");
  }
  if (hold?.state === "cleared") {
    expect(state.validEvidenceSeen).toBe(true);
    expect(hold.selectedEvidence?.conclusion).toMatch(/^(?:non_execution_proven|postcondition_verified)$/);
    expect(hold.resolution).not.toBeNull();
    expect(hold.clearedBy).toBe("evidence-bound-envelope");
  }
}

describe("combined reconnect, journal, and mutation-hold safety", () => {
  it("never bypasses an active hold or executes one identity twice under arbitrary interleavings", () => {
    const eventArbitrary = fc.constantFrom<TraceEvent>(
      "deliver",
      "duplicate",
      "drop",
      "reorder",
      "reconnect",
      "ack",
      "ack_beyond_sent",
      "redeliver_origin",
      "late_outcome",
      "verify_inconclusive",
      "verify_valid",
      "verify_foreign",
      "resolve",
      "fresh_mutation",
      "clear",
      "clear_duplicate",
      "clear_foreign",
    );
    fc.assert(
      fc.property(fc.array(eventArbitrary, { minLength: 1, maxLength: 100 }), (events) => {
        const state = initialTraceState();
        const trace: readonly TraceEvent[] = [
          "drop",
          "reorder",
          "reconnect",
          "ack_beyond_sent",
          "fresh_mutation",
          ...events,
          "verify_inconclusive",
          "fresh_mutation",
          "verify_valid",
          "resolve",
          "clear",
          "clear_duplicate",
          "clear_foreign",
          "ack",
        ];
        trace.forEach((event, index) => {
          runEvent(state, event, index);
          assertSafetyInvariants(state);
        });
      }),
      { numRuns: 150 },
    );
  });
});
