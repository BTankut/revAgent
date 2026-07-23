import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  type HelloAckEnvelope,
  type InvokeEnvelope,
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
  BridgeGatewayPeer as RuntimeBridgeGatewayPeer,
  type BridgeGatewayPeerOptions,
} from "../src/peer.js";
import {
  GatewayTransportError,
  HttpSseGatewayBinding,
  type GatewayBinding,
} from "../src/transport.js";
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

/** Existing unit cases model a binding whose registration handshake already completed. */
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

function logicalRedelivery<T extends InvokeEnvelope | InvokeBatchEnvelope>(
  envelope: T,
  seq: number,
): T {
  return {
    ...structuredClone(envelope),
    id: uuid(),
    seq,
    ts: "2026-07-22T00:00:30.000Z",
  } as T;
}

describe("BridgeGatewayPeer executable lifecycle", () => {
  it("consumes a queued crash only on the real inbound batch dispatch path", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "inbound-crash");
    const batch = atomicBatch(rsid, 1);
    let crashSelections = 0;
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("inbound-crash"),
      {
        idFactory: uuid,
        takeInboundCrashPoint: () => {
          crashSelections += 1;
          return "after_executing_before_addin_write";
        },
      },
    );

    await expect(peer.handleInbound(batch)).rejects.toMatchObject({
      point: "after_executing_before_addin_write",
    });
    expect(crashSelections).toBe(1);
    expect(journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "dispatched",
    });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);
    expect(binding.sent).toEqual([]);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("requires resume_ack before a preattached durable session can heartbeat or dispatch on a fresh binding", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "fresh-binding-authority");
    let now = 0;
    const peer = new RuntimeBridgeGatewayPeer(
      simulator,
      binding,
      helloAck("fresh-binding-authority"),
      {
        idFactory: uuid,
        nowMs: () => now,
      },
    );

    expect(peer.snapshot().sessions).toContainEqual(expect.objectContaining({
      rsid,
      phase: "disconnected",
      dispatchAllowed: false,
    }));
    await peer.sendHeartbeat();
    expect(binding.sent).toEqual([]);
    const preResumeInvoke = readInvoke({ rsid, seq: 1 });
    await expect(peer.handleInbound(preResumeInvoke)).rejects.toThrow(`dispatch is revoked for ${rsid}`);
    expect(fixture.getExecutionCount(preResumeInvoke.payload.invocation_id)).toBe(0);
    expect(journal.loadSequence(rsid).lastRxSeq).toBe(0);

    await peer.resumeAll();
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({ type: "session_resume", payload: { rsid } });
    await peer.sendHeartbeat();
    expect(binding.sent).toHaveLength(1);

    await peer.handleInbound(resumeAck(rsid));
    expect(peer.snapshot().sessions).toContainEqual(expect.objectContaining({
      rsid,
      phase: "registered",
      dispatchAllowed: true,
    }));
    now = 10_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(binding.closeCount).toBe(0);
    const postResumeInvoke = readInvoke({ rsid, seq: 1 });
    await peer.handleInbound(postResumeInvoke);
    expect(fixture.getExecutionCount(postResumeInvoke.payload.invocation_id)).toBe(1);
    await peer.sendHeartbeat();
    expect(binding.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      payload: { sessions: [expect.objectContaining({ rsid })] },
    });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("clears the resume sync deadline before a slow post-resume context poll yields", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const resumeControlId = uuid();
    const slowContextId = uuid();
    fixture.planFault(slowContextId, { stall: true });
    const ids = [resumeControlId, slowContextId];
    let now = 0;
    const binding = new RecordingBinding("wss", "slow-resume-context");
    const peer = new RuntimeBridgeGatewayPeer(
      simulator,
      binding,
      helloAck("slow-resume-context"),
      {
        idFactory: () => ids.shift() ?? uuid(),
        nowMs: () => now,
      },
    );

    await peer.resumeAll();
    const resuming = peer.handleInbound(resumeAck(rsid));
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(slowContextId)).toBe(1);
    });
    now = 10_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(binding.closeCount).toBe(0);

    expect(fixture.releaseStall(slowContextId)).toBe(true);
    await resuming;
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

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

  it("fences heartbeat until an in-flight session registration is correlated", async () => {
    const root = temporaryRoot();
    const registeredFixture = new AddinLoopbackFixture();
    const pendingFixture = new AddinLoopbackFixture();
    const registeredRsid = uuid();
    const { simulator, journal } = await simulatorForFixture({
      fixture: registeredFixture,
      root: root.path,
      rsid: registeredRsid,
    });
    const pendingAddress = await pendingFixture.start();
    const pendingProbe = (await discoverAddinSessions({ explicitTarget: pendingAddress })).sessions[0];
    if (pendingProbe === undefined) throw new Error("pending fixture discovery failed");
    const pendingRegistration = await simulator.registrationForProbe({
      probe: pendingProbe,
      requestId: uuid(),
      userHint: "pending-user",
      hostname: "pending-host",
      fingerprint: `sha256:${"1".repeat(64)}`,
      bridgeVersion: "0.0.0",
    });
    registeredFixture.planFault(`heartbeat-${registeredRsid}`, { stall: true });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    const heartbeat = peer.sendHeartbeat();
    await vi.waitFor(() => {
      expect(registeredFixture.getPendingStallCount(`heartbeat-${registeredRsid}`)).toBe(1);
    });
    const registrationId = await peer.registerSession({
      probe: pendingProbe,
      registration: pendingRegistration,
    });
    expect(registeredFixture.releaseStall(`heartbeat-${registeredRsid}`)).toBe(true);
    await heartbeat;
    expect(binding.sent.map((envelope) => envelope.type)).toEqual(["session_register"]);

    const pendingRsid = uuid();
    await peer.handleInbound({
      v: 1,
      type: "session_registered",
      id: registrationId,
      ts: "2026-07-22T00:00:01.000Z",
      payload: {
        rsid: pendingRsid,
        resume_token: "pending-resume-token",
        resume_expires_at: "2026-07-23T00:00:00.000Z",
        principal: { tenant_id: uuid(), user_id: uuid() },
        seat: { granted: true, seat_id: uuid() },
        granted_session_capabilities: [...pendingProbe.sessionCapabilities],
      },
    });
    await peer.sendHeartbeat();
    expect(binding.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      payload: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ rsid: registeredRsid }),
          expect.objectContaining({ rsid: pendingRsid }),
        ]),
      },
    });

    await peer.close();
    journal.close();
    await registeredFixture.stop();
    await pendingFixture.stop();
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

    await peer.sendHeartbeat();
    const originalId = await peer.registerSession({ probe, registration });
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

  it("keeps heartbeat globally single-flight until the pending ACK deadline", async () => {
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
    expect(binding.sent.filter((entry) => entry.type === "heartbeat")).toHaveLength(1);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBe(15_000);
    now = 15_000;
    await expect(peer.tick(now)).resolves.toBe("disconnected");
    expect(binding.closeCount).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not overwrite a heartbeat flight when two status probes complete concurrently", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    fixture.planFault(`heartbeat-${rsid}`, { stall: true });
    fixture.planFault(`heartbeat-${rsid}`, { stall: true });
    const binding = new RecordingBinding("wss", "concurrent-heartbeat-flight");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("concurrent-heartbeat-flight"),
      { idFactory: uuid },
    );

    const first = peer.sendHeartbeat();
    const second = peer.sendHeartbeat();
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(`heartbeat-${rsid}`)).toBe(2);
    });
    expect(fixture.releaseStall(`heartbeat-${rsid}`)).toBe(true);
    expect(fixture.releaseStall(`heartbeat-${rsid}`)).toBe(true);
    await Promise.all([first, second]);

    expect(binding.sent.filter((entry) => entry.type === "heartbeat")).toHaveLength(1);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).not.toBeNull();
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 0 }]));
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("installs an unregister heartbeat fence before a re-entrant transport ACK", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new ControllableBinding(
      "wss",
      "reentrant-heartbeat-ack",
      async (envelope) => {
        if (envelope.type === "heartbeat") {
          await peer.handleInbound(heartbeatAck([]));
        }
      },
    );
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("reentrant-heartbeat-ack"),
      { idFactory: uuid },
    );

    await peer.unregisterSession(rsid, "operator_requested");

    expect(binding.sent.map((entry) => entry.type)).toEqual(["session_unregister", "heartbeat"]);
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
    expect(simulator.getSession(rsid)).toBeNull();
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not let an old binding ACK consume the current connection heartbeat flight", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let now = 0;
    const initial = new RecordingBinding("wss", "flight-binding-0");
    const replacement = new RecordingBinding("wss", "flight-binding-1");
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("flight-binding-0"), {
      idFactory: uuid,
      nowMs: () => now,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({
        binding: replacement,
        helloAck: helloAck("flight-binding-1"),
      }),
    });

    await peer.sendHeartbeat();
    now = 10_000;
    await peer.tick(now);
    await peer.handleInbound(resumeAck(rsid));
    await peer.sendHeartbeat();
    const currentDeadline = peer.snapshot().heartbeatAckDeadlineAtMs;
    expect(currentDeadline).not.toBeNull();

    await peer.handleInbound(heartbeatAck([{ rsid, seq: 0 }]), initial);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBe(currentDeadline);
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 0 }]), replacement);
    expect(peer.snapshot().heartbeatAckDeadlineAtMs).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not let an unsolicited heartbeat_ack finalize a durable unregister tombstone", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    simulator.unregisterSession(rsid, "operator_requested");
    const binding = new RecordingBinding("wss", "unsolicited-unregister-ack");
    const peer = new RuntimeBridgeGatewayPeer(
      simulator,
      binding,
      helloAck("unsolicited-unregister-ack"),
      { idFactory: uuid },
    );

    await peer.handleInbound(heartbeatAck([]));

    expect(journal.getPendingSessionUnregister(rsid)).toMatchObject({
      phase: "pending",
      reason: "operator_requested",
    });
    expect(simulator.getSession(rsid)).not.toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not mutate local lifecycle when unregister durability fails before a tombstone exists", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "unregister-no-commit");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("unregister-no-commit"),
      { idFactory: uuid },
    );
    const durability = vi.spyOn(journal, "unregisterSession").mockImplementation(() => {
      throw new Error("injected pre-commit durability failure");
    });

    await expect(peer.unregisterSession(rsid, "operator_requested")).rejects.toThrow(
      "injected pre-commit durability failure",
    );
    expect(peer.snapshot().sessions).toContainEqual(expect.objectContaining({
      rsid,
      phase: "registered",
      dispatchAllowed: true,
    }));
    expect(binding.sent).toEqual([]);
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
    durability.mockRestore();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("revokes local authority when unregister COMMIT is observable despite a post-commit error", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "unregister-post-commit-error");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("unregister-post-commit-error"),
      { idFactory: uuid },
    );
    const durableUnregister = journal.unregisterSession.bind(journal);
    const durability = vi.spyOn(journal, "unregisterSession").mockImplementation(
      (targetRsid, reason, atMs) => {
        durableUnregister(targetRsid, reason, atMs);
        throw new Error("injected post-commit fsync failure");
      },
    );

    await expect(peer.unregisterSession(rsid, "operator_requested")).rejects.toThrow(
      "injected post-commit fsync failure",
    );
    expect(journal.getPendingSessionUnregister(rsid)).toMatchObject({
      phase: "pending",
      reason: "operator_requested",
    });
    expect(peer.snapshot().sessions).toContainEqual(expect.objectContaining({
      rsid,
      phase: "unregistered",
      dispatchAllowed: false,
    }));
    expect(binding.sent).toEqual([]);
    durability.mockRestore();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not let an older heartbeat ACK finalize an unregister created while its data flush yields", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const firstRsid = uuid();
    const secondRsid = uuid();
    const { simulator, journal } = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid: firstRsid,
    });
    const firstSession = simulator.getSession(firstRsid);
    if (firstSession === null) throw new Error("first ACK-race session is missing");
    simulator.attachSession({
      ...firstSession,
      rsid: secondRsid,
      resumeToken: "ack-race-second-token",
    });
    let releaseSecondData!: () => void;
    let markSecondDataEntered!: () => void;
    const secondDataGate = new Promise<void>((resolve) => { releaseSecondData = resolve; });
    const secondDataEntered = new Promise<void>((resolve) => { markSecondDataEntered = resolve; });
    const binding = new ControllableBinding(
      "wss",
      "heartbeat-ack-flush-race",
      async (envelope) => {
        if (
          envelope.type === "doc_context_update" &&
          envelope.rsid === firstRsid &&
          envelope.seq === 2
        ) {
          markSecondDataEntered();
          await secondDataGate;
        }
      },
    );
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("heartbeat-ack-flush-race"),
      { idFactory: uuid },
    );

    await peer.pollDocumentContext(firstRsid, true);
    await peer.pollDocumentContext(firstRsid, true);
    await peer.sendHeartbeat();
    const firstAck = peer.handleInbound(heartbeatAck([
      { rsid: firstRsid, seq: 1 },
      { rsid: secondRsid, seq: 0 },
    ]));
    await secondDataEntered;

    await peer.unregisterSession(secondRsid, "operator_requested");
    expect(journal.getPendingSessionUnregister(secondRsid)).not.toBeNull();
    expect(binding.sent.filter((entry) => entry.type === "heartbeat")).toHaveLength(1);

    releaseSecondData();
    await firstAck;
    expect(journal.getPendingSessionUnregister(secondRsid)).not.toBeNull();
    expect(simulator.getSession(secondRsid)).not.toBeNull();
    const heartbeats = binding.sent.filter((entry) => entry.type === "heartbeat");
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[1]).toMatchObject({
      payload: {
        acks: [expect.objectContaining({ rsid: firstRsid })],
        sessions: [expect.objectContaining({ rsid: firstRsid })],
      },
    });

    await peer.handleInbound(heartbeatAck([{ rsid: firstRsid, seq: 2 }]));
    expect(journal.getPendingSessionUnregister(secondRsid)).toBeNull();
    expect(simulator.getSession(secondRsid)).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("replays unregister directly after failed same-session data and finalizes only after the reconnect fence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const initial = new ControllableBinding(
      "wss",
      "unregister-retry-0",
      async (envelope) => {
        if (envelope.type === "doc_context_update" || envelope.type === "session_unregister") {
          throw new GatewayTransportError("injected connection loss", {
            faultClass: "retryable_network",
          });
        }
      },
    );
    const replacement = new RecordingBinding("wss", "unregister-retry-1");
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("unregister-retry-0"), {
      idFactory: uuid,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({
        binding: replacement,
        helloAck: helloAck("unregister-retry-1"),
      }),
    });

    await expect(peer.pollDocumentContext(rsid, true)).rejects.toMatchObject({
      faultClass: "retryable_network",
    });
    expect(journal.loadSequence(rsid).outbox).toHaveLength(1);
    await peer.unregisterSession(rsid, "operator_requested");

    expect(replacement.sent.map((entry) => entry.type)).toEqual([
      "session_unregister",
      "heartbeat",
    ]);
    expect(replacement.sent.some((entry) => entry.type === "session_resume")).toBe(false);
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();
    expect(simulator.getSession(rsid)).not.toBeNull();

    await peer.handleInbound(heartbeatAck([]));
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
    expect(journal.loadSequence(rsid).outbox).toEqual([]);
    expect(simulator.getSession(rsid)).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("replays an orphaned unregister tombstone after journal reopen without resuming", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const journalPath = join(root.path, "reopen-unregister.db");
    const first = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
    });
    first.simulator.unregisterSession(rsid, "bridge_shutdown");
    first.simulator.close();
    first.journal.close();

    const journal = new DurableBridgeJournal(journalPath);
    const simulator = new BridgeSimulator(
      journal,
      new ArtifactSpool(join(root.path, "reopen-spool"), () => uuid()),
    );
    const binding = new RecordingBinding("wss", "reopen-unregister");
    const peer = new RuntimeBridgeGatewayPeer(
      simulator,
      binding,
      helloAck("reopen-unregister"),
      { idFactory: uuid },
    );

    await peer.resumeAll();
    expect(binding.sent.map((entry) => entry.type)).toEqual(["session_unregister", "heartbeat"]);
    expect(binding.sent.some((entry) => entry.type === "session_resume")).toBe(false);
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();
    await peer.handleInbound(heartbeatAck([]));
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps a confirmed tombstone across cleanup failure and completes it after reopen", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_unregister_cleanup", "read_only", () => ({
      files: [{
        fileName: "cleanup.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.alloc(2 * 1_048_576, 0x71).toString("base64"),
      }],
    }));
    const rsid = uuid();
    const journalPath = join(root.path, "confirmed-unregister.db");
    const { simulator, journal } = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName: "confirmed-spool",
    });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_unregister_cleanup" });
    const binding = new RecordingBinding("wss", "confirmed-cleanup-0");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("confirmed-cleanup-0"),
      { idFactory: uuid },
    );
    await peer.handleInbound(invocation);
    await peer.unregisterSession(rsid, "operator_requested");
    const cleanup = vi.spyOn(ArtifactSpool.prototype, "expire").mockImplementationOnce(() => {
      throw new Error("injected spool cleanup failure");
    });

    await expect(peer.handleInbound(heartbeatAck([]))).rejects.toThrow(
      "injected spool cleanup failure",
    );
    cleanup.mockRestore();
    expect(journal.getPendingSessionUnregister(rsid)).toMatchObject({
      phase: "confirmed",
      reason: "operator_requested",
    });
    expect(simulator.getSession(rsid)).toBeNull();
    expect(journal.loadSequence(rsid)).toMatchObject({
      nextTxSeq: 1,
      highestTxSeq: 0,
      outbox: [],
    });

    await peer.close();
    journal.close();
    const reopenedJournal = new DurableBridgeJournal(journalPath);
    const reopenedSimulator = new BridgeSimulator(
      reopenedJournal,
      new ArtifactSpool(join(root.path, "confirmed-spool"), () => uuid()),
    );
    const reopenedBinding = new RecordingBinding("wss", "confirmed-cleanup-1");
    const reopenedPeer = new RuntimeBridgeGatewayPeer(
      reopenedSimulator,
      reopenedBinding,
      helloAck("confirmed-cleanup-1"),
      { idFactory: uuid },
    );
    await reopenedPeer.resumeAll();

    expect(reopenedBinding.sent).toEqual([]);
    expect(reopenedJournal.getPendingSessionUnregister(rsid)).toBeNull();
    expect(existsSync(join(
      root.path,
      "confirmed-spool",
      rsid,
      invocation.payload.invocation_id,
    ))).toBe(false);
    await expect(reopenedPeer.tick(Date.now() + 10_001)).resolves.not.toBe("disconnected");
    expect(reopenedBinding.closeCount).toBe(0);

    await reopenedPeer.close();
    reopenedJournal.close();
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
    await peer.sendHeartbeat();
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    await peer.tick(now);
    expect(peer.snapshot().reconnectAttemptIndex).toBe(0);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("fences reconnect heartbeat until every durable session has a resume acknowledgement", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsidA = uuid();
    const rsidB = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid: rsidA });
    const sessionA = simulator.getSession(rsidA);
    if (sessionA === null) throw new Error("first reconnect session is missing");
    simulator.attachSession({
      ...sessionA,
      rsid: rsidB,
      resumeToken: "resume-token-b",
    });
    let now = 0;
    const initial = new RecordingBinding("streamable_http_sse", "resume-heartbeat-0");
    const replacement = new RecordingBinding("streamable_http_sse", "resume-heartbeat-1");
    const peer = new BridgeGatewayPeer(simulator, initial, helloAck("resume-heartbeat-0"), {
      idFactory: uuid,
      nowMs: () => now,
      reconnectJitter: () => 0,
      sleep: async () => undefined,
      reconnect: async () => ({
        binding: replacement,
        helloAck: helloAck("resume-heartbeat-1"),
      }),
    });

    await peer.sendHeartbeat();
    now = 10_000;
    await expect(peer.tick(now)).resolves.toBe("steady");
    expect(replacement.sent.filter((envelope) => envelope.type === "session_resume")).toHaveLength(2);
    expect(peer.snapshot().pendingResumeCount).toBe(2);

    await peer.sendHeartbeat();
    expect(replacement.sent).not.toContainEqual(expect.objectContaining({ type: "heartbeat" }));

    await peer.handleInbound(resumeAck(rsidA));
    expect(peer.snapshot().pendingResumeCount).toBe(1);
    await peer.sendHeartbeat();
    expect(replacement.sent).not.toContainEqual(expect.objectContaining({ type: "heartbeat" }));

    await peer.handleInbound(resumeAck(rsidB));
    expect(peer.snapshot().pendingResumeCount).toBe(0);
    await peer.sendHeartbeat();
    expect(replacement.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      payload: {
        acks: expect.arrayContaining([
          expect.objectContaining({ rsid: rsidA }),
          expect.objectContaining({ rsid: rsidB }),
        ]),
        sessions: expect.arrayContaining([
          expect.objectContaining({ rsid: rsidA }),
          expect.objectContaining({ rsid: rsidB }),
        ]),
      },
    });

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
    expect(peer.snapshot().backpressure).toMatchObject({
      source: "transport.bufferedAmount",
      highWaterBytes: BRIDGE_OUTBOUND_HIGH_WATER_BYTES,
      currentBufferedAmount: BRIDGE_OUTBOUND_HIGH_WATER_BYTES + 1,
      active: true,
      controlFramesSentWhileBackpressured: 1,
    });
    expect(peer.snapshot().backpressure.blockedPumpCount).toBeGreaterThan(0);
    expect(peer.snapshot().backpressure.maxObservedBufferedAmount)
      .toBe(BRIDGE_OUTBOUND_HIGH_WATER_BYTES + 1);
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
    expect(peer.snapshot().deliveryProgress.records).toContainEqual(expect.objectContaining({
      rsid,
      invocationId: expect.any(String),
      chunkFramesSent: 2,
      resultChunkFramesSent: 2,
      artifactChunkFramesSent: 0,
      terminalFramesSent: 1,
    }));
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    expect(journal.loadSequence(rsid).outbox).toEqual([]);
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("samples real HTTP/SSE unaccepted bytes and blocks the peer data pump above high water", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let fetchCall = 0;
    const messageResolvers: Array<(response: Response) => void> = [];
    const fetchMock: typeof fetch = async () => {
      fetchCall += 1;
      if (fetchCall === 1) {
        return new Response(JSON.stringify(helloAck("actual-http-backpressure")), {
          status: 201,
          headers: { "RBP-Connection-Id": "actual-http-backpressure" },
        });
      }
      if (fetchCall === 2) {
        return new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return await new Promise<Response>((resolve) => messageResolvers.push(resolve));
    };
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetchTimeoutMs: 30_000,
      fetch: fetchMock,
    });
    const ack = await binding.open({
      type: "hello",
      id: uuid(),
      ts: "2026-07-22T00:00:00.000Z",
      payload: {
        min_protocol: 1,
        max_protocol: 1,
        capabilities: [
          "journal_v1",
          "chunked_results",
          "artifact_result_v1",
          "transport_streamable_http",
        ],
        bridge_version: "bridge-test",
        device_id: "device-01",
        machine: { hostname: "WS01", os: "Windows 11" },
        addin_versions: ["fixture"],
      },
    });
    const largeBase64 = "A".repeat(1_000_000);
    const fillerSends = Array.from({ length: 9 }, (_unused, index) =>
      binding.send({
        v: 1,
        type: "partial",
        id: uuid(),
        rsid: uuid(),
        seq: index + 1,
        ts: "2026-07-22T00:00:01.000Z",
        payload: {
          kind: "chunk",
          invocation_id: uuid(),
          stream_id: "result",
          chunk_index: 0,
          encoding: "base64",
          content_type: "application/octet-stream",
          data: largeBase64,
        },
      })
    );
    await vi.waitFor(() => {
      expect(messageResolvers).toHaveLength(9);
      expect(binding.bufferedAmount).toBeGreaterThan(BRIDGE_OUTBOUND_HIGH_WATER_BYTES);
    });

    const peer = new BridgeGatewayPeer(simulator, binding, ack, { idFactory: uuid });
    await peer.handleInbound(readInvoke({ rsid, seq: 1, method: "fixture_counter" }));
    expect(peer.snapshot().queuedDataCount).toBeGreaterThan(0);
    expect(peer.snapshot().backpressure).toMatchObject({
      evidenceVersion: 1,
      source: "transport.bufferedAmount",
      active: true,
      currentBufferedAmount: binding.bufferedAmount,
    });
    expect(peer.snapshot().backpressure.blockedPumpCount).toBeGreaterThan(0);

    for (const resolve of messageResolvers) resolve(new Response(null, { status: 202 }));
    await Promise.all(fillerSends);
    expect(binding.bufferedAmount).toBe(0);
    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("emits correlated artifact progress and exposes only sanitized retained-carrier evidence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const invocation = readInvoke({
      rsid,
      seq: 1,
      method: "fixture_multi_file_output",
    });
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "artifact-progress");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("artifact-progress"), {
      idFactory: uuid,
    });

    await peer.handleInbound(invocation);
    for (let index = 0; index < 4; index += 1) {
      const sent = binding.sent.at(-1);
      if (sent === undefined || !("seq" in sent) || typeof sent.seq !== "number") {
        throw new Error("expected artifact data frame");
      }
      await peer.handleInbound(heartbeatAck([{ rsid, seq: sent.seq }]));
    }

    expect(binding.sent.map((entry) =>
      entry.type === "partial" ? `${entry.type}:${entry.payload.kind}` : entry.type
    )).toEqual([
      "partial:chunk",
      "partial:progress",
      "partial:chunk",
      "partial:progress",
      "result",
    ]);
    for (const progress of binding.sent.filter(
      (entry): entry is Extract<RbpEnvelope, { type: "partial" }> =>
        entry.type === "partial" && entry.payload.kind === "progress",
    )) {
      expect(progress).toMatchObject({
        rsid,
        payload: {
          invocation_id: invocation.payload.invocation_id,
          progress: {
            note: "bridge_chunk_delivery",
            total_chunks: 2,
          },
        },
      });
    }
    const peerEvidence = peer.snapshot().deliveryProgress;
    expect(peerEvidence).toMatchObject({
      evidenceVersion: 1,
      capacity: 128,
      totalRecordCount: 1,
      droppedRecordCount: 0,
    });
    expect(peerEvidence.records).toEqual([expect.objectContaining({
      rsid,
      invocationId: invocation.payload.invocation_id,
      chunkFramesSent: 2,
      artifactChunkFramesSent: 2,
      resultChunkFramesSent: 0,
      progressFramesSent: 2,
      terminalFramesSent: 1,
    })]);
    const spoolEvidence = simulator.artifactSpoolEvidence();
    expect(spoolEvidence).toMatchObject({
      rootPathRedacted: true,
      rawPathExposed: false,
      carrierCount: 1,
      retainedFileCount: 2,
      totalChunks: 2,
      carriers: [{
        rsid,
        invocationId: invocation.payload.invocation_id,
        kind: "artifacts",
        streamCount: 2,
      }],
    });
    expect(JSON.stringify(spoolEvidence)).not.toContain(root.path);
    expect(JSON.stringify(spoolEvidence)).not.toContain("retainedDirectory");
    expect(JSON.stringify(spoolEvidence)).not.toContain("retainedFiles");

    const terminal = binding.sent.at(-1);
    if (terminal === undefined || !("seq" in terminal) || typeof terminal.seq !== "number") {
      throw new Error("expected terminal artifact result");
    }
    await peer.handleInbound(heartbeatAck([{ rsid, seq: terminal.seq }]));
    expect(simulator.artifactSpoolEvidence().carrierCount).toBe(0);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps distinct raw, local, and traversal source paths out of transport and spool evidence", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "artifact-path-redaction");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("artifact-path-redaction"), {
      idFactory: uuid,
    });
    const vectors = [
      {
        scenario: "raw_path",
        secretPath: "C:\\revagent-fixture-private\\raw-artifact.bin",
        params: { scenario: "raw_path" },
      },
      {
        scenario: "local_path",
        secretPath: "C:\\private-workstation\\local-artifact-secret.bin",
        params: {
          scenario: "local_path",
          path: "C:\\private-workstation\\local-artifact-secret.bin",
        },
      },
      {
        scenario: "traversal_path",
        secretPath: "..\\private-traversal-secret.bin",
        params: {
          scenario: "traversal_path",
          path: "..\\private-traversal-secret.bin",
        },
      },
    ] as const;

    for (const [index, vector] of vectors.entries()) {
      const before = binding.sent.length;
      await peer.handleInbound(readInvoke({
        rsid,
        seq: index + 1,
        method: "fixture_multi_file_output",
        params: vector.params,
      }));
      expect(binding.sent).toHaveLength(before + 1);
      const terminal = binding.sent.at(-1);
      expect(terminal).toMatchObject({
        type: "error",
        payload: {
          fault_class: "parameter",
          message: "declared artifact source could not be captured",
        },
      });
      if (terminal === undefined || !("seq" in terminal) || typeof terminal.seq !== "number") {
        throw new Error(`expected ${vector.scenario} terminal error`);
      }
      expect(JSON.stringify(terminal)).not.toContain(vector.secretPath);
      await peer.handleInbound(heartbeatAck([{ rsid, seq: terminal.seq }]));
    }

    const serializedWire = JSON.stringify(binding.sent);
    for (const vector of vectors) expect(serializedWire).not.toContain(vector.secretPath);
    const spoolEvidence = simulator.artifactSpoolEvidence();
    expect(spoolEvidence).toMatchObject({
      evidenceVersion: 1,
      carrierCount: 0,
      retainedFileCount: 0,
      rawPathExposed: false,
    });
    const serializedEvidence = JSON.stringify(spoolEvidence);
    expect(serializedEvidence).not.toContain(root.path);
    for (const vector of vectors) expect(serializedEvidence).not.toContain(vector.secretPath);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("bounds per-invocation delivery progress evidence with explicit drop accounting", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "bounded-delivery-progress");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck("bounded-delivery-progress"), {
      idFactory: uuid,
    });

    for (let seq = 1; seq <= 129; seq += 1) {
      const invocation = readInvoke({ rsid, seq, method: "fixture_counter" });
      await peer.handleInbound(invocation);
      const terminal = binding.sent.at(-1);
      if (terminal === undefined || !("seq" in terminal) || typeof terminal.seq !== "number") {
        throw new Error("expected terminal result");
      }
      await peer.handleInbound(heartbeatAck([{ rsid, seq: terminal.seq }]));
    }
    const evidence = peer.snapshot().deliveryProgress;
    expect(evidence).toMatchObject({
      evidenceVersion: 1,
      capacity: 128,
      totalRecordCount: 129,
      droppedRecordCount: 1,
    });
    expect(evidence.records).toHaveLength(128);

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
    await peer.flushOutbound(rsid);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      rsid,
      seq: 1,
      payload: {
        invocation_id: mutation.payload.invocation_id,
        fault_class: "journal_indeterminate",
        outcome: "indeterminate",
        verification_required: true,
        verification_hold_id: hold.holdId,
        replayed: true,
      },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    const batch = atomicBatch(rsid, 2);
    await peer.handleInbound(batch);
    expect(binding.sent[1]).toMatchObject({
      type: "error",
      rsid,
      seq: 2,
      payload: {
        batch_id: batch.payload.batch_id,
        fault_class: "journal_indeterminate",
        outcome: "indeterminate",
        verification_required: true,
        verification_hold_id: hold.holdId,
        mutation_scope: hold.mutationScope,
      },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    await peer.handleInbound(logicalRedelivery(batch, 3));
    expect(binding.sent[2]).toMatchObject({
      type: "error",
      seq: 3,
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
      const rejectedAfterUnregister = mutationInvoke({ rsid, seq: 2 });
      await expect(peer.handleInbound(rejectedAfterUnregister)).resolves.toBeUndefined();
      expect(fixture.getExecutionCount(rejectedAfterUnregister.payload.invocation_id)).toBe(0);
      expect(journal.getPendingSessionUnregister(rsid)).toMatchObject({ rsid, reason });
      await peer.handleInbound(heartbeatAck([]));
      expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
      expect(simulator.getSession(rsid)).toBeNull();
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

  it("does not resurrect an unregistered session after an in-flight data send or treat its late ACK as connection-fatal", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    let releaseSend!: () => void;
    let markSendEntered!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendEntered = new Promise<void>((resolve) => { markSendEntered = resolve; });
    const binding = new ControllableBinding(
      "wss",
      "unregister-pump-race",
      async (envelope) => {
        if (envelope.type === "doc_context_update" && envelope.rsid === rsid) {
          markSendEntered();
          await sendGate;
        }
      },
    );
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("unregister-pump-race"),
      { idFactory: uuid },
    );

    // Keep an older active-session heartbeat in flight. Its late ACK must
    // release the global heartbeat slot, not finalize a later unregister.
    await peer.sendHeartbeat();
    const pumping = peer.pollDocumentContext(rsid, true);
    await sendEntered;
    expect(binding.sent[1]).toMatchObject({ type: "doc_context_update", rsid, seq: 1 });

    await peer.unregisterSession(rsid, "operator_requested");
    expect(binding.sent[2]).toMatchObject({
      type: "session_unregister",
      payload: { rsid, reason: "operator_requested" },
    });
    expect(journal.loadSequence(rsid)).toMatchObject({
      lastRxSeq: 0,
      nextTxSeq: 2,
      highestTxSeq: 1,
    });
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();

    releaseSend();
    await pumping;
    await expect(peer.handleInbound(heartbeatAck([{ rsid, seq: 0 }]))).resolves.toBeUndefined();
    expect(binding.closeCount).toBe(0);
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();
    expect(binding.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      payload: { acks: [], sessions: [] },
    });

    await expect(peer.handleInbound(heartbeatAck([]))).resolves.toBeUndefined();
    expect(journal.getPendingSessionUnregister(rsid)).toBeNull();
    expect(simulator.getSession(rsid)).toBeNull();
    expect(journal.loadSequence(rsid)).toMatchObject({ nextTxSeq: 1, highestTxSeq: 0, outbox: [] });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("does not leak an unregistered rsid into a heartbeat that was awaiting add-in status", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    fixture.planFault(`heartbeat-${rsid}`, { stall: true });
    const binding = new RecordingBinding("wss", "unregister-heartbeat-race");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("unregister-heartbeat-race"),
      { idFactory: uuid },
    );

    const heartbeat = peer.sendHeartbeat();
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(`heartbeat-${rsid}`)).toBe(1);
    });
    await peer.unregisterSession(rsid, "operator_requested");
    await heartbeat;

    expect(binding.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session_unregister",
        payload: { rsid, reason: "operator_requested" },
      }),
      expect.objectContaining({
        type: "heartbeat",
        payload: expect.objectContaining({ acks: [], sessions: [] }),
      }),
    ]));
    const staleHeartbeat = binding.sent.find((envelope) =>
      envelope.type === "heartbeat" && JSON.stringify(envelope.payload).includes(rsid)
    );
    expect(staleHeartbeat).toBeUndefined();
    expect(binding.closeCount).toBe(0);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("accepts adjacent same-rsid sequences concurrently without a false sequence gap", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const first = readInvoke({ rsid, seq: 1 });
    const second = readInvoke({ rsid, seq: 2 });
    fixture.planFault(first.payload.invocation_id, { delayMs: 100 });
    const binding = new RecordingBinding("wss", "same-rsid-adjacent-sequences");
    binding.inbound.push(first, second);
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("same-rsid-adjacent-sequences"),
      { idFactory: uuid },
    );

    await expect(peer.run()).resolves.toBeUndefined();

    expect(journal.loadSequence(rsid).lastRxSeq).toBe(2);
    expect(journal.getInvocation(rsid, first.payload.invocation_id)).toMatchObject({
      state: "completed",
      terminalOutcome: { status: "completed" },
    });
    expect(journal.getInvocation(rsid, second.payload.invocation_id)).toMatchObject({
      state: "failed",
      terminalOutcome: {
        status: "failed",
        payload: {
          fault_class: "protocol",
          message: "per-session dispatch window is occupied",
        },
      },
    });
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      // seq=1 is still executing and has no durable delivery plan yet.
      ack: 0,
      payload: {
        invocation_id: second.payload.invocation_id,
        fault_class: "protocol",
        message: "per-session dispatch window is occupied",
      },
    });
    expect(JSON.stringify(binding.sent)).not.toContain("sequence rejected");
    expect(fixture.getExecutionCount(first.payload.invocation_id)).toBe(1);
    expect(fixture.getExecutionCount(second.payload.invocation_id)).toBe(0);

    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(binding.sent[1]).toMatchObject({
      type: "result",
      ack: 2,
      payload: { invocation_id: first.payload.invocation_id },
    });

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("ACKs an identical invoke retransmission without entering journal redelivery", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = mutationInvoke({ rsid, seq: 1 });
    fixture.planFault(invocation.payload.invocation_id, { stall: true });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    const executing = peer.handleInbound(invocation);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(invocation.payload.invocation_id)).toBe(1);
    });

    await expect(peer.handleInbound(structuredClone(invocation))).resolves.toBeUndefined();
    expect(binding.sent).toEqual([]);
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "executing",
      verificationHoldId: null,
      lateTerminalOutcome: null,
    });

    expect(fixture.releaseStall(invocation.payload.invocation_id)).toBe(true);
    await executing;
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({
      type: "result",
      ack: 1,
      payload: { invocation_id: invocation.payload.invocation_id, replayed: false },
    });
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "completed",
      verificationHoldId: null,
      lateTerminalOutcome: null,
    });
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await expect(peer.handleInbound(structuredClone(invocation))).resolves.toBeUndefined();
    expect(binding.sent).toHaveLength(1);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("rejects same-sequence invoke identity reuse as a protocol fault", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = readInvoke({ rsid, seq: 1 });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

    await peer.handleInbound(invocation);
    expect(binding.sent).toHaveLength(1);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await expect(peer.handleInbound({
      ...structuredClone(invocation),
      id: uuid(),
    })).rejects.toThrow("invoke sequence rejected: protocol_fault");
    expect(binding.sent).toHaveLength(1);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await peer.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  for (const atomic of [false, true] as const) {
    it(`does not redispatch an identical ${atomic ? "atomic" : "non-atomic"} batch retransmission`, async () => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
      const canonical = atomicBatch(rsid, 1);
      const batch = atomic ? canonical : asNonAtomicBatch(canonical);
      const firstStep = batch.payload.steps[0];
      if (firstStep === undefined) throw new Error("test batch is empty");
      const stallId = atomic ? batch.payload.batch_id : firstStep.invocation_id;
      fixture.planFault(stallId, { stall: true });
      const binding = new RecordingBinding("wss");
      const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });

      const executing = peer.handleInbound(batch);
      await vi.waitFor(() => {
        expect(fixture.getPendingStallCount(stallId)).toBe(1);
      });

      await expect(peer.handleInbound(structuredClone(batch))).resolves.toBeUndefined();
      expect(binding.sent).toEqual([]);
      for (const step of batch.payload.steps) {
        expect(journal.getInvocation(rsid, step.invocation_id)).not.toMatchObject({
          state: "indeterminate",
        });
        expect(journal.getInvocation(rsid, step.invocation_id)?.verificationHoldId ?? null).toBeNull();
      }

      expect(fixture.releaseStall(stallId)).toBe(true);
      await executing;
      expect(binding.sent).toHaveLength(1);
      expect(binding.sent[0]).toMatchObject({
        type: "result",
        ack: 1,
        payload: { kind: "batch", batch_id: batch.payload.batch_id, replayed: false },
      });

      await expect(peer.handleInbound(structuredClone(batch))).resolves.toBeUndefined();
      expect(binding.sent).toHaveLength(1);
      if (atomic) {
        expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);
      } else {
        for (const step of batch.payload.steps) {
          expect(fixture.getExecutionCount(step.invocation_id)).toBe(1);
        }
      }

      await peer.close();
      journal.close();
      await fixture.stop();
      root.cleanup();
    });
  }

  it("recovers only the cancel obligation after an accepted pre-dispatch invoke is cancelled", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const journalPath = join(root.path, "cancel-before-dispatch.db");
    const invocation = readInvoke({ rsid, seq: 1 });

    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    await expect(first.simulator.invoke(invocation, {
      crashAt: "after_received_before_dispatch",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({
      type: "invoke",
      state: "journaled",
    });
    expect(first.journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "received",
      terminalOutcome: null,
    });
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);
    first.simulator.close();
    first.journal.close();

    const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const secondBinding = new RecordingBinding("wss", "cancel-before-dispatch");
    const secondPeer = new BridgeGatewayPeer(
      second.simulator,
      secondBinding,
      helloAck("cancel-before-dispatch"),
      { idFactory: uuid },
    );
    expect(secondPeer.snapshot().queuedDataCount).toBe(0);

    await secondPeer.handleInbound({
      v: 1,
      type: "cancel",
      id: uuid(),
      rsid,
      seq: 2,
      ts: "2026-07-22T00:00:01.000Z",
      payload: { invocation_id: invocation.payload.invocation_id, reason: "user_requested" },
    });
    expect(secondBinding.sent).toHaveLength(1);
    expect(secondBinding.sent[0]).toMatchObject({
      type: "error",
      ack: 2,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "cancelled",
        outcome: "known",
        replayed: false,
      },
    });
    expect(second.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "no_reply" });
    expect(second.journal.getInboundWork(rsid, 2)).toMatchObject({
      type: "cancel",
      state: "delivery_ready",
    });
    expect(second.journal.listInboundWork(rsid)).toHaveLength(2);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);

    await secondPeer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(second.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(0);
    await secondPeer.close();
    second.journal.close();

    const third = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
    const thirdBinding = new RecordingBinding("wss", "cancel-before-dispatch-restart");
    const thirdPeer = new BridgeGatewayPeer(
      third.simulator,
      thirdBinding,
      helloAck("cancel-before-dispatch-restart"),
      { idFactory: uuid },
    );
    expect(thirdPeer.snapshot().queuedDataCount).toBe(0);
    await thirdPeer.flushOutbound(rsid);
    expect(thirdBinding.sent).toEqual([]);
    expect(third.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "no_reply" });
    expect(third.journal.getInboundWork(rsid, 2)).toBeNull();
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);

    await thirdPeer.close();
    third.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it.each([
    { name: "read", mutating: false },
    { name: "mutation", mutating: true },
  ] as const)(
    "resumes a journaled exact $name retransmit without a window=1 ACK deadlock",
    async ({ name, mutating }) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const journalPath = join(root.path, `journaled-exact-${name}.db`);
      const invocation = mutating
        ? mutationInvoke({ rsid, seq: 1 })
        : readInvoke({ rsid, seq: 1 });

      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      await expect(first.simulator.invoke(invocation, {
        crashAt: "after_received_before_dispatch",
      })).rejects.toBeInstanceOf(InjectedBridgeCrash);
      expect(first.journal.inspectInboundWork(rsid)).toMatchObject({
        lastRxSeq: 1,
        acknowledgeableRxSeq: 0,
        work: [{ seq: 1, state: "journaled" }],
      });
      expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);
      first.simulator.close();
      first.journal.close();

      const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      const binding = new RecordingBinding("wss", `journaled-exact-${name}`);
      const peer = new BridgeGatewayPeer(
        second.simulator,
        binding,
        helloAck(`journaled-exact-${name}`),
        { idFactory: uuid },
      );
      await peer.resumeSession(rsid);
      expect(binding.sent[0]).toMatchObject({
        type: "session_resume",
        payload: { rsid, last_rx_seq: 0 },
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
        type: "doc_context_update",
        rsid,
        seq: 1,
        ack: 0,
      });
      expect(second.simulator.retransmit(rsid, "2026-07-22T00:00:02.000Z")[0]).toMatchObject({
        seq: 1,
        ack: 0,
      });
      await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));

      await peer.handleInbound(structuredClone(invocation));
      const terminal = binding.sent[2];
      expect(terminal).toBeDefined();
      expect(validateRbpEnvelope(terminal as RbpEnvelope)).toBe(true);
      expect(terminal).toMatchObject({
        rsid,
        seq: 2,
        ack: 1,
        payload: { invocation_id: invocation.payload.invocation_id },
      });
      if (mutating) {
        expect(terminal).toMatchObject({
          type: "error",
          payload: {
            fault_class: "journal_indeterminate",
            outcome: "indeterminate",
            verification_hold_id: expect.stringMatching(/^vh:/u),
          },
        });
        expect(second.journal.listHolds()).toMatchObject([{ state: "active" }]);
        expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(0);
      } else {
        expect(terminal).toMatchObject({
          type: "result",
          payload: { status: "completed", replayed: false },
        });
        expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
      }
      expect(second.journal.acknowledgeableRxSeq(rsid)).toBe(1);

      await peer.close();
      second.journal.close();
      await fixture.stop();
      root.cleanup();
    },
  );

  it.each([
    { name: "atomic", atomic: true },
    { name: "non-atomic", atomic: false },
  ] as const)(
    "resumes a journaled exact $name batch retransmit after restart",
    async ({ name, atomic }) => {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      const rsid = uuid();
      const journalPath = join(root.path, `journaled-exact-${name}-batch.db`);
      const template = atomicBatch(rsid, 1);
      const batch = atomic ? template : asNonAtomicBatch(template);

      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      await expect(first.simulator.invokeBatch(batch, {
        crashAt: "after_received_before_dispatch",
      })).rejects.toBeInstanceOf(InjectedBridgeCrash);
      expect(first.journal.inspectInboundWork(rsid)).toMatchObject({
        lastRxSeq: 1,
        acknowledgeableRxSeq: 0,
        work: [{ seq: 1, state: "journaled", correlationId: batch.payload.batch_id }],
      });
      expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);
      for (const step of batch.payload.steps) {
        expect(fixture.getExecutionCount(step.invocation_id)).toBe(0);
      }
      first.simulator.close();
      first.journal.close();

      const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath });
      await expect(second.simulator.heartbeat()).resolves.toMatchObject({
        acks: [{ rsid, seq: 0 }],
      });
      const binding = new RecordingBinding("wss", `journaled-exact-${name}-batch`);
      const peer = new BridgeGatewayPeer(
        second.simulator,
        binding,
        helloAck(`journaled-exact-${name}-batch`),
        { idFactory: uuid },
      );
      await peer.resumeSession(rsid);
      expect(binding.sent[0]).toMatchObject({
        type: "session_resume",
        payload: { rsid, last_rx_seq: 0 },
      });
      await peer.handleInbound(resumeAck(rsid));
      expect(binding.sent[1]).toMatchObject({
        type: "doc_context_update",
        rsid,
        seq: 1,
        ack: 0,
      });
      await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));

      await peer.handleInbound(structuredClone(batch));
      const terminal = binding.sent[2];
      expect(terminal).toBeDefined();
      expect(validateRbpEnvelope(terminal as RbpEnvelope)).toBe(true);
      expect(terminal).toMatchObject({
        type: "result",
        rsid,
        seq: 2,
        ack: 1,
        payload: {
          kind: "batch",
          batch_id: batch.payload.batch_id,
          status: "completed",
          replayed: false,
        },
      });
      if (atomic) expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);
      else {
        expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);
        for (const step of batch.payload.steps) {
          expect(fixture.getExecutionCount(step.invocation_id)).toBe(1);
        }
      }
      expect(second.journal.acknowledgeableRxSeq(rsid)).toBe(1);

      await peer.close();
      second.journal.close();
      await fixture.stop();
      root.cleanup();
    },
  );

  it("treats duplicate cancel as a no-op while applying its refreshed piggyback ACK", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const invocation = readInvoke({ rsid, seq: 1 });
    const binding = new RecordingBinding("wss");
    const peer = new BridgeGatewayPeer(simulator, binding, helloAck(), { idFactory: uuid });
    await peer.handleInbound(invocation);
    expect(binding.sent[0]).toMatchObject({
      type: "result",
      seq: 1,
      payload: { invocation_id: invocation.payload.invocation_id },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    const context = await simulator.documentContext(rsid, uuid());
    simulator.queueOutbound(rsid, {
      type: "doc_context_update",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: context as unknown as JsonValue,
    });
    await peer.flushOutbound(rsid);
    expect(binding.sent).toHaveLength(2);
    expect(journal.loadSequence(rsid)).toMatchObject({ lastRxSeq: 1, lastPeerAck: 1 });
    expect(journal.loadSequence(rsid).outbox).toHaveLength(1);

    const cancel = {
      v: 1 as const,
      type: "cancel" as const,
      id: uuid(),
      rsid,
      seq: 2,
      ts: "2026-07-22T00:00:02.000Z",
      payload: { invocation_id: invocation.payload.invocation_id, reason: "user_requested" as const },
    };
    await peer.handleInbound(cancel);
    await peer.handleInbound({
      ...structuredClone(cancel),
      ack: 2,
      ts: "2026-07-22T00:00:03.000Z",
    });

    expect(binding.sent).toHaveLength(2);
    expect(journal.loadSequence(rsid)).toMatchObject({
      lastRxSeq: 2,
      lastPeerAck: 2,
      outbox: [],
    });
    expect(journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "completed",
      abandoned: false,
    });

    await peer.close();
    journal.close();
    await fixture.stop();
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

    await peer.handleInbound(logicalRedelivery(batch, 2));
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

    await peer.handleInbound(logicalRedelivery(batch, 2));
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

  it("emits a schema-valid provisional carrier when an all-read atomic batch loses its response", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const template = atomicBatch(rsid, 1);
    const firstRead = template.payload.steps[0];
    if (firstRead === undefined) throw new Error("all-read atomic test requires a read template");
    const steps: InvokeBatchEnvelope["payload"]["steps"] = [
      firstRead,
      { ...firstRead, invocation_id: uuid() },
    ];
    const timeoutMs = 25;
    const batch: InvokeBatchEnvelope = {
      ...template,
      payload: {
        ...template.payload,
        timeout_ms: timeoutMs,
        steps,
        batch_digest: makeBatchDigest({
          atomic: true,
          batch_id: template.payload.batch_id,
          timeout_ms: timeoutMs,
          recovery_clearances: [],
          steps: steps.map((step) => ({
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
    fixture.planFault(batch.payload.batch_id, { delayMs: 100 });
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const binding = new RecordingBinding("wss", "all-read-atomic-timeout");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("all-read-atomic-timeout"),
      { idFactory: uuid },
    );

    await peer.handleInbound(batch);
    const provisional = binding.sent[0];
    expect(provisional).toBeDefined();
    expect(validateRbpEnvelope(provisional as RbpEnvelope)).toBe(true);
    expect(provisional).toMatchObject({
      type: "result",
      rsid,
      ack: 1,
      payload: {
        kind: "batch",
        atomic: true,
        status: "failed",
        transaction_state: "rolled_back",
        failed_step_index: 0,
        steps: [
          { index: 0, status: "failed", error: { fault_class: "environment" } },
          { index: 1, status: "failed", error: { fault_class: "environment" } },
        ],
      },
    });
    expect(journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
      state: "indeterminate",
      terminalJson: null,
    });
    for (const step of steps) {
      expect(journal.getInvocation(rsid, step.invocation_id)).toMatchObject({
        state: "executing",
        terminalOutcome: null,
      });
    }

    await vi.waitFor(() => {
      expect(journal.getBatchCoordination(batch.payload.batch_id)).toMatchObject({
        state: "terminal",
        terminalJson: expect.any(String),
      });
    }, { timeout: 2_000 });
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(1);

    await peer.close();
    journal.close();
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
    await peer.handleInbound(logicalRedelivery(batch, 2));
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

    await peer.handleInbound(logicalRedelivery(invocation, 2));
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

  it("does not recover or expose an abandoned late artifact carrier after restart", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x71);
    fixture.registerHandler("fixture_abandoned_late_artifact", "read_only", () => ({
      report: "must-remain-hidden",
      files: [{
        fileName: "abandoned-late.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const journalPath = join(root.path, "abandoned-late-artifact.db");
    const spoolName = "abandoned-late-artifact-spool";
    const invocation = readInvoke({
      rsid,
      seq: 1,
      method: "fixture_abandoned_late_artifact",
    });

    const first = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName,
    });
    fixture.planFault(invocation.payload.invocation_id, { stall: true });
    const executing = first.simulator.invoke(invocation);
    await vi.waitFor(() => {
      expect(fixture.getPendingStallCount(invocation.payload.invocation_id)).toBe(1);
    });
    expect(first.simulator.cancelEnvelope({
      v: 1,
      type: "cancel",
      id: uuid(),
      rsid,
      seq: 2,
      ts: "2026-07-22T00:00:01.000Z",
      payload: { invocation_id: invocation.payload.invocation_id, reason: "user_requested" },
    })).toBeNull();
    expect(fixture.releaseStall(invocation.payload.invocation_id)).toBe(true);
    await expect(executing).resolves.toMatchObject({
      kind: "error",
      faultClass: "cancelled",
      replayed: false,
      addinContacted: true,
    });
    expect(first.journal.getInvocation(rsid, invocation.payload.invocation_id)).toMatchObject({
      state: "completed",
      abandoned: true,
      terminalOutcome: {
        status: "completed",
        payload: { artifact_carrier: expect.any(Object) },
      },
    });
    expect(first.journal.getInboundWork(rsid, 1)).toMatchObject({ state: "reply_ready" });
    expect(first.journal.getInboundWork(rsid, 2)).toMatchObject({ state: "no_reply" });
    expect(first.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(false);
    first.simulator.close();
    first.journal.close();

    const second = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath,
      spoolName,
    });
    const binding = new RecordingBinding("wss", "abandoned-late-artifact-restart");
    const peer = new BridgeGatewayPeer(
      second.simulator,
      binding,
      helloAck("abandoned-late-artifact-restart"),
      { idFactory: uuid },
    );

    expect(second.simulator.recoverableDurableDeliveries()).toEqual([]);
    expect(second.journal.hasDurableDelivery(rsid, invocation.payload.invocation_id)).toBe(false);
    expect(second.journal.deliveryCarriersNeedingCleanup()).toEqual([]);
    expect(second.journal.pendingDurableDeliveryDraftCount(rsid)).toBe(1);
    await peer.flushOutbound(rsid);
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]).toMatchObject({
      type: "error",
      rsid,
      seq: 1,
      ack: 2,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        fault_class: "cancelled",
        outcome: "known",
        replayed: true,
      },
    });
    expect(JSON.stringify(binding.sent[0])).not.toContain("artifact");
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);

    await peer.close();
    second.journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("keeps the original artifact carrier deliverable while logical redelivery returns only its digest", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const artifactBytes = Buffer.alloc(2 * 1_048_576, 0x62);
    fixture.registerHandler("fixture_active_artifact_redelivery", "read_only", () => ({
      report: "active-carrier",
      files: [{
        fileName: "active-carrier.bin",
        contentType: "application/octet-stream",
        contentBase64: artifactBytes.toString("base64"),
      }],
    }));
    const rsid = uuid();
    const spoolName = "active-redelivery-spool";
    const invocation = readInvoke({
      rsid,
      seq: 1,
      method: "fixture_active_artifact_redelivery",
    });
    const { simulator, journal } = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      spoolName,
    });
    const binding = new RecordingBinding("wss", "active-artifact-redelivery");
    const peer = new BridgeGatewayPeer(
      simulator,
      binding,
      helloAck("active-artifact-redelivery"),
      { idFactory: uuid },
    );

    await peer.handleInbound(invocation);
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
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBe("active");
    expect(existsSync(join(root.path, spoolName, rsid, invocation.payload.invocation_id))).toBe(true);

    await expect(peer.handleInbound(logicalRedelivery(invocation, 2))).resolves.toBeUndefined();
    expect(binding.sent).toHaveLength(1);
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBe("active");
    expect(journal.pendingDurableDeliveryDraftCount(rsid)).toBe(3);

    await peer.handleInbound(heartbeatAck([{ rsid, seq: 1 }]));
    expect(binding.sent[1]).toMatchObject({
      type: "partial",
      rsid,
      seq: 2,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        kind: "chunk",
        chunk_index: 1,
        artifact_index: 0,
      },
    });
    await peer.handleInbound(heartbeatAck([{ rsid, seq: 2 }]));
    const originalTerminal = binding.sent[2];
    expect(originalTerminal).toMatchObject({
      type: "result",
      rsid,
      seq: 3,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        replayed: false,
        result: {
          report: "active-carrier",
          files: [{ artifact_id: expect.any(String), artifact_index: 0 }],
        },
        artifacts: [{
          filename: "active-carrier.bin",
          total_chunks: 2,
          total_size: artifactBytes.byteLength,
        }],
        result_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBe("active");

    await peer.handleInbound(heartbeatAck([{ rsid, seq: 3 }]));
    const redeliveryTerminal = binding.sent[3];
    expect(redeliveryTerminal).toMatchObject({
      type: "result",
      rsid,
      seq: 4,
      payload: {
        invocation_id: invocation.payload.invocation_id,
        replayed: true,
        payload_omitted: true,
        result_digest: (originalTerminal as Extract<RbpEnvelope, { type: "result" }>).payload.result_digest,
      },
    });
    expect(JSON.stringify(redeliveryTerminal)).not.toContain("artifacts");
    expect(fixture.getExecutionCount(invocation.payload.invocation_id)).toBe(1);
    expect(journal.durableDeliveryDisposition(rsid, invocation.payload.invocation_id)).toBe("acked");

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
    await secondPeer.handleInbound(logicalRedelivery(invocation, 2));
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
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();
    simulator.finalizeSessionUnregister(rsid);
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
    expect(journal.getPendingSessionUnregister(rsid)).not.toBeNull();
    await secondPeer.handleInbound(heartbeatAck([]));
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
    expect(journal.getPendingSessionUnregister(firstRsid)).not.toBeNull();
    await peer.handleInbound(heartbeatAck([{ rsid: secondRsid, seq: 0 }]));
    expect(journal.hasDurableDelivery(firstRsid, invocationId)).toBe(false);
    expect(journal.hasDurableDelivery(secondRsid, invocationId)).toBe(true);
    expect(existsSync(join(root.path, "spool", firstRsid, invocationId))).toBe(false);
    expect(existsSync(join(root.path, "spool", secondRsid, invocationId))).toBe(true);
    await peer.unregisterSession(secondRsid, "operator_requested");
    await peer.handleInbound(heartbeatAck([]));
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
