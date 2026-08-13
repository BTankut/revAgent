import { constants } from "node:fs";
import { inspect } from "node:util";
import { posix } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
  loadPreProductionCredentialFile,
  type PreProductionCredentialMaterial,
  type PreProductionCredentialFileIo,
  type PreProductionCredentialFileStat,
} from "./preProductionCredentialFile.js";
import {
  PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
  PRE_PRODUCTION_CREDENTIAL_GENERATOR_RELATIVE_PATH,
  PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES,
  PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_COUNT,
  PRE_PRODUCTION_NORTH_BEARER_HANDOFF_RELATIVE_PATH,
  PreProductionCredentialGeneratorError,
  generatePreProductionCredentialFile,
  runPreProductionCredentialGenerator,
  type PreProductionCredentialGeneratorDependencies,
  type PreProductionCredentialGeneratorHandle,
  type PreProductionCredentialGeneratorIo,
  type PreProductionCredentialGeneratorProcessIo,
  type PreProductionCredentialGeneratorRuntime,
  type PreProductionCredentialGeneratorStat,
} from "./preProductionCredentialGenerator.js";

const ROOT = "/srv/revagent-m4/SYNTHETIC-ROOT-FRAGMENT";
const RUNTIME_ROOT = `${ROOT}/runtime`;
const SECRETS_ROOT = `${RUNTIME_ROOT}/secrets`;
const HANDOFF_ROOT = `${RUNTIME_ROOT}/handoff`;
const CREDENTIAL_PATH = `${SECRETS_ROOT}/credentials.json`;
const NORTH_BEARER_HANDOFF_PATH = `${HANDOFF_ROOT}/north-bearer.bin`;
const UID = 1_000;

const SYNTHETIC_SOURCE_FRAGMENTS = Object.freeze([
  "SYNTHETIC-ROOT-FRAGMENT",
  "SYNTHETIC-RANDOM-SOURCE-FAILURE",
  "SYNTHETIC-WRITE-FAILURE",
  "SYNTHETIC-VALIDATOR-FAILURE",
  "SYNTHETIC-CLEANUP-FAILURE",
]);

const TEST_RUNTIME: PreProductionCredentialGeneratorRuntime = Object.freeze({
  nodeEnv: "test",
});

const VALID_ARGS = Object.freeze([
  "--root",
  ROOT,
  "--profile",
  "lan_test",
  "--mode",
  "preproduction",
]);

function directoryStat(
  ino: number,
  overrides: Partial<PreProductionCredentialGeneratorStat> = {},
): PreProductionCredentialGeneratorStat {
  return Object.freeze({
    file: false,
    directory: true,
    symbolicLink: false,
    dev: 7,
    ino,
    mode: 0o040700,
    nlink: 2,
    uid: UID,
    size: 0,
    ...overrides,
  });
}

function fileStat(
  size: number,
  overrides: Partial<PreProductionCredentialGeneratorStat> = {},
): PreProductionCredentialGeneratorStat {
  return Object.freeze({
    file: true,
    directory: false,
    symbolicLink: false,
    dev: 11,
    ino: 17,
    mode: 0o100400,
    nlink: 1,
    uid: UID,
    size,
    ...overrides,
  });
}

type ValueOrError<T> = T | Error;

interface FakeIoOptions {
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number | null;
  readonly absolute?: boolean;
  readonly resolvedRoot?: string;
  readonly directoryStats?: Readonly<
    Partial<Record<string, ValueOrError<PreProductionCredentialGeneratorStat | null>>>
  >;
  readonly realpaths?: Readonly<Partial<Record<string, ValueOrError<string>>>>;
  readonly openError?: Error;
  readonly openErrorsByPath?: Readonly<Partial<Record<string, Error>>>;
  readonly handleStats?: readonly ValueOrError<PreProductionCredentialGeneratorStat>[];
  readonly writeError?: Error;
  readonly writeErrorsByPath?: Readonly<Partial<Record<string, Error>>>;
  readonly syncError?: Error;
  readonly closeErrors?: readonly Error[];
  readonly cleanupStat?: ValueOrError<PreProductionCredentialGeneratorStat | null>;
  readonly unlinkError?: Error;
  readonly retainAfterUnlink?: boolean;
}

