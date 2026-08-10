import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AddinLoopbackFixture } from "../../addin-loopback-fixture/dist/index.js";
import {
  ArtifactSpool,
  BridgeSimulator,
  DeterministicUuid7Source,
  DurableBridgeJournal,
  discoverAddinSessions,
  type BridgeBatchOutcome,
} from "../../bridge-simulator/dist/index.js";
import {
  makeParamsDigest,
  type BatchResult,
  type JsonValue,
  type HelloEnvelope,
  type InvokeBatchEnvelope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayAtomicBatchAuthorizationError,
  authorizeGatewayAtomicBatch,
} from "./batchDispatch.js";
import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  GatewayRecoveryAuthority,
  type GatewayAuditedRecoveryDecisionPort,
} from "./recoveryAuthority.js";
import { GatewayToolRegistry, type GatewayToolRecord } from "./registry.js";
import { createRestartableTestStore } from "./testAdapters.js";

let idOffset = 0;
const id = (): string => gatewayUuidV7(1_786_300_000_000 + idOffset++);

const inputSchema = Object.freeze({
  viewId: z.number().int(),
  mode: z.literal("commit"),
  confirmDelete: z.literal(true),
  viewType: z.literal("ThreeD"),
});

const toolRecord: GatewayToolRecord = Object.freeze({
  name: "fixture.delete_review_view",
  summary: "Delete one disposable fixture review view.",
  namespace: "fixture",
  version: "1.0.0",
  policyClass: "confirm",
  mutationScopePolicy: "document",
  executor: "bridge",
  executorMethod: "delete_review_view",
  inputSchema,
  inputJsonSchema: z.toJSONSchema(z.object(inputSchema).strict(), { io: "input" }),
});

function deviceIdentity(): IdentityPort {
  return {
    kind: "oidc",
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside this fixture",
      };
    },
    async authenticateDevice(input) {
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: "tenant-gw16",
          userId: "user-gw16",
          deviceId: "device-gw16",
          seatId: "seat-gw16",
        },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedSessionCapabilities: ["batch_atomic"],
        deviceTokenDigest: `sha256:${"3".repeat(64)}`,
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["batch_atomic"],
      bridge_version: "gw16-test",
      device_id: "device-gw16",
      machine: { hostname: "gw16-test", os: "windows" },
      addin_versions: ["gw16-test"],
    },
  };
}

function registration(): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: "local-gw16",
      user_hint: { name: "fixture" },
      machine: {
        hostname: "gw16-test",
        fingerprint: `sha256:${"4".repeat(64)}`,
      },
      revit: { version: "2025", build: "fixture", pid: 1616 },
      addin_version: "gw16-test",
      result_contract_version: 1,
      session_capabilities: ["batch_atomic"],
      bridge_version: "gw16-test",
      documents: [],
      port: 48884,
    },
  };
}

function step(rsid: string, index: number): GatewayExecutorRequest {
  const args: GatewayJsonObject = {
    viewId: 100 + index,
    mode: "commit",
    confirmDelete: true,
    viewType: "ThreeD",
  };
  const invocationId = id();
  return {
    toolName: toolRecord.name,
    toolVersion: toolRecord.version,
    executorMethod: toolRecord.executorMethod,
    policyClass: toolRecord.policyClass,
    mutationScopePolicy: toolRecord.mutationScopePolicy,
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: "tenant-gw16:user-gw16",
      actor: { tenantId: "tenant-gw16", userId: "user-gw16", role: "user" },
      gatewaySessionId: "gateway-session-gw16",
      oauthClientId: "oauth-client-gw16",
      mcpSessionId: "mcp-session-gw16",
      rsid,
      toolName: toolRecord.name,
      toolVersion: toolRecord.version,
      policyClass: "confirm",
      policyDecision: "confirmed",
      confirmationId: "batch-confirmation-gw16",
      originatingPreviewInvocationId: id(),
      mutationScopePolicy: "document",
      mutating: true,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "doc-gw16" },
      paramsDigest: makeParamsDigest(args as unknown as JsonValue),
      mutationScope: { kind: "document", document_id: "doc-gw16" },
      startedAtMs: 1_786_300_000_000,
    },
  };
}

