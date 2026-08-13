import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
  PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY,
  loadPreProductionCredentialFile,
  type PreProductionCredentialMaterial,
} from "./preProductionCredentialFile.js";

export const PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION =
  "generate_preproduction_credential_file" as const;

export const PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_COUNT = 3 as const;
export const PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES = 48 as const;
export const PRE_PRODUCTION_CREDENTIAL_GENERATOR_RELATIVE_PATH =
  "runtime/secrets/credentials.json" as const;
export const PRE_PRODUCTION_NORTH_BEARER_HANDOFF_RELATIVE_PATH =
  "runtime/handoff/north-bearer.bin" as const;

export const PRE_PRODUCTION_CREDENTIAL_GENERATOR_ERROR_REASONS = Object.freeze([
  "invalid_invocation",
  "production_mode_refused",
  "invalid_root",
  "unsupported_platform",
  "directory_unavailable",
  "directory_symlink_refused",
  "directory_not_directory",
  "directory_owner_mismatch",
  "directory_permissions_invalid",
  "directory_path_not_canonical",
  "random_source_failed",
  "invalid_random_material",
  "duplicate_random_material",
  "file_create_refused",
  "file_verification_refused",
  "file_write_refused",
  "file_sync_refused",
  "file_close_refused",
  "credential_validation_refused",
  "cleanup_failed",
] as const);

export type PreProductionCredentialGeneratorErrorReason =
  (typeof PRE_PRODUCTION_CREDENTIAL_GENERATOR_ERROR_REASONS)[number];

const SAFE_GENERATOR_REASONS: ReadonlySet<string> = new Set(
  PRE_PRODUCTION_CREDENTIAL_GENERATOR_ERROR_REASONS,
);

const DIRECTORY_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o400;

export class PreProductionCredentialGeneratorError extends Error {
  readonly code = "preproduction_credential_generation_refused" as const;

  constructor(readonly reason: PreProductionCredentialGeneratorErrorReason) {
    super(`pre-production credential generation refused: ${reason}`);
    this.name = "PreProductionCredentialGeneratorError";
    Object.freeze(this);
  }
}

export interface PreProductionCredentialGeneratorStat {
  readonly file: boolean;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
}

