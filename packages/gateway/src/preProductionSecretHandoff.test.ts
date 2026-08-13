import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
  PRE_PRODUCTION_SECRET_HANDOFF_FRAME_MAGIC,
  runPreProductionSecretHandoffSource,
  type PreProductionSecretHandoffKind,
  type PreProductionSecretHandoffSourceIo,
  type PreProductionSecretHandoffSourceStat,
} from "./preProductionSecretHandoff.js";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const GENERATION_ROOT = "/home/bt/m4-handoff/attempt-01";
const ROOT = `${GENERATION_ROOT}/runtime/handoff`;
const NORTH_PATH = `${ROOT}/north-bearer.bin`;
const ENROLLMENT_PATH = `${ROOT}/enrollment.json`;
const NORTH_SECRET = `SYNTHETIC-NORTH-BEARER-${"N".repeat(48)}`;
const NORTH_BYTES = new TextEncoder().encode(NORTH_SECRET);
const FRAME_MAGIC_BYTES = new TextEncoder().encode(
  PRE_PRODUCTION_SECRET_HANDOFF_FRAME_MAGIC,
);
const ENROLLMENT_SECRET = `SYNTHETIC-ENROLLMENT-${"E".repeat(64)}`;
const ENROLLMENT_TEXT = JSON.stringify({
  enrollmentToken: ENROLLMENT_SECRET,
});
const ENROLLMENT_BYTES = new TextEncoder().encode(ENROLLMENT_TEXT);

interface HarnessOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number | null;
  readonly rootInitial?: PreProductionSecretHandoffSourceStat;
  readonly rootAfter?: PreProductionSecretHandoffSourceStat;
  readonly rootCanonical?: string;
  readonly sourceInitial?: PreProductionSecretHandoffSourceStat;
  readonly sourceBefore?: PreProductionSecretHandoffSourceStat;
  readonly sourceAfter?: PreProductionSecretHandoffSourceStat;
  readonly sourceCanonicalBefore?: string;
  readonly sourceCanonicalAfter?: string;
  readonly sourceBytes?: Uint8Array;
  readonly fail?:
    | "root_lstat"
    | "root_realpath"
    | "source_lstat"
    | "source_realpath_before"
    | "source_realpath_after"
    | "source_open"
    | "source_stat_before"
    | "source_read"
    | "source_stat_after"
    | "source_close"
    | "source_unlink"
    | "source_absence_check"
    | "source_residue"
    | "stdout";
}

interface Harness {
  readonly io: PreProductionSecretHandoffSourceIo;
  readonly stdout: Buffer[];
  readonly stderr: string[];
  readonly calls: {
    readonly lstat: string[];
    readonly realpath: string[];
    readonly open: Array<readonly [string, number]>;
    readonly unlink: string[];
    readonly pathExists: string[];
  };
}

function rootStat(
  overrides: Partial<PreProductionSecretHandoffSourceStat> = {},
): PreProductionSecretHandoffSourceStat {
  return Object.freeze({
    file: false,
    directory: true,
    symbolicLink: false,
    dev: 11,
    ino: 101,
    mode: 0o40700,
    nlink: 3,
    uid: 1_000,
    size: 4_096,
    mtimeMs: 10,
    ctimeMs: 10,
    ...overrides,
  });
}

function sourceStat(
  overrides: Partial<PreProductionSecretHandoffSourceStat> = {},
): PreProductionSecretHandoffSourceStat {
  return Object.freeze({
    file: true,
    directory: false,
    symbolicLink: false,
    dev: 11,
    ino: 202,
    mode: 0o100400,
    nlink: 1,
    uid: 1_000,
    size: ENROLLMENT_BYTES.byteLength,
    mtimeMs: 20,
    ctimeMs: 20,
    ...overrides,
  });
}

