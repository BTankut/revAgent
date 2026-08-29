import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const GLOBAL_SYSTEM32 = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";
const GLOBAL_WINDOWS_ROOT = "\\\\?\\GLOBALROOT\\SystemRoot";

export interface WindowsSystemPaths {
  readonly windowsRoot: string;
  readonly system32: string;
  readonly powershell: string;
  readonly taskkill: string;
  readonly system32Device: bigint;
  readonly system32Inode: bigint;
}

function normalized(value: string): string {
  return value.replace(/^\\\\\?\\/u, "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function assertPlainExactFile(file: string, label: string): string {
  const entry = lstatSync(file, { bigint: true });
  const real = realpathSync.native(file);
  const stat = statSync(real, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino ||
      normalized(file) !== normalized(real)) {
    throw new Error(`${label} resolves through a substituted identity`);
  }
  return real;
}

/**
 * Resolves fixed Windows system paths through the NT GLOBALROOT SystemRoot
 * alias. Ambient environment values are checked only after this independent
 * resolution and are never used as a fallback or discovery source.
 */
export function resolveWindowsSystemPaths(environment: NodeJS.ProcessEnv = process.env): WindowsSystemPaths | null {
  if (process.platform !== "win32") return null;
  const system32 = realpathSync.native(GLOBAL_SYSTEM32);
  const windowsRoot = realpathSync.native(GLOBAL_WINDOWS_ROOT);
  const lexicalSystem32 = path.resolve(windowsRoot, "System32");
  const globalStat = statSync(system32, { bigint: true });
  const lexicalStat = statSync(lexicalSystem32, { bigint: true });
  if (!globalStat.isDirectory() || !lexicalStat.isDirectory() || globalStat.dev !== lexicalStat.dev || globalStat.ino !== lexicalStat.ino ||
      normalized(system32) !== normalized(realpathSync.native(lexicalSystem32)) ||
      normalized(path.dirname(system32)) !== normalized(windowsRoot) ||
      normalized(realpathSync.native(windowsRoot)) !== normalized(path.resolve(windowsRoot))) {
    throw new Error("GLOBALROOT System32 does not resolve to one canonical Windows identity");
  }
  const systemRoot = environment.SystemRoot;
  const windir = environment.WINDIR;
  if (systemRoot === undefined || windir === undefined || !path.isAbsolute(systemRoot) || !path.isAbsolute(windir) ||
      normalized(path.resolve(systemRoot)) !== normalized(windowsRoot) || normalized(path.resolve(windir)) !== normalized(windowsRoot)) {
    throw new Error("SystemRoot or WINDIR differs from the GLOBALROOT Windows identity");
  }
  const powershell = assertPlainExactFile(
    path.resolve(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    "canonical PowerShell",
  );
  const taskkill = assertPlainExactFile(path.resolve(system32, "taskkill.exe"), "canonical taskkill");
  return Object.freeze({
    windowsRoot,
    system32,
    powershell,
    taskkill,
    system32Device: globalStat.dev,
    system32Inode: globalStat.ino,
  });
}
