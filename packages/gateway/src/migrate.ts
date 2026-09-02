import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export interface MigrationOptions {
  /** Runtime credential supplied out-of-repo; never written to migration SQL. */
  readonly appPassword: string;
}

export interface MigrationCliConfiguration {
  readonly migrationDatabaseUrl: string;
  readonly appPassword: string;
}

export function loadMigrationCliConfiguration(
  env: NodeJS.ProcessEnv,
): MigrationCliConfiguration {
  const migrationDatabaseUrl = env.DATABASE_MIGRATION_URL?.trim();
  const runtimeDatabaseUrl = env.DATABASE_URL?.trim();
  const appPassword = env.REVAGENT_APP_DATABASE_PASSWORD;
  if (migrationDatabaseUrl === undefined || migrationDatabaseUrl === "") {
    throw new Error("DATABASE_MIGRATION_URL is required; DATABASE_URL is runtime-only");
  }
  if (runtimeDatabaseUrl !== undefined && runtimeDatabaseUrl !== "" && runtimeDatabaseUrl === migrationDatabaseUrl) {
    throw new Error("DATABASE_MIGRATION_URL must not reuse DATABASE_URL runtime credentials");
  }
  if (appPassword === undefined || appPassword === "") {
    throw new Error("REVAGENT_APP_DATABASE_PASSWORD is required");
  }
  return Object.freeze({ migrationDatabaseUrl, appPassword });
}

export async function migrateUp(
  databaseUrl: string,
  options: MigrationOptions,
): Promise<readonly string[]> {
  if (options.appPassword.length < 24 || options.appPassword.length > 512) {
    throw new Error("revagent runtime database password must be 24-512 characters");
  }
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
    const passwordSql = await pool.query<{ sql: string }>(
      "SELECT format('ALTER ROLE revagent_runtime PASSWORD %L', $1::text) AS sql",
      [options.appPassword],
    );
    const statement = passwordSql.rows[0]?.sql;
    if (statement === undefined) throw new Error("failed to prepare runtime database credential");
    await pool.query(statement);
    return Object.freeze(applied);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { migrationDatabaseUrl, appPassword } = loadMigrationCliConfiguration(process.env);
  const applied = await migrateUp(migrationDatabaseUrl, { appPassword });
  process.stdout.write(`${JSON.stringify({ migrated: applied })}\n`);
}
