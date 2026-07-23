import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";

import {
  createReceivedJournalRecord,
  makeBatchDigest,
  makeMutationHoldId,
  makeParamsDigest,
  markJournalExecuting,
  recordJournalTerminal,
  type RbpEnvelope,
  type SessionRegister,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  GatewayStubCore,
  RecoveryHoldConflictError,
  WindowViolationError,
} from "../src/core.js";
import type { StaticTokenTable } from "../src/types.js";
import {
  controlEnvelope,
  DIGEST,
  hello,
  MemoryTransport,
  mutatingInvoke,
  NOW,
  readInvoke,
  resultEnvelope,
  sessionRegister,
  statePath,
  TOKEN,
  tokenTable,
  uuid7,
} from "./helpers.js";

const encoder = new TextEncoder();

async function connectedCore(
  name: string,
  clock?: { nowMs(): number },
  options: {
    connectionCapabilities?: readonly string[];
    sessionCapabilities?: readonly string[];
    registration?: SessionRegister;
    tokenTable?: StaticTokenTable;
    stateStoreTestHooks?: {
      beforeCanonicalReplace?: () => void | Promise<void>;
      afterCanonicalReplace?: () => void | Promise<void>;
    };
  } = {},
): Promise<{
  core: GatewayStubCore;
  transport: MemoryTransport;
  rsid: string;
  resumeToken: string;
  statePath: string;
}> {
  const path = await statePath(name);
  const core = await GatewayStubCore.create({
    statePath: path,
    tokenTable: options.tokenTable ?? tokenTable,
    ...(options.stateStoreTestHooks === undefined
      ? {}
      : { stateStoreTestHooks: options.stateStoreTestHooks }),
    clock,
    ...(options.connectionCapabilities === undefined
      ? {}
      : { connectionCapabilities: options.connectionCapabilities }),
    ...(options.sessionCapabilities === undefined
      ? {}
      : { sessionCapabilities: options.sessionCapabilities }),
  });
  const device = core.authenticate(TOKEN);
  const connectionId = await core.allocateConnectionId(device);
  const transport = new MemoryTransport(connectionId, "wss", device);
  core.attachConnection(transport);
  await core.acceptHello(connectionId, hello());
  core.activateConnection(connectionId);
  await core.receiveFrame(
    connectionId,
    encoder.encode(JSON.stringify(controlEnvelope(
      "session_register",
      options.registration ?? sessionRegister(),
      10,
    ))),
  );
  const registered = JSON.parse(transport.sent.at(-1)!) as Extract<
    RbpEnvelope,
    { type: "session_registered" }
  >;
  return {
    core,
    transport,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
    statePath: path,
  };
}