interface FakeIoCalls {
  readonly sequence: string[];
  readonly lstatPaths: string[];
  readonly realpathPaths: string[];
  readonly openCalls: Array<{
    readonly path: string;
    readonly flags: number;
    readonly mode: number;
  }>;
  readonly randomSizes: number[];
  readonly writes: Uint8Array[];
  unlinkCount: number;
  closeCount: number;
}

interface FakeIoFixture {
  readonly io: PreProductionCredentialGeneratorIo;
  readonly calls: FakeIoCalls;
  readonly state: {
    readonly files: Map<string, PreProductionCredentialGeneratorStat>;
    readonly bytesByPath: Map<string, Uint8Array>;
    readonly file: PreProductionCredentialGeneratorStat | null;
    readonly bytes: Uint8Array | null;
    readonly handoffFile: PreProductionCredentialGeneratorStat | null;
    readonly handoffBytes: Uint8Array | null;
  };
}

function resolved<T>(value: ValueOrError<T>): Promise<T> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

function fakeIo(options: FakeIoOptions = {}): FakeIoFixture {
  const calls: FakeIoCalls = {
    sequence: [],
    lstatPaths: [],
    realpathPaths: [],
    openCalls: [],
    randomSizes: [],
    writes: [],
    unlinkCount: 0,
    closeCount: 0,
  };
  const files = new Map<string, PreProductionCredentialGeneratorStat>();
  const bytesByPath = new Map<string, Uint8Array>();
  const state: FakeIoFixture["state"] = {
    files,
    bytesByPath,
    get file() {
      return files.get(CREDENTIAL_PATH) ?? null;
    },
    get bytes() {
      return bytesByPath.get(CREDENTIAL_PATH) ?? null;
    },
    get handoffFile() {
      return files.get(NORTH_BEARER_HANDOFF_PATH) ?? null;
    },
    get handoffBytes() {
      return bytesByPath.get(NORTH_BEARER_HANDOFF_PATH) ?? null;
    },
  };
  let handleStatIndex = 0;
  let closeIndex = 0;
  let cleanupStatConsumed = false;
  let activePath: string | null = null;
  const directories: Readonly<Record<string, PreProductionCredentialGeneratorStat>> =
    Object.freeze({
      [ROOT]: directoryStat(1),
      [RUNTIME_ROOT]: directoryStat(2),
      [SECRETS_ROOT]: directoryStat(3),
      [HANDOFF_ROOT]: directoryStat(4),
    });

  const handle: PreProductionCredentialGeneratorHandle = Object.freeze({
    stat: async () => {
      calls.sequence.push("handle.stat");
      const configured = options.handleStats?.[handleStatIndex];
      handleStatIndex += 1;
      if (configured !== undefined) {
        const value = await resolved(configured);
        if (activePath !== null) files.set(activePath, value);
        return value;
      }
      const currentPath = activePath ?? CREDENTIAL_PATH;
      const existing = files.get(currentPath);
      const fallback = fileStat(bytesByPath.get(currentPath)?.byteLength ?? 0, {
        dev: existing?.dev ?? 11,
        ino: existing?.ino ?? (currentPath === CREDENTIAL_PATH ? 17 : 18),
      });
      files.set(currentPath, fallback);
      return fallback;
    },
    writeFile: async (bytes: Uint8Array) => {
      calls.sequence.push("handle.writeFile");
      calls.writes.push(Uint8Array.from(bytes));
      const currentPath = activePath ?? CREDENTIAL_PATH;
      const writeError =
        options.writeErrorsByPath?.[currentPath] ?? options.writeError;
      if (writeError !== undefined) throw writeError;
      bytesByPath.set(currentPath, Uint8Array.from(bytes));
      const existing = files.get(currentPath);
      if (existing !== undefined) {
        files.set(
          currentPath,
          fileStat(bytes.byteLength, {
            dev: existing.dev,
            ino: existing.ino,
          }),
        );
      }
    },
    sync: async () => {
      calls.sequence.push("handle.sync");
      if (options.syncError !== undefined) throw options.syncError;
    },
    close: async () => {
      calls.sequence.push("handle.close");
      calls.closeCount += 1;
      const error = options.closeErrors?.[closeIndex];
      closeIndex += 1;
      if (error !== undefined) throw error;
    },
  });

  const io: PreProductionCredentialGeneratorIo = Object.freeze({
    platform: options.platform ?? "linux",
    currentUid: () => options.currentUid === undefined ? UID : options.currentUid,
    isAbsolute: () => options.absolute ?? true,
    resolve: () => options.resolvedRoot ?? ROOT,
    join: (...parts: readonly string[]) => posix.join(...parts),
    lstatOrNull: async (filePath: string) => {
      calls.sequence.push(`lstat:${filePath}`);
      calls.lstatPaths.push(filePath);
      const directoryOverride = options.directoryStats?.[filePath];
      if (directoryOverride !== undefined) return resolved(directoryOverride);
      if (filePath in directories) return directories[filePath]!;
      if (
        filePath === CREDENTIAL_PATH ||
        filePath === NORTH_BEARER_HANDOFF_PATH
      ) {
        if (!cleanupStatConsumed && options.cleanupStat !== undefined) {
          cleanupStatConsumed = true;
          return resolved(options.cleanupStat);
        }
        return files.get(filePath) ?? null;
      }
      return null;
    },
    realpath: async (filePath: string) => {
      calls.sequence.push(`realpath:${filePath}`);
      calls.realpathPaths.push(filePath);
      const configured = options.realpaths?.[filePath];
      return configured === undefined ? filePath : resolved(configured);
    },
    open: async (filePath: string, flags: number, mode: number) => {
      calls.sequence.push("open");
      calls.openCalls.push({ path: filePath, flags, mode });
      const openError = options.openErrorsByPath?.[filePath] ?? options.openError;
      if (openError !== undefined) throw openError;
      activePath = filePath;
      files.set(filePath, fileStat(0, {
        ino: filePath === CREDENTIAL_PATH ? 17 : 18,
      }));
      return handle;
    },
    unlink: async (filePath: string) => {
      calls.sequence.push(`unlink:${filePath}`);
      calls.unlinkCount += 1;
      if (options.unlinkError !== undefined) throw options.unlinkError;
      if (!options.retainAfterUnlink) {
        files.delete(filePath);
        bytesByPath.delete(filePath);
      }
    },
  });
  return { io, calls, state };
}

