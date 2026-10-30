import { Router, Request, Response } from "express";
import { z } from "zod";
import { config, getSafeConfig } from "../config/index.js";
import { getRepositories } from "../db/index.js";
import { mqttService, NexGasMqttService } from "../mqtt/client.js";
import { isValidDeviceId } from "../mqtt/topics.js";
import { commandSchema } from "../validation/command.schema.js";
import { commandRateLimiter } from "./middleware/rate-limit.js";
import {
  formatTelemetryForFrontend,
  formatSystemStateForFrontend,
  formatEventToAppNotification,
} from "./formatters.js";
import { logger } from "../utils/logger.js";

const historyQuerySchema = z.object({
  deviceId: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(["asc", "desc"]).default("desc"),
  severity: z.string().optional(),
  type: z.string().optional(),
});

const commandRequestSchema = z.object({
  deviceId: z.string().min(1),
  command: commandSchema,
});

export function createApiRouter(service: NexGasMqttService = mqttService): Router {
  const router = Router();
  const repos = getRepositories();

  // --------------------------------------------------------------------------
  // HEALTH & CONFIG ENDPOINTS
  // --------------------------------------------------------------------------

  router.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      mqttConnected: service.getConnected(),
    });
  });

  router.get("/health/ready", (_req: Request, res: Response) => {
    res.status(200).json({
      ready: true,
      service: "nexgas-backend",
      mqttConnected: service.getConnected(),
      subscribedTopics: service.getTargetTopics(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/api/config", (_req: Request, res: Response) => {
    res.status(200).json(getSafeConfig());
  });

  // --------------------------------------------------------------------------
  // LATEST DATA ENDPOINTS
  // --------------------------------------------------------------------------

  router.get("/api/telemetry/latest", (req: Request, res: Response) => {
    const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

    if (!isValidDeviceId(deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${deviceId}"`,
      });
      return;
    }

    const latest = repos.telemetry.getLatest(deviceId);
    if (!latest) {
      res.status(404).json({
        error: "Not Found",
        message: `No telemetry found for device: "${deviceId}"`,
      });
      return;
    }

    res.status(200).json({
      deviceId: latest.deviceId,
      receivedAt: latest.receivedAt,
      deviceTimestamp: latest.deviceTimestamp,
      uptimeMs: latest.uptimeMs,
      data: latest,
      frontend: formatTelemetryForFrontend(latest),
      sensorsReady: latest.sensorsReady,
      rssi: latest.rssi,
    });
  });

  router.get("/api/state", (req: Request, res: Response) => {
    const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

    if (!isValidDeviceId(deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${deviceId}"`,
      });
      return;
    }

    const state = repos.state.getCurrent(deviceId);
    if (!state) {
      res.status(404).json({
        error: "Not Found",
        message: `No state record found for device: "${deviceId}"`,
      });
      return;
    }

    const latestTelemetry = repos.telemetry.getLatest(deviceId);

    res.status(200).json({
      deviceId: state.deviceId,
      receivedAt: state.receivedAt,
      state,
      frontendSystemState: formatSystemStateForFrontend(state, latestTelemetry),
    });
  });

  router.get("/api/status", (req: Request, res: Response) => {
    const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

    if (!isValidDeviceId(deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${deviceId}"`,
      });
      return;
    }

    const status = repos.status.getCurrent(deviceId);
    if (!status) {
      res.status(404).json({
        error: "Not Found",
        message: `No status record found for device: "${deviceId}"`,
      });
      return;
    }

    res.status(200).json({
      deviceId: status.deviceId,
      status: status.status,
      receivedAt: status.receivedAt,
    });
  });

  // --------------------------------------------------------------------------
  // HISTORICAL DATA ENDPOINTS
  // --------------------------------------------------------------------------

  router.get("/api/history/telemetry", (req: Request, res: Response) => {
    const parsedQuery = historyQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: "Bad Request",
        details: parsedQuery.error.format(),
      });
      return;
    }

    const q = parsedQuery.data;
    if (q.deviceId && !isValidDeviceId(q.deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${q.deviceId}"`,
      });
      return;
    }

    const result = repos.telemetry.getHistory(q);
    res.status(200).json({
      items: result.items,
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  router.get("/api/history/events", (req: Request, res: Response) => {
    const parsedQuery = historyQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: "Bad Request",
        details: parsedQuery.error.format(),
      });
      return;
    }

    const q = parsedQuery.data;
    if (q.deviceId && !isValidDeviceId(q.deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${q.deviceId}"`,
      });
      return;
    }

    const result = repos.event.getHistory(q);
    res.status(200).json({
      items: result.items,
      notifications: result.items.map((ev) => formatEventToAppNotification(ev)),
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  router.get("/api/history/state", (req: Request, res: Response) => {
    const parsedQuery = historyQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: "Bad Request",
        details: parsedQuery.error.format(),
      });
      return;
    }

    const q = parsedQuery.data;
    if (q.deviceId && !isValidDeviceId(q.deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${q.deviceId}"`,
      });
      return;
    }

    const result = repos.state.getHistory(q);
    res.status(200).json({
      items: result.items,
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  router.get("/api/history/status", (req: Request, res: Response) => {
    const parsedQuery = historyQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: "Bad Request",
        details: parsedQuery.error.format(),
      });
      return;
    }

    const q = parsedQuery.data;
    if (q.deviceId && !isValidDeviceId(q.deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${q.deviceId}"`,
      });
      return;
    }

    const result = repos.status.getHistory(q);
    res.status(200).json({
      items: result.items,
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  // --------------------------------------------------------------------------
  // COMMAND ENDPOINT
  // --------------------------------------------------------------------------

  router.post("/api/command", commandRateLimiter, async (req: Request, res: Response) => {
    const parsedBody = commandRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: "Bad Request",
        message: "Invalid command payload structure",
        details: parsedBody.error.format(),
      });
      return;
    }

    const { deviceId, command } = parsedBody.data;

    if (!isValidDeviceId(deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${deviceId}"`,
      });
      return;
    }

    if (!service.getConnected()) {
      logger.warn("Rejected command: MQTT broker client is offline", { deviceId, command });
      res.status(503).json({
        error: "Service Unavailable",
        message: "Cannot dispatch command: MQTT broker client is offline",
      });
      return;
    }

    try {
      const publishResult = await service.publishCommand(deviceId, command);

      res.status(200).json({
        status: "published",
        deviceId,
        topic: publishResult.topic,
        command: publishResult.payload,
        publishedAt: new Date().toISOString(),
        verificationStatus: "pending_execution",
        message:
          "Command published to device MQTT topic. Physical execution is governed by ESP32 firmware safety checks.",
        protocolNote:
          "Firmware does not emit correlated command ACKs; state transitions are broadcast asynchronously on nexgas/{DEVICE_ID}/state.",
      });
    } catch (err) {
      logger.error("Failed to publish command to MQTT", {
        deviceId,
        command,
        error: (err as Error).message,
      });
      res.status(502).json({
        error: "Bad Gateway",
        message: `Failed to deliver command to broker: ${(err as Error).message}`,
      });
    }
  });

  return router;
}
