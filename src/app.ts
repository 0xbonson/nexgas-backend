import express, { Express, Request, Response, NextFunction } from "express";
import { mqttService, NexGasMqttService } from "./mqtt/client.js";
import { corsMiddleware } from "./api/middleware/cors.js";
import { createApiRouter } from "./api/routes.js";
import { logger } from "./utils/logger.js";

export function createApp(service: NexGasMqttService = mqttService): Express {
  const app = express();

  // Security & parsing middleware
  app.use(corsMiddleware);
  app.use(express.json({ limit: "100kb" }));

  // Mount API router
  app.use(createApiRouter(service));

  // Catch-all 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: "Endpoint does not exist",
    });
  });

  // Global safe error handling middleware
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled API error", {
      path: req.path,
      method: req.method,
      error: err.message,
    });

    if (err.message.includes("CORS")) {
      res.status(403).json({
        error: "Forbidden",
        message: err.message,
      });
      return;
    }

    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({
        error: "Bad Request",
        message: "Malformed JSON payload in request body",
      });
      return;
    }

    res.status(500).json({
      error: "Internal Server Error",
      message: "An internal server error occurred",
    });
  });

  return app;
}