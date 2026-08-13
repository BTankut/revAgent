import { constants } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_MESSAGES,
  PreProductionCredentialFileError,
  loadPreProductionCredentialFile,
  type PreProductionCredentialFileErrorReason,
  type PreProductionCredentialFileHandle,
  type PreProductionCredentialFileIo,
  type PreProductionCredentialFileStat,
} from "./preProductionCredentialFile.js";

const SYNTHETIC_SECRETS = Object.freeze({
  northBearer:
    "SYNTHETIC-NORTH-BEARER__NORTH-HEAD__NORTH-MIDDLE__NORTH-TAIL__DO-NOT-USE",
  identityTokenKey:
    "SYNTHETIC-IDENTITY-TOKEN-KEY__IDENTITY-HEAD__IDENTITY-MIDDLE__IDENTITY-TAIL__DO-NOT-USE",
  requestStateHmacKey:
    "SYNTHETIC-REQUEST-STATE-HMAC__STATE-HEAD__STATE-MIDDLE__STATE-TAIL__DO-NOT-USE",
});

const SYNTHETIC_FRAGMENTS = Object.freeze([
  "SYNTHETIC-",
  "NORTH-HEAD",
  "NORTH-MIDDLE",
  "NORTH-TAIL",
  "IDENTITY-HEAD",
  "IDENTITY-MIDDLE",
  "IDENTITY-TAIL",
  "STATE-HEAD",
  "STATE-MIDDLE",
  "STATE-TAIL",
]);

const FILE_PATH = "/run/revagent-m4/credentials.json";
const encoder = new TextEncoder();

interface CredentialDocument {
  readonly contractVersion: string;
  readonly profile: string;
  readonly mode: string;
  readonly northBearerToken: string;
  readonly identityTokenKey: string;
  readonly requestStateHmacKey: string;
}

function validDocument(
  overrides: Partial<CredentialDocument> = {},
): CredentialDocument {
  return {
    contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
    profile: "lan_test",
    mode: "preproduction",
    northBearerToken: SYNTHETIC_SECRETS.northBearer,
    identityTokenKey: SYNTHETIC_SECRETS.identityTokenKey,
    requestStateHmacKey: SYNTHETIC_SECRETS.requestStateHmacKey,
    ...overrides,
  };
}

function documentBytes(
  overrides: Partial<CredentialDocument> = {},
): Uint8Array {
  return encoder.encode(JSON.stringify(validDocument(overrides)));
}

function baseStat(size: number): PreProductionCredentialFileStat {
  return Object.freeze({
    file: true,
    symbolicLink: false,
    dev: 11,
    ino: 17,
    mode: 0o100400,
    nlink: 1,
    uid: 1_000,
    size,
    mtimeMs: 100,
    ctimeMs: 100,
  });
}

type ValueOrError<T> = T | Error;

interface FakeIoOptions {
  readonly bytes?: Uint8Array;
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number | null;
  readonly absolute?: boolean;
  readonly resolvedPath?: string;
  readonly initialStat?: ValueOrError<PreProductionCredentialFileStat>;
  readonly canonicalPath?: ValueOrError<string>;
  readonly canonicalPathAfterRead?: ValueOrError<string>;
  readonly openError?: Error;
  readonly beforeStat?: ValueOrError<PreProductionCredentialFileStat>;
  readonly afterStat?: ValueOrError<PreProductionCredentialFileStat>;
  readonly readError?: Error;
  readonly closeError?: Error;
}

interface FakeIoCalls {
  lstat: number;
  realpath: number;
  open: number;
  stat: number;
  readFile: number;
  close: number;
  openFlags: number | null;
  readonly isAbsolutePaths: string[];
  readonly resolvePaths: string[];
  readonly lstatPaths: string[];
  readonly realpathPaths: string[];
  readonly openPaths: string[];
}

function resolveValue<T>(value: ValueOrError<T>): Promise<T> {
  return value instanceof Error
    ? Promise.reject(value)
    : Promise.resolve(value);
}