function harness(options: HarnessOptions = {}): Harness {
  const stdout: Buffer[] = [];
  const stderr: string[] = [];
  const calls = {
    lstat: [] as string[],
    realpath: [] as string[],
    open: [] as Array<readonly [string, number]>,
    unlink: [] as string[],
    pathExists: [] as string[],
  };
  let rootLstatCount = 0;
  let sourceRealpathCount = 0;
  let handleStatCount = 0;

  const io: PreProductionSecretHandoffSourceIo = Object.freeze({
    platform: options.platform ?? "linux",
    stdout: Object.freeze({
      async write(value: Uint8Array): Promise<void> {
        if (options.fail === "stdout") {
          throw new Error(`write failed near ${NORTH_SECRET}`);
        }
        stdout.push(Buffer.from(value));
      },
    }),
    stderr: Object.freeze({
      write(value: string): void {
        stderr.push(value);
      },
    }),
    currentUid: () => (options.uid === undefined ? 1_000 : options.uid),
    async lstat(
      filePath: string,
    ): Promise<PreProductionSecretHandoffSourceStat> {
      calls.lstat.push(filePath);
      if (filePath === ROOT) {
        if (options.fail === "root_lstat") {
          throw new Error(`root failed near ${NORTH_SECRET}`);
        }
        rootLstatCount += 1;
        return rootLstatCount === 1
          ? (options.rootInitial ?? rootStat())
          : (options.rootAfter ?? options.rootInitial ?? rootStat());
      }
      if (options.fail === "source_lstat") {
        throw new Error(`source failed near ${ENROLLMENT_TEXT}`);
      }
      return options.sourceInitial ?? sourceStat();
    },
    async realpath(filePath: string): Promise<string> {
      calls.realpath.push(filePath);
      if (filePath === ROOT) {
        if (options.fail === "root_realpath") {
          throw new Error(`root failed near ${NORTH_SECRET}`);
        }
        return options.rootCanonical ?? ROOT;
      }
      sourceRealpathCount += 1;
      if (
        (sourceRealpathCount === 1 &&
          options.fail === "source_realpath_before") ||
        (sourceRealpathCount === 2 && options.fail === "source_realpath_after")
      ) {
        throw new Error(`realpath failed near ${ENROLLMENT_TEXT}`);
      }
      return sourceRealpathCount === 1
        ? (options.sourceCanonicalBefore ?? filePath)
        : (options.sourceCanonicalAfter ?? filePath);
    },
    async open(filePath: string, flags: number) {
      calls.open.push([filePath, flags] as const);
      if (options.fail === "source_open") {
        throw new Error(`open failed near ${ENROLLMENT_TEXT}`);
      }
      return Object.freeze({
        async stat(): Promise<PreProductionSecretHandoffSourceStat> {
          handleStatCount += 1;
          if (
            (handleStatCount === 1 && options.fail === "source_stat_before") ||
            (handleStatCount === 2 && options.fail === "source_stat_after")
          ) {
            throw new Error(`stat failed near ${ENROLLMENT_TEXT}`);
          }
          return handleStatCount === 1
            ? (options.sourceBefore ?? options.sourceInitial ?? sourceStat())
            : (options.sourceAfter ??
                options.sourceBefore ??
                options.sourceInitial ??
                sourceStat());
        },
        async readFile(): Promise<Uint8Array> {
          if (options.fail === "source_read") {
            throw new Error(`read failed near ${ENROLLMENT_TEXT}`);
          }
          return new Uint8Array(options.sourceBytes ?? ENROLLMENT_BYTES);
        },
        async close(): Promise<void> {
          if (options.fail === "source_close") {
            throw new Error(`close failed near ${ENROLLMENT_TEXT}`);
          }
        },
      });
    },
    async unlink(filePath: string): Promise<void> {
      calls.unlink.push(filePath);
      if (options.fail === "source_unlink") {
        throw new Error(`unlink failed near ${NORTH_SECRET}`);
      }
    },
    async pathExists(filePath: string): Promise<boolean> {
      calls.pathExists.push(filePath);
      if (options.fail === "source_absence_check") {
        throw new Error(`absence check failed near ${ENROLLMENT_TEXT}`);
      }
      return options.fail === "source_residue";
    },
  });
  return { io, stdout, stderr, calls };
}

