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
  validateRbpEnvelope,
  type CancelEnvelope,
  type DataEnvelopeSnapshot,
  type HelloAckEnvelope,
  type InvocationJournalBinding,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type JsonValue,
  type RbpEnvelope,
} from "@revagent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator, InjectedBridgeCrash } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import {
  BridgeGatewayPeer as RuntimeBridgeGatewayPeer,
  type BridgeGatewayPeerOptions,
} from "../src/peer.js";
import type { GatewayBinding } from "../src/transport.js";
import {
  atomicBatch,
  mutationInvoke,
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

function threeStepNonAtomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const base = nonAtomicBatch(rsid, seq);
  const thirdParams = {};
  const steps: InvokeBatchEnvelope["payload"]["steps"] = [
    ...base.payload.steps,
    {
      invocation_id: uuid(),
      method: "get_current_view_info",
      params: thirdParams,
      params_digest: makeParamsDigest(thirdParams),
      mutating: false,
      mutation_scope: null,
      policy: { class: "auto", decision: "auto", confirmation_id: null },
    },
  ];
  return {
    ...base,
    payload: {
      ...base.payload,
      steps,
      batch_digest: digestBatch({
        atomic: false,
        batchId: base.payload.batch_id,
        timeoutMs: base.payload.timeout_ms,
        steps,
      }),
    },
  };
}

function mutationFirstNonAtomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const base = nonAtomicBatch(rsid, seq);
  const first = base.payload.steps[0];
  const second = base.payload.steps[1];
  if (first === undefined || second === undefined) throw new Error("test batch requires two steps");
  const steps: InvokeBatchEnvelope["payload"]["steps"] = [second, first];
  return {
    ...base,
    payload: {
      ...base.payload,
      steps,
      batch_digest: digestBatch({
        atomic: false,
        batchId: base.payload.batch_id,
        timeoutMs: base.payload.timeout_ms,
        steps,
      }),
    },
  };
}

function logicalRedelivery<T extends { readonly id: string; readonly seq: number }>(
  envelope: T,
  seq: number,
): T {
  return {
    ...structuredClone(envelope),
    id: uuid(),
    seq,
  };
}

function cancellationFor(
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
  invocationId: string,
  seq: number,
): CancelEnvelope {
  return {
    v: 1,
    type: "cancel",
    id: uuid(),
    rsid: envelope.rsid,
    seq,
    ts: "2026-07-22T00:00:01.000Z",
    payload: { invocation_id: invocationId, reason: "user_requested" },
  };
}

function standaloneBinding(envelope: InvokeEnvelope): InvocationJournalBinding {
  return {
    rsid: envelope.rsid,
    invocationId: envelope.payload.invocation_id,
    method: envelope.payload.method,
    mutating: envelope.payload.mutating,
    mutationScope: structuredClone(envelope.payload.mutation_scope),
    paramsDigest: makeParamsDigest(envelope.payload.params as JsonValue),
    policy: structuredClone(envelope.payload.policy),
    verification: structuredClone(envelope.payload.verification),
    recoveryClearances: structuredClone(envelope.payload.recovery_clearances),
  };
}

function auditHelloAck(connectionId: string): HelloAckEnvelope {
  return {
    type: "hello_ack",
    id: uuid(),
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      protocol: 1,
      connection_id: connectionId,
      granted_capabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "transport_streamable_http",
      ],
      heartbeat_interval_ms: 15_000,
      limits: {
        max_params_bytes: 4_194_304,
        max_result_bytes: 33_554_432,
        max_partial_bytes: 1_048_576,
      },
      manifest: {
        latest_bridge_version: "bridge-audit-test",
        manifest_url: "/bridge/update/manifest",
      },
    },
  };
}

class AuditGatewayBinding implements GatewayBinding {
  public readonly kind = "wss" as const;
  public readonly bufferedAmount = 0;
  public readonly sent: RbpEnvelope[] = [];

  public constructor(public readonly connectionId: string) {}

  public async open(): Promise<HelloAckEnvelope> {
    return auditHelloAck(this.connectionId);
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    this.sent.push(structuredClone(envelope));
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        return;
      },
    };
  }

  public async close(): Promise<void> {
    return;
  }
}

/** These audit fixtures model a connection whose session handshake already completed. */
class BridgeGatewayPeer extends RuntimeBridgeGatewayPeer {
  public constructor(
    simulator: BridgeSimulator,
    binding: GatewayBinding,
    ack: HelloAckEnvelope,
    options: BridgeGatewayPeerOptions = {},
  ) {
    super(simulator, binding, ack, {
      ...options,
      unsafeAssumeCurrentBindingForTests: true,
    });
  }
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

function twoMutationNonAtomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const base = twoMutationAtomicBatch(rsid, seq);
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

    await expect(simulator.invoke(logicalRedelivery(rejectedInvoke, 4))).resolves.toMatchObject({
      kind: "error",
      faultClass: "protocol",
      replayed: true,
      addinContacted: false,
    });
    await expect(simulator.invokeBatch(logicalRedelivery(rejectedBatch, 5))).resolves.toMatchObject({
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
    const recovered = await restarted.simulator.invokeBatch(logicalRedelivery(envelope, 2));
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
    const redelivery = await restarted.simulator.invokeBatch(logicalRedelivery(envelope, 2));
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
    await expect(simulator.invokeBatch(logicalRedelivery(envelope, 2))).resolves.toMatchObject({
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
    const replay = await simulator.invoke(logicalRedelivery(envelope, 2));
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
    await expect(simulator.invoke(logicalRedelivery(unsafe, 2))).resolves.toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: true,
      addinContacted: false,
    });

    const missingPath = join(spoolRoot, "operator-secret-missing.txt");
    declaredPath = missingPath;
    const missing = readInvoke({ rsid, seq: 3, method: "fixture_path_output" });
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
    await expect(simulator.invoke(logicalRedelivery(missing, 4))).resolves.toMatchObject({
      kind: "error",
      faultClass: "parameter",
      replayed: true,
      addinContacted: false,
      message: "declared artifact source could not be captured",
    });

    const safePath = join(spoolRoot, "fixture-source.txt");
    writeFileSync(safePath, "safe fixture evidence\n", "utf8");
    declaredPath = safePath;
    const safe = readInvoke({ rsid, seq: 5, method: "fixture_path_output" });
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
    const replay = await simulator.invoke(logicalRedelivery(safe, 6));
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

  it("keeps an in-flight mutation authoritative across a fresh-seq binding mismatch", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "standalone-binding-mismatch.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const original = mutationInvoke({ rsid, seq: 1 });
    fixture.planFault(original.payload.invocation_id, { stall: true });

    const executing = first.simulator.invoke(original);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(original.payload.invocation_id)).toBe(1);
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    });
    const redelivery = logicalRedelivery(original, 2);
    const mismatch: InvokeEnvelope = {
      ...redelivery,
      payload: { ...redelivery.payload, params: { fixture: false } },
    };

