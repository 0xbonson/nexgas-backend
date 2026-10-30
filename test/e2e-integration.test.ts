import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Server } from "http";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { createDatabase, closeDatabase, setDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { MqttDatabaseBridge } from "../src/db/bridge.js";
import { TelemetryRepository } from "../src/db/repositories/telemetry.repository.js";
import { StateRepository } from "../src/db/repositories/state.repository.js";
import { StatusRepository } from "../src/db/repositories/status.repository.js";
import { EventRepository } from "../src/db/repositories/event.repository.js";
import { UserRepository } from "../src/db/repositories/user.repository.js";
import { signAccessToken } from "../src/utils/jwt.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { NexGasWebSocketGateway } from "../src/ws/gateway.js";
import { resetCommandRateLimits } from "../src/api/middleware/rate-limit.js";
import { Database } from "better-sqlite3";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public connected: boolean = true;
  public publishedMessages: Array<{ topic: string; message: string; opts: any }> = [];

  public subscribe = (topics: any, opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => {
    this.publishedMessages.push({ topic, message: payload.toString(), opts });
    if (cb) cb(null);
  };
  public end = (force: any, opts: any, cb: any) => {
    this.connected = false;
    if (cb) cb();
  };
}

describe("End-to-End System Integration (Phase 6B)", () => {
  let db: Database;
  let server: Server;
  let baseUrl: string;
  let wsUrl: string;
  let adminToken: string;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
  let wsGateway: NexGasWebSocketGateway;
  let bridge: MqttDatabaseBridge;
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
      username: "e2e_admin",
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

    bridge = new MqttDatabaseBridge(mqttService, repos);
    bridge.attach();

    const app = createApp(mqttService);
    wsGateway = new NexGasWebSocketGateway(mqttService);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
          wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
        }
        resolve();
      });
    });

    wsGateway.attach(server, "/ws");
    mockMqttClient.emit("connect");
  });

  afterAll(async () => {
    await wsGateway.close();
    bridge.detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    setDatabase(null);
  });

  beforeEach(() => {
    resetCommandRateLimits();
    mockMqttClient.publishedMessages = [];
    mockMqttClient.emit("connect");
  });

  // ==========================================================================
  // 1. FULL TELEMETRY FLOW: MQTT -> Validation -> DB -> REST -> WS Broadcast
  // ==========================================================================
  it("E2E: Ingests telemetry via MQTT, persists with NULL preservation, serves via REST, and broadcasts via WS", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const rawPayload = JSON.stringify({
          ts: 1730282400,
          uptimeMs: 125000,
          h2sBefore: -1, // Upstream sensor not installed
          h2sAfter: 2.3,
          ch4: 64.5,
          leak: 0,
          pressureDigester: 1.45,
          pressureCollector: 0.95,
          temperature: 36.5,
          humidity: 86.0,
          gasLineTemperature: 34.0,
          gasLineHumidity: 82.0,
          ph: 7.15,
          flow: 0.05,
          gasSinceStartL: 145.2,
          sensorsReady: true,
          rssi: -62,
        });

        mockMqttClient.emit("message", "nexgas/nexgas-001/telemetry", Buffer.from(rawPayload));
      });

      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "telemetry" && msg.deviceId === "nexgas-001") {
          try {
            expect(msg.data.h2sBefore).toBeNull();
            expect(msg.data.h2sAfter).toBe(2.3);
            expect(msg.data.ch4Estimate).toBe(64.5);
            expect(msg.frontend.h2sBefore).toBeNull();
            expect(msg.frontend.h2sAfter).toBe(2.3);
            expect(msg.frontend.ch4).toBe(64.5);

            const res = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-001`);
            expect(res.status).toBe(200);
            const body = (await res.json()) as any;
            expect(body.deviceId).toBe("nexgas-001");
            expect(body.frontend.h2sBefore).toBeNull();
            expect(body.frontend.h2sAfter).toBe(2.3);
            expect(body.data.h2sBefore).toBeNull();

            ws.close();
            resolve();
          } catch (e) {
            ws.close();
            reject(e);
          }
        }
      });

      ws.on("error", reject);
    });
  });

  // ==========================================================================
  // 2. FULL STATE FLOW: MQTT -> UPSERT DB -> REST -> WS Broadcast
  // ==========================================================================
  it("E2E: Ingests device state, updates current state in DB, serves via REST, and broadcasts via WS", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const rawState = JSON.stringify({
          valveOpen: false,
          valveMode: "auto",
          filterWarning: false,
          leakWarning: false,
          filterHealth: 94,
          pressureCalibrated: true,
          phCalibrated: true,
          sensorsReady: true,
          buffered: 0,
          uptimeMs: 130000,
          firmware: "1.0.0",
        });

        mockMqttClient.emit("message", "nexgas/nexgas-001/state", Buffer.from(rawState));
      });

      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "state" && msg.deviceId === "nexgas-001") {
          try {
            expect(msg.data.valveMode).toBe("auto");
            expect(msg.data.valveOpen).toBe(false);
            expect(msg.frontend.filterHealth).toBe(94);

            const res = await authedFetch(`${baseUrl}/api/state?deviceId=nexgas-001`);
            expect(res.status).toBe(200);
            const body = (await res.json()) as any;
            expect(body.state.valveMode).toBe("auto");
            expect(body.state.pressureCalibrated).toBe(true);

            ws.close();
            resolve();
          } catch (e) {
            ws.close();
            reject(e);
          }
        }
      });

      ws.on("error", reject);
    });
  });

  // ==========================================================================
  // 3. FULL HARDWARE EVENT FLOW: MQTT -> DB -> REST -> WS Notification
  // ==========================================================================
  it("E2E: Ingests hardware safety event, persists, provides notification mapping in WS, and logs to history", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const rawEvent = JSON.stringify({
          ts: 1730282600,
          uptimeMs: 140000,
          type: "valve_closed_leak",
          severity: "waspada",
          message: "Solenoid valve closed automatically due to methane leak threshold",
        });

        mockMqttClient.emit("message", "nexgas/nexgas-001/event", Buffer.from(rawEvent));
      });

      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "event" && msg.deviceId === "nexgas-001") {
          try {
            expect(msg.data.severity).toBe("waspada");
            expect(msg.notification.category).toBe("peringatan");
            expect(msg.notification.badge).toBe("WASPADA");
            expect(msg.notification.title).toBe("VALVE CLOSED LEAK");

            const res = await authedFetch(`${baseUrl}/api/history/events?deviceId=nexgas-001&severity=waspada`);
            expect(res.status).toBe(200);
            const history = (await res.json()) as any;
            expect(history.items.length).toBeGreaterThanOrEqual(1);
            expect(history.items[0].type).toBe("valve_closed_leak");

            ws.close();
            resolve();
          } catch (e) {
            ws.close();
            reject(e);
          }
        }
      });

      ws.on("error", reject);
    });
  });

  // ==========================================================================
  // 4. COMMAND DISPATCH FLOW: REST -> MQTT Publish -> Honest Execution Status
  // ==========================================================================
  it("E2E: Dispatches command via POST /api/command, publishes to MQTT topic, and returns honest pending disclaimer", async () => {
    const res = await authedFetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "close" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("published");
    expect(body.verificationStatus).toBe("pending_execution");
    expect(body.message).toContain("Physical execution is governed by ESP32 firmware safety checks");
    expect(body.protocolNote).toContain("Firmware does not emit correlated command ACKs");

    expect(mockMqttClient.publishedMessages.length).toBe(1);
    expect(mockMqttClient.publishedMessages[0].topic).toBe("nexgas/nexgas-001/cmd");
    expect(JSON.parse(mockMqttClient.publishedMessages[0].message)).toEqual({ valve: "close" });

    // Verify backend did not optimistically mutate state
    const stateRes = await authedFetch(`${baseUrl}/api/state?deviceId=nexgas-001`);
    const stateBody = (await stateRes.json()) as any;
    expect(stateBody.state.valveMode).toBe("auto");
  });

  // ==========================================================================
  // 5. RESILIENCE: Broker Offline, Corrupted JSON, Rate Limiting, Invalid IDs
  // ==========================================================================
  it("E2E: Rejects command when broker is offline with HTTP 503", async () => {
    mockMqttClient.emit("close");

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

    mockMqttClient.emit("connect");
  });

  it("E2E: Enforces sliding-window rate limit on commands with HTTP 429", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await authedFetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "nexgas-001",
          command: { tare: true },
        }),
      });
      expect(res.status).toBe(200);
    }

    const blockedRes = await authedFetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { tare: true },
      }),
    });

    expect(blockedRes.status).toBe(429);
    const body = (await blockedRes.json()) as any;
    expect(body.error).toBe("Too Many Requests");
  });

  it("E2E: Rejects invalid or dangerous device ID with HTTP 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "nexgas/../malicious-id",
        command: { mode: "manual" },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("E2E: Safely isolates corrupted JSON payload on MQTT topic without crashing service", async () => {
    mockMqttClient.emit("message", "nexgas/nexgas-001/telemetry", Buffer.from("{{malformed-json"));

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it("E2E: Safely handles unrecorded device query with clean 404", async () => {
    const res = await authedFetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-nonexistent`);
    expect(res.status).toBe(404);
  });
});
