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
    const isPublicMode = Boolean(config.PUBLIC_MQTT_TEST_MODE);
    const isPlaceholder =
      !isPublicMode &&
      (!config.MQTT_HOST ||
        config.MQTT_HOST.includes("your-cluster-id") ||
        !config.MQTT_USERNAME ||
        !config.MQTT_PASSWORD);

    if (isPlaceholder) {
      logger.warn(
        "MQTT_CONNECT_ON_STARTUP is enabled, but HiveMQ Cloud credentials (MQTT_HOST, MQTT_USERNAME, MQTT_PASSWORD) are unconfigured placeholders. Backend will remain in standby mode until real credentials are provided in .env.",
      );
    } else {
      if (isPublicMode) {
        logger.warn(
          "!!! RUNNING IN PUBLIC_MQTT_TEST_MODE (broker.hivemq.com:1883) !!! Remote actuator commands are disabled for safety.",
        );
      }
      logger.info("Auto-connecting to MQTT broker on startup...", {
        host: config.MQTT_HOST,
        port: config.MQTT_PORT,
        protocol: config.MQTT_PROTOCOL,
        publicMode: isPublicMode,
      });
      mqttService.connect();
    }
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