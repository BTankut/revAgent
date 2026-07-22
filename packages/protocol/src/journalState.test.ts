import { describe, expect, it } from "vitest";

import {
  createReceivedJournalRecord,
  decideAtomicBatchRedelivery,
  decideJournalRedelivery,
  handleJournalSessionUnregister,
  markJournalExecuting,
  planAtomicFalseBatchRedelivery,
  recordJournalTerminal,
  requestJournalCancellation,
  validateAtomicFalseBatchStatuses,
  type InvocationJournalBinding,
} from "./index.js";

const holdId = `vh:${"a".repeat(64)}`;

function binding(
  invocationId: string,
  mutating = false,
  batchIndex?: number,
): InvocationJournalBinding {
  return {
    rsid: "rs-a",
    invocationId,
    method: mutating ? "set_element_parameter" : "inspect_schedules",
    mutating,
    mutationScope: mutating ? { kind: "document", document_id: "doc-a" } : null,
    paramsDigest: `sha256:${"1".repeat(64)}`,
    verification: null,
    recoveryClearances: [],
    policy: mutating
      ? { class: "confirm", decision: "confirmed", confirmation_id: "confirm-a" }
      : { class: "auto", decision: "auto", confirmation_id: null },
    ...(batchIndex === undefined
      ? {}
      : {
          batchId: "batch-a",
          batchIndex,
          batchDigest: `sha256:${"2".repeat(64)}`,
        }),
  };
}

