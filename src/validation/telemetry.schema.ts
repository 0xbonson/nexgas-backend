import { z } from "zod";
import { RawTelemetryPayload, NormalizedTelemetry } from "../types/index.js";

/**
 * Zod schema for raw telemetry JSON published by ESP32 firmware.
 * Validates the schema without altering incoming negative/unavailable codes.
 */
export const rawTelemetrySchema = z.object({
  ts: z.number().int(),
  uptimeMs: z.number().nonnegative(),
  h2sBefore: z.number(),
  h2sAfter: z.number(),
  ch4: z.number(),
  leak: z.number(),
  pressureDigester: z.number(),
  pressureCollector: z.number(),
  temperature: z.number(),
  humidity: z.number(),
  gasLineTemperature: z.number(),
  gasLineHumidity: z.number(),
  ph: z.number(),
  flow: z.number(),
  gasSinceStartL: z.number(),
  sensorsReady: z.boolean(),
  rssi: z.number(),
});

/**
 * Helper to normalize unavailable or uncalibrated readings.
 * In the NEX-GAS ESP32 firmware, -1 is explicitly designated as "unavailable"
 * (e.g. h2sBefore = -1 when 2nd MQ-136 is not installed).
 * NaN or non-finite values are also normalized to null.
 */
function normalizeSensorReading(val: number): number | null {
  if (!Number.isFinite(val) || val === -1) {
    return null;
  }
  return val;
}

/**
 * Normalizes device timestamp (epoch UTC seconds from ESP32 NTP).
 * Returns null if ts is 0 or invalid (ESP32 was offline during NTP sync).
 */
function normalizeDeviceTimestamp(ts: number): string | null {
  // Firmware sets ts = 0 if NTP has not synced (time < 1600000000)
  if (!ts || ts < 1600000000) {
    return null;
  }
  // ts is in seconds per firmware time(nullptr)
  const date = new Date(ts * 1000);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Helper to identify whether a device identifier belongs to synthetic demonstration data.
 */
export function isSyntheticDevice(deviceId: string): boolean {
  return (
    deviceId === "demo-synthetic" ||
    deviceId.startsWith("demo-") ||
    deviceId.startsWith("synthetic-") ||
    deviceId.includes("demo") ||
    deviceId.includes("synthetic")
  );
}

/**
 * Normalizes raw ESP32 telemetry into backend representation:
 * - Normalizes -1 values to null without fabricating zero.
 * - Retains device timestamp separately from server ingestion timestamp.
 * - Explicitly models CH4 and flow as estimates, per hardware safety notes.
 * - Explicitly marks whether data is synthetic demonstration or real hardware.
 * - Keeps original raw payload attached for debugging.
 */
export function normalizeTelemetry(
  deviceId: string,
  raw: RawTelemetryPayload,
  receivedAt: Date = new Date(),
): NormalizedTelemetry {
  const isSynthetic = isSyntheticDevice(deviceId);
  return {
    deviceId,
    isSynthetic,
    dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
    receivedAt: receivedAt.toISOString(),
    deviceTimestamp: normalizeDeviceTimestamp(raw.ts),
    rawTimestamp: raw.ts,
    uptimeMs: raw.uptimeMs,
    h2sBefore: normalizeSensorReading(raw.h2sBefore),
    h2sAfter: normalizeSensorReading(raw.h2sAfter),
    // Sensor estimates per safety requirements (not certified gas purity)
    ch4Estimate: normalizeSensorReading(raw.ch4),
    leakPpm: normalizeSensorReading(raw.leak),
    pressureDigesterKpa: normalizeSensorReading(raw.pressureDigester),
    pressureCollectorKpa: normalizeSensorReading(raw.pressureCollector),
    temperatureC: normalizeSensorReading(raw.temperature),
    humidityPct: normalizeSensorReading(raw.humidity),
    gasLineTemperatureC: normalizeSensorReading(raw.gasLineTemperature),
    gasLineHumidityPct: normalizeSensorReading(raw.gasLineHumidity),
    ph: normalizeSensorReading(raw.ph),
    // Flow is an estimate based on pressure decay, not a direct flowmeter
    flowEstimateLpm: normalizeSensorReading(raw.flow),
    gasSinceStartTotalL: normalizeSensorReading(raw.gasSinceStartL),
    sensorsReady: raw.sensorsReady,
    rssi: raw.rssi,
    raw,
  };
}