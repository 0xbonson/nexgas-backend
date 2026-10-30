import dotenv from "dotenv";
import { z } from "zod";
import { sanitize } from "../utils/logger.js";

dotenv.config();

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MQTT_HOST: z.string().default("your-cluster-id.s1.eu.hivemq.cloud"),
  MQTT_PORT: z.coerce.number().int().positive().default(8883),
  MQTT_USERNAME: z.string().optional().default(""),
  MQTT_PASSWORD: z.string().optional().default(""),
  MQTT_CLIENT_ID_PREFIX: z.string().default("nexgas-backend"),
  MQTT_RECONNECT_PERIOD_MS: z.coerce.number().int().positive().default(5000),
  MQTT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DEFAULT_DEVICE_ID: z.string().default("nexgas-001"),
  MQTT_CONNECT_ON_STARTUP: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  DB_PATH: z.string().default("./data/nexgas.sqlite"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://127.0.0.1:3000,https://nex-gas.github.io"),
  RATE_LIMIT_COMMAND_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_COMMAND_WINDOW_MS: z.coerce.number().int().positive().default(10000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse({
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    MQTT_HOST: env.MQTT_HOST,
    MQTT_PORT: env.MQTT_PORT,
    MQTT_USERNAME: env.MQTT_USERNAME,
    MQTT_PASSWORD: env.MQTT_PASSWORD,
    MQTT_CLIENT_ID_PREFIX: env.MQTT_CLIENT_ID_PREFIX,
    MQTT_RECONNECT_PERIOD_MS: env.MQTT_RECONNECT_PERIOD_MS,
    MQTT_CONNECT_TIMEOUT_MS: env.MQTT_CONNECT_TIMEOUT_MS,
    DEFAULT_DEVICE_ID: env.DEFAULT_DEVICE_ID,
    MQTT_CONNECT_ON_STARTUP: env.MQTT_CONNECT_ON_STARTUP,
    DB_PATH: env.DB_PATH,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    RATE_LIMIT_COMMAND_MAX: env.RATE_LIMIT_COMMAND_MAX,
    RATE_LIMIT_COMMAND_WINDOW_MS: env.RATE_LIMIT_COMMAND_WINDOW_MS,
  });
  return parsed;
}

export const config = loadConfig();

export function getSafeConfig(cfg: AppConfig = config) {
  return sanitize(cfg);
}