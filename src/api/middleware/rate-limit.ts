import { Request, Response, NextFunction } from "express";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

interface RequestRecord {
  timestamps: number[];
}

const clientRecords = new Map<string, RequestRecord>();

// Cleanup stale rate limit entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of clientRecords.entries()) {
    record.timestamps = record.timestamps.filter(
      (ts) => now - ts < config.RATE_LIMIT_COMMAND_WINDOW_MS,
    );
    if (record.timestamps.length === 0) {
      clientRecords.delete(key);
    }
  }
}, 60000).unref();

export function commandRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const clientKey = req.ip || req.socket.remoteAddress || "global";
  const now = Date.now();

  let record = clientRecords.get(clientKey);
  if (!record) {
    record = { timestamps: [] };
    clientRecords.set(clientKey, record);
  }

  // Filter timestamps within window
  record.timestamps = record.timestamps.filter(
    (ts) => now - ts < config.RATE_LIMIT_COMMAND_WINDOW_MS,
  );

  if (record.timestamps.length >= config.RATE_LIMIT_COMMAND_MAX) {
    logger.warn(`Rate limit exceeded for command API from IP: ${clientKey}`);
    res.status(429).json({
      error: "Too Many Requests",
      message: `Rate limit of ${config.RATE_LIMIT_COMMAND_MAX} commands per ${config.RATE_LIMIT_COMMAND_WINDOW_MS / 1000}s exceeded. Please slow down.`,
    });
    return;
  }

  record.timestamps.push(now);
  next();
}

/**
 * Resets rate limit records (useful for test suites).
 */
export function resetCommandRateLimits(): void {
  clientRecords.clear();
}
