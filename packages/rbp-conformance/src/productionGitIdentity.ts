import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

export interface ProductionGitIdentity {
  path: string;
  realPath: string;
  sha256: string;
  version: string;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}

export function resolveGitExecutableOnPath(): string {
  const locator = process.platform === "win32"
    ? { executable: "where.exe", args: ["git.exe"] }
    : { executable: "sh", args: ["-c", "command -v git"] };
  const result = spawnSync(locator.executable, locator.args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    env: sanitizedEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cannot resolve Git on PATH: ${String(result.stderr).trim()}`);
  }
  const selected = String(result.stdout)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (selected === undefined || !path.isAbsolute(selected)) {
    throw new Error("Git PATH resolution did not return an absolute executable");
  }
  return selected;
}

export function resolveProductionGitIdentity(
  gitExecutable = resolveGitExecutableOnPath(),
): ProductionGitIdentity {
  if (!path.isAbsolute(gitExecutable)) {
    throw new Error(`Git executable must be absolute: ${gitExecutable}`);
  }
  const executable = path.resolve(gitExecutable);
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`Git executable cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`Git executable is not a regular file: ${executable}`);
  }
  const result = spawnSync(realExecutable, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    env: sanitizedEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Git identity probe failed: ${String(result.stderr).trim()}`);
  }
  const version = String(result.stdout).trim();
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+/u.test(version)) {
    throw new Error(`Git identity probe returned an unexpected version: ${version}`);
  }
  return {
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
    version,
  };
}

export function verifyProductionGitIdentityCurrent(
  expected: ProductionGitIdentity,
): ProductionGitIdentity {
  const executable = path.resolve(expected.path);
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`Git executable cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`Git executable is not a regular file: ${executable}`);
  }
  const current = {
    ...expected,
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("bound Git path or bytes changed");
  }
  return current;
}

export function runBoundGit(
  repoRoot: string,
  args: readonly string[],
  expectedIdentity?: ProductionGitIdentity,
): { stdout: string; identity: ProductionGitIdentity } {
  const before = expectedIdentity === undefined
    ? resolveProductionGitIdentity(resolveGitExecutableOnPath())
    : verifyProductionGitIdentityCurrent(expectedIdentity);
  const result = spawnSync(before.realPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: sanitizedEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Git ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  const after = verifyProductionGitIdentityCurrent(before);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("bound Git identity changed during invocation");
  }
  return { stdout: String(result.stdout), identity: before };
}

export function runBoundGitOptional(
  repoRoot: string,
  args: readonly string[],
  expectedIdentity: ProductionGitIdentity,
): string | undefined {
  const before = verifyProductionGitIdentityCurrent(expectedIdentity);
  const result = spawnSync(before.realPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: sanitizedEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  const after = verifyProductionGitIdentityCurrent(before);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("bound Git identity changed during optional invocation");
  }
  if (result.status !== 0) return undefined;
  return String(result.stdout).trim() || undefined;
}
