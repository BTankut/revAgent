import { createRequire } from "node:module";

const gatewayRequire = createRequire(
  new URL("../packages/gateway/package.json", import.meta.url),
);
const Database = gatewayRequire("better-sqlite3");

const database = new Database(":memory:");
try {
  const row = database.prepare(
    "SELECT 42 AS answer, sqlite_version() AS sqlite_version",
  ).get();
  if (
    row === undefined ||
    row.answer !== 42 ||
    typeof row.sqlite_version !== "string" ||
    row.sqlite_version.length === 0
  ) {
    throw new Error("better-sqlite3 native smoke query returned an invalid result");
  }
  process.stdout.write(`${JSON.stringify({
    dependency: "better-sqlite3",
    nativeBindingLoaded: true,
    sqliteVersion: row.sqlite_version,
  })}\n`);
} finally {
  database.close();
}
