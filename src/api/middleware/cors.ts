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

    const isAllowed =
      allowedOriginsList.includes("*") ||
      allowedOriginsList.includes(origin) ||
      allowedOriginsList.some((allowed) => {
        if (allowed.startsWith("*.")) {
          const rootDomain = allowed.slice(2);
          try {
            const originHost = new URL(origin).hostname;
            return originHost === rootDomain || originHost.endsWith("." + rootDomain);
          } catch {
            return false;
          }
        }
        return false;
      });

    if (isAllowed) {
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