    await expect(first.simulator.invoke(mismatch)).resolves.toMatchObject({
      kind: "error",
      faultClass: "protocol",
      replayed: false,
      addinContacted: false,
    });
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({
      state: "reply_ready",
      correlationId: original.payload.invocation_id,
    });
    expect(fixture.releaseStall(original.payload.invocation_id)).toBe(true);
    await expect(executing).resolves.toMatchObject({
      kind: "result",
      status: "completed",
      replayed: false,
      addinContacted: true,
    });
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "reply_ready" });
    expect(first.journal.getInvocation(rsid, original.payload.invocation_id)).toMatchObject({
      state: "completed",
      terminalOutcome: { status: "completed" },
    });
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "standalone-binding-mismatch-restarted",
    });
    expect(restarted.simulator.recoverableInboundReplies()).toMatchObject([{
      seq: 1,
      type: "invoke",
      correlationId: original.payload.invocation_id,
      outcome: {
        kind: "result",
        status: "completed",
        replayed: true,
        addinContacted: false,
      },
    }, {
      seq: 2,
      type: "invoke",
      correlationId: original.payload.invocation_id,
      outcome: {
        kind: "error",
        faultClass: "protocol",
        replayed: true,
        addinContacted: false,
      },
    }]);
    expect(fixture.getExecutionCount(original.payload.invocation_id)).toBe(1);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it.each(["atomic", "non_atomic"] as const)(
    "keeps an in-flight %s batch authoritative across a fresh-seq binding mismatch",
    async (kind) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const journalPath = join(root.path, `${kind}-batch-binding-mismatch.db`);
      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      const original = kind === "atomic" ? atomicBatch(rsid, 1) : nonAtomicBatch(rsid, 1);
      const stallId = kind === "atomic"
        ? original.payload.batch_id
        : original.payload.steps[0]?.invocation_id;
      if (stallId === undefined) throw new Error("batch mismatch test omitted its stall identity");
      fixture.planFault(stallId, { stall: true });

      const executing = first.simulator.invokeBatch(original);
      await vi.waitFor(() => {
        expect(fixture.getPendingStallCount(stallId)).toBe(1);
        expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
      });
      const redelivery = logicalRedelivery(original, 2);
      const changedTimeoutMs = redelivery.payload.timeout_ms + 1;
      const mismatch: InvokeBatchEnvelope = {
        ...redelivery,
        payload: {
          ...redelivery.payload,
          timeout_ms: changedTimeoutMs,
          batch_digest: digestBatch({
            atomic: redelivery.payload.atomic,
            batchId: redelivery.payload.batch_id,
            timeoutMs: changedTimeoutMs,
            steps: redelivery.payload.steps,
          }),
        },
      };

      await expect(first.simulator.invokeBatch(mismatch)).resolves.toMatchObject({
        kind: "error",
        batchId: original.payload.batch_id,
        faultClass: "protocol",
      });
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
      expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({
        state: "reply_ready",
        correlationId: original.payload.batch_id,
      });
      expect(fixture.releaseStall(stallId)).toBe(true);
      await expect(executing).resolves.toMatchObject({
        kind: "batch",
        status: "completed",
        transactionState: kind === "atomic" ? "committed" : "not_applicable",
      });
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
      expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "reply_ready" });
      first.simulator.close();
      first.journal.close();

      const restarted = await simulatorForFixture({
        fixture,
        root: root.path,
        rsid,
        journalPath,
        spoolName: `${kind}-batch-binding-mismatch-restarted`,
      });
      expect(restarted.simulator.recoverableInboundReplies()).toMatchObject([{
        seq: 1,
        type: "invoke_batch",
        correlationId: original.payload.batch_id,
        outcome: {
          kind: "batch",
          status: "completed",
          transactionState: kind === "atomic" ? "committed" : "not_applicable",
          replayed: true,
        },
      }, {
        seq: 2,
        type: "invoke_batch",
        correlationId: original.payload.batch_id,
        outcome: {
          kind: "error",
          batchId: original.payload.batch_id,
          faultClass: "protocol",
          replayed: true,
        },
      }]);
      if (kind === "atomic") expect(fixture.getExecutionCount(original.payload.batch_id)).toBe(1);
      else {
        for (const step of original.payload.steps) {
          expect(fixture.getExecutionCount(step.invocation_id)).toBe(1);
        }
      }

      restarted.simulator.close();
      restarted.journal.close();
      root.cleanup();
    },
  );

  it("coalesces a live same-binding atomic redelivery without emitting a second peer reply", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "live-atomic-redelivery.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const batch = atomicBatch(rsid, 1);
    fixture.planFault(batch.payload.batch_id, { stall: true });
    const binding = new AuditGatewayBinding("live-atomic-redelivery");
    const peer = new BridgeGatewayPeer(
      first.simulator,
      binding,
      auditHelloAck(binding.connectionId),
      { idFactory: uuid },
    );

    const original = peer.handleInbound(batch);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(batch.payload.batch_id)).toBe(1);
      expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
        state: "dispatched",
        terminalJson: null,
      });
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    });

    await peer.handleInbound(logicalRedelivery(batch, 2));
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
    expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "dispatched",
      terminalJson: null,
    });
    expect(first.journal.listHolds()).toEqual([]);
    expect(first.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(binding.sent).toEqual([]);

    expect(fixture.releaseStall(batch.payload.batch_id)).toBe(true);
    await original;
    expect(binding.sent).toHaveLength(1);
    const emitted = binding.sent[0];
    expect(emitted).toBeDefined();
    expect(validateRbpEnvelope(emitted as RbpEnvelope)).toBe(true);
    expect(emitted).toMatchObject({
      type: "result",
      rsid,
      ack: 2,
      payload: {
        kind: "batch",
        batch_id: batch.payload.batch_id,
        atomic: true,
        status: "completed",
        transaction_state: "committed",
        failed_step_index: null,
      },
    });
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "delivery_ready" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    await peer.close();
    first.journal.close();
    root.cleanup();
  });

  it("supersedes seq=1 crash work after fresh-seq invoke and batch redelivery terminals", async () => {
    const invokeRoot = temporaryRoot();
    const invokeFixture = new AddinLoopbackFixture();
    fixtures.push(invokeFixture);
    await invokeFixture.start();
    const invokeRsid = uuid();
    const invokeJournalPath = join(invokeRoot.path, "invoke-superseded.db");
    const invokeFirst = await simulatorForFixture({
      fixture: invokeFixture,
      root: invokeRoot.path,
      rsid: invokeRsid,
      journalPath: invokeJournalPath,
    });
    const invocation = readInvoke({ rsid: invokeRsid, seq: 1 });
    await expect(invokeFirst.simulator.invoke(invocation, {
      crashAt: "after_received_before_dispatch",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(invokeFirst.journal.getInboundWork(invokeRsid, 1)).toMatchObject({ state: "journaled" });

    await expect(invokeFirst.simulator.invoke(logicalRedelivery(invocation, 2))).resolves.toMatchObject({
      kind: "result",
      status: "completed",
      replayed: false,
    });
    expect(invokeFirst.journal.getInboundWork(invokeRsid, 1)).toMatchObject({ state: "no_reply" });
    expect(invokeFirst.journal.getInboundWork(invokeRsid, 2)).toMatchObject({ state: "reply_ready" });
    invokeFirst.simulator.close();
    invokeFirst.journal.close();

    const invokeRestarted = await simulatorForFixture({
      fixture: invokeFixture,
      root: invokeRoot.path,
      rsid: invokeRsid,
      journalPath: invokeJournalPath,
      spoolName: "invoke-superseded-restarted",
    });
    expect(invokeRestarted.simulator.recoverableInboundReplies().map((entry) => entry.seq)).toEqual([2]);
    expect(invokeRestarted.simulator.recoverableInboundReplies()[0]?.outcome).toMatchObject({
      kind: "result",
      status: "completed",
      replayed: true,
      addinContacted: false,
    });
    expect(invokeFixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    invokeRestarted.simulator.close();
    invokeRestarted.journal.close();
    invokeRoot.cleanup();

    const batchRoot = temporaryRoot();
    const batchFixture = new AddinLoopbackFixture();
    fixtures.push(batchFixture);
    await batchFixture.start();
    const batchRsid = uuid();
    const batchJournalPath = join(batchRoot.path, "batch-superseded.db");
    const batchFirst = await simulatorForFixture({
      fixture: batchFixture,
      root: batchRoot.path,
      rsid: batchRsid,
      journalPath: batchJournalPath,
    });
    const batch = atomicBatch(batchRsid, 1);
    await expect(batchFirst.simulator.invokeBatch(batch, {
      crashAt: "after_received_before_dispatch",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(batchFirst.journal.getInboundWork(batchRsid, 1)).toMatchObject({ state: "journaled" });

    await expect(batchFirst.simulator.invokeBatch(logicalRedelivery(batch, 2))).resolves.toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: false,
    });
    expect(batchFirst.journal.getInboundWork(batchRsid, 1)).toMatchObject({ state: "no_reply" });
    expect(batchFirst.journal.getInboundWork(batchRsid, 2)).toMatchObject({ state: "reply_ready" });
    batchFirst.simulator.close();
    batchFirst.journal.close();

    const batchRestarted = await simulatorForFixture({
      fixture: batchFixture,
      root: batchRoot.path,
      rsid: batchRsid,
      journalPath: batchJournalPath,
      spoolName: "batch-superseded-restarted",
    });
    expect(batchRestarted.simulator.recoverableInboundReplies().map((entry) => entry.seq)).toEqual([2]);
    expect(batchRestarted.simulator.recoverableInboundReplies()[0]?.outcome).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: true,
    });
    expect(batchFixture.getExecutionCount(batch.payload.batch_id)).toBe(1);
    batchRestarted.simulator.close();
    batchRestarted.journal.close();
    batchRoot.cleanup();
  });

  it("reconstructs a fully determined non-atomic terminal prefix during restart", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", () => ({
      files: [{
        fileName: "forbidden-inline-batch.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("inline-only-contract-violation", "utf8").toString("base64"),
      }],
    }));
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "non-atomic-terminal-reconstruction.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const batch = nonAtomicBatch(rsid, 1);

    await expect(first.simulator.invokeBatch(batch, {
      crashAt: "after_non_atomic_step_terminal_before_batch_terminal",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    for (const step of batch.payload.steps) {
      expect(first.journal.getInvocation(rsid, step.invocation_id)?.terminalOutcome).not.toBeNull();
    }
    expect(first.journal.getBatchTerminal(batch.payload.batch_id)).toBeNull();
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });

    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "non-atomic-terminal-reconstruction-restarted",
    });
    expect(restarted.simulator.recoverableInboundReplies()).toMatchObject([{
      seq: 1,
      type: "invoke_batch",
      correlationId: batch.payload.batch_id,
      outcome: {
        kind: "batch",
        status: "failed",
        transactionState: "not_applicable",
        failedStepIndex: 1,
        replayed: true,
      },
    }]);
    const durableTerminal = restarted.journal.getBatchTerminal(batch.payload.batch_id);
    expect(durableTerminal).not.toBeNull();
    expect(JSON.parse(durableTerminal as string)).toMatchObject({
      kind: "batch",
      batchId: batch.payload.batch_id,
      status: "failed",
      transactionState: "not_applicable",
      failedStepIndex: 1,
    });
    expect(restarted.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
    expect(restarted.journal.getInboundWork(rsid, 2)).toBeNull();
    expect(fixture.getExecutionCount(batch.payload.steps[0]?.invocation_id ?? "missing")).toBe(1);
    expect(fixture.getExecutionCount(batch.payload.steps[1]?.invocation_id ?? "missing")).toBe(1);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("preserves environment fault identity for a failed non-atomic read", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const batch = nonAtomicBatch(rsid, 1);
    const readStep = batch.payload.steps[0];
    if (readStep === undefined) throw new Error("environment replay test requires a read step");
    fixture.planFault(readStep.invocation_id, { disconnect: "before_dispatch" });

    await expect(simulator.invokeBatch(batch)).resolves.toMatchObject({
      kind: "batch",
      status: "failed",
      transactionState: "not_applicable",
      failedStepIndex: 0,
      steps: [
        { kind: "error", faultClass: "environment", retryable: true },
        { kind: "not_started" },
      ],
    });
    expect(journal.getInvocation(rsid, readStep.invocation_id)?.terminalOutcome).toMatchObject({
      status: "failed",
      payload: { fault_class: "environment" },
    });

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("returns indeterminate mutation evidence and materialized successors on live batch redelivery", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const batch = threeStepNonAtomicBatch(rsid, 1);
    const mutation = batch.payload.steps[1];
    if (mutation === undefined || !mutation.mutating) {
      throw new Error("live batch redelivery test requires a middle mutation");
    }
    fixture.planFault(mutation.invocation_id, { stall: true });

    const original = simulator.invokeBatch(batch);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(mutation.invocation_id)).toBe(1);
      expect(journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
        state: "executing",
        dispatchMayHaveStarted: true,
      });
    });

    const redelivery = await simulator.invokeBatch(logicalRedelivery(batch, 2));
    expect(redelivery).toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "not_applicable",
      failedStepIndex: 1,
      steps: [
        { kind: "result", status: "completed", replayed: true },
        { kind: "error", faultClass: "journal_indeterminate", outcome: "indeterminate" },
        { kind: "not_started", replayed: true },
      ],
    });
    expect(journal.getInboundWork(rsid, 2)).toMatchObject({ state: "reply_ready" });
    expect(journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    expect(journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
      state: "indeterminate",
      verificationHoldId: expect.stringMatching(/^vh:/u),
    });
    expect(fixture.releaseStall(mutation.invocation_id)).toBe(true);
    await expect(original).resolves.toMatchObject({
      kind: "batch",
      status: "completed",
      failedStepIndex: null,
    });
    expect(journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
    expect(fixture.getExecutionCount(batch.payload.steps[2]?.invocation_id ?? "missing")).toBe(1);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it.each(["read", "mutation"] as const)(
    "preserves a late-completed non-atomic mutation before its %s successor",
    async (successorKind) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const journalPath = join(root.path, `non-atomic-hold-race-${successorKind}.db`);
      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      const batch = successorKind === "read"
        ? mutationFirstNonAtomicBatch(rsid, 1)
        : twoMutationNonAtomicBatch(rsid, 1);
      const firstStep = batch.payload.steps[0];
      const successor = batch.payload.steps[1];
      if (firstStep === undefined || successor === undefined || !firstStep.mutating) {
        throw new Error("non-atomic hold race requires a mutating first step and one successor");
      }
      fixture.planFault(firstStep.invocation_id, { stall: true });

      const executing = first.simulator.invokeBatch(batch);
      await vi.waitFor(() => {
        expect(fixture.getPendingStallCount(firstStep.invocation_id)).toBe(1);
        expect(first.journal.getInvocation(rsid, firstStep.invocation_id)).toMatchObject({
          state: "executing",
          dispatchMayHaveStarted: true,
        });
        expect(first.journal.getInvocation(rsid, successor.invocation_id)).toMatchObject({
          state: "received",
          dispatchMayHaveStarted: false,
        });
      });

      await first.simulator.invokeBatch(logicalRedelivery(batch, 2));
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
      expect(first.journal.getInvocation(rsid, firstStep.invocation_id)).toMatchObject({
        state: "indeterminate",
        terminalOutcome: null,
        lateTerminalOutcome: null,
        verificationHoldId: expect.any(String),
      });
      expect(first.journal.getInvocation(rsid, successor.invocation_id)).toMatchObject({
        state: "received",
        dispatchMayHaveStarted: false,
        terminalOutcome: null,
      });
      expect(first.journal.listHolds()).toMatchObject([{
        state: "active",
        originIdempotencyKeys: [makeIdempotencyKey(rsid, firstStep.invocation_id)],
      }]);
      expect(fixture.getExecutionCount(successor.invocation_id)).toBe(0);

      expect(fixture.releaseStall(firstStep.invocation_id)).toBe(true);
      const visible = await executing;
      expect(visible).toMatchObject({
        kind: "batch",
        batchId: batch.payload.batch_id,
        status: successorKind === "read" ? "completed" : "indeterminate",
        transactionState: "not_applicable",
        failedStepIndex: successorKind === "read" ? null : 1,
      });
      expect(visible.steps?.[0]).toMatchObject({ kind: "result", status: "completed" });
      if (successorKind === "read") {
        expect(visible.steps?.[1]).toMatchObject({ kind: "result", status: "completed" });
        expect(first.journal.getInvocation(rsid, successor.invocation_id)).toMatchObject({
          state: "completed",
          terminalOutcome: { status: "completed" },
        });
        expect(fixture.getExecutionCount(successor.invocation_id)).toBe(1);
      } else {
        expect(visible.steps?.[1]).toMatchObject({
          kind: "error",
          faultClass: "journal_indeterminate",
          outcome: "indeterminate",
          addinContacted: false,
        });
        expect(first.journal.getInvocation(rsid, successor.invocation_id)).toMatchObject({
          state: "received",
          dispatchMayHaveStarted: false,
          terminalOutcome: null,
        });
        expect(fixture.getExecutionCount(successor.invocation_id)).toBe(0);
      }
      expect(first.journal.getInvocation(rsid, firstStep.invocation_id)).toMatchObject({
        state: "indeterminate",
        terminalOutcome: null,
        lateTerminalOutcome: { status: "completed" },
        verificationHoldId: expect.any(String),
      });
      if (successorKind === "read") {
        expect(first.journal.getBatchTerminal(batch.payload.batch_id)).not.toBeNull();
      } else {
        expect(first.journal.getBatchTerminal(batch.payload.batch_id)).toBeNull();
      }
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
      first.simulator.close();
      first.journal.close();

      const restarted = await simulatorForFixture({
        fixture,
        root: root.path,
        rsid,
        journalPath,
        spoolName: `non-atomic-hold-race-${successorKind}-restarted`,
      });
      expect(restarted.journal.getInvocation(rsid, firstStep.invocation_id)).toMatchObject({
        state: "indeterminate",
        terminalOutcome: null,
        lateTerminalOutcome: { status: "completed" },
        verificationHoldId: expect.any(String),
      });
      expect(restarted.journal.listHolds()).toHaveLength(1);
      const recovered = restarted.simulator.recoverableInboundReplies().find(
        (entry) => entry.seq === 1 && entry.correlationId === batch.payload.batch_id,
      );
      expect(recovered).toMatchObject({
        type: "invoke_batch",
        outcome: {
          kind: "batch",
          status: successorKind === "read" ? "completed" : "indeterminate",
          transactionState: "not_applicable",
          failedStepIndex: successorKind === "read" ? null : 1,
          replayed: true,
        },
      });
      expect(fixture.getExecutionCount(firstStep.invocation_id)).toBe(1);
      expect(fixture.getExecutionCount(successor.invocation_id)).toBe(successorKind === "read" ? 1 : 0);

      restarted.simulator.close();
      restarted.journal.close();
      root.cleanup();
    },
  );

  it("re-reads a still-received non-atomic successor cancelled while its predecessor is stalled", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "non-atomic-cancel-race.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const batch = threeStepNonAtomicBatch(rsid, 1);
    const firstStep = batch.payload.steps[0];
    const cancelledStep = batch.payload.steps[1];
    const laterStep = batch.payload.steps[2];
    if (firstStep === undefined || cancelledStep === undefined || laterStep === undefined) {
      throw new Error("non-atomic cancellation race requires three steps");
    }
    fixture.planFault(firstStep.invocation_id, { stall: true });

    const executing = first.simulator.invokeBatch(batch);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(firstStep.invocation_id)).toBe(1);
      expect(first.journal.getInvocation(rsid, cancelledStep.invocation_id)).toMatchObject({
        state: "received",
        dispatchMayHaveStarted: false,
      });
    });
    expect(first.simulator.cancelEnvelope(cancellationFor(batch, cancelledStep.invocation_id, 2))).toMatchObject({
      kind: "error",
      faultClass: "cancelled",
      replayed: false,
      addinContacted: false,
    });
    expect(first.journal.getInvocation(rsid, cancelledStep.invocation_id)).toMatchObject({
      state: "cancelled",
      dispatchMayHaveStarted: false,
      abandoned: false,
      terminalOutcome: { status: "cancelled" },
    });
    expect(fixture.releaseStall(firstStep.invocation_id)).toBe(true);

    const visible = await executing;
    expect(visible).toMatchObject({
      kind: "batch",
      status: "cancelled",
      transactionState: "not_applicable",
      failedStepIndex: 1,
      replayed: false,
    });
    expect(visible.steps?.[0]).toMatchObject({ kind: "result", status: "completed" });
    expect(visible.steps?.[1]).toMatchObject({
      kind: "error",
      faultClass: "cancelled",
      replayed: true,
      addinContacted: false,
    });
    expect(visible.steps?.[2]).toMatchObject({
      kind: "not_started",
      addinContacted: false,
    });
    expect(first.journal.getInvocation(rsid, laterStep.invocation_id)).toMatchObject({
      state: "received",
      dispatchMayHaveStarted: false,
      terminalOutcome: null,
    });
    expect(fixture.getExecutionCount(firstStep.invocation_id)).toBe(1);
    expect(fixture.getExecutionCount(cancelledStep.invocation_id)).toBe(0);
    expect(fixture.getExecutionCount(laterStep.invocation_id)).toBe(0);
    expect(first.journal.getBatchTerminal(batch.payload.batch_id)).not.toBeNull();
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "non-atomic-cancel-race-restarted",
    });
    const recoveredBatch = restarted.simulator.recoverableInboundReplies().find(
      (entry) => entry.type === "invoke_batch" && entry.correlationId === batch.payload.batch_id,
    );
    expect(recoveredBatch).toMatchObject({
      seq: 1,
      outcome: {
        kind: "batch",
        status: "cancelled",
        transactionState: "not_applicable",
        failedStepIndex: 1,
        replayed: true,
      },
    });
    expect((recoveredBatch?.outcome as { readonly steps?: readonly unknown[] }).steps?.[1]).toMatchObject({
      kind: "error",
      faultClass: "cancelled",
    });
    expect((recoveredBatch?.outcome as { readonly steps?: readonly unknown[] }).steps?.[2]).toMatchObject({
      kind: "not_started",
    });

    const replay = await restarted.simulator.invokeBatch(logicalRedelivery(batch, 3));
    expect(replay).toMatchObject({
      kind: "batch",
      status: "cancelled",
      transactionState: "not_applicable",
      failedStepIndex: 1,
      replayed: true,
    });
    expect(replay.steps?.[1]).toMatchObject({ kind: "error", faultClass: "cancelled" });
    expect(replay.steps?.[2]).toMatchObject({ kind: "not_started" });
    expect(fixture.getExecutionCount(firstStep.invocation_id)).toBe(1);
    expect(fixture.getExecutionCount(cancelledStep.invocation_id)).toBe(0);
    expect(fixture.getExecutionCount(laterStep.invocation_id)).toBe(0);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("replays a completed atomic batch on fresh seq without re-running atomic acceptance", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "completed-atomic-redelivery.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const batch = atomicBatch(rsid, 1);

    await expect(first.simulator.invokeBatch(batch)).resolves.toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: false,
    });
    const redelivered = await first.simulator.invokeBatch(logicalRedelivery(batch, 2));
    expect(redelivered).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: true,
    });
    expect(JSON.stringify(redelivered)).not.toContain("atomic_batch_not_safely_received");
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "no_reply" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "reply_ready" });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "completed-atomic-redelivery-restarted",
    });
    expect(restarted.simulator.recoverableInboundReplies()).toMatchObject([{
      seq: 2,
      outcome: {
        kind: "batch",
        status: "completed",
        transactionState: "committed",
        replayed: true,
      },
    }]);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("keeps abandoned atomic-step evidence while cancellation survives commit and rollback replay", async () => {
    const scenarios = [
      { name: "commit", transactionState: "committed", terminalStatus: "completed", rollBack: false },
      { name: "rollback", transactionState: "rolled_back", terminalStatus: "guarded", rollBack: true },
    ] as const;

    for (const scenario of scenarios) {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const journalPath = join(root.path, `cancel-atomic-${scenario.name}.db`);
      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      const batch = atomicBatch(rsid, 1);
      const target = batch.payload.steps[0];
      if (target === undefined) throw new Error("atomic cancellation test omitted its target step");
      fixture.planFault(batch.payload.batch_id, { delayMs: 100 });
      if (scenario.rollBack) fixture.planFault(target.invocation_id, { busy: true });

      const executing = first.simulator.invokeBatch(batch);
      await vi.waitFor(() => {
        expect(first.journal.getInvocation(rsid, target.invocation_id)).toMatchObject({
          state: "executing",
          dispatchMayHaveStarted: true,
        });
      });
      expect(first.simulator.cancelEnvelope(cancellationFor(batch, target.invocation_id, 2))).toBeNull();
      const visible = await executing;
      expect(visible).toMatchObject({
        kind: "batch",
        status: "cancelled",
        transactionState: scenario.transactionState,
        failedStepIndex: 0,
      });
      expect(visible.steps?.[0]).toMatchObject({
        kind: "error",
        faultClass: "cancelled",
        outcome: "known",
        addinContacted: true,
        effectState: "read_only",
      });
      expect(first.journal.getInvocation(rsid, target.invocation_id)).toMatchObject({
        abandoned: true,
        terminalOutcome: { status: scenario.terminalStatus },
      });
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
      expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
      first.simulator.close();
      first.journal.close();

      const restarted = await simulatorForFixture({
        fixture,
        root: root.path,
        rsid,
        journalPath,
        spoolName: `cancel-atomic-${scenario.name}-restarted`,
      });
      expect(restarted.simulator.recoverableInboundReplies()).toMatchObject([{
        seq: 1,
        outcome: {
          kind: "batch",
          status: "cancelled",
          transactionState: scenario.transactionState,
          steps: [{ kind: "error", faultClass: "cancelled" }, expect.anything()],
        },
      }]);
      const replay = await restarted.simulator.invokeBatch(logicalRedelivery(batch, 3));
      expect(replay).toMatchObject({
        kind: "batch",
        status: "cancelled",
        transactionState: scenario.transactionState,
        replayed: true,
      });
      expect(replay.steps?.[0]).toMatchObject({
        kind: "error",
        faultClass: "cancelled",
        effectState: "read_only",
      });
      expect(restarted.journal.getInvocation(rsid, target.invocation_id)).toMatchObject({
        abandoned: true,
        terminalOutcome: { status: scenario.terminalStatus },
      });
      expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

      restarted.simulator.close();
      restarted.journal.close();
      root.cleanup();
    }
  });

  it("keeps an atomic timeout provisional and durably replays its correlated late carrier", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "late-atomic-carrier.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const template = atomicBatch(rsid, 1);
    const timeoutMs = 25;
    const batch: InvokeBatchEnvelope = {
      ...template,
      payload: {
        ...template.payload,
        timeout_ms: timeoutMs,
        batch_digest: digestBatch({
          atomic: true,
          batchId: template.payload.batch_id,
          timeoutMs,
          steps: template.payload.steps,
        }),
      },
    };
    fixture.planFault(batch.payload.batch_id, { delayMs: 100 });

    const provisional = await first.simulator.invokeBatch(batch);
    expect(provisional).toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
      replayed: false,
    });
    expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "indeterminate",
      terminalJson: null,
    });
    expect(first.journal.getInvocation(rsid, batch.payload.steps[0]?.invocation_id as string)).toMatchObject({
      state: "executing",
      terminalOutcome: null,
    });
    const mutationId = batch.payload.steps[1]?.invocation_id;
    if (mutationId === undefined) throw new Error("late atomic test omitted its mutation");
    expect(first.journal.getInvocation(rsid, mutationId)).toMatchObject({
      state: "indeterminate",
      terminalOutcome: null,
      lateTerminalOutcome: null,
      verificationHoldId: expect.stringMatching(/^vh:/u),
    });

    await vi.waitFor(() => {
      expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
        state: "terminal",
        terminalJson: expect.any(String),
      });
    }, { timeout: 2_000 });
    expect(first.journal.getInvocation(rsid, mutationId)).toMatchObject({
      state: "indeterminate",
      lateTerminalOutcome: { status: "completed", resultDigest: expect.stringMatching(/^sha256:/u) },
      verificationHoldId: expect.stringMatching(/^vh:/u),
    });
    expect(first.journal.listHolds()).toMatchObject([{ state: "active" }]);

    const replay = await first.simulator.invokeBatch(logicalRedelivery(batch, 2));
    expect(replay).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: true,
      steps: [
        { kind: "result", replayed: true, lateAfterIndeterminate: false },
        {
          kind: "result",
          replayed: true,
          lateAfterIndeterminate: true,
          verificationHoldId: expect.stringMatching(/^vh:/u),
          resultDigest: expect.stringMatching(/^sha256:/u),
        },
      ],
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    first.simulator.close();
    first.journal.close();
    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "late-atomic-carrier-restarted",
    });
    await expect(restarted.simulator.invokeBatch(logicalRedelivery(batch, 3))).resolves.toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: true,
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    restarted.simulator.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("keeps an invalid atomic terminal carrier open instead of freezing synthetic read failures", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const first = await simulatorForFixture({ fixture, root: root.path, rsid });
    const batch = atomicBatch(rsid, 1);
    fixture.planFault(batch.payload.batch_id, { finalBatchResponseFault: "wire_omit_batch_digest" });

    await expect(first.simulator.invokeBatch(batch)).resolves.toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "indeterminate",
      terminalJson: null,
    });
    const readId = batch.payload.steps[0]?.invocation_id;
    if (readId === undefined) throw new Error("invalid atomic carrier test omitted its read");
    expect(first.journal.getInvocation(rsid, readId)).toMatchObject({
      state: "executing",
      terminalOutcome: null,
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    await expect(first.simulator.invokeBatch(logicalRedelivery(batch, 2))).resolves.toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
      replayed: true,
    });
    expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "indeterminate",
      terminalJson: null,
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    first.simulator.close();
    first.journal.close();
    root.cleanup();
  });

  it("suppresses a late atomic carrier behind cancellation while retaining exact durable evidence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const first = await simulatorForFixture({ fixture, root: root.path, rsid });
    const template = atomicBatch(rsid, 1);
    const timeoutMs = 25;
    const batch: InvokeBatchEnvelope = {
      ...template,
      payload: {
        ...template.payload,
        timeout_ms: timeoutMs,
        batch_digest: digestBatch({
          atomic: true,
          batchId: template.payload.batch_id,
          timeoutMs,
          steps: template.payload.steps,
        }),
      },
    };
    const mutation = batch.payload.steps[1];
    if (mutation === undefined) throw new Error("late cancellation test omitted its mutation");
    fixture.planFault(batch.payload.batch_id, { delayMs: 100 });

    const executing = first.simulator.invokeBatch(batch);
    await vi.waitFor(() => {
      expect(first.journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
        state: "executing",
        dispatchMayHaveStarted: true,
      });
    });
    expect(first.simulator.cancelEnvelope(cancellationFor(batch, mutation.invocation_id, 2))).toBeNull();
    await expect(executing).resolves.toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    await vi.waitFor(() => {
      expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
        state: "terminal",
        terminalJson: expect.any(String),
      });
    }, { timeout: 2_000 });

    const replay = await first.simulator.invokeBatch(logicalRedelivery(batch, 3));
    expect(replay).toMatchObject({
      kind: "batch",
      status: "cancelled",
      transactionState: "committed",
      replayed: true,
      steps: [expect.anything(), {
        kind: "error",
        faultClass: "cancelled",
        effectState: "committed",
      }],
    });
    expect(first.journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
      state: "indeterminate",
      abandoned: true,
      lateTerminalOutcome: { status: "completed", resultDigest: expect.stringMatching(/^sha256:/u) },
      verificationHoldId: expect.stringMatching(/^vh:/u),
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    first.simulator.close();
    first.journal.close();
    root.cleanup();
  });

  it.each([
    { name: "rolled-back guard", rollbackFailure: false, status: "guarded", transactionState: "rolled_back" },
    { name: "rollback failure", rollbackFailure: true, status: "indeterminate", transactionState: "indeterminate" },
  ] as const)(
    "durably correlates a late atomic $name carrier without clearing its hold",
    async ({ name, rollbackFailure, status, transactionState }) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const first = await simulatorForFixture({
        fixture,
        root: root.path,
        rsid,
        journalPath: join(root.path, `late-atomic-${name.replace(/\s+/gu, "-")}.db`),
      });
      const template = atomicBatch(rsid, 1);
      const timeoutMs = 25;
      const batch: InvokeBatchEnvelope = {
        ...template,
        payload: {
          ...template.payload,
          timeout_ms: timeoutMs,
          batch_digest: digestBatch({
            atomic: true,
            batchId: template.payload.batch_id,
            timeoutMs,
            steps: template.payload.steps,
          }),
        },
      };
      const mutation = batch.payload.steps[1];
      if (mutation === undefined) throw new Error("late rollback test omitted its mutation");
      fixture.planFault(batch.payload.batch_id, { delayMs: 100, rollbackFailure });
      fixture.planFault(mutation.invocation_id, { busy: true });

      await expect(first.simulator.invokeBatch(batch)).resolves.toMatchObject({
        kind: "batch",
        status: "indeterminate",
        transactionState: "indeterminate",
      });
      expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
        state: "indeterminate",
        terminalJson: null,
      });
      await vi.waitFor(() => {
        expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
          state: "terminal",
          terminalJson: expect.any(String),
        });
      }, { timeout: 2_000 });

      const replay = await first.simulator.invokeBatch(logicalRedelivery(batch, 2));
      expect(replay).toMatchObject({
        kind: "batch",
        status,
        transactionState,
        replayed: true,
      });
      expect(first.journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject(
        rollbackFailure
          ? {
              state: "indeterminate",
              lateTerminalOutcome: null,
              verificationHoldId: expect.stringMatching(/^vh:/u),
            }
          : {
              state: "indeterminate",
              lateTerminalOutcome: { status: "guarded" },
              verificationHoldId: expect.stringMatching(/^vh:/u),
            },
      );
      expect(first.journal.listHolds()).toMatchObject([{ state: "active" }]);
      expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

      first.simulator.close();
      first.journal.close();
      root.cleanup();
    },
  );

  it("measures the exact raw atomic response bytes instead of accepting whitespace-hidden overflow", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const first = await simulatorForFixture({ fixture, root: root.path, rsid });
    first.simulator.applyNegotiatedLimits({
      maxParamsBytes: 1_048_576,
      maxResultBytes: 1_048_576,
      maxPartialBytes: 65_536,
    });
    const batch = atomicBatch(rsid, 1);
    fixture.planFault(batch.payload.batch_id, { responseWhitespaceBytes: 1_048_576 });

    await expect(first.simulator.invokeBatch(batch)).resolves.toMatchObject({
      kind: "batch",
      status: "indeterminate",
      transactionState: "indeterminate",
    });
    expect(first.journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "indeterminate",
      terminalJson: null,
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    first.simulator.close();
    first.journal.close();
    root.cleanup();
  });

  it.each([
    { name: "success", fails: false, terminalStatus: "completed" },
    { name: "environment failure", fails: true, terminalStatus: "failed" },
  ] as const)(
    "returns held late evidence when a live fresh-seq mutation promotion races a $name",
    async ({ name, fails, terminalStatus }) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const first = await simulatorForFixture({
        fixture,
        root: root.path,
        rsid,
        journalPath: join(root.path, `live-promotion-${name.replace(/\s+/gu, "-")}.db`),
      });
      const invocation = mutationInvoke({ rsid, seq: 1 });
      fixture.planFault(invocation.payload.invocation_id, {
        stall: true,
        ...(fails
          ? {
              injectedOutcome: {
                state: "failed" as const,
                error: {
                  code: "command_failure" as const,
                  message: "deadline exceeded after mutation dispatch",
                },
              },
            }
          : {}),
      });

      const executing = first.simulator.invoke(invocation);
      await vi.waitFor(() => {
        expect(fixture.getPendingStallCount(invocation.payload.invocation_id)).toBe(1);
        expect(first.journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
          state: "executing",
        });
      });
      await expect(first.simulator.invoke(logicalRedelivery(invocation, 2))).resolves.toMatchObject({
        kind: "error",
        faultClass: "journal_indeterminate",
        outcome: "indeterminate",
        verificationHoldId: expect.stringMatching(/^vh:/u),
        replayed: true,
      });
      expect(fixture.releaseStall(invocation.payload.invocation_id)).toBe(true);
      const late = await executing;
      expect(late).toMatchObject({
        kind: fails ? "error" : "result",
        replayed: true,
        lateAfterIndeterminate: true,
        verificationHoldId: expect.stringMatching(/^vh:/u),
        resultDigest: expect.stringMatching(/^sha256:/u),
        addinContacted: true,
      });
      if (fails) expect(late).toMatchObject({ faultClass: "revit_timeout", outcome: "known" });
      else expect(late).toMatchObject({ status: "completed" });
      expect(first.journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
        state: "indeterminate",
        terminalOutcome: null,
        lateTerminalOutcome: { status: terminalStatus },
        verificationHoldId: expect.stringMatching(/^vh:/u),
      });
      expect(first.journal.listHolds()).toMatchObject([{ state: "active" }]);
      expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

      first.simulator.close();
      first.journal.close();
      root.cleanup();
    },
  );

  it.each([
    { name: "commit", rollBack: false, transactionState: "committed", effectState: "committed" },
    { name: "rollback", rollBack: true, transactionState: "rolled_back", effectState: "not_committed" },
  ] as const)(
    "emits a schema-valid atomic cancellation with exact $name effect evidence",
    async (scenario) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const journalPath = join(root.path, `peer-atomic-cancel-${scenario.name}.db`);
      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      const batch = atomicBatch(rsid, 1);
      const target = batch.payload.steps[1];
      if (target === undefined || !target.mutating) {
        throw new Error("peer atomic cancellation test requires its mutating second step");
      }
      fixture.planFault(batch.payload.batch_id, { stall: true });
      if (scenario.rollBack) fixture.planFault(target.invocation_id, { busy: true });
      const binding = new AuditGatewayBinding(`peer-atomic-cancel-${scenario.name}`);
      const peer = new BridgeGatewayPeer(
        first.simulator,
        binding,
        auditHelloAck(binding.connectionId),
        { idFactory: uuid },
      );

      const executing = peer.handleInbound(batch);
      await vi.waitFor(() => {
        expect(fixture.getPendingStallCount(batch.payload.batch_id)).toBe(1);
        expect(first.journal.getInvocation(rsid, target.invocation_id)).toMatchObject({
          state: "executing",
          dispatchMayHaveStarted: true,
        });
      });
      await peer.handleInbound(cancellationFor(batch, target.invocation_id, 2));
      expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
      expect(binding.sent).toEqual([]);

      expect(fixture.releaseStall(batch.payload.batch_id)).toBe(true);
      await executing;
      expect(binding.sent).toHaveLength(1);
      const emitted = binding.sent[0];
      expect(emitted).toBeDefined();
      expect(validateRbpEnvelope(emitted as RbpEnvelope)).toBe(true);
      expect(emitted).toMatchObject({
        type: "result",
        rsid,
        ack: 2,
        payload: {
          kind: "batch",
          batch_id: batch.payload.batch_id,
          atomic: true,
          status: "cancelled",
          transaction_state: scenario.transactionState,
          failed_step_index: 1,
          steps: [expect.anything(), {
            index: 1,
            invocation_id: target.invocation_id,
            status: "cancelled",
            replayed: false,
            effect_state: scenario.effectState,
            error: {
              fault_class: "cancelled",
              outcome: "known",
              replayed: false,
            },
          }],
        },
      });
      expect(first.journal.getInvocation(rsid, target.invocation_id)).toMatchObject({
        abandoned: true,
        terminalOutcome: { status: scenario.rollBack ? "guarded" : "completed" },
      });
      expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

      await peer.close();
      first.journal.close();
      root.cleanup();
    },
  );

  it("recovers the authoritative seq=1 artifact carrier after a coalesced seq=2 read redelivery", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x73);
    fixture.registerHandler("fixture_stale_carrier_race", "read_only", () => ({
      report: "authoritative-original",
      files: [{
        fileName: "stale-seq1.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "stale-carrier-race.db");
    const spoolName = "stale-carrier-race-spool";
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_stale_carrier_race" });
    fixture.planFault(invocation.payload.invocation_id, { stall: true });

    const stalled = first.simulator.invoke(invocation);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(invocation.payload.invocation_id)).toBe(1);
      expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    });
    await expect(first.simulator.invoke(logicalRedelivery(invocation, 2))).resolves.toMatchObject({
      kind: "error",
      faultClass: "protocol",
      replayed: true,
      addinContacted: false,
      message: "logical read redelivery coalesced with the active invocation",
    });
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "journaled" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });

    expect(fixture.releaseStall(invocation.payload.invocation_id)).toBe(true);
    const original = await stalled;
    expect(original).toMatchObject({
      kind: "result",
      status: "completed",
      replayed: false,
      artifactCarrier: { invocationId: invocation.payload.invocation_id },
    });
    if (original.kind !== "result" || original.artifactCarrier === null) {
      throw new Error("authoritative original result did not retain its test carrier");
    }
    expect(existsSync(original.artifactCarrier.retainedDirectory)).toBe(true);
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
    expect(first.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName,
    });
    expect(restarted.simulator.recoverableDurableDeliveries()).toEqual([]);
    const binding = new AuditGatewayBinding("stale-carrier-restart");
    const peer = new BridgeGatewayPeer(
      restarted.simulator,
      binding,
      auditHelloAck(binding.connectionId),
      { idFactory: uuid },
    );
    expect(restarted.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "delivery_ready" });
    expect(restarted.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
    expect(restarted.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(3);
    expect(restarted.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(true);

    await peer.flushOutbound(rsid);
    expect(binding.sent).toMatchObject([{
      type: "partial",
      rsid,
      seq: 1,
      ack: 2,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        kind: "chunk",
        chunk_index: 0,
        artifact_index: 0,
      },
    }]);
    expect(validateRbpEnvelope(binding.sent[0] as RbpEnvelope)).toBe(true);
    expect(JSON.stringify(binding.sent[0])).not.toContain(original.artifactCarrier.retainedDirectory);
    expect(restarted.simulator.recoverableDurableDeliveries()).toEqual([]);

    await peer.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("keeps pre-v2 carrier-only recovery working when no inbound-work row exists", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const journalPath = join(root.path, "legacy-carrier-only.db");
    const spoolRoot = join(root.path, "legacy-carrier-only-spool");
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    const journal = new DurableBridgeJournal(journalPath);
    const ids = new DeterministicUuid7Source();
    const spool = new ArtifactSpool(spoolRoot, () => ids.next());
    expect(journal.acceptInvocation(
      standaloneBinding(invocation),
      dataEnvelopeImmutableDigest(invocation as unknown as DataEnvelopeSnapshot),
    ).kind).toBe("accepted");
    journal.markExecuting(rsid, invocation.payload.invocation_id);
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x6c);
    const carrier = spool.retain(rsid, invocation.payload.invocation_id, [{
      filename: "legacy-carrier.bin",
      contentType: "application/octet-stream",
      bytes: artifactBytes,
    }]);
    const retainedPayload = {
      bridge_result: { report: "legacy-carrier-only" },
      artifact_carrier: spool.compact(carrier),
    } as unknown as JsonValue;
    journal.recordTerminal(rsid, invocation.payload.invocation_id, {
      status: "completed",
      payloadRetained: true,
      payload: retainedPayload,
      resultDigest: makeParamsDigest(retainedPayload),
    });
    expect(journal.listInboundWork(rsid)).toEqual([]);
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "legacy-carrier-only-spool",
    });
    expect(restarted.journal.listInboundWork(rsid)).toEqual([]);
    expect(restarted.simulator.recoverableDurableDeliveries()).toMatchObject([{
      rsid,
      invocationId: invocation.payload.invocation_id,
      outcome: {
        kind: "result",
        replayed: true,
        artifactCarrier: {
          invocationId: invocation.payload.invocation_id,
          retainedDirectory: carrier.retainedDirectory,
        },
      },
    }]);

    const binding = new AuditGatewayBinding("legacy-carrier-restart");
    const peer = new BridgeGatewayPeer(
      restarted.simulator,
      binding,
      auditHelloAck(binding.connectionId),
      { idFactory: uuid },
    );
    expect(restarted.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(3);
    expect(restarted.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(true);
    await peer.flushOutbound(rsid);
    expect(binding.sent[0]).toMatchObject({
      type: "partial",
      rsid,
      seq: 1,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        kind: "chunk",
        chunk_index: 0,
        artifact_index: 0,
      },
    });
    expect(JSON.stringify(binding.sent[0])).not.toContain(carrier.retainedDirectory);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);

    await peer.close();
    restarted.journal.close();
    root.cleanup();
  });

  it("expires a crash-surviving abandoned carrier directory during simulator startup", () => {
    const root = temporaryRoot();
    const rsid = uuid();
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    const journalPath = join(root.path, "abandoned-carrier-startup.db");
    const spoolRoot = join(root.path, "abandoned-carrier-spool");
    let journal = new DurableBridgeJournal(journalPath);
    let ids = new DeterministicUuid7Source();
    let spool = new ArtifactSpool(spoolRoot, () => ids.next());
    const accepted = journal.acceptInvocation(
      standaloneBinding(invocation),
      dataEnvelopeImmutableDigest(invocation as unknown as DataEnvelopeSnapshot),
    );
    expect(accepted.kind).toBe("accepted");
    journal.markExecuting(rsid, invocation.payload.invocation_id);
    expect(journal.requestCancellation(rsid, invocation.payload.invocation_id)).toMatchObject({
      kind: "await_real_outcome",
      record: { abandoned: true },
    });
    const carrier = spool.retain(rsid, invocation.payload.invocation_id, [{
      filename: "abandoned.bin",
      contentType: "application/octet-stream",
      bytes: Buffer.from("crash-surviving-abandoned-carrier", "utf8"),
    }]);
    const retainedPayload = {
      bridge_result: { success: true },
      artifact_carrier: spool.compact(carrier),
    } as unknown as JsonValue;
    journal.recordTerminal(rsid, invocation.payload.invocation_id, {
      status: "completed",
      payloadRetained: true,
      payload: retainedPayload,
      resultDigest: makeParamsDigest(retainedPayload),
    });
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      abandoned: true,
      terminalOutcome: {
        status: "completed",
        payload: { artifact_carrier: { retainedDirectory: carrier.retainedDirectory } },
      },
    });
    journal.close();

    journal = new DurableBridgeJournal(journalPath);
    ids = new DeterministicUuid7Source();
    spool = new ArtifactSpool(spoolRoot, () => ids.next());
    const restarted = new BridgeSimulator(journal, spool);
    expect(existsSync(carrier.retainedDirectory)).toBe(false);
    expect(journal.retainedDeliveryCarrierJsons()).toEqual([]);
    expect(restarted.recoverableDurableDeliveries()).toEqual([]);

    restarted.close();
    journal.close();
    root.cleanup();
  });
});
