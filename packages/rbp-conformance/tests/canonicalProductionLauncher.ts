import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Test support may construct the canonical host arguments from the exact
// checked-out commit. Production evidence still requires an independently
// reviewed authority vector retained outside the checkout.
// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import { productionLaunchPowerShellArguments } from "../scripts/production-launch-bootstrap.mjs";

function requiredEnvironmentPath(
  environmentKey: "ProgramFiles" | "SystemRoot",
  segments: readonly string[],
): string {
  const root = environmentKey === "SystemRoot"
    ? process.env.SystemRoot ?? process.env.WINDIR
    : process.env.ProgramFiles;
  if (root === undefined) {
    throw new Error(`canonical test launcher requires ${environmentKey}`);
  }
  const executable = path.join(root, ...segments);
  if (!existsSync(executable)) {
    throw new Error(
      `canonical test launcher executable is missing: ${executable}`,
    );
  }
  return executable;
}

export const exactSystemPowerShell = requiredEnvironmentPath(
  "SystemRoot",
  ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
);

const exactSystemGit = requiredEnvironmentPath(
  "ProgramFiles",
  ["Git", "bin", "git.exe"],
);

function repositoryRevision(repoRoot: string, revision: string): string {
  const result = spawnSync(
    exactSystemGit,
    ["-C", repoRoot, "rev-parse", "--verify", revision],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `canonical test launcher could not resolve ${revision}: ` +
        String(result.stderr).trim(),
    );
  }
  return String(result.stdout).trim();
}

export function canonicalProductionCliArguments(
  repoRoot: string,
  commandArguments: readonly string[],
): string[] {
  return productionLaunchPowerShellArguments({
    repoRoot,
    role: "cli-bootstrap",
    expectedCommit: repositoryRevision(repoRoot, "HEAD^{commit}"),
    expectedTree: repositoryRevision(repoRoot, "HEAD^{tree}"),
    commandArguments: [...commandArguments],
    powershellExecutable: exactSystemPowerShell,
  });
}
