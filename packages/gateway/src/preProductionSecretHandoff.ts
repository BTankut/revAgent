import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { posix } from "node:path";

export const PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION =
  "revagent.m4-secret-handoff/v1" as const;
export const PRE_PRODUCTION_SECRET_HANDOFF_FRAME_MAGIC =
  "REVAGENT-M4-HANDOFF-V1\n" as const;
const FRAME_MAGIC_BYTES = Buffer.from(
  PRE_PRODUCTION_SECRET_HANDOFF_FRAME_MAGIC,
  "ascii",
);

export const PRE_PRODUCTION_SECRET_HANDOFF_KINDS = Object.freeze([
  "north_bearer",
  "enrollment_artifact",
] as const);

export type PreProductionSecretHandoffKind =
  (typeof PRE_PRODUCTION_SECRET_HANDOFF_KINDS)[number];

export const PRE_PRODUCTION_SECRET_HANDOFF_SOURCE_PATHS = Object.freeze({
  north_bearer: Object.freeze(["north-bearer.bin"] as const),
  enrollment_artifact: Object.freeze(["enrollment.json"] as const),
} satisfies Readonly<
  Record<PreProductionSecretHandoffKind, readonly string[]>
>);

const ACTION = "source_preproduction_secret_handoff" as const;
const PROBE_ABSENCE_ACTION =
  "probe_preproduction_secret_handoff_source_absence" as const;
const MAX_ROOT_PATH_LENGTH = 4_096;
const MIN_NORTH_BEARER_BYTES = 32;
const MAX_ENROLLMENT_ARTIFACT_BYTES = 4_096;

export const PRE_PRODUCTION_SECRET_HANDOFF_SOURCE_ERROR_REASONS = Object.freeze(
  [
    "invalid_invocation",
    "unsupported_contract_version",
    "invalid_kind",
    "invalid_root",
    "unsupported_platform",
    "production_mode_refused",
    "root_unavailable",
    "root_symlink_refused",
    "root_not_directory",
    "root_owner_mismatch",
    "root_invalid_permissions",
    "root_not_canonical",
    "root_changed_during_read",
    "source_unavailable",
    "source_symlink_refused",
    "source_not_regular_file",
    "source_owner_mismatch",
    "source_invalid_permissions",
    "source_invalid_link_count",
    "source_invalid_size",
    "source_not_canonical",
    "source_changed_during_read",
    "source_material_invalid",
    "source_cleanup_failed",
    "handoff_write_failed",
    "internal_error",
  ] as const,
);

export type PreProductionSecretHandoffSourceErrorReason =
  (typeof PRE_PRODUCTION_SECRET_HANDOFF_SOURCE_ERROR_REASONS)[number];

const SAFE_SOURCE_REASONS: ReadonlySet<string> = new Set(
  PRE_PRODUCTION_SECRET_HANDOFF_SOURCE_ERROR_REASONS,
);

export class PreProductionSecretHandoffSourceError extends Error {
  readonly code = "preproduction_secret_handoff_source_refused" as const;

  constructor(readonly reason: PreProductionSecretHandoffSourceErrorReason) {
    super("pre-production secret handoff source refused");
    this.name = "PreProductionSecretHandoffSourceError";
    Object.freeze(this);
  }
}

