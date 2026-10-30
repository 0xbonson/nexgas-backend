import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { EventRepository } from "../src/db/repositories/event.repository.js";
import { Database } from "better-sqlite3";
import { NormalizedDeviceEvent } from "../src/types/index.js";

describe("EventRepository", () => {
  let db: Database;
  let repo: EventRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    repo = new EventRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const sampleEvents: NormalizedDeviceEvent[] = [
    {
      deviceId: "nexgas-001",
      receivedAt: "2026-10-30T10:00:00.000Z",
      deviceTimestamp: "2026-10-30T09:59:59.000Z",
      uptimeMs: 1000,
      type: "boot",
      severity: "info",
      message: "1.0.0",
      raw: { ts: 1761000000, uptimeMs: 1000, type: "boot", severity: "info", message: "1.0.0" },
    },
    {
      deviceId: "nexgas-001",
      receivedAt: "2026-10-30T10:05:00.000Z",
      deviceTimestamp: "2026-10-30T10:04:59.000Z",
      uptimeMs: 301000,
      type: "pressure_uncalibrated",
      severity: "waspada",
      message: "Mode auto terkunci: kalibrasi tekanan 2 titik belum dilakukan",
      raw: { ts: 1761000300, uptimeMs: 301000, type: "pressure_uncalibrated", severity: "waspada", message: "msg" },
    },
    {
      deviceId: "nexgas-001",
      receivedAt: "2026-10-30T10:10:00.000Z",
      deviceTimestamp: "2026-10-30T10:09:59.000Z",
      uptimeMs: 601000,
      type: "valve_closed_leak",
      severity: "bahaya",
      message: "Solenoid ditutup paksa: metana di udara sekitar berbahaya",
      raw: { ts: 1761000600, uptimeMs: 601000, type: "valve_closed_leak", severity: "bahaya", message: "msg" },
    },
  ];

  it("inserts and retrieves events chronologically", () => {
    for (const ev of sampleEvents) {
      repo.insert(ev);
    }

    const all = repo.getHistory({ deviceId: "nexgas-001" });
    expect(all.total).toBe(3);
    expect(all.items[0].type).toBe("valve_closed_leak"); // Latest first
    expect(all.items[0].severity).toBe("bahaya");
    expect(all.items[2].type).toBe("boot");
  });

  it("filters events by severity and type", () => {
    for (const ev of sampleEvents) {
      repo.insert(ev);
    }

    const critical = repo.getHistory({ severity: "bahaya" });
    expect(critical.total).toBe(1);
    expect(critical.items[0].type).toBe("valve_closed_leak");

    const boots = repo.getHistory({ type: "boot" });
    expect(boots.total).toBe(1);
    expect(boots.items[0].severity).toBe("info");
  });

  it("supports date range filtering and pagination", () => {
    for (const ev of sampleEvents) {
      repo.insert(ev);
    }

    const paged = repo.getHistory({
      from: "2026-10-30T10:04:00.000Z",
      to: "2026-10-30T10:12:00.000Z",
      limit: 1,
      offset: 0,
    });
    expect(paged.total).toBe(2);
    expect(paged.items.length).toBe(1);
    expect(paged.items[0].type).toBe("valve_closed_leak");
  });
});
