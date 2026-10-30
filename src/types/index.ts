/**
 * NEX-GAS Domain and MQTT Protocol Types
 */

export type TopicType = "telemetry" | "state" | "status" | "event" | "cmd";

export interface ParsedTopic {
  raw: string;
  deviceId: string;
  type: TopicType;
}

export type ValveMode = "auto" | "manual";

export type EventSeverity = "info" | "waspada" | "bahaya" | "jadwal";

/**
 * Raw Telemetry Payload as emitted by ESP32 firmware over MQTT.
 * In this representation, unavailable sensors or uncalibrated readings remain `-1` or `0` as sent by firmware.
 */
export interface RawTelemetryPayload {
  ts: number;
  uptimeMs: number;
  h2sBefore: number;
  h2sAfter: number;
  ch4: number;
  leak: number;
  pressureDigester: number;
  pressureCollector: number;
  temperature: number;
  humidity: number;
  gasLineTemperature: number;
  gasLineHumidity: number;
  ph: number;
  flow: number;
  gasSinceStartL: number;
  sensorsReady: boolean;
  rssi: number;
}

export type DataSourceType = "REAL_HARDWARE" | "SYNTHETIC_DEMO";

/**
 * Normalized Telemetry Representation used internally by the backend.
 * Readings equal to -1 are normalized to null (unavailable), preventing bogus 0 ppm calculations.
 * Device timestamp (ts) is normalized to null when ts = 0 (NTP unsynced).
 * Estimates (CH4, flow) are clearly marked and not treated as certified purity or direct flowmeter measurements.
 */
export interface NormalizedTelemetry {
  deviceId: string;
  isSynthetic: boolean;
  dataSource: DataSourceType;
  receivedAt: string; // ISO 8601 UTC timestamp of backend reception
  deviceTimestamp: string | null; // ISO 8601 UTC timestamp or null if device NTP was 0
  rawTimestamp: number; // Raw ts from payload
  uptimeMs: number;
  h2sBefore: number | null; // null represents unavailable (e.g. 2nd MQ-136 not installed)
  h2sAfter: number | null;
  ch4Estimate: number | null; // Relative sensor estimate from MQ-4 curve, NOT verified gas purity
  leakPpm: number | null;
  pressureDigesterKpa: number | null;
  pressureCollectorKpa: number | null;
  temperatureC: number | null;
  humidityPct: number | null;
  gasLineTemperatureC: number | null;
  gasLineHumidityPct: number | null;
  ph: number | null;
  flowEstimateLpm: number | null; // Estimated from pressure drop rate, NOT a direct flowmeter
  gasSinceStartTotalL: number | null; // Estimated accumulated volume
  sensorsReady: boolean;
  rssi: number;
  raw: RawTelemetryPayload; // Original payload preserved for auditing and debugging
}

/**
 * Device State Payload as published to nexgas/{deviceId}/state.
 */
export interface DeviceStatePayload {
  valveOpen: boolean;
  valveMode: ValveMode;
  filterWarning: boolean;
  leakWarning: boolean;
  filterHealth: number; // 0 - 100 estimated filter lifetime
  pressureCalibrated: boolean;
  phCalibrated: boolean;
  sensorsReady: boolean;
  buffered: number;
  uptimeMs: number;
  firmware: string;
}

export interface NormalizedDeviceState extends DeviceStatePayload {
  deviceId: string;
  isSynthetic: boolean;
  dataSource: DataSourceType;
  receivedAt: string;
}

/**
 * Device Status Payload (retained LWT or connect).
 */
export interface DeviceStatusPayload {
  status: "online" | "offline";
}

export interface NormalizedDeviceStatus {
  deviceId: string;
  status: "online" | "offline";
  isSynthetic: boolean;
  dataSource: DataSourceType;
  receivedAt: string;
}

/**
 * Event Payload published to nexgas/{deviceId}/event.
 */
export interface DeviceEventPayload {
  ts: number;
  uptimeMs: number;
  type: string; // e.g. "boot", "valve_closed_leak", "collector_full", "pressure_uncalibrated"
  severity: string;
  message: string;
}

export interface NormalizedDeviceEvent {
  deviceId: string;
  isSynthetic: boolean;
  dataSource: DataSourceType;
  receivedAt: string;
  deviceTimestamp: string | null;
  uptimeMs: number;
  type: string;
  severity: EventSeverity;
  message: string;
  raw: DeviceEventPayload;
}

/**
 * Commands dispatched to nexgas/{deviceId}/cmd.
 */
export type CommandPayload =
  | { mode: ValveMode }
  | { valve: "open" | "close" }
  | { tare: true }
  | { cal_pressure_point: { sensor: "digester" | "collector"; kpa: number } }
  | { cal_mq: { gas: "h2s" | "ch4" | "leak"; ref_ppm: number } }
  | { cal_ph: { ph: number } };

export * from "./auth.js";
