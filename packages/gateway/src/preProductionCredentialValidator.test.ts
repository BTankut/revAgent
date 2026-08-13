import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
  PreProductionCredentialFileError,
  loadPreProductionCredentialFile,
  type PreProductionCredentialFileIo,
  type PreProductionCredentialFileStat,
  type PreProductionCredentialMaterial,
} from "./preProductionCredentialFile.js";
import {
  runPreProductionCredentialValidator,
  type PreProductionCredentialValidatorDependencies,
  type PreProductionCredentialValidatorIo,
  type PreProductionCredentialValidatorRuntime,
} from "./preProductionCredentialValidator.js";

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

const FILE_PATH = "/run/revagent-m4/SYNTHETIC-NORTH-HEAD-credential-file.json";
const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_RUNTIME: PreProductionCredentialValidatorRuntime = Object.freeze({
  nodeEnv: "test",
});
const VALID_ARGS = Object.freeze([
  "--file",
  FILE_PATH,
  "--profile",
  "lan_test",
  "--mode",
  "preproduction",
]);

const VALID_MATERIAL: PreProductionCredentialMaterial = Object.freeze({
  contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  profile: "lan_test",
  mode: "preproduction",
  northAuthorization: `Bearer ${SYNTHETIC_SECRETS.northBearer}`,
  identityTokenKey: SYNTHETIC_SECRETS.identityTokenKey,
  requestStateHmacKey: SYNTHETIC_SECRETS.requestStateHmacKey,
});

interface CapturedIo {
  readonly io: PreProductionCredentialValidatorIo;
  readonly stdout: string[];
  readonly stderr: string[];
}

function capturedIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: Object.freeze({
      stdout: Object.freeze({ write: (value: string) => stdout.push(value) }),
      stderr: Object.freeze({ write: (value: string) => stderr.push(value) }),
    }),
  };
}

function dependencies(
  load: PreProductionCredentialValidatorDependencies["load"],
): PreProductionCredentialValidatorDependencies {
  return Object.freeze({ load });
}

function assertNoSyntheticSecretLeak(
  caseId: string,
  values: readonly unknown[],
): void {
  const visible = values
    .map((value) =>
      typeof value === "string"
        ? value
        : inspect(value, {
            depth: null,
            showHidden: true,
            getters: false,
            customInspect: false,
          }),
    )
    .join("\n");
  for (
    let index = 0;
    index < Object.values(SYNTHETIC_SECRETS).length;
    index += 1
  ) {
    if (visible.includes(Object.values(SYNTHETIC_SECRETS)[index] ?? "")) {
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

let ambientOutputCalls: unknown[][] = [];

beforeEach(() => {
  ambientOutputCalls = [];
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    ambientOutputCalls.push(["process.stdout", value]);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    ambientOutputCalls.push(["process.stderr", value]);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    ambientOutputCalls.push(["console.log", ...values]);
  });
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    ambientOutputCalls.push(["console.info", ...values]);
  });
  vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    ambientOutputCalls.push(["console.warn", ...values]);
  });
  vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    ambientOutputCalls.push(["console.error", ...values]);
  });
  vi.spyOn(console, "debug").mockImplementation((...values: unknown[]) => {
    ambientOutputCalls.push(["console.debug", ...values]);
  });
});

afterEach(() => {
  assertNoSyntheticSecretLeak("ambient-output-surface", ambientOutputCalls);
  expect(ambientOutputCalls).toEqual([]);
  vi.restoreAllMocks();
});

