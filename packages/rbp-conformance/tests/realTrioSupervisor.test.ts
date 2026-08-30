import { describe, expect, it } from "vitest";

import { preControlWatcherSeedFromSnapshot } from "../src/realTrioDocumentContextEvidence.js";

import {
  assertProductionCredential,
  assertDedicatedRealTrioProcessComponents,
  bridgeEndpointForBinding,
  classifyRealTrioAuditControlFailure,
  fixtureAttestationTokens,
  fixtureAttestedWorkerCommand,
  hasOrderedDocumentContextStages,
  issueDeviceCredentialControlPayload,
  persistedBindingForReadiness,
  pollRbpSessionV3Readiness,
  realTrioFailureDiagnostics,
  RealTrioSessionReadinessPollError,
  RealTrioDocumentContextCursorJournal,
  MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS,
  readRbpSessionV3Readiness,
  realTrioCredentialRequest,
  redactBridgeTranscript,
  REAL_TRIO_TEST_HEARTBEAT_INTERVAL_MS,
  PublicGatewayControlError,
  testHeartbeatWorkerCommand,
} from "../src/realTrioSupervisor.js";

const worker = (binding: "wss" | "streamable_http_sse"): readonly string[] => ["--binding", binding];

describe("WP-12 bounded real-case-audit control outcomes", () => {
  it("classifies timeout, 503, and process exit without retaining raw error values", () => {
    expect(classifyRealTrioAuditControlFailure(new PublicGatewayControlError("timeout"), false)).toEqual({
      outcome: "failure", error: "timeout", statusCode: null, okKeyPresent: false, actionKeyPresent: false,
    });
    expect(classifyRealTrioAuditControlFailure(new PublicGatewayControlError("http_status_5xx", 503, true, true), false)).toEqual({
      outcome: "failure", error: "http_status_5xx", statusCode: 503, okKeyPresent: true, actionKeyPresent: true,
    });
    const exited = classifyRealTrioAuditControlFailure(new Error("secret-path-must-not-persist"), true);
    expect(exited).toMatchObject({ outcome: "failure", error: "process_exited" });
    expect(JSON.stringify(exited)).not.toContain("secret-path-must-not-persist");
  });
});

function cursorObservation(stage: string, outcome: string, sequence: number | null, sourceOffset: number, hash = `sha256:${"a".repeat(64)}`) {
  const payloadBearing = (stage === "snapshot" && outcome === "ready") ||
    (stage === "queue" && outcome === "durably_queued") ||
    (stage === "send" && outcome === "sent");
  return {
    stream: "stderr" as const,
    at: "2026-08-24T00:00:00.000Z",
    sourceOffset,
    line: JSON.stringify({
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation",
      stage,
      outcome,
      rsidHash: hash,
      payloadHash: `sha256:${"b".repeat(64)}`,
      sequence,
      ...(payloadBearing ? {
        contextDigest: "d".repeat(64),
        sourceRevision: 1,
        cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
      } : {}),
    }),
  };
}

