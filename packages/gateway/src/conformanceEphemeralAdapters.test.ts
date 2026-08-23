import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  });

  it("requires a digest key and does not cross-read a tenant object", async () => {
    const store = new DigestFileConformanceObjectStore(await root());
    const bytes = Buffer.from("verified payload");
    const key = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await expect(store.put({ tenantId: "tenant_a", storageKey: key, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: true });
    await expect(store.get({ tenantId: "tenant_b", storageKey: key })).resolves.toMatchObject({ ok: false });
    await expect(store.put({ tenantId: "tenant_a", storageKey: `sha256:${"0".repeat(64)}`, bytes, contentType: "application/octet-stream" })).resolves.toMatchObject({ ok: false });
  });
});
