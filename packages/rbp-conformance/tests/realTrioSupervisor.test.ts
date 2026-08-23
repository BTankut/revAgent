import { describe, expect, it } from "vitest";

import {
  bridgeEndpointForBinding,
  fixtureAttestationTokens,
  fixtureAttestedWorkerCommand,
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
