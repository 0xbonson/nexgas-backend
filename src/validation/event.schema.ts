import { z } from "zod";
import { DeviceEventPayload, NormalizedDeviceEvent, EventSeverity } from "../types/index.js";

export const eventSeveritySchema = z.enum(["info", "waspada", "bahaya", "jadwal"]);

export const rawEventSchema = z.object({
  ts: z.number().int(),
  uptimeMs: z.number().nonnegative(),
  type: z.string().min(1),
  severity: z.string().min(1),
  message: z.string(),
});

function normalizeEventTimestamp(ts: number): string | null {
  if (!ts || ts < 1600000000) {
    return null;
  }
  const date = new Date(ts * 1000);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeDeviceEvent(
  deviceId: string,
  raw: DeviceEventPayload,
  receivedAt: Date = new Date(),
): NormalizedDeviceEvent {
  // Validate or coerce severity
  const severityParsed = eventSeveritySchema.safeParse(raw.severity.toLowerCase());
  const severity: EventSeverity = severityParsed.success ? severityParsed.data : "info";

  return {
    deviceId,
    receivedAt: receivedAt.toISOString(),
    deviceTimestamp: normalizeEventTimestamp(raw.ts),
    uptimeMs: raw.uptimeMs,
    type: raw.type,
    severity,
    message: raw.message,
    raw,
  };
}