import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { StateRepository } from "../src/db/repositories/state.repository.js";
import { Database } from "better-sqlite3";
import { NormalizedDeviceState } from "../src/types/index.js";

describe("StateRepository", () => {
  let db: Database;
  let repo: StateRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    repo = new StateRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const baseState: NormalizedDeviceState = {
    deviceId: "nexgas-001",
    valveOpen: false,
    valveMode: "auto",
    filterWarning: false,
    leakWarning: false,
    filterHealth: 85,
    pressureCalibrated: true,
    phCalibrated: false,
    sensorsReady: true,
    buffered: 0,
    uptimeMs: 100000,
    firmware: "1.0.0",
    receivedAt: "2026-10-30T10:00:00.000Z",
  };

  it("upserts current state and appends to transition history", () => {
    // Initial state
    repo.save(baseState);

    const current1 = repo.getCurrent("nexgas-001");
    expect(current1).not.toBeNull();
    expect(current1?.valveMode).toBe("auto");
    expect(current1?.valveOpen).toBe(false);
    expect(current1?.filterHealth).toBe(85);

    // State transition: user switches to manual and opens valve
    const updatedState: NormalizedDeviceState = {
      ...baseState,
      valveMode: "manual",
      valveOpen: true,
      uptimeMs: 105000,
      receivedAt: "2026-10-30T10:00:05.000Z",
    };
    repo.save(updatedState);

    // Current state must reflect latest values
    const current2 = repo.getCurrent("nexgas-001");
    expect(current2?.valveMode).toBe("manual");
    expect(current2?.valveOpen).toBe(true);
    expect(current2?.receivedAt).toBe("2026-10-30T10:00:05.000Z");

    // History must contain both transitions
    const history = repo.getHistory({ deviceId: "nexgas-001" });
    expect(history.total).toBe(2);
    expect(history.items[0].valveMode).toBe("manual"); // latest first
    expect(history.items[1].valveMode).toBe("auto");
  });

  it("supports date range filtering and pagination on state history", () => {
    for (let i = 1; i <= 4; i++) {
      repo.save({
        ...baseState,
        uptimeMs: 100000 + i * 1000,
        receivedAt: `2026-10-30T10:0${i}:00.000Z`,
        filterHealth: 90 - i,
      });
    }

    const paged = repo.getHistory({ deviceId: "nexgas-001", limit: 2, offset: 0 });
    expect(paged.items.length).toBe(2);
    expect(paged.total).toBe(4);
    expect(paged.items[0].receivedAt).toBe("2026-10-30T10:04:00.000Z");

    const filtered = repo.getHistory({
      deviceId: "nexgas-001",
      from: "2026-10-30T10:02:00.000Z",
      to: "2026-10-30T10:03:00.000Z",
    });
    expect(filtered.total).toBe(2);
  });
});
