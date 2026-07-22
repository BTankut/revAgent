#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import { type InvokeEnvelope } from "@revagent/protocol";

import { ArtifactSpool, DeterministicUuid7Source } from "./artifacts.js";
import { BridgeSimulator, InjectedBridgeCrash } from "./bridgeSimulator.js";
import {
  BRIDGE_CONTROL_ACTIONS,
  BRIDGE_CONTROL_VERSION,
  MAX_BRIDGE_CONTROL_LINE_BYTES,
  BridgeDaemonRuntime,
  BridgeJsonlControl,
} from "./control.js";
import { DurableBridgeJournal } from "./journal.js";
import { discoverAddinSessions } from "./loopback.js";

interface ExternalFixtureTarget {
  readonly host: string;
  readonly port: number;
}

const RSID = "0197a3c2-0000-7000-8000-000000000001";
const INVOCATION_ID = "0197a3c2-0000-7000-8000-000000000002";
const FRESH_INVOCATION_ID = "0197a3c2-0000-7000-8000-000000000003";

function invoke(invocationId: string, seq: number): InvokeEnvelope {
  return {
    v: 1,
    type: "invoke",
    id: invocationId,
    rsid: RSID,
    seq,
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      invocation_id: invocationId,
      method: "delete_review_view",
      params: { viewId: 42, mode: "commit", confirmDelete: true, viewType: "ThreeD" },
      timeout_ms: 5_000,
      mutating: true,
      mutation_scope: { kind: "document", document_id: "fixture-doc-01" },
      policy: { class: "confirm", decision: "confirmed", confirmation_id: "demo-confirmation" },
      verification: null,
      recovery_clearances: [],
    },
  };
}

async function attach(simulator: BridgeSimulator, port: number): Promise<void> {
  const discovery = await discoverAddinSessions({
    explicitTarget: { host: "127.0.0.1", port },
  });
  const probe = discovery.sessions[0];
  if (probe === undefined) throw new Error("fixture discovery failed");
  const registration = await simulator.registrationForProbe({
    probe,
    requestId: `registration-${port}`,
    userHint: "fixture",
    hostname: "fixture-host",
    fingerprint: `sha256:${"0".repeat(64)}`,
    bridgeVersion: "0.0.0",
  });
  simulator.attachSession({
    rsid: RSID,
    resumeToken: "resume-token",
    resumeExpiresAt: "2026-07-22T01:00:00.000Z",
    grantedSessionCapabilities: probe.sessionCapabilities,
    probe,
    registration,
  });
}

async function crashRecovery(externalFixture?: ExternalFixtureTarget): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "revagent-bridge-simulator-"));
  const fixture = externalFixture === undefined
    ? new AddinLoopbackFixture({ processId: 4242 })
    : null;
  const address = externalFixture ?? await (fixture as AddinLoopbackFixture).start();
  const journalPath = join(root, "bridge.db");
  try {
    let journal = new DurableBridgeJournal(journalPath);
    let ids = new DeterministicUuid7Source();
    let simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root, "spool-a"), () => ids.next()));
    await attach(simulator, address.port);
    let crashPoint = "none";
    try {
      const unexpected = await simulator.invoke(invoke(INVOCATION_ID, 1), {
        crashAt: "after_addin_response_before_terminal",
      });
      throw new Error(`crash injection did not fire: ${JSON.stringify(unexpected)}`);
    } catch (error) {
      if (!(error instanceof InjectedBridgeCrash)) {
        simulator.close();
        journal.close();
        throw error;
      }
      crashPoint = error.point;
    }
    simulator.close();
    journal.close();

    journal = new DurableBridgeJournal(journalPath);
    ids = new DeterministicUuid7Source();
    simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root, "spool-b"), () => ids.next()));
    await attach(simulator, address.port);
    const redelivery = await simulator.invoke(invoke(INVOCATION_ID, 1));
    const fresh = await simulator.invoke(invoke(FRESH_INVOCATION_ID, 2));
    const evidence = {
      scenario: "crash-recovery",
      externalFixture: externalFixture !== undefined,
      crashPoint,
      addinExecutionCount: fixture?.getExecutionCount(INVOCATION_ID) ?? null,
      redelivery: {
        kind: redelivery.kind,
        outcome: redelivery.kind === "error" ? redelivery.outcome : "known",
        verificationRequired: redelivery.kind === "error" && redelivery.verificationRequired,
        addinContacted: redelivery.addinContacted,
      },
      freshInvocationBlocked: fresh.kind === "error" && fresh.faultClass === "journal_indeterminate",
      unclearedHoldCount: journal.listHolds().filter((hold) => hold.state !== "cleared").length,
      tempRegistryReads: 0,
      filesystemLocksCreated: 0,
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    simulator.close();
    journal.close();
  } finally {
    await fixture?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

async function daemon(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new Error("daemon does not accept command-line options");
  const root = mkdtempSync(join(tmpdir(), "revagent-bridge-daemon-"));
  const runtime = new BridgeDaemonRuntime(root);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(root, { recursive: true, force: true });
  };
  process.stdout.write(`${JSON.stringify({
    ready: true,
    component: "bridge-simulator",
    componentRole: "O1-T4",
    contract: "bridge-simulator-control/v1",
    controlVersion: BRIDGE_CONTROL_VERSION,
    maxControlLineBytes: MAX_BRIDGE_CONTROL_LINE_BYTES,
    pid: process.pid,
    actions: BRIDGE_CONTROL_ACTIONS,
  })}\n`);
  const control = new BridgeJsonlControl(runtime, process.stdin, process.stdout, () => {
    cleanup();
    process.exitCode = 0;
  });
  control.start();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    control.close();
    await runtime.shutdown();
    cleanup();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "daemon") {
    await daemon(process.argv.slice(3));
    return;
  }
  if (command !== "crash-recovery") {
    process.stderr.write(
      "usage: revagent-bridge-simulator daemon | crash-recovery [--fixture-host IP --fixture-port PORT]\n",
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(3);
  let fixtureHost: string | undefined;
  let fixturePort: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fixture-host") fixtureHost = args[++index];
    else if (arg === "--fixture-port") {
      const raw = args[++index];
      if (raw === undefined || !/^\d+$/u.test(raw)) throw new Error("--fixture-port requires an integer");
      fixturePort = Number(raw);
    } else throw new Error(`unknown option: ${String(arg)}`);
  }
  if ((fixtureHost === undefined) !== (fixturePort === undefined)) {
    throw new Error("--fixture-host and --fixture-port must be supplied together");
  }
  await crashRecovery(
    fixtureHost === undefined || fixturePort === undefined
      ? undefined
      : { host: fixtureHost, port: fixturePort },
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
