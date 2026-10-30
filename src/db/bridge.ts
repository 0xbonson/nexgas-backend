import { NexGasMqttService } from "../mqtt/client.js";
import { TelemetryRepository } from "./repositories/telemetry.repository.js";
import { StateRepository } from "./repositories/state.repository.js";
import { StatusRepository } from "./repositories/status.repository.js";
import { EventRepository } from "./repositories/event.repository.js";
import { logger } from "../utils/logger.js";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
} from "../types/index.js";

export interface DatabaseRepositories {
  telemetry: TelemetryRepository;
  state: StateRepository;
  status: StatusRepository;
  event: EventRepository;
}

export class MqttDatabaseBridge {
  private telemetryHandler: (t: NormalizedTelemetry) => void;
  private stateHandler: (s: NormalizedDeviceState) => void;
  private statusHandler: (st: NormalizedDeviceStatus) => void;
  private eventHandler: (e: NormalizedDeviceEvent) => void;
  private isAttached = false;

  constructor(
    private mqttService: NexGasMqttService,
    private repos: DatabaseRepositories,
  ) {
    this.telemetryHandler = (telemetry: NormalizedTelemetry) => {
      try {
        const res = this.repos.telemetry.insert(telemetry);
        if (res.inserted) {
          logger.debug("Persisted telemetry message", {
            deviceId: telemetry.deviceId,
            id: res.id,
          });
        } else {
          logger.debug("Skipped duplicate/replayed telemetry message", {
            deviceId: telemetry.deviceId,
            id: res.id,
          });
        }
      } catch (err) {
        logger.error("Database failure while persisting telemetry (non-fatal)", {
          deviceId: telemetry.deviceId,
          error: (err as Error).message,
        });
      }
    };

    this.stateHandler = (state: NormalizedDeviceState) => {
      try {
        this.repos.state.save(state);
        logger.debug("Persisted device state transition", {
          deviceId: state.deviceId,
          valveMode: state.valveMode,
          valveOpen: state.valveOpen,
        });
      } catch (err) {
        logger.error("Database failure while persisting state (non-fatal)", {
          deviceId: state.deviceId,
          error: (err as Error).message,
        });
      }
    };

    this.statusHandler = (status: NormalizedDeviceStatus) => {
      try {
        this.repos.status.save(status);
        logger.info("Persisted device status transition", {
          deviceId: status.deviceId,
          status: status.status,
        });
      } catch (err) {
        logger.error("Database failure while persisting status (non-fatal)", {
          deviceId: status.deviceId,
          error: (err as Error).message,
        });
      }
    };

    this.eventHandler = (event: NormalizedDeviceEvent) => {
      try {
        const res = this.repos.event.insert(event);
        logger.info("Persisted hardware event", {
          deviceId: event.deviceId,
          type: event.type,
          severity: event.severity,
          id: res.id,
        });
      } catch (err) {
        logger.error("Database failure while persisting event (non-fatal)", {
          deviceId: event.deviceId,
          error: (err as Error).message,
        });
      }
    };
  }

  public attach(): void {
    if (this.isAttached) return;

    this.mqttService.on("telemetry", this.telemetryHandler);
    this.mqttService.on("state", this.stateHandler);
    this.mqttService.on("status", this.statusHandler);
    this.mqttService.on("event", this.eventHandler);

    this.isAttached = true;
    logger.info("MQTT-to-Database persistence bridge attached");
  }

  public detach(): void {
    if (!this.isAttached) return;

    this.mqttService.off("telemetry", this.telemetryHandler);
    this.mqttService.off("state", this.stateHandler);
    this.mqttService.off("status", this.statusHandler);
    this.mqttService.off("event", this.eventHandler);

    this.isAttached = false;
    logger.info("MQTT-to-Database persistence bridge detached");
  }

  public getAttached(): boolean {
    return this.isAttached;
  }
}
