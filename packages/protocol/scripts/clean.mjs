import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageRoot, "dist");
if (dirname(outputPath) !== packageRoot) {
  throw new Error(`refusing to clean unexpected path: ${outputPath}`);
}
await rm(outputPath, { recursive: true, force: true });
