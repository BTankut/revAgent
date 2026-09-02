import { describe, expect, it } from "vitest";
import { loadMigrationCliConfiguration } from "./migrate.js";

const APP_PASSWORD = "runtime-value-from-host-secret-file";

describe("EU-10 migration CLI credential boundary", () => {
  it("refuses runtime DATABASE_URL when the migration-owner URL is absent", () => {
    expect(() => loadMigrationCliConfiguration({
      DATABASE_URL: "postgresql://runtime@postgres/revagent",
      REVAGENT_APP_DATABASE_PASSWORD: APP_PASSWORD,
    })).toThrow("DATABASE_MIGRATION_URL is required; DATABASE_URL is runtime-only");
  });

  it("refuses one credential URL reused for migration and runtime", () => {
    expect(() => loadMigrationCliConfiguration({
      DATABASE_MIGRATION_URL: "postgresql://same@postgres/revagent",
      DATABASE_URL: "postgresql://same@postgres/revagent",
      REVAGENT_APP_DATABASE_PASSWORD: APP_PASSWORD,
    })).toThrow("DATABASE_MIGRATION_URL must not reuse DATABASE_URL runtime credentials");
  });

  it("selects only the explicit migration-owner URL", () => {
    expect(loadMigrationCliConfiguration({
      DATABASE_MIGRATION_URL: "postgresql://owner@postgres/revagent",
      DATABASE_URL: "postgresql://runtime@postgres/revagent",
      REVAGENT_APP_DATABASE_PASSWORD: APP_PASSWORD,
    })).toEqual({
      migrationDatabaseUrl: "postgresql://owner@postgres/revagent",
      appPassword: APP_PASSWORD,
    });
  });
});
