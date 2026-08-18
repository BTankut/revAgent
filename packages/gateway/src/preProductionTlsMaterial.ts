import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { GatewayServerTlsMaterial } from "./server.js";

const MAX_TLS_FILE_BYTES = 256 * 1_024;

export type PreProductionTlsMaterialErrorReason =
  | "invalid_path"
  | "unsupported_platform"
  | "file_unavailable"
  | "symlink_refused"
  | "not_regular_file"
  | "path_not_canonical"
  | "owner_mismatch"
  | "invalid_permissions"
  | "invalid_link_count"
  | "invalid_size"
  | "changed_during_read"
  | "duplicate_file";

export class PreProductionTlsMaterialError extends Error {
  readonly code = "preproduction_tls_material_refused" as const;

  constructor(readonly reason: PreProductionTlsMaterialErrorReason) {
    super(`pre-production TLS material refused: ${reason}`);
    this.name = "PreProductionTlsMaterialError";
  }
}

export interface PreProductionTlsFileStat {
  readonly file: boolean;
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

export interface PreProductionTlsFileHandle {
  stat(): Promise<PreProductionTlsFileStat>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PreProductionTlsMaterialIo {
  readonly platform: NodeJS.Platform;
  currentUid(): number | null;
  isAbsolute(filePath: string): boolean;
  resolve(filePath: string): string;
  lstat(filePath: string): Promise<PreProductionTlsFileStat>;
  realpath(filePath: string): Promise<string>;
  open(filePath: string, flags: number): Promise<PreProductionTlsFileHandle>;
}

/**
 * Identity and policy fields are integral by definition, so requiring a whole
 * number costs nothing and buys precision: `sameState` compares them for
 * equality to detect a file swapped mid-read, and a `bigint` silently truncated
 * past 2^53 could make two different inodes compare equal and defeat that.
 */
function asNumber(value: number | bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) refused("file_unavailable");
  return numeric;
}

/**
 * Timestamps are legitimately fractional: ext4 and every other filesystem with
 * sub-millisecond resolution leave a remainder in `mtimeMs`/`ctimeMs`. Demanding
 * a whole number here refused every real file, so the pre-production Gateway
 * could not start at all. Precision still matters, because `sameState` compares
 * these two fields as well, so the value must stay inside the range where a
 * double compares exactly -- it simply must not be required to be an integer.
 */
function asTimestamp(value: number | bigint): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
    refused("file_unavailable");
  }
  return numeric;
}

function snapshot(value: Awaited<ReturnType<typeof lstat>>): PreProductionTlsFileStat {
  return Object.freeze({
    file: value.isFile(),
    symbolicLink: value.isSymbolicLink(),
    dev: asNumber(value.dev),
    ino: asNumber(value.ino),
    mode: asNumber(value.mode),
    nlink: asNumber(value.nlink),
    uid: asNumber(value.uid),
    size: asNumber(value.size),
    mtimeMs: asTimestamp(value.mtimeMs),
    ctimeMs: asTimestamp(value.ctimeMs),
  });
}

const NODE_IO: PreProductionTlsMaterialIo = Object.freeze({
  platform: process.platform,
  currentUid: () =>
    typeof process.getuid === "function" ? process.getuid() : null,
  isAbsolute,
  resolve,
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
});

function refused(reason: PreProductionTlsMaterialErrorReason): never {
  throw new PreProductionTlsMaterialError(reason);
}

function sameState(
  left: PreProductionTlsFileStat,
  right: PreProductionTlsFileStat,
): boolean {
  return (
    left.file === right.file &&
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

function validate(stat: PreProductionTlsFileStat, uid: number): void {
  if (stat.symbolicLink) refused("symlink_refused");
  if (!stat.file) refused("not_regular_file");
  if (stat.uid !== uid) refused("owner_mismatch");
  if ((stat.mode & 0o7777) !== 0o400) refused("invalid_permissions");
  if (stat.nlink !== 1) refused("invalid_link_count");
  if (
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0 ||
    stat.size > MAX_TLS_FILE_BYTES
  ) {
    refused("invalid_size");
  }
}

async function readOne(
  filePath: string,
  io: PreProductionTlsMaterialIo,
): Promise<{ readonly bytes: Buffer; readonly dev: number; readonly ino: number }> {
  if (!io.isAbsolute(filePath) || io.resolve(filePath) !== filePath) {
    refused("invalid_path");
  }
  const uid = io.currentUid();
  if (io.platform === "win32" || uid === null) {
    refused("unsupported_platform");
  }

  let initial: PreProductionTlsFileStat;
  try {
    initial = await io.lstat(filePath);
  } catch {
    return refused("file_unavailable");
  }
  validate(initial, uid);
  try {
    if ((await io.realpath(filePath)) !== filePath) {
      refused("path_not_canonical");
    }
  } catch (error) {
    if (error instanceof PreProductionTlsMaterialError) throw error;
    return refused("file_unavailable");
  }

  let handle: PreProductionTlsFileHandle;
  try {
    handle = await io.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return refused("file_unavailable");
  }

  try {
    const before = await handle.stat();
    validate(before, uid);
    if (!sameState(initial, before)) refused("changed_during_read");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    validate(after, uid);
    if (!sameState(before, after) || bytes.byteLength !== after.size) {
      refused("changed_during_read");
    }
    if ((await io.realpath(filePath)) !== filePath) {
      refused("path_not_canonical");
    }
    return Object.freeze({
      bytes: Buffer.from(bytes),
      dev: after.dev,
      ino: after.ino,
    });
  } catch (error) {
    if (error instanceof PreProductionTlsMaterialError) throw error;
    return refused("file_unavailable");
  } finally {
    try {
      await handle.close();
    } catch {
      // A failed close makes the bounded read unverifiable.
      refused("file_unavailable");
    }
  }
}

/** Loads two explicit owner-only files without following links or logging data. */
export async function loadPreProductionTlsMaterial(
  input: {
    readonly keyFilePath: string;
    readonly certificateFilePath: string;
  },
  io: PreProductionTlsMaterialIo = NODE_IO,
): Promise<GatewayServerTlsMaterial> {
  const key = await readOne(input.keyFilePath, io);
  const certificate = await readOne(input.certificateFilePath, io);
  if (key.dev === certificate.dev && key.ino === certificate.ino) {
    refused("duplicate_file");
  }
  return Object.freeze({ key: key.bytes, cert: certificate.bytes });
}
