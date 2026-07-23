import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertTrustedProductionLaunch } from "./production-launch-attestation.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");

// This assertion consumes the OS-backed launcher receipt before the production
// controller or any of its dependencies are imported.
assertTrustedProductionLaunch({ repoRoot, role: "cli-bootstrap" });

const [firstArgument, ...remainingArguments] = process.argv.slice(2);
if (firstArgument === "__launcher-attestation-argv-spoof") {
  process.argv[2] = "__mutated_after_handoff";
  assertTrustedProductionLaunch({ repoRoot, role: "cli-bootstrap" });
  throw new Error("mutated argv unexpectedly retained trusted launch status");
} else if (firstArgument === "__launcher-attestation-probe") {
  const [outputFile, exitCodeValue, ...forwarded] = remainingArguments;
  if (outputFile === undefined || exitCodeValue === undefined) {
    throw new Error("launcher probe requires output path and exit code");
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    outputFile,
    JSON.stringify({
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      forwarded,
    }),
    "utf8",
  );
  process.exitCode = Number(exitCodeValue);
} else {
  const cli = path.join(packageRoot, "dist", "src", "cli.js");
  if (
    !existsSync(cli) ||
    !lstatSync(cli).isFile() ||
    lstatSync(cli).isSymbolicLink() ||
    realpathSync(cli) !== path.resolve(cli)
  ) {
    throw new Error("canonical freshly-built production CLI is unavailable");
  }
  const module = await import(pathToFileURL(cli).href);
  if (typeof module.runProductionCliMain !== "function") {
    throw new Error("canonical production CLI does not expose its guarded main");
  }
  await module.runProductionCliMain(process.argv.slice(2));
}
