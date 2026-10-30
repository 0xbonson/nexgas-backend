import { describe, it, expect } from "vitest";
import {
  rawTelemetrySchema,
  normalizeTelemetry,
} from "../src/validation/telemetry.schema.js";
import {
  rawStateSchema,
  normalizeDeviceState,
} from "../src/validation/state.schema.js";
import {
  parseStatusPayload,
  normalizeDeviceStatus,
} from "../src/validation/status.schema.js";
import {
  rawEventSchema,
  normalizeDeviceEvent,
} from "../src/validation/event.schema.js";
import { commandSchema } from "../src/validation/command.schema.js";
import { RawTelemetryPayload } from "../src/types/index.js";

describe("Payload Validation & Normalization", () => {
  describe("Telemetry Payload", () => {
    const validSample: RawTelemetryPayload = {
      ts: 1761000000,
      uptimeMs: 123456,
      h2sBefore: -1, // Unavailable (2nd sensor not installed)
      h2sAfter: 3.2,
      ch4: 68.0,
      leak: 30.0,
      pressureDigester: 0.72,
      pressureCollector: 0.85,
      temperature: 33.4,
      humidity: 91.0,
      gasLineTemperature: 32.1,
      gasLineHumidity: 88.0,
      ph: 6.8,
      flow: 0.0,
      gasSinceStartL: 12.5,
      sensorsReady: true,
      rssi: -54,
    };

    it("successfully validates full telemetry conforming to firmware contract", () => {
      const parsed = rawTelemetrySchema.safeParse(validSample);
      expect(parsed.success).toBe(true);
    });

    it("normalizes -1 sensor values to null without fabricating zero", () => {
      const normalized = normalizeTelemetry("nexgas-001", validSample, new Date("2026-10-30T10:00:00Z"));

      expect(normalized.h2sBefore).toBeNull();
      expect(normalized.h2sBefore).not.toBe(0);
      expect(normalized.h2sAfter).toBe(3.2);
      expect(normalized.ch4Estimate).toBe(68.0);
      expect(normalized.pressureDigesterKpa).toBe(0.72);
      expect(normalized.raw.h2sBefore).toBe(-1); // Raw value preserved
    });

    it("normalizes ts = 0 (unsynced NTP) to null deviceTimestamp while preserving server receivedAt", () => {
      const sampleNoNtp: RawTelemetryPayload = {
        ...validSample,
        ts: 0,
      };

      const normalized = normalizeTelemetry("nexgas-001", sampleNoNtp, new Date("2026-10-30T10:00:00Z"));
      expect(normalized.deviceTimestamp).toBeNull();
      expect(normalized.rawTimestamp).toBe(0);
      expect(normalized.uptimeMs).toBe(123456);
      expect(normalized.receivedAt).toBe("2026-10-30T10:00:00.000Z");
    });

    it("converts valid NTP epoch seconds into ISO 8601 UTC timestamp", () => {
      const normalized = normalizeTelemetry("nexgas-001", validSample);
      expect(normalized.deviceTimestamp).toBe(new Date(1761000000 * 1000).toISOString());
    });

    it("rejects telemetry with missing required fields", () => {
      const invalid = { ts: 1761000000 };
      const parsed = rawTelemetrySchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Device State Payload", () => {
    const validState = {
      valveOpen: false,
      valveMode: "auto" as const,
      filterWarning: false,
      leakWarning: false,
      filterHealth: 72,
      pressureCalibrated: true,
      phCalibrated: false,
      sensorsReady: true,
      buffered: 0,
      uptimeMs: 123456,
      firmware: "1.0.0",
    };

    it("validates compliant firmware state payload", () => {
      const parsed = rawStateSchema.safeParse(validState);
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid valve modes", () => {
      const invalid = { ...validState, valveMode: "automatic" };
      const parsed = rawStateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it("rejects out-of-bound filter health values", () => {
      expect(rawStateSchema.safeParse({ ...validState, filterHealth: -5 }).success).toBe(false);
      expect(rawStateSchema.safeParse({ ...validState, filterHealth: 105 }).success).toBe(false);
    });

    it("normalizes state with metadata", () => {
      const normalized = normalizeDeviceState("nexgas-001", validState, new Date("2026-10-30T10:00:00Z"));
      expect(normalized.deviceId).toBe("nexgas-001");
      expect(normalized.receivedAt).toBe("2026-10-30T10:00:00.000Z");
      expect(normalized.valveOpen).toBe(false);
    });
  });

  describe("Device Status Payload", () => {
    it("parses bare string online and offline", () => {
      expect(parseStatusPayload("online")).toEqual({ status: "online" });
      expect(parseStatusPayload("offline")).toEqual({ status: "offline" });
      expect(parseStatusPayload("ONLINE")).toEqual({ status: "online" });
      expect(parseStatusPayload("  offline \n")).toEqual({ status: "offline" });
    });

    it("parses JSON status object", () => {
      expect(parseStatusPayload('{"status":"online"}')).toEqual({ status: "online" });
      expect(parseStatusPayload({ status: "offline" })).toEqual({ status: "offline" });
    });

    it("returns null on invalid status strings", () => {
      expect(parseStatusPayload("connected")).toBeNull();
      expect(parseStatusPayload("")).toBeNull();
      expect(parseStatusPayload(123)).toBeNull();
    });

    it("normalizes device status with metadata", () => {
      const normalized = normalizeDeviceStatus(
        "nexgas-001",
        { status: "online" },
        new Date("2026-10-30T10:00:00Z"),
      );
      expect(normalized.deviceId).toBe("nexgas-001");
      expect(normalized.status).toBe("online");
      expect(normalized.receivedAt).toBe("2026-10-30T10:00:00.000Z");
    });
  });

  describe("Device Event Payload", () => {
    const validEvent = {
      ts: 1761000000,
      uptimeMs: 123456,
      type: "valve_closed_leak",
      severity: "bahaya",
      message: "Solenoid ditutup paksa: metana di udara sekitar berbahaya",
    };

    it("validates event payload matching firmware output", () => {
      expect(rawEventSchema.safeParse(validEvent).success).toBe(true);
    });

    it("normalizes event with severity and timestamps", () => {
      const normalized = normalizeDeviceEvent("nexgas-001", validEvent, new Date("2026-10-30T10:00:00Z"));
      expect(normalized.deviceId).toBe("nexgas-001");
      expect(normalized.type).toBe("valve_closed_leak");
      expect(normalized.severity).toBe("bahaya");
      expect(normalized.deviceTimestamp).toBe(new Date(1761000000 * 1000).toISOString());
    });

    it("falls back safely to 'info' severity for unrecognized severity labels", () => {
      const unknownSeverity = { ...validEvent, severity: "custom-level" };
      const normalized = normalizeDeviceEvent("nexgas-001", unknownSeverity);
      expect(normalized.severity).toBe("info");
    });
  });

  describe("Command Payloads", () => {
    it("validates valve mode commands", () => {
      expect(commandSchema.safeParse({ mode: "auto" }).success).toBe(true);
      expect(commandSchema.safeParse({ mode: "manual" }).success).toBe(true);
      expect(commandSchema.safeParse({ mode: "invalid" }).success).toBe(false);
    });

    it("validates manual valve actuate commands", () => {
      expect(commandSchema.safeParse({ valve: "open" }).success).toBe(true);
      expect(commandSchema.safeParse({ valve: "close" }).success).toBe(true);
      expect(commandSchema.safeParse({ valve: "toggle" }).success).toBe(false);
    });

    it("validates tare and calibration commands", () => {
      expect(commandSchema.safeParse({ tare: true }).success).toBe(true);
      expect(
        commandSchema.safeParse({
          cal_pressure_point: { sensor: "digester", kpa: 2.5 },
        }).success,
      ).toBe(true);
      expect(
        commandSchema.safeParse({
          cal_mq: { gas: "h2s", ref_ppm: 10 },
        }).success,
      ).toBe(true);
      expect(
        commandSchema.safeParse({
          cal_ph: { ph: 6.86 },
        }).success,
      ).toBe(true);
    });

    it("rejects malformed commands", () => {
      expect(commandSchema.safeParse({ cal_ph: { ph: 99 } }).success).toBe(false);
      expect(commandSchema.safeParse({ cal_mq: { gas: "unknown_gas", ref_ppm: 0 } }).success).toBe(false);
      expect(commandSchema.safeParse({}).success).toBe(false);
    });
  });
});