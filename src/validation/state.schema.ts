import { z } from "zod";
import { DeviceStatePayload, NormalizedDeviceState } from "../types/index.js";

import { isSyntheticDevice } from "./telemetry.schema.js";

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
  const isSynthetic = isSyntheticDevice(deviceId);
  return {
    ...raw,
    deviceId,
    isSynthetic,
    dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
    receivedAt: receivedAt.toISOString(),
  };
}