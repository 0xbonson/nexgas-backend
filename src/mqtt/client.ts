import { EventEmitter } from "events";
import mqtt, { MqttClient, IClientOptions } from "mqtt";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getSubscriptionTopics, getCommandTopic } from "./topics.js";
import { parseIncomingMessage, MessageParseResult } from "./parser.js";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
  CommandPayload,
} from "../types/index.js";
import { commandSchema } from "../validation/command.schema.js";

export interface MqttServiceEvents {
  telemetry: (telemetry: NormalizedTelemetry) => void;
  state: (state: NormalizedDeviceState) => void;
  status: (status: NormalizedDeviceStatus) => void;
  event: (event: NormalizedDeviceEvent) => void;
  connection: (status: "connected" | "disconnected" | "reconnecting" | "offline") => void;
  parse_error: (errorResult: { error: string; rawTopic: string; rawPayload?: string }) => void;
}

export class NexGasMqttService extends EventEmitter {
  private client: MqttClient | null = null;
  private isConnected = false;
  private currentBackoffMs: number;
  private targetTopics: string[];

  constructor(customClient?: MqttClient) {
    super();
    this.currentBackoffMs = config.MQTT_RECONNECT_PERIOD_MS;
    this.targetTopics = getSubscriptionTopics([config.DEFAULT_DEVICE_ID]);

    if (customClient) {
      this.attachClient(customClient);
    }
  }

  /**
   * Builds HiveMQ Cloud TLS connection options from validated config.
   * Credentials and parameters are kept strictly confidential.
   */
  public getClientOptions(): IClientOptions {
    const randomSuffix = Math.random().toString(16).substring(2, 8);
    const clientId = `${config.MQTT_CLIENT_ID_PREFIX}-${randomSuffix}`;

    const options: IClientOptions = {
      clientId,
      protocol: "mqtts",
      port: config.MQTT_PORT,
      host: config.MQTT_HOST,
      username: config.MQTT_USERNAME || undefined,
      password: config.MQTT_PASSWORD || undefined,
      clean: true,
      keepalive: 60,
      reconnectPeriod: this.currentBackoffMs,
      connectTimeout: config.MQTT_CONNECT_TIMEOUT_MS,
      rejectUnauthorized: true, // Validate TLS certificates (ISRG Root X1 on HiveMQ Cloud)
    };

    return options;
  }

  /**
   * Initializes connection to HiveMQ Cloud.
   */
  public connect(): void {
    if (this.client) {
      logger.warn("MQTT client already initialized, skipping new connection request");
      return;
    }

    const options = this.getClientOptions();
    logger.info("Connecting to HiveMQ Cloud broker...", {
      host: options.host,
      port: options.port,
      protocol: options.protocol,
      clientId: options.clientId,
      sslVerified: options.rejectUnauthorized,
    });

    try {
      const client = mqtt.connect(options);
      this.attachClient(client);
    } catch (err) {
      logger.error("Failed to initiate MQTT connection", { error: (err as Error).message });
      this.emit("connection", "disconnected");
    }
  }

  /**
   * Attaches event listeners to an MQTT client instance (supports real or mock clients).
   */
  public attachClient(client: MqttClient): void {
    this.client = client;

    this.client.on("connect", () => {
      this.isConnected = true;
      this.currentBackoffMs = config.MQTT_RECONNECT_PERIOD_MS;
      logger.info("Successfully connected to MQTT broker");
      this.emit("connection", "connected");

      // Subscribe to all target telemetry, state, status, and event topics
      this.subscribe();
    });

    this.client.on("reconnect", () => {
      this.isConnected = false;
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * 1.5,
        30000,
      );
      logger.warn("Reconnecting to MQTT broker...", {
        nextBackoffMs: Math.round(this.currentBackoffMs),
      });
      this.emit("connection", "reconnecting");
    });

    this.client.on("close", () => {
      this.isConnected = false;
      logger.warn("MQTT connection closed");
      this.emit("connection", "disconnected");
    });

    this.client.on("offline", () => {
      this.isConnected = false;
      logger.warn("MQTT client went offline");
      this.emit("connection", "offline");
    });

    this.client.on("error", (err: Error) => {
      logger.error("MQTT client error", { error: err.message });
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      this.handleIncomingMessage(topic, payload);
    });
  }

  /**
   * Subscribes to configured topic patterns with QoS 1 for reliable delivery.
   */
  public subscribe(): void {
    if (!this.client || !this.isConnected) {
      logger.warn("Cannot subscribe: MQTT client is not connected");
      return;
    }

    this.client.subscribe(this.targetTopics, { qos: 1 }, (err, granted) => {
      if (err) {
        logger.error("Failed to subscribe to topics", {
          topics: this.targetTopics,
          error: err.message,
        });
      } else {
        logger.info("Subscribed to NEX-GAS topics", {
          topics: granted?.map((g) => g.topic) ?? this.targetTopics,
        });
      }
    });
  }

  /**
   * Processes an incoming message, validates with Zod, and emits domain events.
   * Corrupted or invalid payloads do not crash the application.
   */
  public handleIncomingMessage(topic: string, payload: Buffer | string): MessageParseResult {
    const result = parseIncomingMessage(topic, payload);

    if (!result.success) {
      this.emit("parse_error", {
        error: result.error,
        rawTopic: result.rawTopic,
        rawPayload: result.rawPayload,
      });
      return result;
    }

    switch (result.type) {
      case "telemetry":
        this.emit("telemetry", result.data);
        break;
      case "state":
        this.emit("state", result.data);
        break;
      case "status":
        this.emit("status", result.data);
        break;
      case "event":
        this.emit("event", result.data);
        break;
    }

    return result;
  }

  /**
   * Publishes a validated command payload to nexgas/{deviceId}/cmd with QoS 1.
   *
   * IMPORTANT ARCHITECTURAL & SAFETY NOTICE:
   * Resolving this promise only confirms that the MQTT broker received the command.
   * IT DOES NOT MEAN THE PHYSICAL DEVICE HAS EXECUTED IT.
   * Physical valve safety is strictly maintained by the ESP32 firmware.
   */
  public async publishCommand(
    deviceId: string,
    command: CommandPayload,
  ): Promise<{ published: boolean; topic: string; payload: CommandPayload }> {
    const validated = commandSchema.parse(command);
    const topic = getCommandTopic(deviceId);

    if (!this.client || !this.isConnected) {
      throw new Error(`Cannot publish command: MQTT client is offline`);
    }

    const payloadString = JSON.stringify(validated);

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payloadString, { qos: 1 }, (err) => {
        if (err) {
          logger.error("Failed to publish command to MQTT", {
            topic,
            error: err.message,
          });
          reject(err);
        } else {
          logger.info("Published command to device", {
            topic,
            command: validated,
          });
          resolve({
            published: true,
            topic,
            payload: validated,
          });
        }
      });
    });
  }

  /**
   * Disconnects from MQTT broker.
   */
  public async disconnect(): Promise<void> {
    if (!this.client) return;

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.isConnected = false;
        this.client = null;
        logger.info("MQTT client disconnected gracefully");
        resolve();
      });
    });
  }

  public getConnected(): boolean {
    return this.isConnected;
  }

  public getTargetTopics(): string[] {
    return [...this.targetTopics];
  }

  public getCurrentBackoffMs(): number {
    return this.currentBackoffMs;
  }
}

export const mqttService = new NexGasMqttService();