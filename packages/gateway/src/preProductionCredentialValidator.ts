import {
  PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_REASONS,
  PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
  PreProductionCredentialFileError,
  loadPreProductionCredentialFile,
  type PreProductionCredentialMaterial,
} from "./preProductionCredentialFile.js";

const ACTION = "validate_preproduction_credential_file" as const;

const SAFE_CREDENTIAL_REFUSAL_REASONS: ReadonlySet<string> = new Set(
  PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_REASONS,
);

export interface PreProductionCredentialValidatorWriter {
  write(value: string): void;
}

export interface PreProductionCredentialValidatorIo {
  readonly stdout: PreProductionCredentialValidatorWriter;
  readonly stderr: PreProductionCredentialValidatorWriter;
}

export interface PreProductionCredentialValidatorDependencies {
  load(filePath: string): Promise<PreProductionCredentialMaterial>;
}

export interface PreProductionCredentialValidatorRuntime {
  readonly nodeEnv: string | undefined;
}

interface ValidatorInvocation {
  readonly filePath: string;
  readonly profile: string;
  readonly mode: string;
}

const PROCESS_IO: PreProductionCredentialValidatorIo = Object.freeze({
  stdout: Object.freeze({
    write: (value: string) => {
      process.stdout.write(value);
    },
  }),
  stderr: Object.freeze({
    write: (value: string) => {
      process.stderr.write(value);
    },
  }),
});

const DEFAULT_DEPENDENCIES: PreProductionCredentialValidatorDependencies =
  Object.freeze({ load: loadPreProductionCredentialFile });

const PROCESS_RUNTIME: PreProductionCredentialValidatorRuntime = Object.freeze({
  nodeEnv: process.env.NODE_ENV,
});

function writeLine(
  writer: PreProductionCredentialValidatorWriter,
  value: Readonly<Record<string, unknown>>,
): void {
  writer.write(`${JSON.stringify(value)}\n`);
}

function parseInvocation(argv: readonly string[]): ValidatorInvocation | null {
  if (argv.length !== 6) {
    return null;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      value.length === 0 ||
      !["--file", "--profile", "--mode"].includes(name) ||
      values.has(name)
    ) {
      return null;
    }
    values.set(name, value);
  }
  const filePath = values.get("--file");
  const profile = values.get("--profile");
  const mode = values.get("--mode");
  return filePath === undefined || profile === undefined || mode === undefined
    ? null
    : Object.freeze({ filePath, profile, mode });
}

function refusal(
  io: PreProductionCredentialValidatorIo,
  code: string,
  reason: string,
  exitCode: number,
): number {
  writeLine(io.stderr, {
    ok: false,
    action: ACTION,
    code,
    reason,
  });
  return exitCode;
}

/** Runs exactly once, emits one value-free line, and never creates ingress. */
export async function runPreProductionCredentialValidator(
  argv: readonly string[],
  io: PreProductionCredentialValidatorIo = PROCESS_IO,
  dependencies: PreProductionCredentialValidatorDependencies = DEFAULT_DEPENDENCIES,
  runtime: PreProductionCredentialValidatorRuntime = PROCESS_RUNTIME,
): Promise<number> {
  const invocation = parseInvocation(argv);
  if (invocation === null) {
    return refusal(io, "invalid_invocation", "invalid_invocation", 64);
  }
  if (invocation.profile !== "lan_test") {
    return refusal(io, "invalid_invocation", "invalid_profile", 64);
  }
  if (invocation.mode !== "preproduction") {
    return refusal(io, "invalid_invocation", "invalid_mode", 64);
  }
  if (runtime.nodeEnv?.trim().toLowerCase() === "production") {
    return refusal(
      io,
      "preproduction_credential_file_refused",
      "production_mode_refused",
      78,
    );
  }

  try {
    const loaded = await dependencies.load(invocation.filePath);
    if (
      loaded.contractVersion !==
        PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION ||
      loaded.profile !== "lan_test" ||
      loaded.mode !== "preproduction"
    ) {
      return refusal(
        io,
        "preproduction_credential_file_refused",
        "invalid_loaded_contract",
        78,
      );
    }
    writeLine(io.stdout, {
      ok: true,
      action: ACTION,
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      permissionPolicy: PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
      northCredentialCount: 1,
    });
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof PreProductionCredentialFileError &&
      SAFE_CREDENTIAL_REFUSAL_REASONS.has(error.reason)
    ) {
      return refusal(
        io,
        "preproduction_credential_file_refused",
        error.reason,
        78,
      );
    }
    return refusal(io, "validator_failed", "internal_error", 1);
  }
}
