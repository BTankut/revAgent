import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  ProtectedConformanceObjectStore,
  SqliteConformanceProtocolStore,
} from "./conformanceEphemeralAdapters.js";
import { ConformanceProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";
import { EncryptedProtectedObjectStore } from "./protectedObjectStore.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "revagent-wp12-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map(async (value) => rm(value, { recursive: true, force: true }))); });

describe("conformance ephemeral adapters", () => {
  it("rejects malformed/revoked HMAC device credentials and keeps audit without raw token", async () => {
    const identity = new ConformanceCredentialAuthority([{ tenantId: "tenant_a", userId: "user_a", deviceId: "device_a", token: "test-token" }], Buffer.alloc(32, 7));
    const issued = identity.issue("device_a");
    await expect(identity.authenticateDevice({ deviceToken: issued, connectionId: "connection", claimedDeviceId: "device_a", machineFingerprint: fingerprint })).resolves.toMatchObject({ ok: true });
    expect(identity.revoke("device_a")).toBe(true);
    await expect(identity.authenticateDevice({ deviceToken: issued, connectionId: "connection", claimedDeviceId: "device_a", machineFingerprint: fingerprint })).resolves.toMatchObject({ ok: false });
    expect(JSON.stringify(identity.audit())).not.toContain("test-token");
  });

  it("carries only the public contract's explicit per-launch grants into device authentication", async () => {
    const identity = new ConformanceCredentialAuthority([
      { tenantId: "tenant_a", userId: "user_a", deviceId: "device_a", token: "test-token" },
    ], Buffer.alloc(32, 8));
    const issued = identity.issue("device_a", {
      connectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1", "transport_streamable_http"],
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    });
    await expect(identity.authenticateDevice({ deviceToken: issued, connectionId: "http", claimedDeviceId: "device_a", machineFingerprint: fingerprint }))
      .resolves.toMatchObject({ ok: true, value: {
        grantedConnectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1", "transport_streamable_http"],
        grantedSessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
      } });

    const unprovisioned = identity.issue("device_a", {
      connectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1"],
      sessionCapabilities: [],
    });
    await expect(identity.authenticateDevice({ deviceToken: unprovisioned, connectionId: "http", claimedDeviceId: "device_a", machineFingerprint: fingerprint }))
      .resolves.toMatchObject({ ok: true, value: {
        grantedConnectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1", "route_rebind_proof_v1"],
        grantedSessionCapabilities: [],
      } });
  });

  it("persists CAS state across restart and keeps tenant inventory bounded", async () => {
    const location = await root();
    const first = new SqliteConformanceProtocolStore(location);
    expect((await first.open()).ok).toBe(true);
    expect((await first.transact({ tenantId: "tenant_a" }, (tx) => { tx.stage({ namespace: "sessions", key: "one", value: { status: "open" }, expect: { kind: "absent" } }); return "written"; })).ok).toBe(true);
    await first.close();
    const restarted = new SqliteConformanceProtocolStore(location);
    await restarted.open();
    const read = await restarted.transact({ tenantId: "tenant_a" }, (tx) => tx.read("sessions", "one"));
    expect(read).toMatchObject({ ok: true, value: { value: { status: "open" }, version: 1 } });
    expect(await restarted.startupCoordinator.listTenantIds(1)).toMatchObject({ ok: true, value: ["tenant_a"] });
    await restarted.close();
  });

  it("uses SQLite CAS across two independently opened adapter instances", async () => {
    const location = await root();
    const left = new SqliteConformanceProtocolStore(location);
    const right = new SqliteConformanceProtocolStore(location);
    await left.open(); await right.open();
    expect(await left.transact({ tenantId: "tenant_a" }, (tx) => { tx.stage({ namespace: "sessions", key: "one", value: { n: 1 }, expect: { kind: "absent" } }); return true; })).toMatchObject({ ok: true });
    expect(await right.transact({ tenantId: "tenant_a" }, (tx) => { tx.stage({ namespace: "sessions", key: "one", value: { n: 2 }, expect: { kind: "absent" } }); return true; })).toMatchObject({ ok: false, code: "conflict" });
    await left.close(); await right.close();
  });

  it("serializes startup work across independently opened SQLite adapters", async () => {
    const location = await root();
    const left = new SqliteConformanceProtocolStore(location);
    const right = new SqliteConformanceProtocolStore(location);
    await left.open(); await right.open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = left.startupCoordinator.runExclusive(async () => { order.push("left"); await held; return { ok: true as const, value: undefined }; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = right.startupCoordinator.runExclusive(async () => { order.push("right"); return { ok: true as const, value: undefined }; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["left"]);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(order).toEqual(["left", "right"]);
    await left.close(); await right.close();
  });

  it("renews a short SQLite lease over three lease periods without contender overlap", async () => {
    const location = await root();
    const options = { startupLeaseMs: 90, startupRenewMs: 20 };
    const left = new SqliteConformanceProtocolStore(location, options);
    const right = new SqliteConformanceProtocolStore(location, options);
    await left.open(); await right.open();
    let leftEnd = 0; let rightStart = 0;
    const first = left.startupCoordinator.runExclusive(async () => { await new Promise((resolve) => setTimeout(resolve, 310)); leftEnd = Date.now(); return { ok: true as const, value: undefined }; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = right.startupCoordinator.runExclusive(async () => { rightStart = Date.now(); return { ok: true as const, value: undefined }; });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(rightStart).toBeGreaterThanOrEqual(leftEnd);
    await left.close(); await right.close();
  });

  it("fails on renewal ownership loss and permits only stale takeover after replacement expiry", async () => {
    const location = await root(); const options = { startupLeaseMs: 90, startupRenewMs: 20 };
    const owner = new SqliteConformanceProtocolStore(location, options); await owner.open();
    const replaced = new Database(path.join(location, "sqlite.db"));
    const lost = await owner.startupCoordinator.runExclusive(async () => {
      replaced.prepare("UPDATE conformance_startup_lock SET owner_token = ?, lease_expires_at_ms = ?, version = version + 1 WHERE id = 1").run("replacement", Date.now() + 80);
      await new Promise((resolve) => setTimeout(resolve, 45));
      return { ok: true as const, value: "owner" };
    });
    expect(lost).toMatchObject({ ok: false, code: "unavailable" });
    const check = replaced.prepare<unknown[], { owner_token: string | null }>("SELECT owner_token FROM conformance_startup_lock WHERE id = 1").get();
    expect(check?.owner_token).toBe("replacement");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = new SqliteConformanceProtocolStore(location, options); await third.open();
    await expect(third.startupCoordinator.runExclusive(async () => ({ ok: true as const, value: "taken" }))).resolves.toMatchObject({ ok: true, value: "taken" });
    replaced.close(); await owner.close(); await third.close();
  });

  it("requires a digest key and does not cross-read a tenant object", async () => {
    const location = await root();
    const store = new DigestFileConformanceObjectStore(location);
    const bytes = Buffer.from("verified payload");
    const key = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await expect(store.put({ tenantId: "tenant_a", storageKey: key, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: true });
    await expect(new DigestFileConformanceObjectStore(location).get({ tenantId: "tenant_a", storageKey: key })).resolves.toMatchObject({ ok: true, value: { contentType: "application/octet-stream" } });
    await expect(store.get({ tenantId: "tenant_b", storageKey: key })).resolves.toMatchObject({ ok: false });
    await expect(store.put({ tenantId: "tenant_a", storageKey: `sha256:${"0".repeat(64)}`, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: false });
  });

  it("keeps ordinary content addressing while C39 opaque protected keys are isolated and write-once", async () => {
    const location = await root();
    const ordinary = new DigestFileConformanceObjectStore(location);
    const protectedStore = new ProtectedConformanceObjectStore(location);
    const ordinaryBytes = Buffer.from("ordinary content-addressed bytes");
    const ordinaryKey = `sha256:${createHash("sha256").update(ordinaryBytes).digest("hex")}`;
    const opaqueKey = `sha256:${"0".repeat(64)}`;
    const encrypted = Buffer.from("RAPO-not-a-content-address");
    const changed = Buffer.from("RAPO-different-ciphertext");
    await expect(ordinary.put({
      tenantId: "tenant_a", storageKey: ordinaryKey, bytes: ordinaryBytes,
      contentType: "application/json",
    })).resolves.toMatchObject({ ok: true });
    await expect(ordinary.put({
      tenantId: "tenant_a", storageKey: opaqueKey, bytes: encrypted,
      contentType: "application/vnd.revagent.c39.protected-object",
    })).resolves.toMatchObject({ ok: false });
    await expect(protectedStore.put({
      tenantId: "tenant_a", storageKey: opaqueKey, bytes: encrypted,
      contentType: "application/vnd.revagent.c39.protected-object",
    })).resolves.toMatchObject({ ok: true });
    await expect(protectedStore.put({
      tenantId: "tenant_a", storageKey: opaqueKey, bytes: encrypted,
      contentType: "application/vnd.revagent.c39.protected-object",
    })).resolves.toMatchObject({ ok: true });
    await expect(protectedStore.put({
      tenantId: "tenant_a", storageKey: opaqueKey, bytes: changed,
      contentType: "application/vnd.revagent.c39.protected-object",
    })).resolves.toMatchObject({ ok: false });
    await expect(protectedStore.get({ tenantId: "tenant_a", storageKey: opaqueKey }))
      .resolves.toMatchObject({ ok: true, value: { bytes: encrypted } });
    await expect(ordinary.get({ tenantId: "tenant_a", storageKey: opaqueKey }))
      .resolves.toMatchObject({ ok: false });
  });

  it("refuses a protected-store junction component before any opaque-key write", async () => {
    const location = await root();
    const outside = await root();
    const linked = path.join(location, "linked-root");
    await symlink(outside, linked, "junction");
    const store = new ProtectedConformanceObjectStore(linked);
    await expect(store.put({
      tenantId: "tenant_a",
      storageKey: `sha256:${"0".repeat(64)}`,
      bytes: Buffer.from("RAPO-protected"),
      contentType: "application/vnd.revagent.c39.protected-object",
    })).resolves.toMatchObject({ ok: false });
  });

  it("stores a C39 AES-GCM envelope under its opaque AAD key without changing ordinary digest validation", async () => {
    const location = await root();
    const keyId = "c39-conformance-test";
    const keys = new ConformanceProtectedObjectKeyProvider(
      keyId,
      new Map([[keyId, Buffer.alloc(32, 7)]]),
      Object.freeze({ kind: "conformance" as const, async listLiveKids() { return [keyId] as const; } }),
    );
    const protectedStore = new EncryptedProtectedObjectStore(
      new ProtectedConformanceObjectStore(location),
      keys,
      { randomBytes: () => Buffer.alloc(12, 9) },
    );
    const storageKey = `sha256:${"0".repeat(64)}`;
    const bytes = Buffer.from('{"encrypted":true}', "utf8");
    const binding = Object.freeze({
      tenantId: "tenant_a", userId: "user_a", principalKey: "tenant_a:user_a",
      effectiveMcpSessionId: "mcp_a", sessionBindingId: "0197a3c2-0000-7000-8000-000000000001",
      sessionBindingVersion: 1, rsid: "rsid_a",
      recoveryInvocationId: "0197a3c2-0000-7000-8000-000000000002",
      originInvocationId: "0197a3c2-0000-7000-8000-000000000003",
      originResultDigest: `sha256:${"a".repeat(64)}`,
      resultRefDigest: `sha256:${"b".repeat(64)}`,
      bridgeSequence: 5, chunkIndex: 0,
      plainDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      plainLength: bytes.byteLength,
      purpose: "dispatch_payload_recovery" as const,
      expiresAtMs: Date.now() + 60_000,
    });
    await expect(protectedStore.putProtected({
      storageKey, contentType: "application/json", bytes, binding,
    })).resolves.toMatchObject({ ok: true });
    await expect(protectedStore.getProtected({
      storageKey, contentType: "application/json", binding,
    })).resolves.toMatchObject({ ok: true, value: { bytes, contentType: "application/json" } });
    await expect(new DigestFileConformanceObjectStore(location).get({
      tenantId: "tenant_a", storageKey,
    })).resolves.toMatchObject({ ok: false });
  });

  it("rejects a pre-created tenant directory and never exposes a sidecar-only interrupted write", async () => {
    const location = await root();
    const bytes = Buffer.from("partial");
    const key = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await mkdir(path.join(location, "objects", "tenant_a"), { recursive: true });
    const store = new DigestFileConformanceObjectStore(location);
    await expect(store.put({ tenantId: "tenant_a", storageKey: key, bytes, contentType: "text/plain" })).resolves.toMatchObject({ ok: false });
    await writeFile(path.join(location, "objects", "tenant_a", `${key.slice(7)}.content-type`), "text/plain");
    await expect(store.get({ tenantId: "tenant_a", storageKey: key })).resolves.toMatchObject({ ok: false });
  });

  it("rejects a junction component rather than resolving outside its exclusive root", async () => {
    const location = await root();
    const outside = await root();
    const linked = path.join(location, "linked-root");
    await symlink(outside, linked, "junction");
    const bytes = Buffer.from("junction");
    const key = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const store = new DigestFileConformanceObjectStore(linked);
    await expect(store.put({ tenantId: "tenant_a", storageKey: key, bytes, contentType: "text/plain" })).resolves.toMatchObject({ ok: false });
  });
});
