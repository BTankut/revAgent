import { describe, expect, it } from "vitest";

import {
  assertProductionCredential,
  assertDedicatedRealTrioComponentIds,
  bridgeEndpointForBinding,
  fixtureAttestationTokens,
  fixtureAttestedWorkerCommand,
  issueDeviceCredentialControlPayload,
  persistedBindingForReadiness,
  pollRbpSessionV2Readiness,
  realTrioFailureDiagnostics,
  RealTrioSessionReadinessPollError,
  readRbpSessionV2Readiness,
  realTrioCredentialRequest,
} from "../src/realTrioSupervisor.js";

const worker = (binding: "wss" | "streamable_http_sse"): readonly string[] => ["--binding", binding];

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
    expect(() => assertDedicatedRealTrioComponentIds(launch)).not.toThrow();
    expect(() => assertDedicatedRealTrioComponentIds({
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
    ["wss", ["journal_v1", "chunked_results", "artifact_result_v1"]],
    ["streamable_http_sse", ["journal_v1", "chunked_results", "artifact_result_v1", "transport_streamable_http"]],
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
});

describe("WP-12 real-trio v2 session smoke reader", () => {
  const v2Snapshot = {
    sessions: [{
      namespace: "gateway.rbp-session/v2",
      value: {
        schema: "gateway.rbp-session/v2",
        rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
        binding: { binding: "wss", grantedCapabilities: ["batch_atomic", "doc_context_cached_v1"] },
        lifecycle: { sessionLifecycle: {
          localSessionKey: "port:8080:pid:42:started:99",
          phase: "registered",
          dispatchAllowed: true,
          rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
        } },
      },
    }],
  };

  it("reads only the v2 nested binding grant and local session key before STOP", () => {
    expect(readRbpSessionV2Readiness(v2Snapshot, "wss")).toEqual({
      rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
      localSessionKey: "port:8080:pid:42:started:99",
      grantedCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
  });

  it("accepts the canonical nested HTTP lifecycle row without using timestamps as readiness", () => {
    const snapshot = structuredClone(v2Snapshot);
    const value = snapshot.sessions[0]!.value;
    value.binding.binding = "streamable_http_sse";
    value.lifecycle = { ...value.lifecycle, createdAtMs: 100, updatedAtMs: 200 };
    expect(readRbpSessionV2Readiness(snapshot, "streamable_http_sse")).toEqual({
      rsid: "018f7f7e-1234-7abc-8def-1234567890ab",
      localSessionKey: "port:8080:pid:42:started:99",
      grantedCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
  });

  it.each([
    [{ sessions: [] }, /lacks one normalized v2/u],
    [{ sessions: [{ namespace: "gateway.rbp-session/v1", value: { grantedCapabilities: ["batch_atomic"] } }] }, /legacy or malformed/u],
    [{ sessions: [{ namespace: "gateway.rbp-session/v2", value: { schema: "gateway.rbp-session/v2", rsid: "r", binding: { binding: "wss", grantedCapabilities: ["batch_atomic"] }, lifecycle: { sessionLifecycle: { localSessionKey: "k" } }, grantedCapabilities: ["batch_atomic"] } }] }, /v2 session row is malformed/u],
    [{ sessions: [{ namespace: "gateway.rbp-session/v2", value: { schema: "gateway.rbp-session/v2", rsid: "r", binding: { binding: "streamable_http_sse", grantedCapabilities: ["batch_atomic"] }, lifecycle: { createdAtMs: 1, updatedAtMs: 2 } } }] }, /v2 session row is malformed/u],
    [{ sessions: [{ namespace: "gateway.rbp-session/v2", value: { schema: "gateway.rbp-session/v2", rsid: "r", binding: { binding: "wss", grantedCapabilities: [] }, lifecycle: { sessionLifecycle: { localSessionKey: "k", phase: "registered", dispatchAllowed: true, rsid: "r" } } } }] }, /nested grants/u],
  ] as const)("rejects absent, legacy, or non-nested v2 session readiness %#", (snapshot, expected) => {
    expect(() => readRbpSessionV2Readiness(snapshot, "wss")).toThrow(expected);
  });

  it("polls no-row then two identical active v2 observations", async () => {
    let time = 0;
    let reads = 0;
    const readiness = await pollRbpSessionV2Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => (++reads === 1 ? { sessions: [] } : v2Snapshot),
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
        return { sessions: [{ ...v2Snapshot.sessions[0]!, value: {
          ...v2Snapshot.sessions[0]!.value,
          lifecycle: { sessionLifecycle: { ...v2Snapshot.sessions[0]!.value.lifecycle.sessionLifecycle, localSessionKey: flip ? "a" : "b" } },
        } }] };
      };
    }],
    ["multiple", () => async () => ({ sessions: [v2Snapshot.sessions[0]!, v2Snapshot.sessions[0]!] })],
    ["legacy", () => async () => ({ sessions: [{ namespace: "gateway.rbp-session/v1", value: {} }] })],
  ] as const)("retains audits and times out on %s rows", async (_label, createReader) => {
    let time = 0;
    await expect(pollRbpSessionV2Readiness({
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
    await expect(pollRbpSessionV2Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => true,
      readSnapshot: async () => v2Snapshot,
      timeoutMs: 200,
      intervalMs: 100,
    })).rejects.toMatchObject({ message: expect.stringMatching(/bridge exited/u), audits: [] });
  });

  it("traces alternating grant order as a stable-fingerprint reset without retaining grants", async () => {
    let time = 0;
    let reads = 0;
    await expect(pollRbpSessionV2Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => {
        reads += 1;
        const snapshot = structuredClone(v2Snapshot);
        if (reads % 2 === 0) snapshot.sessions[0]!.value.binding.grantedCapabilities.reverse();
        return snapshot;
      },
      timeoutMs: 200,
      intervalMs: 100,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RealTrioSessionReadinessPollError &&
      error.readinessTrace.length === 3 &&
      error.readinessTrace.every((trace) => trace.outcome === "VALID") &&
      error.readinessTrace.some((trace) => trace.resetReason === "fingerprint_changed") &&
      !JSON.stringify(error.readinessTrace).includes("batch_atomic"));
  });

  it("traces an invalid poll then records the reset without exposing values", async () => {
    let time = 0;
    let reads = 0;
    await expect(pollRbpSessionV2Readiness({
      expectedBinding: "wss",
      isBridgeExited: () => false,
      readSnapshot: async () => {
        reads += 1;
        if (reads === 1) return { sessions: [] };
        const snapshot = structuredClone(v2Snapshot);
        if (reads % 2 === 1) snapshot.sessions[0]!.value.binding.grantedCapabilities.reverse();
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
    const error = new RealTrioSessionReadinessPollError(
      "readiness failed",
      [],
      {
        sessions: [{
          namespace: "gateway.rbp-session/v2",
          value: {
            localSessionKey: "must-not-leak",
            deviceToken: "must-not-leak",
            lifecycle: { createdAtMs: 100, updatedAtMs: 200 },
          },
        }],
      },
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
        namespaces: ["gateway.rbp-session/v2"],
        sessions: [{
          binding: "unknown",
          lifecyclePhase: "unknown",
          dispatchAllowed: false,
          localKeyPresent: false,
          created: true,
          updated: true,
        }],
      }],
      bridgeTranscript: [{ stream: "stderr", at: "2026-08-23T00:00:00.000Z" }],
    });
    expect(JSON.parse(diagnostics!.bridgeTranscript[0]!.line)).toEqual({
      contractVersion: "revagent.wp12-real-worker-observation/v1",
      event: "bridge.connection_failure_observation",
      timestamp: "2026-08-23T00:00:00.000Z",
      binding: "streamable_http_sse",
      state: "retry_paused",
      reason: "authorization_refusal",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
    expect(JSON.stringify(diagnostics)).not.toContain("private\\path");
  });
});
