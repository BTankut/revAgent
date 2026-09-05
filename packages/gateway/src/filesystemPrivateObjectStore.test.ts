import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemPrivateObjectStore } from "./filesystemPrivateObjectStore.js";
import type { GatewayPrivateObjectBinding } from "./store.js";

const roots: string[] = [];
const digest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const descriptor = (bytes: Uint8Array): GatewayPrivateObjectBinding => ({
  tenantId: "tenant-a", rsid: "session-a", purpose: "terminal-payload",
  storageKey: `sha256:${"a".repeat(64)}`, byteLength: bytes.byteLength,
  digest: digest(bytes), contentType: "application/json",
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eu20-private-objects-")); roots.push(root);
  return { root, store: new FilesystemPrivateObjectStore(root) };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("production private filesystem objects", () => {
  it("persists immutable owner-bound bytes across adapter restart", async () => {
    const { root, store } = await fixture(), bytes = Buffer.from('{"value":1}'), binding = descriptor(bytes);
    expect(await store.putOwned({ binding, bytes })).toMatchObject({ ok: true });
    const restarted = new FilesystemPrivateObjectStore(root);
    expect(await restarted.getOwnedOptional({ binding })).toEqual({ ok: true, value: { bytes, contentType: binding.contentType } });
    expect(await restarted.putOwned({ binding, bytes })).toMatchObject({ ok: true });
    const changed = Buffer.from('{"value":2}');
    expect(await restarted.putOwned({ binding: { ...binding, digest: digest(changed) }, bytes: changed })).toMatchObject({ ok: false });
  });
  it("refuses foreign descriptors and does not reveal another tenant's object", async () => {
    const { store } = await fixture(), bytes = Buffer.from("data"), binding = descriptor(bytes);
    await store.putOwned({ binding, bytes });
    expect(await store.getOwnedOptional({ binding: { ...binding, rsid: "other" } })).toMatchObject({ ok: false });
    expect(await store.getOwnedOptional({ binding: { ...binding, tenantId: "tenant-b" } })).toEqual({ ok: true, value: null });
    expect(await store.deleteOwned({ binding: { ...binding, rsid: "other" } })).toMatchObject({ ok: false });
    expect(await store.getOwnedOptional({ binding })).toMatchObject({ ok: true });
  });
  it("refuses tampered bytes and path traversal", async () => {
    const { root, store } = await fixture(), bytes = Buffer.from("data"), binding = descriptor(bytes);
    await store.putOwned({ binding, bytes });
    const file = join(root, "objects", binding.tenantId, binding.storageKey.slice(7));
    const damaged = await readFile(file); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await writeFile(file, damaged);
    expect(await store.getOwnedOptional({ binding })).toMatchObject({ ok: false });
    expect(await store.get({ tenantId: "../tenant-a", storageKey: binding.storageKey })).toMatchObject({ ok: false });
  });
  it("deletes only the exact owned descriptor and verifies absence", async () => {
    const { store } = await fixture(), bytes = Buffer.from("data"), binding = descriptor(bytes);
    await store.putOwned({ binding, bytes });
    expect(await store.scanOwned({ tenantId: binding.tenantId, rsid: binding.rsid, afterKey: null, limit: 2 })).toEqual({ ok: true, value: [binding] });
    expect(await store.deleteOwned({ binding })).toEqual({ ok: true, value: { state: "deleted" } });
    expect(await store.deleteOwned({ binding })).toEqual({ ok: true, value: { state: "missing" } });
  });
});