export interface PreProductionCredentialGeneratorHandle {
  stat(): Promise<PreProductionCredentialGeneratorStat>;
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PreProductionCredentialGeneratorIo {
  readonly platform: NodeJS.Platform;
  currentUid(): number | null;
  isAbsolute(filePath: string): boolean;
  resolve(filePath: string): string;
  join(...parts: readonly string[]): string;
  lstatOrNull(filePath: string): Promise<PreProductionCredentialGeneratorStat | null>;
  realpath(filePath: string): Promise<string>;
  open(
    filePath: string,
    flags: number,
    mode: number,
  ): Promise<PreProductionCredentialGeneratorHandle>;
  unlink(filePath: string): Promise<void>;
}

export interface PreProductionCredentialGeneratorDependencies {
  randomBytes(size: number): Uint8Array;
  load(filePath: string): Promise<PreProductionCredentialMaterial>;
}

export interface PreProductionCredentialGeneratorRuntime {
  readonly nodeEnv: string | undefined;
}

export interface PreProductionCredentialGeneratorOptions {
  readonly root: string;
  readonly profile: "lan_test";
  readonly mode: "preproduction";
}

export interface PreProductionCredentialGeneratorResult {
  readonly ok: true;
  readonly action: typeof PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION;
  readonly contractVersion: typeof PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION;
  readonly profile: "lan_test";
  readonly mode: "preproduction";
  readonly permissionPolicy: typeof PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY;
  readonly secretCount: typeof PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_COUNT;
  readonly secretBytesEach: typeof PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES;
  readonly credentialFileCreated: true;
  readonly northBearerHandoffCreated: true;
  readonly validated: true;
}

export interface PreProductionCredentialGeneratorWriter {
  write(value: string): void;
}

export interface PreProductionCredentialGeneratorProcessIo {
  readonly stdout: PreProductionCredentialGeneratorWriter;
  readonly stderr: PreProductionCredentialGeneratorWriter;
}

function snapshot(value: Stats): PreProductionCredentialGeneratorStat {
  return Object.freeze({
    file: value.isFile(),
    directory: value.isDirectory(),
    symbolicLink: value.isSymbolicLink(),
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    uid: value.uid,
    size: value.size,
  });
}

const NODE_IO: PreProductionCredentialGeneratorIo = Object.freeze({
  platform: process.platform,
  currentUid: () =>
    typeof process.getuid === "function" ? process.getuid() : null,
  isAbsolute,
  resolve,
  join: (...parts: readonly string[]) => join(...parts),
  lstatOrNull: async (filePath: string) => {
    try {
      return snapshot(await lstat(filePath));
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  },
  realpath,
  open: async (filePath: string, flags: number, mode: number) => {
    const handle = await open(filePath, flags, mode);
    return Object.freeze({
      stat: async () => snapshot(await handle.stat()),
      writeFile: async (bytes: Uint8Array) => handle.writeFile(bytes),
      sync: async () => handle.sync(),
      close: async () => handle.close(),
    });
  },
  unlink,
});

const DEFAULT_DEPENDENCIES: PreProductionCredentialGeneratorDependencies =
  Object.freeze({
    randomBytes: nodeRandomBytes,
    load: loadPreProductionCredentialFile,
  });

const PROCESS_RUNTIME: PreProductionCredentialGeneratorRuntime = Object.freeze({
  nodeEnv: process.env.NODE_ENV,
});

const PROCESS_IO: PreProductionCredentialGeneratorProcessIo = Object.freeze({
  stdout: Object.freeze({ write: (value: string) => process.stdout.write(value) }),
  stderr: Object.freeze({ write: (value: string) => process.stderr.write(value) }),
});

function refused(
  reason: PreProductionCredentialGeneratorErrorReason,
): never {
  throw new PreProductionCredentialGeneratorError(reason);
}

async function fixedFailure<T>(
  action: () => Promise<T>,
  reason: PreProductionCredentialGeneratorErrorReason,
): Promise<T> {
  try {
    return await action();
  } catch {
    return refused(reason);
  }
}

function validateDirectory(
  value: PreProductionCredentialGeneratorStat,
  currentUid: number,
): void {
  if (value.symbolicLink) refused("directory_symlink_refused");
  if (!value.directory || value.file) refused("directory_not_directory");
  if (value.uid !== currentUid) refused("directory_owner_mismatch");
  if ((value.mode & 0o7777) !== DIRECTORY_MODE) {
    refused("directory_permissions_invalid");
  }
}

async function validateCanonicalDirectory(
  filePath: string,
  currentUid: number,
  io: PreProductionCredentialGeneratorIo,
): Promise<void> {
  const stat = await fixedFailure(
    () => io.lstatOrNull(filePath),
    "directory_unavailable",
  );
  if (stat === null) refused("directory_unavailable");
  validateDirectory(stat, currentUid);
  const canonical = await fixedFailure(
    () => io.realpath(filePath),
    "directory_unavailable",
  );
  if (canonical !== filePath) refused("directory_path_not_canonical");
}

function validateCreatedFile(
  value: PreProductionCredentialGeneratorStat,
  currentUid: number,
  expectedSize: number,
): void {
  if (
    value.symbolicLink ||
    !value.file ||
    value.directory ||
    value.uid !== currentUid ||
    (value.mode & 0o7777) !== CREDENTIAL_FILE_MODE ||
    value.nlink !== 1 ||
    value.size !== expectedSize
  ) {
    refused("file_verification_refused");
  }
}

function sameIdentity(
  left: PreProductionCredentialGeneratorStat,
  right: PreProductionCredentialGeneratorStat,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function generatedSecret(
  dependencies: PreProductionCredentialGeneratorDependencies,
): string {
  let bytes: Uint8Array;
  try {
    bytes = dependencies.randomBytes(
      PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES,
    );
  } catch {
    return refused("random_source_failed");
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_BYTES
  ) {
    return refused("invalid_random_material");
  }
  return Buffer.from(bytes).toString("base64url");
}

function serializeCredentialDocument(secrets: readonly string[]): Uint8Array {
  const [northBearerToken, identityTokenKey, requestStateHmacKey] = secrets;
  if (
    northBearerToken === undefined ||
    identityTokenKey === undefined ||
    requestStateHmacKey === undefined
  ) {
    return refused("invalid_random_material");
  }
  return Buffer.from(
    `${JSON.stringify({
      contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      northBearerToken,
      identityTokenKey,
      requestStateHmacKey,
    })}\n`,
    "utf8",
  );
}

interface OwnedFile {
  readonly path: string;
  readonly identity: PreProductionCredentialGeneratorStat;
}

interface ValidatedDirectory {
  readonly path: string;
  readonly identity: PreProductionCredentialGeneratorStat;
}

interface CreationState {
  readonly ownedFiles: OwnedFile[];
  cleanupUncertain: boolean;
}

async function removeOwnedFile(
  owned: OwnedFile,
  io: PreProductionCredentialGeneratorIo,
): Promise<boolean> {
  try {
    const current = await io.lstatOrNull(owned.path);
    if (current === null) return true;
    if (
      current.symbolicLink ||
      !current.file ||
      current.directory ||
      current.nlink !== 1 ||
      !sameIdentity(owned.identity, current)
    ) {
      return false;
    }
    await io.unlink(owned.path);
    return (await io.lstatOrNull(owned.path)) === null;
  } catch {
    return false;
  }
}

function result(): PreProductionCredentialGeneratorResult {
  return Object.freeze({
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
}

async function createProtectedFile(
  filePath: string,
  body: Uint8Array,
  currentUid: number,
  io: PreProductionCredentialGeneratorIo,
  state: CreationState,
): Promise<void> {
  let handle: PreProductionCredentialGeneratorHandle | null = null;
  let handleAcquired = false;
  let owned: OwnedFile | null = null;
  let closed = false;
  let failure: unknown = null;
  try {
    handle = await fixedFailure(
      () =>
        io.open(
          filePath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          CREDENTIAL_FILE_MODE,
        ),
      "file_create_refused",
    );
    handleAcquired = true;
    const initial = await fixedFailure(
      () => handle!.stat(),
      "file_verification_refused",
    );
    if (initial.file && !initial.symbolicLink && !initial.directory) {
      owned = Object.freeze({ path: filePath, identity: initial });
      state.ownedFiles.push(owned);
    }
    validateCreatedFile(initial, currentUid, 0);

    await fixedFailure(() => handle!.writeFile(body), "file_write_refused");
    await fixedFailure(() => handle!.sync(), "file_sync_refused");
    const afterWrite = await fixedFailure(
      () => handle!.stat(),
      "file_verification_refused",
    );
    validateCreatedFile(afterWrite, currentUid, body.byteLength);
    if (!sameIdentity(initial, afterWrite)) {
      refused("file_verification_refused");
    }

    await fixedFailure(() => handle!.close(), "file_close_refused");
    closed = true;

    const closedPath = await fixedFailure(
      () => io.lstatOrNull(filePath),
      "file_verification_refused",
    );
    if (closedPath === null) refused("file_verification_refused");
    validateCreatedFile(closedPath, currentUid, body.byteLength);
    if (!sameIdentity(initial, closedPath)) {
      refused("file_verification_refused");
    }
    const canonicalPath = await fixedFailure(
      () => io.realpath(filePath),
      "file_verification_refused",
    );
    if (canonicalPath !== filePath) refused("file_verification_refused");
    return;
  } catch (error: unknown) {
    failure = error;
  }

  if (!closed && handle !== null) {
    try {
      await handle.close();
      closed = true;
    } catch {
      state.cleanupUncertain = true;
    }
  }
  if (handleAcquired && owned === null) {
    state.cleanupUncertain = true;
  }
  if (failure instanceof PreProductionCredentialGeneratorError) throw failure;
  return refused("file_verification_refused");
}

async function captureValidatedDirectory(
  path: string,
  currentUid: number,
  io: PreProductionCredentialGeneratorIo,
): Promise<ValidatedDirectory> {
  await validateCanonicalDirectory(path, currentUid, io);
  const identity = await fixedFailure(
    () => io.lstatOrNull(path),
    "directory_unavailable",
  );
  if (identity === null) refused("directory_unavailable");
  validateDirectory(identity, currentUid);
  return Object.freeze({ path, identity });
}

async function assertDirectoriesUnchanged(
  directories: readonly ValidatedDirectory[],
  currentUid: number,
  io: PreProductionCredentialGeneratorIo,
): Promise<void> {
  for (const directory of directories) {
    await validateCanonicalDirectory(directory.path, currentUid, io);
    const current = await fixedFailure(
      () => io.lstatOrNull(directory.path),
      "directory_unavailable",
    );
    if (current === null || !sameIdentity(directory.identity, current)) {
      refused("directory_unavailable");
    }
  }
}

async function assertOwnedFileCurrent(
  owned: OwnedFile,
  expectedSize: number,
  currentUid: number,
  io: PreProductionCredentialGeneratorIo,
): Promise<void> {
  const current = await fixedFailure(
    () => io.lstatOrNull(owned.path),
    "file_verification_refused",
  );
  if (current === null) refused("file_verification_refused");
  validateCreatedFile(current, currentUid, expectedSize);
  if (!sameIdentity(owned.identity, current)) {
    refused("file_verification_refused");
  }
  const canonical = await fixedFailure(
    () => io.realpath(owned.path),
    "file_verification_refused",
  );
  if (canonical !== owned.path) refused("file_verification_refused");
}

async function removeOwnedFiles(
  state: CreationState,
  io: PreProductionCredentialGeneratorIo,
): Promise<boolean> {
  let removed = !state.cleanupUncertain;
  for (const owned of [...state.ownedFiles].reverse()) {
    if (!(await removeOwnedFile(owned, io))) {
      removed = false;
    }
  }
  return removed;
}

/**
 * Creates one M4 LAN/test credential file and a distinct north-bearer handoff
 * endpoint. The caller must prepare the isolated root plus runtime/secrets and
 * runtime/handoff; this function refuses to widen permissions or create an
 * unverified ancestor. The separate handoff endpoint lets a transport cleanup
 * remove bounded source material without deleting Gateway credentials.
 */
export async function generatePreProductionCredentialFile(
  options: PreProductionCredentialGeneratorOptions,
  io: PreProductionCredentialGeneratorIo = NODE_IO,
  dependencies: PreProductionCredentialGeneratorDependencies =
    DEFAULT_DEPENDENCIES,
  runtime: PreProductionCredentialGeneratorRuntime = PROCESS_RUNTIME,
): Promise<PreProductionCredentialGeneratorResult> {
  if (options.profile !== "lan_test" || options.mode !== "preproduction") {
    refused("invalid_invocation");
  }
  if (runtime.nodeEnv?.trim().toLowerCase() === "production") {
    refused("production_mode_refused");
  }
  if (!io.isAbsolute(options.root) || io.resolve(options.root) !== options.root) {
    refused("invalid_root");
  }
  if (io.platform === "win32") refused("unsupported_platform");
  const currentUid = io.currentUid();
  if (
    currentUid === null ||
    !Number.isSafeInteger(currentUid) ||
    currentUid < 0
  ) {
    refused("unsupported_platform");
  }

  const runtimeRoot = io.join(options.root, "runtime");
  const secretsRoot = io.join(runtimeRoot, "secrets");
  const handoffRoot = io.join(runtimeRoot, "handoff");
  const credentialPath = io.join(secretsRoot, "credentials.json");
  const northBearerHandoffPath = io.join(handoffRoot, "north-bearer.bin");
  const directories: ValidatedDirectory[] = [];
  for (const directory of [
    options.root,
    runtimeRoot,
    secretsRoot,
    handoffRoot,
  ]) {
    directories.push(await captureValidatedDirectory(directory, currentUid, io));
  }

  const secrets = Object.freeze([
    generatedSecret(dependencies),
    generatedSecret(dependencies),
    generatedSecret(dependencies),
  ] as const);
  if (new Set(secrets).size !== PRE_PRODUCTION_CREDENTIAL_GENERATOR_SECRET_COUNT) {
    refused("duplicate_random_material");
  }
  const body = serializeCredentialDocument(secrets);
  const northBearerBody = Buffer.from(secrets[0], "ascii");
  const creationState: CreationState = {
    ownedFiles: [],
    cleanupUncertain: false,
  };
  let failure: unknown = null;
  try {
    await assertDirectoriesUnchanged(directories, currentUid, io);
    await createProtectedFile(
      credentialPath,
      body,
      currentUid,
      io,
      creationState,
    );

    const loaded = await fixedFailure(
      () => dependencies.load(credentialPath),
      "credential_validation_refused",
    );
    if (
      loaded.contractVersion !==
        PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION ||
      loaded.profile !== "lan_test" ||
      loaded.mode !== "preproduction" ||
      loaded.northAuthorization !== `Bearer ${secrets[0]}` ||
      loaded.identityTokenKey !== secrets[1] ||
      loaded.requestStateHmacKey !== secrets[2]
    ) {
      refused("credential_validation_refused");
    }

    await assertDirectoriesUnchanged(directories, currentUid, io);
    await createProtectedFile(
      northBearerHandoffPath,
      northBearerBody,
      currentUid,
      io,
      creationState,
    );
    await assertDirectoriesUnchanged(directories, currentUid, io);
    const credentialOwned = creationState.ownedFiles.find(
      (value) => value.path === credentialPath,
    );
    const handoffOwned = creationState.ownedFiles.find(
      (value) => value.path === northBearerHandoffPath,
    );
    if (credentialOwned === undefined || handoffOwned === undefined) {
      refused("file_verification_refused");
    }
    await assertOwnedFileCurrent(
      credentialOwned,
      body.byteLength,
      currentUid,
      io,
    );
    await assertOwnedFileCurrent(
      handoffOwned,
      northBearerBody.byteLength,
      currentUid,
      io,
    );
    return result();
  } catch (error: unknown) {
    failure = error;
  }
  if (!(await removeOwnedFiles(creationState, io))) refused("cleanup_failed");
  if (failure instanceof PreProductionCredentialGeneratorError) throw failure;
  return refused("file_verification_refused");
}

interface GeneratorInvocation {
  readonly root: string;
  readonly profile: "lan_test";
  readonly mode: "preproduction";
}

function parseInvocation(argv: readonly string[]): GeneratorInvocation | null {
  if (argv.length !== 6) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      value.length === 0 ||
      !["--root", "--profile", "--mode"].includes(name) ||
      values.has(name)
    ) {
      return null;
    }
    values.set(name, value);
  }
  const root = values.get("--root");
  if (
    root === undefined ||
    values.get("--profile") !== "lan_test" ||
    values.get("--mode") !== "preproduction"
  ) {
    return null;
  }
  return Object.freeze({
    root,
    profile: "lan_test" as const,
    mode: "preproduction" as const,
  });
}

function writeLine(
  writer: PreProductionCredentialGeneratorWriter,
  value: object,
): void {
  writer.write(`${JSON.stringify(value)}\n`);
}

function writeRefusal(
  io: PreProductionCredentialGeneratorProcessIo,
  code: string,
  reason: string,
  exitCode: number,
): number {
  writeLine(io.stderr, {
    ok: false,
    action: PRE_PRODUCTION_CREDENTIAL_GENERATOR_ACTION,
    code,
    reason,
  });
  return exitCode;
}

/** One-shot, listenerless CLI boundary with a fixed value-free output shape. */
export async function runPreProductionCredentialGenerator(
  argv: readonly string[],
  processIo: PreProductionCredentialGeneratorProcessIo = PROCESS_IO,
  io: PreProductionCredentialGeneratorIo = NODE_IO,
  dependencies: PreProductionCredentialGeneratorDependencies =
    DEFAULT_DEPENDENCIES,
  runtime: PreProductionCredentialGeneratorRuntime = PROCESS_RUNTIME,
): Promise<number> {
  const invocation = parseInvocation(argv);
  if (invocation === null) {
    return writeRefusal(processIo, "invalid_invocation", "invalid_invocation", 64);
  }
  try {
    const generated = await generatePreProductionCredentialFile(
      invocation,
      io,
      dependencies,
      runtime,
    );
    writeLine(processIo.stdout, generated);
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof PreProductionCredentialGeneratorError &&
      SAFE_GENERATOR_REASONS.has(error.reason)
    ) {
      const exitCode = error.reason === "cleanup_failed" ? 1 : 78;
      const code =
        error.reason === "cleanup_failed"
          ? "credential_generation_failed"
          : "preproduction_credential_generation_refused";
      return writeRefusal(processIo, code, error.reason, exitCode);
    }
    return writeRefusal(processIo, "credential_generation_failed", "internal_error", 1);
  }
}
