import { createApp } from "./app.js";
import { config, getSafeConfig } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { mqttService } from "./mqtt/client.js";
import { initializeDatabaseLayer, closeDatabase } from "./db/index.js";
import { wsGateway } from "./ws/gateway.js";

// Initialize SQLite schema migrations and attach MQTT persistence bridge
initializeDatabaseLayer(mqttService);

const app = createApp(mqttService);

const server = app.listen(config.PORT, () => {
  logger.info(`NEX-GAS Backend HTTP Server listening on port ${config.PORT}`, {
    port: config.PORT,
    nodeEnv: config.NODE_ENV,
    config: getSafeConfig(),
  });

  // Attach WebSocket gateway to HTTP server
  wsGateway.attach(server, "/ws");

  if (config.MQTT_CONNECT_ON_STARTUP) {
    logger.info("Auto-connecting to MQTT broker on startup...");
    mqttService.connect();
  } else {
    logger.info("MQTT auto-connect on startup is disabled (MQTT_CONNECT_ON_STARTUP=false).");
  }
});

function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}, initiating graceful shutdown...`);
  server.close(async () => {
    logger.info("HTTP server closed.");
    await wsGateway.close();
    await mqttService.disconnect();
    closeDatabase();
    logger.info("NEX-GAS Backend shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));