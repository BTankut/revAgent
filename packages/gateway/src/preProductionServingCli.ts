import { constants } from "node:fs";
import { open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  preparePreProductionServing,
  type PreparedPreProductionServing,
  type PreProductionServingOptions,
  PreProductionServingError,
} from "./preProductionServing.js";
import {
  loadPreProductionTlsMaterial,
  PreProductionTlsMaterialError,
} from "./preProductionTlsMaterial.js";
import type { GatewayServerHandle } from "./server.js";

export const PRE_PRODUCTION_ENROLLMENT_ARTIFACT_VERSION =
  "revagent.m4-enrollment-artifact/v1" as const;

const MAX_REGISTRY_SEED_BYTES = 16 * 1024 * 1024;

export interface PreProductionServingLaunch {
  readonly prepared: PreparedPreProductionServing;
  readonly server: GatewayServerHandle;
  readonly enrollmentOutputPath: string;
  cleanup(): Promise<void>;
}

export type PreProductionServingCliErrorReason =
  | "invalid_invocation"
  | "production_mode_refused"
  | "invalid_environment"
  | "enrollment_artifact_cleanup_failed";

export class PreProductionServingCliError extends Error {
  readonly code = "preproduction_serving_cli_refused" as const;

  constructor(readonly reason: PreProductionServingCliErrorReason) {
    super(`pre-production serving CLI refused: ${reason}`);
    this.name = "PreProductionServingCliError";
  }
}

interface Invocation {
  readonly credentialFilePath: string;
  readonly registrySeedFilePath: string;
  readonly tlsKeyFilePath: string;
  readonly tlsCertificateFilePath: string;
  readonly enrollmentOutputPath: string;
  readonly principal: PreProductionServingOptions["principal"];
  readonly device: PreProductionServingOptions["device"];
}

export interface PreProductionServingCliDependencies {
  prepare: typeof preparePreProductionServing;
  loadTls: typeof loadPreProductionTlsMaterial;
  readRegistrySeed(filePath: string): Promise<unknown>;
  writeEnrollmentArtifact(
    filePath: string,
    enrollment: PreparedPreProductionServing["enrollment"],
  ): Promise<void>;
  removeEnrollmentArtifact(filePath: string): Promise<void>;
}

export type PreProductionPostLaunchAction = (
  launch: PreProductionServingLaunch,
) => void | Promise<void>;

const ARGUMENT_NAMES = Object.freeze([
  "--credential-file",
  "--registry-seed-file",
  "--tls-key-file",
  "--tls-cert-file",
  "--enrollment-output-file",
  "--profile",
  "--mode",
  "--tenant-id",
  "--user-id",
  "--role",
  "--gateway-session-id",
  "--oauth-client-id",
  "--enrollment-id",
  "--device-id",
  "--seat-id",
  "--machine-fingerprint",
  "--session-capabilities",
] as const);

async function defaultReadRegistrySeed(filePath: string): Promise<unknown> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    throw new Error("invalid_path");
  }
  const canonical = await realpath(filePath);
  if (canonical !== filePath) throw new Error("path_not_canonical");
  const bytes = await readFile(filePath);
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_REGISTRY_SEED_BYTES) {
    throw new Error("invalid_size");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function defaultWriteEnrollmentArtifact(
  filePath: string,
  enrollment: PreparedPreProductionServing["enrollment"],
): Promise<void> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    throw new Error("invalid_path");
  }
  const body = Buffer.from(
    `${JSON.stringify({
      contractVersion: PRE_PRODUCTION_ENROLLMENT_ARTIFACT_VERSION,
      enrollmentToken: enrollment.enrollmentToken,
      expiresAtMs: enrollment.expiresAtMs,
    })}\n`,
    "utf8",
  );
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  let complete = false;
  try {
    await handle.writeFile(body);
    await handle.sync();
    const stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      uid === null ||
      stat.uid !== uid ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o400 ||
      stat.size !== body.byteLength
    ) {
      throw new Error("artifact_verification_failed");
    }
    complete = true;
  } finally {
    let closeFailed = false;
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
    if (!complete || closeFailed) {
      try {
        await rm(filePath, { force: true, maxRetries: 0 });
      } catch {
        throw new PreProductionServingCliError(
          "enrollment_artifact_cleanup_failed",
        );
      }
    }
    if (closeFailed) throw new Error("artifact_close_failed");
  }
}

const DEFAULT_DEPENDENCIES: PreProductionServingCliDependencies = Object.freeze({
  prepare: preparePreProductionServing,
  loadTls: loadPreProductionTlsMaterial,
  readRegistrySeed: defaultReadRegistrySeed,
  writeEnrollmentArtifact: defaultWriteEnrollmentArtifact,
  removeEnrollmentArtifact: async (filePath: string) =>
    rm(filePath, { force: true, maxRetries: 0 }),
});

function parseInvocation(argv: readonly string[]): Invocation | null {
  if (argv.length !== ARGUMENT_NAMES.length * 2) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      value.length === 0 ||
      !(ARGUMENT_NAMES as readonly string[]).includes(name) ||
      values.has(name)
    ) {
      return null;
    }
    values.set(name, value);
  }
  const get = (name: (typeof ARGUMENT_NAMES)[number]): string =>
    values.get(name) ?? "";
  if (
    get("--profile") !== "lan_test" ||
    get("--mode") !== "preproduction" ||
    get("--role") !== "user"
  ) {
    return null;
  }
  const capabilities = get("--session-capabilities")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    return null;
  }
  return Object.freeze({
    credentialFilePath: get("--credential-file"),
    registrySeedFilePath: get("--registry-seed-file"),
    tlsKeyFilePath: get("--tls-key-file"),
    tlsCertificateFilePath: get("--tls-cert-file"),
    enrollmentOutputPath: get("--enrollment-output-file"),
    principal: Object.freeze({
      tenantId: get("--tenant-id"),
      userId: get("--user-id"),
      role: "user" as const,
      sessionId: get("--gateway-session-id"),
      oauthClientId: get("--oauth-client-id"),
    }),
    device: Object.freeze({
      enrollmentId: get("--enrollment-id"),
      deviceId: get("--device-id"),
      seatId: get("--seat-id"),
      machineFingerprint: get("--machine-fingerprint"),
      grantedSessionCapabilities: Object.freeze(capabilities),
    }),
  });
}