describe("WP-12 C38 monotonic document-context cursor journal", () => {
  it("rolls over more than sixteen observations without borrowing expired history", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const records = Array.from({ length: MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS + 4 }, (_, index) =>
      cursorObservation("ack", "durably_acknowledged", index + 1, index));
    const snapshot = journal.snapshot(records);
    expect(snapshot.rows).toHaveLength(MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS);
    expect(snapshot.highWaterCursor).toBe(String(MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS + 4));
    expect(journal.since("0", snapshot.generation, records).state).toBe("cursor_expired");
    const since = journal.since(String(4), snapshot.generation, records);
    expect(since).toMatchObject({ state: "ok", highWaterCursor: String(MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS + 4) });
    expect(since.state === "ok" && since.rows[0]?.cursor).toBe("5");
  });

  it("deduplicates a re-read source line but gives identical real events distinct cursors", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const one = cursorObservation("ack", "durably_acknowledged", 1, 11);
    const two = cursorObservation("ack", "durably_acknowledged", 1, 12);
    const first = journal.snapshot([one, one, two]);
    expect(first.rows.map((row) => row.cursor)).toEqual(["1", "2"]);
    const reread = journal.snapshot([one, two]);
    expect(reread.highWaterCursor).toBe("2");
  });

  it("fails closed for expiry, malformed cursor, and generation changes", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const rows = Array.from({ length: MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS + 1 }, (_, index) =>
      cursorObservation("ack", "durably_acknowledged", index + 1, index));
    const snapshot = journal.snapshot(rows);
    expect(journal.since("00", snapshot.generation, rows).state).toBe("gap");
    expect(journal.since("0", snapshot.generation, rows).state).toBe("cursor_expired");
    journal.restartGeneration();
    expect(journal.since(snapshot.highWaterCursor, snapshot.generation, []).state).toBe("generation_changed");
  });

  it("never admits malformed, partial, or oversize source lines and keeps snapshot memory bounded", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const valid = cursorObservation("ack", "durably_acknowledged", 1, 1);
    const malformed = { stream: "stderr" as const, at: "", sourceOffset: 2, line: "{partial" };
    const oversize = { stream: "stderr" as const, at: "", sourceOffset: 3, line: "x".repeat(70 * 1024) };
    const snapshot = journal.snapshot([valid, malformed, oversize]);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]!.line.length).toBeLessThanOrEqual(2 * 1024);
  });

  it("returns an atomic snapshot and exact later rows when an append races a read", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const first = cursorObservation("probe", "started", 1, 1);
    const before = journal.snapshot([first]);
    const second = cursorObservation("snapshot", "ready", null, 2);
    const since = journal.since(before.highWaterCursor, before.generation, [first, second]);
    const after = journal.snapshot([first, second]);
    expect(since).toMatchObject({ state: "ok", generation: before.generation });
    expect(since.state === "ok" && since.rows.map((row) => row.cursor)).toEqual(["2"]);
    expect(after.highWaterCursor).toBe("2");
  });

  it("earns a compact settled watcher seed before a 128-row eviction and binds it to exact high water", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const records = Array.from({ length: 33 }, (_, cycle) => {
      const offset = cycle * 5;
      return [
        cursorObservation("probe", "started", null, offset + 1),
        cursorObservation("snapshot", "ready", null, offset + 2),
        cursorObservation("queue", "durably_queued", cycle + 1, offset + 3),
        cursorObservation("send", "sent", cycle + 1, offset + 4),
        cursorObservation("ack", "durably_acknowledged", cycle + 1, offset + 5),
      ];
    }).flat();
    const snapshot = journal.snapshot(records);
    expect(snapshot.rows).toHaveLength(MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS);
    expect(snapshot.lowWaterCursor).toBe("38");
    expect(snapshot.settledWatcherSeed).toMatchObject({
      generation: snapshot.generation, highWaterCursor: snapshot.highWaterCursor,
      watcherOrdinal: 33, lastSentSequence: 33, lastAckSequence: 33,
    });
    expect(snapshot).toMatchObject({ seedStatus: "valid", seedReason: null });
  });

  it("consumes the exact reducer checkpoint after retained-prefix eviction and rejects drift", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const records = Array.from({ length: 33 }, (_, cycle) => {
      const offset = cycle * 5;
      return [
        cursorObservation("probe", "started", null, offset + 1),
        cursorObservation("snapshot", "ready", null, offset + 2),
        cursorObservation("queue", "durably_queued", cycle + 1, offset + 3),
        cursorObservation("send", "sent", cycle + 1, offset + 4),
        cursorObservation("ack", "durably_acknowledged", cycle + 1, offset + 5),
      ];
    }).flat();
    const snapshot = journal.snapshot(records);
    expect(snapshot.lowWaterCursor).not.toBe("1");
    expect(preControlWatcherSeedFromSnapshot(snapshot)).toEqual(snapshot.settledWatcherSeed);
    expect(preControlWatcherSeedFromSnapshot({
      ...snapshot, seedStatus: "pending", seedReason: "unacked",
    })).toBeNull();
    expect(preControlWatcherSeedFromSnapshot({
      ...snapshot,
      settledWatcherSeed: snapshot.settledWatcherSeed === null || snapshot.settledWatcherSeed === undefined
        ? null
        : { ...snapshot.settledWatcherSeed, highWaterCursor: String(BigInt(snapshot.highWaterCursor) - 1n) },
    })).toBeNull();
    expect(preControlWatcherSeedFromSnapshot({
      ...snapshot, rows: Object.freeze([
        { ...snapshot.rows[0]!, line: "{}" }, ...snapshot.rows.slice(1),
      ]),
    })).toBeNull();
  });

  it("withholds the compact seed for open/unacknowledged or malformed document history and clears it on restart", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const open = [
      cursorObservation("probe", "started", null, 1),
      cursorObservation("snapshot", "ready", null, 2),
      cursorObservation("queue", "durably_queued", 1, 3),
      cursorObservation("send", "sent", 1, 4),
    ];
    expect(journal.snapshot(open).settledWatcherSeed).toBeNull();
    const malformed = { stream: "stderr" as const, at: "", sourceOffset: 5,
      line: JSON.stringify({ event: "bridge.document_context_observation", stage: "future", outcome: "unknown" }) };
    expect(journal.snapshot([...open, malformed]).settledWatcherSeed).toBeNull();
    journal.restartGeneration();
    const restarted = journal.snapshot([]);
    expect(restarted.settledWatcherSeed).toBeNull();
    expect(restarted.highWaterCursor).toBe("0");
  });

  it("seeds a fresh watcher after monotonic replay ACKs and value-free cache-not-ready polls", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    const records = [
      cursorObservation("probe", "started", null, 1),
      cursorObservation("ack", "durably_acknowledged", 1, 2),
      cursorObservation("ack", "durably_acknowledged", 2, 3),
      cursorObservation("snapshot", "not_ready", null, 4),
      cursorObservation("probe", "started", null, 5),
      cursorObservation("snapshot", "not_ready", null, 6),
    ];
    const snapshot = journal.snapshot(records);
    expect(snapshot).toMatchObject({
      generation: 1, lowWaterCursor: "1", highWaterCursor: "6",
      seedStatus: "valid", seedReason: null,
      settledWatcherSeed: {
        generation: 1, highWaterCursor: "6", watcherOrdinal: 2,
        lastSentSequence: null, lastAckSequence: null,
      },
    });
  });

  it("reports only fixed compact-seed reason codes without changing seed admission", () => {
    const journal = new RealTrioDocumentContextCursorJournal();
    expect(journal.snapshot([])).toMatchObject({ seedStatus: "pending", seedReason: "no_probe" });
    const open = [cursorObservation("probe", "started", null, 1), cursorObservation("snapshot", "ready", null, 2)];
    expect(journal.snapshot(open)).toMatchObject({ seedStatus: "pending", seedReason: "open_cycle", settledWatcherSeed: null });
    const sent = [...open, cursorObservation("queue", "durably_queued", 1, 3), cursorObservation("send", "sent", 1, 4)];
    expect(journal.snapshot(sent)).toMatchObject({ seedStatus: "pending", seedReason: "unacked" });
    const malformed = { stream: "stderr" as const, at: "", sourceOffset: 5,
      line: JSON.stringify({ event: "bridge.document_context_observation", stage: "unknown", outcome: "unknown", rsidHash: `sha256:${"a".repeat(64)}`, sequence: null }) };
    expect(journal.snapshot([...sent, malformed])).toMatchObject({ seedStatus: "invalid", seedReason: "unknown_stage" });
    journal.restartGeneration();
    expect(journal.snapshot([])).toMatchObject({ seedStatus: "pending", seedReason: "restart_reset" });
  });
});

