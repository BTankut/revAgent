import { describe, expect, it } from "vitest";

import { bridgeEndpointForBinding } from "../src/realTrioSupervisor.js";

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