function northHarness(options: HarnessOptions = {}): Harness {
  return harness({
    sourceBytes: NORTH_BYTES,
    sourceInitial: sourceStat({ size: NORTH_BYTES.byteLength }),
    ...options,
  });
}

function argv(
  kind: PreProductionSecretHandoffKind,
  root = ROOT,
): readonly string[] {
  return Object.freeze([
    "--contract",
    PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
    "--kind",
    kind,
    "--root",
    root,
  ]);
}

function probeArgv(
  kind: PreProductionSecretHandoffKind,
  root = ROOT,
): readonly string[] {
  return Object.freeze([...argv(kind, root), "--probe-absent", "true"]);
}

function assertNoSecretFragments(
  output: readonly string[],
  secrets: readonly string[],
): void {
  const serialized = output.join("");
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    for (let index = 0; index <= secret.length - 10; index += 1) {
      expect(serialized).not.toContain(secret.slice(index, index + 10));
    }
  }
}

function expectRefusal(
  result: number,
  output: Harness,
  reason: string,
  exitCode = 78,
): void {
  expect(result).toBe(exitCode);
  expect(output.stdout).toEqual([]);
  expect(output.stderr).toHaveLength(1);
  expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
    ok: false,
    action: "source_preproduction_secret_handoff",
    contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
    code: "preproduction_secret_handoff_source_refused",
    reason,
  });
  assertNoSecretFragments(output.stderr, [NORTH_SECRET, ENROLLMENT_SECRET]);
}

function expectSingleFrame(output: Harness, payload: Uint8Array): void {
  expect(output.stdout).toHaveLength(1);
  const frame = output.stdout[0];
  expect(Buffer.isBuffer(frame)).toBe(true);
  expect(
    Array.from(frame?.slice(0, FRAME_MAGIC_BYTES.byteLength) ?? []),
  ).toEqual(Array.from(FRAME_MAGIC_BYTES));
  expect(frame?.readUInt32BE(FRAME_MAGIC_BYTES.byteLength)).toBe(
    payload.byteLength,
  );
  expect(Array.from(frame?.slice(FRAME_MAGIC_BYTES.byteLength + 4) ?? [])).toEqual(
    Array.from(payload),
  );
}

function expectProbeUncertain(
  result: number,
  output: Harness,
  kind: PreProductionSecretHandoffKind,
): void {
  expect(result).toBe(79);
  expect(output.stdout).toEqual([]);
  expect(output.stderr).toHaveLength(1);
  expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
    ok: false,
    action: "probe_preproduction_secret_handoff_source_absence",
    contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
    kind,
    code: "cleanup_uncertain",
    reason: "cleanup_uncertain",
  });
  assertNoSecretFragments(output.stderr, [NORTH_SECRET, ENROLLMENT_SECRET]);
}