async function simulatorForFixture(input: {
  readonly fixture: AddinLoopbackFixture;
  readonly root: string;
  readonly rsid: string;
}): Promise<{
  readonly simulator: BridgeSimulator;
  readonly journal: DurableBridgeJournal;
}> {
  const address = input.fixture.address ?? (await input.fixture.start());
  const discovery = await discoverAddinSessions({ explicitTarget: address });
  const probe = discovery.sessions[0];
  if (probe === undefined) throw new Error("fixture was not discovered");
  const journal = new DurableBridgeJournal(join(input.root, "bridge.db"));
  const ids = new DeterministicUuid7Source();
  const simulator = new BridgeSimulator(
    journal,
    new ArtifactSpool(join(input.root, "spool"), () => ids.next()),
  );
  const bridgeRegistration = await simulator.registrationForProbe({
    probe,
    requestId: id(),
    userHint: "fixture-user",
    hostname: "fixture-host",
    fingerprint: "fixture-fingerprint",
    bridgeVersion: "bridge-simulator-test",
  });
  simulator.attachSession({
    rsid: input.rsid,
    resumeToken: "resume-token",
    resumeExpiresAt: "2026-08-11T00:00:00.000Z",
    grantedSessionCapabilities: probe.sessionCapabilities,
    probe,
    registration: bridgeRegistration,
  });
  return { simulator, journal };
}

function completedCarrier(
  envelope: InvokeBatchEnvelope,
  outcome: BridgeBatchOutcome,
): Extract<RbpEnvelope, { type: "result" }> {
  if (
    outcome.kind !== "batch" ||
    outcome.status !== "completed" ||
    outcome.transactionState !== "committed" ||
    outcome.steps === undefined
  ) {
    throw new Error("fixture did not return a committed atomic batch");
  }
  const steps = envelope.payload.steps.map((batchStep, index) => {
    const result = outcome.steps![index];
    if (result?.kind !== "result" || result.status !== "completed") {
      throw new Error(`fixture batch step ${index} did not complete`);
    }
    return {
      index,
      invocation_id: batchStep.invocation_id,
      status: "completed" as const,
      replayed: false as const,
      result: result.result ?? null,
      result_digest: result.resultDigest,
    };
  }) as BatchResult["steps"];
  return {
    v: 1,
    type: "result",
    id: id(),
    rsid: envelope.rsid,
    seq: 1,
    ack: envelope.seq,
    ts: new Date().toISOString(),
    payload: {
      kind: "batch",
      batch_id: envelope.payload.batch_id,
      atomic: true,
      status: "completed",
      transaction_state: "committed",
      failed_step_index: null,
      replayed: false,
      steps,
    },
  };
}

