import cors from "cors";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const allowedOriginsList = config.CORS_ALLOWED_ORIGINS
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow non-browser requests without origin (cURL, mobile clients, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOriginsList.includes(origin) || allowedOriginsList.includes("*")) {
      return callback(null, true);
    }

    logger.warn(`CORS request rejected for origin: "${origin}"`);
    return callback(new Error(`CORS origin not allowed: "${origin}"`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
});
