import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { MqttClient } from "mqtt";

class MockMqttClient extends EventEmitter {
  public subscribe = vi.fn((topics, opts, cb) => {
    if (cb) cb(null, topics.map((t: string) => ({ topic: t, qos: 1 })));
    return this;
  });

  public publish = vi.fn((topic, payload, opts, cb) => {
    if (cb) cb(null);
    return this;
  });

  public end = vi.fn((force, opts, cb) => {
    if (cb) cb();
    return this;
  });
}

describe("NexGasMqttService", () => {
  let mockClient: MockMqttClient;
  let service: NexGasMqttService;

  beforeEach(() => {
    mockClient = new MockMqttClient();
    service = new NexGasMqttService(mockClient as unknown as MqttClient);
  });

  it("builds compliant HiveMQ Cloud TLS options", () => {
    const options = service.getClientOptions();
    expect(options.protocol).toBe("mqtts");
    expect(options.port).toBe(8883);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.clean).toBe(true);
    expect(options.clientId).toContain("nexgas-backend");
  });

  it("subscribes to telemetry, state, status, and event topics on connect", () => {
    expect(service.getConnected()).toBe(false);

    mockClient.emit("connect");

    expect(service.getConnected()).toBe(true);
    expect(mockClient.subscribe).toHaveBeenCalledTimes(1);
    const subscribedTopics = mockClient.subscribe.mock.calls[0][0];
    expect(subscribedTopics).toEqual([
      "nexgas/nexgas-001/telemetry",
      "nexgas/nexgas-001/state",
      "nexgas/nexgas-001/status",
      "nexgas/nexgas-001/event",
    ]);
  });

  it("adjusts backoff upon reconnect events without exceeding maximum limit", () => {
    const initialBackoff = service.getCurrentBackoffMs();
    expect(initialBackoff).toBe(5000);

    mockClient.emit("reconnect");
    expect(service.getConnected()).toBe(false);
    expect(service.getCurrentBackoffMs()).toBe(7500); // 5000 * 1.5

    mockClient.emit("reconnect");
    expect(service.getCurrentBackoffMs()).toBe(11250);

    // Connecting resets backoff to default
    mockClient.emit("connect");
    expect(service.getCurrentBackoffMs()).toBe(5000);
  });

  it("routes incoming telemetry message and emits 'telemetry' event", async () => {
    const telemetrySpy = vi.fn();
    service.on("telemetry", telemetrySpy);

    const payload = Buffer.from(
      JSON.stringify({
        ts: 1761000000,
        uptimeMs: 12000,
        h2sBefore: -1,
        h2sAfter: 1.8,
        ch4: 70,
        leak: 15,
        pressureDigester: 0.8,
        pressureCollector: 0.7,
        temperature: 30,
        humidity: 80,
        gasLineTemperature: 29,
        gasLineHumidity: 75,
        ph: 7.0,
        flow: 0.2,
        gasSinceStartL: 10,
        sensorsReady: true,
        rssi: -50,
      }),
    );

    mockClient.emit("message", "nexgas/nexgas-001/telemetry", payload);

    expect(telemetrySpy).toHaveBeenCalledTimes(1);
    const received = telemetrySpy.mock.calls[0][0];
    expect(received.deviceId).toBe("nexgas-001");
    expect(received.h2sBefore).toBeNull();
    expect(received.h2sAfter).toBe(1.8);
  });

  it("routes incoming status message and emits 'status' event", () => {
    const statusSpy = vi.fn();
    service.on("status", statusSpy);

    mockClient.emit("message", "nexgas/nexgas-001/status", Buffer.from("offline"));

    expect(statusSpy).toHaveBeenCalledTimes(1);
    const status = statusSpy.mock.calls[0][0];
    expect(status.deviceId).toBe("nexgas-001");
    expect(status.status).toBe("offline");
  });

  it("emits 'parse_error' for corrupted payloads without crashing", () => {
    const errorSpy = vi.fn();
    service.on("parse_error", errorSpy);

    mockClient.emit("message", "nexgas/nexgas-001/state", Buffer.from("{ bad json "));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0].rawTopic).toBe("nexgas/nexgas-001/state");
  });

  it("publishes validated command to nexgas/{deviceId}/cmd with QoS 1", async () => {
    mockClient.emit("connect");

    const result = await service.publishCommand("nexgas-001", { mode: "manual" });

    expect(result.published).toBe(true);
    expect(result.topic).toBe("nexgas/nexgas-001/cmd");
    expect(mockClient.publish).toHaveBeenCalledWith(
      "nexgas/nexgas-001/cmd",
      JSON.stringify({ mode: "manual" }),
      { qos: 1 },
      expect.any(Function),
    );
  });

  it("rejects command publish when client is offline", async () => {
    // Client is disconnected
    await expect(
      service.publishCommand("nexgas-001", { mode: "manual" }),
    ).rejects.toThrow("Cannot publish command: MQTT client is offline");
  });
});