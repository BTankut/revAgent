import { join } from "node:path";

import {
  makeParamsDigest,
  type InvocationJournalBinding,
  type MutationScope,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { temporaryRoot, uuid } from "./helpers.js";

const RESULT_DIGEST = `sha256:${"1".repeat(64)}`;

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
