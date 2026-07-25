import { existsSync } from "node:fs";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import { afterEach, describe, expect, it } from "vitest";

import { InjectedBridgeCrash, type BridgeCrashPoint } from "../src/bridgeSimulator.js";
import { discoverAddinSessions, isNumericLoopback } from "../src/loopback.js";
import {
  atomicBatch,
  mutationInvoke,
  readInvoke,
  simulatorForFixture,
  temporaryRoot,
  uuid,
} from "./helpers.js";

describe("BridgeSimulator with the real add-in loopback fixture", () => {
  const fixtures: AddinLoopbackFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.stop();
  });

  it("discovers multiple persistent sessions in one bounded scan without registry/temp-file coordination", async () => {
    let pair: { first: AddinLoopbackFixture; second: AddinLoopbackFixture; base: number } | null = null;
    for (let base = 31_000; base < 31_100 && pair === null; base += 2) {
      const first = new AddinLoopbackFixture({ port: base, processId: base });
      const second = new AddinLoopbackFixture({ port: base + 1, processId: base + 1 });
      try {
        await first.start();
        await second.start();
        pair = { first, second, base };
        fixtures.push(first, second);
      } catch {
        await first.stop();
        await second.stop();
      }
    }
    if (pair === null) throw new Error("could not reserve a two-port fixture range");
    const discovery = await discoverAddinSessions({
      host: "127.0.0.1",
      firstPort: pair.base,
      lastPort: pair.base + 1,
    });
    expect(discovery.sessions).toHaveLength(2);
    expect(discovery.sessions.every((session) => !session.client.closed)).toBe(true);
    expect(discovery.evidence).toMatchObject({
      source: "bounded_scan",
      tempRegistryReads: 0,
      filesystemLocksCreated: 0,
    });
    discovery.sessions.forEach((session) => session.client.close());
  });

  it("rejects every hostname, wildcard, and LAN target before a connector is called", async () => {
    expect(isNumericLoopback("127.1.2.3")).toBe(true);
    expect(isNumericLoopback("::1")).toBe(true);
    expect(isNumericLoopback("0:0:0:0:0:0:0:1")).toBe(true);
    let connectorCalls = 0;
    for (const host of ["localhost", "0.0.0.0", "::", "192.0.2.10"]) {
      const result = await discoverAddinSessions({
        explicitTarget: { host, port: 8080 },
        connector: async () => {
          connectorCalls += 1;
          throw new Error("must not run");
        },
      });
      expect(result.sessions).toHaveLength(0);
      expect(result.evidence.rejectedTargets).toHaveLength(1);
    }
    expect(connectorCalls).toBe(0);
  });

  it("probes the real fixture over IPv6 loopback when the runner exposes ::1", async () => {
    const fixture = new AddinLoopbackFixture({ host: "::1" });
    try {
      const address = await fixture.start();
      fixtures.push(fixture);
      const discovery = await discoverAddinSessions({ explicitTarget: address });
      expect(discovery.sessions).toHaveLength(1);
      expect(discovery.evidence.acceptedTargets[0]?.host).toBe("::1");
      discovery.sessions[0]?.client.close();
    } catch (error) {
      await fixture.stop();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw error;
    }
  });

  it("does not poll mcp_status per normal invocation and replays a terminal without add-in contact", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1 });
    const first = await simulator.invoke(envelope);
    expect(first).toMatchObject({ kind: "result", status: "completed", replayed: false, addinContacted: true });
    expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);
    const replayEnvelope = { ...envelope, id: uuid(), seq: 2 };
    const replay = await simulator.invoke(replayEnvelope);
    expect(replay).toMatchObject({ kind: "result", status: "completed", replayed: true, addinContacted: false });
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(1);
    expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);
    const heartbeat = await simulator.heartbeat();
    expect(heartbeat).toMatchObject({
      bridge_version: "bridge-simulator-0.0.0",
      // Direct simulator use has not yet bound seq=2's reply to a durable
      // delivery plan, so the reverse cumulative ACK stops at seq=1.
      acks: [{ rsid, seq: 1 }],
      sessions: [{ rsid, revit_status: { addin_reachable: true, active_task: null } }],
    });
    expect(fixture.getMethodExecutionCount("mcp_status")).toBe(2);
    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("classifies an invoke for a real but locally unregistered rsid as authorization and never contacts the add-in", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const registeredRsid = uuid();
    const foreignRsid = uuid();
    const { simulator, journal } = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid: registeredRsid,
    });
    const envelope = readInvoke({ rsid: foreignRsid, seq: 1 });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "auth",
      message: "invoke targets an unregistered rsid",
      outcome: "known",
      replayed: false,
      addinContacted: false,
    });
    expect(journal.listInvocations()).toEqual([]);
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(0);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("rejects an explicit mismatched params_digest before journaling or add-in dispatch while consuming seq", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    envelope.payload.params_digest = `sha256:${"0".repeat(64)}`;
    const outcome = await simulator.invoke(envelope);
    expect(outcome).toMatchObject({ kind: "error", faultClass: "protocol", addinContacted: false });
    expect(journal.listInvocations()).toEqual([]);
    expect(journal.loadSequence(rsid).lastRxSeq).toBe(1);
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(0);
    simulator.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("uses a bounded side-channel status read while the command slot is timed out", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1, method: "fixture_counter" });
    envelope.payload.timeout_ms = 25;
    fixture.planFault(envelope.payload.invocation_id, { delayMs: 100 });
    const invocation = simulator.invoke(envelope);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = await simulator.heartbeat();
    expect(heartbeat.sessions[0]?.revit_status).toMatchObject({ addin_reachable: true });
    const outcome = await invocation;
    expect(outcome).toMatchObject({
      kind: "error",
      faultClass: "revit_busy",
      addinContacted: true,
    });
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(0);
    expect(fixture.getMethodExecutionCount("mcp_status")).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(1);
    const followUp = readInvoke({ rsid, seq: 2, method: "fixture_counter" });
    await expect(simulator.invoke(followUp)).resolves.toMatchObject({ kind: "result" });
    expect(fixture.getExecutionCount(envelope.payload.invocation_id)).toBe(1);
    simulator.close();
    journal.close();
    await fixture.stop();
    root.cleanup();
  });

  it("uses exactly one execute_batch frame and durably replays the carrier", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = atomicBatch(rsid, 1);
    const first = await simulator.invokeBatch(envelope);
    expect(first).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      replayed: false,
    });
    expect(fixture.getExecutionCount(envelope.payload.batch_id)).toBe(1);
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);
    for (const step of envelope.payload.steps) {
      expect(fixture.getExecutionCount(step.invocation_id)).toBe(1);
      expect(journal.getInvocation(rsid, step.invocation_id)?.state).toBe("completed");
    }
    const replayEnvelope = { ...envelope, id: uuid(), seq: 2 };
    const replay = await simulator.invokeBatch(replayEnvelope);
    expect(replay).toMatchObject({ kind: "batch", status: "completed", replayed: true });
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);
    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("rolls back an atomic guarded step and does not assimilate model state", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:42", { deleted: true });
      return { state: "guarded", guardedReason: "protected_view" };
    });
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const result = await simulator.invokeBatch(atomicBatch(rsid, 1));
    expect(result).toMatchObject({
      kind: "batch",
      status: "guarded",
      transactionState: "rolled_back",
      failedStepIndex: 1,
    });
    expect(fixture.modelState.has("view:42")).toBe(false);
    expect(journal.listHolds()).toHaveLength(0);
    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("survives a kill point after one mutation: redelivery and fresh id never execute it again", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const invocationId = uuid();
    const journalPath = join(root.path, "durable.db");
    const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName: "spool-a" });
    const envelope = mutationInvoke({ rsid, seq: 1, invocationId });
    await expect(first.simulator.invoke(envelope, {
      crashAt: "after_addin_response_before_terminal",
    })).rejects.toBeInstanceOf(InjectedBridgeCrash);
    first.simulator.close();
    first.journal.close();

    const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName: "spool-b" });
    const redeliveryEnvelope = { ...envelope, id: uuid(), seq: 2 };
    const redelivery = await second.simulator.invoke(redeliveryEnvelope);
    expect(redelivery).toMatchObject({
      kind: "error",
      faultClass: "journal_indeterminate",
      outcome: "indeterminate",
      verificationRequired: true,
      addinContacted: false,
    });
    const fresh = await second.simulator.invoke(mutationInvoke({ rsid, seq: 3, documentId: "doc-01" }));
    expect(fresh).toMatchObject({
      kind: "error",
      faultClass: "journal_indeterminate",
      addinContacted: false,
    });
    expect(fixture.getExecutionCount(invocationId)).toBe(1);
    expect(second.journal.listHolds()).toHaveLength(1);
    second.simulator.close();
    second.journal.close();
    expect(existsSync(journalPath)).toBe(true);
    root.cleanup();
  });

  it("distinguishes known-not-dispatched and possibly-dispatched crash points", async () => {
    const cases: Array<{ readonly point: BridgeCrashPoint; readonly expectedHolds: number }> = [
      { point: "after_received_before_dispatch", expectedHolds: 0 },
      { point: "after_executing_before_addin_write", expectedHolds: 1 },
    ];
    for (const scenario of cases) {
      const root = temporaryRoot();
      const fixture = new AddinLoopbackFixture();
      fixtures.push(fixture);
      await fixture.start();
      const rsid = uuid();
      const invocationId = uuid();
      const journalPath = join(root.path, "durable.db");
      const first = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName: "spool-a" });
      await expect(first.simulator.invoke(mutationInvoke({ rsid, seq: 1, invocationId }), {
        crashAt: scenario.point,
      })).rejects.toBeInstanceOf(InjectedBridgeCrash);
      first.simulator.close();
      first.journal.close();
      const second = await simulatorForFixture({ fixture, root: root.path, rsid, journalPath, spoolName: "spool-b" });
      expect(second.journal.listHolds()).toHaveLength(scenario.expectedHolds);
      expect(fixture.getExecutionCount(invocationId)).toBe(0);
      second.simulator.close();
      second.journal.close();
      root.cleanup();
    }
  });

  it("durably captures a correlated late mutation terminal without clearing its hold", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const invocationId = uuid();
    fixture.planFault(invocationId, { delayMs: 60 });
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const base = mutationInvoke({ rsid, seq: 1, invocationId });
    const envelope = { ...base, payload: { ...base.payload, timeout_ms: 10 } };
    const uncertain = await simulator.invoke(envelope);
    expect(uncertain).toMatchObject({
      kind: "error",
      faultClass: "journal_indeterminate",
      outcome: "indeterminate",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retained = journal.getInvocation(rsid, invocationId);
    expect(retained?.state).toBe("indeterminate");
    expect(retained?.lateTerminalOutcome).toMatchObject({ status: "completed" });
    expect(retained?.lateTerminalOutcome?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(journal.listHolds()[0]?.state).toBe("active");
    expect(fixture.getExecutionCount(invocationId)).toBe(1);
    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("never retains or replays a local artifact path from a late mutation response", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    const secretPath = "C:\\ProgramData\\DPE\\revAgent\\spool\\secret-export.xlsx";
    fixture.registerHandler("send_code_to_revit", "model_transaction", () => ({
      state: "completed",
      result: {
        success: true,
        files: [{ path: secretPath, contentType: "application/octet-stream" }],
      },
    }));
    fixtures.push(fixture);
    await fixture.start();
    const rsid = uuid();
    const invocationId = uuid();
    fixture.planFault(invocationId, { delayMs: 60 });
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const base = mutationInvoke({ rsid, seq: 1, invocationId });
    const envelope = { ...base, payload: { ...base.payload, timeout_ms: 10 } };

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "journal_indeterminate",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = journal.getInvocation(rsid, invocationId);
    expect(record?.lateTerminalOutcome).toMatchObject({
      status: "completed",
      payloadRetained: false,
      resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(record)).not.toContain(secretPath);

    const replayEnvelope = { ...envelope, id: uuid(), seq: 2 };
    const replay = await simulator.invoke(replayEnvelope);
    expect(replay).toMatchObject({
      kind: "result",
      status: "completed",
      replayed: true,
      payloadOmitted: true,
    });
    expect(JSON.stringify(replay)).not.toContain(secretPath);

    simulator.close();
    journal.close();
    root.cleanup();
  });
});
