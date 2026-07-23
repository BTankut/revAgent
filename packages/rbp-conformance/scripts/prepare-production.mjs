import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.status !== 0) {
  throw new Error(`git status failed: ${String(status.stderr).trim()}`);
}
if (String(status.stdout).length > 0) {
  throw new Error("canonical production preparation requires an exactly clean source tree");
}

const npmEntrypoint = process.env.npm_execpath;
if (npmEntrypoint === undefined || !path.isAbsolute(npmEntrypoint)) {
  throw new Error(
    "canonical production preparation must be invoked through npm run prepare:rbp-production",
  );
}
const protocolBootstrap = run(
  process.execPath,
  [npmEntrypoint, "run", "build", "--workspace", "@revagent/protocol"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (protocolBootstrap.status !== 0) {
  throw new Error(`protocol bootstrap build failed (exit ${String(protocolBootstrap.status)})`);
}

const build = run(
  process.execPath,
  [npmEntrypoint, "run", "build", "--workspace", "@revagent/rbp-conformance"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (build.status !== 0) {
  throw new Error(`rbp-conformance build failed (exit ${String(build.status)})`);
}

const cli = path.join(repoRoot, "packages/rbp-conformance/dist/src/cli.js");
const prepare = run(
  process.execPath,
  [cli, "prepare-production", ...process.argv.slice(2)],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (prepare.status !== 0) {
  process.exitCode = prepare.status ?? 1;
}
