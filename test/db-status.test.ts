import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { StatusRepository } from "../src/db/repositories/status.repository.js";
import { Database } from "better-sqlite3";

describe("StatusRepository", () => {
  let db: Database;
  let repo: StatusRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    repo = new StatusRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("upserts current status and appends to status transition history", () => {
    repo.save({
      deviceId: "nexgas-001",
      status: "online",
      receivedAt: "2026-10-30T10:00:00.000Z",
    });

    const current1 = repo.getCurrent("nexgas-001");
    expect(current1?.status).toBe("online");

    // LWT disconnect
    repo.save({
      deviceId: "nexgas-001",
      status: "offline",
      receivedAt: "2026-10-30T10:15:00.000Z",
    });

    const current2 = repo.getCurrent("nexgas-001");
    expect(current2?.status).toBe("offline");

    const history = repo.getHistory({ deviceId: "nexgas-001" });
    expect(history.total).toBe(2);
    expect(history.items[0].status).toBe("offline");
    expect(history.items[1].status).toBe("online");
  });

  it("returns null when querying status for unknown device", () => {
    expect(repo.getCurrent("non-existent-device")).toBeNull();
  });
});
