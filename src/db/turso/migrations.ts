import { Client } from "@libsql/client";
import { logger } from "../../utils/logger.js";
import { MIGRATION_001_SQL, MIGRATION_002_SQL } from "../migrations/index.js";

export interface TursoMigration {
  version: number;
  name: string;
  sql: string;
}

export const tursoMigrations: TursoMigration[] = [
  {
    version: 1,
    name: "001_initial_schema",
    sql: MIGRATION_001_SQL,
  },
  {
    version: 2,
    name: "002_auth_and_audit",
    sql: MIGRATION_002_SQL,
  },
];

/**
 * Ensures schema_migrations exists and applies all pending migrations in order on Turso/libSQL.
 * Uses executeMultiple for bulk DDL statement execution.
 */
export async function runTursoMigrations(
  client: Client,
): Promise<{ applied: number; currentVersion: number }> {
  // 1. Ensure migration tracking table exists
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // 2. Fetch applied migrations
  const result = await client.execute(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  );

  const appliedVersions = new Set<number>(
    result.rows.map((row) => Number(row.version)),
  );

  let appliedCount = 0;
  let latestVersion = 0;

  for (const row of result.rows) {
    const v = Number(row.version);
    if (v > latestVersion) latestVersion = v;
  }

  // 3. Apply missing migrations in sequence
  for (const migration of tursoMigrations) {
    if (!appliedVersions.has(migration.version)) {
      logger.info(
        `Applying Turso database migration ${migration.version}: ${migration.name}...`,
      );

      // Execute DDL batch
      await client.executeMultiple(migration.sql);

      // Record successful application
      await client.execute({
        sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        args: [migration.version, migration.name, new Date().toISOString()],
      });

      appliedCount++;
      latestVersion = migration.version;
      logger.info(
        `Turso migration ${migration.version} successfully applied`,
      );
    }
  }

  return {
    applied: appliedCount,
    currentVersion: latestVersion,
  };
}