/** Launches only after exact pre-production arguments and value-free setup. */
export async function launchPreProductionServing(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  dependencies: PreProductionServingCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreProductionServingLaunch> {
  const invocation = parseInvocation(argv);
  if (invocation === null) {
    throw new PreProductionServingCliError("invalid_invocation");
  }
  if (environment.NODE_ENV !== "preproduction") {
    throw new PreProductionServingCliError(
      environment.NODE_ENV === "production"
        ? "production_mode_refused"
        : "invalid_environment",
    );
  }

  const seed = await dependencies.readRegistrySeed(
    invocation.registrySeedFilePath,
  );
  const prepared = await dependencies.prepare({
    profile: "lan_test",
    mode: "preproduction",
    environment,
    credentialFilePath: invocation.credentialFilePath,
    registrySeed: seed,
    principal: invocation.principal,
    device: invocation.device,
  });
  const tls = await dependencies.loadTls({
    keyFilePath: invocation.tlsKeyFilePath,
    certificateFilePath: invocation.tlsCertificateFilePath,
  });

  let artifactWritten = false;
  let server: GatewayServerHandle | null = null;
  try {
    await dependencies.writeEnrollmentArtifact(
      invocation.enrollmentOutputPath,
      prepared.enrollment,
    );
    artifactWritten = true;
    server = await prepared.start(tls);
  } catch (error) {
    if (artifactWritten) {
      try {
        await dependencies.removeEnrollmentArtifact(
          invocation.enrollmentOutputPath,
        );
      } catch {
        throw new PreProductionServingCliError(
          "enrollment_artifact_cleanup_failed",
        );
      }
    }
    throw error;
  }

  let shutdownBegun = false;
  let serverClosed = false;
  let artifactRemoved = false;
  return Object.freeze({
    prepared,
    server,
    enrollmentOutputPath: invocation.enrollmentOutputPath,
    async cleanup(): Promise<void> {
      if (serverClosed && artifactRemoved) return;
      let primaryError: unknown;
      if (!shutdownBegun) {
        shutdownBegun = true;
        try {
          server.beginShutdown();
        } catch (error) {
          primaryError = error;
        }
      }
      if (!serverClosed) {
        try {
          await server.close();
          serverClosed = true;
        } catch (error) {
          primaryError = error;
        }
      }
      if (!artifactRemoved) {
        try {
          await dependencies.removeEnrollmentArtifact(
            invocation.enrollmentOutputPath,
          );
          artifactRemoved = true;
        } catch (error) {
          primaryError ??= error;
        }
      }
      if (primaryError !== undefined) throw primaryError;
    },
  });
}

/**
 * Transfers cleanup ownership before any signal registration, logging, or
 * other post-launch action can fail. A post-launch exception therefore cannot
 * strand the raw enrollment artifact.
 */
export async function launchPreProductionServingOwned(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  afterLaunch: PreProductionPostLaunchAction,
  dependencies: PreProductionServingCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreProductionServingLaunch> {
  const launch = await launchPreProductionServing(
    argv,
    environment,
    dependencies,
  );
  try {
    await afterLaunch(launch);
    return launch;
  } catch (error) {
    try {
      await launch.cleanup();
    } catch {
      throw new PreProductionServingCliError(
        "enrollment_artifact_cleanup_failed",
      );
    }
    throw error;
  }
}

const SAFE_CLI_REASONS: ReadonlySet<string> = new Set([
  "invalid_invocation",
  "production_mode_refused",
  "invalid_environment",
  "enrollment_artifact_cleanup_failed",
]);

const SAFE_SERVING_REASONS: ReadonlySet<string> = new Set([
  "invalid_invocation",
  "production_mode_refused",
  "invalid_gateway_configuration",
  "invalid_registry_seed",
  "runtime_adapter_unavailable",
  "enrollment_issue_refused",
]);

const SAFE_TLS_REASONS: ReadonlySet<string> = new Set([
  "invalid_path",
  "unsupported_platform",
  "file_unavailable",
  "symlink_refused",
  "not_regular_file",
  "path_not_canonical",
  "owner_mismatch",
  "invalid_permissions",
  "invalid_link_count",
  "invalid_size",
  "changed_during_read",
  "duplicate_file",
]);

/** Reduces startup failures to a closed, value-free vocabulary. */
export function safePreProductionStartupReason(error: unknown): string {
  if (
    error instanceof PreProductionServingCliError &&
    error.code === "preproduction_serving_cli_refused" &&
    SAFE_CLI_REASONS.has(error.reason)
  ) {
    return error.reason;
  }
  if (
    error instanceof PreProductionServingError &&
    error.code === "preproduction_serving_refused" &&
    SAFE_SERVING_REASONS.has(error.reason)
  ) {
    return error.reason;
  }
  if (
    error instanceof PreProductionTlsMaterialError &&
    error.code === "preproduction_tls_material_refused" &&
    SAFE_TLS_REASONS.has(error.reason)
  ) {
    return error.reason;
  }
  return "internal_error";
}
