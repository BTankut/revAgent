import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  SqliteConformanceProtocolStore,
} from "./conformanceEphemeralAdapters.js";

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

  it("requires a digest key and does not cross-read a tenant object", async () => {
    const store = new DigestFileConformanceObjectStore(await root());
    const bytes = Buffer.from("verified payload");
    const key = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await expect(store.put({ tenantId: "tenant_a", storageKey: key, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: true });
    await expect(store.get({ tenantId: "tenant_b", storageKey: key })).resolves.toMatchObject({ ok: false });
    await expect(store.put({ tenantId: "tenant_a", storageKey: `sha256:${"0".repeat(64)}`, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: false });
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
