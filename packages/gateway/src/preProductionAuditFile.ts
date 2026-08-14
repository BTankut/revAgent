import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  PreProductionAuditArtifactError,
  type PreProductionAuditAtomicArtifactWriter,
  type PreProductionAuditAtomicCommitOptions,
} from "./preProductionAuditWriter.js";

export const PRE_PRODUCTION_AUDIT_FILE_MODE = 0o400 as const;

function validAuditPath(filePath: string): boolean {
  return isAbsolute(filePath) && resolve(filePath) === filePath;
}

/** Derives the single sibling retained-evidence path without another CLI flag. */
export function derivePreProductionAuditFilePath(
  enrollmentOutputPath: string,
): string {
  if (!validAuditPath(enrollmentOutputPath)) {
    throw new Error("invalid pre-production audit source path");
  }
  const parsed = parse(enrollmentOutputPath);
  const stem = parsed.ext.length > 0 ? parsed.name : parsed.base;
  if (stem.length === 0) {
    throw new Error("invalid pre-production audit source path");
  }
  const auditPath = join(parsed.dir, `${stem}.audit.jsonl`);
  if (!validAuditPath(auditPath) || auditPath === enrollmentOutputPath) {
    throw new Error("invalid pre-production audit destination path");
  }
  return auditPath;
}

function expectedMode(stat: Stats): boolean {
  const mode = stat.mode & 0o7777;
  if (process.platform === "win32") {
    // NTFS exposes owner-read-only as 0444 through Node. The Linux Gateway
    // host must and does satisfy the exact POSIX 0400 branch below.
    return (mode & 0o222) === 0 && (mode & 0o444) !== 0;
  }
  return mode === PRE_PRODUCTION_AUDIT_FILE_MODE;
}

function normalizedCanonicalPath(filePath: string): string {
  const normalized = resolve(filePath).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertTrustedParent(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("pre-production audit parent is not a plain directory");
  }
  if (
    normalizedCanonicalPath(realpathSync(directory)) !==
    normalizedCanonicalPath(directory)
  ) {
    throw new Error("pre-production audit parent is not canonical");
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error("pre-production audit parent is not privately owned");
    }
  }
}

function verifyArtifactStat(stat: Stats, expectedBytes: number): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== expectedBytes ||
    !expectedMode(stat) ||
    (uid !== null && stat.uid !== uid)
  ) {
    throw new Error("pre-production audit artifact verification failed");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(directory: string): void {
  // NTFS FlushFileBuffers for directory handles is not exposed by Node.
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isMissing(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    );
  } catch {
    return false;
  }
}

function removeOwnedPath(filePath: string, ownedStat: Stats): boolean {
  try {
    const current = lstatSync(filePath);
    if (!sameFile(current, ownedStat)) return false;
    rmSync(filePath, { force: true, maxRetries: 0 });
  } catch (error: unknown) {
    return isMissing(error);
  }
  try {
    lstatSync(filePath);
    return false;
  } catch (error: unknown) {
    return isMissing(error);
  }
}

/**
 * Creates a one-attempt 0400 retained-evidence writer.
 *
 * Bytes are staged with O_EXCL, forced to storage, verified, and then exposed
 * with a same-tick hard-link/no-clobber publish. No asynchronous boundary
 * exists between the final abort check and `markCommitted`; the writer's
 * monotonic commit check can therefore reject and roll back a late publish
 * before the event loop observes it as terminal success.
 */
export function createPreProductionAuditFileWriter(
  filePath: string,
): PreProductionAuditAtomicArtifactWriter {
  if (!validAuditPath(filePath)) {
    throw new Error("invalid pre-production audit destination path");
  }
  let attempted = false;

  return Object.freeze({
    async commit(
      value: string,
      options: PreProductionAuditAtomicCommitOptions,
    ): Promise<void> {
      if (attempted) {
        throw new PreProductionAuditArtifactError("commit_failed");
      }
      attempted = true;
      if (options.signal.aborted) {
        throw new PreProductionAuditArtifactError("commit_failed");
      }

      const bytes = Buffer.from(value, "utf8");
      const directory = dirname(filePath);
      const temporaryPath = join(
        directory,
        `.${parse(filePath).base}.${randomUUID()}.tmp`,
      );
      let temporaryOwned = false;
      let descriptor: number | undefined;
      let stagedStat: Stats | undefined;
      let finalLinked = false;
      let committed = false;
      let operationFailed = false;
      let cleanupFailed = false;
      let cleanupAttempted = false;

      try {
        assertTrustedParent(directory);
        descriptor = openSync(
          temporaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          PRE_PRODUCTION_AUDIT_FILE_MODE,
        );
        temporaryOwned = true;
        stagedStat = fstatSync(descriptor);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        stagedStat = fstatSync(descriptor);
        verifyArtifactStat(stagedStat, bytes.byteLength);
        closeSync(descriptor);
        descriptor = undefined;

        if (options.signal.aborted) {
          throw new Error("pre-production audit artifact commit aborted");
        }
        assertTrustedParent(directory);

        // Everything through markCommitted is deliberately synchronous. The
        // event loop cannot run the deadline callback inside this boundary.
        linkSync(temporaryPath, filePath);
        finalLinked = true;
        unlinkSync(temporaryPath);
        temporaryOwned = false;
        const finalStat = lstatSync(filePath);
        verifyArtifactStat(finalStat, bytes.byteLength);
        if (!sameFile(finalStat, stagedStat)) {
          throw new Error("pre-production audit artifact identity changed");
        }
        fsyncDirectory(directory);
        options.markCommitted();
        committed = true;
      } catch {
        operationFailed = true;
      } finally {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            cleanupFailed = true;
          }
        }
        if (operationFailed && !committed) {
          if (finalLinked) {
            cleanupAttempted = true;
            if (
              stagedStat === undefined ||
              !removeOwnedPath(filePath, stagedStat)
            ) {
              cleanupFailed = true;
            }
          }
          if (temporaryOwned) {
            cleanupAttempted = true;
            if (
              stagedStat === undefined ||
              !removeOwnedPath(temporaryPath, stagedStat)
            ) {
              cleanupFailed = true;
            }
          }
          if (cleanupAttempted) {
            try {
              fsyncDirectory(directory);
            } catch {
              cleanupFailed = true;
            }
          }
        }
      }

      if (cleanupFailed) {
        throw new PreProductionAuditArtifactError("cleanup_failed");
      }
      if (operationFailed) {
        throw new PreProductionAuditArtifactError("commit_failed");
      }
    },
  });
}
