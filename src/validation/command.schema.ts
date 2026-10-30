import { z } from "zod";

export const valveModeCommandSchema = z.object({
  mode: z.enum(["auto", "manual"]),
});

export const valveActuateCommandSchema = z.object({
  valve: z.enum(["open", "close"]),
});

export const tareCommandSchema = z.object({
  tare: z.literal(true),
});

export const calPressureCommandSchema = z.object({
  cal_pressure_point: z.object({
    sensor: z.enum(["digester", "collector"]),
    kpa: z.number().finite(),
  }),
});

export const calMqCommandSchema = z.object({
  cal_mq: z.object({
    gas: z.enum(["h2s", "ch4", "leak"]),
    ref_ppm: z.number().nonnegative(),
  }),
});

export const calPhCommandSchema = z.object({
  cal_ph: z.object({
    ph: z.number().min(0).max(14),
  }),
});

export const commandSchema = z.union([
  valveModeCommandSchema,
  valveActuateCommandSchema,
  tareCommandSchema,
  calPressureCommandSchema,
  calMqCommandSchema,
  calPhCommandSchema,
]);

export type ValidatedCommand = z.infer<typeof commandSchema>;
