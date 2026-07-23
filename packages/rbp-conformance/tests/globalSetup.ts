import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const planFile = path.join(
  repoRoot,
  "artifacts",
  "conformance",
  "rbp-v1",
  "1.0",
  "test-support",
  "current-production-plan.json",
);

function npmEntrypoint(): string {
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_EXECPATH,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const selected = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      path.isAbsolute(candidate) &&
      existsSync(candidate),
  );
  if (selected === undefined) {
    throw new Error(
      "production test setup could not resolve the exact npm launcher",
    );
  }
  return selected;
}

function systemPowerShell(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined) {
    throw new Error("production test setup could not resolve SystemRoot");
  }
  const executable = path.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(executable)) {
    throw new Error(
      `production test setup could not find exact Windows PowerShell: ${executable}`,
    );
  }
  return executable;
}

function directLauncherEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "NPM_EXECPATH" ||
      normalized === "NPM_NODE_EXECPATH" ||
      normalized.startsWith("NPM_LIFECYCLE_")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

export default function setup(): void {
  const launcher = path.join(
    packageRoot,
    "scripts",
    "invoke-production.ps1",
  );
  const wrapper = path.join(
    packageRoot,
    "scripts",
    "prepare-production.mjs",
  );
  const result = spawnSync(
    systemPowerShell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "-NodeExecutable",
      process.execPath,
      "-Entrypoint",
      wrapper,
      "--npm-executable",
      npmEntrypoint(),
      planFile,
      "--run-id",
      "rbp-conformance-test-current-production",
      "--sequence",
      "1",
      "--repo-root",
      repoRoot,
      "--node-executable",
      process.execPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: directLauncherEnvironment(),
      shell: false,
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `canonical production test preparation failed (exit ${String(result.status)})`,
        String(result.stdout).trim(),
        String(result.stderr).trim(),
      ].filter((entry) => entry.length > 0).join("\n"),
    );
  }
  process.env.RBP_TEST_PRODUCTION_PLAN = planFile;
  process.env.RBP_TEST_REPO_ROOT = repoRoot;
}