describe("WP-12 real trio bridge endpoint derivation", () => {
  it.each([
    ["wss", "https://127.0.0.1:48291", "wss://localhost:48291/bridge/v1"],
    ["streamable_http_sse", "https://127.0.0.1:48291/", "https://localhost:48291/bridge/v1"],
    ["wss", "https://127.0.0.1:48291/bridge/v1", "wss://localhost:48291/bridge/v1"],
  ] as const)("pins %s from the Gateway READY origin", (binding, readyEndpoint, expected) => {
    expect(bridgeEndpointForBinding(readyEndpoint, worker(binding))).toBe(expected);
  });

  it.each([
    ["http://127.0.0.1:48291", worker("wss"), /not HTTPS/u],
    ["https://localhost:48291", worker("wss"), /numeric loopback/u],
    ["https://192.168.90.154:48291", worker("wss"), /numeric loopback/u],
    ["https://127.0.0.1", worker("wss"), /explicit port/u],
    ["https://user:proof@127.0.0.1:48291", worker("wss"), /userinfo/u],
    ["https://127.0.0.1:48291/other", worker("wss"), /unexpected path/u],
    ["https://127.0.0.1:48291/bridge/v1/", worker("wss"), /unexpected path/u],
    ["https://127.0.0.1:48291?next=/bridge/v1", worker("wss"), /query or fragment/u],
    ["https://127.0.0.1:48291/#fragment", worker("wss"), /query or fragment/u],
    ["not a URL", worker("wss"), /malformed/u],
    ["https://127.0.0.1:48291", ["--binding", "http"] as const, /lacks one supported binding/u],
  ] as const)("rejects unsafe or malformed READY endpoint %#", (readyEndpoint, workerArgs, expected) => {
    expect(() => bridgeEndpointForBinding(readyEndpoint, workerArgs)).toThrow(expected);
  });
});