function deterministicRandoms(): readonly Uint8Array[] {
  return Object.freeze([
    Buffer.from("SYNTHETIC-NORTH-BEARER-RANDOM-BYTES-00000000001X"),
    Buffer.from("SYNTHETIC-IDENTITY-KEY-RANDOM-BYTES-00000000002X"),
    Buffer.from("SYNTHETIC-REQUEST-HMAC-RANDOM-BYTES-000000000003"),
  ]);
}

function loaderStat(
  value: PreProductionCredentialGeneratorStat,
): PreProductionCredentialFileStat {
  return Object.freeze({
    file: value.file,
    symbolicLink: value.symbolicLink,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    uid: value.uid,
    size: value.size,
    mtimeMs: 100,
    ctimeMs: 100,
  });
}

function dependenciesFor(
  fixture: FakeIoFixture,
  overrides: Partial<PreProductionCredentialGeneratorDependencies> = {},
): PreProductionCredentialGeneratorDependencies {
  const randoms = deterministicRandoms();
  let randomIndex = 0;
  return Object.freeze({
    randomBytes: (size: number) => {
      fixture.calls.sequence.push("randomBytes");
      fixture.calls.randomSizes.push(size);
      const value = randoms[randomIndex];
      randomIndex += 1;
      if (value === undefined) throw new Error("SYNTHETIC-RANDOM-EXHAUSTED");
      return value;
    },
    load: async (filePath: string) => {
      fixture.calls.sequence.push("load");
      expect(filePath).toBe(CREDENTIAL_PATH);
      const loaderIo: PreProductionCredentialFileIo = Object.freeze({
        platform: "linux",
        currentUid: () => UID,
        isAbsolute: () => true,
        resolve: () => CREDENTIAL_PATH,
        lstat: async () => {
          const value = fixture.state.file;
          if (value === null) throw new Error("SYNTHETIC-FILE-ABSENT");
          return loaderStat(value);
        },
        realpath: async () => CREDENTIAL_PATH,
        open: async (_path: string, flags: number) => {
          expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
          return Object.freeze({
            stat: async () => {
              const value = fixture.state.file;
              if (value === null) throw new Error("SYNTHETIC-FILE-ABSENT");
              return loaderStat(value);
            },
            readFile: async () => Uint8Array.from(fixture.state.bytes ?? []),
            close: async () => undefined,
          });
        },
      });
      return loadPreProductionCredentialFile(filePath, loaderIo);
    },
    ...overrides,
  });
}

