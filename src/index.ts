import { createApp } from "./app.js";
import { config, getSafeConfig } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { mqttService } from "./mqtt/client.js";
import { initializeDatabase, closeDatabaseLayer } from "./db/index.js";
import { wsGateway } from "./ws/gateway.js";

async function bootstrap() {
  try {
    // 1. Initialize unified database layer based on DATABASE_DRIVER
    // Fails fast with descriptive error if Turso credentials/connection fail (NO silent fallback)
    const dbLayer = await initializeDatabase(config.DATABASE_DRIVER, mqttService);

    // 2. Initialize Express application with unified asynchronous routes
    const app = createApp(mqttService);

    // 3. Start HTTP server
    const server = app.listen(config.PORT, () => {
      logger.info(`NEX-GAS Backend HTTP Server listening on port ${config.PORT}`, {
        port: config.PORT,
        nodeEnv: config.NODE_ENV,
        databaseDriver: dbLayer.driver,
        config: getSafeConfig(),
      });

      // 4. Attach WebSocket gateway to HTTP server
      wsGateway.attach(server, "/ws");

      // 5. Connect MQTT broker if auto-connect is enabled
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

    // 6. Graceful shutdown handler
    const gracefulShutdown = (signal: string) => {
      logger.info(`Received ${signal}, initiating graceful shutdown...`);
      server.close(async () => {
        logger.info("HTTP server closed.");
        try {
          await wsGateway.close();
          await mqttService.disconnect();
          await closeDatabaseLayer();
          logger.info("NEX-GAS Backend shutdown complete.");
          process.exit(0);
        } catch (err) {
          logger.error("Error during graceful shutdown", { error: (err as Error).message });
          process.exit(1);
        }
      });
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  } catch (err) {
    logger.error("FATAL: Backend failed to initialize and cannot start", {
      error: (err as Error).message,
      driver: config.DATABASE_DRIVER,
    });
    process.exit(1);
  }
}

bootstrap();
