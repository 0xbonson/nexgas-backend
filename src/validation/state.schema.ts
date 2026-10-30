import { z } from "zod";
import { DeviceStatePayload, NormalizedDeviceState } from "../types/index.js";

export const rawStateSchema = z.object({
  valveOpen: z.boolean(),
  valveMode: z.enum(["auto", "manual"]),
  filterWarning: z.boolean(),
  leakWarning: z.boolean(),
  filterHealth: z.number().min(0).max(100),
  pressureCalibrated: z.boolean(),
  phCalibrated: z.boolean(),
  sensorsReady: z.boolean(),
  buffered: z.number().int().nonnegative(),
  uptimeMs: z.number().nonnegative(),
  firmware: z.string().min(1),
});

export function normalizeDeviceState(
  deviceId: string,
  raw: DeviceStatePayload,
  receivedAt: Date = new Date(),
): NormalizedDeviceState {
  return {
    ...raw,
    deviceId,
    receivedAt: receivedAt.toISOString(),
  };
}