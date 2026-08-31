import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConformanceProtectedObjectKeyProvider, LinuxFileProtectedObjectKeyProvider, MAX_PROTECTED_OBJECT_KEY_COUNT, type ProtectedObjectLiveKeyInventoryPort } from "./protectedObjectKeyProvider.js";

const roots: string[] = [];
const key64 = Buffer.alloc(32, 1).toString("base64");
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "revagent-c39-key-")); roots.push(value); return value; }
function document(active = "current", keys: Record<string, string> = { current: key64 }): string { return `{"v":1,"active_kid":${JSON.stringify(active)},"keys":{${Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)).map(([kid, value]) => `${JSON.stringify(kid)}:${JSON.stringify(value)}`).join(",")}}}`; }
function inventory(kids: readonly string[] = [], kind: "durable" | "conformance" = "durable"): ProtectedObjectLiveKeyInventoryPort & { kids: string[] } { return { kind, kids: [...kids], async listLiveKids() { return this.kids; } }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("C39 protected object key providers", () => {
  it("does not enable default/Windows configuration or a non-durable production inventory", async () => {
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: null, inventory: inventory(), platform: "linux" }).readiness()).toBe("not_configured");
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: "C:\\keys\\c39.json", inventory: inventory(), platform: "win32" }).readiness()).toBe("unsupported_platform");
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: "/run/c39.json", inventory: inventory([], "conformance"), platform: "linux" }).readiness()).toBe("not_configured");
  });
  it("keeps fixture keys conformance-only and has provider-owned live inventory", async () => {
    const owned = inventory(["old"], "conformance");
    const provider = new ConformanceProtectedObjectKeyProvider("next", new Map([["old", Buffer.alloc(32, 3)], ["next", Buffer.alloc(32, 4)]]), owned);
    expect(MAX_PROTECTED_OBJECT_KEY_COUNT).toBe(16);
    expect(await provider.selfTest()).toBe(true);
    owned.kids = Array.from({ length: MAX_PROTECTED_OBJECT_KEY_COUNT + 1 }, (_, index) => `kid-${index}`);
    expect(await provider.snapshot()).toBeNull();
    owned.kids = ["missing"];
    expect(await provider.snapshot()).toBeNull();
  });
  it.runIf(process.platform === "linux")("uses pinned descriptors and refuses symlink, modes, and ancestry swaps", async () => {
    const directory = await root(); const parent = path.join(directory, "trusted"); const replacement = path.join(directory, "attacker"); await mkdir(parent); await mkdir(replacement);
    const file = path.join(parent, "c39.json"); await writeFile(file, document()); await chmod(file, 0o400);
    const required = inventory(["current"]);
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file, inventory: required }).selfTest()).toBe(true);
    await chmod(file, 0o600); expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file, inventory: required }).snapshot()).toBeNull(); await chmod(file, 0o400);
    const link = path.join(directory, "link.json"); await symlink(file, link); expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: link, inventory: required }).snapshot()).toBeNull();
    const moved = path.join(directory, "trusted-old");
    const raced = new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file, inventory: required, boundaryHook: async () => { await rename(parent, moved); await mkdir(parent); await writeFile(path.join(parent, "c39.json"), document("current", { current: Buffer.alloc(32, 9).toString("base64") })); await chmod(path.join(parent, "c39.json"), 0o400); } });
    expect(await raced.snapshot()).toBeNull();
  });
  it.runIf(process.platform === "linux")("keeps prior snapshot internally and fails closed on durable live-key removal", async () => {
    const directory = await root(); const file = path.join(directory, "c39.json"); const previous = Buffer.alloc(32, 2).toString("base64"); await writeFile(file, document("current", { current: key64, old: previous })); await chmod(file, 0o400);
    const required = inventory(["old"]); const provider = new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file, inventory: required }); expect(await provider.snapshot()).not.toBeNull();
    await chmod(file, 0o600); await writeFile(file, document("current", { current: key64 })); await chmod(file, 0o400); expect(await provider.snapshot()).toBeNull();
  });
});
