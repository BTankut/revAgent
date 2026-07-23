import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableGatewayStateStore,
  renameAtomicallyWithRetry,
} from "../src/stateStore.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function files(): Promise<{ directory: string; canonical: string; temporary: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-state-rename-"));
  temporaryDirectories.push(directory);
  const canonical = path.join(directory, "state.json");
  const temporary = path.join(directory, "state.json.tmp");
  await writeFile(canonical, "old\n", "utf8");
  await writeFile(temporary, "new\n", "utf8");
  return { directory, canonical, temporary };
}

function transient(code: "EPERM" | "EACCES" | "EBUSY"): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

describe("Windows atomic state replacement", () => {
  it("leaves live and canonical authority unchanged on a pre-rename update failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gateway-state-pre-rename-"));
    temporaryDirectories.push(directory);
    const canonical = path.join(directory, "state.json");
    await writeFile(canonical, JSON.stringify({
      schemaVersion: 1,
      nextId: 1,
      sessions: {},
      mutationHolds: { holds: [] },
    }), "utf8");
    const store = await DurableGatewayStateStore.open(canonical, {
      beforeCanonicalReplace: () => {
        throw new Error("injected pre-rename failure");
      },
    });

    await expect(store.update((draft) => {
      draft.nextId = 2;
    })).rejects.toMatchObject({
      name: "GatewayStatePersistenceError",
      canonicalReplaced: false,
    });
    expect(store.snapshot().nextId).toBe(1);
    expect(JSON.parse(await readFile(canonical, "utf8"))).toMatchObject({ nextId: 1 });
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("retries only the same atomic rename after transient sharing failures", async () => {
    const { canonical, temporary } = await files();
    const waits: number[] = [];
    let attempts = 0;

    await renameAtomicallyWithRetry(temporary, canonical, {
      platform: "win32",
      wait: async (delayMs) => { waits.push(delayMs); },
      renameFile: async (source, destination) => {
        attempts += 1;
        if (attempts === 1) throw transient("EPERM");
        if (attempts === 2) throw transient("EBUSY");
        await rename(source, destination);
      },
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([10, 20]);
    expect(await readFile(canonical, "utf8")).toBe("new\n");
  });

  it("fails closed after the bounded retry window without replacing the canonical file", async () => {
    const { canonical, temporary } = await files();
    const waits: number[] = [];
    let attempts = 0;

    await expect(renameAtomicallyWithRetry(temporary, canonical, {
      platform: "win32",
      wait: async (delayMs) => { waits.push(delayMs); },
      renameFile: async () => {
        attempts += 1;
        throw transient(attempts % 2 === 0 ? "EACCES" : "EPERM");
      },
    })).rejects.toMatchObject({ code: "EACCES" });

    expect(attempts).toBe(6);
    expect(waits).toEqual([10, 20, 40, 80, 160]);
    expect(await readFile(canonical, "utf8")).toBe("old\n");
    expect(await readFile(temporary, "utf8")).toBe("new\n");
  });
});
