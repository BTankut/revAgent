import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bridgeRequire = createRequire(
  path.join(repoRoot, "packages/bridge-simulator/package.json"),
);
const modulePath = bridgeRequire.resolve("better-sqlite3");
const BetterSqlite3 = bridgeRequire("better-sqlite3");

const database = new BetterSqlite3(":memory:");
try {
  const row = database.prepare("SELECT 42 AS answer").get();
  if (row?.answer !== 42) {
    throw new Error("native SQLite query returned an unexpected result");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    answer: row.answer,
    modulePath: path.relative(repoRoot, modulePath).replaceAll("\\", "/"),
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      modulesAbi: process.versions.modules,
      napiVersion: process.versions.napi ?? null,
    },
  })}\n`);
} finally {
  database.close();
}
