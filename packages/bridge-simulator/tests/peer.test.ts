import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  type HelloAckEnvelope,
  type JsonValue,
  type RbpEnvelope,
  type SessionUnregister,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { discoverAddinSessions } from "../src/loopback.js";
import {
  BRIDGE_OUTBOUND_HIGH_WATER_BYTES,
  BridgeGatewayPeer,
} from "../src/peer.js";
import type { GatewayBinding } from "../src/transport.js";
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
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        while (inbound.length > 0) yield inbound.shift() as RbpEnvelope;
      },
    };
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
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
      granted_capabilities: ["journal_v1", "chunked_results", "transport_streamable_http"],
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
});
