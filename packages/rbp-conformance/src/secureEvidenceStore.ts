import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalManifest } from "./manifest.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPlainDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`evidence path component is not a plain directory: ${directory}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { mode: DIRECTORY_MODE });
  assertPlainDirectory(directory);
  chmodSync(directory, DIRECTORY_MODE);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    // Windows does not permit opening a directory as a normal file handle.
    // The data file itself is still fsynced before rename; Linux CI additionally
    // fsyncs the containing directory so the rename is durable.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface StoredEvidenceFile {
  absolutePath: string;
  bytes: Buffer;
}

/**
 * Parent-owned retained-evidence writer.
 *
 * Every path is confined below the canonical retained root. Directories are
 * forced to 0700 and files to 0600. A write is staged with O_EXCL in the final
 * directory, fsynced, and atomically renamed; an existing final file is never
 * replaced.
 */
export class SecureEvidenceStore {
  readonly artifactRoot: string;
  readonly retainedRoot: string;
  readonly #artifactRootReal: string;

  constructor(artifactRoot: string) {
    this.artifactRoot = path.resolve(artifactRoot);
    if (!existsSync(this.artifactRoot)) {
      mkdirSync(this.artifactRoot, { recursive: true, mode: DIRECTORY_MODE });
    }
    assertPlainDirectory(this.artifactRoot);
    this.#artifactRootReal = realpathSync.native(this.artifactRoot);
    this.retainedRoot = path.resolve(this.artifactRoot, canonicalManifest.retainedEvidence.root);
    if (!isInside(this.artifactRoot, this.retainedRoot)) {
      throw new Error("canonical retained evidence root escapes artifactRoot");
    }
    this.#ensureDirectoryChain(this.retainedRoot);
  }

  #ensureDirectoryChain(directory: string): void {
    if (realpathSync.native(this.artifactRoot) !== this.#artifactRootReal) {
      throw new Error("evidence root identity changed during operation");
    }
    if (!isInside(this.artifactRoot, directory)) {
      throw new Error(`evidence directory escapes artifactRoot: ${directory}`);
    }
    const relative = path.relative(this.artifactRoot, directory);
    let cursor = this.artifactRoot;
    for (const segment of relative.split(path.sep).filter((entry) => entry.length > 0)) {
      cursor = path.join(cursor, segment);
      ensurePrivateDirectory(cursor);
      if (realpathSync.native(cursor) !== path.resolve(this.#artifactRootReal, path.relative(this.artifactRoot, cursor))) {
        throw new Error(`evidence directory identity changed: ${cursor}`);
      }
    }
  }

  resolve(relativePath: string): string {
    const normalizedPrefix = `${canonicalManifest.retainedEvidence.root}/`;
    if (path.isAbsolute(relativePath) || !relativePath.replaceAll("\\", "/").startsWith(normalizedPrefix)) {
      throw new Error(`evidence path must remain below ${canonicalManifest.retainedEvidence.root}`);
    }
    const target = path.resolve(this.artifactRoot, relativePath);
    if (!isInside(this.retainedRoot, target)) {
      throw new Error(`evidence path escapes retained root: ${relativePath}`);
    }
    return target;
  }

  write(relativePath: string, contents: string | Buffer): StoredEvidenceFile {
    const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
    const target = this.resolve(relativePath);
    const directory = path.dirname(target);
    this.#ensureDirectoryChain(directory);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        FILE_MODE,
      );
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, FILE_MODE);
      // link is an atomic no-clobber publication primitive on the same volume:
      // unlike rename on Windows, it cannot replace a competing final target.
      linkSync(temporary, target);
      rmSync(temporary, { force: true });
      chmodSync(target, FILE_MODE);
      fsyncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
    return { absolutePath: target, bytes: readFileSync(target) };
  }
}