interface CapturedProcessIo {
  readonly io: PreProductionCredentialGeneratorProcessIo;
  readonly stdout: string[];
  readonly stderr: string[];
}

function capturedProcessIo(): CapturedProcessIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return Object.freeze({
    stdout,
    stderr,
    io: Object.freeze({
      stdout: Object.freeze({ write: (value: string) => stdout.push(value) }),
      stderr: Object.freeze({ write: (value: string) => stderr.push(value) }),
    }),
  });
}

function assertValueFree(label: string, values: readonly unknown[]): void {
  const visible = values
    .map((value) => typeof value === "string" ? value : inspect(value, { depth: 8 }))
    .join("\n");
  for (const fragment of SYNTHETIC_SOURCE_FRAGMENTS) {
    expect(visible, `${label} leaked ${fragment}`).not.toContain(fragment);
  }
}

async function expectCoreRefusal(
  fixture: FakeIoFixture,
  expectedReason: string,
  dependencies = dependenciesFor(fixture),
): Promise<PreProductionCredentialGeneratorError> {
  let caught: unknown;
  try {
    await generatePreProductionCredentialFile(
      { root: ROOT, profile: "lan_test", mode: "preproduction" },
      fixture.io,
      dependencies,
      TEST_RUNTIME,
    );
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreProductionCredentialGeneratorError);
  expect(caught).toMatchObject({
    code: "preproduction_credential_generation_refused",
    reason: expectedReason,
  });
  return caught as PreProductionCredentialGeneratorError;
}

