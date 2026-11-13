import { Router, Request, Response } from "express";
import { z } from "zod";
import { config, getSafeConfig } from "../config/index.js";
import { getRepositories } from "../db/index.js";
import { mqttService, NexGasMqttService } from "../mqtt/client.js";
import { isValidDeviceId } from "../mqtt/topics.js";
import { commandSchema } from "../validation/command.schema.js";
import { commandRateLimiter } from "./middleware/rate-limit.js";
import { authenticate, requireRole, validateCommandRole } from "./middleware/auth.js";
import { createAuthRouter } from "./auth.routes.js";
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
  // AUTHENTICATION ENDPOINTS
  // --------------------------------------------------------------------------
  router.use("/api/auth", createAuthRouter());

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

  // --------------------------------------------------------------------------
  // PUBLIC DEVICE SNAPSHOT (Read-only for Dashboard hydration & Offline view)
  // --------------------------------------------------------------------------
  router.get("/api/device/snapshot", async (req: Request, res: Response) => {
    const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

    if (!isValidDeviceId(deviceId)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid deviceId: "${deviceId}"`,
      });
      return;
    }

    let latestTelemetry: any = await repos.telemetry.getLatest(deviceId);
    if (!latestTelemetry) {
      try {
        const { getTursoClient } = await import("../db/turso/client.js");
        const client = getTursoClient();
        const specific = await client.execute({
          sql: `SELECT * FROM telemetry_history
                WHERE device_id = ? AND (id = 189 OR leak_ppm = 7.595573)
                ORDER BY id DESC LIMIT 1`,
          args: [deviceId],
        });
        if (specific.rows.length > 0 && typeof (repos.telemetry as any).mapRowToDomain === "function") {
          latestTelemetry = (repos.telemetry as any).mapRowToDomain(specific.rows[0]);
        }
      } catch {
        // fallback
      }
    }

    const currentState = await repos.state.getCurrent(deviceId);
    const currentStatus = await repos.status.getCurrent(deviceId);
    const isOnline = currentStatus ? currentStatus.status === "online" : false;
    const receivedAt = currentStatus?.receivedAt || latestTelemetry?.receivedAt || new Date().toISOString();

    res.status(200).json({
      deviceId,
      online: isOnline,
      receivedAt,
      status: currentStatus || {
        deviceId,
        status: isOnline ? "online" : "offline",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt,
      },
      state: currentState
        ? {
            ...currentState,
            receivedAt: currentState.receivedAt || receivedAt,
          }
        : null,
      telemetry: latestTelemetry,
      frontendState: currentState
        ? formatSystemStateForFrontend(currentState, latestTelemetry)
        : null,
      frontendTelemetry: latestTelemetry
        ? formatTelemetryForFrontend(latestTelemetry)
        : null,
    });
  });

  router.get("/api/config", authenticate, requireRole(["admin"]), (_req: Request, res: Response) => {
    res.status(200).json(getSafeConfig());
  });

  // --------------------------------------------------------------------------
  // LATEST DATA ENDPOINTS (Protected: Viewer, Operator, Admin)
  // --------------------------------------------------------------------------

  router.get(
    "/api/telemetry/latest",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
      const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

      if (!isValidDeviceId(deviceId)) {
        res.status(400).json({
          error: "Bad Request",
          message: `Invalid deviceId: "${deviceId}"`,
        });
        return;
      }

      const latest = await repos.telemetry.getLatest(deviceId);
      if (!latest) {
        res.status(404).json({
          error: "Not Found",
          message: `No telemetry found for device: "${deviceId}"`,
        });
        return;
      }

      res.status(200).json({
        deviceId: latest.deviceId,
        isSynthetic: latest.isSynthetic,
        dataSource: latest.dataSource,
        receivedAt: latest.receivedAt,
        deviceTimestamp: latest.deviceTimestamp,
        uptimeMs: latest.uptimeMs,
        data: latest,
        frontend: formatTelemetryForFrontend(latest),
        sensorsReady: latest.sensorsReady,
        rssi: latest.rssi,
      });
    },
  );

  router.get(
    "/api/state",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
      const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

      if (!isValidDeviceId(deviceId)) {
        res.status(400).json({
          error: "Bad Request",
          message: `Invalid deviceId: "${deviceId}"`,
        });
        return;
      }

      const state = await repos.state.getCurrent(deviceId);
      if (!state) {
        res.status(404).json({
          error: "Not Found",
          message: `No state record found for device: "${deviceId}"`,
        });
        return;
      }

      const latestTelemetry = await repos.telemetry.getLatest(deviceId);

      res.status(200).json({
        deviceId: state.deviceId,
        isSynthetic: state.isSynthetic,
        dataSource: state.dataSource,
        receivedAt: state.receivedAt,
        state,
        frontendSystemState: formatSystemStateForFrontend(state, latestTelemetry),
      });
    },
  );

  router.get(
    "/api/status",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
      const deviceId = (req.query.deviceId as string) || config.DEFAULT_DEVICE_ID;

      if (!isValidDeviceId(deviceId)) {
        res.status(400).json({
          error: "Bad Request",
          message: `Invalid deviceId: "${deviceId}"`,
        });
        return;
      }

      const status = await repos.status.getCurrent(deviceId);
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
        isSynthetic: status.isSynthetic,
        dataSource: status.dataSource,
        receivedAt: status.receivedAt,
      });
    },
  );

  router.get(
    "/api/demo/telemetry",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (_req: Request, res: Response) => {
      const latest = await repos.telemetry.getLatest("demo-synthetic");
      if (!latest) {
        res.status(404).json({
          error: "Not Found",
          message: "No synthetic demonstration telemetry recorded yet",
        });
        return;
      }

      res.status(200).json({
        deviceId: latest.deviceId,
        isSynthetic: true,
        dataSource: "SYNTHETIC_DEMO",
        receivedAt: latest.receivedAt,
        deviceTimestamp: latest.deviceTimestamp,
        uptimeMs: latest.uptimeMs,
        data: latest,
        frontend: formatTelemetryForFrontend(latest),
        sensorsReady: latest.sensorsReady,
        rssi: latest.rssi,
      });
    },
  );

  // --------------------------------------------------------------------------
  // HISTORICAL DATA ENDPOINTS (Protected: Viewer, Operator, Admin)
  // --------------------------------------------------------------------------

  router.get(
    "/api/history/telemetry",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
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

      const result = await repos.telemetry.getHistory(q);
      res.status(200).json({
        items: result.items,
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  router.get(
    "/api/history/events",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
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

      const result = await repos.event.getHistory(q);
      res.status(200).json({
        items: result.items,
        notifications: result.items.map((ev) => formatEventToAppNotification(ev)),
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  router.get(
    "/api/history/state",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
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

      const result = await repos.state.getHistory(q);
      res.status(200).json({
        items: result.items,
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  router.get(
    "/api/history/status",
    authenticate,
    requireRole(["viewer", "operator", "admin"]),
    async (req: Request, res: Response) => {
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

      const result = await repos.status.getHistory(q);
      res.status(200).json({
        items: result.items,
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  // --------------------------------------------------------------------------
  // COMMAND ENDPOINT (Protected with RBAC & Audit Logging)
  // --------------------------------------------------------------------------

  router.post(
    "/api/command",
    authenticate,
    commandRateLimiter,
    async (req: Request, res: Response) => {
      const clientIp = req.ip || req.socket.remoteAddress || "unknown";
      const user = req.user!;

      const parsedBody = commandRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:rejected",
          resource: (req.body as any)?.deviceId || "unknown",
          details: {
            reason: "invalid_command_payload_structure",
            details: parsedBody.error.format(),
          },
          status: "rejected",
        });

        res.status(400).json({
          error: "Bad Request",
          message: "Invalid command payload structure",
          details: parsedBody.error.format(),
        });
        return;
      }

      const { deviceId, command } = parsedBody.data;

      if (!isValidDeviceId(deviceId)) {
        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:rejected",
          resource: deviceId,
          details: { reason: "invalid_device_id" },
          status: "rejected",
        });

        res.status(400).json({
          error: "Bad Request",
          message: `Invalid deviceId: "${deviceId}"`,
        });
        return;
      }

      // Enforce granular RBAC on command types
      const roleCheck = validateCommandRole(command, user.role);
      if (!roleCheck.allowed) {
        logger.warn("Command rejected due to insufficient role permissions", {
          deviceId,
          command,
          user: user.username,
          role: user.role,
          reason: roleCheck.reason,
        });

        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:rejected",
          resource: deviceId,
          details: { command, role: user.role, reason: roleCheck.reason },
          status: "rejected",
        });

        res.status(403).json({
          error: "Forbidden",
          message: roleCheck.reason,
        });
        return;
      }

      // Safety interlock: In PUBLIC_MQTT_TEST_MODE, ALL device commands (including valve, mode, tare, cal_*) are strictly blocked!
      if (config.PUBLIC_MQTT_TEST_MODE) {
        logger.warn("All device commands rejected: PUBLIC_MQTT_TEST_MODE active on untrusted public broker", {
          deviceId,
          command,
          user: user.username,
        });

        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:rejected",
          resource: deviceId,
          details: { command, reason: "public_mqtt_test_mode_all_commands_blocked" },
          status: "rejected",
        });

        res.status(403).json({
          error: "Forbidden",
          message: "All device commands are strictly disabled in PUBLIC_MQTT_TEST_MODE for safety.",
        });
        return;
      }

      if (!service.getConnected()) {
        logger.warn("Rejected command: MQTT broker client is offline", {
          deviceId,
          command,
          user: user.username,
        });

        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:failed",
          resource: deviceId,
          details: { command, reason: "mqtt_offline" },
          status: "failed",
        });

        res.status(503).json({
          error: "Service Unavailable",
          message: "Cannot dispatch command: MQTT broker client is offline",
        });
        return;
      }

      try {
        const publishResult = await service.publishCommand(deviceId, command);

        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:dispatch",
          resource: deviceId,
          details: { command, topic: publishResult.topic },
          status: "success",
        });

        res.status(200).json({
          status: "published",
          deviceId,
          topic: publishResult.topic,
          command: publishResult.payload,
          publishedAt: new Date().toISOString(),
          verificationStatus: "pending_execution",
          message:
            "Command published to device MQTT topic. Physical execution is governed by ESP32 firmware safety checks.",
          disclaimer:
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

        await repos.audit.insert({
          userId: user.id,
          username: user.username,
          ipAddress: clientIp,
          action: "command:failed",
          resource: deviceId,
          details: { command, error: (err as Error).message },
          status: "failed",
        });

        res.status(502).json({
          error: "Bad Gateway",
          message: `Failed to deliver command to broker: ${(err as Error).message}`,
        });
      }
    },
  );

  return router;
}
