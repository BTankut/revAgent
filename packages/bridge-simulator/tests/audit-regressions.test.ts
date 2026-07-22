import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AddinLoopbackFixture, type JsonObject } from "@revagent/addin-loopback-fixture";
import {
  acceptInboundData,
  canonicalizeJson,
  createRbpSequenceState,
  dataEnvelopeImmutableDigest,
  makeBatchDigest,
  makeIdempotencyKey,
  makeParamsDigest,
  type DataEnvelopeSnapshot,
  type InvocationJournalBinding,
  type InvokeBatchEnvelope,
  type JsonValue,
} from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { InjectedBridgeCrash } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import {
  atomicBatch,
  readInvoke,
  simulatorForFixture,
  temporaryRoot,
  uuid,
} from "./helpers.js";

function digestBatch(input: {
  readonly atomic: boolean;
  readonly batchId: string;
  readonly timeoutMs: number;
  readonly steps: InvokeBatchEnvelope["payload"]["steps"];
}): string {
  return makeBatchDigest({
    atomic: input.atomic,
    batch_id: input.batchId,
    recovery_clearances: [],
    steps: input.steps.map((step) => ({
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope as unknown as JsonValue,
      params_digest: step.params_digest,
      policy: step.policy,
    })),
    timeout_ms: input.timeoutMs,
  });
}

function nonAtomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const base = atomicBatch(rsid, seq);
  return {
    ...base,
    payload: {
      ...base.payload,
      atomic: false,
      batch_digest: digestBatch({
        atomic: false,
        batchId: base.payload.batch_id,
        timeoutMs: base.payload.timeout_ms,
        steps: base.payload.steps,
      }),
    },
  };
}

function twoMutationAtomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const batchId = uuid();
  // Deliberately reverse lexical order. Recovery must preserve the wire/input
  // order instead of accidentally sorting invocation identifiers.
  const invocationIds = [
    "0197a3c2-0000-7000-8000-999999999999",
    "0197a3c2-0000-7000-8000-000000000001",
  ] as const;
  const params = [
    { viewId: 71, mode: "commit", confirmDelete: true, viewType: "ThreeD" },
    { viewId: 72, mode: "commit", confirmDelete: true, viewType: "ThreeD" },
  ] as const;
  const step = (index: 0 | 1): InvokeBatchEnvelope["payload"]["steps"][number] => ({
    invocation_id: invocationIds[index],
    method: "delete_review_view",
    params: params[index] as JsonValue,
    params_digest: makeParamsDigest(params[index] as JsonValue),
    mutating: true,
    mutation_scope: { kind: "document", document_id: "doc-ordered-hold" },
    policy: { class: "confirm", decision: "confirmed", confirmation_id: "ordered-hold-test" },
  });
  const steps: InvokeBatchEnvelope["payload"]["steps"] = [step(0), step(1)];
  const timeoutMs = 5_000;
  return {
    v: 1,
    type: "invoke_batch",
    id: uuid(),
    rsid,
    seq,
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      batch_id: batchId,
      atomic: true,
      timeout_ms: timeoutMs,
      recovery_clearances: [],
      steps,
      batch_digest: digestBatch({ atomic: true, batchId, timeoutMs, steps }),
    },
  };
}

function seedInterruptedNonAtomicRead(
  journal: DurableBridgeJournal,
  envelope: InvokeBatchEnvelope,
): void {
  const sequence = acceptInboundData(
    createRbpSequenceState(envelope.rsid),
    envelope as unknown as DataEnvelopeSnapshot,
  );
  if (sequence.kind !== "accepted") throw new Error(`test sequence setup failed: ${sequence.kind}`);
  journal.saveSequence(sequence.state);
  const bindingStatus = journal.acceptBatchBinding({
    batchId: envelope.payload.batch_id,
    rsid: envelope.rsid,
    batchDigest: envelope.payload.batch_digest,
    bindingJson: canonicalizeJson(envelope.payload as unknown as JsonValue),
  });
  if (bindingStatus !== "accepted") throw new Error(`test batch setup failed: ${bindingStatus}`);
  const bindings: InvocationJournalBinding[] = envelope.payload.steps.map((step, batchIndex) => ({
    rsid: envelope.rsid,
    invocationId: step.invocation_id,
    method: step.method,
    mutating: step.mutating,
    mutationScope: structuredClone(step.mutation_scope),
    paramsDigest: step.params_digest,
    policy: structuredClone(step.policy),
    verification: null,
    recoveryClearances: [],
    batchId: envelope.payload.batch_id,
    batchIndex,
    batchDigest: envelope.payload.batch_digest,
  }));
  const accepted = journal.acceptBatchInvocations({
    bindings,
    recoveryClearances: [],
    dispatchIdentity: dataEnvelopeImmutableDigest(envelope as unknown as DataEnvelopeSnapshot),
    atomic: false,
  });
  if (accepted.kind !== "accepted") throw new Error(`test invocation setup failed: ${accepted.kind}`);
  const first = envelope.payload.steps[0];
  if (first === undefined) throw new Error("test batch omitted first step");
  journal.markExecuting(envelope.rsid, first.invocation_id);
}

