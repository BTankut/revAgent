import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  type HelloAckEnvelope,
  type InvokeBatchEnvelope,
  type JsonValue,
  type RbpEnvelope,
  type SessionUnregister,
  makeBatchDigest,
  makeParamsDigest,
  validateRbpEnvelope,
} from "@revagent/protocol";
import { describe, expect, it, vi } from "vitest";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator, InjectedBridgeCrash } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { discoverAddinSessions } from "../src/loopback.js";
import {
  BRIDGE_OUTBOUND_HIGH_WATER_BYTES,
  BridgeGatewayPeer,
} from "../src/peer.js";
import { GatewayTransportError, type GatewayBinding } from "../src/transport.js";
import {
  mutationInvoke,
  atomicBatch,
  readInvoke,
  simulatorForFixture,
  temporaryRoot,
  uuid,
} from "./helpers.js";

class RecordingBinding implements GatewayBinding {
  public readonly sent: RbpEnvelope[] = [];
  public readonly inbound: RbpEnvelope[] = [];
  public bufferedAmount = 0;
  public closeCount = 0;
  public messageError: Error | null = null;

  public constructor(
    public readonly kind: GatewayBinding["kind"],
    public readonly connectionId = "peer-connection",
  ) {}

  public async open(): Promise<HelloAckEnvelope> {
    return helloAck(this.connectionId);
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    this.sent.push(structuredClone(envelope));
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    const inbound = this.inbound;
    const messageError = this.messageError;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        while (inbound.length > 0) yield inbound.shift() as RbpEnvelope;
        if (messageError !== null) throw messageError;
      },
    };
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class ControllableBinding extends RecordingBinding {
  readonly #queued: RbpEnvelope[] = [];
  readonly #sendHook: (envelope: RbpEnvelope) => Promise<void>;
  #waiting: ((envelope: RbpEnvelope | null) => void) | null = null;
  #ended = false;

  public constructor(
    kind: GatewayBinding["kind"],
    connectionId: string,
    sendHook: (envelope: RbpEnvelope) => Promise<void> = async () => undefined,
  ) {
    super(kind, connectionId);
    this.#sendHook = sendHook;
  }

  public push(...envelopes: readonly RbpEnvelope[]): void {
    if (this.#ended) throw new Error("cannot push to a closed controllable binding");
    for (const envelope of envelopes) {
      const waiting = this.#waiting;
      if (waiting === null) this.#queued.push(envelope);
      else {
        this.#waiting = null;
        waiting(envelope);
      }
    }
  }

  public override async send(envelope: RbpEnvelope): Promise<void> {
    this.sent.push(structuredClone(envelope));
    await this.#sendHook(envelope);
  }

  public override messages(): AsyncIterable<RbpEnvelope> {
    const next = async (): Promise<RbpEnvelope | null> => await this.#next();
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        while (true) {
          const envelope = await next();
          if (envelope === null) return;
          yield envelope;
        }
      },
    };
  }

  public override async close(): Promise<void> {
    await super.close();
    if (this.#ended) return;
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.(null);
  }

  async #next(): Promise<RbpEnvelope | null> {
    const queued = this.#queued.shift();
    if (queued !== undefined) return queued;
    if (this.#ended) return null;
    if (this.#waiting !== null) throw new Error("controllable binding supports one message consumer");
    return await new Promise<RbpEnvelope | null>((resolve) => {
      this.#waiting = resolve;
    });
  }
}

function helloAck(connectionId = "peer-connection"): HelloAckEnvelope {
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
      manifest: { latest_bridge_version: "bridge-test", manifest_url: "/bridge/update/manifest" },
    },
  };
}

function heartbeatAck(acks: readonly { readonly rsid: string; readonly seq: number }[]): RbpEnvelope {
  return {
    v: 1,
    type: "heartbeat_ack",
    id: uuid(),
    ts: "2026-07-22T00:00:15.000Z",
    payload: { server_time: "2026-07-22T00:00:15.000Z", acks: [...acks] },
  };
}

function resumeAck(rsid: string, lastRxSeq = 0): RbpEnvelope {
  return {
    v: 1,
    type: "resume_ack",
    id: uuid(),
    ts: "2026-07-22T00:00:01.000Z",
    payload: {
      rsid,
      last_rx_seq: lastRxSeq,
      resume_expires_at: "2026-07-23T00:00:00.000Z",
    },
  };
}

function asNonAtomicBatch(
  batch: InvokeBatchEnvelope,
  steps: InvokeBatchEnvelope["payload"]["steps"] = batch.payload.steps,
): InvokeBatchEnvelope {
  const payload = {
    ...batch.payload,
    atomic: false as const,
    steps,
  };
  return {
    ...batch,
    payload: {
      ...payload,
      batch_digest: makeBatchDigest({
        atomic: false,
        batch_id: payload.batch_id,
        timeout_ms: payload.timeout_ms,
        recovery_clearances: payload.recovery_clearances as unknown as JsonValue[],
        steps: payload.steps.map((step) => ({
          invocation_id: step.invocation_id,
          method: step.method,
          mutating: step.mutating,
          mutation_scope: step.mutation_scope as unknown as JsonValue,
          params_digest: step.params_digest,
          policy: step.policy,
        })),
      }),
    },
  };
}

