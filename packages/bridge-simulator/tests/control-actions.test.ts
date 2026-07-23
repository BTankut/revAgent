import { Buffer } from "node:buffer";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  makeParamsDigest,
  type InvocationJournalBinding,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { BridgeDaemonRuntime } from "../src/control.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { readInvoke, simulatorForFixture, temporaryRoot, uuid } from "./helpers.js";
import { createTestTlsIdentity } from "./tlsFixture.js";

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("Bridge daemon journal controls", () => {
  it("opens numeric-loopback WSS through the exact JSONL TLS trust contract and retains evidence", async () => {
    const root = temporaryRoot();
    const identity = createTestTlsIdentity("127.0.0.1");
    const caCertificatePath = join(root.path, "gateway-current-stack.pem");
    writeFileSync(caCertificatePath, identity.certificate, { encoding: "utf8", flag: "wx" });
    const tlsTrust = {
      caCertificatePath,
      caCertificateSha256: sha256(identity.certificate),
      serverCertificateSha256: sha256(new X509Certificate(identity.certificate).raw),
    };
    const server = createHttpsServer({
      cert: identity.certificate,
      key: identity.privateKey,
    });
    const websocketServer = new WebSocketServer({ server });
    websocketServer.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({
          type: "hello_ack",
          id: uuid(),
          ts: "2026-07-22T00:00:00.000Z",
          payload: {
            protocol: 1,
            connection_id: "control-loopback-tls",
            granted_capabilities: ["journal_v1", "chunked_results", "artifact_result_v1"],
            heartbeat_interval_ms: 15_000,
            limits: {
              max_params_bytes: 4_194_304,
              max_result_bytes: 33_554_432,
              max_partial_bytes: 1_048_576,
            },
            manifest: { latest_bridge_version: "bridge-test", manifest_url: "/bridge/update/manifest" },
          },
        }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const runtime = new BridgeDaemonRuntime(root.path);
    const request = {
      controlVersion: 1,
      id: "tls-control",
      action: "open_transport",
      kind: "wss",
      deviceToken: "fixture-device-token",
      wssUrl: `wss://127.0.0.1:${port}/bridge/v1`,
      endpointPolicy: "loopback_test_tls",
      tlsTrust,
      hello: {
        id: uuid(),
        ts: "2026-07-22T00:00:00.000Z",
        bridgeVersion: "0.0.0",
        deviceId: "fixture-device",
        hostname: "fixture-host",
        os: "fixture-os",
      },
    };
    try {
      await expect(runtime.execute({
        ...request,
        id: "invalid-tls-control",
        endpointPolicy: "loopback_test_readiness",
      }, "invalid-tls-control")).rejects.toThrow(
        /tlsTrust is accepted only by kind=wss with endpointPolicy=loopback_test_tls/u,
      );
      await expect(runtime.execute({
        ...request,
        id: "invalid-tls-schema",
        tlsTrust: { ...tlsTrust, allowUntrusted: true },
      }, "invalid-tls-schema")).rejects.toThrow(/Unknown control field: allowUntrusted/u);
      await expect(runtime.execute(request, "tls-control")).resolves.toMatchObject({
        value: {
          selectedKind: "wss",
          connectionId: "control-loopback-tls",
          testTlsTrust: tlsTrust,
        },
      });
      expect(runtime.snapshotEvidence().transport).toMatchObject({
        kind: "wss",
        open: true,
        testTlsTrust: tlsTrust,
      });
    } finally {
      await runtime.shutdown();
      websocketServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
        server.closeAllConnections();
      });
      root.cleanup();
    }
  }, 15_000);

  it("closes a selected binding when cold-start peer recovery fails and permits a clean retry", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_control_preplan_artifact", "read_only", () => ({
      files: [{
        fileName: "cold-start.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("cold-start-carrier", "utf8").toString("base64"),
      }],
    }));
    const rsid = uuid();
    const seeded = await simulatorForFixture({
      fixture,
      root: root.path,
      rsid,
      journalPath: join(root.path, "bridge.db"),
      spoolName: "spool",
    });
    const invocation = readInvoke({ rsid, seq: 1, method: "fixture_control_preplan_artifact" });
    await expect(seeded.simulator.invoke(invocation)).resolves.toMatchObject({
      kind: "result",
      artifactCarrier: { invocationId: invocation.payload.invocation_id },
    });
    seeded.simulator.close();
    seeded.journal.close();
    await fixture.stop();

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    let connectionCount = 0;
    const closedConnections: number[] = [];
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.once("message", () => {
        socket.send(JSON.stringify({
          type: "hello_ack",
          id: uuid(),
          ts: "2026-07-22T00:00:00.000Z",
          payload: {
            protocol: 1,
            connection_id: `cold-start-${connectionIndex}`,
            granted_capabilities: connectionIndex === 1
              ? ["journal_v1"]
              : ["journal_v1", "chunked_results", "artifact_result_v1"],
            heartbeat_interval_ms: 15_000,
            limits: {
              max_params_bytes: 4_194_304,
              max_result_bytes: 33_554_432,
              max_partial_bytes: 1_048_576,
            },
            manifest: { latest_bridge_version: "bridge-test", manifest_url: "/bridge/update/manifest" },
          },
        }));
      });
      socket.once("close", () => closedConnections.push(connectionIndex));
    });

    const runtime = new BridgeDaemonRuntime(root.path);
    const open = (id: string) => runtime.execute({
      controlVersion: 1,
      id,
      action: "open_transport",
      kind: "wss",
      deviceToken: "fixture-device-token",
      wssUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      endpointPolicy: "loopback_test_readiness",
      hello: {
        id: uuid(),
        ts: "2026-07-22T00:00:00.000Z",
        bridgeVersion: "0.0.0",
        deviceId: "fixture-device",
        hostname: "fixture-host",
        os: "fixture-os",
      },
    }, id);

    try {
      await expect(open("first")).rejects.toThrow(/chunked_results/u);
      await expect.poll(() => closedConnections).toContain(1);
      expect(runtime.snapshotEvidence().transport).toMatchObject({ open: false, kind: null });
      await expect(open("second")).resolves.toMatchObject({
        value: { selectedKind: "wss", connectionId: "cold-start-2" },
      });
      expect(connectionCount).toBe(2);
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      root.cleanup();
    }
  }, 15_000);

  it("records and resolves durable late evidence, then emits its exact clearance", async () => {
    const root = temporaryRoot();
    const rsid = uuid();
    const originInvocationId = uuid();
    const evidenceDigest = `sha256:${"b".repeat(64)}`;
    const binding: InvocationJournalBinding = {
      rsid,
      invocationId: originInvocationId,
      method: "set_element_parameter",
      mutating: true,
      mutationScope: { kind: "document", document_id: "doc-late-control" },
      paramsDigest: makeParamsDigest({ element_id: 42 }),
      policy: {
        class: "confirm",
        decision: "confirmed",
        confirmation_id: "late-control-confirmation",
      },
      verification: null,
      recoveryClearances: [],
    };
    const journal = new DurableBridgeJournal(join(root.path, "bridge.db"));
    expect(journal.acceptInvocation(binding, `sha256:${"1".repeat(64)}`).kind).toBe("accepted");
    journal.markExecuting(rsid, originInvocationId, 1_721_600_000_000);
    const indeterminate = journal.markIndeterminate(rsid, originInvocationId, 1_721_600_000_001);
    const holdId = indeterminate.verificationHoldId as string;
    journal.recordTerminal(rsid, originInvocationId, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: evidenceDigest,
    }, 1_721_600_000_002);
    journal.close();

    const runtime = new BridgeDaemonRuntime(root.path);
    const recorded = await runtime.execute({
      controlVersion: 1,
      id: "late-evidence",
      action: "record_late_evidence",
      rsid,
      holdId,
      originInvocationId,
      evidenceDigest,
      conclusion: "postcondition_verified",
      atMs: 1_721_600_000_003,
    }, "late-evidence");
    expect(recorded.value).toMatchObject({
      recorded: true,
      hold: {
        holdId,
        state: "evidence_recorded",
        evidenceAttemptCount: 1,
        selectedEvidence: { basis: "late_terminal", evidenceDigest },
      },
    });

    const authorizedDispatchIdentity = `sha256:${"2".repeat(64)}`;
    const resolved = await runtime.execute({
      controlVersion: 1,
      id: "late-resolution",
      action: "resolve_hold",
      rsid,
      holdId,
      basis: "late_terminal",
      verificationInvocationId: null,
      evidenceDigest,
      decision: "postcondition_verified",
      resolutionId: uuid(),
      auditId: uuid(),
      authorizedDispatchIdentity,
      atMs: 1_721_600_000_004,
    }, "late-resolution");
    expect(resolved.value).toMatchObject({
      resolved: true,
      hold: {
        holdId,
        state: "resolved_pending_bridge",
        resolution: { basis: "late_terminal", verificationInvocationId: null },
      },
    });

    const clearance = await runtime.execute({
      controlVersion: 1,
      id: "late-clearance",
      action: "clearance_for_hold",
      rsid,
      holdId,
    }, "late-clearance");
    expect(clearance.value).toMatchObject({
      clearance: {
        hold_id: holdId,
        basis: "late_terminal",
        verification_invocation_id: null,
        evidence_digest: evidenceDigest,
        decision: "postcondition_verified",
      },
    });
    await runtime.shutdown();
    root.cleanup();
  });
});
