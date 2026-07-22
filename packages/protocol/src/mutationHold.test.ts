import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  authorizeMutationDispatch,
  createMutationHoldLedger,
  createReceivedJournalRecord,
  installMutationHolds,
  isOriginRedeliveryExempt,
  makeMutationHoldId,
  markJournalExecuting,
  markJournalIndeterminate,
  mutationScopesConflict,
  recordJournalTerminal,
  recordLateTerminalEvidence,
  recordVerificationEvidence,
  recoveryClearanceForHold,
  resolveMutationHold,
  type MutationHoldLedger,
  type MutationScope,
  type InvocationJournalRecord,
} from "./index.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function installDocumentHold(): {
  ledger: MutationHoldLedger;
  holdId: string;
} {
  const installed = installMutationHolds(createMutationHoldLedger(), "rs-a", [
    {
      originIdempotencyKey: "rs-a/inv-origin",
      mutationScope: { kind: "document", document_id: "doc-a" },
    },
  ]);
  if (installed.kind !== "installed") throw new Error("hold was not installed");
  const hold = installed.holds[0];
  if (hold === undefined) throw new Error("installed hold missing");
  return { ledger: installed.ledger, holdId: hold.holdId };
}

function verificationJournal(
  holdId: string,
  verificationInvocationId = "verify-1",
  resultDigest = digestA,
): InvocationJournalRecord {
  const record = createReceivedJournalRecord({
    rsid: "rs-a",
    invocationId: verificationInvocationId,
    method: "inspect_verification_state",
    mutating: false,
    mutationScope: null,
    paramsDigest: `sha256:${"1".repeat(64)}`,
    policy: { class: "auto", decision: "auto", confirmation_id: null },
    verification: {
      hold_id: holdId,
      mutation_scope: { kind: "document", document_id: "doc-a" },
      purpose: "resolve_indeterminate",
    },
    recoveryClearances: [],
  });
  return recordJournalTerminal(markJournalExecuting(record), {
    status: "completed",
    payloadRetained: true,
    payload: { observed: "postcondition_verified" },
    resultDigest,
  });
}

function lateOriginJournal(holdId: string, resultDigest = digestA): InvocationJournalRecord {
  let record = createReceivedJournalRecord({
    rsid: "rs-a",
    invocationId: "inv-origin",
    method: "set_element_parameter",
    mutating: true,
    mutationScope: { kind: "document", document_id: "doc-a" },
    paramsDigest: `sha256:${"2".repeat(64)}`,
    policy: { class: "confirm", decision: "confirmed", confirmation_id: "confirm-a" },
    verification: null,
    recoveryClearances: [],
  });
  record = markJournalExecuting(record);
  record = markJournalIndeterminate(record, holdId);
  return recordJournalTerminal(record, {
    status: "completed",
    payloadRetained: true,
    payload: { committed: false },
    resultDigest,
  });
}

