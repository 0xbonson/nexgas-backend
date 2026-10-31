import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import WebSocket from "ws";
import { NexGasWebSocketGateway } from "../src/ws/gateway.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
} from "../src/types/index.js";

class MockMqttClient extends EventEmitter {
  public subscribe = (topics: any, opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => cb && cb(null);
  public end = (force: any, opts: any, cb: any) => cb && cb();
}

describe("NexGasWebSocketGateway", () => {
  let server: Server;
  let wsGateway: NexGasWebSocketGateway;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
  let wsUrl: string;

  beforeAll(async () => {
    mockMqttClient = new MockMqttClient();
    mqttService = new NexGasMqttService(mockMqttClient as unknown as MqttClient);
    wsGateway = new NexGasWebSocketGateway(mqttService);

    server = createServer();
    wsGateway.attach(server, "/ws");

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await wsGateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to the WebSocket gateway", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        expect(wsGateway.getClientCount()).toBeGreaterThanOrEqual(1);
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
  });

  it("responds to client ping with a pong message", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") {
          expect(msg.timestamp).toBeDefined();
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("pushes initial device status to client upon connection", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "status") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data?.status).toBeDefined();
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("broadcasts telemetry to connected clients when MQTT service receives telemetry", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const telemetryPayload: NormalizedTelemetry = {
          deviceId: "nexgas-001",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          deviceTimestamp: "2026-10-30T10:00:00.000Z",
          receivedAt: new Date().toISOString(),
          rawTimestamp: 1730282400,
          uptimeMs: 120000,
          h2sBefore: null,
          h2sAfter: 2.1,
          ch4Estimate: 62.5,
          leakPpm: 0,
          pressureDigesterKpa: 101.8,
          pressureCollectorKpa: 101.2,
          temperatureC: 37.2,
          humidityPct: 88.4,
          gasLineTemperatureC: 36.8,
          gasLineHumidityPct: 85.0,
          ph: 7.2,
          flowEstimateLpm: 3.5,
          gasSinceStartTotalL: 142.8,
          sensorsReady: true,
          rssi: -65,
          raw: {
            ts: 1730282400,
            uptimeMs: 120000,
            h2sBefore: -1,
            h2sAfter: 2.1,
            ch4: 62.5,
            leak: 0,
            pressureDigester: 101.8,
            pressureCollector: 101.2,
            temperature: 37.2,
            humidity: 88.4,
            gasLineTemperature: 36.8,
            gasLineHumidity: 85.0,
            ph: 7.2,
            flow: 3.5,
            gasSinceStartL: 142.8,
            sensorsReady: true,
            rssi: -65,
          },
        };

        // Emit from mqttService
        mqttService.emit("telemetry", telemetryPayload);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "telemetry") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.h2sBefore).toBeNull();
          expect(msg.data.h2sAfter).toBe(2.1);
          // Frontend mapping check
          expect(msg.frontend.h2sBefore).toBeNull();
          expect(msg.frontend.h2sAfter).toBe(2.1);
          expect(msg.frontend.ch4).toBe(62.5);
          expect(msg.frontend.flow).toBe(3.5);
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("broadcasts state updates to connected clients when MQTT service receives state", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const statePayload: NormalizedDeviceState = {
          deviceId: "nexgas-001",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          receivedAt: new Date().toISOString(),
          uptimeMs: 150000,
          valveOpen: true,
          valveMode: "auto",
          filterWarning: false,
          leakWarning: false,
          filterHealth: 95,
          pressureCalibrated: true,
          phCalibrated: true,
          sensorsReady: true,
          buffered: 0,
          firmware: "1.0.0",
        };

        mqttService.emit("state", statePayload);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "state") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.valveOpen).toBe(true);
          expect(msg.data.valveMode).toBe("auto");
          expect(msg.frontend.valveOpen).toBe(true);
          expect(msg.frontend.filterHealth).toBe(95);
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("broadcasts status changes to connected clients", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const statusPayload: NormalizedDeviceStatus = {
          deviceId: "nexgas-001",
          status: "online",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          receivedAt: new Date().toISOString(),
        };

        mqttService.emit("status", statusPayload);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "status" && msg.data?.status === "online") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.status).toBe("online");
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("broadcasts hardware events with frontend notification mapping", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        const eventPayload: NormalizedDeviceEvent = {
          deviceId: "nexgas-001",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          deviceTimestamp: "2026-10-30T10:05:00.000Z",
          receivedAt: new Date().toISOString(),
          uptimeMs: 180000,
          type: "valve_closed_leak",
          severity: "waspada",
          message: "Solenoid valve closed due to methane leak detection",
          raw: {
            ts: 1730282700,
            uptimeMs: 180000,
            type: "valve_closed_leak",
            severity: "waspada",
            message: "Solenoid valve closed due to methane leak detection",
          },
        };

        mqttService.emit("event", eventPayload);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "event") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.severity).toBe("waspada");
          expect(msg.notification.category).toBe("peringatan");
          expect(msg.notification.badge).toBe("WASPADA");
          expect(msg.notification.title).toBe("VALVE CLOSED LEAK");
          expect(msg.notification.body).toContain("Solenoid valve closed");
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });

  it("handles broken client or unparseable messages gracefully", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // Send malformed non-JSON message
        ws.send("NOT_JSON_AT_ALL");

        // Send a valid ping immediately afterwards to confirm gateway is still functioning
        ws.send(JSON.stringify({ type: "ping" }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") {
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
    });
  });
});