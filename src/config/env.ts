import dotenv from "dotenv";
import { z } from "zod";
import { sanitize } from "../utils/logger.js";

if (process.env.NODE_ENV !== "test") {
  dotenv.config();
}

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MQTT_HOST: z.string().default("broker.hivemq.com"),
  MQTT_PORT: z.coerce.number().int().positive().default(1883),
  MQTT_PROTOCOL: z.enum(["mqtts", "mqtt", "ws", "wss"]).default("mqtt"),
  MQTT_USERNAME: z.string().optional().default(""),
  MQTT_PASSWORD: z.string().optional().default(""),
  MQTT_CLIENT_ID_PREFIX: z.string().default("nexgas-backend"),
  MQTT_RECONNECT_PERIOD_MS: z.coerce.number().int().positive().default(5000),
  MQTT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DEFAULT_DEVICE_ID: z.string().default("nexgas-001"),
  MQTT_CONNECT_ON_STARTUP: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true"),
  PUBLIC_MQTT_TEST_MODE: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  DB_PATH: z.string().default("./data/nexgas.sqlite"),
  DATABASE_DRIVER: z.enum(["sqlite", "turso"]).default("turso"),
  TURSO_DATABASE_URL: z
    .string()
    .default("libsql://nexgas-db-0xbonson.aws-ap-southeast-1.turso.io"),
  TURSO_AUTH_TOKEN: z
    .string()
    .default(
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTM0NTIzNDAsImlkIjoiMDFhMTkxZmItMmEwMS03ZTcyLWEzNGMtNWQ0YWNlNWY0NmFjIiwia2lkIjoiR3ZsLV8xRFRhcVU3OW9FV2NBN0ltakFzaWRjX1I3MXFWd05oa0FpYVZCWSIsInJpZCI6IjM2NGIzMGQzLWE2NGYtNDUxNi04NGFmLWU5OTEwNzJjMjE1MCJ9.25XX4-mbrdO4iUo17DDzatbCFnjTUfGDNsw8Cv2meGWJnWF1CfYfoi0AMUFpH8uih4cKdPikNZv_IdRTYQEaCg"
    ),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://127.0.0.1:3000,https://nex-gas.github.io,*.vercel.app,https://nex-gas.vercel.app,https://nexgas.vercel.app"
    ),
  RATE_LIMIT_COMMAND_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_COMMAND_WINDOW_MS: z.coerce.number().int().positive().default(10000),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters long")
    .default("nexgas-default-dev-secret-key-32-chars-minimum!"),
  JWT_ACCESS_EXPIRATION: z.string().default("15m"),
  JWT_REFRESH_EXPIRATION_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((val) => val === "true" || process.env.NODE_ENV === "production"),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_DOMAIN: z.string().optional(),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  DATA_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse({
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    MQTT_HOST: env.MQTT_HOST,
    MQTT_PORT: env.MQTT_PORT,
    MQTT_PROTOCOL: env.MQTT_PROTOCOL,
    MQTT_USERNAME: env.MQTT_USERNAME,
    MQTT_PASSWORD: env.MQTT_PASSWORD,
    MQTT_CLIENT_ID_PREFIX: env.MQTT_CLIENT_ID_PREFIX,
    MQTT_RECONNECT_PERIOD_MS: env.MQTT_RECONNECT_PERIOD_MS,
    MQTT_CONNECT_TIMEOUT_MS: env.MQTT_CONNECT_TIMEOUT_MS,
    DEFAULT_DEVICE_ID: env.DEFAULT_DEVICE_ID,
    MQTT_CONNECT_ON_STARTUP: env.MQTT_CONNECT_ON_STARTUP,
    PUBLIC_MQTT_TEST_MODE: env.PUBLIC_MQTT_TEST_MODE,
    DB_PATH: env.DB_PATH,
    DATABASE_DRIVER: env.DATABASE_DRIVER,
    TURSO_DATABASE_URL: env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: env.TURSO_AUTH_TOKEN,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    RATE_LIMIT_COMMAND_MAX: env.RATE_LIMIT_COMMAND_MAX,
    RATE_LIMIT_COMMAND_WINDOW_MS: env.RATE_LIMIT_COMMAND_WINDOW_MS,
    JWT_SECRET: env.JWT_SECRET,
    JWT_ACCESS_EXPIRATION: env.JWT_ACCESS_EXPIRATION,
    JWT_REFRESH_EXPIRATION_DAYS: env.JWT_REFRESH_EXPIRATION_DAYS,
    COOKIE_SECURE: env.COOKIE_SECURE,
    COOKIE_SAME_SITE: env.COOKIE_SAME_SITE,
    COOKIE_DOMAIN: env.COOKIE_DOMAIN,
    RATE_LIMIT_LOGIN_MAX: env.RATE_LIMIT_LOGIN_MAX,
    RATE_LIMIT_LOGIN_WINDOW_MS: env.RATE_LIMIT_LOGIN_WINDOW_MS,
    DATA_RETENTION_DAYS: env.DATA_RETENTION_DAYS,
  });

  const knownPlaceholderSecrets = [
    /^generate_a_secure/i,
    /^your[_-]/i,
    /changeme/i,
    /placeholder/i,
  ];

  if (
    parsed.NODE_ENV === "production" &&
    (parsed.JWT_SECRET === "nexgas-default-dev-secret-key-32-chars-minimum!" ||
      knownPlaceholderSecrets.some((pattern) => pattern.test(parsed.JWT_SECRET)))
  ) {
    throw new Error(
      "FATAL: In production, JWT_SECRET must be explicitly configured with a strong secret (not a default or placeholder value).",
    );
  }

  return parsed;
}

export const config = loadConfig();

export function getSafeConfig(cfg: AppConfig = config) {
  return sanitize(cfg);
}