import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { TelemetryRepository } from "../src/db/repositories/telemetry.repository.js";
import { Database } from "better-sqlite3";
import { NormalizedTelemetry } from "../src/types/index.js";

describe("TelemetryRepository", () => {
  let db: Database;
  let repo: TelemetryRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    repo = new TelemetryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const sampleTelemetry: NormalizedTelemetry = {
    deviceId: "nexgas-001",
    receivedAt: "2026-10-30T10:00:00.000Z",
    deviceTimestamp: "2026-10-30T09:59:58.000Z",
    rawTimestamp: 1761000000,
    uptimeMs: 150000,
    h2sBefore: null, // Explicitly unavailable (2nd sensor not installed)
    h2sAfter: 2.8,
    ch4Estimate: 66.5,
    leakPpm: 25.0,
    pressureDigesterKpa: 1.25,
    pressureCollectorKpa: 0.85,
    temperatureC: 34.2,
    humidityPct: 88.5,
    gasLineTemperatureC: 31.0,
    gasLineHumidityPct: 76.0,
    ph: 6.95,
    flowEstimateLpm: 0.15,
    gasSinceStartTotalL: 14.2,
    sensorsReady: true,
    rssi: -58,
    raw: {
      ts: 1761000000,
      uptimeMs: 150000,
      h2sBefore: -1,
      h2sAfter: 2.8,
      ch4: 66.5,
      leak: 25.0,
      pressureDigester: 1.25,
      pressureCollector: 0.85,
      temperature: 34.2,
      humidity: 88.5,
      gasLineTemperature: 31.0,
      gasLineHumidity: 76.0,
      ph: 6.95,
      flow: 0.15,
      gasSinceStartL: 14.2,
      sensorsReady: true,
      rssi: -58,
    },
  };

  it("inserts telemetry and preserves NULL values for unavailable sensors", () => {
    const res = repo.insert(sampleTelemetry);
    expect(res.inserted).toBe(true);
    expect(res.id).toBeGreaterThan(0);

    const latest = repo.getLatest("nexgas-001");
    expect(latest).not.toBeNull();
    expect(latest?.deviceId).toBe("nexgas-001");
    expect(latest?.h2sBefore).toBeNull(); // NULL is preserved, NEVER converted to 0
    expect(latest?.h2sAfter).toBe(2.8);
    expect(latest?.pressureDigesterKpa).toBe(1.25);
    expect(latest?.deviceTimestamp).toBe("2026-10-30T09:59:58.000Z");
    expect(latest?.receivedAt).toBe("2026-10-30T10:00:00.000Z");
    expect(latest?.uptimeMs).toBe(150000);
  });

  it("preserves null device timestamp when device ts = 0", () => {
    const telemetryNoNtp: NormalizedTelemetry = {
      ...sampleTelemetry,
      deviceTimestamp: null,
      rawTimestamp: 0,
      uptimeMs: 150001,
      receivedAt: "2026-10-30T10:00:05.000Z",
    };

    const res = repo.insert(telemetryNoNtp);
    expect(res.inserted).toBe(true);

    const latest = repo.getLatest("nexgas-001");
    expect(latest?.deviceTimestamp).toBeNull();
    expect(latest?.rawTimestamp).toBe(0);
    expect(latest?.receivedAt).toBe("2026-10-30T10:00:05.000Z");
  });

  it("detects duplicate/replayed messages and avoids duplicate insertion", () => {
    const res1 = repo.insert(sampleTelemetry);
    expect(res1.inserted).toBe(true);

    // Replay with identical deviceId, rawTimestamp, and uptimeMs
    const res2 = repo.insert(sampleTelemetry);
    expect(res2.inserted).toBe(false);
    expect(res2.id).toBe(res1.id);

    const history = repo.getHistory({ deviceId: "nexgas-001" });
    expect(history.total).toBe(1);
  });

  it("supports pagination and date range filtering", () => {
    // Insert 5 samples with consecutive receive times
    for (let i = 1; i <= 5; i++) {
      repo.insert({
        ...sampleTelemetry,
        rawTimestamp: 1761000000 + i * 5,
        uptimeMs: 150000 + i * 5000,
        receivedAt: `2026-10-30T10:0${i}:00.000Z`,
        pressureDigesterKpa: 1.0 + i * 0.1,
      });
    }

    // Pagination: limit 2, offset 0 (default desc)
    const page1 = repo.getHistory({ deviceId: "nexgas-001", limit: 2, offset: 0 });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.items[0].receivedAt).toBe("2026-10-30T10:05:00.000Z");

    // Pagination: limit 2, offset 2
    const page2 = repo.getHistory({ deviceId: "nexgas-001", limit: 2, offset: 2 });
    expect(page2.items.length).toBe(2);
    expect(page2.items[0].receivedAt).toBe("2026-10-30T10:03:00.000Z");

    // Date range filter
    const filtered = repo.getHistory({
      deviceId: "nexgas-001",
      from: "2026-10-30T10:02:00.000Z",
      to: "2026-10-30T10:04:00.000Z",
    });
    expect(filtered.total).toBe(3);
    expect(filtered.items.map((it) => it.receivedAt)).toEqual([
      "2026-10-30T10:04:00.000Z",
      "2026-10-30T10:03:00.000Z",
      "2026-10-30T10:02:00.000Z",
    ]);

    // Ascending order
    const asc = repo.getHistory({ deviceId: "nexgas-001", limit: 2, order: "asc" });
    expect(asc.items[0].receivedAt).toBe("2026-10-30T10:01:00.000Z");
  });
});