describe("M4-03 one-shot credential validator", () => {
  it("emits one allowlisted evidence line without opening a listener", async () => {
    const output = capturedIo();
    const load = vi.fn(async () => VALID_MATERIAL);
    const listen = vi.spyOn(Server.prototype, "listen");

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(load),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(0);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(FILE_PATH);
    expect(listen).not.toHaveBeenCalled();
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      ok: true,
      action: "validate_preproduction_credential_file",
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      permissionPolicy: PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
      northCredentialCount: 1,
    });
    assertNoSyntheticSecretLeak("validator-success", [
      output.stdout,
      output.stderr,
    ]);
  });

  it("refuses an ambient production runtime before reading a file", async () => {
    const output = capturedIo();
    const load = vi.fn(async () => VALID_MATERIAL);
    const listen = vi.spyOn(Server.prototype, "listen");

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(load),
      { nodeEnv: " Production " },
    );

    expect(exitCode).toBe(78);
    expect(load).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      `${JSON.stringify({
        ok: false,
        action: "validate_preproduction_credential_file",
        code: "preproduction_credential_file_refused",
        reason: "production_mode_refused",
      })}\n`,
    ]);
    assertNoSyntheticSecretLeak("ambient-production-refusal", [
      output.stdout,
      output.stderr,
    ]);
  });

  it("rejects malformed, defaulted, wrong-profile, and production invocations before reading", async () => {
    const cases: readonly {
      readonly id: string;
      readonly args: readonly string[];
      readonly reason: string;
    }[] = [
      { id: "empty", args: [], reason: "invalid_invocation" },
      {
        id: "missing-mode",
        args: ["--file", FILE_PATH, "--profile", "lan_test"],
        reason: "invalid_invocation",
      },
      {
        id: "unknown-argument",
        args: [
          "--file",
          FILE_PATH,
          "--profile",
          "lan_test",
          "--unknown",
          "SYNTHETIC-STATE-HEAD",
        ],
        reason: "invalid_invocation",
      },
      {
        id: "duplicate-file",
        args: [
          "--file",
          FILE_PATH,
          "--file",
          FILE_PATH,
          "--mode",
          "preproduction",
        ],
        reason: "invalid_invocation",
      },
      {
        id: "wrong-profile",
        args: [
          "--file",
          FILE_PATH,
          "--profile",
          "SYNTHETIC-NORTH-HEAD",
          "--mode",
          "preproduction",
        ],
        reason: "invalid_profile",
      },
      {
        id: "production-mode",
        args: [
          "--file",
          FILE_PATH,
          "--profile",
          "lan_test",
          "--mode",
          "production",
        ],
        reason: "invalid_mode",
      },
    ];

    for (const testCase of cases) {
      const output = capturedIo();
      const load = vi.fn(async () => VALID_MATERIAL);
      const listen = vi.spyOn(Server.prototype, "listen");
      const exitCode = await runPreProductionCredentialValidator(
        testCase.args,
        output.io,
        dependencies(load),
        TEST_RUNTIME,
      );

      expect(exitCode).toBe(64);
      expect(load).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toHaveLength(1);
      expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
        ok: false,
        action: "validate_preproduction_credential_file",
        code: "invalid_invocation",
        reason: testCase.reason,
      });
      assertNoSyntheticSecretLeak(testCase.id, [output.stdout, output.stderr]);
      listen.mockRestore();
    }
  });

  it("projects credential refusals without exception, path, or secret values", async () => {
    const output = capturedIo();
    const error = new PreProductionCredentialFileError("duplicate_secret");
    const load = vi.fn(async () => Promise.reject(error));
    const listen = vi.spyOn(Server.prototype, "listen");

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(load),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(78);
    expect(listen).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: "validate_preproduction_credential_file",
      code: "preproduction_credential_file_refused",
      reason: "duplicate_secret",
    });
    assertNoSyntheticSecretLeak("credential-refusal", [
      error,
      error.stack,
      output.stdout,
      output.stderr,
    ]);
  });

  it("sanitizes an unexpected secret-bearing exception and cause", async () => {
    const output = capturedIo();
    const nativeError = new Error(
      `unexpected ${SYNTHETIC_SECRETS.northBearer}`,
      { cause: new Error(SYNTHETIC_SECRETS.identityTokenKey) },
    );
    const load = vi.fn(async () => Promise.reject(nativeError));
    const listen = vi.spyOn(Server.prototype, "listen");

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(load),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(1);
    expect(listen).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: "validate_preproduction_credential_file",
      code: "validator_failed",
      reason: "internal_error",
    });
    assertNoSyntheticSecretLeak("unexpected-exception", [
      output.stdout,
      output.stderr,
      ambientOutputCalls,
    ]);
  });

  it("keeps the success projection closed if a loader returns the wrong contract", async () => {
    const output = capturedIo();
    const wrong = {
      ...VALID_MATERIAL,
      contractVersion: "SYNTHETIC-UNSUPPORTED-CONTRACT",
    } as unknown as PreProductionCredentialMaterial;

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(async () => wrong),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(78);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: "validate_preproduction_credential_file",
      code: "preproduction_credential_file_refused",
      reason: "invalid_loaded_contract",
    });
    assertNoSyntheticSecretLeak("wrong-loaded-contract", [
      output.stdout,
      output.stderr,
    ]);
  });

  it("sanitizes a forged typed refusal whose reason is not allowlisted", async () => {
    const output = capturedIo();
    const forged = Object.create(
      PreProductionCredentialFileError.prototype,
    ) as PreProductionCredentialFileError;
    Object.defineProperties(forged, {
      reason: { value: SYNTHETIC_SECRETS.northBearer },
      code: { value: SYNTHETIC_SECRETS.identityTokenKey },
      message: { value: SYNTHETIC_SECRETS.requestStateHmacKey },
    });

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies(async () => Promise.reject(forged)),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: "validate_preproduction_credential_file",
      code: "validator_failed",
      reason: "internal_error",
    });
    assertNoSyntheticSecretLeak("forged-typed-refusal", [
      output.stdout,
      output.stderr,
    ]);
  });

  it("keeps a real loader refusal value-free through the validator boundary", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
        profile: "lan_test",
        mode: "preproduction",
        northBearerToken: SYNTHETIC_SECRETS.northBearer,
        identityTokenKey: SYNTHETIC_SECRETS.identityTokenKey,
        requestStateHmacKey: SYNTHETIC_SECRETS.requestStateHmacKey,
        unexpected: SYNTHETIC_SECRETS.northBearer,
      }),
    );
    const stat: PreProductionCredentialFileStat = Object.freeze({
      file: true,
      symbolicLink: false,
      dev: 11,
      ino: 17,
      mode: 0o100400,
      nlink: 1,
      uid: 1_000,
      size: bytes.byteLength,
      mtimeMs: 100,
      ctimeMs: 100,
    });
    const credentialIo: PreProductionCredentialFileIo = Object.freeze({
      platform: "linux",
      currentUid: () => 1_000,
      isAbsolute: (filePath: string) => filePath === FILE_PATH,
      resolve: (filePath: string) => filePath,
      lstat: async () => stat,
      realpath: async (filePath: string) => filePath,
      open: async () =>
        Object.freeze({
          stat: async () => stat,
          readFile: async () => bytes,
          close: async () => undefined,
        }),
    });
    const output = capturedIo();
    const listen = vi.spyOn(Server.prototype, "listen");

    const exitCode = await runPreProductionCredentialValidator(
      VALID_ARGS,
      output.io,
      dependencies((filePath) =>
        loadPreProductionCredentialFile(filePath, credentialIo),
      ),
      TEST_RUNTIME,
    );

    expect(exitCode).toBe(78);
    expect(listen).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toEqual({
      ok: false,
      action: "validate_preproduction_credential_file",
      code: "preproduction_credential_file_refused",
      reason: "unknown_field",
    });
    assertNoSyntheticSecretLeak("real-loader-validator-refusal", [
      output.stdout,
      output.stderr,
      ambientOutputCalls,
    ]);
  });

  it("executes the real one-shot main with an isolated import graph and exact exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "revagent-m4-03-main-"));
    const outputFile = join(root, "validator-main.mjs");
    try {
      const buildResult = await build({
        entryPoints: [
          join(SOURCE_DIRECTORY, "preProductionCredentialValidatorMain.ts"),
        ],
        outfile: outputFile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        logLevel: "silent",
        metafile: true,
      });
      const forbiddenInputs = new Set([
        "server.ts",
        "main.ts",
        "store.ts",
        "index.ts",
        "preproductioncomposition.ts",
      ]);
      expect(
        Object.keys(buildResult.metafile.inputs)
          .map((input) => basename(input).toLowerCase())
          .filter((input) => forbiddenInputs.has(input)),
      ).toEqual([]);

      const invalid = spawnSync(process.execPath, [outputFile], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      });
      expect(invalid.status).toBe(64);
      expect(invalid.signal).toBeNull();
      expect(invalid.error).toBeUndefined();
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toBe(
        `${JSON.stringify({
          ok: false,
          action: "validate_preproduction_credential_file",
          code: "invalid_invocation",
          reason: "invalid_invocation",
        })}\n`,
      );

      const production = spawnSync(
        process.execPath,
        [outputFile, ...VALID_ARGS],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      expect(production.status).toBe(78);
      expect(production.signal).toBeNull();
      expect(production.error).toBeUndefined();
      expect(production.stdout).toBe("");
      expect(production.stderr).toBe(
        `${JSON.stringify({
          ok: false,
          action: "validate_preproduction_credential_file",
          code: "preproduction_credential_file_refused",
          reason: "production_mode_refused",
        })}\n`,
      );
      assertNoSyntheticSecretLeak("real-one-shot-main", [
        invalid.stdout,
        invalid.stderr,
        production.stdout,
        production.stderr,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