describe("invocation and journal FSM", () => {
  it("replays a durable terminal outcome without another execution", () => {
    const received = createReceivedJournalRecord(binding("inv-read"));
    const completed = recordJournalTerminal(markJournalExecuting(received), {
      status: "completed",
      payloadRetained: true,
      payload: { rows: 3 },
      resultDigest: `sha256:${"3".repeat(64)}`,
    });
    expect(decideJournalRedelivery(completed, binding("inv-read"))).toMatchObject({
      kind: "replay_terminal",
      outcome: { status: "completed", payload: { rows: 3 } },
    });
  });

  it("fails a changed binding as protocol before any replay decision", () => {
    const record = createReceivedJournalRecord(binding("inv-read"));
    expect(
      decideJournalRedelivery(record, {
        ...binding("inv-read"),
        paramsDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "binding_mismatch" });
  });

  it("binds hold-correlated verification evidence into the journal identity", () => {
    const ordinary = binding("inv-read");
    const correlated: InvocationJournalBinding = {
      ...ordinary,
      verification: {
        hold_id: holdId,
        mutation_scope: { kind: "document", document_id: "doc-a" },
        purpose: "resolve_indeterminate",
      },
    };
    const record = createReceivedJournalRecord(ordinary);
    expect(decideJournalRedelivery(record, correlated)).toMatchObject({
      kind: "protocol_fault",
      reason: "binding_mismatch",
    });
    const correlatedRecord = createReceivedJournalRecord(correlated);
    expect(() =>
      recordJournalTerminal(correlatedRecord, {
        status: "completed",
        payloadRetained: true,
        payload: { verified: true },
      }),
    ).toThrow(/verification terminal requires resultDigest/);
    expect(requestJournalCancellation(correlatedRecord)).toMatchObject({
      kind: "cancelled_before_dispatch",
      record: {
        state: "cancelled",
        terminalOutcome: { resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      },
    });
    expect(handleJournalSessionUnregister(correlatedRecord, true)).toMatchObject({
      kind: "known_addin_unreachable",
      record: {
        state: "failed",
        terminalOutcome: { resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      },
    });
  });

  it("promotes an uncertain mutation to indeterminate with zero re-executions", () => {
    const executing = markJournalExecuting(createReceivedJournalRecord(binding("inv-write", true)));
    const decision = decideJournalRedelivery(executing, binding("inv-write", true), holdId);
    expect(decision).toMatchObject({
      kind: "promote_mutation_indeterminate",
      record: { state: "indeterminate", verificationHoldId: holdId },
    });
    if (decision.kind !== "promote_mutation_indeterminate") return;
    expect(decideJournalRedelivery(decision.record, binding("inv-write", true))).toMatchObject({
      kind: "return_indeterminate",
    });
  });

  it("allows a non-mutating recovery execution at most once", () => {
    const executing = markJournalExecuting(createReceivedJournalRecord(binding("inv-read")));
    const first = decideJournalRedelivery(executing, binding("inv-read"));
    expect(first.kind).toBe("reexecute_read");
    if (first.kind !== "reexecute_read") return;
    expect(first.record.readRecoveryConsumed).toBe(true);
    expect(decideJournalRedelivery(first.record, binding("inv-read"))).toMatchObject({
      kind: "read_recovery_already_consumed",
    });
  });

  it("preserves the real terminal outcome after an executing cancellation", () => {
    const executing = markJournalExecuting(createReceivedJournalRecord(binding("inv-write", true)));
    const cancellation = requestJournalCancellation(executing);
    expect(cancellation).toMatchObject({ kind: "await_real_outcome", record: { abandoned: true } });
    if (cancellation.kind !== "await_real_outcome") return;
    const terminal = recordJournalTerminal(cancellation.record, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: `sha256:${"4".repeat(64)}`,
    });
    expect(terminal).toMatchObject({
      abandoned: true,
      terminalOutcome: { status: "completed", payload: { committed: true } },
    });
  });

  it("records a late real outcome without overwriting the indeterminate classification", () => {
    const executing = markJournalExecuting(createReceivedJournalRecord(binding("inv-write", true)));
    const uncertain = decideJournalRedelivery(executing, binding("inv-write", true), holdId);
    if (uncertain.kind !== "promote_mutation_indeterminate") throw new Error("promotion failed");
    const late = recordJournalTerminal(uncertain.record, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: `sha256:${"5".repeat(64)}`,
    });
    expect(late.state).toBe("indeterminate");
    expect(decideJournalRedelivery(late, binding("inv-write", true))).toMatchObject({
      kind: "replay_late_terminal",
      verificationHoldId: holdId,
    });
  });

  it("never turns a possibly dispatched mutation into known failure on session unregister", () => {
    const executing = markJournalExecuting(createReceivedJournalRecord(binding("inv-write", true)));
    expect(handleJournalSessionUnregister(executing, false, holdId)).toMatchObject({
      kind: "mutation_indeterminate",
      requiresHold: true,
      record: { state: "indeterminate" },
    });
    const notDispatched = createReceivedJournalRecord(binding("inv-write-2", true));
    expect(handleJournalSessionUnregister(notDispatched, true)).toMatchObject({
      kind: "known_addin_unreachable",
      record: { state: "failed" },
    });
  });

  it("stops first-delivery atomic:false on a guarded step", () => {
    expect(validateAtomicFalseBatchStatuses(["guarded", "not_started", "not_started"])).toEqual({
      valid: true,
      failedStepIndex: 0,
    });
    expect(validateAtomicFalseBatchStatuses(["guarded", "completed"])).toEqual({ valid: false });
    expect(validateAtomicFalseBatchStatuses(["completed", "completed"])).toEqual({
      valid: true,
      failedStepIndex: null,
    });
  });

  it("plans mixed terminal/non-terminal atomic:false redelivery safely", () => {
    const completed = recordJournalTerminal(
      markJournalExecuting(createReceivedJournalRecord(binding("step-0", false, 0))),
      { status: "completed", payloadRetained: true, payload: {} },
    );
    const uncertainWrite = markJournalExecuting(
      createReceivedJournalRecord(binding("step-1", true, 1)),
    );
    const successor = createReceivedJournalRecord(binding("step-2", false, 2));
    const incomingBindings = [completed.binding, uncertainWrite.binding, successor.binding];
    const plan = planAtomicFalseBatchRedelivery(
      [completed, uncertainWrite, successor],
      incomingBindings,
      { "step-1": holdId },
    );
    expect(plan).toMatchObject({
      kind: "planned",
      replayed: true,
      failedStepIndex: 1,
      steps: [
        { action: "replay", status: "completed" },
        { action: "return_indeterminate", status: "indeterminate" },
        { action: "not_started", status: "not_started" },
      ],
    });
    if (plan.kind !== "planned") throw new Error("batch plan failed");
    expect(plan.records[1]?.state).toBe("indeterminate");
  });

  it("rejects reordered, different-batch, digest, and mutation-scope journal rows", () => {
    const first = createReceivedJournalRecord(binding("step-0", false, 0));
    const second = createReceivedJournalRecord(binding("step-1", true, 1));
    const incoming = [first.binding, second.binding];
    expect(planAtomicFalseBatchRedelivery([second, first], incoming)).toMatchObject({
      kind: "protocol_fault",
      reason: "batch_binding_mismatch",
    });
    expect(
      planAtomicFalseBatchRedelivery([first, second], [
        incoming[0]!,
        { ...incoming[1]!, batchId: "other-batch" },
      ]),
    ).toMatchObject({ kind: "protocol_fault" });
    expect(
      planAtomicFalseBatchRedelivery([first, second], [
        incoming[0]!,
        { ...incoming[1]!, batchDigest: `sha256:${"8".repeat(64)}` },
      ]),
    ).toMatchObject({ kind: "protocol_fault" });
    expect(
      planAtomicFalseBatchRedelivery([first, second], [
        incoming[0]!,
        {
          ...incoming[1]!,
          mutationScope: { kind: "document", document_id: "doc-other" },
        },
      ]),
    ).toMatchObject({ kind: "protocol_fault" });
  });

  it("replays mandatory late terminal batch evidence instead of regressing to indeterminate", () => {
    const stepBinding = binding("step-late", true, 0);
    const executing = markJournalExecuting(createReceivedJournalRecord(stepBinding));
    const promoted = decideJournalRedelivery(executing, stepBinding, holdId);
    if (promoted.kind !== "promote_mutation_indeterminate") throw new Error("promotion failed");
    const late = recordJournalTerminal(promoted.record, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: `sha256:${"5".repeat(64)}`,
    });
    const plan = planAtomicFalseBatchRedelivery([late], [stepBinding]);
    expect(plan).toMatchObject({
      kind: "planned",
      failedStepIndex: null,
      steps: [{ action: "replay", status: "completed" }],
    });
  });

  it("distinguishes atomic terminal replay from uncertain dispatched recovery", () => {
    const atomicBinding = {
      batchId: "batch-a",
      batchDigest: `sha256:${"6".repeat(64)}`,
      orderedStepBindingDigests: [`sha256:${"7".repeat(64)}`],
    };
    expect(
      decideAtomicBatchRedelivery({
        binding: atomicBinding,
        state: "terminal",
        dispatchMayHaveStarted: true,
        terminalDigest: `sha256:${"6".repeat(64)}`,
      }, atomicBinding),
    ).toMatchObject({ kind: "replay_terminal" });
    expect(
      decideAtomicBatchRedelivery({
        binding: atomicBinding,
        state: "received",
        dispatchMayHaveStarted: false,
        terminalDigest: null,
      }, atomicBinding),
    ).toMatchObject({ kind: "execute_atomic", record: { state: "dispatched" } });
    expect(
      decideAtomicBatchRedelivery({
        binding: atomicBinding,
        state: "dispatched",
        dispatchMayHaveStarted: true,
        terminalDigest: null,
      }, atomicBinding),
    ).toMatchObject({ kind: "return_indeterminate", record: { state: "indeterminate" } });
    expect(
      decideAtomicBatchRedelivery(
        {
          binding: atomicBinding,
          state: "terminal",
          dispatchMayHaveStarted: true,
          terminalDigest: `sha256:${"6".repeat(64)}`,
        },
        { ...atomicBinding, orderedStepBindingDigests: [...atomicBinding.orderedStepBindingDigests].reverse().concat("extra") },
      ),
    ).toMatchObject({ kind: "protocol_fault", reason: "batch_binding_mismatch" });
  });

  it("requires guarded reason and digest-backed omitted outcomes", () => {
    const received = createReceivedJournalRecord(binding("guarded"));
    expect(() =>
      recordJournalTerminal(received, { status: "guarded", payloadRetained: true, payload: {} }),
    ).toThrow(/guardedReason/);
    expect(() =>
      recordJournalTerminal(received, { status: "completed", payloadRetained: false }),
    ).toThrow(/resultDigest/);
    expect(() =>
      recordJournalTerminal(received, {
        status: "completed",
        payloadRetained: true,
      }),
    ).toThrow(/must be present/);
    expect(() =>
      recordJournalTerminal(received, {
        status: "completed",
        payloadRetained: false,
        payload: {},
        resultDigest: `sha256:${"7".repeat(64)}`,
      }),
    ).toThrow(/cannot retain/);
    expect(
      recordJournalTerminal(received, {
        status: "guarded",
        guardedReason: "confirmation_required",
        payloadRetained: false,
        resultDigest: `sha256:${"7".repeat(64)}`,
      }),
    ).toMatchObject({ state: "guarded" });
  });

  it("makes identical terminal persistence idempotent and rejects conflicting duplicates", () => {
    const received = createReceivedJournalRecord(binding("terminal-idempotent"));
    const outcome = {
      status: "completed" as const,
      payloadRetained: true,
      payload: { value: 1 },
      resultDigest: `sha256:${"8".repeat(64)}`,
    };
    const terminal = recordJournalTerminal(received, outcome);
    expect(recordJournalTerminal(terminal, structuredClone(outcome))).toBe(terminal);
    expect(() =>
      recordJournalTerminal(terminal, { ...outcome, payload: { value: 2 } }),
    ).toThrow(/conflicting terminal/);

    const uncertain = decideJournalRedelivery(
      markJournalExecuting(createReceivedJournalRecord(binding("late-idempotent", true))),
      binding("late-idempotent", true),
      holdId,
    );
    if (uncertain.kind !== "promote_mutation_indeterminate") throw new Error("promotion failed");
    expect(() =>
      recordJournalTerminal(uncertain.record, {
        status: "completed",
        payloadRetained: true,
        payload: {},
      }),
    ).toThrow(/requires resultDigest/);
    const late = recordJournalTerminal(uncertain.record, outcome);
    expect(recordJournalTerminal(late, structuredClone(outcome))).toBe(late);
    expect(() =>
      recordJournalTerminal(late, { ...outcome, resultDigest: `sha256:${"9".repeat(64)}` }),
    ).toThrow(/conflicting late terminal/);
  });
});
