import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "http";
import { createApp } from "../src/app.js";
import { createDatabase, closeDatabase, setDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { TelemetryRepository } from "../src/db/repositories/telemetry.repository.js";
import { StateRepository } from "../src/db/repositories/state.repository.js";
import { StatusRepository } from "../src/db/repositories/status.repository.js";
import { EventRepository } from "../src/db/repositories/event.repository.js";
import { UserRepository } from "../src/db/repositories/user.repository.js";
import { signAccessToken } from "../src/utils/jwt.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { Database } from "better-sqlite3";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";
import { config } from "../src/config/index.js";

class MockMqttClient extends EventEmitter {
  public subscribe = (_topics: any, _opts: any, cb: any) => cb && cb(null, []);
  public publish = (_topic: any, _payload: any, _opts: any, cb: any) => cb && cb(null);
  public end = (_force: any, _opts: any, cb: any) => cb && cb();
}

describe("Hardened PUBLIC_MQTT_TEST_MODE & Synthetic Data Separation", () => {
  let db: Database;
  let server: Server;
  let baseUrl: string;
  let adminToken: string;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
  let originalPublicMode: boolean;
  let repos: {
    telemetry: TelemetryRepository;
    state: StateRepository;
    status: StatusRepository;
    event: EventRepository;
  };

  function authedFetch(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${adminToken}`);
    }
    return fetch(url, { ...options, headers });
  }

  beforeAll(async () => {
    originalPublicMode = config.PUBLIC_MQTT_TEST_MODE;
    // Enable PUBLIC_MQTT_TEST_MODE for this test suite
    (config as any).PUBLIC_MQTT_TEST_MODE = true;

    db = createDatabase({ inMemory: true });
    runMigrations(db);
    setDatabase(db);

    repos = {
      telemetry: new TelemetryRepository(db),
      state: new StateRepository(db),
      status: new StatusRepository(db),
      event: new EventRepository(db),
    };

    const userRepo = new UserRepository(db);
    const admin = userRepo.createUser({
      username: "safety_admin",
      passwordHash: "dummyhash",
      role: "admin",
      isActive: true,
    });
    adminToken = await signAccessToken({
      sub: String(admin.id),
      username: admin.username,
      role: admin.role,
    });

    mockMqttClient = new MockMqttClient();
    mqttService = new NexGasMqttService(mockMqttClient as unknown as MqttClient);
    (mqttService as any).isConnected = true;

    const app = createApp(mqttService);
    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server.once("listening", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    (config as any).PUBLIC_MQTT_TEST_MODE = originalPublicMode;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
  });

  describe("Priority 1: Strict Blocking of ALL Commands in PUBLIC_MQTT_TEST_MODE", () => {
    it("rejects 'valve: open' command with HTTP 403 Forbidden", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { valve: "open" },
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE");
    });

    it("rejects 'mode: manual' command with HTTP 403 Forbidden", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { mode: "manual" },
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE");
    });

    it("rejects 'tare: true' command with HTTP 403 Forbidden", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { tare: true },
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE");
    });

    it("rejects 'cal_pressure_point' calibration command with HTTP 403 Forbidden", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { cal_pressure_point: { sensor: "digester", kpa: 2.5 } },
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE");
    });

    it("rejects internal mqttService.publishCommand call directly when in PUBLIC_MQTT_TEST_MODE", async () => {
      await expect(
        mqttService.publishCommand("nexgas-001", { tare: true }),
      ).rejects.toThrow("All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE for safety");
    });
  });

  describe("Priority 2: Namespace & Synthetic Data Isolation", () => {
    it("explicitly marks synthetic demo telemetry as isSynthetic: true and dataSource: SYNTHETIC_DEMO", () => {
      const rawPayload = {
        ts: 1793366400,
        uptimeMs: 60000,
        h2sBefore: -1,
        h2sAfter: 5.0,
        ch4: 60.0,
        leak: 0,
        pressureDigester: 1.2,
        pressureCollector: 2.0,
        temperature: 28.0,
        humidity: 60.0,
        gasLineTemperature: 27.0,
        gasLineHumidity: 62.0,
        ph: 7.0,
        flow: 0.5,
        gasSinceStartL: 10.0,
        sensorsReady: true,
        rssi: -65,
      };

      const result = mqttService.handleIncomingMessage(
        "nexgas/demo-synthetic/telemetry",
        JSON.stringify(rawPayload),
      );

      expect(result.success).toBe(true);
      if (result.success && result.type === "telemetry") {
        expect(result.data.deviceId).toBe("demo-synthetic");
        expect(result.data.isSynthetic).toBe(true);
        expect(result.data.dataSource).toBe("SYNTHETIC_DEMO");
      }
    });

    it("explicitly marks real device telemetry as isSynthetic: false and dataSource: REAL_HARDWARE", () => {
      const rawPayload = {
        ts: 1793366400,
        uptimeMs: 70000,
        h2sBefore: -1,
        h2sAfter: 4.2,
        ch4: 64.0,
        leak: 0,
        pressureDigester: 1.3,
        pressureCollector: 2.1,
        temperature: 28.5,
        humidity: 59.0,
        gasLineTemperature: 27.5,
        gasLineHumidity: 61.0,
        ph: 7.1,
        flow: 0.6,
        gasSinceStartL: 12.0,
        sensorsReady: true,
        rssi: -58,
      };

      const result = mqttService.handleIncomingMessage(
        "nexgas/nexgas-001/telemetry",
        JSON.stringify(rawPayload),
      );

      expect(result.success).toBe(true);
      if (result.success && result.type === "telemetry") {
        expect(result.data.deviceId).toBe("nexgas-001");
        expect(result.data.isSynthetic).toBe(false);
        expect(result.data.dataSource).toBe("REAL_HARDWARE");
      }
    });

    it("separates storage: querying nexgas-001 does not return demo-synthetic data", async () => {
      // Insert synthetic data for demo-synthetic
      repos.telemetry.insert({
        deviceId: "demo-synthetic",
        isSynthetic: true,
        dataSource: "SYNTHETIC_DEMO",
        receivedAt: new Date().toISOString(),
        deviceTimestamp: "2026-10-30T12:00:00.000Z",
        rawTimestamp: 1793366400,
        uptimeMs: 99999,
        h2sBefore: null,
        h2sAfter: 99.9,
        ch4Estimate: 99.9,
        leakPpm: 0,
        pressureDigesterKpa: 9.9,
        pressureCollectorKpa: 9.9,
        temperatureC: 99.9,
        humidityPct: 99.9,
        gasLineTemperatureC: 99.9,
        gasLineHumidityPct: 99.9,
        ph: 9.9,
        flowEstimateLpm: 9.9,
        gasSinceStartTotalL: 99.9,
        sensorsReady: true,
        rssi: -50,
        raw: {} as any,
      });

      // Query GET /api/telemetry/latest?deviceId=nexgas-001
      const realRes = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-001`);
      if (realRes.ok) {
        const realJson = await realRes.json();
        expect(realJson.deviceId).toBe("nexgas-001");
        expect(realJson.isSynthetic).toBe(false);
        expect(realJson.dataSource).toBe("REAL_HARDWARE");
        expect(realJson.data.ch4Estimate).not.toBe(99.9);
      }

      // Query GET /api/demo/telemetry
      const demoRes = await authedFetch(`${baseUrl}/api/demo/telemetry`);
      expect(demoRes.status).toBe(200);
      const demoJson = await demoRes.json();
      expect(demoJson.deviceId).toBe("demo-synthetic");
      expect(demoJson.isSynthetic).toBe(true);
      expect(demoJson.dataSource).toBe("SYNTHETIC_DEMO");
      expect(demoJson.data.ch4Estimate).toBe(99.9);
    });
  });
});
