import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { TelemetryRepository } from "../src/db/repositories/telemetry.repository.js";
import { StateRepository } from "../src/db/repositories/state.repository.js";
import { StatusRepository } from "../src/db/repositories/status.repository.js";
import { EventRepository } from "../src/db/repositories/event.repository.js";
import { MqttDatabaseBridge } from "../src/db/bridge.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { Database } from "better-sqlite3";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public subscribe = vi.fn((topics, opts, cb) => cb && cb(null, []));
  public publish = vi.fn((topic, payload, opts, cb) => cb && cb(null));
  public end = vi.fn((force, opts, cb) => cb && cb());
}

describe("MqttDatabaseBridge", () => {
  let db: Database;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
  let bridge: MqttDatabaseBridge;
  let repos: {
    telemetry: TelemetryRepository;
    state: StateRepository;
    status: StatusRepository;
    event: EventRepository;
  };

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);

    repos = {
      telemetry: new TelemetryRepository(db),
      state: new StateRepository(db),
      status: new StatusRepository(db),
      event: new EventRepository(db),
    };

    mockMqttClient = new MockMqttClient();
    mqttService = new NexGasMqttService(mockMqttClient as unknown as MqttClient);

    bridge = new MqttDatabaseBridge(mqttService, repos);
    bridge.attach();
  });

  afterEach(() => {
    bridge.detach();
    closeDatabase(db);
  });

  it("persists incoming MQTT telemetry messages automatically", () => {
    const payload = Buffer.from(
      JSON.stringify({
        ts: 1761000000,
        uptimeMs: 12000,
        h2sBefore: -1,
        h2sAfter: 2.1,
        ch4: 68,
        leak: 20,
        pressureDigester: 0.85,
        pressureCollector: 0.75,
        temperature: 31,
        humidity: 82,
        gasLineTemperature: 30,
        gasLineHumidity: 78,
        ph: 7.1,
        flow: 0.0,
        gasSinceStartL: 12,
        sensorsReady: true,
        rssi: -52,
      }),
    );

    mockMqttClient.emit("message", "nexgas/nexgas-001/telemetry", payload);

    const latest = repos.telemetry.getLatest("nexgas-001");
    expect(latest).not.toBeNull();
    expect(latest?.h2sBefore).toBeNull();
    expect(latest?.h2sAfter).toBe(2.1);
    expect(latest?.pressureDigesterKpa).toBe(0.85);
  });

  it("persists incoming MQTT state messages automatically", () => {
    const payload = Buffer.from(
      JSON.stringify({
        valveOpen: true,
        valveMode: "manual",
        filterWarning: false,
        leakWarning: false,
        filterHealth: 90,
        pressureCalibrated: true,
        phCalibrated: true,
        sensorsReady: true,
        buffered: 0,
        uptimeMs: 50000,
        firmware: "1.0.0",
      }),
    );

    mockMqttClient.emit("message", "nexgas/nexgas-001/state", payload);

    const current = repos.state.getCurrent("nexgas-001");
    expect(current).not.toBeNull();
    expect(current?.valveOpen).toBe(true);
    expect(current?.valveMode).toBe("manual");
  });

  it("persists incoming MQTT status messages automatically", () => {
    mockMqttClient.emit("message", "nexgas/nexgas-001/status", Buffer.from("offline"));

    const current = repos.status.getCurrent("nexgas-001");
    expect(current).not.toBeNull();
    expect(current?.status).toBe("offline");
  });

  it("persists incoming MQTT event messages automatically", () => {
    const payload = Buffer.from(
      JSON.stringify({
        ts: 1761000000,
        uptimeMs: 1000,
        type: "boot",
        severity: "info",
        message: "1.0.0",
      }),
    );

    mockMqttClient.emit("message", "nexgas/nexgas-001/event", payload);

    const events = repos.event.getHistory({ deviceId: "nexgas-001" });
    expect(events.total).toBe(1);
    expect(events.items[0].type).toBe("boot");
  });

  it("resilience: database failures do not crash the MQTT service or message handlers", () => {
    // Spy on insert and force it to throw
    vi.spyOn(repos.telemetry, "insert").mockImplementation(() => {
      throw new Error("Simulated SQLite write lock timeout");
    });

    const payload = Buffer.from(
      JSON.stringify({
        ts: 1761000000,
        uptimeMs: 12000,
        h2sBefore: -1,
        h2sAfter: 2.1,
        ch4: 68,
        leak: 20,
        pressureDigester: 0.85,
        pressureCollector: 0.75,
        temperature: 31,
        humidity: 82,
        gasLineTemperature: 30,
        gasLineHumidity: 78,
        ph: 7.1,
        flow: 0.0,
        gasSinceStartL: 12,
        sensorsReady: true,
        rssi: -52,
      }),
    );

    // Emitting message should NOT throw an uncaught exception
    expect(() => {
      mockMqttClient.emit("message", "nexgas/nexgas-001/telemetry", payload);
    }).not.toThrow();
  });

  it("detaches listeners properly", () => {
    bridge.detach();
    expect(bridge.getAttached()).toBe(false);

    mockMqttClient.emit("message", "nexgas/nexgas-001/status", Buffer.from("online"));
    expect(repos.status.getCurrent("nexgas-001")).toBeNull();
  });
});
