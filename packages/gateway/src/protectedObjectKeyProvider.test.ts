import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConformanceProtectedObjectKeyProvider, LinuxFileProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";

const roots: string[] = [];
const key64 = Buffer.alloc(32, 1).toString("base64");
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "revagent-c39-key-")); roots.push(value); return value; }
function document(active = "current", keys: Record<string, string> = { current: key64 }): string { return `{"v":1,"active_kid":${JSON.stringify(active)},"keys":{${Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)).map(([kid, value]) => `${JSON.stringify(kid)}:${JSON.stringify(value)}`).join(",")}}}`; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("C39 protected object key providers", () => {
  it("does not enable default or Windows configuration", async () => {
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: null, platform: "linux" }).readiness()).toBe("not_configured");
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: "C:\\keys\\c39.json", platform: "win32" }).readiness()).toBe("unsupported_platform");
  });

  it("keeps fixture keys conformance-only and rejects live-key removal", async () => {
    const provider = new ConformanceProtectedObjectKeyProvider("next", new Map([["old", Buffer.alloc(32, 3)], ["next", Buffer.alloc(32, 4)]]));
    expect(await provider.selfTest(new Set(["old"]))).toBe(true);
    expect(await provider.snapshot(new Set(["missing"]))).toBeNull();
  });

  it.runIf(process.platform === "linux")("rejects symlink, unsafe mode and non-canonical Linux key files", async () => {
    const directory = await root();
    const file = path.join(directory, "c39.json");
    await writeFile(file, document()); await chmod(file, 0o400);
    const good = new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file });
    expect(await good.selfTest()).toBe(true);
    await chmod(file, 0o600);
    expect(await good.snapshot()).toBeNull();
    await chmod(file, 0o400);
    const link = path.join(directory, "link.json"); await symlink(file, link);
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: link }).snapshot()).toBeNull();
    await writeFile(file, `${document()}\n`); await chmod(file, 0o400);
    expect(await new LinuxFileProtectedObjectKeyProvider({ keyFilePath: file }).snapshot()).toBeNull();
  });
});