describe("BridgeGatewayPeer executable lifecycle", () => {
  it("correlates session registration and immediately pushes cached document context", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const address = await fixture.start();
    const discovery = await discoverAddinSessions({ explicitTarget: address });
    const probe = discovery.sessions[0];
    if (probe === undefined) throw new Error("fixture discovery failed");
    const journal = new DurableBridgeJournal(join(root.path, "bridge.db"));
    const ids = new DeterministicUuid7Source();
    const simulator = new BridgeSimulator(
      journal,
      new ArtifactSpool(join(root.path, "spool"), () => ids.next()),
    );
    const registration = await simulator.registrationForProbe({
      probe,
      requestId: uuid(),
      userHint: "fixture-user",
      hostname: "fixture-host",
      fingerprint: `sha256:${"0".repeat(64)}`,
      bridgeVersion: "0.0.0",
    });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    const registrationId = await peer.registerSession({ probe, registration });
    expect(binding.sent[0]).toMatchObject({
      v: 1,
      type: "session_register",
      id: registrationId,
      payload: { local_session_key: probe.localSessionKey },
    });
    const rsid = uuid();
    await peer.handleInbound({
      v: 1,
      type: "session_registered",
      id: registrationId,
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        resume_token: "resume-token",
        resume_expires_at: "2026-07-23T00:00:00.000Z",
        principal: { tenant_id: uuid(), user_id: uuid() },
        seat: { granted: true, seat_id: uuid() },
        granted_session_capabilities: [...probe.sessionCapabilities],
      },
    });
    expect(simulator.getSession(rsid)).not.toBeNull();
    expect(binding.sent[1]).toMatchObject({
      type: "doc_context_update",
      rsid,
      seq: 1,
      payload: { active_document: "fixture-document-1" },
    });
    expect(peer.snapshot().sessions).toContainEqual(expect.objectContaining({
      rsid,
      phase: "registered",
      dispatchAllowed: true,
    }));
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("resends a pending session registration after reconnect with a fresh sender id", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const address = await fixture.start();
    const probe = (await discoverAddinSessions({ explicitTarget: address })).sessions[0];
    if (probe === undefined) throw new Error("fixture discovery failed");
    const journal = new DurableBridgeJournal(join(root.path, "bridge.db"));
    const ids = new DeterministicUuid7Source();
    const simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root.path, "spool"), () => ids.next()));
    const registration = await simulator.registrationForProbe({
      probe,
      requestId: uuid(),
      userHint: "fixture-user",
      hostname: "fixture-host",
      fingerprint: `sha256:${"0".repeat(64)}`,
      bridgeVersion: "0.0.0",
    });
    let now = 0;
    const initial = new RecordingBinding("wss", "connection-0");
    const replacement = new RecordingBinding("wss", "connection-1");
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("connection-0"), {
      idFactory: uuid,
      nowMs: () => now,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({ binding: replacement, helloAck: helloAck("connection-1") }),
    });

    const originalId = await peer.registerSession({ probe, registration });
    await peer.sendHeartbeat();
    now = 10_000;
    await peer.tick(now);
    expect(replacement.sent[0]).toMatchObject({ type: "session_register", payload: registration });
    expect(replacement.sent[0]?.id).not.toBe(originalId);
    expect(peer.snapshot().pendingRegistrationCount).toBe(1);

    const rsid = uuid();
    await peer.handleInbound({
      v: 1,
      type: "session_registered",
      id: uuid(),
      ts: "2026-07-22T00:00:10.000Z",
      payload: {
        rsid,
        resume_token: "resume-token",
        resume_expires_at: "2026-07-23T00:00:00.000Z",
        principal: { tenant_id: uuid(), user_id: uuid() },
        seat: { granted: true, seat_id: uuid() },
        granted_session_capabilities: [...probe.sessionCapabilities],
      },
    });
    expect(peer.snapshot().pendingRegistrationCount).toBe(0);
    expect(replacement.sent[1]).toMatchObject({ type: "doc_context_update", rsid });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("has identical resume/retransmit outcomes on WSS and HTTP/SSE bindings", async () => {
    const run = async (kind: GatewayBinding["kind"]): Promise<unknown> => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
      const context = await simulator.documentContext(rsid, uuid());
      simulator.queueOutbound(rsid, {
        type: "doc_context_update",
        id: uuid(),
        ts: "2026-07-22T00:00:00.000Z",
        payload: context as unknown as JsonValue,
      });
      const binding = new RecordingBinding(kind);
      const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
      await peer.resumeSession(rsid);
      await peer.handleInbound({
        v: 1,
        type: "resume_ack",
        id: uuid(),
        ts: "2026-07-22T00:00:01.000Z",
        payload: {
          rsid,
          last_rx_seq: 0,
          resume_expires_at: "2026-07-23T00:00:00.000Z",
        },
      });
      await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
      const evidence = {
        sent: binding.sent.map((entry) => ({
          type: entry.type,
          hasRsid: "rsid" in entry,
          seq: "seq" in entry ? entry.seq : null,
          payloadKind: "kind" in entry.payload ? entry.payload.kind : null,
        })),
        sequence: (() => {
          const sequence = journal.loadSequence(rsid);
          return {
            nextTxSeq: sequence.nextTxSeq,
            highestTxSeq: sequence.highestTxSeq,
            lastRxSeq: sequence.lastRxSeq,
            lastPeerAck: sequence.lastPeerAck,
            outboxSeqs: sequence.outbox.map((entry) => entry.envelope.seq),
          };
        })(),
        phase: peer.snapshot().sessions[0]?.phase,
      };
      await peer.close();
      journal.close();
      await fixture.stop();
      root.cleanup();
      return evidence;
    };
    const wss = await run("wss");
    const fallback = await run("streamable_http_sse");
    expect(fallback).toEqual(wss);
  });

  it("pushes changed cached context within 15 seconds and enforces 35/65 liveness", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 0;
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), {
      idFactory: uuid,
      nowMs: () => now,
    });
    await peer.pollDocumentContext(rsid, true);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    fixture.applyDocumentContextEvent({
      capturedAtUtc: "2026-07-22T00:00:15.000Z",
      cacheState: "ready",
      unavailableReason: null,
      documents: [{
        documentId: "fixture-document-2",
        title: "Updated",
        pathDigest: null,
        isWorkshared: true,
        isActive: true,
      }],
      activeDocumentId: "fixture-document-2",
      activeView: {
        documentId: "fixture-document-2",
        id: "2002",
        name: "Updated View",
        type: "ThreeD",
        level: null,
      },
      disciplineHint: "coordination",
    });
    now = 15_000;
    await peer.tick(now);
    expect(binding.sent.map((entry) => entry.type)).toEqual([
      "doc_context_update",
      "heartbeat",
      "doc_context_update",
    ]);
    expect(binding.sent[2]).toMatchObject({
      seq: 2,
      payload: { active_document: "fixture-document-2", active_view: { id: "2002" } },
    });
    expect(fixture.getMethodExecutionCount("get_current_view_info")).toBe(0);
    expect(fixture.getMethodExecutionCount("list_open_views")).toBe(0);
    expect(peer.livenessAt(34_999)).toBe("steady");
    expect(peer.livenessAt(35_000)).toBe("degraded");
    expect(peer.livenessAt(65_000)).toBe("disconnected");
    now = 65_000;
    await expect(peer.tick(now)).resolves.toBe("disconnected");
    expect(binding.closeCount).toBe(1);
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not extend the first pending heartbeat ACK deadline with later heartbeats", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 0;
    const binding = new RecordingBinding("wss");
    const ack = helloAck();
    const peer = new BridgeGatewayPeer(simulator, binding, ack, {
      idFactory: uuid,
      nowMs: () => now,
      heartbeatIntervalMs: 5_000,
    });

    now = 5_000;
    await peer.tick(now);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBe(15_000);
    now = 10_000;
    await peer.tick(now);
    expect(binding.sent.filter((entry) => entry.type === "heartbeat")).toHaveLength(2);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBe(15_000);
    now = 15_000;
    await expect(peer.tick(now)).resolves.toBe("disconnected");
    expect(binding.closeCount).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("rejects a hello_ack heartbeat interval that differs from the RBP/1 constant", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const ack = helloAck();
    (ack.payload as { heartbeat_interval_ms: number }).heartbeat_interval_ms = 65_000;

    expect(() => new BridgeGatewayPeer(simulator, new RecordingBinding("wss"), ack, {
      idFactory: uuid,
    })).toThrow(/heartbeat_interval_ms must equal 15000/u);

    simulator.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("retries reconnect with stateful backoff and reissues resume after a pre-ack loss", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 0;
    const initial = new RecordingBinding("wss", "connection-0");
    const replacements = [
      new RecordingBinding("wss", "connection-1"),
      new RecordingBinding("wss", "connection-2"),
    ];
    const attempts: Array<{ attemptIndex: number; delayMs: number }> = [];
    const slept: number[] = [];
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("connection-0"), {
      idFactory: uuid,
      nowMs: () => now,
      reconnectJitter: () => 0.5,
      sleep: async (delayMs) => { slept.push(delayMs); },
      reconnect: async (attempt) => {
        attempts.push(attempt);
        const binding = replacements[attempt.attemptIndex];
        if (binding === undefined) throw new Error("unexpected reconnect attempt");
        return { binding, helloAck: helloAck(binding.connectionId as string) };
      },
    });

    await peer.sendHeartbeat();
    now = 10_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(replacements[0]?.sent[0]).toMatchObject({
      type: "session_resume",
      payload: { rsid, resume_token: "resume-token" },
    });
    expect(peer.snapshot().pendingResumeCount).toBe(1);

    // Simulate losing the replacement before its resume_ack arrives.  The
    // second reconnect must reset the local resuming phase and send resume
    // again rather than failing the lifecycle transition.
    await peer.sendHeartbeat();
    now = 20_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(replacements[1]?.sent[0]).toMatchObject({
      type: "session_resume",
      payload: { rsid, resume_token: "resume-token" },
    });
    expect(attempts).toEqual([
      { attemptIndex: 0, delayMs: 500 },
      { attemptIndex: 1, delayMs: 1_000 },
    ]);
    expect(slept).toEqual([500, 1_000]);
    expect(peer.snapshot()).toMatchObject({ reconnectAttemptIndex: 2, pendingResumeCount: 1 });

    now = 140_000;
    await peer.handleInbound({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:02:20.000Z",
      payload: { rsid, last_rx_seq: 0, resume_expires_at: "2026-07-23T00:00:00.000Z" },
    });
    await peer.tick(now);
    expect(peer.snapshot().reconnectAttemptIndex).toBe(0);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("reconnects the run loop after a retryable transport stream failure", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const initial = new RecordingBinding("wss", "connection-0");
    initial.messageError = new GatewayTransportError("connection reset", {
      faultClass: "retryable_network",
    });
    const replacement = new RecordingBinding("wss", "connection-1");
    replacement.inbound.push({
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: { reason: "shutdown" },
    });
    const attempts: Array<{ attemptIndex: number; delayMs: number }> = [];
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("connection-0"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async (attempt) => {
        attempts.push(attempt);
        return { binding: replacement, helloAck: helloAck("connection-1") };
      },
    });

    await peer.run();
    expect(attempts).toEqual([{ attemptIndex: 0, delayMs: 0 }]);
    expect(initial.closeCount).toBe(1);
    expect(replacement.sent[0]).toMatchObject({ type: "session_resume", payload: { rsid } });
    expect(replacement.closeCount).toBe(1);
    expect(peer.snapshot().closed).toBe(true);

    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("reconnects after a retryable message-send expiry and retransmits the durable result after resume", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    let releaseInitial!: () => void;
    const initialClosed = new Promise<void>((resolve) => { releaseInitial = resolve; });
    let initialCloseCount = 0;
    const initial: GatewayBinding = {
      kind: "streamable_http_sse",
      connectionId: "send-expired-0",
      bufferedAmount: 0,
      open: async () => helloAck("send-expired-0"),
      send: async (envelope) => {
        if (envelope.type === "result" || envelope.type === "error") {
          throw new GatewayTransportError("HTTP/SSE message send received HTTP 410", {
            faultClass: "retryable_network",
            httpStatus: 410,
          });
        }
      },
      messages: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
          yield invocation;
          await initialClosed;
        },
      }),
      close: async () => {
        initialCloseCount += 1;
        releaseInitial();
      },
    };
    const replacement = new RecordingBinding("streamable_http_sse", "send-expired-1");
    replacement.inbound.push({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        last_rx_seq: 0,
        resume_expires_at: "2026-07-23T00:00:00.000Z",
      },
    }, {
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:02.000Z",
      payload: { reason: "shutdown" },
    });
    const replacementAck = helloAck("send-expired-1");
    const attempts: Array<{ attemptIndex: number; delayMs: number }> = [];
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("send-expired-0"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async (attempt) => {
        attempts.push(attempt);
        return { binding: replacement, helloAck: replacementAck };
      },
    });

    await peer.run();
    expect(attempts).toEqual([{ attemptIndex: 0, delayMs: 0 }]);
    expect(initialCloseCount).toBeGreaterThanOrEqual(1);
    expect(replacement.sent[0]).toMatchObject({
      type: "session_resume",
      payload: { rsid, last_rx_seq: 1 },
    });
    expect(replacement.sent[1]).toMatchObject({
      type: "result",
      rsid,
      seq: 1,
      ack: 1,
      payload: { invocation_id: invocation.payload.invocation_id },
    });
    expect(journal.loadSequence(rsid).outbox).toHaveLength(1);
    expect(peer.snapshot().closed).toBe(true);

    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("holds a second session's completed data until its reconnect resume_ack", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsidA = uuid();
    const rsidB = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid: rsidA });
    const sessionA = simulator.getSession(rsidA);
    if (sessionA === null) throw new Error("first test session is missing");
    simulator.attachSession({
      ...sessionA,
      rsid: rsidB,
      resumeToken: "resume-token-b",
    });
    const invocationA = readInvoke({ rsid: rsidA, seq: 1, method: "fixture_counter" });
    const invocationB = readInvoke({ rsid: rsidB, seq: 1, method: "fixture_counter" });
    fixture.planFault(invocationB.payload.invocation_id, { stall: true });

    const initial = new ControllableBinding(
      "streamable_http_sse",
      "two-session-0",
      async (envelope) => {
        if (
          (envelope.type === "result" || envelope.type === "error") &&
          envelope.rsid === rsidA
        ) {
          throw new GatewayTransportError("HTTP/SSE message send received HTTP 410", {
            faultClass: "retryable_network",
            httpStatus: 410,
          });
        }
      },
    );
    initial.push(invocationB);
    const replacement = new ControllableBinding("streamable_http_sse", "two-session-1");
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("two-session-0"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({ binding: replacement, helloAck: helloAck("two-session-1") }),
    });

    const run = peer.run();
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(invocationB.payload.invocation_id)).toBe(1);
    });
    initial.push(invocationA);
    await vi.waitFor(() => {
      expect(replacement.sent.filter((entry) => entry.type === "session_resume")).toHaveLength(2);
    });
    expect(replacement.sent.filter((entry) => "rsid" in entry && entry.rsid === rsidB)).toEqual([]);

    expect(fixture.releaseStall(invocationB.payload.invocation_id)).toBe(true);
    await vi.waitFor(() => {
      expect(journal.getInvocation(rsidB, invocationB.payload.invocation_id)?.state).toBe("completed");
    });
    expect(replacement.sent.filter((entry) => "rsid" in entry && entry.rsid === rsidB)).toEqual([]);

    replacement.push(resumeAck(rsidA));
    await vi.waitFor(() => {
      expect(replacement.sent).toContainEqual(expect.objectContaining({ type: "error", rsid: rsidA }));
    });
    expect(replacement.sent).not.toContainEqual(expect.objectContaining({ type: "result", rsid: rsidB }));
    replacement.push(resumeAck(rsidB));
    await vi.waitFor(() => {
      expect(replacement.sent).toContainEqual(expect.objectContaining({ type: "result", rsid: rsidB }));
    });
    replacement.push({
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:02.000Z",
      payload: { reason: "shutdown" },
    });
    await run;

    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("closes the actual replacement binding when an old-binding task gets a second retryable send failure", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsidA = uuid();
    const rsidB = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid: rsidA });
    const sessionA = simulator.getSession(rsidA);
    if (sessionA === null) throw new Error("first test session is missing");
    simulator.attachSession({
      ...sessionA,
      rsid: rsidB,
      resumeToken: "resume-token-b",
    });
    const invocationA = readInvoke({ rsid: rsidA, seq: 1, method: "fixture_counter" });
    const invocationB = readInvoke({ rsid: rsidB, seq: 1, method: "fixture_counter" });
    fixture.planFault(invocationB.payload.invocation_id, { stall: true });

    const initial = new ControllableBinding(
      "streamable_http_sse",
      "second-expiry-0",
      async (envelope) => {
        if (
          (envelope.type === "result" || envelope.type === "error") &&
          envelope.rsid === rsidA
        ) {
          throw new GatewayTransportError("initial HTTP/SSE send received HTTP 410", {
            faultClass: "retryable_network",
            httpStatus: 410,
          });
        }
      },
    );
    initial.push(invocationB);
    const firstReplacement = new ControllableBinding(
      "streamable_http_sse",
      "second-expiry-1",
      async (envelope) => {
        if (
          (envelope.type === "result" || envelope.type === "error") &&
          envelope.rsid === rsidB
        ) {
          throw new GatewayTransportError("replacement HTTP/SSE send received HTTP 410", {
            faultClass: "retryable_network",
            httpStatus: 410,
          });
        }
      },
    );
    const secondReplacement = new ControllableBinding("streamable_http_sse", "second-expiry-2");
    const replacements = [firstReplacement, secondReplacement] as const;
    let reconnectCount = 0;
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("second-expiry-0"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => {
        const binding = replacements[reconnectCount];
        if (binding === undefined) throw new Error("unexpected extra reconnect");
        reconnectCount += 1;
        return { binding, helloAck: helloAck(binding.connectionId as string) };
      },
    });

    const run = peer.run();
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(invocationB.payload.invocation_id)).toBe(1);
    });
    initial.push(invocationA);
    await vi.waitFor(() => {
      expect(firstReplacement.sent.filter((entry) => entry.type === "session_resume")).toHaveLength(2);
    });
    firstReplacement.push(resumeAck(rsidA), resumeAck(rsidB));
    await vi.waitFor(() => {
      expect(firstReplacement.sent).toContainEqual(expect.objectContaining({ type: "error", rsid: rsidA }));
      expect(firstReplacement.sent).toContainEqual(expect.objectContaining({ type: "doc_context_update", rsid: rsidB }));
    });
    firstReplacement.push(heartbeatAck([{ rsid: rsidA, seq: 1 }, { rsid: rsidB, seq: 1 }]));

    expect(fixture.releaseStall(invocationB.payload.invocation_id)).toBe(true);
    await vi.waitFor(() => {
      expect(firstReplacement.closeCount).toBeGreaterThan(0);
      expect(secondReplacement.sent.filter((entry) => entry.type === "session_resume")).toHaveLength(2);
    });
    expect(reconnectCount).toBe(2);
    secondReplacement.push(resumeAck(rsidA, 1), resumeAck(rsidB));
    await vi.waitFor(() => {
      expect(secondReplacement.sent).toContainEqual(expect.objectContaining({
        type: "result",
        rsid: rsidB,
        payload: expect.objectContaining({ invocation_id: invocationB.payload.invocation_id }),
      }));
    });
    secondReplacement.push({
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:03.000Z",
      payload: { reason: "shutdown" },
    });
    await run;

    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("pauses chunk data above 8 MiB while heartbeat control remains serviceable", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_large", "read_only", () => ({
      status: "completed",
      result: { blob: "x".repeat(1_100_000) },
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss");
    binding.bufferedAmount = BRIDGE_OUTBOUND_HIGH_WATER_BYTES + 1;
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    await peer.handleInbound(readInvoke({ rsid, seq: 1, method: "fixture_large" }));
    expect(binding.sent).toEqual([]);
    await peer.sendHeartbeat();
    expect(binding.sent.map((entry) => entry.type)).toEqual(["heartbeat"]);
    binding.bufferedAmount = 0;
    await peer.flushOutbound(rsid);
    await peer.flushOutbound(rsid);
    expect(binding.sent.filter((entry) => "seq" in entry)).toHaveLength(1);
    expect(binding.sent[1]).toMatchObject({ type: "partial", seq: 1 });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(binding.sent[2]).toMatchObject({ type: "partial", seq: 2 });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    expect(binding.sent[3]).toMatchObject({
      type: "result",
      seq: 3,
      payload: { chunked: true, stream_id: "result", total_chunks: 2 },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    expect(journal.loadSequence(rsid).outbox).toEqual([]);
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("carries batch identity and verification hold on a blocked batch error", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const mutation = mutationInvoke({ rsid, seq: 1 });
    await expect(simulator.invoke(mutation, {
      crashAt: "after_executing_before_addin_write",
    })).rejects.toThrow("after_executing_before_addin_write");
    journal.classifyInterruptedMutations();
    const hold = journal.listHolds()[0];
    if (hold === undefined) throw new Error("test hold was not installed");
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    const batch = atomicBatch(rsid, 2);
    await peer.handleInbound(batch);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      rsid,
      seq: 1,
      payload: {
        batch_id: batch.payload.batch_id,
        fault_class: "journal_indeterminate",
        outcome: "indeterminate",
        verification_required: true,
        verification_hold_id: hold.holdId,
        mutation_scope: hold.mutationScope,
      },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    await peer.handleInbound(batch);
    expect(binding.sent[1]).toMatchObject({
      type: "error",
      seq: 2,
      payload: {
        batch_id: batch.payload.batch_id,
        fault_class: "journal_indeterminate",
        replayed: true,
      },
    });
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it.each([
    "revit_exited",
    "bridge_shutdown",
    "session_replaced",
    "operator_requested",
  ] satisfies SessionUnregister["reason"][])(
    "revokes resume/dispatch and preserves uncertain mutation for %s",
    async (reason) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
      const mutation = mutationInvoke({ rsid, seq: 1 });
      await expect(simulator.invoke(mutation, {
        crashAt: "after_executing_before_addin_write",
      })).rejects.toThrow("after_executing_before_addin_write");
      const binding = new RecordingBinding("wss");
      const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
      await peer.unregisterSession(rsid, reason);
      expect(binding.sent[0]).toMatchObject({
        type: "session_unregister",
        payload: { rsid, reason },
      });
      expect(journal.getInvocation(rsid, mutation.payload.invocation_id)).toMatchObject({
        state: "indeterminate",
        verificationHoldId: expect.any(String),
      });
      expect(journal.listHolds()).toHaveLength(1);
      expect(peer.snapshot().sessions[0]).toMatchObject({
        phase: "unregistered",
        resumeAllowed: false,
        dispatchAllowed: false,
        unregisterReason: reason,
      });
      await expect(peer.resumeSession(rsid)).rejects.toThrow("not resumable");
      await expect(simulator.invoke(mutationInvoke({ rsid, seq: 2 }))).resolves.toMatchObject({
        kind: "error",
        faultClass: "protocol",
      });
      await peer.close();
      journal.close();
      await fixture.stop();
      root.cleanup();
    },
  );

  it("executes inbound control through the binding run loop", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 20_000;
    const binding = new RecordingBinding("wss");
    binding.inbound.push(heartbeatAck([]));
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), {
      idFactory: uuid,
      nowMs: () => now,
    });
    now = 25_000;
    await peer.run();
    expect(peer.snapshot().lastHeartbeatAckAtMs).toBe(25_000);
    expect(peer.snapshot().runLoopActive).toBe(false);
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("ACKs a preflight-rejected invoke sequence and accepts the next sequence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    const rejected = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    rejected.payload.params_digest = `sha256:${"0".repeat(64)}`;

    await peer.handleInbound(rejected);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      ack: 1,
      payload: { invocation_id: rejected.payload.invocation_id, fault_class: "protocol" },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    await peer.handleInbound(readInvoke({ rsid, seq: 2, method: "fixture_counter" }));
    expect(binding.sent[1]).toMatchObject({ type: "result", ack: 2 });
    expect(journal.loadSequence(rsid).lastRxSeq).toBe(2);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("ACKs a preflight-rejected batch sequence and accepts the next sequence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    const rejected = atomicBatch(rsid, 1);
    const firstStep = rejected.payload.steps[0];
    if (firstStep === undefined) throw new Error("test batch is empty");
    firstStep.method = "fixture_counter";
    rejected.payload.batch_digest = makeBatchDigest({
      atomic: rejected.payload.atomic,
      batch_id: rejected.payload.batch_id,
      recovery_clearances: rejected.payload.recovery_clearances as unknown as JsonValue[],
      steps: rejected.payload.steps.map((step) => ({
        invocation_id: step.invocation_id,
        method: step.method,
        mutating: step.mutating,
        mutation_scope: step.mutation_scope as unknown as JsonValue,
        params_digest: step.params_digest,
        policy: step.policy,
      })),
      timeout_ms: rejected.payload.timeout_ms,
    });

    await peer.handleInbound(rejected);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      ack: 1,
      payload: { batch_id: rejected.payload.batch_id, fault_class: "unsupported" },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    await peer.handleInbound(readInvoke({ rsid, seq: 2, method: "fixture_counter" }));
    expect(binding.sent[1]).toMatchObject({ type: "result", ack: 2 });
    expect(journal.loadSequence(rsid).lastRxSeq).toBe(2);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps independent rsids concurrent through the binding run loop", async () => {
    const root = temporaryRoot();
    const firstFixture = new AddinLoopbackFixture();
    const secondFixture = new AddinLoopbackFixture();
    const firstAddress = await firstFixture.start();
    const secondAddress = await secondFixture.start();
    const firstProbe = (await discoverAddinSessions({ explicitTarget: firstAddress })).sessions[0];
    const secondProbe = (await discoverAddinSessions({ explicitTarget: secondAddress })).sessions[0];
    if (firstProbe === undefined || secondProbe === undefined) throw new Error("fixture discovery failed");
    const journal = new DurableBridgeJournal(join(root.path, "concurrent.db"));
    const ids = new DeterministicUuid7Source();
    const simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root.path, "spool"), () => ids.next()));
    const rsids = [uuid(), uuid()] as const;
    for (const [index, probe] of [firstProbe, secondProbe].entries()) {
      const registration = await simulator.registrationForProbe({
        probe,
        requestId: uuid(),
        userHint: `fixture-user-${index}`,
        hostname: `fixture-host-${index}`,
        fingerprint: `sha256:${index.toString().repeat(64)}`,
        bridgeVersion: "bridge-simulator-test",
      });
      simulator.attachSession({
        rsid: rsids[index] as string,
        resumeToken: `resume-${index}`,
        resumeExpiresAt: "2026-07-23T00:00:00.000Z",
        grantedSessionCapabilities: probe.sessionCapabilities,
        probe,
        registration,
      });
    }
    const slow = readInvoke({ rsid: rsids[0], seq: 1 });
    const fast = readInvoke({ rsid: rsids[1], seq: 1 });
    firstFixture.planFault(slow.payload.invocation_id, { delayMs: 100 });
    const binding = new RecordingBinding("wss");
    binding.inbound.push(slow, fast);
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    await peer.run();
    expect(binding.sent).toHaveLength(2);
    expect(binding.sent[0]).toMatchObject({ type: "result", rsid: rsids[1] });
    expect(binding.sent[1]).toMatchObject({ type: "result", rsid: rsids[0] });
    expect(firstFixture.getExecutionCount(slow.payload.invocation_id)).toBe(1);
    expect(secondFixture.getExecutionCount(fast.payload.invocation_id)).toBe(1);

    await peer.close();
    journal.close();
    await firstFixture.stop();
    await secondFixture.stop();
    root.cleanup();
  });

  it("does not emit a premature terminal when cancel races an executing invocation", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = readInvoke({ rsid, seq: 1 });
    fixture.planFault(invocation.payload.invocation_id, { delayMs: 80 });
    const binding = new RecordingBinding("wss");
    binding.inbound.push(invocation, {
      v: 1,
      type: "cancel",
      id: uuid(),
      rsid,
      seq: 2,
      ts: "2026-07-22T00:00:00.010Z",
      payload: { invocation_id: invocation.payload.invocation_id, reason: "user_requested" },
    });
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    const running = peer.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(binding.sent).toEqual([]);
    await running;
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "cancelled",
        outcome: "known",
      },
    });
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "completed",
      abandoned: true,
      terminalOutcome: { status: "completed" },
    });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("emits a schema-valid atomic rollback prefix and deeply marks its durable replay", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:42", { deleted: true });
      return { state: "guarded", guardedReason: "protected_view" };
    });
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    const batch = atomicBatch(rsid, 1);

    await peer.handleInbound(batch);
    const first = binding.sent[0];
    expect(first).toBeDefined();
    expect(validateRbpEnvelope(first as RbpEnvelope)).toBe(true);
    expect(first).toMatchObject({
      type: "result",
      rsid,
      seq: 1,
      payload: {
        kind: "batch",
        status: "guarded",
        transaction_state: "rolled_back",
        failed_step_index: 1,
        replayed: false,
        steps: [
          {
            index: 0,
            status: "completed",
            replayed: false,
            result: {
              execution_state: "completed",
              effect_state: "discarded",
              result_suppressed: "batch_rolled_back",
            },
          },
          { index: 1, status: "guarded", replayed: false, guarded_reason: "protected_view" },
        ],
      },
    });
    expect(fixture.modelState.has("view:42")).toBe(false);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));

    await peer.handleInbound(batch);
    const replay = binding.sent[1];
    expect(replay).toBeDefined();
    expect(validateRbpEnvelope(replay as RbpEnvelope)).toBe(true);
    expect(replay).toMatchObject({
      type: "result",
      rsid,
      seq: 2,
      payload: {
        kind: "batch",
        status: "guarded",
        replayed: true,
        steps: [
          { index: 0, status: "completed", replayed: true },
          { index: 1, status: "guarded", replayed: true },
        ],
      },
    });
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not fabricate a completed read when atomic dispatch crashes before the add-in write", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const batch = atomicBatch(rsid, 1);
    const journalPath = join(root.path, "atomic-read-result-unavailable.db");
    const first = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-first",
    });
    await expect(first.simulator.invokeBatch(batch, {
      crashAt: "after_executing_before_addin_write",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(0);
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-restarted",
    });
    const binding = new RecordingBinding("wss", "atomic-indeterminate");
    const peer = new BridgeGatewayPeer(
      restarted.simulator,
      binding,
      helloAck("atomic-indeterminate"),
      { idFactory: uuid },
    );

    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        kind: "batch",
        status: "indeterminate",
        transaction_state: "indeterminate",
        failed_step_index: 0,
        replayed: true,
        steps: [
          {
            index: 0,
            status: "failed",
            replayed: true,
            error: {
              retryable: true,
              fault_class: "environment",
              outcome: "known",
              verification_required: false,
              replayed: true,
            },
          },
          {
            index: 1,
            status: "indeterminate",
            replayed: true,
            error: {
              fault_class: "journal_indeterminate",
              verification_required: true,
              replayed: true,
            },
          },
        ],
      },
    });
    const carrierPayload = carrier !== undefined && "payload" in carrier
      ? carrier.payload as { readonly steps?: readonly Record<string, unknown>[] }
      : {};
    expect(carrierPayload.steps?.[0]).not.toHaveProperty("result");
    const readStep = batch.payload.steps[0];
    const mutatingStep = batch.payload.steps[1];
    expect(readStep).toBeDefined();
    expect(mutatingStep).toBeDefined();
    expect(restarted.journal.getInvocation(rsid, readStep?.invocation_id ?? "missing")).toMatchObject({
      state: "failed",
      terminalOutcome: { status: "failed" },
    });
    expect(restarted.journal.getInvocation(rsid, mutatingStep?.invocation_id ?? "missing")).toMatchObject({
      state: "indeterminate",
      verificationHoldId: expect.any(String),
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(0);

    await peer.close();
    restarted.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps a large non-atomic batch result inline and leaves no unreachable spool after ack", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const largeBlob = "x".repeat(1_100_000);
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "completed",
      result: { success: true, blob: largeBlob },
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-inline-large");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-inline-large"), {
      idFactory: uuid,
    });
    const batch = asNonAtomicBatch(atomicBatch(rsid, 1));

    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        kind: "batch",
        status: "completed",
        failed_step_index: null,
        steps: [
          { status: "completed", result: { success: true, blob: largeBlob } },
          { status: "completed" },
        ],
      },
    });
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(journal.loadSequence(rsid).outbox).toEqual([]);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("stops on the first post-dispatch inline cap violation before aggregate growth", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "completed",
      result: { blob: "x".repeat(8_500_000) },
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-inline-cap");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-inline-cap"), {
      idFactory: uuid,
    });
    const batch = asNonAtomicBatch(atomicBatch(rsid, 1));

    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        status: "failed",
        failed_step_index: 0,
        steps: [
          {
            status: "failed",
            effect_state: "read_only",
            error: { fault_class: "protocol" },
          },
          { status: "not_started" },
        ],
      },
    });
    expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(1);
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(carrier), "utf8")).toBeLessThan(64_000);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not turn theoretical per-step maxima into an artificial batch-length limit", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-aggregate-small-results");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-aggregate-small-results"), {
      idFactory: uuid,
    });
    const base = atomicBatch(rsid, 1);
    const template = base.payload.steps[0];
    if (template === undefined) throw new Error("test batch requires a read step");
    const steps = Array.from({ length: 6 }, (): InvokeBatchEnvelope["payload"]["steps"][number] => ({
      ...template,
      invocation_id: uuid(),
    })) as unknown as InvokeBatchEnvelope["payload"]["steps"];
    const batch = asNonAtomicBatch(base, steps);

    await peer.handleInbound(batch);
    expect(binding.sent[0]).toMatchObject({
      type: "result",
      payload: {
        batch_id: batch.payload.batch_id,
        status: "completed",
        failed_step_index: null,
      },
    });
    const payload = binding.sent[0]?.payload as { readonly steps?: readonly unknown[] } | undefined;
    expect(payload?.steps).toHaveLength(6);
    expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(6);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("rejects an unadvertised artifact batch method before dispatch or spooling", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-artifact-preflight");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-artifact-preflight"), {
      idFactory: uuid,
    });
    const base = atomicBatch(rsid, 1);
    const first = base.payload.steps[0];
    const second = base.payload.steps[1];
    if (first === undefined || second === undefined) throw new Error("test batch requires two steps");
    const params = {} as JsonValue;
    const steps: InvokeBatchEnvelope["payload"]["steps"] = [
      {
        ...first,
        method: "fixture_multi_file_output",
        params,
        params_digest: makeParamsDigest(params),
      },
      second,
    ];
    const batch = asNonAtomicBatch(base, steps);

    await peer.handleInbound(batch);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      payload: {
        batch_id: batch.payload.batch_id,
        fault_class: "unsupported",
      },
    });
    expect(fixture.getMethodExecutionCount("fixture_multi_file_output")).toBe(0);
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(0);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("preserves a committed mutation when an attested batch method violates inline-only output", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", () => ({
      state: "completed",
      result: {
        success: true,
        files: [{
          fileName: "must-not-spool.txt",
          contentType: "text/plain",
          contentBase64: "eA==",
        }],
      },
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-inline-violation");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-inline-violation"), {
      idFactory: uuid,
    });
    const batch = asNonAtomicBatch(atomicBatch(rsid, 1));
    const mutation = batch.payload.steps[1];
    if (mutation === undefined) throw new Error("test batch requires a mutation");

    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        kind: "batch",
        status: "failed",
        failed_step_index: 1,
        steps: [
          { status: "completed" },
          {
            status: "failed",
            effect_state: "committed",
            error: { fault_class: "protocol", outcome: "known" },
          },
        ],
      },
    });
    expect(journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: {
        status: "failed",
        payload: { fault_class: "protocol", effect_state: "committed" },
      },
    });
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(1);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(journal.loadSequence(rsid).outbox).toEqual([]);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("preserves committed effect state when malformed artifact data violates batch-inline-only output", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", () => ({
      state: "completed",
      result: {
        success: true,
        files: [{
          fileName: "malformed-must-not-spool.txt",
          contentType: "text/plain",
          contentBase64: "!!!",
        }],
      },
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "batch-inline-malformed");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("batch-inline-malformed"), {
      idFactory: uuid,
    });
    const batch = asNonAtomicBatch(atomicBatch(rsid, 1));
    const mutation = batch.payload.steps[1];
    if (mutation === undefined) throw new Error("test batch requires a mutation");

    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        kind: "batch",
        status: "failed",
        failed_step_index: 1,
        steps: [
          { status: "completed" },
          {
            status: "failed",
            effect_state: "committed",
            error: { fault_class: "protocol", outcome: "known" },
          },
        ],
      },
    });
    expect(journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: {
        status: "failed",
        payload: { fault_class: "protocol", effect_state: "committed" },
      },
    });
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(1);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("rejects an invalid artifact content type before carrier or delivery-plan persistence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_invalid_artifact_content_type", "read_only", () => ({
      files: [{
        fileName: "poison-pill.txt",
        contentType: "",
        contentBase64: "eA==",
      }],
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "artifact-content-type");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("artifact-content-type"), {
      idFactory: uuid,
    });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_invalid_artifact_content_type" });

    await peer.handleInbound(invocation);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "parameter",
        outcome: "known",
      },
    });
    expect(validateRbpEnvelope(binding.sent[0] as RbpEnvelope)).toBe(true);
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: { status: "failed" },
    });
    expect(journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);
    expect(journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(existsSync(join(root.path, "spool", rsid, invocation.payload.invocation_id))).toBe(false);
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("replays an inline-only delivery fault after the step-terminal crash window without dispatching successors", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", () => ({
      state: "completed",
      result: {
        success: true,
        files: [{
          fileName: "must-not-survive-crash.txt",
          contentType: "text/plain",
          contentBase64: "eA==",
        }],
      },
    }));
    const rsid = uuid();
    const base = atomicBatch(rsid, 1);
    const firstStep = base.payload.steps[0];
    const mutation = base.payload.steps[1];
    if (firstStep === undefined || mutation === undefined) throw new Error("test batch requires two steps");
    const successorParams = {} as JsonValue;
    const successor: InvokeBatchEnvelope["payload"]["steps"][number] = {
      ...firstStep,
      invocation_id: uuid(),
      params: successorParams,
      params_digest: makeParamsDigest(successorParams),
    };
    const batch = asNonAtomicBatch(base, [firstStep, mutation, successor]);
    const journalPath = join(root.path, "batch-inline-crash.db");
    const first = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-first",
    });

    await expect(first.simulator.invokeBatch(batch, {
      crashAt: "after_non_atomic_step_terminal_before_batch_terminal",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(first.journal.getInvocation(rsid, mutation.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: {
        status: "failed",
        payload: { fault_class: "protocol", effect_state: "committed" },
      },
    });
    expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(1);
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(1);
    first.simulator.close();
    first.journal.close();

    const restarted = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "spool-restarted",
    });
    const binding = new RecordingBinding("wss", "batch-inline-crash-replay");
    const peer = new BridgeGatewayPeer(
      restarted.simulator,
      binding,
      helloAck("batch-inline-crash-replay"),
      { idFactory: uuid },
    );
    await peer.handleInbound(batch);
    const carrier = binding.sent[0];
    expect(carrier).toBeDefined();
    expect(validateRbpEnvelope(carrier as RbpEnvelope)).toBe(true);
    expect(carrier).toMatchObject({
      type: "result",
      payload: {
        kind: "batch",
        status: "failed",
        failed_step_index: 1,
        replayed: true,
        steps: [
          { status: "completed", replayed: true },
          {
            status: "failed",
            replayed: true,
            effect_state: "committed",
            error: { fault_class: "protocol", replayed: true },
          },
          { status: "not_started", replayed: false },
        ],
      },
    });
    expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(1);
    expect(fixture.getMethodExecutionCount("delete_review_view")).toBe(1);
    expect(readdirSync(join(root.path, "spool-restarted"))).toEqual([]);

    await peer.close();
    restarted.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("carries a mutating deadline as indeterminate first and exact late terminal evidence on replay", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = mutationInvoke({ rsid, seq: 1 });
    fixture.planFault(invocation.payload.invocation_id, {
      jsonRpcError: { code: -32603, message: "deadline exceeded after dispatch" },
    });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    await peer.handleInbound(invocation);
    const indeterminate = binding.sent[0];
    expect(indeterminate).toBeDefined();
    expect(validateRbpEnvelope(indeterminate as RbpEnvelope)).toBe(true);
    expect(indeterminate).toMatchObject({
      type: "error",
      rsid,
      seq: 1,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "journal_indeterminate",
        retryable: false,
        outcome: "indeterminate",
        verification_required: true,
        replayed: false,
        verification_hold_id: expect.any(String),
        mutation_scope: invocation.payload.mutation_scope,
      },
    });
    const holdId = (indeterminate as Extract<RbpEnvelope, { type: "error" }>).payload.verification_hold_id;
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "indeterminate",
      verificationHoldId: holdId,
      lateTerminalOutcome: {
        status: "failed",
        payload: { fault_class: "revit_timeout", message: "deadline exceeded after dispatch" },
        resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));

    await peer.handleInbound(invocation);
    const late = binding.sent[1];
    expect(late).toBeDefined();
    expect(validateRbpEnvelope(late as RbpEnvelope)).toBe(true);
    expect(late).toMatchObject({
      type: "error",
      rsid,
      seq: 2,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "revit_timeout",
        retryable: true,
        outcome: "known",
        verification_required: false,
        replayed: true,
        late_after_indeterminate: true,
        verification_hold_id: holdId,
        result_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("continues a two-part artifact plan across restart and deletes the spool only after terminal ack", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x5a);
    fixture.registerHandler("fixture_restart_artifact", "read_only", () => ({
      report: "restart-proof",
      files: [{
        fileName: "restart-proof.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const journalPath = join(root.path, "artifact-restart.db");
    const spoolName = "artifact-spool";
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_restart_artifact" });

    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const firstBinding = new RecordingBinding("wss", "artifact-connection-1");
    const firstPeer = new BridgeGatewayPeer(
      first.simulator,
      firstBinding,
      helloAck("artifact-connection-1"),
      { idFactory: uuid },
    );
    await firstPeer.handleInbound(invocation);
    expect(firstBinding.sent).toHaveLength(1);
    expect(firstBinding.sent[0]).toMatchObject({
      type: "partial",
      rsid,
      seq: 1,
      payload: { kind: "chunk", chunk_index: 0, artifact_index: 0 },
    });
    expect(first.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(2);
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(true);
    await firstPeer.close();
    first.journal.close();

    const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const secondBinding = new RecordingBinding("wss", "artifact-connection-2");
    const secondPeer = new BridgeGatewayPeer(
      second.simulator,
      secondBinding,
      helloAck("artifact-connection-2"),
      { idFactory: uuid },
    );
    await secondPeer.resumeSession(rsid);
    await secondPeer.handleInbound({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        last_rx_seq: 0,
        resume_expires_at: "2026-07-23T00:00:00.000Z",
      },
    });
    expect(secondBinding.sent[1]).toMatchObject({
      ...firstBinding.sent[0],
      ts: expect.any(String),
    });

    await secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(secondBinding.sent[2]).toMatchObject({
      type: "partial",
      rsid,
      seq: 2,
      payload: { kind: "chunk", chunk_index: 1, artifact_index: 0 },
    });
    await secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    const terminal = secondBinding.sent[3];
    expect(terminal).toBeDefined();
    expect(validateRbpEnvelope(terminal as RbpEnvelope)).toBe(true);
    expect(terminal).toMatchObject({
      type: "result",
      rsid,
      seq: 3,
      payload: {
        kind: "invocation",
        invocation_id: invocation.payload.invocation_id,
        status: "completed",
        chunked: true,
        result: {
          report: "restart-proof",
          files: [{ artifact_id: expect.any(String), artifact_index: 0 }],
        },
        artifacts: [{
          artifact_id: expect.any(String),
          artifact_index: 0,
          stream_id: expect.stringMatching(/^artifact:/u),
          filename: "restart-proof.bin",
          total_chunks: 2,
          total_size: artifactBytes.byteLength,
          sha256: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
        }],
        result_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(second.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(true);

    await secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(false);
    expect(readdirSync(join(root.path, spoolName))).toEqual([]);
    expect(second.journal.deliveryCarriersNeedingCleanup()).toEqual([]);
    // ACK the context update queued by resume, then prove a later origin
    // redelivery cannot claim deleted artifact bytes.
    await secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 4 }]));
    await secondPeer.handleInbound(invocation);
    expect(secondBinding.sent[5]).toMatchObject({
      type: "result",
      rsid,
      seq: 5,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        replayed: true,
        payload_omitted: true,
        result_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(JSON.stringify(secondBinding.sent[5])).not.toContain("artifacts");

    await secondPeer.close();
    second.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("recovers an artifact terminal committed before the peer could stage its delivery plan", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x3c);
    fixture.registerHandler("fixture_preplan_crash_artifact", "read_only", () => ({
      report: "committed-before-plan",
      files: [{
        fileName: "preplan-crash.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const journalPath = join(root.path, "artifact-preplan-crash.db");
    const spoolName = "artifact-preplan-spool";
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_preplan_crash_artifact" });

    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const committed = await first.simulator.invoke(invocation);
    expect(committed).toMatchObject({
      kind: "result",
      replayed: false,
      artifactCarrier: { invocationId: invocation.payload.invocation_id },
    });
    expect(first.journal.loadSequence(rsid).lastRxSeq).toBe(1);
    expect(first.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(first.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(true);
    first.simulator.close();
    first.journal.close();

    const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const binding = new RecordingBinding("wss", "artifact-preplan-connection");
    const peer = new BridgeGatewayPeer(
      second.simulator,
      binding,
      helloAck("artifact-preplan-connection"),
      { idFactory: uuid },
    );
    expect(second.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(3);
    expect(second.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(true);
    expect(peer.snapshot().queuedDataCount).toBe(3);

    await peer.resumeSession(rsid);
    expect(binding.sent[0]).toMatchObject({
      type: "session_resume",
      payload: { rsid, last_rx_seq: 1 },
    });
    await peer.handleInbound({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        last_rx_seq: 0,
        resume_expires_at: "2026-07-23T00:00:00.000Z",
      },
    });
    expect(binding.sent[1]).toMatchObject({
      type: "partial",
      rsid,
      seq: 1,
      payload: { invocation_id: invocation.payload.invocation_id, chunk_index: 0 },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(binding.sent[2]).toMatchObject({ type: "partial", rsid, seq: 2 });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    expect(binding.sent[3]).toMatchObject({
      type: "result",
      rsid,
      seq: 3,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        replayed: true,
        result: {
          report: "committed-before-plan",
          files: [{ artifact_id: expect.any(String), artifact_index: 0 }],
        },
        artifacts: [{
          filename: "preplan-crash.bin",
          total_chunks: 2,
          total_size: artifactBytes.byteLength,
          sha256: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
        }],
      },
    });
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(false);
    expect(second.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);

    await peer.close();
    second.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("fails closed on a pre-plan carrier capability downgrade and unregister expires the terminal-only spool", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x4d);
    fixture.registerHandler("fixture_preplan_downgrade", "read_only", () => ({
      files: [{
        fileName: "preplan-downgrade.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const spoolName = "preplan-downgrade-spool";
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_preplan_downgrade" });
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid, spoolName });
    const initial = new RecordingBinding("wss", "preplan-initial");
    initial.messageError = new GatewayTransportError("connection expired", {
      faultClass: "retryable_network",
    });
    const replacement = new RecordingBinding("wss", "preplan-downgraded");
    const downgradedAck = helloAck("preplan-downgraded");
    downgradedAck.payload.granted_capabilities = ["journal_v1"];
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("preplan-initial"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({ binding: replacement, helloAck: downgradedAck }),
    });

    await expect(simulator.invoke(invocation)).resolves.toMatchObject({
      kind: "result",
      artifactCarrier: { invocationId: invocation.payload.invocation_id },
    });
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBeNull();
    await expect(peer.run()).rejects.toMatchObject({ faultClass: "protocol" });
    expect(peer.snapshot().retrySuppressedFault).toBe("protocol");
    expect(replacement.closeCount).toBe(1);
    expect(replacement.sent).toEqual([]);
    expect(journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(true);

    simulator.unregisterSession(rsid, "operator_requested");
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(false);
    expect(journal.deliveryCarriersNeedingExpiry()).toEqual([]);
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBe("expired");

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("recovers a first-delivery chunked result committed before peer plan staging", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const blob = "r".repeat(1_100_000);
    fixture.registerHandler("fixture_preplan_chunked_result", "read_only", () => ({ blob }));
    const rsid = uuid();
    const journalPath = join(root.path, "chunked-preplan-crash.db");
    const spoolName = "chunked-preplan-spool";
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_preplan_chunked_result" });

    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const committed = await first.simulator.invoke(invocation);
    expect(committed).toMatchObject({
      kind: "result",
      replayed: false,
      resultCarrier: { kind: "chunked_result", rsid, invocationId: invocation.payload.invocation_id },
    });
    if (committed.kind !== "result" || committed.resultCarrier === null) {
      throw new Error("chunked result carrier was not retained");
    }
    const expectedTotalSize = committed.resultCarrier.totalSize;
    expect(first.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    first.simulator.close();
    first.journal.close();

    const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName });
    const binding = new RecordingBinding("wss", "chunked-preplan-connection");
    const peer = new BridgeGatewayPeer(
      second.simulator,
      binding,
      helloAck("chunked-preplan-connection"),
      { idFactory: uuid },
    );
    expect(second.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(3);
    await peer.resumeSession(rsid);
    await peer.handleInbound({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        last_rx_seq: 0,
        resume_expires_at: "2026-07-23T00:00:00.000Z",
      },
    });
    expect(binding.sent[1]).toMatchObject({
      type: "partial",
      seq: 1,
      payload: { invocation_id: invocation.payload.invocation_id, stream_id: "result", chunk_index: 0 },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(binding.sent[2]).toMatchObject({ type: "partial", seq: 2, payload: { chunk_index: 1 } });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    expect(binding.sent[3]).toMatchObject({
      type: "result",
      seq: 3,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        replayed: true,
        chunked: true,
        stream_id: "result",
        total_chunks: 2,
        total_size: expectedTotalSize,
      },
    });
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(false);

    await peer.close();
    second.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it.each(["auth", "version", "trust"] as const)(
    "suppresses unchanged reconnect after one terminal %s failure",
    async (faultClass) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
      let now = 0;
      let attempts = 0;
      const initial = new RecordingBinding("wss", `terminal-${faultClass}`);
      const peer = new BridgeGatewayPeer(simulator, initial, helloAck(`terminal-${faultClass}`), {
        idFactory: uuid,
        nowMs: () => now,
        reconnectJitter: () => 0,
        sleep: async () => undefined,
        reconnect: async () => {
          attempts += 1;
          throw new GatewayTransportError(`${faultClass} reconnect refusal`, { faultClass });
        },
      });

      await peer.sendHeartbeat();
      now = 10_000;
      await expect(peer.tick(now)).rejects.toMatchObject({ faultClass });
      expect(peer.snapshot()).toMatchObject({
        liveness: "disconnected",
        reconnectAttemptIndex: 1,
        retrySuppressedFault: faultClass,
      });
      now = 20_000;
      await expect(peer.tick(now)).resolves.toBe("disconnected");
      expect(attempts).toBe(1);

      await peer.close();
      journal.close();
      await fixture.stop();
      root.cleanup();
    },
  );

  it("carries bounded transport Retry-After into the next reconnect delay floor", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 0;
    const initial = new RecordingBinding("wss", "retry-after-0");
    const replacement = new RecordingBinding("wss", "retry-after-1");
    const attempts: Array<{ attemptIndex: number; delayMs: number }> = [];
    const sleeps: number[] = [];
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("retry-after-0"), {
      idFactory: uuid,
      nowMs: () => now,
      reconnectJitter: () => 0,
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reconnect: async (attempt) => {
        attempts.push(attempt);
        if (attempt.attemptIndex === 0) {
          throw new GatewayTransportError("HTTP 503", {
            faultClass: "retryable_network",
            httpStatus: 503,
            retryAfterMs: 30_000,
          });
        }
        return { binding: replacement, helloAck: helloAck("retry-after-1") };
      },
    });

    await peer.sendHeartbeat();
    now = 10_000;
    await expect(peer.tick(now)).resolves.toBe("disconnected");
    now = 20_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(attempts).toEqual([
      { attemptIndex: 0, delayMs: 0 },
      { attemptIndex: 1, delayMs: 30_000 },
    ]);
    expect(sleeps).toEqual([0, 30_000]);
    expect(replacement.sent[0]).toMatchObject({ type: "session_resume", payload: { rsid } });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it.each(["update", "server_draining"] as const)(
    "delays %s goodbye reconnect without discarding resumable session state",
    async (reason) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
      const initial = new RecordingBinding("wss", `goodbye-${reason}-0`);
      initial.inbound.push({
        v: 1,
        type: "goodbye",
        id: uuid(),
        ts: "2026-07-22T00:00:01.000Z",
        payload: { reason, retry_after_ms: 30_000 },
      });
      const replacement = new RecordingBinding("wss", `goodbye-${reason}-1`);
      replacement.inbound.push({
        v: 1,
        type: "goodbye",
        id: uuid(),
        ts: "2026-07-22T00:00:31.000Z",
        payload: { reason: "shutdown" },
      });
      const sleeps: number[] = [];
      const attempts: Array<{ attemptIndex: number; delayMs: number }> = [];
      const peer = new BridgeGatewayPeer(simulator, initial, helloAck(initial.connectionId as string), {
        idFactory: uuid,
        reconnectJitter: () => 0,
        sleep: async (delayMs) => { sleeps.push(delayMs); },
        reconnect: async (attempt) => {
          attempts.push(attempt);
          return { binding: replacement, helloAck: helloAck(replacement.connectionId as string) };
        },
      });

      await peer.run();
      expect(sleeps).toEqual([30_000]);
      expect(attempts).toEqual([{ attemptIndex: 0, delayMs: 30_000 }]);
      expect(replacement.sent[0]).toMatchObject({
        type: "session_resume",
        payload: { rsid, resume_token: "resume-token" },
      });
      expect(peer.snapshot().closed).toBe(true);

      journal.close();
      await fixture.stop();
      root.cleanup();
    },
  );

  it("treats auth_revoked goodbye as permanent and never enters reconnect", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "auth-revoked-0");
    binding.inbound.push({
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: { reason: "auth_revoked" },
    });
    let attempts = 0;
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("auth-revoked-0"), {
      idFactory: uuid,
      reconnect: async () => {
        attempts += 1;
        throw new Error("must not reconnect");
      },
    });

    await peer.run();
    expect(attempts).toBe(0);
    expect(peer.snapshot()).toMatchObject({ closed: true, retrySuppressedFault: "auth" });

    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("fails closed when reconnect grants cannot carry retained artifact data", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x6d);
    fixture.registerHandler("fixture_downgrade_artifact", "read_only", () => ({
      files: [{
        fileName: "downgrade.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_downgrade_artifact" });
    const firstBinding = new RecordingBinding("wss", "artifact-before-downgrade");
    const firstPeer = new BridgeGatewayPeer(
      simulator,
      firstBinding,
      helloAck("artifact-before-downgrade"),
      { idFactory: uuid },
    );
    await firstPeer.handleInbound(invocation);
    await firstPeer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(firstBinding.sent[1]).toMatchObject({ type: "partial", seq: 2 });

    const downgradedAck = helloAck("artifact-after-downgrade");
    downgradedAck.payload.granted_capabilities = ["journal_v1"];
    const secondBinding = new RecordingBinding("wss", "artifact-after-downgrade");
    const secondPeer = new BridgeGatewayPeer(simulator, secondBinding, downgradedAck, { idFactory: uuid });
    await secondPeer.resumeSession(rsid);
    await expect(secondPeer.handleInbound({
      v: 1,
      type: "resume_ack",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid,
        last_rx_seq: 1,
        resume_expires_at: "2026-07-23T00:00:00.000Z",
      },
    })).rejects.toMatchObject({ faultClass: "protocol" });
    expect(secondBinding.sent).toHaveLength(1);

    await expect(secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]))).rejects.toMatchObject({
      faultClass: "protocol",
    });
    expect(secondBinding.sent).toHaveLength(1);
    await secondPeer.unregisterSession(rsid, "operator_requested");
    expect(journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    expect(existsSync(join(root.path, "spool", rsid, invocation.payload.invocation_id))).toBe(false);
    expect(journal.deliveryCarriersNeedingExpiry()).toEqual([]);

    await secondPeer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps identical invocation ids isolated by rsid and expires each session independently", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_composite_artifact", "read_only", () => ({
      files: [{
        fileName: "composite.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("composite", "utf8").toString("base64"),
      }],
    }));
    const firstRsid = uuid();
    const secondRsid = uuid();
    const invocationId = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid: firstRsid });
    const firstSession = simulator.getSession(firstRsid);
    if (firstSession === null) throw new Error("first composite session was not attached");
    simulator.attachSession({
      ...firstSession,
      rsid: secondRsid,
      resumeToken: "second-resume-token",
    });
    const binding = new RecordingBinding("wss", "composite-artifacts");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("composite-artifacts"),
      { idFactory: uuid },
    );

    await peer.handleInbound(readInvoke({
      rsid: firstRsid,
      seq: 1,
      invocationId,
      method: "fixture_composite_artifact",
    }));
    await peer.handleInbound(readInvoke({
      rsid: secondRsid,
      seq: 1,
      invocationId,
      method: "fixture_composite_artifact",
    }));
    expect(journal.hasDurableDelivery(firstRsid, invocationId)).toBe(true);
    expect(journal.hasDurableDelivery(secondRsid, invocationId)).toBe(true);
    expect(existsSync(join(root.path, "spool", firstRsid, invocationId))).toBe(true);
    expect(existsSync(join(root.path, "spool", secondRsid, invocationId))).toBe(true);

    await peer.unregisterSession(firstRsid, "operator_requested");
    expect(journal.hasDurableDelivery(firstRsid, invocationId)).toBe(false);
    expect(journal.hasDurableDelivery(secondRsid, invocationId)).toBe(true);
    expect(existsSync(join(root.path, "spool", firstRsid, invocationId))).toBe(false);
    expect(existsSync(join(root.path, "spool", secondRsid, invocationId))).toBe(true);
    await peer.unregisterSession(secondRsid, "operator_requested");
    expect(journal.hasDurableDelivery(secondRsid, invocationId)).toBe(false);
    expect(existsSync(join(root.path, "spool", secondRsid, invocationId))).toBe(false);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("stores hello grants and never emits ungranted chunk or artifact carriers", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_large_inline", "read_only", () => ({
      blob: "x".repeat(1_100_000),
    }));
    fixture.registerHandler("fixture_ungranted_artifact", "read_only", () => ({
      files: [{
        fileName: "denied.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("denied").toString("base64"),
      }],
    }));
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const ack = helloAck("capability-gates");
    ack.payload.granted_capabilities = ["journal_v1", "artifact_result_v1"];
    const binding = new RecordingBinding("wss", "capability-gates");
    const peer = new BridgeGatewayPeer(simulator, binding, ack, { idFactory: uuid });
    expect(peer.snapshot().grantedCapabilities).toEqual(["artifact_result_v1", "journal_v1"]);

    await peer.handleInbound(readInvoke({ rsid, seq: 1, method: "fixture_large_inline" }));
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({
      type: "result",
      seq: 1,
      payload: { result: { blob: expect.any(String) } },
    });
    expect(binding.sent[0]?.payload).not.toHaveProperty("chunked");
    expect(binding.sent.some((envelope) => envelope.type === "partial")).toBe(false);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));

    await peer.handleInbound(readInvoke({ rsid, seq: 2, method: "fixture_ungranted_artifact" }));
    expect(binding.sent[1]).toMatchObject({
      type: "error",
      seq: 2,
      payload: { fault_class: "unsupported", outcome: "known" },
    });
    expect(readdirSync(join(root.path, "spool"))).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });
});