function fakeIo(options: FakeIoOptions = {}): {
  readonly io: PreProductionCredentialFileIo;
  readonly calls: FakeIoCalls;
} {
  const bytes = options.bytes ?? documentBytes();
  const initialStat = options.initialStat ?? baseStat(bytes.byteLength);
  const fallbackStat =
    initialStat instanceof Error ? baseStat(bytes.byteLength) : initialStat;
  const beforeStat = options.beforeStat ?? fallbackStat;
  const afterStat = options.afterStat ?? beforeStat;
  const calls: FakeIoCalls = {
    lstat: 0,
    realpath: 0,
    open: 0,
    stat: 0,
    readFile: 0,
    close: 0,
    openFlags: null,
    isAbsolutePaths: [],
    resolvePaths: [],
    lstatPaths: [],
    realpathPaths: [],
    openPaths: [],
  };

  const handle: PreProductionCredentialFileHandle = Object.freeze({
    stat: async () => {
      calls.stat += 1;
      return resolveValue(calls.stat === 1 ? beforeStat : afterStat);
    },
    readFile: async () => {
      calls.readFile += 1;
      if (options.readError !== undefined) {
        throw options.readError;
      }
      return bytes;
    },
    close: async () => {
      calls.close += 1;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
    },
  });

  return {
    calls,
    io: Object.freeze({
      platform: options.platform ?? "linux",
      currentUid: () =>
        options.currentUid === undefined ? 1_000 : options.currentUid,
      isAbsolute: (filePath: string) => {
        calls.isAbsolutePaths.push(filePath);
        return options.absolute ?? true;
      },
      resolve: (filePath: string) => {
        calls.resolvePaths.push(filePath);
        return options.resolvedPath ?? FILE_PATH;
      },
      lstat: async (filePath: string) => {
        calls.lstatPaths.push(filePath);
        calls.lstat += 1;
        return resolveValue(initialStat);
      },
      realpath: async (filePath: string) => {
        calls.realpathPaths.push(filePath);
        calls.realpath += 1;
        return resolveValue(
          calls.realpath === 1
            ? (options.canonicalPath ?? FILE_PATH)
            : (options.canonicalPathAfterRead ??
                options.canonicalPath ??
                FILE_PATH),
        );
      },
      open: async (filePath: string, flags: number) => {
        calls.openPaths.push(filePath);
        calls.open += 1;
        calls.openFlags = flags;
        if (options.openError !== undefined) {
          throw options.openError;
        }
        return handle;
      },
    }),
  };
}

function observableText(values: readonly unknown[]): string {
  return values
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      return inspect(value, {
        depth: null,
        showHidden: true,
        getters: false,
        customInspect: false,
      });
    })
    .join("\n");
}

/** Failure messages identify only the fixture class; they never print canaries. */
function assertNoSyntheticSecretLeak(
  caseId: string,
  values: readonly unknown[],
  additionalSecrets: readonly string[] = [],
): void {
  const visible = observableText(values);
  const fullSecrets = [
    ...Object.values(SYNTHETIC_SECRETS),
    ...additionalSecrets,
  ];
  for (let index = 0; index < fullSecrets.length; index += 1) {
    if (visible.includes(fullSecrets[index] ?? "")) {
      throw new Error(
        `${caseId}: full synthetic credential ${String(index)} leaked`,
      );
    }
  }
  for (let index = 0; index < SYNTHETIC_FRAGMENTS.length; index += 1) {
    if (visible.includes(SYNTHETIC_FRAGMENTS[index] ?? "")) {
      throw new Error(
        `${caseId}: synthetic credential fragment ${String(index)} leaked`,
      );
    }
  }
}