describe("M4-04/A2 pre-production credential generator", () => {
  it("creates the exact v1 document with three independent 48-byte OS-random calls", async () => {
    const fixture = fakeIo();
    const generated = await generatePreProductionCredentialFile(
      { root: ROOT, profile: "lan_test", mode: "preproduction" },
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );

    expect(generated).toEqual({
      ok: true,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      permissionPolicy: PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
      secretCount: PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_COUNT,
      secretBytesEach: PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES,
      credentialFileCreated: true,
      northBearerHandoffCreated: true,
      validated: true,
    });
    expect(PRE_PRODUCTION_CREDENTIAL_GENERATOR_RELATIVE_PATH).toBe(
      "runtime/secrets/credentials.json",
    );
    expect(PRE_PRODUCTION_NORTH_BEARER_HANDOFF_RELATIVE_PATH).toBe(
      "runtime/handoff/north-bearer.bin",
    );
    expect(fixture.calls.randomSizes).toEqual([48, 48, 48]);
    expect(fixture.calls.openCalls).toHaveLength(2);
    expect(fixture.calls.openCalls.map(({ path }) => path)).toEqual([
      CREDENTIAL_PATH,
      NORTH_BEARER_HANDOFF_PATH,
    ]);
    for (const opened of fixture.calls.openCalls) {
      expect(opened.mode).toBe(0o400);
      expect(opened.flags).toBe(
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
      );
    }

    const raw = Buffer.from(fixture.state.bytes ?? []).toString("utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const document = JSON.parse(raw) as Record<string, string>;
    expect(Object.keys(document)).toEqual([
      "contractVersion",
      "profile",
      "mode",
      "northBearerToken",
      "identityTokenKey",
      "requestStateHmacKey",
    ]);
    expect(document.contractVersion).toBe(
      PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
    );
    expect(document.profile).toBe("lan_test");
    expect(document.mode).toBe("preproduction");
    const secretValues = [
      document.northBearerToken,
      document.identityTokenKey,
      document.requestStateHmacKey,
    ];
    expect(new Set(secretValues).size).toBe(3);
    expect(secretValues.every((value) => value?.length === 64)).toBe(true);
    expect(
      secretValues.every((value) => /^[A-Za-z0-9_-]+$/.test(value ?? "")),
    ).toBe(true);
    expect(Buffer.from(fixture.state.handoffBytes ?? []).toString("ascii")).toBe(
      document.northBearerToken,
    );
    expect(fixture.state.handoffFile).toMatchObject({
      file: true,
      symbolicLink: false,
      mode: 0o100400,
      nlink: 1,
      uid: UID,
      size: 64,
    });
  });

  it("checks every directory before randomness and writes, syncs, closes, then re-opens", async () => {
    const fixture = fakeIo();
    await generatePreProductionCredentialFile(
      { root: ROOT, profile: "lan_test", mode: "preproduction" },
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );

    for (const directory of [ROOT, RUNTIME_ROOT, SECRETS_ROOT, HANDOFF_ROOT]) {
      expect(fixture.calls.lstatPaths).toContain(directory);
      expect(fixture.calls.lstatPaths.filter((path) => path === directory).length)
        .toBeGreaterThan(1);
    }
    expect(fixture.calls.realpathPaths.slice(0, 4)).toEqual([
      ROOT,
      RUNTIME_ROOT,
      SECRETS_ROOT,
      HANDOFF_ROOT,
    ]);
    expect(fixture.calls.realpathPaths.filter((path) => path === ROOT).length)
      .toBeGreaterThan(1);
    expect(fixture.calls.realpathPaths).toContain(CREDENTIAL_PATH);
    expect(fixture.calls.realpathPaths).toContain(NORTH_BEARER_HANDOFF_PATH);
    const sequence = fixture.calls.sequence;
    expect(sequence.indexOf("handle.writeFile")).toBeGreaterThan(
      sequence.indexOf("handle.stat"),
    );
    expect(sequence.indexOf("handle.sync")).toBeGreaterThan(
      sequence.indexOf("handle.writeFile"),
    );
    expect(sequence.indexOf("handle.close")).toBeGreaterThan(
      sequence.indexOf("handle.sync"),
    );
    expect(sequence.indexOf("load")).toBeGreaterThan(
      sequence.indexOf("handle.close"),
    );
    expect(sequence.lastIndexOf("open")).toBeGreaterThan(
      sequence.indexOf("load"),
    );
    expect(sequence.lastIndexOf("handle.close")).toBeGreaterThan(
      sequence.lastIndexOf("handle.stat"),
    );
    expect(fixture.calls.unlinkCount).toBe(0);
  });

  it.each([
    { name: "relative root", io: { absolute: false }, reason: "invalid_root" },
    {
      name: "non-normalized root",
      io: { resolvedRoot: "/srv/normalized" },
      reason: "invalid_root",
    },
    {
      name: "Windows platform",
      io: { platform: "win32" as NodeJS.Platform },
      reason: "unsupported_platform",
    },
    {
      name: "missing uid",
      io: { currentUid: null },
      reason: "unsupported_platform",
    },
    {
      name: "invalid uid",
      io: { currentUid: -1 },
      reason: "unsupported_platform",
    },
  ])("refuses $name before creating a file", async ({ io, reason }) => {
    const fixture = fakeIo(io);
    await expectCoreRefusal(fixture, reason);
    expect(fixture.calls.openCalls).toEqual([]);
    expect(fixture.calls.randomSizes).toEqual([]);
  });

  it.each([
    {
      name: "missing directory",
      stat: null,
      reason: "directory_unavailable",
    },
    {
      name: "unreadable directory",
      stat: new Error("SYNTHETIC-DIRECTORY-FAILURE"),
      reason: "directory_unavailable",
    },
    {
      name: "symlink directory",
      stat: directoryStat(2, { symbolicLink: true }),
      reason: "directory_symlink_refused",
    },
    {
      name: "non-directory",
      stat: fileStat(0),
      reason: "directory_not_directory",
    },
    {
      name: "wrong owner",
      stat: directoryStat(2, { uid: UID + 1 }),
      reason: "directory_owner_mismatch",
    },
    {
      name: "group-readable mode",
      stat: directoryStat(2, { mode: 0o040750 }),
      reason: "directory_permissions_invalid",
    },
  ])("refuses a $name ancestor", async ({ stat, reason }) => {
    const fixture = fakeIo({ directoryStats: { [RUNTIME_ROOT]: stat } });
    await expectCoreRefusal(fixture, reason);
    expect(fixture.calls.openCalls).toEqual([]);
    expect(fixture.calls.randomSizes).toEqual([]);
  });

  it("requires the protected handoff directory before generating material", async () => {
    const fixture = fakeIo({ directoryStats: { [HANDOFF_ROOT]: null } });
    await expectCoreRefusal(fixture, "directory_unavailable");
    expect(fixture.calls.lstatPaths).toContain(HANDOFF_ROOT);
    expect(fixture.calls.randomSizes).toEqual([]);
    expect(fixture.calls.openCalls).toEqual([]);
  });

  it("refuses a directory whose real path changes without disclosing it", async () => {
    const fixture = fakeIo({
      realpaths: {
        [SECRETS_ROOT]: "/srv/SYNTHETIC-REALPATH-TARGET",
      },
    });
    const caught = await expectCoreRefusal(
      fixture,
      "directory_path_not_canonical",
    );
    assertValueFree("realpath refusal", [caught, caught.message, caught.stack]);
    expect(fixture.calls.openCalls).toEqual([]);
  });

  it("refuses production before path, directory, random, or file access", async () => {
    const fixture = fakeIo();
    const output = capturedProcessIo();
    const exitCode = await runPreProductionCredentialGenerator(
      VALID_ARGS,
      output.io,
      fixture.io,
      dependenciesFor(fixture),
      { nodeEnv: " production " },
    );
    expect(exitCode).toBe(78);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      code: "preproduction_credential_generation_refused",
      reason: "production_mode_refused",
    });
    expect(fixture.calls.sequence).toEqual([]);
  });

  it("maps random-source exceptions value-free and never opens the file", async () => {
    const fixture = fakeIo();
    const output = capturedProcessIo();
    const deps = dependenciesFor(fixture, {
      randomBytes: () => {
        throw new Error("SYNTHETIC-RANDOM-SOURCE-FAILURE");
      },
    });
    const exitCode = await runPreProductionCredentialGenerator(
      VALID_ARGS,
      output.io,
      fixture.io,
      deps,
      TEST_RUNTIME,
    );
    expect(exitCode).toBe(78);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      code: "preproduction_credential_generation_refused",
      reason: "random_source_failed",
    });
    assertValueFree("random refusal", [output.stdout, output.stderr]);
    expect(fixture.calls.openCalls).toEqual([]);
  });

  it.each([
    {
      name: "short random return",
      randomBytes: () => new Uint8Array(47),
      reason: "invalid_random_material",
    },
    {
      name: "duplicate random values",
      randomBytes: () => Buffer.alloc(48, 7),
      reason: "duplicate_random_material",
    },
  ])("refuses $name before file creation", async ({ randomBytes, reason }) => {
    const fixture = fakeIo();
    await expectCoreRefusal(
      fixture,
      reason,
      dependenciesFor(fixture, { randomBytes }),
    );
    expect(fixture.calls.openCalls).toEqual([]);
  });

  it("does not delete an unknown pre-existing path when exclusive open fails", async () => {
    const fixture = fakeIo({
      openError: new Error("SYNTHETIC-EXISTING-PATH"),
    });
    await expectCoreRefusal(fixture, "file_create_refused");
    expect(fixture.calls.unlinkCount).toBe(0);
  });

  it.each([
    {
      name: "wrong initial owner",
      stats: [fileStat(0, { uid: UID + 1 })],
      reason: "file_verification_refused",
      cleanup: true,
    },
    {
      name: "wrong initial mode",
      stats: [fileStat(0, { mode: 0o100600 })],
      reason: "file_verification_refused",
      cleanup: true,
    },
    {
      name: "non-empty new file",
      stats: [fileStat(1)],
      reason: "file_verification_refused",
      cleanup: true,
    },
    {
      name: "non-file handle",
      stats: [directoryStat(17)],
      reason: "cleanup_failed",
      cleanup: false,
    },
    {
      name: "symlink handle anomaly",
      stats: [fileStat(0, { symbolicLink: true })],
      reason: "cleanup_failed",
      cleanup: false,
    },
    {
      name: "hardlink anomaly",
      stats: [fileStat(0, { nlink: 2 })],
      reason: "cleanup_failed",
      cleanup: false,
    },
  ])("handles $name without deleting an unowned identity", async ({ stats, reason, cleanup }) => {
    const fixture = fakeIo({ handleStats: stats });
    await expectCoreRefusal(fixture, reason);
    expect(fixture.calls.unlinkCount).toBe(cleanup ? 1 : 0);
    if (cleanup) expect(fixture.state.file).toBeNull();
  });

  it.each([
    {
      name: "write failure",
      options: { writeError: new Error("SYNTHETIC-WRITE-FAILURE") },
      reason: "file_write_refused",
    },
    {
      name: "sync failure",
      options: { syncError: new Error("SYNTHETIC-SYNC-FAILURE") },
      reason: "file_sync_refused",
    },
    {
      name: "one close failure followed by a successful cleanup close",
      options: { closeErrors: [new Error("SYNTHETIC-CLOSE-FAILURE")] },
      reason: "file_close_refused",
    },
  ])("unlinks and proves absence after $name", async ({ options, reason }) => {
    const fixture = fakeIo(options);
    const caught = await expectCoreRefusal(fixture, reason);
    expect(fixture.calls.unlinkCount).toBe(1);
    expect(fixture.state.file).toBeNull();
    assertValueFree(`${reason} error`, [caught, caught.message, caught.stack]);
  });

  it("removes a generated file when re-open validation fails", async () => {
    const fixture = fakeIo();
    const deps = dependenciesFor(fixture, {
      load: async () => {
        throw new Error("SYNTHETIC-VALIDATOR-FAILURE");
      },
    });
    const caught = await expectCoreRefusal(
      fixture,
      "credential_validation_refused",
      deps,
    );
    expect(fixture.calls.unlinkCount).toBe(1);
    expect(fixture.state.file).toBeNull();
    assertValueFree("loader refusal", [caught, caught.message, caught.stack]);
  });

  it("removes both owned files when north-bearer handoff creation fails", async () => {
    const fixture = fakeIo({
      writeErrorsByPath: {
        [NORTH_BEARER_HANDOFF_PATH]: new Error("SYNTHETIC-WRITE-FAILURE"),
      },
    });
    const caught = await expectCoreRefusal(fixture, "file_write_refused");
    expect(fixture.calls.openCalls.map(({ path }) => path)).toEqual([
      CREDENTIAL_PATH,
      NORTH_BEARER_HANDOFF_PATH,
    ]);
    expect(fixture.calls.unlinkCount).toBe(2);
    expect(fixture.state.file).toBeNull();
    expect(fixture.state.handoffFile).toBeNull();
    assertValueFree("handoff write error", [caught, caught.message, caught.stack]);
  });

  it("removes a generated file when the re-opened material disagrees", async () => {
    const fixture = fakeIo();
    const invalidMaterial: PreProductionCredentialMaterial = Object.freeze({
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      northAuthorization: "Bearer SYNTHETIC-WRONG-NORTH-CREDENTIAL",
      identityTokenKey: "SYNTHETIC-WRONG-IDENTITY-CREDENTIAL",
      requestStateHmacKey: "SYNTHETIC-WRONG-REQUEST-CREDENTIAL",
    });
    await expectCoreRefusal(
      fixture,
      "credential_validation_refused",
      dependenciesFor(fixture, { load: async () => invalidMaterial }),
    );
    expect(fixture.calls.unlinkCount).toBe(1);
    expect(fixture.state.file).toBeNull();
  });

  it.each([
    {
      name: "path identity changed",
      options: { cleanupStat: fileStat(0, { ino: 99 }) },
      unlink: false,
    },
    {
      name: "a second hardlink appeared",
      options: { cleanupStat: fileStat(0, { nlink: 2 }) },
      unlink: false,
    },
    {
      name: "unlink failed",
      options: { unlinkError: new Error("SYNTHETIC-CLEANUP-FAILURE") },
      unlink: true,
    },
    {
      name: "path remained after unlink",
      options: { retainAfterUnlink: true },
      unlink: true,
    },
    {
      name: "handle could not be closed during cleanup",
      options: {
        closeErrors: [
          new Error("SYNTHETIC-CLOSE-FAILURE"),
          new Error("SYNTHETIC-CLEANUP-FAILURE"),
        ],
      },
      unlink: true,
    },
  ])("returns terminal cleanup_failed when $name", async ({ options, unlink }) => {
    const fixture = fakeIo({
      writeError: new Error("SYNTHETIC-WRITE-FAILURE"),
      ...options,
    });
    const output = capturedProcessIo();
    const exitCode = await runPreProductionCredentialGenerator(
      VALID_ARGS,
      output.io,
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );
    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      code: "credential_generation_failed",
      reason: "cleanup_failed",
    });
    expect(fixture.calls.unlinkCount).toBe(unlink ? 1 : 0);
    assertValueFree("cleanup refusal", [output.stdout, output.stderr]);
  });

  it("preserves the original fixed refusal when the owned path is already absent", async () => {
    const fixture = fakeIo({
      writeError: new Error("SYNTHETIC-WRITE-FAILURE"),
      cleanupStat: null,
    });
    await expectCoreRefusal(fixture, "file_write_refused");
    expect(fixture.calls.unlinkCount).toBe(0);
  });

  it.each([
    { argv: [] },
    { argv: ["--root", ROOT] },
    { argv: ["--root", ROOT, "--root", ROOT, "--mode", "preproduction"] },
    { argv: ["--root", ROOT, "--profile", "wrong", "--mode", "preproduction"] },
    { argv: ["--root", ROOT, "--profile", "lan_test", "--mode", "production"] },
    { argv: ["--root", ROOT, "--profile", "lan_test", "--unknown", "value"] },
  ])("returns one fixed invalid-invocation line for argv $argv", async ({ argv }) => {
    const fixture = fakeIo();
    const output = capturedProcessIo();
    const exitCode = await runPreProductionCredentialGenerator(
      argv,
      output.io,
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );
    expect(exitCode).toBe(64);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      code: "invalid_invocation",
      reason: "invalid_invocation",
    });
    expect(fixture.calls.sequence).toEqual([]);
  });

  it("emits one bounded success line without the root or generated values", async () => {
    const fixture = fakeIo();
    const output = capturedProcessIo();
    const exitCode = await runPreProductionCredentialGenerator(
      VALID_ARGS,
      output.io,
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );
    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      ok: true,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      permissionPolicy: PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
      secretCount: 3,
      secretBytesEach: 48,
      credentialFileCreated: true,
      northBearerHandoffCreated: true,
      validated: true,
    });
    const document = JSON.parse(
      Buffer.from(fixture.state.bytes ?? []).toString("utf8"),
    ) as Record<string, string>;
    assertValueFree("success output", [output.stdout, output.stderr]);
    for (const secret of [
      document.northBearerToken,
      document.identityTokenKey,
      document.requestStateHmacKey,
    ]) {
      expect(output.stdout.join("\n")).not.toContain(secret ?? "missing");
    }
  });

  it("sanitizes a forged generator error rather than trusting its reason", async () => {
    const forged = Object.create(
      PreProductionCredentialGeneratorError.prototype,
    ) as PreProductionCredentialGeneratorError;
    Object.defineProperties(forged, {
      reason: { value: "SYNTHETIC-VALIDATOR-FAILURE" },
      code: { value: "SYNTHETIC-RANDOM-SOURCE-FAILURE" },
      message: { value: "SYNTHETIC-CLEANUP-FAILURE" },
    });
    const fixture = fakeIo();
    const maliciousIo: PreProductionCredentialGeneratorIo = Object.freeze({
      ...fixture.io,
      isAbsolute: () => {
        throw forged;
      },
    });
    const output = capturedProcessIo();
    const exitCode = await runPreProductionCredentialGenerator(
      VALID_ARGS,
      output.io,
      maliciousIo,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );
    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
      code: "credential_generation_failed",
      reason: "internal_error",
    });
    assertValueFree("forged refusal", [output.stdout, output.stderr]);
  });

  it("never touches a listener", async () => {
    const listen = vi.spyOn(
      (await import("node:net")).Server.prototype,
      "listen",
    );
    const fixture = fakeIo();
    await generatePreProductionCredentialFile(
      { root: ROOT, profile: "lan_test", mode: "preproduction" },
      fixture.io,
      dependenciesFor(fixture),
      TEST_RUNTIME,
    );
    expect(listen).not.toHaveBeenCalled();
    listen.mockRestore();
  });
});
