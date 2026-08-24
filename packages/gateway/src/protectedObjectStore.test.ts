import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConformanceProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";
import { C39_MAX_PLAINTEXT_BYTES, EncryptedProtectedObjectStore } from "./protectedObjectStore.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type { ObjectStorePort, ProtectedObjectBinding } from "./store.js";

function digest(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
const bytes = Buffer.from("C39 payload that must never reach the backing object store", "utf8");
const key = Buffer.alloc(32, 7);
const inventory = { kind: "conformance" as const, async listLiveKids() { return []; } };
const binding = (overrides: Partial<ProtectedObjectBinding> = {}): ProtectedObjectBinding => ({
  tenantId: "tenant", userId: "user", principalKey: "tenant:user", effectiveMcpSessionId: "mcp-session", sessionBindingId: "binding", rsid: "rsid", recoveryInvocationId: "018f2d10-1111-7000-8000-111111111111", originInvocationId: "018f2d10-2222-7000-8000-222222222222", originResultDigest: digest(Buffer.from("origin")), bridgeSequence: 4, chunkIndex: 0, plainDigest: digest(bytes), plainLength: bytes.byteLength, purpose: "dispatch_payload_recovery", expiresAtMs: 1_900_000_000_000, ...overrides,
});

class MemoryObjectStore implements ObjectStorePort {
  readonly kind = "memory" as const;
  readonly values = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(input: { tenantId: string; storageKey: string; bytes: Uint8Array; contentType: string }): Promise<GatewayPortResult<{ storageKey: string }>> { this.values.set(`${input.tenantId}/${input.storageKey}`, { bytes: Buffer.from(input.bytes), contentType: input.contentType }); return { ok: true, value: { storageKey: input.storageKey } }; }
  async get(input: { tenantId: string; storageKey: string }): Promise<GatewayPortResult<{ bytes: Uint8Array; contentType: string }>> { const value = this.values.get(`${input.tenantId}/${input.storageKey}`); return value === undefined ? { ok: false, port: "object_store", code: "unavailable", message: "missing" } : { ok: true, value: { bytes: Buffer.from(value.bytes), contentType: value.contentType } }; }
  async head(input: { tenantId: string; storageKey: string }): Promise<GatewayPortResult<{ byteSize: number }>> { const result = await this.get(input); return result.ok ? { ok: true, value: { byteSize: result.value.bytes.byteLength } } : result; }
  async delete(): Promise<GatewayPortResult<void>> { return { ok: true, value: undefined }; }
}

describe("C39 protected object encryption", () => {
  it("encrypts before the backing store and requires the complete bound AAD to read", async () => {
    const inner = new MemoryObjectStore();
    const subject = new EncryptedProtectedObjectStore(inner, new ConformanceProtectedObjectKeyProvider("k1", new Map([["k1", key]]), inventory));
    const storageKey = digest(bytes);
    expect((await subject.putProtected({ storageKey, contentType: "application/json", bytes, binding: binding() })).ok).toBe(true);
    const raw = inner.values.get(`tenant/${storageKey}`)!;
    expect(raw.contentType).toContain("protected-object");
    expect(Buffer.from(raw.bytes).includes(bytes)).toBe(false);
    await expect(subject.getProtected({ storageKey, contentType: "application/json", binding: binding() })).resolves.toMatchObject({ ok: true, value: { bytes } });
    await expect(subject.getProtected({ storageKey, contentType: "application/json", binding: binding({ rsid: "other-rsid" }) })).resolves.toMatchObject({ ok: false, message: "protected object unavailable" });
  });

  it("rejects each envelope mutation and object substitution without a plaintext fallback", async () => {
    const inner = new MemoryObjectStore();
    const subject = new EncryptedProtectedObjectStore(inner, new ConformanceProtectedObjectKeyProvider("k1", new Map([["k1", key]]), inventory));
    const storageKey = digest(bytes);
    await subject.putProtected({ storageKey, contentType: "application/json", bytes, binding: binding() });
    const original = inner.values.get(`tenant/${storageKey}`)!;
    for (const index of [0, 4, 5, 6, 7, original.bytes.byteLength - 1]) {
      const mutated = Buffer.from(original.bytes); mutated[index] ^= 1;
      inner.values.set(`tenant/${storageKey}`, { ...original, bytes: mutated });
      await expect(subject.getProtected({ storageKey, contentType: "application/json", binding: binding() })).resolves.toMatchObject({ ok: false });
    }
    inner.values.set(`tenant/${storageKey}`, original);
    await expect(subject.getProtected({ storageKey: digest(Buffer.from("substitute")), contentType: "application/json", binding: binding() })).resolves.toMatchObject({ ok: false });
  });

  it("uses historical keys for reads but refuses a missing caller-supplied live key", async () => {
    const legacy = Buffer.alloc(32, 3);
    const inner = new MemoryObjectStore();
    const writer = new EncryptedProtectedObjectStore(inner, new ConformanceProtectedObjectKeyProvider("old", new Map([["old", legacy]]), inventory));
    const storageKey = digest(bytes);
    await writer.putProtected({ storageKey, contentType: "application/json", bytes, binding: binding() });
    const rotated = new EncryptedProtectedObjectStore(inner, new ConformanceProtectedObjectKeyProvider("new", new Map([["old", legacy], ["new", key]]), inventory));
    await expect(rotated.getProtected({ storageKey, contentType: "application/json", binding: binding() })).resolves.toMatchObject({ ok: true });
    const requiredOld = { kind: "conformance" as const, async listLiveKids() { return ["old"]; } };
    await expect(new ConformanceProtectedObjectKeyProvider("new", new Map([["new", key]]), requiredOld).snapshot()).resolves.toBeNull();
  });

  it("rejects over-32MiB input before random bytes or backing-store write", async () => {
    const inner = new MemoryObjectStore();
    let randomCalls = 0;
    const subject = new EncryptedProtectedObjectStore(inner, new ConformanceProtectedObjectKeyProvider("k1", new Map([["k1", key]]), inventory), { randomBytes(size) { randomCalls += 1; return Buffer.alloc(size, 1); } });
    const oversized = Buffer.allocUnsafe(C39_MAX_PLAINTEXT_BYTES + 1);
    const result = await subject.putProtected({ storageKey: digest(oversized), contentType: "application/octet-stream", bytes: oversized, binding: binding({ plainLength: oversized.byteLength }) });
    expect(result).toMatchObject({ ok: false });
    expect(randomCalls).toBe(0);
    expect(inner.values.size).toBe(0);
  });
});
