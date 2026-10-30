import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { Database } from "better-sqlite3";

describe("Database Migrations", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("applies migrations 001 and 002 and creates all required tables and indexes", () => {
    const result = runMigrations(db);
    expect(result.applied).toBe(2);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("telemetry_history");
    expect(tableNames).toContain("device_current_state");
    expect(tableNames).toContain("state_history");
    expect(tableNames).toContain("device_current_status");
    expect(tableNames).toContain("status_history");
    expect(tableNames).toContain("event_history");
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("refresh_sessions");
    expect(tableNames).toContain("audit_logs");

    // Verify migration records
    const records = db
      .prepare("SELECT * FROM schema_migrations ORDER BY version ASC")
      .all() as { version: number; name: string }[];
    expect(records.length).toBe(2);
    expect(records[0].name).toBe("001_initial_schema");
    expect(records[1].name).toBe("002_auth_and_audit");
  });

  it("is safe and idempotent: re-running migrations applies 0 new migrations", () => {
    const firstRun = runMigrations(db);
    expect(firstRun.applied).toBe(2);

    const secondRun = runMigrations(db);
    expect(secondRun.applied).toBe(0);

    const records = db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };
    expect(records.count).toBe(2);
  });
});
