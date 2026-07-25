#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

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

interface DaemonState {
  readonly root: string;
  readonly preserveState: boolean;
  readonly source: "temporary" | "argument" | "environment";
}

const STATE_ROOT_ENV = "REVAGENT_BRIDGE_STATE_ROOT";
const MAX_STATE_ROOT_LENGTH = 4_096;
const TEMP_STATE_PREFIX = "revagent-bridge-daemon-";

function temporaryStateGuardian(root: string): ChildProcess {
  const script = String.raw`
const { rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, resolve } = require("node:path");
const root = resolve(process.argv[1] || "");
const temp = resolve(tmpdir());
if (dirname(root) !== temp || !basename(root).startsWith("revagent-bridge-daemon-")) process.exit(2);
const parentPid = process.ppid;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { rmSync(root, { recursive: true, force: true }); process.exit(0); }
  catch { process.exit(1); }
};
setInterval(() => {
  try { process.kill(parentPid, 0); }
  catch { cleanup(); }
}, 50);
`;
  const guardian = spawn(process.execPath, ["-e", script, root], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  guardian.unref();
  return guardian;
}

function absoluteStateRoot(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_STATE_ROOT_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded path without control characters`);
  }
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const root = resolve(value);
  if (parse(root).root === root) throw new Error(`${label} must not be a filesystem root`);
  return root;
}

function daemonState(args: readonly string[]): DaemonState {
  let argumentRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--state-root") throw new Error(`unknown daemon option: ${String(arg)}`);
    if (argumentRoot !== undefined) throw new Error("--state-root may be supplied only once");
    const value = args[index + 1];
    if (value === undefined) throw new Error("--state-root requires an absolute path");
    argumentRoot = absoluteStateRoot(value, "--state-root");
    index += 1;
  }
  const environmentValue = process.env[STATE_ROOT_ENV];
  if (argumentRoot !== undefined && environmentValue !== undefined) {
    throw new Error(`--state-root cannot be combined with ${STATE_ROOT_ENV}`);
  }
  if (argumentRoot !== undefined) {
    return { root: argumentRoot, preserveState: true, source: "argument" };
  }
  if (environmentValue !== undefined) {
    return {
      root: absoluteStateRoot(environmentValue, STATE_ROOT_ENV),
      preserveState: true,
      source: "environment",
    };
  }
  return {
    root: mkdtempSync(join(tmpdir(), TEMP_STATE_PREFIX)),
    preserveState: false,
    source: "temporary",
  };
}

const RSID = "0197a3c2-0000-7000-8000-000000000001";
const INVOCATION_ID = "0197a3c2-0000-7000-8000-000000000002";
const FRESH_INVOCATION_ID = "0197a3c2-0000-7000-8000-000000000003";
const REDELIVERY_ENVELOPE_ID = "0197a3c2-0000-7000-8000-000000000004";

function invoke(invocationId: string, seq: number, envelopeId = invocationId): InvokeEnvelope {
  return {
    v: 1,
    type: "invoke",
    id: envelopeId,
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
    const redelivery = await simulator.invoke(invoke(INVOCATION_ID, 2, REDELIVERY_ENVELOPE_ID));
    const fresh = await simulator.invoke(invoke(FRESH_INVOCATION_ID, 3));
    const evidence = {
      scenario: "crash-recovery",
      externalFixture: externalFixture !== undefined,
      crashPoint,
      addinExecutionCount: fixture?.getExecutionCount(INVOCATION_ID) ?? null,
      redelivery: {
        kind: redelivery.kind,
        faultClass: redelivery.kind === "error" ? redelivery.faultClass : null,
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
  const state = daemonState(args);
  const guardian = state.preserveState ? null : temporaryStateGuardian(state.root);
  const stopGuardian = (): void => {
    if (guardian === null) return;
    if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGTERM");
    guardian.unref();
  };
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (!state.preserveState) rmSync(state.root, { recursive: true, force: false });
  };
  let runtime: BridgeDaemonRuntime;
  try {
    runtime = new BridgeDaemonRuntime(state.root);
  } catch (error) {
    cleanup();
    stopGuardian();
    throw error;
  }
  const finish = (): void => {
    try {
      cleanup();
      stopGuardian();
      process.stdin.pause();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`bridge daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  const control = new BridgeJsonlControl(runtime, process.stdin, process.stdout, () => {
    finish();
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await control.stopAndDrain();
      await runtime.shutdown();
      finish();
    } catch (error) {
      process.stderr.write(`bridge daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  control.start();
  process.stdout.write(`${JSON.stringify({
    ready: true,
    component: "bridge-simulator",
    componentRole: "O1-T4",
    contract: "bridge-simulator-control/v1",
    controlVersion: BRIDGE_CONTROL_VERSION,
    maxControlLineBytes: MAX_BRIDGE_CONTROL_LINE_BYTES,
    pid: process.pid,
    actions: BRIDGE_CONTROL_ACTIONS,
    transportTrust: {
      loopbackTestTlsPolicy: "loopback_test_tls",
      caIdentity: "absolute_path_and_exact_byte_sha256",
      serverIdentity: "leaf_der_sha256",
      numericLoopbackOnly: true,
      rejectUnauthorized: true,
    },
    stateRoot: state.root,
    preserveState: state.preserveState,
    stateRootSource: state.source,
  })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "daemon") {
    await daemon(process.argv.slice(3));
    return;
  }
  if (command !== "crash-recovery") {
    process.stderr.write(
      "usage: revagent-bridge-simulator daemon [--state-root ABSOLUTE_PATH] | " +
      "crash-recovery [--fixture-host IP --fixture-port PORT]\n",
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
