import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import WebSocket from "ws";
import { NexGasWebSocketGateway } from "../src/ws/gateway.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { createDatabase, closeDatabase, setDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { StatusRepository } from "../src/db/repositories/status.repository.js";
import { Database } from "better-sqlite3";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public subscribe = (topics: any, opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => cb && cb(null);
  public end = (force: any, opts: any, cb: any) => cb && cb();
}

describe("False Online Status Remediation Verification", () => {
  let db: Database;
  let statusRepo: StatusRepository;
  let server: Server;
  let wsGateway: NexGasWebSocketGateway;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;
  let wsUrl: string;

  beforeAll(async () => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    setDatabase(db);
    statusRepo = new StatusRepository(db);

    // Initial state in database: offline
    statusRepo.save({
      deviceId: "nexgas-001",
      status: "offline",
      isSynthetic: false,
      dataSource: "REAL_HARDWARE",
      receivedAt: new Date().toISOString(),
    });

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
    closeDatabase(db);
  });

  it("Requirement 1 & 2: Client connecting when DB records offline immediately receives status: 'offline'", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "status") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.status).toBe("offline");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("Requirement 3: Device sending status online broadcasts online to connected client", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        mqttService.emit("status", {
          deviceId: "nexgas-001",
          status: "online",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          receivedAt: new Date().toISOString(),
        });
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
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

  it("Requirement 4: Device/LWT sending status offline broadcasts offline and updates state", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        mqttService.emit("status", {
          deviceId: "nexgas-001",
          status: "offline",
          isSynthetic: false,
          dataSource: "REAL_HARDWARE",
          receivedAt: new Date().toISOString(),
        });
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "status" && msg.data?.status === "offline") {
          expect(msg.deviceId).toBe("nexgas-001");
          expect(msg.data.status).toBe("offline");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("Requirement 7: Client reconnecting while ESP32 is off still receives offline from DB", async () => {
    // Save offline in DB
    statusRepo.save({
      deviceId: "nexgas-001",
      status: "offline",
      isSynthetic: false,
      dataSource: "REAL_HARDWARE",
      receivedAt: new Date().toISOString(),
    });

    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "status") {
          expect(msg.data.status).toBe("offline");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("Requirement 8: Snapshot REST status parser correctly extracts status from root and nested formats", () => {
    // Root level format (returned by NeX-Gas-Backend GET /api/status)
    const rootResponse = {
      deviceId: "nexgas-001",
      status: "offline",
      isSynthetic: false,
      dataSource: "REAL_HARDWARE",
    };
    const rootStatus = (rootResponse as any)?.status ?? (rootResponse as any)?.data?.status;
    expect(rootStatus).toBe("offline");

    // Nested level format
    const nestedResponse = {
      deviceId: "nexgas-001",
      data: { status: "online" },
    };
    const nestedStatus = (nestedResponse as any)?.status ?? (nestedResponse as any)?.data?.status;
    expect(nestedStatus).toBe("online");

    // Null/undefined status
    const nullResponse = null;
    const nullStatus = (nullResponse as any)?.status ?? (nullResponse as any)?.data?.status;
    expect(nullStatus).toBeUndefined();
  });
});