describe("durable-model mutation-scope hold ledger", () => {
  it("derives a stable evidence id from rsid, normalized scope, and ordered origin keys", () => {
    const first = makeMutationHoldId("rs-a", { kind: "document", document_id: "doc-a" }, [
      "rs-a/inv-1",
      "rs-a/inv-2",
    ]);
    expect(first).toMatch(/^vh:[0-9a-f]{64}$/);
    expect(
      makeMutationHoldId("rs-a", { kind: "document", document_id: "doc-a" }, [
        "rs-a/inv-1",
        "rs-a/inv-2",
      ]),
    ).toBe(first);
    expect(
      makeMutationHoldId("rs-a", { kind: "document", document_id: "doc-a" }, [
        "rs-a/inv-2",
        "rs-a/inv-1",
      ]),
    ).not.toBe(first);
  });

  it("uses one conservative session hold when an uncertain batch contains session scope", () => {
    const installed = installMutationHolds(createMutationHoldLedger(), "rs-a", [
      { originIdempotencyKey: "rs-a/step-0", mutationScope: { kind: "document", document_id: "doc-a" } },
      { originIdempotencyKey: "rs-a/step-1", mutationScope: { kind: "session" } },
      { originIdempotencyKey: "rs-a/step-2", mutationScope: { kind: "document", document_id: "doc-b" } },
    ]);
    expect(installed).toMatchObject({
      kind: "installed",
      holds: [
        {
          mutationScope: { kind: "session" },
          originIdempotencyKeys: ["rs-a/step-0", "rs-a/step-1", "rs-a/step-2"],
        },
      ],
    });
  });

  it("blocks fresh-id invocation and batch writes while exempting only an origin redelivery", () => {
    const { ledger } = installDocumentHold();
    expect(isOriginRedeliveryExempt(ledger, "rs-a", "rs-a/inv-origin")).toBe(true);
    expect(isOriginRedeliveryExempt(ledger, "rs-a", "rs-a/inv-fresh")).toBe(false);
    expect(
      authorizeMutationDispatch(ledger, {
        rsid: "rs-a",
        mutationScopes: [{ kind: "document", document_id: "doc-a" }],
        recoveryClearances: [],
        dispatchIdentity: "rs-a/inv-fresh",
      }),
    ).toMatchObject({ kind: "blocked" });
    expect(
      authorizeMutationDispatch(ledger, {
        rsid: "rs-a",
        mutationScopes: [
          { kind: "document", document_id: "doc-b" },
          { kind: "session" },
        ],
        recoveryClearances: [],
        dispatchIdentity: "batch:fresh",
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("keeps inconclusive verification blocking and rejects foreign evidence", () => {
    const { ledger, holdId } = installDocumentHold();
    const journalRecord = verificationJournal(holdId);
    const inconclusive = recordVerificationEvidence(ledger, {
      rsid: "rs-a",
      holdId,
      mutationScope: { kind: "document", document_id: "doc-a" },
      verificationInvocationId: "verify-1",
      evidenceDigest: digestA,
      conclusion: "inconclusive",
      journalRecord,
    });
    expect(inconclusive).toMatchObject({
      kind: "inconclusive_recorded",
      hold: { state: "active", selectedEvidence: null },
    });
    expect(
      resolveMutationHold(inconclusive.ledger, {
        rsid: "rs-a",
        holdId,
        basis: "verification_read",
        verificationInvocationId: "verify-1",
        evidenceDigest: digestA,
        decision: "postcondition_verified",
        resolutionId: "resolution-1",
        auditId: "audit-1",
        authorizedDispatchIdentity: "rs-a/inv-next",
      }),
    ).toMatchObject({ kind: "rejected", reason: "invalid_state" });
    expect(
      recordVerificationEvidence(ledger, {
        rsid: "rs-a",
        holdId: `vh:${"f".repeat(64)}`,
        mutationScope: { kind: "document", document_id: "doc-a" },
        verificationInvocationId: "verify-foreign",
        evidenceDigest: digestA,
        conclusion: "postcondition_verified",
        journalRecord: verificationJournal(`vh:${"f".repeat(64)}`, "verify-foreign"),
      }),
    ).toMatchObject({ kind: "rejected", reason: "foreign_hold" });
  });

  it("clears exactly once through correlated verification evidence and an exact next-envelope clearance", () => {
    const initial = installDocumentHold();
    const journalRecord = verificationJournal(initial.holdId);
    const evidence = recordVerificationEvidence(initial.ledger, {
      rsid: "rs-a",
      holdId: initial.holdId,
      mutationScope: { kind: "document", document_id: "doc-a" },
      verificationInvocationId: "verify-1",
      evidenceDigest: digestA,
      conclusion: "postcondition_verified",
      journalRecord,
    });
    if (evidence.kind !== "recorded") throw new Error("evidence not recorded");
    const resolved = resolveMutationHold(evidence.ledger, {
      rsid: "rs-a",
      holdId: initial.holdId,
      basis: "verification_read",
      verificationInvocationId: "verify-1",
      evidenceDigest: digestA,
      decision: "postcondition_verified",
      resolutionId: "resolution-1",
      auditId: "audit-1",
      authorizedDispatchIdentity: "rs-a/inv-next",
    });
    if (resolved.kind !== "resolved") throw new Error("hold not resolved");
    const clearance = recoveryClearanceForHold(resolved.hold);
    expect(resolved.hold.resolution).toMatchObject({
      evidenceDigest: digestA,
      journalBindingDigest: journalRecord.bindingDigest,
      journalOutcomeDigest: journalRecord.terminalOutcomeDigest,
      terminalKind: "terminal",
      terminalStatus: "completed",
    });
    expect(clearance).toMatchObject({
      evidence_digest: digestA,
      verification_invocation_id: "verify-1",
    });
    expect(() =>
      recoveryClearanceForHold({
        ...resolved.hold,
        resolution: { ...resolved.hold.resolution!, evidenceDigest: digestB },
      }),
    ).toThrow(/journal-attested evidence/);

    expect(
      authorizeMutationDispatch(resolved.ledger, {
        rsid: "rs-a",
        mutationScopes: [{ kind: "document", document_id: "doc-a" }],
        recoveryClearances: [{ ...clearance, evidence_digest: digestB }],
        dispatchIdentity: "rs-a/inv-bad",
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "clearance_mismatch" });

    expect(
      authorizeMutationDispatch(resolved.ledger, {
        rsid: "rs-a",
        mutationScopes: [{ kind: "document", document_id: "doc-a" }],
        recoveryClearances: [clearance],
        dispatchIdentity: "rs-a/inv-foreign-envelope",
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "clearance_mismatch" });

    const accepted = authorizeMutationDispatch(resolved.ledger, {
      rsid: "rs-a",
      mutationScopes: [{ kind: "document", document_id: "doc-a" }],
      recoveryClearances: [clearance],
      dispatchIdentity: "rs-a/inv-next",
    });
    expect(accepted).toMatchObject({ kind: "allowed", clearedHoldIds: [initial.holdId] });
    if (accepted.kind !== "allowed") return;
    expect(accepted.ledger.holds[0]).toMatchObject({ state: "cleared", clearedBy: "rs-a/inv-next" });
    const identicalDuplicate = authorizeMutationDispatch(accepted.ledger, {
      rsid: "rs-a",
      mutationScopes: [{ kind: "document", document_id: "doc-a" }],
      recoveryClearances: [clearance],
      dispatchIdentity: "rs-a/inv-next",
    });
    expect(identicalDuplicate).toMatchObject({
      kind: "allowed",
      clearedHoldIds: [initial.holdId],
    });
    if (identicalDuplicate.kind === "allowed") {
      expect(identicalDuplicate.ledger).toBe(accepted.ledger);
    }
    expect(
      authorizeMutationDispatch(accepted.ledger, {
        rsid: "rs-a",
        mutationScopes: [{ kind: "document", document_id: "doc-a" }],
        recoveryClearances: [clearance],
        dispatchIdentity: "rs-a/inv-another",
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "foreign_clearance" });
  });

  it("rejects a caller digest unrelated to the correlated verification terminal", () => {
    const initial = installDocumentHold();
    const journalRecord = verificationJournal(initial.holdId, "verify-digest", digestA);
    const rejected = recordVerificationEvidence(initial.ledger, {
      rsid: "rs-a",
      holdId: initial.holdId,
      mutationScope: { kind: "document", document_id: "doc-a" },
      verificationInvocationId: "verify-digest",
      evidenceDigest: digestB,
      conclusion: "postcondition_verified",
      journalRecord,
    });
    expect(rejected).toMatchObject({
      kind: "rejected",
      reason: "evidence_digest_mismatch",
      ledger: { holds: [{ state: "active", selectedEvidence: null }] },
    });

    expect(
      recordVerificationEvidence(initial.ledger, {
        rsid: "rs-a",
        holdId: initial.holdId,
        mutationScope: { kind: "document", document_id: "doc-a" },
        verificationInvocationId: "different-verification-id",
        evidenceDigest: digestA,
        conclusion: "postcondition_verified",
        journalRecord,
      }),
    ).toMatchObject({ kind: "rejected", reason: "journal_binding_mismatch" });

    expect(
      recordVerificationEvidence(initial.ledger, {
        rsid: "rs-a",
        holdId: initial.holdId,
        mutationScope: { kind: "document", document_id: "doc-a" },
        verificationInvocationId: "verify-digest",
        evidenceDigest: digestB,
        conclusion: "postcondition_verified",
        journalRecord: {
          ...journalRecord,
          terminalOutcome: { ...journalRecord.terminalOutcome!, resultDigest: digestB },
        },
      }),
    ).toMatchObject({ kind: "rejected", reason: "journal_integrity_mismatch" });
  });

  it("accepts correlated conclusive late evidence but does not auto-clear the hold", () => {
    const initial = installDocumentHold();
    const journalRecord = lateOriginJournal(initial.holdId);
    const evidence = recordLateTerminalEvidence(initial.ledger, {
      rsid: "rs-a",
      holdId: initial.holdId,
      originIdempotencyKey: "rs-a/inv-origin",
      evidenceDigest: digestA,
      conclusion: "non_execution_proven",
      journalRecord,
    });
    expect(evidence).toMatchObject({
      kind: "recorded",
      hold: { state: "evidence_recorded", selectedEvidence: { basis: "late_terminal" } },
    });
    if (evidence.kind !== "recorded") return;
    expect(
      authorizeMutationDispatch(evidence.ledger, {
        rsid: "rs-a",
        mutationScopes: [{ kind: "document", document_id: "doc-a" }],
        recoveryClearances: [],
        dispatchIdentity: "rs-a/inv-fresh",
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("rejects a caller digest unrelated to the journal-attested late terminal", () => {
    const initial = installDocumentHold();
    const journalRecord = lateOriginJournal(initial.holdId, digestA);
    expect(
      recordLateTerminalEvidence(initial.ledger, {
        rsid: "rs-a",
        holdId: initial.holdId,
        originIdempotencyKey: "rs-a/inv-origin",
        evidenceDigest: digestB,
        conclusion: "non_execution_proven",
        journalRecord,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "evidence_digest_mismatch",
      ledger: { holds: [{ state: "active", selectedEvidence: null }] },
    });

    expect(
      recordLateTerminalEvidence(initial.ledger, {
        rsid: "rs-a",
        holdId: initial.holdId,
        originIdempotencyKey: "rs-a/inv-origin",
        evidenceDigest: digestB,
        conclusion: "non_execution_proven",
        journalRecord: {
          ...journalRecord,
          lateTerminalOutcome: { ...journalRecord.lateTerminalOutcome!, resultDigest: digestB },
        },
      }),
    ).toMatchObject({ kind: "rejected", reason: "journal_integrity_mismatch" });

    const ordinaryTerminal = recordJournalTerminal(
      markJournalExecuting(createReceivedJournalRecord(journalRecord.binding)),
      {
        status: "completed",
        payloadRetained: true,
        payload: { committed: false },
        resultDigest: digestA,
      },
    );
    expect(
      recordLateTerminalEvidence(initial.ledger, {
        rsid: "rs-a",
        holdId: initial.holdId,
        originIdempotencyKey: "rs-a/inv-origin",
        evidenceDigest: digestA,
        conclusion: "non_execution_proven",
        journalRecord: { ...ordinaryTerminal, verificationHoldId: initial.holdId },
      }),
    ).toMatchObject({ kind: "rejected", reason: "journal_state_mismatch" });
  });

  it("requires every and only conflicting clearance in ascending hold-id order", () => {
    const installed = installMutationHolds(createMutationHoldLedger(), "rs-a", [
      { originIdempotencyKey: "rs-a/step-a", mutationScope: { kind: "document", document_id: "doc-a" } },
      { originIdempotencyKey: "rs-a/step-b", mutationScope: { kind: "document", document_id: "doc-b" } },
    ]);
    if (installed.kind !== "installed") throw new Error("holds not installed");
    expect(
      authorizeMutationDispatch(installed.ledger, {
        rsid: "rs-a",
        mutationScopes: [
          { kind: "document", document_id: "doc-a" },
          { kind: "document", document_id: "doc-b" },
        ],
        recoveryClearances: [],
        dispatchIdentity: "batch-next",
      }),
    ).toMatchObject({ kind: "blocked", conflictingHolds: expect.arrayContaining([...installed.holds]) });
  });

  it("makes scope conflict symmetric for arbitrary document identities", () => {
    const scopeArbitrary = fc.oneof(
      fc.constant<MutationScope>({ kind: "session" }),
      fc.string({ minLength: 1, maxLength: 20 }).map(
        (documentId): MutationScope => ({ kind: "document", document_id: documentId }),
      ),
    );
    fc.assert(
      fc.property(scopeArbitrary, scopeArbitrary, (left, right) => {
        expect(mutationScopesConflict(left, right)).toBe(mutationScopesConflict(right, left));
        if (left.kind === "session" || right.kind === "session") {
          expect(mutationScopesConflict(left, right)).toBe(true);
        }
      }),
    );
  });
});