async function captureRefusal(
  caseId: string,
  expectedReason: PreProductionCredentialFileErrorReason,
  options: FakeIoOptions,
  filePath = FILE_PATH,
  additionalSecrets: readonly string[] = [],
): Promise<PreProductionCredentialFileError> {
  const { io } = fakeIo(options);
  const processStdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const processStderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
  ];
  let caught: unknown;
  try {
    await loadPreProductionCredentialFile(filePath, io);
  } catch (error: unknown) {
    caught = error;
  }
  const directWrites = [
    processStdout.mock.calls,
    processStderr.mock.calls,
    ...consoleSpies.map((spy) => spy.mock.calls),
  ];
  processStdout.mockRestore();
  processStderr.mockRestore();
  for (const consoleSpy of consoleSpies) {
    consoleSpy.mockRestore();
  }
  if (!(caught instanceof PreProductionCredentialFileError)) {
    throw new Error(`${caseId}: expected a credential-file refusal`);
  }
  expect(caught).toMatchObject({
    name: "PreProductionCredentialFileError",
    code: "preproduction_credential_file_refused",
    reason: expectedReason,
    message: PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_MESSAGES[expectedReason],
  });
  expect(Object.hasOwn(caught, "cause")).toBe(false);
  assertNoSyntheticSecretLeak(
    caseId,
    [
      caught,
      caught.name,
      caught.message,
      caught.stack,
      Object.getOwnPropertyDescriptors(caught),
      JSON.stringify(caught),
      ...directWrites,
    ],
    additionalSecrets,
  );
  expect(directWrites.every((calls) => calls.length === 0)).toBe(true);
  return caught;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M4-03 pre-production credential file", () => {
  it("uses only recognizable fixed synthetic secrets in new fixtures", () => {
    const values = Object.values(SYNTHETIC_SECRETS);
    expect(values.every((value) => value.startsWith("SYNTHETIC-"))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it("loads the exact v1 contract from one unchanged owner-read-only descriptor", async () => {
    const { io, calls } = fakeIo();
    const loaded = await loadPreProductionCredentialFile(FILE_PATH, io);

    expect(loaded).toEqual({
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      northAuthorization: `Bearer ${SYNTHETIC_SECRETS.northBearer}`,
      identityTokenKey: SYNTHETIC_SECRETS.identityTokenKey,
      requestStateHmacKey: SYNTHETIC_SECRETS.requestStateHmacKey,
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(calls).toMatchObject({
      lstat: 1,
      realpath: 2,
      open: 1,
      stat: 2,
      readFile: 1,
      close: 1,
    });
    expect(calls.isAbsolutePaths).toEqual([FILE_PATH]);
    expect(calls.resolvePaths).toEqual([FILE_PATH]);
    expect(calls.lstatPaths).toEqual([FILE_PATH]);
    expect(calls.realpathPaths).toEqual([FILE_PATH, FILE_PATH]);
    expect(calls.openPaths).toEqual([FILE_PATH]);
    expect(calls.openFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
  });

  it("fails closed for every physical-file and descriptor policy violation", async () => {
    const bytes = documentBytes();
    const stat = baseStat(bytes.byteLength);
    const cases: readonly {
      readonly id: string;
      readonly reason: PreProductionCredentialFileErrorReason;
      readonly options: FakeIoOptions;
      readonly filePath?: string;
    }[] = [
      {
        id: "relative-path",
        reason: "invalid_path",
        options: { absolute: false },
        filePath: `SYNTHETIC-NORTH-HEAD/credentials.json`,
      },
      {
        id: "non-normalized-path",
        reason: "invalid_path",
        options: { resolvedPath: "/run/credentials.json" },
      },
      {
        id: "windows-acl-unsupported",
        reason: "unsupported_platform",
        options: { platform: "win32" },
      },
      {
        id: "missing-getuid",
        reason: "unsupported_platform",
        options: { currentUid: null },
      },
      {
        id: "native-lstat-error",
        reason: "file_unavailable",
        options: { initialStat: new Error(SYNTHETIC_SECRETS.northBearer) },
      },
      {
        id: "symlink",
        reason: "symlink_refused",
        options: { initialStat: { ...stat, symbolicLink: true } },
      },
      {
        id: "directory",
        reason: "not_regular_file",
        options: { initialStat: { ...stat, file: false } },
      },
      {
        id: "ancestor-symlink",
        reason: "path_not_canonical",
        options: {
          canonicalPath: `/real/${SYNTHETIC_SECRETS.requestStateHmacKey}`,
        },
      },
      {
        id: "different-owner",
        reason: "owner_mismatch",
        options: { initialStat: { ...stat, uid: 1_001 } },
      },
      {
        id: "owner-writable",
        reason: "invalid_permissions",
        options: { initialStat: { ...stat, mode: 0o100600 } },
      },
      {
        id: "group-readable",
        reason: "invalid_permissions",
        options: { initialStat: { ...stat, mode: 0o100440 } },
      },
      {
        id: "setuid-bit",
        reason: "invalid_permissions",
        options: { initialStat: { ...stat, mode: 0o104400 } },
      },
      {
        id: "hardlink",
        reason: "invalid_link_count",
        options: { initialStat: { ...stat, nlink: 2 } },
      },
      {
        id: "empty",
        reason: "invalid_size",
        options: { initialStat: { ...stat, size: 0 } },
      },
      {
        id: "oversize",
        reason: "invalid_size",
        options: { initialStat: { ...stat, size: 16 * 1_024 + 1 } },
      },
      {
        id: "open-error",
        reason: "file_unavailable",
        options: { openError: new Error(SYNTHETIC_SECRETS.identityTokenKey) },
      },
      {
        id: "path-switched-before-read",
        reason: "changed_during_read",
        options: { beforeStat: { ...stat, ino: stat.ino + 1 } },
      },
      {
        id: "read-error",
        reason: "file_unavailable",
        options: { readError: new Error(SYNTHETIC_SECRETS.northBearer) },
      },
      {
        id: "changed-after-read",
        reason: "changed_during_read",
        options: { afterStat: { ...stat, mtimeMs: stat.mtimeMs + 1 } },
      },
      {
        id: "ancestor-switched-after-read",
        reason: "path_not_canonical",
        options: {
          canonicalPathAfterRead: `/real/${SYNTHETIC_SECRETS.requestStateHmacKey}`,
        },
      },
      {
        id: "close-error",
        reason: "file_unavailable",
        options: {
          closeError: new Error(SYNTHETIC_SECRETS.requestStateHmacKey),
        },
      },
    ];

    for (const testCase of cases) {
      await captureRefusal(
        testCase.id,
        testCase.reason,
        { bytes, ...testCase.options },
        testCase.filePath,
      );
    }
  });

  it("rejects invalid encoding, structure, binding, and secret classes value-free", async () => {
    const weakSecret = "SYNTHETIC-WEAK";
    const overlongSecret = `SYNTHETIC-OVERLONG-${"A".repeat(4_096)}`;
    const nonAsciiSecret = `${SYNTHETIC_SECRETS.northBearer}é`;
    const valid = validDocument();
    const duplicateField = `{${Object.entries(valid)
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(",")},"northBearerToken":${JSON.stringify(
      SYNTHETIC_SECRETS.northBearer,
    )}}`;
    const malformed = `{"contractVersion":"${PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION}","northBearerToken":"${SYNTHETIC_SECRETS.northBearer}",`;
    const cases: readonly {
      readonly id: string;
      readonly reason: PreProductionCredentialFileErrorReason;
      readonly bytes: Uint8Array;
      readonly additionalSecrets?: readonly string[];
    }[] = [
      {
        id: "invalid-utf8",
        reason: "invalid_encoding",
        bytes: new Uint8Array([0xc3, 0x28]),
      },
      {
        id: "utf8-bom",
        reason: "invalid_encoding",
        bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...documentBytes()]),
      },
      {
        id: "nul-byte",
        reason: "invalid_encoding",
        bytes: new Uint8Array([...documentBytes(), 0]),
      },
      {
        id: "malformed-json-near-secret",
        reason: "malformed_document",
        bytes: encoder.encode(malformed),
      },
      {
        id: "non-object-root",
        reason: "malformed_document",
        bytes: encoder.encode(
          JSON.stringify([SYNTHETIC_SECRETS.identityTokenKey]),
        ),
      },
      {
        id: "non-string-value",
        reason: "malformed_document",
        bytes: encoder.encode(JSON.stringify({ ...valid, profile: 1 })),
      },
      {
        id: "duplicate-json-key",
        reason: "duplicate_field",
        bytes: encoder.encode(duplicateField),
      },
      {
        id: "unknown-field",
        reason: "unknown_field",
        bytes: encoder.encode(
          JSON.stringify({
            ...valid,
            unexpected: SYNTHETIC_SECRETS.requestStateHmacKey,
          }),
        ),
      },
      {
        id: "missing-field",
        reason: "missing_field",
        bytes: encoder.encode(
          JSON.stringify({
            contractVersion: valid.contractVersion,
            profile: valid.profile,
            mode: valid.mode,
            northBearerToken: valid.northBearerToken,
            identityTokenKey: valid.identityTokenKey,
          }),
        ),
      },
      {
        id: "unsupported-version",
        reason: "unsupported_contract_version",
        bytes: documentBytes({ contractVersion: "SYNTHETIC-UNKNOWN-VERSION" }),
      },
      {
        id: "wrong-profile",
        reason: "invalid_profile",
        bytes: documentBytes({ profile: "SYNTHETIC-NOT-LAN-TEST" }),
      },
      {
        id: "production-mode",
        reason: "invalid_mode",
        bytes: documentBytes({ mode: "production" }),
      },
      {
        id: "weak-north-secret",
        reason: "invalid_secret",
        bytes: documentBytes({ northBearerToken: weakSecret }),
        additionalSecrets: [weakSecret],
      },
      {
        id: "overlong-identity-secret",
        reason: "invalid_secret",
        bytes: documentBytes({ identityTokenKey: overlongSecret }),
        additionalSecrets: [overlongSecret],
      },
      {
        id: "non-ascii-request-secret",
        reason: "invalid_secret",
        bytes: documentBytes({ requestStateHmacKey: nonAsciiSecret }),
        additionalSecrets: [nonAsciiSecret],
      },
      {
        id: "duplicate-north-and-identity",
        reason: "duplicate_secret",
        bytes: documentBytes({
          identityTokenKey: SYNTHETIC_SECRETS.northBearer,
        }),
      },
      {
        id: "duplicate-north-and-request-state",
        reason: "duplicate_secret",
        bytes: documentBytes({
          requestStateHmacKey: SYNTHETIC_SECRETS.northBearer,
        }),
      },
      {
        id: "duplicate-identity-and-request-state",
        reason: "duplicate_secret",
        bytes: documentBytes({
          requestStateHmacKey: SYNTHETIC_SECRETS.identityTokenKey,
        }),
      },
    ];

    for (const testCase of cases) {
      await captureRefusal(
        testCase.id,
        testCase.reason,
        { bytes: testCase.bytes },
        FILE_PATH,
        testCase.additionalSecrets,
      );
    }
  });

  it("keeps full secrets and distinguishing fragments out of every error observable", async () => {
    const nativeError = new Error(
      `native failure ${SYNTHETIC_SECRETS.northBearer}`,
      {
        cause: new Error(SYNTHETIC_SECRETS.identityTokenKey),
      },
    );
    const caught = await captureRefusal(
      "explicit-value-free-evidence",
      "file_unavailable",
      { openError: nativeError },
    );

    assertNoSyntheticSecretLeak("explicit-value-free-evidence", [
      caught,
      String(caught),
      caught.message,
      caught.stack,
      Object.getOwnPropertyDescriptors(caught),
      JSON.stringify(caught),
    ]);
  });

  it("sanitizes a forged typed error at the injectable filesystem boundary", async () => {
    const forged = Object.create(
      PreProductionCredentialFileError.prototype,
    ) as PreProductionCredentialFileError;
    Object.defineProperties(forged, {
      reason: { value: SYNTHETIC_SECRETS.northBearer },
      code: { value: SYNTHETIC_SECRETS.identityTokenKey },
      message: { value: SYNTHETIC_SECRETS.requestStateHmacKey },
    });

    await captureRefusal(
      "forged-typed-filesystem-error",
      "file_unavailable",
      { openError: forged },
      FILE_PATH,
    );
  });

  it.runIf(process.platform !== "win32")(
    "reads a real POSIX owner-read-only file as an additional smoke proof",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "revagent-m4-03-"));
      const filePath = join(root, "credentials.json");
      try {
        await writeFile(filePath, documentBytes(), { mode: 0o600 });
        await chmod(filePath, 0o400);
        const loaded = await loadPreProductionCredentialFile(filePath);
        expect(loaded.profile).toBe("lan_test");
        expect(loaded.mode).toBe("preproduction");
      } finally {
        await chmod(filePath, 0o600).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
