import { describe, expect, it } from "vitest";

import {
  createProductionConformanceC39OriginResendPolicy,
  startProductionGatewayHost,
} from "./productionConformanceHost.js";
import { conformanceConnectionCapabilitiesForBinding, validateConformanceDeviceProvision } from "./productionConformanceHostCli.js";
import type { GatewayServerOptions } from "./server.js";
import { createFailClosedPorts } from "./server.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { ConformanceCredentialAuthority, DigestFileConformanceObjectStore, SqliteConformanceProtocolStore, createConformanceSupportingPorts } from "./conformanceEphemeralAdapters.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function server(nodeEnv: "test" | "production", bindHost: string): Omit<GatewayServerOptions, "ports"> {
  return {
    config: {
      nodeEnv,
      logLevel: "fatal",
      http: { bindHost, port: 0 },
      publicUrl: "https://gateway.invalid",
      objectStore: { driver: "fs", root: null },
      credentialsPresent: { databaseUrl: false },
      ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
    },
  };
}

describe("productionGatewayHost", () => {
  it("mints the D2b one-shot policy only for the fixed C39 fixture identity", () => {
    const policy = createProductionConformanceC39OriginResendPolicy();
    expect(policy.kind).toBe("internal_d2b_conformance");
    expect(policy.allowCapture({
      tenantId: "conformance", userId: "conformance", rsid: "r1",
      originInvocationId: "019f9ac3-ae89-7342-9f6d-b9269e167187",
      method: "fixture_multi_file_output", toolName: "conformance.fixture.c39_multifile",
    })).toBe(true);
    expect(policy.takeResumeRequest({
      tenantId: "conformance", userId: "conformance", rsid: "r1", sessionBindingId: "b1",
    })).toEqual({
      originInvocationId: "019f9ac3-ae89-7342-9f6d-b9269e167187",
      originIdempotencyKey: "r1/019f9ac3-ae89-7342-9f6d-b9269e167187",
    });
    expect(policy.takeResumeRequest({
      tenantId: "conformance", userId: "conformance", rsid: "r1", sessionBindingId: "b1",
    })).toBeNull();
    expect(policy.allowCapture({
      tenantId: "other", userId: "conformance", rsid: "r2",
      originInvocationId: "019f9ac3-ae89-7342-9f6d-b9269e167188",
      method: "fixture_multi_file_output", toolName: "conformance.fixture.c39_multifile",
    })).toBe(false);
  });
  it("requires the one public provisioning contract to name the selected carrier explicitly", () => {
    expect(conformanceConnectionCapabilitiesForBinding("wss")).toEqual([
      "journal_v1", "chunked_results", "artifact_result_v1",
    ]);
    expect(conformanceConnectionCapabilitiesForBinding("streamable_http_sse")).toEqual([
      "journal_v1", "chunked_results", "artifact_result_v1", "transport_streamable_http",
    ]);
    for (const binding of ["wss", "streamable_http_sse"] as const) {
      const connectionCapabilities = conformanceConnectionCapabilitiesForBinding(binding);
      expect(validateConformanceDeviceProvision({
        binding,
        connectionCapabilities,
        sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
      })).toEqual({ binding, connectionCapabilities, sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"] });
    }
    // An HTTP/SSE launch cannot degrade to an empty or unprovisioned grant.
    expect(validateConformanceDeviceProvision({
      binding: "streamable_http_sse",
      connectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1"],
      sessionCapabilities: [],
    })).toBeNull();
  });
  it("requires one exact bridge/resource/protocol/object-store identity graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "revagent-carrier-graph-"));
    try {
      const identity = new ConformanceCredentialAuthority([]);
      const protocolStore = new SqliteConformanceProtocolStore(root);
      await protocolStore.open();
      const objectStore = new DigestFileConformanceObjectStore(root);
      const resources = new GatewayResourceAuthority({ protocolStore, objectStore });
      const authority = new GatewayBridgeSessionAuthority(protocolStore, identity, {
        resourceAuthority: resources,
      });
      const otherObjects = new DigestFileConformanceObjectStore(`${root}-other`);
      const otherStore = new SqliteConformanceProtocolStore(`${root}-store`);
      await otherStore.open();
      const unavailableResources = new GatewayResourceAuthority({
        protocolStore,
        objectStore: { kind: "unavailable" } as never,
      });

      expect(authority.hasExactCarrierComposition(resources, objectStore)).toBe(true);
      expect(authority.hasExactCarrierComposition(resources, otherObjects)).toBe(false);
      expect(resources.isBridgeCarrierReady(otherStore, objectStore)).toBe(false);
      expect(unavailableResources.isBridgeCarrierReady(protocolStore)).toBe(false);

      await otherStore.close();
      await protocolStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-other`, { recursive: true, force: true });
      await rm(`${root}-store`, { recursive: true, force: true });
    }
  });
  it("is explicitly non-production and numeric-loopback only before any port can start", async () => {
    await expect(startProductionGatewayHost({
      server: server("production", "127.0.0.1"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
      resourceAuthority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/conformance-only/u);
    await expect(startProductionGatewayHost({
      server: server("test", "localhost"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
      resourceAuthority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/numeric loopback/u);
  });
  it("requires the explicit profile and a complete conformance tuple before opening a socket", async () => {
    const ports = createFailClosedPorts();
    await expect(startProductionGatewayHost({
      server: { ...server("test", "127.0.0.1"), tls: { key: Buffer.from("test"), cert: Buffer.from("test") } }, ports,
      authority: null as unknown as never,
      resourceAuthority: null as unknown as never,
      hostProfile: "not_conformance" as never,
    })).rejects.toThrow(/host profile/u);
    await expect(startProductionGatewayHost({
      server: { ...server("test", "127.0.0.1"), tls: { key: Buffer.from("test"), cert: Buffer.from("test") } }, ports,
      authority: null as unknown as never,
      resourceAuthority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/explicit conformance identity/u);
  });
  it("refuses a plaintext listener before any adapter startup", async () => {
    await expect(startProductionGatewayHost({
      server: server("test", "127.0.0.1"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
      resourceAuthority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/loopback TLS/u);
  });
  it("rejects a forged conformance-shaped ingress before any listener starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "revagent-forged-"));
    try {
      const identity = new ConformanceCredentialAuthority([]);
      const protocolStore = new SqliteConformanceProtocolStore(root); await protocolStore.open();
      const objectStore = new DigestFileConformanceObjectStore(root);
      const resources = new GatewayResourceAuthority({ protocolStore, objectStore });
      const authority = new GatewayBridgeSessionAuthority(protocolStore, identity, {
        resourceAuthority: resources,
      });
      const supporting = createConformanceSupportingPorts();
      const forged = { kind: "conformance" as const, enabled: true as const, mountPrefix: "/bridge/v1" as const, authority, delegate: { authority }, refuse: () => ({ ok: false as const, port: "rbp_ingress" as const, code: "unavailable" as const, message: "forged" }), mount: () => { throw new Error("listener must not mount"); } };
      await expect(startProductionGatewayHost({
        server: { ...server("test", "127.0.0.1"), tls: { key: Buffer.from("test"), cert: Buffer.from("test") } },
        ports: { identity, protocolStore, objectStore, entitlement: supporting.entitlement, events: supporting.events, guardrails: supporting.guardrails, rbpIngress: forged as never }, authority, resourceAuthority: resources, hostProfile: "production_conformance",
      })).rejects.toThrow(/exact validated conformance ingress/u);
      await protocolStore.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