describe("GW-16 registry-authorized atomic batch", () => {
  const fixtures: AddinLoopbackFixture[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.stop()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("rejects a step whose executor method diverges from the registry", () => {
    const registry = new GatewayToolRegistry([toolRecord]);
    const request = step(id(), 0);
    expect(() =>
      authorizeGatewayAtomicBatch({
        registry,
        batchId: id(),
        steps: [{ ...request, executorMethod: "send_code_to_revit" }],
      }),
    ).toThrowError(GatewayAtomicBatchAuthorizationError);
  });

  it("sends five authorized steps in one atomic frame and replays without duplicate add-in execution", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      deviceIdentity(),
    );
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;
    const registry = new GatewayToolRegistry([toolRecord]);
    const batch = authorizeGatewayAtomicBatch({
      registry,
      batchId: id(),
      steps: Array.from({ length: 5 }, (_, index) =>
        step(registered.payload.rsid, index),
      ),
    });
    const executor = authority.createExecutor();
    const draft = executor.buildAtomicBatchDispatch!(batch);
    const envelope = draft.envelope as InvokeBatchEnvelope;
    expect(envelope.payload.steps).toHaveLength(5);
    expect(envelope.payload.atomic).toBe(true);

    const evidenceDecision: GatewayAuditedRecoveryDecisionPort = {
      async decideEvidence() {
        return {
          kind: "decided",
          conclusion: "inconclusive",
          authorityReference: "gw16-fixture-only",
          decisionVersion: 1,
          decidedAtMs: Date.now(),
        };
      },
    };
    const recovery = new GatewayRecoveryAuthority(restartable.store, {
      bridgeEvidence: authority,
      evidenceDecision,
    });
    const attemptId = id();
    await expect(
      recovery.acquireInvocationWindow({
        tenantId: "tenant-gw16",
        rsid: registered.payload.rsid,
        attemptId,
      }),
    ).resolves.toMatchObject({ kind: "acquired" });
    await expect(
      recovery.preflightMutation({
        tenantId: "tenant-gw16",
        rsid: registered.payload.rsid,
        mutationScopes: batch.steps.map(
          (batchStep) => batchStep.context.mutationScope!,
        ),
      }),
    ).resolves.toMatchObject({ kind: "clear" });
    const preparation = await recovery.prepareMutationDispatch({
      tenantId: "tenant-gw16",
      attemptId,
      sessionBindingId: draft.sessionBindingId,
      connectionId: draft.connectionId,
      envelope,
      expected: draft.expected,
    });
    if (preparation.kind !== "prepared") {
      throw new Error(`batch preparation failed: ${preparation.kind}`);
    }
    const prepared = preparation.dispatch;

    const pending = executor.executePreparedAtomicBatch!(batch, prepared);
    while (!sent.some((candidate) => candidate.type === "invoke_batch")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const dispatched = sent.filter(
      (candidate) => candidate.type === "invoke_batch",
    ) as InvokeBatchEnvelope[];
    expect(dispatched).toHaveLength(1);

    const root = mkdtempSync(join(tmpdir(), "gateway-gw16-"));
    roots.push(root);
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    await fixture.start();
    const bridge = await simulatorForFixture({
      fixture,
      root,
      rsid: registered.payload.rsid,
    });
    const first = await bridge.simulator.invokeBatch(dispatched[0]!);
    expect(first).toMatchObject({
      kind: "batch",
      status: "completed",
      transactionState: "committed",
      replayed: false,
    });
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);
    for (const batchStep of dispatched[0]!.payload.steps) {
      expect(fixture.getExecutionCount(batchStep.invocation_id)).toBe(1);
    }

    await authority.receive(
      opening.connectionId,
      completedCarrier(dispatched[0]!, first),
    );
    await expect(pending).resolves.toMatchObject({ state: "completed" });

    const reconciled = await recovery.reconcilePendingDispatch({
      tenantId: "tenant-gw16",
      rsid: registered.payload.rsid,
      envelopeDigest: prepared.envelopeDigest,
    });
    expect(reconciled).toMatchObject({
      kind: "terminal_recorded",
      terminalBatch: { result: { batch_id: batch.batchId, status: "completed" } },
    });
    await expect(
      recovery.releaseInvocationWindow({
        tenantId: "tenant-gw16",
        rsid: registered.payload.rsid,
        attemptId,
      }),
    ).resolves.toMatchObject({ kind: "released" });

    const replay = await bridge.simulator.invokeBatch({
      ...dispatched[0]!,
      id: id(),
      seq: dispatched[0]!.seq + 1,
    });
    expect(replay).toMatchObject({
      kind: "batch",
      status: "completed",
      replayed: true,
    });
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);
    for (const batchStep of dispatched[0]!.payload.steps) {
      expect(fixture.getExecutionCount(batchStep.invocation_id)).toBe(1);
    }

    const replayAttemptId = id();
    await expect(
      recovery.acquireInvocationWindow({
        tenantId: "tenant-gw16",
        rsid: registered.payload.rsid,
        attemptId: replayAttemptId,
      }),
    ).resolves.toMatchObject({ kind: "acquired" });
    await expect(
      recovery.prepareMutationDispatch({
        tenantId: "tenant-gw16",
        attemptId: replayAttemptId,
        sessionBindingId: draft.sessionBindingId,
        connectionId: draft.connectionId,
        envelope,
        expected: draft.expected,
      }),
    ).resolves.toMatchObject({
      kind: "replay_terminal",
      history: { batchTerminal: { result: { batch_id: batch.batchId } } },
    });
    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(1);
    await expect(
      recovery.releaseInvocationWindow({
        tenantId: "tenant-gw16",
        rsid: registered.payload.rsid,
        attemptId: replayAttemptId,
      }),
    ).resolves.toMatchObject({ kind: "released" });

    bridge.simulator.close();
    bridge.journal.close();
    await authority.close();
  });
});
