import { cp, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const entryPoint = resolve(
  repositoryRoot,
  "installer/runtime-mcp-server/src/tools/register.ts",
);
const schemasSource = resolve(
  repositoryRoot,
  "installer/runtime-mcp-server/schemas",
);
const outputRoot = resolve(packageRoot, "dist");
const outputFile = resolve(outputRoot, "runtime/tools/register.js");

await mkdir(dirname(outputFile), { recursive: true });
await copyFile(
  resolve(packageRoot, "package.json"),
  resolve(outputRoot, "package.json"),
);
await cp(schemasSource, resolve(outputRoot, "schemas"), {
  recursive: true,
  force: true,
});
await build({
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  logLevel: "warning",
  outfile: outputFile,
  packages: "external",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
