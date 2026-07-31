// Run every migration workspace's test suite EXCEPT @revagent/rbp-conformance.
//
// Used by the "Verify generated protocol types and test migration packages"
// step in .github/workflows/ci.yml so the always-run portion of Gateway gates
// stays fast while the RBP conformance suite runs behind the fail-closed
// classifier (scripts/ci-classify-changes.ps1).
//
// Workspaces are enumerated dynamically from packages/*/package.json so a
// newly added workspace is automatically tested in the scoped path too (no
// hardcoded-list drift). Suites run sequentially and the first non-zero exit
// fails the run.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_WORKSPACES = new Set(["@revagent/rbp-conformance"]);
const WORKSPACE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");

const workspaceNames = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name, "package.json"))
  .filter((manifestPath) => existsSync(manifestPath))
  .map((manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`Workspace manifest has no name: ${manifestPath}`);
    }
    if (!WORKSPACE_NAME_PATTERN.test(manifest.name)) {
      throw new Error(`Workspace name is not shell-safe: ${manifest.name}`);
    }
    return manifest.name;
  })
  .filter((name) => !EXCLUDED_WORKSPACES.has(name))
  .sort();

if (workspaceNames.length === 0) {
  throw new Error(`No non-excluded workspaces found under ${packagesRoot}`);
}

for (const name of workspaceNames) {
  process.stdout.write(`[scoped] npm run test --workspace ${name} --if-present\n`);
  const result = spawnSync(`npm run test --workspace ${name} --if-present`, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(`[scoped] workspace ${name} tests failed with exit code ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`[scoped] all ${workspaceNames.length} non-rbp workspaces passed\n`);
