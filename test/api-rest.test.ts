import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { resetCommandRateLimits } from "../src/api/middleware/rate-limit.js";
import { Database } from "better-sqlite3";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public subscribe = (topics: any, opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => cb && cb(null);
  public end = (force: any, opts: any, cb: any) => cb && cb();
}

describe("REST API Endpoints", () => {
  let db: Database;
  let server: Server;
  let baseUrl: string;
  let adminToken: string;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
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
      username: "rest_admin",
      passwordHash: "dummy",
      role: "admin",
      isActive: true,
    });
    adminToken = await signAccessToken({
      sub: String(admin.id),
      username: admin.username,
      role: "admin",
    });

    mockMqttClient = new MockMqttClient();
    mqttService = new NexGasMqttService(mockMqttClient as unknown as MqttClient);

    const app = createApp(mqttService);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    setDatabase(null);
  });

  beforeEach(() => {
    resetCommandRateLimits();
  });

  // --------------------------------------------------------------------------
  // HEALTH & CONFIG
  // --------------------------------------------------------------------------

  it("GET /health returns liveness status and uptime", async () => {
    const res = await authedFetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.mqttConnected).toBe(false);
  });

  it("GET /health/ready returns readiness check and topic listing", async () => {
    const res = await authedFetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ready).toBe(true);
    expect(body.service).toBe("nexgas-backend");
    expect(Array.isArray(body.subscribedTopics)).toBe(true);
  });

  it("GET /api/config returns safe config with masked passwords", async () => {
    const res = await authedFetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.PORT).toBeDefined();
    if (body.MQTT_PASSWORD) {
      expect(body.MQTT_PASSWORD).toBe("[REDACTED]");
    }
  });

  // --------------------------------------------------------------------------
  // LATEST DATA
  // --------------------------------------------------------------------------

  describe("GET /api/telemetry/latest", () => {
    it("returns 400 for invalid device ID format", async () => {
      const res = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=invalid/id!`);
      expect(res.status).toBe(400);
    });

    it("returns 404 when no telemetry has been recorded yet", async () => {
      const res = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-999`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe("Not Found");
    });

    it("returns 200 with telemetry data and frontend-compatible mapping", async () => {
      repos.telemetry.insert({
        deviceId: "nexgas-001",
        receivedAt: "2026-10-30T10:00:00.000Z",
        deviceTimestamp: "2026-10-30T09:59:58.000Z",
        rawTimestamp: 1761000000,
        uptimeMs: 60000,
        h2sBefore: null, // Unavailable
        h2sAfter: 3.1,
        ch4Estimate: 65,
        leakPpm: 20,
        pressureDigesterKpa: 0.9,
        pressureCollectorKpa: 0.8,
        temperatureC: 33,
        humidityPct: 88,
        gasLineTemperatureC: 31,
        gasLineHumidityPct: 78,
        ph: 6.9,
        flowEstimateLpm: 0.1,
        gasSinceStartTotalL: 12,
        sensorsReady: true,
        rssi: -55,
        raw: {} as any,
      });

      const res = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deviceId).toBe("nexgas-001");
      expect(body.frontend.h2sBefore).toBeNull();
      expect(body.frontend.h2sAfter).toBe(3.1);
      expect(body.frontend.pressureDigester).toBe(0.9);
      expect(body.frontend.flow).toBe(0.1);
    });
  });

  describe("GET /api/state", () => {
    it("returns 404 when device state is missing", async () => {
      const res = await authedFetch(`${baseUrl}/api/state?deviceId=nexgas-999`);
      expect(res.status).toBe(404);
    });

    it("returns 200 with current state and frontendSystemState mapping", async () => {
      repos.state.save({
        deviceId: "nexgas-001",
        valveOpen: false,
        valveMode: "auto",
        filterWarning: false,
        leakWarning: false,
        filterHealth: 80,
        pressureCalibrated: true,
        phCalibrated: false,
        sensorsReady: true,
        buffered: 0,
        uptimeMs: 70000,
        firmware: "1.0.0",
        receivedAt: "2026-10-30T10:00:00.000Z",
      });

      const res = await authedFetch(`${baseUrl}/api/state?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.state.valveMode).toBe("auto");
      expect(body.frontendSystemState.valveOpen).toBe(false);
      expect(body.frontendSystemState.filterHealth).toBe(80);
      expect(body.frontendSystemState.telemetry.h2sAfter).toBe(3.1);
    });
  });

  describe("GET /api/status", () => {
    it("returns 404 when device status is missing", async () => {
      const res = await authedFetch(`${baseUrl}/api/status?deviceId=nexgas-999`);
      expect(res.status).toBe(404);
    });

    it("returns 200 with online/offline status", async () => {
      repos.status.save({
        deviceId: "nexgas-001",
        status: "online",
        receivedAt: "2026-10-30T10:00:00.000Z",
      });

      const res = await authedFetch(`${baseUrl}/api/status?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("online");
    });
  });

  // --------------------------------------------------------------------------
  // HISTORICAL ENDPOINTS
  // --------------------------------------------------------------------------

  describe("History Endpoints", () => {
    it("GET /api/history/telemetry supports pagination and query options", async () => {
      const res = await authedFetch(`${baseUrl}/api/history/telemetry?deviceId=nexgas-001&limit=10&offset=0`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
    });

    it("GET /api/history/telemetry returns 400 on invalid query values", async () => {
      const res = await authedFetch(`${baseUrl}/api/history/telemetry?limit=-1`);
      expect(res.status).toBe(400);
    });

    it("GET /api/history/events returns raw events and mapped notifications", async () => {
      repos.event.insert({
        deviceId: "nexgas-001",
        receivedAt: "2026-10-30T10:00:00.000Z",
        deviceTimestamp: "2026-10-30T09:59:59.000Z",
        uptimeMs: 1000,
        type: "valve_closed_leak",
        severity: "bahaya",
        message: "Solenoid ditutup paksa",
        raw: {} as any,
      });

      const res = await authedFetch(`${baseUrl}/api/history/events?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.notifications[0].category).toBe("peringatan");
      expect(body.notifications[0].badge).toBe("BAHAYA");
    });

    it("GET /api/history/state returns state transitions", async () => {
      const res = await authedFetch(`${baseUrl}/api/history/state?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /api/history/status returns status history", async () => {
      const res = await authedFetch(`${baseUrl}/api/history/status?deviceId=nexgas-001`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // COMMAND ENDPOINT
  // --------------------------------------------------------------------------

  describe("POST /api/command", () => {
    it("returns 400 on missing or invalid command payload", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on unsupported command structure", async () => {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { mode: "turbo" }, // Unsupported mode
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 503 when MQTT client is offline", async () => {
      // mock client is not connected
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { mode: "manual" },
        }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error).toBe("Service Unavailable");
    });

    it("returns 200 with honest 'published' status when connected, documenting ACK limitation", async () => {
      // Connect mock client
      mockMqttClient.emit("connect");

      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { valve: "open" },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("published");
      expect(body.verificationStatus).toBe("pending_execution");
      // Must not falsely claim the physical valve is already confirmed open
      expect(body.message).toContain("governed by ESP32 firmware safety checks");
      expect(body.protocolNote).toBeDefined();
    });

    it("returns 429 when rate limit is exceeded", async () => {
      mockMqttClient.emit("connect");

      // Send 10 commands (the maximum allowed)
      for (let i = 0; i < 10; i++) {
        await authedFetch(`${baseUrl}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: "nexgas-001",
            command: { mode: "manual" },
          }),
        });
      }

      // 11th command must trigger 429 Too Many Requests
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { mode: "manual" },
        }),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as any;
      expect(body.error).toBe("Too Many Requests");
    });
  });
});
