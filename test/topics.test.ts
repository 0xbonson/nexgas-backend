import { describe, it, expect } from "vitest";
import {
  parseTopic,
  buildTopic,
  isValidDeviceId,
  getSubscriptionTopics,
  isMqttTopicMatch,
} from "../src/mqtt/topics.js";

describe("MQTT Topics", () => {
  describe("isValidDeviceId", () => {
    it("accepts valid alphanumeric device IDs with dashes and underscores", () => {
      expect(isValidDeviceId("nexgas-001")).toBe(true);
      expect(isValidDeviceId("device_123")).toBe(true);
      expect(isValidDeviceId("NEXGAS-UNIT-99")).toBe(true);
    });

    it("rejects invalid characters, wildcards, or empty strings", () => {
      expect(isValidDeviceId("")).toBe(false);
      expect(isValidDeviceId("nexgas/001")).toBe(false);
      expect(isValidDeviceId("nexgas+001")).toBe(false);
      expect(isValidDeviceId("nexgas#001")).toBe(false);
      expect(isValidDeviceId("nexgas$")).toBe(false);
      expect(isValidDeviceId("   ")).toBe(false);
    });
  });

  describe("buildTopic", () => {
    it("builds correct topic paths for all topic types", () => {
      expect(buildTopic("nexgas-001", "telemetry")).toBe("nexgas/nexgas-001/telemetry");
      expect(buildTopic("nexgas-001", "state")).toBe("nexgas/nexgas-001/state");
      expect(buildTopic("nexgas-001", "status")).toBe("nexgas/nexgas-001/status");
      expect(buildTopic("nexgas-001", "event")).toBe("nexgas/nexgas-001/event");
      expect(buildTopic("nexgas-001", "cmd")).toBe("nexgas/nexgas-001/cmd");
    });

    it("throws when building a topic with invalid deviceId", () => {
      expect(() => buildTopic("invalid/id", "telemetry")).toThrow();
    });
  });

  describe("parseTopic", () => {
    it("successfully parses valid NEX-GAS topics", () => {
      const parsed = parseTopic("nexgas/nexgas-001/telemetry");
      expect(parsed).toEqual({
        raw: "nexgas/nexgas-001/telemetry",
        deviceId: "nexgas-001",
        type: "telemetry",
      });

      const parsedState = parseTopic("nexgas/unit-2/state");
      expect(parsedState).toEqual({
        raw: "nexgas/unit-2/state",
        deviceId: "unit-2",
        type: "state",
      });
    });

    it("returns null for malformed topics", () => {
      expect(parseTopic("")).toBeNull();
      expect(parseTopic("nexgas")).toBeNull();
      expect(parseTopic("nexgas/nexgas-001")).toBeNull();
      expect(parseTopic("otherprefix/nexgas-001/telemetry")).toBeNull();
      expect(parseTopic("nexgas/nexgas-001/unknownType")).toBeNull();
      expect(parseTopic("nexgas/nexgas-001/telemetry/extra")).toBeNull();
      expect(parseTopic("nexgas/invalid!id/telemetry")).toBeNull();
    });
  });

  describe("getSubscriptionTopics", () => {
    it("returns wildcard topics when no device IDs are specified", () => {
      const topics = getSubscriptionTopics([]);
      expect(topics).toContain("nexgas/+/telemetry");
      expect(topics).toContain("nexgas/+/state");
      expect(topics).toContain("nexgas/+/status");
      expect(topics).toContain("nexgas/+/event");
      expect(topics).not.toContain("nexgas/+/cmd");
    });

    it("returns specific device topics when devices are given", () => {
      const topics = getSubscriptionTopics(["nexgas-001"]);
      expect(topics).toEqual([
        "nexgas/nexgas-001/telemetry",
        "nexgas/nexgas-001/state",
        "nexgas/nexgas-001/status",
        "nexgas/nexgas-001/event",
      ]);
    });
  });

  describe("isMqttTopicMatch", () => {
    it("matches exact topics and wildcard patterns", () => {
      expect(isMqttTopicMatch("nexgas/+/telemetry", "nexgas/nexgas-001/telemetry")).toBe(true);
      expect(isMqttTopicMatch("nexgas/+/state", "nexgas/nexgas-001/state")).toBe(true);
      expect(isMqttTopicMatch("nexgas/#", "nexgas/nexgas-001/event")).toBe(true);
      expect(isMqttTopicMatch("nexgas/+/telemetry", "nexgas/nexgas-001/state")).toBe(false);
      expect(isMqttTopicMatch("nexgas/+/telemetry", "other/nexgas-001/telemetry")).toBe(false);
    });
  });
});