describe("Gateway stub shared FSM authority", () => {
  it("adopts post-rename revoke authority and poisons future updates when durability confirmation fails", async () => {
    let injectPostRenameFailure = false;
    const fixture = await connectedCore("post-rename-revoke", undefined, {
      stateStoreTestHooks: {
        afterCanonicalReplace: () => {
          if (injectPostRenameFailure) throw new Error("injected directory fsync failure");
        },
      },
    });
    injectPostRenameFailure = true;
    const unregister = controlEnvelope("session_unregister", {
      rsid: fixture.rsid,
      reason: "operator_requested",
    }, 390);

    await expect(fixture.core.receiveFrame(
      fixture.transport.connectionId,
      encoder.encode(JSON.stringify(unregister)),
    )).rejects.toMatchObject({
      name: "GatewayStatePersistenceError",
      canonicalReplaced: true,
    });
    expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
      revoked: true,
      lifecycle: { phase: "unregistered", unregisterReason: "operator_requested" },
    });
    const canonical = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      sessions: Record<string, { revoked: boolean }>;
    };
    expect(canonical.sessions[fixture.rsid]?.revoked).toBe(true);
    await expect(fixture.core.dispatchInvoke({
      rsid: fixture.rsid,
      payload: readInvoke(uuid7(391)),
    })).rejects.toMatchObject({ faultClass: "auth", closeCode: 4403 });
    await expect(fixture.core.receiveFrame(
      fixture.transport.connectionId,
      encoder.encode(JSON.stringify(controlEnvelope("manifest_check", {
        bridge_version: "0.1.0-test",
        addin_versions: ["0.1.0-test"],
        channel: "test",
        highest_accepted_release_sequence: 0,
      }, 392))),
    )).rejects.toMatchObject({
      name: "GatewayStatePersistenceError",
      canonicalReplaced: true,
    });

    await expect(fixture.core.close()).rejects.toThrow();
  });

  it("accepts direct same-owner unregister on a fresh binding and rejects unsafe replays with 4403", async () => {
    const otherToken = "other-device-token";
    const tokens: StaticTokenTable = {
      ...tokenTable,
      [otherToken]: {
        ...tokenTable[TOKEN]!,
        deviceId: "device-02",
        tenantId: "tenant-02",
        userId: "user-02",
        seatId: "seat-02",
        machineFingerprint: `sha256:${"9".repeat(64)}`,
      },
    };
    const fixture = await connectedCore("fresh-binding-unregister", { nowMs: () => Date.parse(NOW) }, {
      tokenTable: tokens,
    });
    try {
      const sameOwner = fixture.core.authenticate(TOKEN);
      const freshConnectionId = await fixture.core.allocateConnectionId(sameOwner);
      const freshTransport = new MemoryTransport(freshConnectionId, "wss", sameOwner);
      fixture.core.attachConnection(freshTransport);
      await fixture.core.acceptHello(freshConnectionId, hello(401));
      fixture.core.activateConnection(freshConnectionId);
      const unregister = controlEnvelope("session_unregister", {
        rsid: fixture.rsid,
        reason: "operator_requested",
      }, 402);

      await expect(fixture.core.receiveFrame(
        freshConnectionId,
        encoder.encode(JSON.stringify(unregister)),
      )).resolves.toMatchObject({ outcome: "delivered" });
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        revoked: true,
        lifecycle: { phase: "unregistered", unregisterReason: "operator_requested" },
      });
      await expect(fixture.core.receiveFrame(
        freshConnectionId,
        encoder.encode(JSON.stringify({ ...unregister, id: uuid7(403) })),
      )).resolves.toMatchObject({ outcome: "delivered" });

      await expect(fixture.core.receiveFrame(
        freshConnectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_unregister", {
          rsid: fixture.rsid,
          reason: "bridge_shutdown",
        }, 404))),
      )).rejects.toMatchObject({ faultClass: "auth", closeCode: 4403 });
      await expect(fixture.core.receiveFrame(
        freshConnectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_unregister", {
          rsid: uuid7(405),
          reason: "operator_requested",
        }, 406))),
      )).rejects.toMatchObject({ faultClass: "auth", closeCode: 4403 });

      const otherOwner = fixture.core.authenticate(otherToken);
      const otherConnectionId = await fixture.core.allocateConnectionId(otherOwner);
      const otherTransport = new MemoryTransport(otherConnectionId, "wss", otherOwner);
      fixture.core.attachConnection(otherTransport);
      const otherHello = hello(407);
      otherHello.payload.device_id = "device-02";
      await fixture.core.acceptHello(otherConnectionId, otherHello);
      fixture.core.activateConnection(otherConnectionId);
      await expect(fixture.core.receiveFrame(
        otherConnectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_unregister", {
          rsid: fixture.rsid,
          reason: "operator_requested",
        }, 408))),
      )).rejects.toMatchObject({ faultClass: "auth", closeCode: 4403 });
    } finally {
      await fixture.core.close();
    }
  });

  it("projects the T2 connection heartbeat transitions into degraded and disconnected session state", async () => {
    let now = Date.parse(NOW);
    const fixture = await connectedCore("liveness", { nowMs: () => now });
    try {
      now += 36_000;
      expect(await fixture.core.livenessSweep()).toEqual([]);
      expect(fixture.core.snapshot()).toMatchObject({
        sessions: { [fixture.rsid]: { liveness: "degraded" } },
        runtime: {
          connectionPhases: { [fixture.transport.connectionId]: "degraded" },
        },
      });

      now += 30_000;
      expect(await fixture.core.livenessSweep()).toEqual([fixture.transport.connectionId]);
      expect(fixture.core.snapshot()).toMatchObject({
        sessions: { [fixture.rsid]: { liveness: "disconnected" } },
        runtime: {
          connectionPhases: { [fixture.transport.connectionId]: "backoff" },
        },
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("persists T2 sequence/window state and closes window=1 only on a terminal envelope", async () => {
    const fixture = await connectedCore("sequence-window");
    const invocationId = uuid7(101);
    try {
      const dispatched = await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(invocationId),
      });
      expect(dispatched).toMatchObject({ type: "invoke", seq: 1, ack: 0 });

      const pending = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(fixture.core.snapshot().runtime.connectionPhases[fixture.transport.connectionId]).toBe("steady");
      expect(pending.sequence).toMatchObject({
        rsid: fixture.rsid,
        nextTxSeq: 2,
        highestTxSeq: 1,
        lastRxSeq: 0,
        lastPeerAck: 0,
      });
      expect(pending.sequence.outbox).toHaveLength(1);
      expect(pending.dispatchWindow.active).toEqual([
        { rsid: fixture.rsid, invocationId, kind: "invoke" },
      ]);
      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(uuid7(102)),
      })).rejects.toBeInstanceOf(WindowViolationError);

      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, invocationId, 2))),
      )).rejects.toThrow(/forward sequence gap/);

      const terminal = resultEnvelope(fixture.rsid, invocationId);
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal)),
      );
      const completed = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(completed.sequence.lastRxSeq).toBe(1);
      expect(completed.sequence.lastPeerAck).toBe(1);
      expect(completed.sequence.outbox).toEqual([]);
      expect(completed.dispatchWindow.active).toEqual([]);
      expect(completed.inFlight).toBeNull();

      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal)),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.sequence.lastRxSeq).toBe(1);
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify({
          ...terminal,
          payload: { ...terminal.payload, result: { changed: true } },
        })),
      )).rejects.toThrow(/duplicate_identity_mismatch/);
    } finally {
      await fixture.core.close();
    }
  });

  it("restarts with the retained T2 outbox and retransmits its immutable dispatch on resume", async () => {
    const fixture = await connectedCore("resume");
    const invocationId = uuid7(103);
    const original = await fixture.core.dispatchInvoke({
      rsid: fixture.rsid,
      payload: readInvoke(invocationId),
    });
    await fixture.core.close();

    const resumedCore = await GatewayStubCore.create({ statePath: fixture.statePath, tokenTable });
    const device = resumedCore.authenticate(TOKEN);
    const connectionId = await resumedCore.allocateConnectionId(device);
    const transport = new MemoryTransport(connectionId, "http_sse", device);
    resumedCore.attachConnection(transport);
    await resumedCore.acceptHello(connectionId, hello(2));
    resumedCore.activateConnection(connectionId);
    try {
      await resumedCore.receiveFrame(
        connectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_resume", {
          rsid: fixture.rsid,
          resume_token: fixture.resumeToken,
          last_rx_seq: 0,
        }, 11))),
      );
      expect(transport.sent).toHaveLength(2);
      const resumeAck = JSON.parse(transport.sent[0]!) as RbpEnvelope;
      const retransmission = JSON.parse(transport.sent[1]!) as RbpEnvelope;
      expect(resumeAck).toMatchObject({ type: "resume_ack", payload: { last_rx_seq: 0 } });
      expect(retransmission).toMatchObject({
        v: 1,
        type: original.type,
        id: original.id,
        rsid: fixture.rsid,
        seq: original.seq,
        payload: original.payload,
      });
      expect(resumedCore.snapshot().sessions[fixture.rsid]!.lifecycle).toMatchObject({
        phase: "registered",
        dispatchAllowed: true,
      });
    } finally {
      await resumedCore.close();
    }
  });

  it("removes crash-orphan temp files and fails closed on a truncated canonical state", async () => {
    const fixture = await connectedCore("state-crash-recovery");
    const orphanPath = `${fixture.statePath}.tmp-999999-crash`;
    await fixture.core.close();
    await writeFile(orphanPath, "partial", "utf8");

    const reopened = await GatewayStubCore.create({ statePath: fixture.statePath, tokenTable });
    try {
      await expect(access(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(reopened.snapshot().sessions[fixture.rsid]).toBeDefined();
    } finally {
      await reopened.close();
    }

    await writeFile(fixture.statePath, '{"schemaVersion":1', "utf8");
    await expect(GatewayStubCore.create({
      statePath: fixture.statePath,
      tokenTable,
    })).rejects.toBeInstanceOf(SyntaxError);
  });

  it("rejects a resume acknowledgement that regresses behind the durable peer acknowledgement", async () => {
    const fixture = await connectedCore("resume-regression");
    const invocationId = uuid7(123);
    await fixture.core.dispatchInvoke({
      rsid: fixture.rsid,
      payload: readInvoke(invocationId),
    });
    await fixture.core.receiveFrame(
      fixture.transport.connectionId,
      encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, invocationId))),
    );
    expect(fixture.core.snapshot().sessions[fixture.rsid]!.sequence.lastPeerAck).toBe(1);
    await fixture.core.close();

    const resumedCore = await GatewayStubCore.create({ statePath: fixture.statePath, tokenTable });
    const device = resumedCore.authenticate(TOKEN);
    const connectionId = await resumedCore.allocateConnectionId(device);
    const transport = new MemoryTransport(connectionId, "http_sse", device);
    resumedCore.attachConnection(transport);
    await resumedCore.acceptHello(connectionId, hello(2));
    resumedCore.activateConnection(connectionId);
    try {
      await expect(resumedCore.receiveFrame(
        connectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_resume", {
          rsid: fixture.rsid,
          resume_token: fixture.resumeToken,
          last_rx_seq: 0,
        }, 12))),
      )).rejects.toThrow(/regresses durable bridge acknowledgement/);
      expect(resumedCore.snapshot().sessions[fixture.rsid]!.sequence.lastPeerAck).toBe(1);
    } finally {
      await resumedCore.close();
    }
  });

  it("round-trips principal, version, build, port, context, and resume authority across restart", async () => {
    const fixture = await connectedCore("session-table-roundtrip");
    await fixture.core.receiveFrame(
      fixture.transport.connectionId,
      encoder.encode(JSON.stringify({
        v: 1,
        type: "doc_context_update",
        id: uuid7(124),
        rsid: fixture.rsid,
        seq: 1,
        ack: 0,
        ts: NOW,
        payload: {
          documents: sessionRegister().documents,
          active_document: "doc-01",
          active_view: { id: "view-01", name: "Level 1", type: "FloorPlan", level: "Level 1" },
          discipline_hint: "mechanical",
        },
      })),
    );
    await fixture.core.close();

    const resumedCore = await GatewayStubCore.create({ statePath: fixture.statePath, tokenTable });
    const device = resumedCore.authenticate(TOKEN);
    const connectionId = await resumedCore.allocateConnectionId(device);
    const transport = new MemoryTransport(connectionId, "wss", device);
    resumedCore.attachConnection(transport);
    await resumedCore.acceptHello(connectionId, hello(125));
    resumedCore.activateConnection(connectionId);
    try {
      const persisted = resumedCore.snapshot().sessions[fixture.rsid]!;
      expect(persisted).toMatchObject({
        deviceId: "device-01",
        tenantId: "tenant-01",
        userId: "user-01",
        seatId: "seat-01",
        userHint: { name: "Test User" },
        machine: { hostname: "fixture", fingerprint: expect.stringMatching(/^sha256:/) },
        revit: { version: "2025", build: "25.0", pid: 1001 },
        addinVersion: "0.1.0-test",
        resultContractVersion: 1,
        bridgeVersion: "0.1.0-test",
        port: 8080,
        activeDocument: "doc-01",
        activeView: { id: "view-01", name: "Level 1", type: "FloorPlan" },
        disciplineHint: "mechanical",
        resumeTokenRedacted: true,
      });
      expect("resumeToken" in persisted).toBe(false);

      await resumedCore.receiveFrame(
        connectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_resume", {
          rsid: fixture.rsid,
          resume_token: fixture.resumeToken,
          last_rx_seq: 0,
        }, 126))),
      );
      expect(resumedCore.snapshot().sessions[fixture.rsid]).toMatchObject({
        lifecycle: { phase: "registered", dispatchAllowed: true },
        tenantId: "tenant-01",
        userHint: { name: "Test User" },
        activeDocument: "doc-01",
      });
    } finally {
      await resumedCore.close();
    }
  });

  it("binds resume authority to the persisted tenant, user, and seat principal", async () => {
    const fixture = await connectedCore("resume-principal-binding");
    await fixture.core.close();
    const changedPrincipalTable = structuredClone(tokenTable);
    changedPrincipalTable[TOKEN]!.seatId = "seat-02";
    const resumedCore = await GatewayStubCore.create({
      statePath: fixture.statePath,
      tokenTable: changedPrincipalTable,
    });
    const device = resumedCore.authenticate(TOKEN);
    const connectionId = await resumedCore.allocateConnectionId(device);
    const transport = new MemoryTransport(connectionId, "wss", device);
    resumedCore.attachConnection(transport);
    await resumedCore.acceptHello(connectionId, hello(127));
    resumedCore.activateConnection(connectionId);
    try {
      await expect(resumedCore.receiveFrame(
        connectionId,
        encoder.encode(JSON.stringify(controlEnvelope("session_resume", {
          rsid: fixture.rsid,
          resume_token: fixture.resumeToken,
          last_rx_seq: 0,
        }, 128))),
      )).rejects.toThrow(/resume token\/session authorization failed/);
      expect(resumedCore.snapshot().sessions[fixture.rsid]).toMatchObject({
        seatId: "seat-01",
        lifecycle: { phase: "disconnected", dispatchAllowed: false },
      });
    } finally {
      await resumedCore.close();
    }
  });

  it("uses the T2 mutation ledger to block fresh writes while allowing the exact verification read", async () => {
    const fixture = await connectedCore("holds");
    try {
      const scope = { kind: "document", document_id: "doc-01" } as const;
      const holds = await fixture.core.installSyntheticHold(
        fixture.rsid,
        scope,
        [uuid7(104)],
      );
      expect(holds).toHaveLength(1);
      expect(holds[0]!.holdId).toBe(
        makeMutationHoldId(fixture.rsid, scope, [`${fixture.rsid}/${uuid7(104)}`]),
      );
      expect(fixture.core.snapshot().mutationHolds.holds).toEqual(holds);

      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: mutatingInvoke(uuid7(104), scope),
      })).resolves.toMatchObject({ type: "invoke" });
      await fixture.core.expirePendingNow(fixture.rsid);
      expect(fixture.core.snapshot().mutationHolds.holds[0]!.state).toBe("active");

      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: mutatingInvoke(uuid7(105), scope),
      })).rejects.toBeInstanceOf(RecoveryHoldConflictError);

      const uncorrelatedId = uuid7(118);
      let uncorrelatedJournal = createReceivedJournalRecord({
        rsid: fixture.rsid,
        invocationId: uncorrelatedId,
        method: "inspect_fixture",
        mutating: false,
        mutationScope: null,
        paramsDigest: makeParamsDigest({ value: 1 }),
        policy: { class: "auto", decision: "auto", confirmation_id: null },
        verification: {
          hold_id: holds[0]!.holdId,
          mutation_scope: scope,
          purpose: "resolve_indeterminate",
        },
        recoveryClearances: [],
      });
      uncorrelatedJournal = recordJournalTerminal(markJournalExecuting(uncorrelatedJournal), {
        status: "completed",
        payloadRetained: true,
        payload: { ok: true },
        resultDigest: DIGEST,
      });
      await expect(fixture.core.recordVerificationHoldEvidence({
        rsid: fixture.rsid,
        holdId: holds[0]!.holdId,
        mutationScope: scope,
        verificationInvocationId: uncorrelatedId,
        evidenceDigest: DIGEST,
        conclusion: "postcondition_verified",
        journalRecord: uncorrelatedJournal,
      })).rejects.toThrow(/not correlated to an accepted digest-bound read terminal/);

      const verificationId = uuid7(106);
      const verification = readInvoke(verificationId, {
        hold_id: holds[0]!.holdId,
        mutation_scope: scope,
        purpose: "resolve_indeterminate",
      });
      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: verification,
      })).resolves.toMatchObject({ type: "invoke", payload: { mutating: false } });
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify({
          ...resultEnvelope(fixture.rsid, verificationId, 1, 2),
          payload: {
            ...resultEnvelope(fixture.rsid, verificationId, 1, 2).payload,
            result_digest: DIGEST,
          },
        })),
      );
      expect(fixture.core.snapshot().mutationHolds.holds[0]!.state).toBe("active");

      let journal = createReceivedJournalRecord({
        rsid: fixture.rsid,
        invocationId: verificationId,
        method: "inspect_fixture",
        mutating: false,
        mutationScope: null,
        paramsDigest: makeParamsDigest({ value: 1 }),
        policy: { class: "auto", decision: "auto", confirmation_id: null },
        verification: verification.verification,
        recoveryClearances: [],
      });
      journal = recordJournalTerminal(markJournalExecuting(journal), {
        status: "completed",
        payloadRetained: true,
        payload: { ok: true },
        resultDigest: DIGEST,
      });
      const evidenced = await fixture.core.recordVerificationHoldEvidence({
        rsid: fixture.rsid,
        holdId: holds[0]!.holdId,
        mutationScope: scope,
        verificationInvocationId: verificationId,
        evidenceDigest: DIGEST,
        conclusion: "postcondition_verified",
        journalRecord: journal,
      });
      expect(evidenced.state).toBe("evidence_recorded");

      const clearance = {
        hold_id: evidenced.holdId,
        mutation_scope: scope,
        resolution_id: uuid7(120),
        basis: "verification_read" as const,
        verification_invocation_id: verificationId,
        evidence_digest: DIGEST,
        decision: "postcondition_verified" as const,
        audit_id: uuid7(121),
      };
      const authorized = mutatingInvoke(uuid7(122), scope);
      authorized.recovery_clearances = [clearance];
      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: authorized,
      })).resolves.toMatchObject({ type: "invoke", payload: { recovery_clearances: [clearance] } });
      expect(fixture.core.snapshot().mutationHolds.holds[0]).toMatchObject({
        state: "resolved_pending_bridge",
        clearedBy: null,
      });
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.inFlight)
        .toMatchObject({ pendingRecoveryClearances: [clearance] });

      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, uuid7(122), 2, 2, 119))),
      )).rejects.toThrow(/does not acknowledge the evidence-bound recovery dispatch/);
      expect(fixture.core.snapshot().mutationHolds.holds[0]).toMatchObject({
        state: "resolved_pending_bridge",
        clearedBy: null,
      });

      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, uuid7(122), 2, 3, 122))),
      );
      expect(fixture.core.snapshot().mutationHolds.holds[0]).toMatchObject({
        state: "cleared",
        clearedBy: expect.stringMatching(/^sha256:/),
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("keeps a recovery hold pending when the authorized dispatch expires before Bridge acknowledgement", async () => {
    const fixture = await connectedCore("recovery-clearance-expiry");
    const scope = { kind: "document", document_id: "doc-01" } as const;
    const originId = uuid7(123);
    const verificationId = uuid7(124);
    try {
      const [hold] = await fixture.core.installSyntheticHold(
        fixture.rsid,
        scope,
        [originId],
      );
      const verification = readInvoke(verificationId, {
        hold_id: hold!.holdId,
        mutation_scope: scope,
        purpose: "resolve_indeterminate",
      });
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: verification,
      });
      const terminal = resultEnvelope(fixture.rsid, verificationId);
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify({
          ...terminal,
          payload: { ...terminal.payload, result_digest: DIGEST },
        })),
      );

      let journal = createReceivedJournalRecord({
        rsid: fixture.rsid,
        invocationId: verificationId,
        method: "inspect_fixture",
        mutating: false,
        mutationScope: null,
        paramsDigest: makeParamsDigest({ value: 1 }),
        policy: { class: "auto", decision: "auto", confirmation_id: null },
        verification: verification.verification,
        recoveryClearances: [],
      });
      journal = recordJournalTerminal(markJournalExecuting(journal), {
        status: "completed",
        payloadRetained: true,
        payload: { ok: true },
        resultDigest: DIGEST,
      });
      const evidenced = await fixture.core.recordVerificationHoldEvidence({
        rsid: fixture.rsid,
        holdId: hold!.holdId,
        mutationScope: scope,
        verificationInvocationId: verificationId,
        evidenceDigest: DIGEST,
        conclusion: "postcondition_verified",
        journalRecord: journal,
      });
      const clearance = {
        hold_id: evidenced.holdId,
        mutation_scope: scope,
        resolution_id: uuid7(125),
        basis: "verification_read" as const,
        verification_invocation_id: verificationId,
        evidence_digest: DIGEST,
        decision: "postcondition_verified" as const,
        audit_id: uuid7(126),
      };
      const recovered = mutatingInvoke(uuid7(127), scope);
      recovered.recovery_clearances = [clearance];
      await fixture.core.dispatchInvoke({ rsid: fixture.rsid, payload: recovered });

      await expect(fixture.core.expirePendingNow(fixture.rsid)).resolves.toBeUndefined();
      expect(fixture.core.snapshot()).toMatchObject({
        mutationHolds: {
          holds: [expect.objectContaining({
            holdId: hold!.holdId,
            state: "resolved_pending_bridge",
            clearedBy: null,
          })],
        },
        sessions: {
          [fixture.rsid]: {
            inFlight: null,
            terminalOutcomes: {
              [recovered.invocation_id]: { classification: "journal_indeterminate" },
            },
          },
        },
      });
      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: mutatingInvoke(uuid7(128), scope),
      })).rejects.toBeInstanceOf(RecoveryHoldConflictError);
    } finally {
      await fixture.core.close();
    }
  });

  it("persists chunk bytes through the T2 stream assembler and finalizes only a matching manifest", async () => {
    const fixture = await connectedCore("carrier");
    const invocationId = uuid7(107);
    try {
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(invocationId),
      });
      const bytes = Buffer.from("hello", "utf8");
      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const partial: RbpEnvelope = {
        v: 1,
        type: "partial",
        id: uuid7(40),
        rsid: fixture.rsid,
        seq: 1,
        ack: 1,
        ts: NOW,
        payload: {
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: 0,
          encoding: "base64",
          content_type: "text/plain",
          data: bytes.toString("base64"),
        },
      };
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(partial)),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.streamAssemblers[invocationId])
        .toMatchObject({ decodedBytes: 5 });

      const terminal: RbpEnvelope = {
        v: 1,
        type: "result",
        id: uuid7(41),
        rsid: fixture.rsid,
        seq: 2,
        ack: 1,
        ts: NOW,
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: false,
          chunked: true,
          stream_id: "result",
          content_type: "text/plain",
          total_chunks: 1,
          total_size: 5,
          sha256,
          metrics: {
            execute_ms: 1,
            request_bytes: 2,
            response_bytes: 5,
            framing: "length-prefixed",
          },
        },
      };
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal)),
      );
      const session = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(session.streamAssemblers).toEqual({});
      expect(session.chunkedResults[invocationId]).toMatchObject({
        totalChunks: 1,
        totalSize: 5,
        sha256,
        bytesBase64: bytes.toString("base64"),
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("retains cancel as sequenced data and closes the original window on the correlated terminal error", async () => {
    const fixture = await connectedCore("cancel");
    const invocationId = uuid7(130);
    try {
      await fixture.core.dispatchInvoke({ rsid: fixture.rsid, payload: readInvoke(invocationId) });
      const cancel = await fixture.core.dispatchCancel({
        rsid: fixture.rsid,
        invocationId,
        reason: "user_requested",
      });
      expect(cancel).toMatchObject({
        type: "cancel",
        seq: 2,
        payload: { invocation_id: invocationId, reason: "user_requested" },
      });
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        inFlight: { cancelRequested: true },
        sequence: { outbox: [{ envelope: { seq: 1 } }, { envelope: { seq: 2 } }] },
      });

      const cancelled: RbpEnvelope = {
        v: 1,
        type: "error",
        id: uuid7(131),
        rsid: fixture.rsid,
        seq: 1,
        ack: 2,
        ts: NOW,
        payload: {
          invocation_id: invocationId,
          retryable: false,
          fault_class: "cancelled",
          outcome: "known",
          verification_required: false,
          replayed: false,
          message: "cancelled by test operator",
        },
      };
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(cancelled)),
      );
      const session = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(session.inFlight).toBeNull();
      expect(session.dispatchWindow.active).toEqual([]);
      expect(session.sequence.outbox).toEqual([]);
      expect(session.terminalOutcomes[invocationId]).toMatchObject({ classification: "cancelled" });
    } finally {
      await fixture.core.close();
    }
  });

  it("suppresses a real post-cancel success as evidence instead of exposing ordinary success", async () => {
    const fixture = await connectedCore("cancel-real-outcome");
    const invocationId = uuid7(135);
    try {
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(invocationId),
      });
      await fixture.core.dispatchCancel({
        rsid: fixture.rsid,
        invocationId,
        reason: "user_requested",
      });
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, invocationId, 1, 2, 136))),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        inFlight: null,
        terminalOutcomes: {
          [invocationId]: { classification: "cancelled", envelope: null },
        },
        lateTerminalEvidence: {
          [invocationId]: [expect.objectContaining({
            classification: "result",
            source: "cancel_suppressed",
          })],
        },
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("validates batch digests, capability-gates atomic dispatch, and correlates every terminal step", async () => {
    const fixture = await connectedCore("batch");
    const batchId = uuid7(140);
    const invocationId = uuid7(141);
    try {
      const digestInput = {
        batch_id: batchId,
        atomic: true,
        timeout_ms: 5_000,
        recovery_clearances: [],
        steps: [{
          invocation_id: invocationId,
          method: "inspect_fixture",
          params: { value: 1 },
          params_digest: makeParamsDigest({ value: 1 }),
          policy: { class: "auto" as const, decision: "auto" as const, confirmation_id: null },
          mutating: false as const,
          mutation_scope: null,
        }],
      };
      const payload = {
        ...digestInput,
        steps: digestInput.steps as [typeof digestInput.steps[number]],
        batch_digest: makeBatchDigest(digestInput),
      };
      await expect(fixture.core.dispatchBatch({
        rsid: fixture.rsid,
        payload: { ...payload, batch_digest: `sha256:${"f".repeat(64)}` },
      })).rejects.toThrow(/batch_digest mismatch/);

      await expect(fixture.core.dispatchBatch({ rsid: fixture.rsid, payload }))
        .resolves.toMatchObject({ type: "invoke_batch", seq: 1 });
      const terminal: RbpEnvelope = {
        v: 1,
        type: "result",
        id: uuid7(142),
        rsid: fixture.rsid,
        seq: 1,
        ack: 1,
        ts: NOW,
        payload: {
          kind: "batch",
          batch_id: batchId,
          atomic: true,
          status: "completed",
          transaction_state: "committed",
          failed_step_index: null,
          replayed: false,
          steps: [{
            index: 0,
            invocation_id: invocationId,
            status: "completed",
            replayed: false,
            result: { ok: true },
          }],
        },
      };
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal)),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        inFlight: null,
        dispatchWindow: { active: [] },
        terminalOutcomes: { [batchId]: { classification: "result" } },
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("binds batch terminals to the dispatched atomic/digest identity and rejects a top-level error carrier", async () => {
    const fixture = await connectedCore("batch-terminal-binding");
    const batchId = uuid7(150);
    const invocationId = uuid7(151);
    const digestInput = {
      batch_id: batchId,
      atomic: true,
      timeout_ms: 5_000,
      recovery_clearances: [],
      steps: [{
        invocation_id: invocationId,
        method: "inspect_fixture",
        params: { value: 1 },
        params_digest: makeParamsDigest({ value: 1 }),
        policy: { class: "auto" as const, decision: "auto" as const, confirmation_id: null },
        mutating: false as const,
        mutation_scope: null,
      }],
    };
    const payload = {
      ...digestInput,
      steps: digestInput.steps as [typeof digestInput.steps[number]],
      batch_digest: makeBatchDigest(digestInput),
    };
    try {
      await fixture.core.dispatchBatch({ rsid: fixture.rsid, payload });
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.inFlight).toMatchObject({
        batchAtomic: true,
        batchDigest: payload.batch_digest,
        dispatchIdentity: expect.stringMatching(/^sha256:/),
      });

      const mismatchedAtomic: RbpEnvelope = {
        v: 1,
        type: "result",
        id: uuid7(152),
        rsid: fixture.rsid,
        seq: 1,
        ack: 1,
        ts: NOW,
        payload: {
          kind: "batch",
          batch_id: batchId,
          atomic: false,
          status: "completed",
          transaction_state: "not_applicable",
          failed_step_index: null,
          replayed: false,
          steps: [{
            index: 0,
            invocation_id: invocationId,
            status: "completed",
            replayed: false,
            result: { ok: true },
          }],
        },
      };
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(mismatchedAtomic)),
      )).rejects.toThrow(/atomic\/digest binding/);

      const topLevelError: RbpEnvelope = {
        v: 1,
        type: "error",
        id: uuid7(153),
        rsid: fixture.rsid,
        seq: 1,
        ack: 1,
        ts: NOW,
        payload: {
          invocation_id: invocationId,
          retryable: false,
          fault_class: "protocol",
          outcome: "known",
          verification_required: false,
          replayed: false,
          message: "invalid batch carrier",
        },
      };
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(topLevelError)),
      )).rejects.toThrow(/must terminate with one batch result carrier/);
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.sequence.lastRxSeq).toBe(0);

      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify({
          ...mismatchedAtomic,
          id: uuid7(154),
          payload: {
            ...mismatchedAtomic.payload,
            atomic: true,
            transaction_state: "committed",
          },
        })),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.inFlight).toBeNull();
    } finally {
      await fixture.core.close();
    }
  });

  it("derives and verifies nested batch hold ids and rejects atomic under-coverage", async () => {
    const fixture = await connectedCore("batch-hold-binding");
    const scope = { kind: "document", document_id: "doc-01" } as const;
    const batchId = uuid7(160);
    const invocationId = uuid7(161);
    const step = {
      invocation_id: invocationId,
      method: "mutate_fixture",
      params: { value: 1 },
      params_digest: makeParamsDigest({ value: 1 }),
      policy: {
        class: "confirm" as const,
        decision: "confirmed" as const,
        confirmation_id: uuid7(162),
      },
      mutating: true as const,
      mutation_scope: scope,
    };
    const digestInput = {
      batch_id: batchId,
      atomic: true,
      timeout_ms: 5_000,
      recovery_clearances: [],
      steps: [step],
    };
    const payload = {
      ...digestInput,
      steps: [step] as [typeof step],
      batch_digest: makeBatchDigest(digestInput),
    };
    const expectedHoldId = makeMutationHoldId(
      fixture.rsid,
      scope,
      [`${fixture.rsid}/${invocationId}`],
    );
    const terminal = (holdId: string): RbpEnvelope => ({
      v: 1,
      type: "result",
      id: uuid7(163),
      rsid: fixture.rsid,
      seq: 1,
      ack: 1,
      ts: NOW,
      payload: {
        kind: "batch",
        batch_id: batchId,
        atomic: true,
        status: "indeterminate",
        transaction_state: "indeterminate",
        failed_step_index: 0,
        replayed: false,
        steps: [{
          index: 0,
          invocation_id: invocationId,
          status: "indeterminate",
          replayed: false,
          error: {
            retryable: false,
            fault_class: "journal_indeterminate",
            outcome: "indeterminate",
            verification_required: true,
            replayed: false,
            verification_hold_id: holdId,
            mutation_scope: scope,
            message: "outcome unknown",
          },
        }],
      },
    });
    try {
      await fixture.core.dispatchBatch({ rsid: fixture.rsid, payload });
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal(`vh:${"f".repeat(64)}`))),
      )).rejects.toThrow(/derived recovery hold/);
      expect(fixture.core.snapshot().mutationHolds.holds).toEqual([]);

      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(terminal(expectedHoldId))),
      );
      expect(fixture.core.snapshot().mutationHolds.holds).toEqual([
        expect.objectContaining({
          holdId: expectedHoldId,
          state: "active",
          originIdempotencyKeys: [`${fixture.rsid}/${invocationId}`],
        }),
      ]);
    } finally {
      await fixture.core.close();
    }
  });

  it("rejects an atomic indeterminate carrier that leaves a possibly executed mutation completed", async () => {
    const fixture = await connectedCore("atomic-hold-undercoverage");
    const scope = { kind: "document", document_id: "doc-01" } as const;
    const batchId = uuid7(164);
    const firstId = uuid7(165);
    const secondId = uuid7(166);
    const step = (invocationId: string, confirmationId: string) => ({
      invocation_id: invocationId,
      method: "mutate_fixture",
      params: { value: 1 },
      params_digest: makeParamsDigest({ value: 1 }),
      policy: {
        class: "confirm" as const,
        decision: "confirmed" as const,
        confirmation_id: confirmationId,
      },
      mutating: true as const,
      mutation_scope: scope,
    });
    const steps = [step(firstId, uuid7(167)), step(secondId, uuid7(168))] as const;
    const digestInput = {
      batch_id: batchId,
      atomic: true,
      timeout_ms: 5_000,
      recovery_clearances: [],
      steps,
    };
    try {
      await fixture.core.dispatchBatch({
        rsid: fixture.rsid,
        payload: {
          ...digestInput,
          steps: [...steps] as [typeof steps[0], typeof steps[1]],
          batch_digest: makeBatchDigest(digestInput),
        },
      });
      const secondHold = makeMutationHoldId(
        fixture.rsid,
        scope,
        [`${fixture.rsid}/${secondId}`],
      );
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify({
          v: 1,
          type: "result",
          id: uuid7(169),
          rsid: fixture.rsid,
          seq: 1,
          ack: 1,
          ts: NOW,
          payload: {
            kind: "batch",
            batch_id: batchId,
            atomic: true,
            status: "indeterminate",
            transaction_state: "indeterminate",
            failed_step_index: 1,
            replayed: false,
            steps: [{
              index: 0,
              invocation_id: firstId,
              status: "completed",
              replayed: false,
              result: { ok: true },
            }, {
              index: 1,
              invocation_id: secondId,
              status: "indeterminate",
              replayed: false,
              error: {
                retryable: false,
                fault_class: "journal_indeterminate",
                outcome: "indeterminate",
                verification_required: true,
                replayed: false,
                verification_hold_id: secondHold,
                mutation_scope: scope,
                message: "outcome unknown",
              },
            }],
          },
        })),
      )).rejects.toThrow(/every possibly executed mutation indeterminate/);
      expect(fixture.core.snapshot().mutationHolds.holds).toEqual([]);
    } finally {
      await fixture.core.close();
    }
  });

  it("rejects document-scoped dispatch outside the registered session documents", async () => {
    const fixture = await connectedCore("foreign-document-scope");
    try {
      await expect(fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: mutatingInvoke(uuid7(170), {
          kind: "document",
          document_id: "foreign-doc",
        }),
      })).rejects.toThrow(/not registered for this rsid/);
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        inFlight: null,
        sequence: { nextTxSeq: 1, outbox: [] },
      });
    } finally {
      await fixture.core.close();
    }
  });

  it("enforces every connection/session capability at the consuming message boundary", async () => {
    const noSessionGrant = await connectedCore("missing-session-capabilities", undefined, {
      sessionCapabilities: [],
    });
    const noChunkGrant = await connectedCore("missing-chunk-capability", undefined, {
      connectionCapabilities: ["journal_v1", "transport_streamable_http"],
    });
    const noArtifactGrant = await connectedCore("missing-artifact-capability", undefined, {
      connectionCapabilities: ["journal_v1", "chunked_results", "transport_streamable_http"],
    });
    try {
      const batchId = uuid7(171);
      const invocationId = uuid7(172);
      const digestInput = {
        batch_id: batchId,
        atomic: true,
        timeout_ms: 5_000,
        recovery_clearances: [],
        steps: [{
          invocation_id: invocationId,
          method: "inspect_fixture",
          params: { value: 1 },
          params_digest: makeParamsDigest({ value: 1 }),
          policy: { class: "auto" as const, decision: "auto" as const, confirmation_id: null },
          mutating: false as const,
          mutation_scope: null,
        }],
      };
      await expect(noSessionGrant.core.dispatchBatch({
        rsid: noSessionGrant.rsid,
        payload: {
          ...digestInput,
          steps: digestInput.steps as [typeof digestInput.steps[number]],
          batch_digest: makeBatchDigest(digestInput),
        },
      })).rejects.toThrow(/atomic batch is not granted/);

      await expect(noSessionGrant.core.receiveFrame(
        noSessionGrant.transport.connectionId,
        encoder.encode(JSON.stringify({
          v: 1,
          type: "doc_context_update",
          id: uuid7(173),
          rsid: noSessionGrant.rsid,
          seq: 1,
          ack: 0,
          ts: NOW,
          payload: {
            documents: sessionRegister().documents,
            active_document: "doc-01",
            active_view: null,
          },
        })),
      )).rejects.toThrow(/doc_context_cached_v1/);

      await noChunkGrant.core.dispatchInvoke({
        rsid: noChunkGrant.rsid,
        payload: readInvoke(uuid7(174)),
      });
      await expect(noChunkGrant.core.receiveFrame(
        noChunkGrant.transport.connectionId,
        encoder.encode(JSON.stringify({
          v: 1,
          type: "partial",
          id: uuid7(175),
          rsid: noChunkGrant.rsid,
          seq: 1,
          ack: 1,
          ts: NOW,
          payload: {
            kind: "chunk",
            invocation_id: uuid7(174),
            stream_id: "result",
            chunk_index: 0,
            encoding: "base64",
            content_type: "text/plain",
            data: Buffer.from("x").toString("base64"),
          },
        })),
      )).rejects.toThrow(/chunked_results/);

      await noArtifactGrant.core.dispatchInvoke({
        rsid: noArtifactGrant.rsid,
        payload: readInvoke(uuid7(176)),
      });
      await expect(noArtifactGrant.core.receiveFrame(
        noArtifactGrant.transport.connectionId,
        encoder.encode(JSON.stringify({
          v: 1,
          type: "partial",
          id: uuid7(177),
          rsid: noArtifactGrant.rsid,
          seq: 1,
          ack: 1,
          ts: NOW,
          payload: {
            kind: "chunk",
            invocation_id: uuid7(176),
            stream_id: `artifact:${uuid7(178)}`,
            artifact_id: uuid7(178),
            artifact_index: 0,
            chunk_index: 0,
            encoding: "base64",
            content_type: "image/png",
            data: Buffer.from("x").toString("base64"),
          },
        })),
      )).rejects.toThrow(/artifact_result_v1/);

      expect(noSessionGrant.core.snapshot().sessions[noSessionGrant.rsid]!.sequence.lastRxSeq).toBe(0);
      expect(noChunkGrant.core.snapshot().sessions[noChunkGrant.rsid]!.sequence.lastRxSeq).toBe(0);
      expect(noArtifactGrant.core.snapshot().sessions[noArtifactGrant.rsid]!.sequence.lastRxSeq).toBe(0);
    } finally {
      await Promise.all([
        noSessionGrant.core.close(),
        noChunkGrant.core.close(),
        noArtifactGrant.core.close(),
      ]);
    }
  });

  it("retains gateway-expiry and bridge-late terminal evidence without overwriting indeterminate classification", async () => {
    const fixture = await connectedCore("late-terminal-correlation");
    const scope = { kind: "document", document_id: "doc-01" } as const;
    const invocationId = uuid7(180);
    try {
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: mutatingInvoke(invocationId, scope),
      });
      await fixture.core.expirePendingNow(fixture.rsid);
      const afterExpiry = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(afterExpiry.terminalOutcomes[invocationId]).toMatchObject({
        classification: "journal_indeterminate",
        envelope: null,
      });
      expect(afterExpiry.expiredOrigins[invocationId]).toMatchObject({
        kind: "invoke",
        correlationId: invocationId,
      });

      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, invocationId))),
      );
      let retained = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(retained.terminalOutcomes[invocationId]).toMatchObject({
        classification: "journal_indeterminate",
        envelope: null,
      });
      expect(retained.lateTerminalEvidence[invocationId]).toEqual([
        expect.objectContaining({ classification: "result", source: "gateway_expiry" }),
      ]);

      const holdId = fixture.core.snapshot().mutationHolds.holds[0]!.holdId;
      const lateReplay = resultEnvelope(fixture.rsid, invocationId, 2, 1, 181);
      lateReplay.payload = {
        ...lateReplay.payload,
        replayed: true,
        late_after_indeterminate: true,
        verification_hold_id: holdId,
        result_digest: DIGEST,
      } as typeof lateReplay.payload;
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(lateReplay)),
      );
      retained = fixture.core.snapshot().sessions[fixture.rsid]!;
      expect(retained.lateTerminalEvidence[invocationId]).toEqual([
        expect.objectContaining({ source: "gateway_expiry" }),
        expect.objectContaining({ source: "bridge_late_replay" }),
      ]);
      expect(retained.terminalOutcomes[invocationId]!.classification).toBe("journal_indeterminate");
      expect(fixture.core.snapshot().mutationHolds.holds[0]!.state).toBe("active");

      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, uuid7(182), 3, 1, 182))),
      )).rejects.toThrow(/does not match the active invocation\/batch/);
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.sequence.lastRxSeq).toBe(2);
    } finally {
      await fixture.core.close();
    }
  });

  it("requires an explicit digest-bound audited correlated read for payload_omitted recovery", async () => {
    const fixture = await connectedCore("payload-omitted-recovery");
    const originId = uuid7(190);
    try {
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(originId),
      });
      const invalidOmitted = resultEnvelope(fixture.rsid, originId);
      invalidOmitted.payload = {
        ...invalidOmitted.payload,
        payload_omitted: true,
        result_digest: DIGEST,
        replayed: false,
      } as typeof invalidOmitted.payload;
      delete (invalidOmitted.payload as Record<string, unknown>).result;
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(invalidOmitted)),
      )).rejects.toThrow(/RBP envelope validation failed/);

      const omitted = {
        ...invalidOmitted,
        id: uuid7(191),
        payload: { ...invalidOmitted.payload, replayed: true },
      } as RbpEnvelope;
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(omitted)),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]).toMatchObject({
        terminalOutcomes: { [originId]: { classification: "payload_omitted" } },
        omittedPayloadRecoveries: {
          [originId]: {
            omittedResultDigest: DIGEST,
            state: "awaiting_correlated_read",
            auditId: null,
          },
        },
      });

      const independentId = uuid7(192);
      await fixture.core.dispatchInvoke({
        rsid: fixture.rsid,
        payload: readInvoke(independentId),
      });
      const independent = resultEnvelope(fixture.rsid, independentId, 2, 2, 192);
      independent.payload = { ...independent.payload, result_digest: DIGEST } as typeof independent.payload;
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(independent)),
      );
      expect(
        fixture.core.snapshot().sessions[fixture.rsid]!.omittedPayloadRecoveries[originId]!.state,
      ).toBe("awaiting_correlated_read");

      const recoveryId = uuid7(193);
      await expect(fixture.core.dispatchPayloadRecovery({
        rsid: fixture.rsid,
        originInvocationId: originId,
        omittedResultDigest: `sha256:${"f".repeat(64)}`,
        auditId: uuid7(194),
        payload: readInvoke(recoveryId),
      })).rejects.toThrow(/does not match a pending omitted result/);

      const auditId = uuid7(195);
      await fixture.core.dispatchPayloadRecovery({
        rsid: fixture.rsid,
        originInvocationId: originId,
        omittedResultDigest: DIGEST,
        auditId,
        payload: readInvoke(recoveryId),
      });
      await expect(fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(resultEnvelope(fixture.rsid, recoveryId, 3, 3, 196))),
      )).rejects.toThrow(/retained digest on a full correlated read result/);

      const recovered = resultEnvelope(fixture.rsid, recoveryId, 3, 3, 197);
      recovered.payload = {
        ...recovered.payload,
        result_digest: `sha256:${"3".repeat(64)}`,
      } as typeof recovered.payload;
      await fixture.core.receiveFrame(
        fixture.transport.connectionId,
        encoder.encode(JSON.stringify(recovered)),
      );
      expect(fixture.core.snapshot().sessions[fixture.rsid]!.omittedPayloadRecoveries[originId])
        .toMatchObject({
          state: "recovered",
          auditId,
          recoveryInvocationId: recoveryId,
          omittedResultDigest: DIGEST,
          recoveryResultDigest: `sha256:${"3".repeat(64)}`,
        });
    } finally {
      await fixture.core.close();
    }
  });
});
