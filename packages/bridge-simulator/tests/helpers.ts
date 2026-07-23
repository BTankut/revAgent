import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  makeBatchDigest,
  makeParamsDigest,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type JsonValue,
} from "@revagent/protocol";

import { ArtifactSpool, DeterministicUuid7Source } from "../src/artifacts.js";
import { BridgeSimulator } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { discoverAddinSessions } from "../src/loopback.js";

let idCounter = 100;

export function uuid(): string {
  idCounter += 1;
  return `0197a3c2-0000-7000-8000-${idCounter.toString().padStart(12, "0")}`;
}

export function temporaryRoot(): { readonly path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "bridge-simulator-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function readInvoke(input: {
  readonly rsid: string;
  readonly seq: number;
  readonly invocationId?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}): InvokeEnvelope {
  const invocationId = input.invocationId ?? uuid();
  return {
    v: 1,
    type: "invoke",
    id: uuid(),
    rsid: input.rsid,
    seq: input.seq,
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      invocation_id: invocationId,
      method: input.method ?? "fixture_counter",
      params: input.params ?? {},
      timeout_ms: 5_000,
      mutating: false,
      mutation_scope: null,
      policy: { class: "auto", decision: "auto", confirmation_id: null },
      verification: null,
      recovery_clearances: [],
    },
  };
}

export function mutationInvoke(input: {
  readonly rsid: string;
  readonly seq: number;
  readonly invocationId?: string;
  readonly documentId?: string;
}): InvokeEnvelope {
  const invocationId = input.invocationId ?? uuid();
  return {
    v: 1,
    type: "invoke",
    id: uuid(),
    rsid: input.rsid,
    seq: input.seq,
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      invocation_id: invocationId,
      method: "send_code_to_revit",
      params: { fixture: true },
      timeout_ms: 5_000,
      mutating: true,
      mutation_scope: { kind: "document", document_id: input.documentId ?? "doc-01" },
      policy: { class: "confirm", decision: "confirmed", confirmation_id: "confirmed-for-test" },
      verification: null,
      recovery_clearances: [],
    },
  };
}

export function atomicBatch(rsid: string, seq: number): InvokeBatchEnvelope {
  const batchId = uuid();
  const readId = uuid();
  const mutationId = uuid();
  const steps: InvokeBatchEnvelope["payload"]["steps"] = [
    {
      invocation_id: readId,
      method: "get_ui_state",
      params: {},
      params_digest: makeParamsDigest({}),
      mutating: false,
      mutation_scope: null,
      policy: { class: "auto", decision: "auto", confirmation_id: null },
    },
    {
      invocation_id: mutationId,
      method: "delete_review_view",
      params: { viewId: 42, mode: "commit", confirmDelete: true, viewType: "ThreeD" },
      params_digest: makeParamsDigest({ viewId: 42, mode: "commit", confirmDelete: true, viewType: "ThreeD" }),
      mutating: true,
      mutation_scope: { kind: "document", document_id: "doc-01" },
      policy: { class: "confirm", decision: "confirmed", confirmation_id: "batch-confirmation" },
    },
  ];
  const payloadWithoutDigest = {
    batch_id: batchId,
    atomic: true,
    timeout_ms: 5_000,
    recovery_clearances: [],
    steps,
  };
  return {
    v: 1,
    type: "invoke_batch",
    id: uuid(),
    rsid,
    seq,
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      ...payloadWithoutDigest,
      batch_digest: makeBatchDigest({
        atomic: true,
        batch_id: batchId,
        recovery_clearances: [],
        steps: steps.map((step) => ({
          invocation_id: step.invocation_id,
          method: step.method,
          mutating: step.mutating,
          mutation_scope: step.mutation_scope as unknown as JsonValue,
          params_digest: step.params_digest,
          policy: step.policy,
        })),
        timeout_ms: 5_000,
      }),
    },
  };
}

export async function simulatorForFixture(input: {
  readonly fixture: AddinLoopbackFixture;
  readonly root: string;
  readonly rsid: string;
  readonly journalPath?: string;
  readonly spoolName?: string;
}): Promise<{ readonly simulator: BridgeSimulator; readonly journal: DurableBridgeJournal }> {
  const address = input.fixture.address ?? await input.fixture.start();
  const discovery = await discoverAddinSessions({
    explicitTarget: { host: address.host, port: address.port },
  });
  const probe = discovery.sessions[0];
  if (probe === undefined) throw new Error("fixture was not discovered");
  const journal = new DurableBridgeJournal(input.journalPath ?? join(input.root, "bridge.db"));
  const ids = new DeterministicUuid7Source();
  const simulator = new BridgeSimulator(
    journal,
    new ArtifactSpool(join(input.root, input.spoolName ?? "spool"), () => ids.next()),
  );
  const registration = await simulator.registrationForProbe({
    probe,
    requestId: uuid(),
    userHint: "fixture-user",
    hostname: "fixture-host",
    fingerprint: "fixture-fingerprint",
    bridgeVersion: "bridge-simulator-test",
  });
  simulator.attachSession({
    rsid: input.rsid,
    resumeToken: "resume-token",
    resumeExpiresAt: "2026-07-22T01:00:00.000Z",
    grantedSessionCapabilities: probe.sessionCapabilities,
    probe,
    registration,
  });
  return { simulator, journal };
}
