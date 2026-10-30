import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { NexGasMqttService, mqttService } from "../mqtt/client.js";
import { logger } from "../utils/logger.js";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
} from "../types/index.js";
import {
  formatTelemetryForFrontend,
  formatSystemStateForFrontend,
  formatEventToAppNotification,
} from "../api/formatters.js";

interface TrackedWebSocket extends WebSocket {
  isAlive: boolean;
}

export type WsBroadcastMessage =
  | {
      type: "telemetry";
      deviceId: string;
      isSynthetic: boolean;
      dataSource: "REAL_HARDWARE" | "SYNTHETIC_DEMO";
      receivedAt: string;
      data: NormalizedTelemetry;
      frontend: ReturnType<typeof formatTelemetryForFrontend>;
    }
  | {
      type: "state";
      deviceId: string;
      isSynthetic: boolean;
      dataSource: "REAL_HARDWARE" | "SYNTHETIC_DEMO";
      receivedAt: string;
      data: NormalizedDeviceState;
      frontend: ReturnType<typeof formatSystemStateForFrontend>;
    }
  | {
      type: "status";
      deviceId: string;
      isSynthetic: boolean;
      dataSource: "REAL_HARDWARE" | "SYNTHETIC_DEMO";
      receivedAt: string;
      data: NormalizedDeviceStatus;
    }
  | {
      type: "event";
      deviceId: string;
      isSynthetic: boolean;
      dataSource: "REAL_HARDWARE" | "SYNTHETIC_DEMO";
      receivedAt: string;
      data: NormalizedDeviceEvent;
      notification: ReturnType<typeof formatEventToAppNotification>;
    }
  | {
      type: "pong";
      timestamp: string;
    };

export class NexGasWebSocketGateway {
  private wss: WebSocketServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private telemetryHandler: (t: NormalizedTelemetry) => void;
  private stateHandler: (s: NormalizedDeviceState) => void;
  private statusHandler: (st: NormalizedDeviceStatus) => void;
  private eventHandler: (e: NormalizedDeviceEvent) => void;

  constructor(private service: NexGasMqttService = mqttService) {
    this.telemetryHandler = (t: NormalizedTelemetry) => {
      this.broadcast({
        type: "telemetry",
        deviceId: t.deviceId,
        isSynthetic: t.isSynthetic,
        dataSource: t.dataSource,
        receivedAt: t.receivedAt,
        data: t,
        frontend: formatTelemetryForFrontend(t),
      });
    };

    this.stateHandler = (s: NormalizedDeviceState) => {
      this.broadcast({
        type: "state",
        deviceId: s.deviceId,
        isSynthetic: s.isSynthetic,
        dataSource: s.dataSource,
        receivedAt: s.receivedAt,
        data: s,
        frontend: formatSystemStateForFrontend(s),
      });
    };

    this.statusHandler = (st: NormalizedDeviceStatus) => {
      this.broadcast({
        type: "status",
        deviceId: st.deviceId,
        isSynthetic: st.isSynthetic,
        dataSource: st.dataSource,
        receivedAt: st.receivedAt,
        data: st,
      });
    };

    this.eventHandler = (e: NormalizedDeviceEvent) => {
      this.broadcast({
        type: "event",
        deviceId: e.deviceId,
        isSynthetic: e.isSynthetic,
        dataSource: e.dataSource,
        receivedAt: e.receivedAt,
        data: e,
        notification: formatEventToAppNotification(e),
      });
    };
  }

  /**
   * Attaches WebSocket server to an existing HTTP server instance or port.
   */
  public attach(server: Server, path: string = "/ws"): WebSocketServer {
    this.wss = new WebSocketServer({ server, path });

    logger.info(`WebSocket Gateway attached to path "${path}"`);

    this.wss.on("connection", (ws: WebSocket, req) => {
      const client = ws as TrackedWebSocket;
      client.isAlive = true;

      const ip = req.socket.remoteAddress;
      logger.info(`WebSocket client connected from ${ip}`);

      client.on("pong", () => {
        client.isAlive = true;
      });

      client.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            client.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } catch {
          // Ignore unparseable client messages
        }
      });

      client.on("close", (code, reason) => {
        logger.debug("WebSocket client disconnected", {
          code,
          reason: reason.toString(),
        });
      });

      client.on("error", (err) => {
        logger.warn("WebSocket client error", { error: err.message });
      });
    });

    // Setup 30s ping-pong heartbeat
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;

      this.wss.clients.forEach((ws) => {
        const client = ws as TrackedWebSocket;
        if (!client.isAlive) {
          logger.debug("Terminating unresponsive WebSocket client");
          return client.terminate();
        }
        client.isAlive = false;
        client.ping();
      });
    }, 30000);

    // Bind MQTT service event subscriptions
    this.service.on("telemetry", this.telemetryHandler);
    this.service.on("state", this.stateHandler);
    this.service.on("status", this.statusHandler);
    this.service.on("event", this.eventHandler);

    return this.wss;
  }

  /**
   * Broadcasts a JSON message to all open WebSocket clients safely.
   */
  public broadcast(message: WsBroadcastMessage): void {
    if (!this.wss || this.wss.clients.size === 0) return;

    const serialized = JSON.stringify(message);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(serialized);
        } catch (err) {
          logger.warn("Failed to broadcast to WebSocket client", {
            error: (err as Error).message,
          });
        }
      }
    });
  }

  /**
   * Returns current active client count.
   */
  public getClientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /**
   * Closes the WebSocket server and unregisters listeners.
   */
  public close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.service.off("telemetry", this.telemetryHandler);
    this.service.off("state", this.stateHandler);
    this.service.off("status", this.statusHandler);
    this.service.off("event", this.eventHandler);

    if (!this.wss) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.wss!.clients.forEach((client) => client.terminate());
      this.wss!.close(() => {
        logger.info("WebSocket gateway closed");
        this.wss = null;
        resolve();
      });
    });
  }
}

export const wsGateway = new NexGasWebSocketGateway();
