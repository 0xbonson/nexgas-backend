import { z } from "zod";
import { DeviceStatusPayload, NormalizedDeviceStatus } from "../types/index.js";

export const statusStringSchema = z.enum(["online", "offline"]);

export const statusObjectSchema = z.object({
  status: statusStringSchema,
});

/**
 * Parses raw status payload which can be either a bare string ("online" | "offline")
 * from MQTT Last Will / Connect, or a JSON object ({"status": "online"}).
 */
export function parseStatusPayload(rawPayload: unknown): DeviceStatusPayload | null {
  if (typeof rawPayload === "string") {
    const trimmed = rawPayload.trim().toLowerCase();
    const strResult = statusStringSchema.safeParse(trimmed);
    if (strResult.success) {
      return { status: strResult.data };
    }
    // Attempt parsing as JSON string if it looks like JSON
    try {
      const parsed = JSON.parse(trimmed);
      const objResult = statusObjectSchema.safeParse(parsed);
      if (objResult.success) {
        return objResult.data;
      }
    } catch {
      return null;
    }
  }

  if (typeof rawPayload === "object" && rawPayload !== null) {
    const objResult = statusObjectSchema.safeParse(rawPayload);
    if (objResult.success) {
      return objResult.data;
    }
  }

  return null;
}

export function normalizeDeviceStatus(
  deviceId: string,
  payload: DeviceStatusPayload,
  receivedAt: Date = new Date(),
): NormalizedDeviceStatus {
  return {
    deviceId,
    status: payload.status,
    receivedAt: receivedAt.toISOString(),
  };
}