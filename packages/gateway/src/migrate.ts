import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export async function migrateUp(databaseUrl: string): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const applied: string[] = [];
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      digest char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    for (const file of files) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      const digest = createHash("sha256").update(sql, "utf8").digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const prior = await client.query<{ digest: string }>(
          "SELECT digest FROM schema_migrations WHERE version = $1",
          [file],
        );
        if (prior.rowCount === 0) {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations(version, digest) VALUES ($1, $2)",
            [file, digest],
          );
          applied.push(file);
        } else if (prior.rows[0]?.digest !== digest) throw new Error(`migration digest mismatch: ${file}`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return Object.freeze(applied);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }
  const applied = await migrateUp(databaseUrl);
  process.stdout.write(`${JSON.stringify({ migrated: applied })}\n`);
}
