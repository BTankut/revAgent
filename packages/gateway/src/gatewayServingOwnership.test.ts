import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GatewayServingOwnership,
  REFUSE_DISPATCH_DURABILITY_PROFILE,
  resolveBundledTestServingOwnership,
} from "./gatewayServingOwnership.js";
import { createPreProductionRuntimeAdapters } from "./preProductionRuntimeAdapters.js";
import {
  createRestartableTestStore,
} from "./testAdapters.js";
import {
  GATEWAY_PRIVATE_OBJECT_MAX_BYTES,
  type GatewayPrivateObjectBinding,
} from "./store.js";

function binding(bytes: Uint8Array): GatewayPrivateObjectBinding {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  return Object.freeze({
    tenantId: "tenant-a",
    rsid: "rsid-a",
    purpose: "terminal-payload" as const,
    storageKey: digest,
    byteLength: bytes.byteLength,
    digest,
    contentType: "application/json",
  });
}

describe("GatewayServingOwnership", () => {
  it("mints the exact resource-less preproduction profile only while its lease is current", async () => {
    const adapters = createPreProductionRuntimeAdapters();
    const owner = new GatewayServingOwnership({
      protocolStore: adapters.protocolStore,
      privateObjectStore: adapters.privateObjectStore,
      profile: "preproduction_private",
    });

    expect(owner.durabilityProfile()).toStrictEqual(REFUSE_DISPATCH_DURABILITY_PROFILE);
    await expect(owner.protocolStore.open()).resolves.toMatchObject({ ok: true });
    expect(owner.durabilityProfile()).toMatchObject({
      version: 1,
      mode: "private_object",
      maxParamsBytes: 4 * 1024 * 1024,
      maxOutboundWireBytes: 50_331_648,
      maxResultBytes: 32 * 1024 * 1024,
      maxPartialBytes: 1,
      inlineSlotBytes: 65_536,
      privateObjectMaxBytes: 50_331_648,
      resourceCarrierReady: false,
    });
    expect(owner.ownerEpoch).toBeGreaterThan(0);

    await expect(owner.protocolStore.close()).resolves.toMatchObject({ ok: true });
    expect(owner.durabilityProfile()).toStrictEqual(REFUSE_DISPATCH_DURABILITY_PROFILE);
  });

  it("requires a minted durable intent and proves positive absence before metadata deletion", async () => {
    const adapters = createPreProductionRuntimeAdapters();
    const owner = new GatewayServingOwnership({
      protocolStore: adapters.protocolStore,
      privateObjectStore: adapters.privateObjectStore,
      profile: "preproduction_private",
    });
    await owner.protocolStore.open();
    try {
      const bytes = Buffer.from('{"result":"ok"}', "utf8");
      const descriptor = binding(bytes);
      const privateStore = owner.privateObjectStore();
      expect(privateStore).not.toBeNull();
      const ticket = owner.mintPrivateObjectIntent({
        binding: descriptor,
        intentNamespace: "gateway.session-blob-intent/v1",
        intentKey: "rsid-a/terminal/1",
        intentVersion: 1,
      });

      await expect(privateStore!.put(ticket, bytes)).resolves.toMatchObject({
        ok: true,
        value: { storageKey: descriptor.storageKey },
      });
      await expect(privateStore!.get(descriptor)).resolves.toMatchObject({ ok: true });
      await expect(privateStore!.scanOwned({
        tenantId: "tenant-a",
        rsid: "rsid-a",
        afterKey: null,
        limit: 64,
      })).resolves.toMatchObject({ ok: true, value: [descriptor] });

      await expect(privateStore!.delete(ticket)).resolves.toMatchObject({
        ok: true,
        value: { state: "deleted" },
      });
      await expect(privateStore!.getOptional(descriptor)).resolves.toStrictEqual({
        ok: true,
        value: null,
      });
      await expect(privateStore!.delete(ticket)).resolves.toMatchObject({
        ok: true,
        value: { state: "missing" },
      });
    } finally {
      await owner.protocolStore.close();
    }
  });

  it("mints the real production-conformance limit matrix without changing the public object API", async () => {
    const restartable = createRestartableTestStore();
    const backend = createPreProductionRuntimeAdapters().privateObjectStore;
    const owner = new GatewayServingOwnership({
      protocolStore: restartable.store,
      privateObjectStore: backend,
      profile: "production_conformance",
    });
    await owner.protocolStore.open();
    try {
      expect(owner.durabilityProfile()).toMatchObject({
        mode: "private_object",
        maxParamsBytes: 4_194_304,
        maxResultBytes: 33_554_432,
        maxPartialBytes: 1_048_576,
        maxOutboundWireBytes: 50_331_648,
        privateObjectMaxBytes: 50_331_648,
        resourceCarrierReady: true,
      });
      expect(owner.resourceObjectStore).not.toBeNull();
      expect(owner.privateObjectStore()?.contractVersion)
        .toBe("revagent.gateway-owned-private-object-store/v1");
    } finally {
      await owner.protocolStore.close();
    }
  });

  it("rejects unproved capacity and all private IO after owner release", async () => {
    const adapters = createPreProductionRuntimeAdapters();
    const owner = new GatewayServingOwnership({
      protocolStore: adapters.protocolStore,
      privateObjectStore: adapters.privateObjectStore,
      profile: "preproduction_private",
    });
    await owner.protocolStore.open();
    const privateStore = owner.privateObjectStore()!;
    const bytes = Buffer.from("x", "utf8");
    const descriptor = binding(bytes);
    expect(() => owner.mintPrivateObjectIntent({
      binding: { ...descriptor, byteLength: GATEWAY_PRIVATE_OBJECT_MAX_BYTES + 1 },
      intentNamespace: "gateway.session-blob-intent/v1",
      intentKey: "oversize",
      intentVersion: 1,
    })).toThrow("private object intent is unavailable");

    const ticket = owner.mintPrivateObjectIntent({
      binding: descriptor,
      intentNamespace: "gateway.session-blob-intent/v1",
      intentKey: "released",
      intentVersion: 1,
    });
    await owner.protocolStore.close();
    await expect(privateStore.put(ticket, bytes)).resolves.toMatchObject({ ok: false });
    await expect(privateStore.getOptional(descriptor)).resolves.toMatchObject({ ok: false });
  });

  it("brands restartable test stores without accepting a structural lookalike", async () => {
    const restartable = createRestartableTestStore();
    const first = resolveBundledTestServingOwnership(restartable.store);
    expect(first).toBeInstanceOf(GatewayServingOwnership);
    const restartedStore = restartable.restart();
    const second = resolveBundledTestServingOwnership(restartedStore);
    expect(second).toBeInstanceOf(GatewayServingOwnership);
    expect(second).not.toBe(first);
    expect(resolveBundledTestServingOwnership({ ...restartedStore })).toBeNull();
  });
});
