import { describe, it, expect } from "vitest";
import { parseIncomingMessage } from "../src/mqtt/parser.js";

describe("MQTT Message Parser & Error Resilience", () => {
  it("parses valid telemetry payload into normalized domain object", () => {
    const topic = "nexgas/nexgas-001/telemetry";
    const payload = JSON.stringify({
      ts: 1761000000,
      uptimeMs: 50000,
      h2sBefore: -1,
      h2sAfter: 2.5,
      ch4: 65,
      leak: 20,
      pressureDigester: 1.1,
      pressureCollector: 0.9,
      temperature: 32,
      humidity: 85,
      gasLineTemperature: 30,
      gasLineHumidity: 80,
      ph: 6.9,
      flow: 0.1,
      gasSinceStartL: 5.5,
      sensorsReady: true,
      rssi: -60,
    });

    const result = parseIncomingMessage(topic, payload);
    expect(result.success).toBe(true);
    if (result.success && result.type === "telemetry") {
      expect(result.data.deviceId).toBe("nexgas-001");
      expect(result.data.h2sBefore).toBeNull();
      expect(result.data.h2sAfter).toBe(2.5);
    }
  });

  it("handles malformed JSON without throwing and returns a clean error result", () => {
    const topic = "nexgas/nexgas-001/telemetry";
    const malformed = "{ this is not valid JSON, missing quotes: 123 ";

    expect(() => {
      const result = parseIncomingMessage(topic, malformed);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Malformed JSON");
        expect(result.rawTopic).toBe(topic);
      }
    }).not.toThrow();
  });

  it("handles empty or non-object JSON payloads safely", () => {
    const topic = "nexgas/nexgas-001/state";

    expect(() => {
      const resultNum = parseIncomingMessage(topic, "12345");
      expect(resultNum.success).toBe(false);

      const resultArr = parseIncomingMessage(topic, "[]");
      expect(resultArr.success).toBe(false);

      const resultNull = parseIncomingMessage(topic, "null");
      expect(resultNull.success).toBe(false);
    }).not.toThrow();
  });

  it("handles payload with missing required fields safely", () => {
    const topic = "nexgas/nexgas-001/state";
    const partial = JSON.stringify({ valveOpen: true }); // Missing remaining state fields

    const result = parseIncomingMessage(topic, partial);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("State validation failed");
    }
  });

  it("handles bare string status gracefully", () => {
    const topic = "nexgas/nexgas-001/status";
    const result = parseIncomingMessage(topic, "online");

    expect(result.success).toBe(true);
    if (result.success && result.type === "status") {
      expect(result.data.status).toBe("online");
      expect(result.data.deviceId).toBe("nexgas-001");
    }
  });

  it("rejects messages on unrecognized topics without throwing", () => {
    const topic = "unknown/sensor/topic";
    const result = parseIncomingMessage(topic, '{"some":"data"}');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unrecognized or invalid NEX-GAS topic");
    }
  });
});