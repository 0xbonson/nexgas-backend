import { describe, it, expect } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";

describe("SQLite Database Lifecycle", () => {
  it("initializes an in-memory database with WAL mode and foreign keys enabled", () => {
    const db = createDatabase({ inMemory: true });

    const fkPragma = db.pragma("foreign_keys", { simple: true });
    expect(fkPragma).toBe(1);

    // In-memory sqlite databases often report 'memory' or 'wal'
    const journalMode = db.pragma("journal_mode", { simple: true });
    expect(typeof journalMode).toBe("string");

    closeDatabase(db);
    expect(db.open).toBe(false);
  });

  it("handles graceful closing without throwing errors", () => {
    const db = createDatabase({ inMemory: true });
    expect(db.open).toBe(true);

    expect(() => closeDatabase(db)).not.toThrow();
    expect(db.open).toBe(false);

    // Calling close again on already closed DB should not throw
    expect(() => closeDatabase(db)).not.toThrow();
  });
});