describe("W1 bridge/journal/artifact audit regressions", () => {
  const fixtures: AddinLoopbackFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.stop();
  });

  it("durably terminalizes window=1 rejections so neither invoke nor batch executes later", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const occupying = readInvoke({ rsid, seq: 1 });
    fixture.planFault(occupying.payload.invocation_id, { delayMs: 150 });

    const inFlight = simulator.invoke(occupying);
    const rejectedInvoke = readInvoke({ rsid, seq: 2 });
    const invokeRejection = await simulator.invoke(rejectedInvoke);
    expect(invokeRejection).toMatchObject({ kind: "error", faultClass: "protocol", replayed: false });
    expect(journal.getInvocation(rsid, rejectedInvoke.payload.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: { status: "failed" },
    });

    const rejectedBatch = nonAtomicBatch(rsid, 3);
    const batchRejection = await simulator.invokeBatch(rejectedBatch);
    expect(batchRejection).toMatchObject({ kind: "error", faultClass: "protocol" });
    for (const step of rejectedBatch.payload.steps) {
      expect(journal.getInvocation(rsid, step.invocation_id)).toMatchObject({
        state: "failed",
        terminalOutcome: { status: "failed" },
      });
    }
    await expect(inFlight).resolves.toMatchObject({ kind: "result", status: "completed" });

    await expect(simulator.invoke(rejectedInvoke)).resolves.toMatchObject({
      kind: "error",
      faultClass: "protocol",
      replayed: true,
      addinContacted: false,
    });
    await expect(simulator.invokeBatch(rejectedBatch)).resolves.toMatchObject({
      kind: "error",
      faultClass: "protocol",
      replayed: true,
    });
    expect(fixture.getExecutionCount(rejectedInvoke.payload.invocation_id)).toBe(0);
    expect(fixture.getExecutionCount(rejectedBatch.payload.batch_id)).toBe(0);
    for (const step of rejectedBatch.payload.steps) {
      expect(fixture.getExecutionCount(step.invocation_id)).toBe(0);
    }

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("keeps atomic:false successors received and claims them only after a recovered read completes", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const envelope = nonAtomicBatch(rsid, 1);
    const journalPath = join(root.path, "recoverable-non-atomic.db");
    const seeded = new DurableBridgeJournal(journalPath);
    seedInterruptedNonAtomicRead(seeded, envelope);
    const firstStep = envelope.payload.steps[0];
    const successor = envelope.payload.steps[1];
    if (firstStep === undefined || successor === undefined) throw new Error("test batch requires two steps");
    expect(seeded.getInvocation(rsid, firstStep.invocation_id)?.state).toBe("executing");
    expect(seeded.getInvocation(rsid, successor.invocation_id)).toMatchObject({
      state: "received",
      dispatchMayHaveStarted: false,
      terminalOutcome: null,
    });
    seeded.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-restarted",
    });
    const recovered = await restarted.simulator.invokeBatch(envelope);
    expect(recovered).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "not_applicable",
      failedStepIndex: null,
      replayed: false,
      steps: [
        { kind: "result", status: "completed", addinContacted: true },
        { kind: "result", status: "completed", addinContacted: true },
      ],
    });
    expect(fixture.getExecutionCount(firstStep.invocation_id)).toBe(1);
    expect(fixture.getExecutionCount(successor.invocation_id)).toBe(1);
    expect(restarted.journal.getInvocation(rsid, firstStep.invocation_id)?.state).toBe("completed");
    expect(restarted.journal.getInvocation(rsid, successor.invocation_id)?.state).toBe("completed");
    expect(
      restarted.journal.durabilityEvents().filter((event) => event.action === "claim_batch_successor"),
    ).toHaveLength(1);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("recovers a durable atomic dispatch marker as one indeterminate input-ordered hold", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const envelope = twoMutationAtomicBatch(rsid, 1);
    const journalPath = join(root.path, "atomic-dispatch.db");
    const first = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-first",
    });
    await expect(first.simulator.invokeBatch(envelope, {
      crashAt: "after_executing_before_addin_write",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(first.journal.getBatchCoordination(envelope.payload.batch_id)?.state).toBe("dispatched");
    expect(first.journal.durabilityEvents().some((event) => event.action === "atomic_batch_dispatch_owned")).toBe(true);
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-restarted",
    });
    expect(restarted.journal.getBatchCoordination(envelope.payload.batch_id)?.state).toBe("indeterminate");
    const expectedOrigins = envelope.payload.steps.map((step) =>
      makeIdempotencyKey(rsid, step.invocation_id),
    );
    expect(restarted.journal.listHolds()).toHaveLength(1);
    expect(restarted.journal.listHolds()[0]?.originIdempotencyKeys).toEqual(expectedOrigins);
    for (const step of envelope.payload.steps) {
      expect(restarted.journal.getInvocation(rsid, step.invocation_id)?.state).toBe("indeterminate");
    }
    const redelivery = await restarted.simulator.invokeBatch(envelope);
    expect(redelivery).toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    expect(fixture.getExecutionCount(envelope.payload.batch_id)).toBe(0);
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(0);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("rejects an impossible atomic effect matrix even when every top-level correlation field matches", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = atomicBatch(rsid, 1);
    const session = simulator.getSession(rsid);
    if (session === null) throw new Error("test session was not attached");
    const rows = envelope.payload.steps.map((step, index): JsonObject => ({
      index,
      invocationId: step.invocation_id,
      method: step.method,
      executionState: "completed",
      // The mutating row deliberately lies about its committed effect.
      effectState: "read_only",
      result: { success: true, index },
    }));
    const malformedResult: JsonObject = {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId: envelope.payload.batch_id,
      batchDigest: envelope.payload.batch_digest,
      atomic: true,
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      rollback: {
        attempted: false,
        succeeded: null,
        triggerStepIndex: null,
        triggerState: null,
      },
      steps: rows,
    };
    const message: JsonObject = {
      jsonrpc: "2.0",
      id: envelope.payload.batch_id,
      result: malformedResult,
    };
    Object.defineProperty(session.probe.client, "request", {
      configurable: true,
      value: async () => ({ message, payload: Buffer.from(JSON.stringify(message), "utf8") }),
    });

    const rejected = await simulator.invokeBatch(envelope);
    expect(rejected).toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    const mutation = envelope.payload.steps.find((step) => step.mutating);
    if (mutation === undefined) throw new Error("test batch omitted mutation");
    expect(journal.getInvocation(rsid, mutation.invocation_id)?.state).toBe("indeterminate");
    expect(journal.listHolds()).toHaveLength(1);
    expect(fixture.getExecutionCount(envelope.payload.batch_id)).toBe(0);
    await expect(simulator.invokeBatch(envelope)).resolves.toMatchObject({
      kind: "batch",
      status: "indeterminate",
      replayed: true,
    });

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("rejects an impossible atomic artifact path without retaining or returning the raw path", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = atomicBatch(rsid, 1);
    const session = simulator.getSession(rsid);
    if (session === null) throw new Error("test session was not attached");
    const secretPath = "C:\\ProgramData\\DPE\\revAgent\\spool\\atomic-secret.xlsx";
    const rows = envelope.payload.steps.map((step, index): JsonObject => ({
      index,
      invocationId: step.invocation_id,
      method: step.method,
      executionState: "completed",
      effectState: step.mutating ? "committed" : "read_only",
      result: index === 0
        ? { files: [{ path: secretPath, contentType: "application/octet-stream" }] }
        : { success: true },
    }));
    const malformedResult: JsonObject = {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId: envelope.payload.batch_id,
      batchDigest: envelope.payload.batch_digest,
      atomic: true,
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      rollback: {
        attempted: false,
        succeeded: null,
        triggerStepIndex: null,
        triggerState: null,
      },
      steps: rows,
    };
    const message: JsonObject = {
      jsonrpc: "2.0",
      id: envelope.payload.batch_id,
      result: malformedResult,
    };
    Object.defineProperty(session.probe.client, "request", {
      configurable: true,
      value: async () => ({ message, payload: Buffer.from(JSON.stringify(message), "utf8") }),
    });

    const rejected = await simulator.invokeBatch(envelope);
    expect(rejected).toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    expect(JSON.stringify(rejected)).not.toContain(secretPath);
    expect(JSON.stringify(journal.listInvocations())).not.toContain(secretPath);
    expect(JSON.stringify(journal.getBatchCoordination(envelope.payload.batch_id))).not.toContain(secretPath);
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(0);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("preserves the exact raw result digest across terminal replay", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1, method: "fixture_counter" });

    const first = await simulator.invoke(envelope);
    expect(first).toMatchObject({ kind: "result", replayed: false });
    if (first.kind !== "result") throw new Error("test invocation did not complete");
    const durableDigest = journal.getInvocation(rsid, envelope.payload.invocation_id)
      ?.terminalOutcome?.resultDigest;
    expect(durableDigest).toBe(first.resultDigest);
    const replay = await simulator.invoke(envelope);
    expect(replay).toMatchObject({ kind: "result", replayed: true, addinContacted: false });
    if (replay.kind !== "result") throw new Error("test replay did not return a result");
    expect(replay.resultDigest).toBe(first.resultDigest);
    expect(replay.resultDigest).toBe(durableDigest);
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(1);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("validates and spools declared paths before completion and never replays the raw source path", async () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    const unsafePath = join(root.path, "operator-secret.txt");
    writeFileSync(unsafePath, "must never leave the add-in boundary\n", "utf8");
    let declaredPath = unsafePath;
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_path_output", "read_only", () => ({
      state: "completed",
      result: {
        files: [{ path: declaredPath, contentType: "text/plain" }],
      },
    }));
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });

    const unsafe = readInvoke({ rsid, seq: 1, method: "fixture_path_output" });
    const rejected = await simulator.invoke(unsafe);
    expect(rejected).toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: false,
      addinContacted: true,
    });
    const rejectedRecord = journal.getInvocation(rsid, unsafe.payload.invocation_id);
    expect(rejectedRecord).toMatchObject({ state: "failed", terminalOutcome: { status: "failed" } });
    expect(JSON.stringify(rejectedRecord?.terminalOutcome)).not.toContain(unsafePath);
    expect(existsSync(join(spoolRoot, unsafe.payload.invocation_id))).toBe(false);
    await expect(simulator.invoke(unsafe)).resolves.toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: true,
      addinContacted: false,
    });

    const missingPath = join(spoolRoot, "operator-secret-missing.txt");
    declaredPath = missingPath;
    const missing = readInvoke({ rsid, seq: 2, method: "fixture_path_output" });
    const missingRejected = await simulator.invoke(missing);
    expect(missingRejected).toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: false,
      addinContacted: true,
      message: "declared artifact source could not be captured",
    });
    expect(JSON.stringify(missingRejected)).not.toContain(missingPath);
    const missingRecord = journal.getInvocation(rsid, missing.payload.invocation_id);
    expect(missingRecord).toMatchObject({ state: "failed", terminalOutcome: { status: "failed" } });
    expect(JSON.stringify(missingRecord?.terminalOutcome)).not.toContain(missingPath);
    await expect(simulator.invoke(missing)).resolves.toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: true,
      addinContacted: false,
      message: "declared artifact source could not be captured",
    });

    const safePath = join(spoolRoot, "fixture-source.txt");
    writeFileSync(safePath, "safe fixture evidence\n", "utf8");
    declaredPath = safePath;
    const safe = readInvoke({ rsid, seq: 3, method: "fixture_path_output" });
    const completed = await simulator.invoke(safe);
    expect(completed).toMatchObject({
      kind: "result",
      status: "completed",
      replayed: false,
      artifactCarrier: { invocationId: safe.payload.invocation_id },
    });
    if (completed.kind !== "result" || completed.artifactCarrier === null) {
      throw new Error("safe declared artifact was not retained");
    }
    expect(completed.artifactCarrier.retainedFiles.every((path) => existsSync(path))).toBe(true);
    const safeRecord = journal.getInvocation(rsid, safe.payload.invocation_id);
    expect(safeRecord?.state).toBe("completed");
    expect(JSON.stringify(safeRecord?.terminalOutcome)).not.toContain(safePath);
    const replay = await simulator.invoke(safe);
    expect(replay).toMatchObject({
      kind: "result",
      status: "completed",
      replayed: true,
      addinContacted: false,
    });
    expect(JSON.stringify(replay)).not.toContain(safePath);
    expect(fixture.getExecutionCount(safe.payload.invocation_id)).toBe(1);

    simulator.close();
    journal.close();
    root.cleanup();
  });
});