export interface PreProductionSecretHandoffSourceStat {
  readonly file: boolean;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PreProductionSecretHandoffSourceHandle {
  stat(): Promise<PreProductionSecretHandoffSourceStat>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PreProductionSecretHandoffSourceWriter {
  write(value: Uint8Array): Promise<void>;
}

export interface PreProductionSecretHandoffSourceErrorWriter {
  write(value: string): void;
}

/** Injectable so every POSIX-only refusal stays testable on Windows CI. */
export interface PreProductionSecretHandoffSourceIo {
  readonly platform: NodeJS.Platform;
  readonly stdout: PreProductionSecretHandoffSourceWriter;
  readonly stderr: PreProductionSecretHandoffSourceErrorWriter;
  currentUid(): number | null;
  lstat(filePath: string): Promise<PreProductionSecretHandoffSourceStat>;
  realpath(filePath: string): Promise<string>;
  open(
    filePath: string,
    flags: number,
  ): Promise<PreProductionSecretHandoffSourceHandle>;
  unlink(filePath: string): Promise<void>;
  pathExists(filePath: string): Promise<boolean>;
}

export interface PreProductionSecretHandoffSourceRuntime {
  readonly nodeEnv: string | undefined;
}

interface SourceInvocation {
  readonly kind: PreProductionSecretHandoffKind;
  readonly root: string;
  readonly probeAbsent: boolean;
}

interface ValidatedRoot {
  readonly path: string;
  readonly uid: number;
  readonly initial: PreProductionSecretHandoffSourceStat;
}

function snapshot(value: Stats): PreProductionSecretHandoffSourceStat {
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
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

const PROCESS_IO: PreProductionSecretHandoffSourceIo = Object.freeze({
  platform: process.platform,
  stdout: Object.freeze({
    write: async (value: Uint8Array): Promise<void> =>
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(value, (error: Error | null | undefined) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  }),
  stderr: Object.freeze({
    write: (value: string): void => {
      process.stderr.write(value);
    },
  }),
  currentUid: () =>
    typeof process.getuid === "function" ? process.getuid() : null,
  lstat: async (filePath: string) => snapshot(await lstat(filePath)),
  realpath,
  open: async (filePath: string, flags: number) => {
    const handle = await open(filePath, flags);
    return Object.freeze({
      stat: async () => snapshot(await handle.stat()),
      readFile: async () => handle.readFile(),
      close: async () => handle.close(),
    });
  },
  unlink,
  pathExists: async (filePath: string) => {
    try {
      await lstat(filePath);
      return true;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  },
});

const PROCESS_RUNTIME: PreProductionSecretHandoffSourceRuntime = Object.freeze({
  nodeEnv: process.env.NODE_ENV,
});

function refused(reason: PreProductionSecretHandoffSourceErrorReason): never {
  throw new PreProductionSecretHandoffSourceError(reason);
}

async function safeIoCall<T>(
  action: () => Promise<T>,
  reason: PreProductionSecretHandoffSourceErrorReason,
): Promise<T> {
  try {
    return await action();
  } catch {
    return refused(reason);
  }
}

function sameState(
  left: PreProductionSecretHandoffSourceStat,
  right: PreProductionSecretHandoffSourceStat,
): boolean {
  return (
    left.file === right.file &&
    left.directory === right.directory &&
    left.symbolicLink === right.symbolicLink &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

// Identity-stable root fields only, for the post-read root recheck.
//
// The source's own authorised unlink of the allowlisted leaf necessarily
// advances the root directory's mtimeMs and ctimeMs, so those two cannot take
// part in a comparison that runs after the read. Comparing them made the recheck
// impossible to pass: the source consumed the secret and then refused to emit
// it, on every invocation.
//
// nlink IS compared. Measured on ext4: a directory's link count is unchanged by
// a file unlink but increments when a subdirectory is created, so including it
// costs nothing and detects a foreign subdirectory appearing in the handoff root
// during the read.
//
// size is NOT compared. This was a deliberate call, not an oversight -- please
// do not "restore" it. The production handoff root is a host bind mount, so the
// operative filesystem is the host's ext4, which is what was measured: there a
// directory's size is stable across a file unlink, because directory blocks are
// never reclaimed. Excluding it is a portability margin for tmpfs and overlayfs,
// where directory-size semantics differ and were not measured. It also carries
// no detection value here: identity is covered by dev+ino, protection by
// mode+uid, foreign-subdirectory injection by nlink, and canonicality by
// realpath plus validateRootStat.
//
// sameState stays strict and is deliberately not reused here: its other call
// sites compare the leaf, including the swap detection immediately before the
// unlink, and relaxing those would be a security regression.
function sameRootIdentity(
  left: PreProductionSecretHandoffSourceStat,
  right: PreProductionSecretHandoffSourceStat,
): boolean {
  return (
    left.file === right.file &&
    left.directory === right.directory &&
    left.symbolicLink === right.symbolicLink &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink
  );
}

function validateRootStat(
  value: PreProductionSecretHandoffSourceStat,
  uid: number,
): void {
  if (value.symbolicLink) {
    refused("root_symlink_refused");
  }
  if (!value.directory) {
    refused("root_not_directory");
  }
  if (value.uid !== uid) {
    refused("root_owner_mismatch");
  }
  if ((value.mode & 0o7777) !== 0o700) {
    refused("root_invalid_permissions");
  }
}

async function validateRoot(
  root: string,
  io: PreProductionSecretHandoffSourceIo,
): Promise<ValidatedRoot> {
  if (
    root.length === 0 ||
    root.length > MAX_ROOT_PATH_LENGTH ||
    root.includes("\0") ||
    !posix.isAbsolute(root) ||
    posix.resolve(root) !== root
  ) {
    refused("invalid_root");
  }
  if (io.platform === "win32") {
    refused("unsupported_platform");
  }
  const uid = io.currentUid();
  if (uid === null || !Number.isSafeInteger(uid) || uid < 0) {
    refused("unsupported_platform");
  }

  const initial = await safeIoCall(() => io.lstat(root), "root_unavailable");
  validateRootStat(initial, uid);
  const canonical = await safeIoCall(
    () => io.realpath(root),
    "root_unavailable",
  );
  if (canonical !== root) {
    refused("root_not_canonical");
  }
  return Object.freeze({ path: root, uid, initial });
}

async function assertRootUnchanged(
  root: ValidatedRoot,
  io: PreProductionSecretHandoffSourceIo,
): Promise<void> {
  const current = await safeIoCall(
    () => io.lstat(root.path),
    "root_unavailable",
  );
  validateRootStat(current, root.uid);
  const canonical = await safeIoCall(
    () => io.realpath(root.path),
    "root_unavailable",
  );
  if (canonical !== root.path) {
    refused("root_not_canonical");
  }
  if (!sameRootIdentity(root.initial, current)) {
    refused("root_changed_during_read");
  }
}

function validateSourceStat(
  value: PreProductionSecretHandoffSourceStat,
  uid: number,
  kind: PreProductionSecretHandoffKind,
): void {
  if (value.symbolicLink) {
    refused("source_symlink_refused");
  }
  if (!value.file) {
    refused("source_not_regular_file");
  }
  if (value.uid !== uid) {
    refused("source_owner_mismatch");
  }
  if ((value.mode & 0o7777) !== 0o400) {
    refused("source_invalid_permissions");
  }
  if (value.nlink !== 1) {
    refused("source_invalid_link_count");
  }
  if (
    !Number.isSafeInteger(value.size) ||
    value.size < (kind === "north_bearer" ? MIN_NORTH_BEARER_BYTES : 1) ||
    value.size > MAX_ENROLLMENT_ARTIFACT_BYTES
  ) {
    refused("source_invalid_size");
  }
}

function validateSourceMaterial(
  bytes: Uint8Array,
  kind: PreProductionSecretHandoffKind,
): void {
  if (
    kind === "north_bearer" &&
    ![...bytes].every((value) => value >= 0x21 && value <= 0x7e)
  ) {
    refused("source_material_invalid");
  }
}

async function readSourceBytes(
  filePath: string,
  root: ValidatedRoot,
  io: PreProductionSecretHandoffSourceIo,
  kind: PreProductionSecretHandoffKind,
): Promise<Uint8Array> {
  const initial = await safeIoCall(
    () => io.lstat(filePath),
    "source_unavailable",
  );
  validateSourceStat(initial, root.uid, kind);
  const canonicalBefore = await safeIoCall(
    () => io.realpath(filePath),
    "source_unavailable",
  );
  if (canonicalBefore !== filePath) {
    refused("source_not_canonical");
  }

  let handle: PreProductionSecretHandoffSourceHandle | null = null;
  let bytes: Uint8Array | null = null;
  let failure: unknown = null;
  try {
    const openedHandle = await safeIoCall(
      () => io.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW),
      "source_unavailable",
    );
    handle = openedHandle;
    const beforeRead = await safeIoCall(
      () => openedHandle.stat(),
      "source_unavailable",
    );
    validateSourceStat(beforeRead, root.uid, kind);
    if (!sameState(initial, beforeRead)) {
      refused("source_changed_during_read");
    }

    bytes = await safeIoCall(
      () => openedHandle.readFile(),
      "source_unavailable",
    );
    const afterRead = await safeIoCall(
      () => openedHandle.stat(),
      "source_unavailable",
    );
    validateSourceStat(afterRead, root.uid, kind);
    if (
      !sameState(beforeRead, afterRead) ||
      bytes.byteLength !== afterRead.size
    ) {
      refused("source_changed_during_read");
    }
    const canonicalAfter = await safeIoCall(
      () => io.realpath(filePath),
      "source_unavailable",
    );
    if (canonicalAfter !== filePath) {
      refused("source_not_canonical");
    }
  } catch (error: unknown) {
    failure =
      error instanceof PreProductionSecretHandoffSourceError
        ? error
        : new PreProductionSecretHandoffSourceError("source_unavailable");
  }

  if (handle !== null) {
    try {
      await handle.close();
    } catch {
      failure ??= new PreProductionSecretHandoffSourceError(
        "source_unavailable",
      );
    }
  }

  try {
    const cleanupState = await io.lstat(filePath);
    validateSourceStat(cleanupState, root.uid, kind);
    if (!sameState(initial, cleanupState)) {
      refused("source_cleanup_failed");
    }
    const cleanupCanonical = await io.realpath(filePath);
    if (cleanupCanonical !== filePath) {
      refused("source_cleanup_failed");
    }
    await io.unlink(filePath);
    if (await io.pathExists(filePath)) {
      refused("source_cleanup_failed");
    }
  } catch {
    failure = new PreProductionSecretHandoffSourceError(
      "source_cleanup_failed",
    );
  }

  if (failure !== null) {
    throw failure;
  }
  if (bytes === null) {
    return refused("source_unavailable");
  }
  validateSourceMaterial(bytes, kind);
  return bytes;
}

function sourcePath(
  root: string,
  kind: PreProductionSecretHandoffKind,
): string {
  return posix.join(root, ...PRE_PRODUCTION_SECRET_HANDOFF_SOURCE_PATHS[kind]);
}

function frameHandoffPayload(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(
    FRAME_MAGIC_BYTES.byteLength + 4 + payload.byteLength,
  );
  FRAME_MAGIC_BYTES.copy(frame, 0);
  frame.writeUInt32BE(payload.byteLength, FRAME_MAGIC_BYTES.byteLength);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    FRAME_MAGIC_BYTES.byteLength + 4,
  );
  return frame;
}

function parseInvocation(
  argv: readonly string[],
): SourceInvocation | PreProductionSecretHandoffSourceErrorReason {
  if (argv.length !== 6 && argv.length !== 8) {
    return "invalid_invocation";
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      value.length === 0 ||
      !["--contract", "--kind", "--root", "--probe-absent"].includes(name) ||
      values.has(name)
    ) {
      return "invalid_invocation";
    }
    values.set(name, value);
  }
  if (
    values.get("--contract") !== PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION
  ) {
    return "unsupported_contract_version";
  }
  const kind = values.get("--kind");
  if (
    kind === undefined ||
    !PRE_PRODUCTION_SECRET_HANDOFF_KINDS.some((candidate) => candidate === kind)
  ) {
    return "invalid_kind";
  }
  const root = values.get("--root");
  const probeValue = values.get("--probe-absent");
  if (
    (argv.length === 8 && probeValue !== "true") ||
    (argv.length === 6 && probeValue !== undefined)
  ) {
    return "invalid_invocation";
  }
  return root === undefined
    ? "invalid_invocation"
    : Object.freeze({
        kind: kind as PreProductionSecretHandoffKind,
        root,
        probeAbsent: probeValue === "true",
      });
}

async function writeProbeAbsenceSuccess(
  io: PreProductionSecretHandoffSourceIo,
  kind: PreProductionSecretHandoffKind,
): Promise<void> {
  await io.stdout.write(
    Buffer.from(
      `${JSON.stringify({
        ok: true,
        action: PROBE_ABSENCE_ACTION,
        contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
        kind,
        sourceAbsent: true,
      })}\n`,
      "utf8",
    ),
  );
}

function writeProbeAbsenceUncertain(
  io: PreProductionSecretHandoffSourceIo,
  kind: PreProductionSecretHandoffKind,
): void {
  io.stderr.write(
    `${JSON.stringify({
      ok: false,
      action: PROBE_ABSENCE_ACTION,
      contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
      kind,
      code: "cleanup_uncertain",
      reason: "cleanup_uncertain",
    })}\n`,
  );
}

async function runSourceAbsenceProbe(
  invocation: SourceInvocation,
  io: PreProductionSecretHandoffSourceIo,
): Promise<number> {
  try {
    const root = await validateRoot(invocation.root, io);
    const path = sourcePath(root.path, invocation.kind);
    const present = await io.pathExists(path);
    await assertRootUnchanged(root, io);
    if (present) {
      throw new Error("source endpoint is not absent");
    }
    await writeProbeAbsenceSuccess(io, invocation.kind);
    return 0;
  } catch {
    writeProbeAbsenceUncertain(io, invocation.kind);
    return 79;
  }
}

function writeRefusal(
  io: PreProductionSecretHandoffSourceIo,
  reason: PreProductionSecretHandoffSourceErrorReason,
): void {
  io.stderr.write(
    `${JSON.stringify({
      ok: false,
      action: ACTION,
      contractVersion: PRE_PRODUCTION_SECRET_HANDOFF_CONTRACT_VERSION,
      code: "preproduction_secret_handoff_source_refused",
      reason,
    })}\n`,
  );
}

function refusalExitCode(
  reason: PreProductionSecretHandoffSourceErrorReason,
): number {
  if (
    reason === "invalid_invocation" ||
    reason === "unsupported_contract_version" ||
    reason === "invalid_kind"
  ) {
    return 64;
  }
  if (reason === "handoff_write_failed" || reason === "internal_error") {
    return 1;
  }
  return 78;
}

/**
 * Consumes exactly one allowlisted source below a dedicated handoff root and
 * emits one binary framed write.
 * No server, shell, destination, network, argv secret, or environment secret
 * is created.
 */
export async function runPreProductionSecretHandoffSource(
  argv: readonly string[],
  io: PreProductionSecretHandoffSourceIo = PROCESS_IO,
  runtime: PreProductionSecretHandoffSourceRuntime = PROCESS_RUNTIME,
): Promise<number> {
  const parsed = parseInvocation(argv);
  if (typeof parsed === "string") {
    writeRefusal(io, parsed);
    return refusalExitCode(parsed);
  }
  if (runtime.nodeEnv?.trim().toLowerCase() === "production") {
    writeRefusal(io, "production_mode_refused");
    return refusalExitCode("production_mode_refused");
  }
  if (parsed.probeAbsent) {
    return await runSourceAbsenceProbe(parsed, io);
  }

  try {
    const root = await validateRoot(parsed.root, io);
    const path = sourcePath(root.path, parsed.kind);
    const bytes = await readSourceBytes(path, root, io, parsed.kind);
    let frame: Buffer | null = null;
    try {
      await assertRootUnchanged(root, io);
      frame = frameHandoffPayload(bytes);
      try {
        await io.stdout.write(frame);
      } catch {
        throw new PreProductionSecretHandoffSourceError("handoff_write_failed");
      }
    } finally {
      bytes.fill(0);
      frame?.fill(0);
    }
    return 0;
  } catch (error: unknown) {
    const reason =
      error instanceof PreProductionSecretHandoffSourceError &&
      SAFE_SOURCE_REASONS.has(error.reason)
        ? error.reason
        : "internal_error";
    writeRefusal(io, reason);
    return refusalExitCode(reason);
  }
}
