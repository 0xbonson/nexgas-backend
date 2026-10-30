import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "http";
import { createApp } from "../src/app.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public subscribe = (topics: any, opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => cb && cb(null);
  public end = (force: any, opts: any, cb: any) => cb && cb();
}

describe("CORS Restrictions & Security Headers", () => {
  let server: Server;
  let baseUrl: string;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;

  beforeAll(async () => {
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
  });

  it("permits requests from localhost:3000 and sets Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("permits requests from https://nex-gas.github.io", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: "https://nex-gas.github.io",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://nex-gas.github.io");
  });

  it("allows requests without an Origin header (e.g. backend curl or node fetch)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("rejects requests from disallowed origins with 403 Forbidden", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: "https://malicious-attacker-website.com",
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Forbidden");
    expect(body.message).toContain("CORS origin not allowed");
  });
});
