/**
 * Structured, credential-safe logger for NEX-GAS.
 * Ensures passwords, tokens, and authorization headers are never logged.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = [
  "password",
  "pass",
  "secret",
  "token",
  "auth",
  "authorization",
  "key",
  "api_key",
  "apikey",
  "mqtt_password",
  "ota_password",
];

export function sanitize<T = any>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    // Mask password in URI strings like mqtts://user:secret@host:8883 -> user:[REDACTED]@host:8883
    const masked = data.replace(
      /(:\/\/[^:]+:)([^@]+)(@)/g,
      (_match, p1, _secret, p3) => `${p1}[REDACTED]${p3}`,
    );
    return masked as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item)) as unknown as T;
  }

  if (typeof data === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        copy[key] = "[REDACTED]";
      } else {
        copy[key] = sanitize(value);
      }
    }
    return copy as unknown as T;
  }

  return data;
}

export const redactSensitive = sanitize;

export interface LoggerOptions {
  level?: LogLevel;
}

export class Logger {
  private levelValue: number;
  private currentLevel: LogLevel;

  constructor(levelOrOptions?: LogLevel | LoggerOptions) {
    let lvl: LogLevel = "info";
    if (typeof levelOrOptions === "string") {
      lvl = levelOrOptions;
    } else if (levelOrOptions && typeof levelOrOptions === "object" && levelOrOptions.level) {
      lvl = levelOrOptions.level;
    }
    this.currentLevel = lvl;
    this.levelValue = LOG_LEVELS[lvl] ?? LOG_LEVELS.info;
  }

  setLevel(level: LogLevel) {
    this.currentLevel = level;
    this.levelValue = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }

  getLevel(): LogLevel {
    return this.currentLevel;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown> | unknown) {
    if (LOG_LEVELS[level] < this.levelValue) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: level.toLowerCase(),
      message,
    };

    if (meta !== undefined) {
      entry.data = sanitize(meta);
    }

    const output = JSON.stringify(entry);
    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  debug(message: string, meta?: Record<string, unknown> | unknown) {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown> | unknown) {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown> | unknown) {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown> | unknown) {
    this.write("error", message, meta);
  }
}

export function createLogger(options?: LoggerOptions | LogLevel): Logger {
  return new Logger(options);
}

export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || "info",
);