describe("WP-12 dedicated real-trio process identity preflight", () => {
  const launch = {
    gateway: { executable: "gateway.exe", args: [], workingDirectory: "." },
    bridgeWorker: { executable: "bridge.exe", args: [], workingDirectory: "." },
    fixture: { executable: "fixture.exe", args: [], workingDirectory: "." },
    gatewayExpected: { component: "gateway_production_conformance" },
    bridgeExpected: { component: "bridge_worker" },
    fixtureExpected: { component: "addin_loopback_fixture" },
    csharpPublishPath: "bridge.exe",
    gatewayBuildPath: "gateway.js",
    fixtureBuildPath: "fixture.js",
    gatewayControlToken: "test-token",
  } as const;

  it("rejects old simulator labels before any real process can launch", () => {
    expect(() => assertDedicatedRealTrioProcessComponents(launch)).not.toThrow();
    expect(() => assertDedicatedRealTrioProcessComponents({
      ...launch,
      gatewayExpected: { component: "gateway_stub" },
    })).toThrow(/must declare/u);
  });
});

describe("WP-12 real-trio public credential provisioning", () => {
  it.each([
    ["wss", "wss"],
    ["streamable_http_sse", "http_sse"],
  ] as const)("maps external %s to persisted readiness %s only", (binding, expected) => {
    expect(persistedBindingForReadiness(binding)).toBe(expected);
  });

  it.each([
    ["wss", ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1"]],
    ["streamable_http_sse", ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1", "transport_streamable_http"]],
  ] as const)("uses one exact credential schema for %s with non-empty session grants", (binding, connectionCapabilities) => {
    expect(realTrioCredentialRequest(binding)).toEqual({
      binding,
      connectionCapabilities,
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
  });

  it("serializes issue_device_credential with only exact connection and session fields", () => {
    expect(issueDeviceCredentialControlPayload(
      realTrioCredentialRequest("streamable_http_sse"),
    )).toEqual({
      action: "issue_device_credential",
      binding: "streamable_http_sse",
      connectionCapabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "route_rebind_proof_v1",
        "transport_streamable_http",
      ],
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
  });

  it("rejects a stub-labelled credential before its identity or endpoint can reach the C# worker", () => {
    const request = realTrioCredentialRequest("wss");
    const credential = {
      deviceId: "device",
      deviceProof: "proof",
      binding: "wss",
      gatewayEndpoint: "https://127.0.0.1:48291",
      credentialProvenance: "gateway_stub",
      adapterProvenance: { identity: "conformance", protocolStore: "conformance", authority: "GatewayBridgeSessionAuthority" },
      connectionCapabilities: [...request.connectionCapabilities],
      sessionCapabilities: [...request.sessionCapabilities],
    };
    expect(() => assertProductionCredential(credential, request, "https://127.0.0.1:48291"))
      .toThrow(/production-conformance credential/u);
  });
});

describe("WP-12 fixture attestation supervisor configuration", () => {
  it.each([
    ["wss", "https://127.0.0.1:48291", { fixture_port: "48292", fixture_pid: "4455" }],
    ["streamable_http_sse", "https://127.0.0.1:48291", { fixture_port: "48292", fixture_pid: "4455" }],
  ] as const)("passes the exact READY fixture pid and IPv4 port for %s", (binding, gatewayEndpoint, expected) => {
    expect(bridgeEndpointForBinding(gatewayEndpoint, worker(binding))).toContain("localhost:48291");
    const tokens = fixtureAttestationTokens({ host: "127.0.0.1", port: 48292 }, 4455);
    expect(tokens).toEqual(expected);
    expect(fixtureAttestedWorkerCommand({
      executable: "worker.exe",
      args: ["--binding", binding, "--addin-port", "{{fixture_port}}", "--fixture-pid", "{{fixture_pid}}"],
      workingDirectory: ".",
    }, tokens).args).toContain("4455");
  });

  it.each([
    [{ host: "localhost", port: 48292 }, 4455, /IPv4 loopback/u],
    [{ host: "::1", port: 48292 }, 4455, /IPv4 loopback/u],
    [{ host: "127.0.0.1", port: 0 }, 4455, /exact loopback port/u],
    [{ host: "127.0.0.1", port: 48292 }, 0, /exact pid/u],
  ] as const)("rejects an unsafe or incomplete fixture identity", (readiness, pid, expected) => {
    expect(() => fixtureAttestationTokens(readiness, pid)).toThrow(expected);
  });

  it("refuses an unbound or substituted fixture command before any bridge route can open", () => {
    const tokens = fixtureAttestationTokens({ host: "127.0.0.1", port: 48292 }, 4455);
    expect(() => fixtureAttestedWorkerCommand({
      executable: "worker.exe",
      args: ["--binding", "wss", "--addin-port", "48292"],
      workingDirectory: ".",
    }, tokens)).toThrow(/does not bind exact/u);
    expect(() => fixtureAttestedWorkerCommand({
      executable: "worker.exe",
      args: ["--binding", "wss", "--addin-port", "{{fixture_port}}", "--fixture-pid", "0"],
      workingDirectory: ".",
    }, tokens)).toThrow(/does not bind exact/u);
  });

  it("supervisor injects the bounded 1000ms test-host heartbeat cadence", () => {
    const command = testHeartbeatWorkerCommand({
      executable: "worker.exe",
      args: ["--binding", "wss", "--test-heartbeat-interval-ms", "{{test_heartbeat_interval_ms}}"],
      workingDirectory: ".",
    });
    expect(REAL_TRIO_TEST_HEARTBEAT_INTERVAL_MS).toBe(1_000);
    expect(command.args).toContain("1000");
  });

  it.each([249, 5_001])("rejects an invalid test-host heartbeat interval", (interval) => {
    expect(() => testHeartbeatWorkerCommand({
      executable: "worker.exe",
      args: ["--binding", "wss", "--test-heartbeat-interval-ms", "{{test_heartbeat_interval_ms}}"],
      workingDirectory: ".",
    }, interval)).toThrow(/between 250 and 5000/u);
  });
});

describe("WP-12 real-trio v3 session smoke reader", () => {
  const WSS_CONNECTION_GRANTS = ["artifact_result_v1", "chunked_results", "journal_v1", "route_rebind_proof_v1"];
  const HTTP_CONNECTION_GRANTS = [...WSS_CONNECTION_GRANTS, "transport_streamable_http"];
  const v3Snapshot = {
    ok: true,
    action: "snapshot_audit",
    sessionAudit: {
      status: "candidate",
      candidateCount: 1,
      projection: {
        status: "candidate",
        candidateCount: 1,
        tenantId: "conformance",
        rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
        rootVersion: 7,
        rootDigest: `sha256:${"a".repeat(64)}`,
        treesDigest: `sha256:${"b".repeat(64)}`,
        retired: false,
        readiness: {
          binding: "wss",
          sessionBindingId: "018f7f7e-1234-7abc-8def-1234567890ac",
          sessionVersion: 1,
          connectionId: "018f7f7e-1234-7abc-8def-1234567890ad",
          localSessionKey: "port:8080:pid:42:started:99",
          phase: "registered",
          dispatchAllowed: true,
          liveDocumentRoute: null,
          sessionGrantedCapabilities: ["batch_atomic", "doc_context_cached_v1"],
          connectionGrantedCapabilities: WSS_CONNECTION_GRANTS,
        },
      },
    },
  };

  const snapshotForPersistedBinding = (binding: "wss" | "http_sse") => {
    const snapshot = structuredClone(v3Snapshot);
    snapshot.sessionAudit.projection.readiness.binding = binding;
    snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities =
      binding === "http_sse" ? [...HTTP_CONNECTION_GRANTS] : [...WSS_CONNECTION_GRANTS];
    return snapshot;
  };

  it("reads only the strict v3 root-marker readiness projection before STOP", () => {
    expect(readRbpSessionV3Readiness(v3Snapshot, "wss")).toMatchObject({
      rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
      localSessionKey: "port:8080:pid:42:started:99",
      grantedCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
    expect(readRbpSessionV3Readiness(v3Snapshot, "wss").connectionGrantOrderHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("accepts the canonical HTTP projection without raw lifecycle timestamps", () => {
    const snapshot = snapshotForPersistedBinding("http_sse");
    expect(readRbpSessionV3Readiness(snapshot, "http_sse")).toMatchObject({
      rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
      localSessionKey: "port:8080:pid:42:started:99",
      grantedCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
  });

  it.each(["wss", "http_sse"] as const)("requires canonical persisted split grants for %s", (binding) => {
    const readiness = readRbpSessionV3Readiness(snapshotForPersistedBinding(binding), binding);
    expect(readiness.grantedCapabilities).toEqual(["batch_atomic", "doc_context_cached_v1"]);
    expect(readiness.connectionGrantOrderHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("returns a full redacted connection-grant admission fence for each persisted binding", () => {
    const wss = readRbpSessionV3Readiness(snapshotForPersistedBinding("wss"), "wss");
    const http = readRbpSessionV3Readiness(snapshotForPersistedBinding("http_sse"), "http_sse");
    expect(wss.connectionGrantOrderHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(http.connectionGrantOrderHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(wss.connectionGrantOrderHash).not.toBe(http.connectionGrantOrderHash);
    expect(JSON.stringify(wss)).not.toContain("route_rebind_proof_v1");
  });

  it("rejects a route proof capability placed only in session grants", () => {
    const snapshot = snapshotForPersistedBinding("wss");
    snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities.push("route_rebind_proof_v1");
    snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities = [...WSS_CONNECTION_GRANTS];
    expect(() => readRbpSessionV3Readiness(snapshot, "wss")).toThrow(/session grants/u);
  });

  it("traces a route proof capability placed only in session grants as redacted missing-route readiness", async () => {
    let time = 0;
    const snapshot = snapshotForPersistedBinding("wss");
    snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities.push("route_rebind_proof_v1");
    snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities = [];
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => snapshot,
      timeoutMs: 200,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.readinessTrace.length === 3 &&
      error.readinessTrace.every((trace) => trace.outcome === "MISSING_ROUTE_REBIND") &&
      !JSON.stringify(error.readinessTrace).includes("route_rebind_proof_v1"));
  });

  it("traces an absent session batch grant distinctly from a connection route grant", async () => {
    let time = 0;
    const snapshot = snapshotForPersistedBinding("wss");
    snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities = ["doc_context_cached_v1"];
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => snapshot,
      timeoutMs: 200,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.readinessTrace.length === 3 &&
      error.readinessTrace.every((trace) => trace.outcome === "MISSING_BATCH") &&
      !JSON.stringify(error.readinessTrace).includes("doc_context_cached_v1"));
  });

  it.each([
    null,
    "route_rebind_proof_v1",
    ["route_rebind_proof_v1", 7],
  ])("rejects malformed projected connection grants %#", (connectionGrants) => {
    const snapshot = snapshotForPersistedBinding("wss");
    (snapshot.sessionAudit.projection.readiness as { connectionGrantedCapabilities: unknown })
      .connectionGrantedCapabilities = connectionGrants;
    expect(() => readRbpSessionV3Readiness(snapshot, "wss")).toThrow(/v3 readiness fields/u);
  });

  it.each([
    ["wss duplicate connection grant", "wss", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities.push("route_rebind_proof_v1")],
    ["http reordered connection grant", "http_sse", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities.reverse()],
    ["wss missing connection grant", "wss", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => { snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities = [...WSS_CONNECTION_GRANTS.slice(1)]; }],
    ["http extra session grant", "http_sse", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities.push("route_rebind_proof_v1")],
    ["wss batch in connection grants", "wss", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities.push("batch_atomic")],
    ["http route in session grants", "http_sse", (snapshot: ReturnType<typeof snapshotForPersistedBinding>) => snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities.push("route_rebind_proof_v1")],
  ] as const)("rejects noncanonical exact-domain grant lists: %s", (_label, binding, mutate) => {
    const snapshot = snapshotForPersistedBinding(binding);
    mutate(snapshot);
    expect(() => readRbpSessionV3Readiness(snapshot, binding)).toThrow(/grants/u);
  });

  it.each([
    [{ sessionAudit: { status: "no_candidate", candidateCount: 0, projection: null } }, /no candidate/u],
    [{ sessions: [{ namespace: "gateway.rbp-session/v2", value: {} }] }, /not v3/u],
    [{ sessionAudit: { status: "multiple", candidateCount: 2, projection: null } }, /multiple/u],
    [{ sessionAudit: { status: "not_current", candidateCount: 1, projection: null } }, /not current/u],
    [{ sessionAudit: { status: "candidate", candidateCount: 1, projection: {} } }, /projection is malformed/u],
  ] as const)("rejects absent, legacy, multiple, or malformed v3 readiness %#", (snapshot, expected) => {
    expect(() => readRbpSessionV3Readiness(snapshot, "wss")).toThrow(expected);
  });

  it("polls no-candidate then two identical active v3 observations", async () => {
    let time = 0;
    let reads = 0;
    const readiness = await pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => (++reads === 1
        ? { sessionAudit: { status: "no_candidate", candidateCount: 0, projection: null } }
        : v3Snapshot),
      timeoutMs: 1_000,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });
    expect(reads).toBe(3);
    expect(readiness.localSessionKey).toContain("port:8080");
  });

  it.each([
    ["unstable", () => {
      let flip = false;
      return async () => {
        flip = !flip;
        const snapshot = structuredClone(v3Snapshot);
        snapshot.sessionAudit.projection.readiness.localSessionKey = flip ? "a" : "b";
        return snapshot;
      };
    }],
    ["multiple", () => async () => ({ sessionAudit: {
      status: "multiple", candidateCount: 2, projection: null,
    } })],
    ["legacy", () => async () => ({ sessions: [{ namespace: "gateway.rbp-session/v1", value: {} }] })],
  ] as const)("retains audits and times out on %s rows", async (_label, createReader) => {
    let time = 0;
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: createReader(),
      timeoutMs: 200,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.audits.length === 3 &&
      error.lastGatewayAudit !== null &&
      error.bridgeReceiveTranscript.length === 0);
  });

  it("aborts polling when the real worker exits", async () => {
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => true,
      readSnapshot: async () => v3Snapshot,
      timeoutMs: 200,
      intervalMs: 100,
    })).rejects.toMatchObject({ message: expect.stringMatching(/bridge exited/u), audits: [] });
  });

  it("does not admit two reads when the persisted connection-grant order drifts", async () => {
    let time = 0;
    let reads = 0;
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => {
        reads += 1;
        const snapshot = snapshotForPersistedBinding("wss");
        if (reads === 2) {
          snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities.reverse();
        }
        return snapshot;
      },
      timeoutMs: 200,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.readinessTrace.length === 3 &&
      error.readinessTrace[0]?.outcome === "VALID" &&
      error.readinessTrace[1]?.outcome === "INVALID_CONNECTION_GRANTS" &&
      error.readinessTrace[2]?.outcome === "VALID" &&
      !JSON.stringify(error.readinessTrace).includes("route_rebind_proof_v1"));
  });

  it("traces an invalid poll then records the reset without exposing values", async () => {
    let time = 0;
    let reads = 0;
    await expect(pollRbpSessionV3Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => {
        reads += 1;
        if (reads === 1) {
          return { sessionAudit: { status: "no_candidate", candidateCount: 0, projection: null } };
        }
        const snapshot = structuredClone(v3Snapshot);
        if (reads % 2 === 1) {
          snapshot.sessionAudit.projection.readiness.sessionGrantedCapabilities.reverse();
          snapshot.sessionAudit.projection.readiness.connectionGrantedCapabilities.reverse();
        }
        return snapshot;
      },
      timeoutMs: 300,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.readinessTrace[0]?.outcome === "NO_ROW" &&
      error.readinessTrace.slice(1).some((trace) => trace.outcome === "VALID") &&
      !JSON.stringify(error.readinessTrace).includes("port:8080"));
  });

  it("retains only bounded value-free worker observations and reduced Gateway audit on failure", () => {
    const gatewayAudit = structuredClone(v3Snapshot);
    gatewayAudit.sessionAudit.projection.readiness.localSessionKey = "must-not-leak";
    (gatewayAudit.sessionAudit.projection.readiness as Record<string, unknown>).deviceToken =
      "must-not-leak";
    const error = new RealTrioSessionReadinessPollError(
      "readiness failed",
      [],
      gatewayAudit,
      [
        {
          stream: "stderr",
          at: "2026-08-23T00:00:00.000Z",
          line: JSON.stringify({
            contractVersion: "revagent.wp12-real-worker-observation/v1",
            event: "bridge.connection_failure_observation",
            timestamp: "2026-08-23T00:00:00.000Z",
            binding: "streamable_http_sse",
            state: "retry_paused",
            reason: "authorization_refusal",
            token: "must-not-leak",
          }),
        },
        { stream: "stderr", at: "2026-08-23T00:00:01.000Z", line: "C:\\private\\path secret" },
      ],
    );
    const diagnostics = realTrioFailureDiagnostics(new Error("wrapped", { cause: error }));
    expect(diagnostics).toMatchObject({
      schemaVersion: "rbp-real-trio-failure-diagnostics/v1",
      gatewayAudits: [{
        sessionCount: 1,
        namespaces: ["gateway.rbp-session/v3"],
        sessions: [{
          binding: "wss",
          lifecyclePhase: "registered",
          dispatchAllowed: true,
          localKeyPresent: true,
          rootDigestPresent: true,
          treesDigestPresent: true,
          retired: false,
        }],
      }],
      bridgeTranscript: [{ stream: "stderr", at: "" }],
    });
    expect(JSON.parse(diagnostics!.bridgeTranscript[0]!.line)).toEqual({
      contractVersion: "revagent.wp12-real-worker-observation/v1",
      event: "bridge.connection_failure_observation",
      stage: "failure",
      outcome: "authorization_refusal",
      binding: "streamable_http_sse",
      failureKind: "authorization_refusal",
      rsidHashPresent: false,
      payloadHashPresent: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
    expect(JSON.stringify(diagnostics)).not.toContain("private\\path");
  });

  it("admits only fixed document-context schema fields and drops unknown stderr", () => {
    const retained = redactBridgeTranscript([
      {
        stream: "stderr",
        at: "now",
        line: JSON.stringify({
          contractVersion: "revagent.rbp-document-context-observation/v1",
          event: "bridge.document_context_observation",
          stage: "queue",
          outcome: "durably_queued",
          rsidHash: `sha256:${"a".repeat(64)}`,
          payloadHash: `sha256:${"b".repeat(64)}`,
          sequence: 7,
          contextDigest: "c".repeat(64),
          sourceRevision: 3,
          cacheIncarnationDigest: `sha256:${"d".repeat(64)}`,
          path: "C:\\private",
          token: "never-retain",
        }),
      },
      { stream: "stderr", at: "now", line: JSON.stringify({ event: "unknown", token: "drop" }) },
    ]);
    expect(retained).toHaveLength(1);
    expect(JSON.parse(retained[0]!.line)).toEqual({
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation",
      stage: "queue",
      outcome: "durably_queued",
      binding: "unknown",
      failureKind: "none",
      rsidHash: `sha256:${"a".repeat(64)}`,
      sequence: 7,
      payloadHashPresent: true,
      contextDigest: "c".repeat(64),
      sourceRevision: 3,
      cacheIncarnationDigest: `sha256:${"d".repeat(64)}`,
    });
    expect(redactBridgeTranscript([{ stream: "stderr", at: "now", line: JSON.stringify({
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation", stage: "send", outcome: "sent",
      rsidHash: `sha256:${"A".repeat(64)}`, sequence: 7,
    }) }])).toEqual([]);
    expect(redactBridgeTranscript([{ stream: "stderr", at: "now", line: JSON.stringify({
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation", stage: "send", outcome: "sent",
      rsidHash: `sha256:${"a".repeat(64)}`, sequence: 0,
    }) }])).toEqual([]);
  });

  it("retains C# source revision only with its exact valid cache incarnation", () => {
    const base = {
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation", stage: "send", outcome: "sent",
      rsidHash: `sha256:${"a".repeat(64)}`, payloadHash: `sha256:${"b".repeat(64)}`,
      sequence: 7, contextDigest: "d".repeat(64),
    };
    const valid = redactBridgeTranscript([{ stream: "stderr", at: "now", line: JSON.stringify({
      ...base, sourceRevision: 9, cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
    }) }]);
    expect(JSON.parse(valid[0]!.line)).toMatchObject({ sourceRevision: 9,
      cacheIncarnationDigest: `sha256:${"c".repeat(64)}` });
    for (const value of [
      { ...base, sourceRevision: 9 },
      { ...base, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` },
      { ...base, sourceRevision: 0, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` },
      { ...base, sourceRevision: Number.MAX_SAFE_INTEGER + 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` },
      { ...base, sourceRevision: 9, cacheIncarnationDigest: `sha256:${"C".repeat(64)}` },
    ]) expect(redactBridgeTranscript([{ stream: "stderr", at: "now", line: JSON.stringify(value) }])).toEqual([]);
  });

  it("requires document context progression through durable acknowledgement", () => {
    const event = (stage: string) => ({
      stream: "stderr" as const,
      at: "",
      line: JSON.stringify({ event: "bridge.document_context_observation", stage }),
    });
    expect(hasOrderedDocumentContextStages([
      event("probe"), event("snapshot"), event("queue"), event("send"), event("ack"),
    ])).toBe(true);
    expect(hasOrderedDocumentContextStages([
      event("probe"), event("queue"), event("snapshot"), event("send"), event("ack"),
    ])).toBe(false);
  });
});
