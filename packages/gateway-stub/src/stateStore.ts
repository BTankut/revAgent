import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { PersistedGatewayState } from "./types.js";
import { createMutationHoldLedger } from "@revagent/protocol";

const WINDOWS_ATOMIC_RENAME_DELAYS_MS = [0, 10, 20, 40, 80, 160] as const;

interface AtomicRenameOptions {
  platform?: NodeJS.Platform;
  renameFile?: (source: string, destination: string) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
}

function isTransientWindowsRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === "win32" &&
    ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function renameAtomicallyWithRetry(
  source: string,
  destination: string,
  options: AtomicRenameOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  }));
  let lastError: unknown;
  for (const delayMs of WINDOWS_ATOMIC_RENAME_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsRenameError(error, platform)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function initialState(): PersistedGatewayState {
  return {
    schemaVersion: 1,
    nextId: 1,
    sessions: {},
    mutationHolds: createMutationHoldLedger(),
  };
}

function assertState(value: unknown): asserts value is PersistedGatewayState {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Number.isSafeInteger((value as { nextId?: unknown }).nextId) ||
    typeof (value as { sessions?: unknown }).sessions !== "object" ||
    (value as { sessions?: unknown }).sessions === null ||
    typeof (value as { mutationHolds?: unknown }).mutationHolds !== "object" ||
    (value as { mutationHolds?: { holds?: unknown } }).mutationHolds === null ||
    !Array.isArray((value as { mutationHolds?: { holds?: unknown } }).mutationHolds?.holds)
  ) {
    throw new Error("gateway stub state file has an unsupported or malformed schema");
  }
}

export class DurableGatewayStateStore {
  readonly path: string;
  private current: PersistedGatewayState;
  private tail: Promise<void> = Promise.resolve();

  private constructor(path: string, state: PersistedGatewayState) {
    this.path = path;
    this.current = state;
  }

  static async open(path: string): Promise<DurableGatewayStateStore> {
    const absolutePath = resolve(path);
    const parentDirectory = dirname(absolutePath);
    await mkdir(parentDirectory, { recursive: true });
    const temporaryPrefix = `${basename(absolutePath)}.tmp-`;
    for (const entry of await readdir(parentDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(temporaryPrefix)) {
        await rm(resolve(parentDirectory, entry.name), { force: true });
      }
    }
    let state: PersistedGatewayState;
    try {
      await access(absolutePath, constants.F_OK);
      const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
      assertState(parsed);
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      state = initialState();
    }

    const store = new DurableGatewayStateStore(absolutePath, state);
    if ((await access(absolutePath, constants.F_OK).then(() => true, () => false)) === false) {
      await store.persist(state);
    }
    return store;
  }

  snapshot(): PersistedGatewayState {
    return structuredClone(this.current);
  }

  async update<T>(mutator: (draft: PersistedGatewayState) => T): Promise<T> {
    let resolveResult: (value: T | PromiseLike<T>) => void = () => undefined;
    let rejectResult: (reason?: unknown) => void = () => undefined;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });

    this.tail = this.tail.then(async () => {
      const draft = structuredClone(this.current);
      try {
        const output = mutator(draft);
        await this.persist(draft);
        this.current = draft;
        resolveResult(output);
      } catch (error) {
        rejectResult(error);
      }
    });
    await result;
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private async persist(state: PersistedGatewayState): Promise<void> {
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const file = await open(temporaryPath, "wx", 0o600);
    let renamed = false;
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await renameAtomicallyWithRetry(temporaryPath, this.path);
      renamed = true;
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
        // NTFS FlushFileBuffers on a directory is not exposed by Node; the file itself was fsynced above.
      } finally {
        await directory.close();
      }
    } finally {
      if (!renamed) {
        await rm(temporaryPath, { force: true });
      }
    }
  }
}