describe("pre-production secret handoff source", () => {
  it.each([
    ["north_bearer", NORTH_PATH],
    ["enrollment_artifact", ENROLLMENT_PATH],
  ] as const)(
    "positively proves the closed %s source endpoint absent without reading or mutating it",
    async (kind, expectedPath) => {
      const output = harness();

      const result = await runPreProductionSecretHandoffSource(
        probeArgv(kind),
        output.io,
        { nodeEnv: "preproduction" },
      );

      expect(result).toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.stdout).toHaveLength(1);
      expect(Buffer.isBuffer(output.stdout[0])).toBe(true);
      expect(new TextDecoder().decode(output.stdout[0])).toBe(
        `${JSON.stringify({
          ok: true,
          action: "probe_preproduction_secret_handoff_source_absence",
          contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
          kind,
          sourceAbsent: true,
        })}\n`,
      );
      expect(output.calls.pathExists).toEqual([expectedPath]);
      expect(output.calls.open).toEqual([]);
      expect(output.calls.unlink).toEqual([]);
      expect(output.calls.lstat).toEqual([ROOT, ROOT]);
      expect(output.calls.realpath).toEqual([ROOT, ROOT]);
    },
  );

  it.each([
    {
      id: "present endpoint",
      options: { fail: "source_residue" as const },
    },
    {
      id: "unavailable absence check",
      options: { fail: "source_absence_check" as const },
    },
    {
      id: "root identity change",
      options: { rootAfter: rootStat({ ino: 102 }) },
    },
    {
      id: "metadata stdout failure",
      options: { fail: "stdout" as const },
    },
  ])(
    "returns only fixed cleanup_uncertain metadata for $id",
    async ({ options }) => {
      const output = harness(options);

      const result = await runPreProductionSecretHandoffSource(
        probeArgv("enrollment_artifact"),
        output.io,
        { nodeEnv: "preproduction" },
      );

      expectProbeUncertain(result, output, "enrollment_artifact");
      expect(output.calls.open).toEqual([]);
      expect(output.calls.unlink).toEqual([]);
    },
  );

  it("emits only the north bearer bytes from the fixed hardened handoff endpoint", async () => {
    const output = northHarness();

    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer"),
      output.io,
      { nodeEnv: "preproduction" },
    );

    expect(result).toBe(0);
    expectSingleFrame(output, NORTH_BYTES);
    expect(output.stderr).toEqual([]);
    expect(output.calls.open).toEqual([
      [NORTH_PATH, constants.O_RDONLY | constants.O_NOFOLLOW],
    ]);
    expect(output.calls.lstat).toEqual([ROOT, NORTH_PATH, NORTH_PATH, ROOT]);
    expect(output.calls.realpath).toEqual([
      ROOT,
      NORTH_PATH,
      NORTH_PATH,
      NORTH_PATH,
      ROOT,
    ]);
    expect(output.calls.unlink).toEqual([NORTH_PATH]);
    expect(output.calls.pathExists).toEqual([NORTH_PATH]);
  });

  it("emits the exact enrollment bytes only after no-follow handle validation and close", async () => {
    const output = harness();

    const result = await runPreProductionSecretHandoffSource(
      argv("enrollment_artifact"),
      output.io,
      { nodeEnv: "preproduction" },
    );

    expect(result).toBe(0);
    expectSingleFrame(output, ENROLLMENT_BYTES);
    expect(output.stderr).toEqual([]);
    expect(output.calls.open).toEqual([
      [ENROLLMENT_PATH, constants.O_RDONLY | constants.O_NOFOLLOW],
    ]);
    expect(output.calls.lstat).toEqual([
      ROOT,
      ENROLLMENT_PATH,
      ENROLLMENT_PATH,
      ROOT,
    ]);
    expect(output.calls.realpath).toEqual([
      ROOT,
      ENROLLMENT_PATH,
      ENROLLMENT_PATH,
      ENROLLMENT_PATH,
      ROOT,
    ]);
    expect(output.calls.unlink).toEqual([ENROLLMENT_PATH]);
    expect(output.calls.pathExists).toEqual([ENROLLMENT_PATH]);
  });

  it.each([
    {
      id: "missing arguments",
      args: ["--kind", "north_bearer"],
      reason: "invalid_invocation",
    },
    {
      id: "unknown option",
      args: [
        "--contract",
        PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
        "--kind",
        "north_bearer",
        "--path",
        ROOT,
      ],
      reason: "invalid_invocation",
    },
    {
      id: "wrong contract",
      args: [
        "--contract",
        "revagent.m4-secret-handoff/v2",
        "--kind",
        "north_bearer",
        "--root",
        ROOT,
      ],
      reason: "unsupported_contract_version",
    },
    {
      id: "open secret class",
      args: [
        "--contract",
        PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
        "--kind",
        "arbitrary_file",
        "--root",
        ROOT,
      ],
      reason: "invalid_kind",
    },
    {
      id: "non-true absence probe",
      args: [
        "--contract",
        PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
        "--kind",
        "north_bearer",
        "--root",
        ROOT,
        "--probe-absent",
        "false",
      ],
      reason: "invalid_invocation",
    },
  ])("refuses $id without touching a source", async ({ args, reason }) => {
    const output = harness();
    const result = await runPreProductionSecretHandoffSource(args, output.io, {
      nodeEnv: "preproduction",
    });
    expectRefusal(result, output, reason, 64);
    expect(output.calls.lstat).toEqual([]);
  });

  it.each([
    {
      id: "relative root",
      root: "relative/root",
      options: {},
      reason: "invalid_root",
    },
    {
      id: "Windows runtime",
      root: ROOT,
      options: { platform: "win32" as const },
      reason: "unsupported_platform",
    },
    {
      id: "missing uid",
      root: ROOT,
      options: { uid: null },
      reason: "unsupported_platform",
    },
    {
      id: "root symlink",
      root: ROOT,
      options: { rootInitial: rootStat({ symbolicLink: true }) },
      reason: "root_symlink_refused",
    },
    {
      id: "root non-directory",
      root: ROOT,
      options: { rootInitial: rootStat({ directory: false, file: true }) },
      reason: "root_not_directory",
    },
    {
      id: "root foreign owner",
      root: ROOT,
      options: { rootInitial: rootStat({ uid: 1_001 }) },
      reason: "root_owner_mismatch",
    },
    {
      id: "root loose mode",
      root: ROOT,
      options: { rootInitial: rootStat({ mode: 0o40750 }) },
      reason: "root_invalid_permissions",
    },
    {
      id: "root alias",
      root: ROOT,
      options: { rootCanonical: `${ROOT}-real` },
      reason: "root_not_canonical",
    },
    {
      id: "root changed",
      root: ROOT,
      options: { rootAfter: rootStat({ ino: 102 }) },
      reason: "root_changed_during_read",
    },
  ])("fails closed for $id", async ({ root, options, reason }) => {
    const output = northHarness(options);
    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer", root),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(result, output, reason);
  });

  it("refuses production mode before reading the root", async () => {
    const output = northHarness();
    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer"),
      output.io,
      { nodeEnv: "production" },
    );
    expectRefusal(result, output, "production_mode_refused");
    expect(output.calls.lstat).toEqual([]);
  });

  it.each([
    {
      id: "symlink",
      options: { sourceInitial: sourceStat({ symbolicLink: true }) },
      reason: "source_symlink_refused",
    },
    {
      id: "non-file",
      options: { sourceInitial: sourceStat({ file: false, directory: true }) },
      reason: "source_not_regular_file",
    },
    {
      id: "foreign owner",
      options: { sourceInitial: sourceStat({ uid: 1_001 }) },
      reason: "source_owner_mismatch",
    },
    {
      id: "loose mode",
      options: { sourceInitial: sourceStat({ mode: 0o100440 }) },
      reason: "source_invalid_permissions",
    },
    {
      id: "hard link",
      options: { sourceInitial: sourceStat({ nlink: 2 }) },
      reason: "source_invalid_link_count",
    },
    {
      id: "empty file",
      options: { sourceInitial: sourceStat({ size: 0 }) },
      reason: "source_invalid_size",
    },
    {
      id: "oversize file",
      options: { sourceInitial: sourceStat({ size: 4_097 }) },
      reason: "source_invalid_size",
    },
    {
      id: "path alias",
      options: { sourceCanonicalBefore: `${ENROLLMENT_PATH}-real` },
      reason: "source_not_canonical",
    },
    {
      id: "changed before read",
      options: { sourceBefore: sourceStat({ ino: 203 }) },
      reason: "source_changed_during_read",
    },
    {
      id: "changed after read",
      options: { sourceAfter: sourceStat({ mtimeMs: 21 }) },
      reason: "source_changed_during_read",
    },
    {
      id: "short read",
      options: {
        sourceBytes: ENROLLMENT_BYTES.slice(0, ENROLLMENT_BYTES.length - 1),
      },
      reason: "source_changed_during_read",
    },
  ])("refuses enrollment source $id", async ({ options, reason }) => {
    const output = harness(options);
    const result = await runPreProductionSecretHandoffSource(
      argv("enrollment_artifact"),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(result, output, reason);
  });

  it.each([
    "root_lstat",
    "root_realpath",
    "source_lstat",
    "source_realpath_before",
    "source_realpath_after",
    "source_open",
    "source_stat_before",
    "source_read",
    "source_stat_after",
    "source_close",
    "source_unlink",
    "source_absence_check",
    "source_residue",
  ] as const)("keeps diagnostics value-free when %s fails", async (fail) => {
    const output = harness({ fail });
    const result = await runPreProductionSecretHandoffSource(
      argv("enrollment_artifact"),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(
      result,
      output,
      fail.startsWith("root_")
        ? "root_unavailable"
        : fail === "source_unlink" ||
            fail === "source_absence_check" ||
            fail === "source_residue"
          ? "source_cleanup_failed"
          : "source_unavailable",
    );
    if (fail === "source_read" || fail === "source_close") {
      expect(output.calls.unlink).toEqual([ENROLLMENT_PATH]);
      expect(output.calls.pathExists).toEqual([ENROLLMENT_PATH]);
    }
    expect([
      ...output.calls.lstat,
      ...output.calls.realpath,
      ...output.calls.unlink,
    ]).not.toContain(`${ROOT}/runtime/secrets/credentials.json`);
  });

  it("refuses a north endpoint containing non-visible token bytes", async () => {
    const invalidBytes = new TextEncoder().encode(`${NORTH_SECRET}\n`);
    const output = northHarness({
      sourceBytes: invalidBytes,
      sourceInitial: sourceStat({ size: invalidBytes.byteLength }),
    });
    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer"),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(result, output, "source_material_invalid");
  });

  it("refuses a north endpoint shorter than the closed lower bound", async () => {
    const shortBytes = new TextEncoder().encode("SYNTHETIC-NORTH-SHORT");
    const output = northHarness({
      sourceBytes: shortBytes,
      sourceInitial: sourceStat({ size: shortBytes.byteLength }),
    });
    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer"),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(result, output, "source_invalid_size");
  });

  it("keeps write failure diagnostics fixed and value-free", async () => {
    const output = northHarness({ fail: "stdout" });
    const result = await runPreProductionSecretHandoffSource(
      argv("north_bearer"),
      output.io,
      { nodeEnv: "preproduction" },
    );
    expectRefusal(result, output, "handoff_write_failed", 1);
  });

  it("sanitizes a forged source error reason before writing diagnostics", async () => {
    const output = harness();
    const forgedReason = `SYNTHETIC-FORGED-${ENROLLMENT_SECRET}`;
    const forged = Object.create(Error.prototype) as Error & { reason: string };
    Object.defineProperties(forged, {
      name: { value: "PreProductionSecretHandoffSourceError" },
      reason: { value: forgedReason },
    });
    const maliciousIo: PreProductionSecretHandoffSourceIo = Object.freeze({
      ...output.io,
      currentUid: () => {
        throw forged;
      },
    });

    const result = await runPreProductionSecretHandoffSource(
      argv("enrollment_artifact"),
      maliciousIo,
      { nodeEnv: "preproduction" },
    );

    expectRefusal(result, output, "internal_error", 1);
    expect(output.stderr.join("\n")).not.toContain("SYNTHETIC-FORGED");
    assertNoSecretFragments(output.stderr, [ENROLLMENT_SECRET]);
  });

  it("keeps the source main isolated from server and composition imports", async () => {
    const source = await readFile(
      join(SOURCE_DIRECTORY, "preProductionSecretHandoffSourceMain.ts"),
      "utf8",
    );
    expect(source).toContain("runPreProductionSecretHandoffSource");
    expect(source).toContain("process.argv.slice(2)");
    expect(source).not.toContain("preProductionServing");
    expect(source).not.toContain("credentials.json");
    expect(source).not.toContain("server.js");
    expect(source).not.toContain("index.js");
  });
});
