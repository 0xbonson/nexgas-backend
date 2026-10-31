import { NexGasMqttService } from "../../mqtt/client.js";
import { TelemetryTursoRepository } from "./repositories/telemetry.turso.repository.js";
import { StateTursoRepository } from "./repositories/state.turso.repository.js";
import { StatusTursoRepository } from "./repositories/status.turso.repository.js";
import { EventTursoRepository } from "./repositories/event.turso.repository.js";
import { UserTursoRepository } from "./repositories/user.turso.repository.js";
import { RefreshSessionTursoRepository } from "./repositories/refresh-session.turso.repository.js";
import { AuditTursoRepository } from "./repositories/audit.turso.repository.js";
import { logger } from "../../utils/logger.js";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
} from "../../types/index.js";
import { DatabaseRepositories } from "../interfaces.js";

export type TursoDatabaseRepositories = DatabaseRepositories;

export interface RetryQueueOptions {
  maxCapacity?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  flushIntervalMs?: number;
}

interface RetryQueueItem {
  id: string;
  type: "telemetry" | "state" | "status" | "event";
  payload: unknown;
  attempts: number;
  nextRetryAt: number;
}

/**
 * In-memory bounded retry queue for Turso Cloud operations during transient network outages.
 *
 * CHARACTERISTICS & BOUNDARIES:
 * - Non-blocking: Handlers return immediately, ensuring MQTT event loop is never frozen.
 * - Bounded memory: Drops oldest entries on overflow (default max 500 items) to prevent OOM.
 * - Exponential backoff: Backs off 2s, 4s, 8s, up to 60s.
 * - Non-durable: Stored in process memory. If the Node.js process crashes while the cloud
 *   is offline, un-flushed queue items are lost.
 */
export class TursoRetryQueue {
  private queue: RetryQueueItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isDraining = false;
  private totalEnqueued = 0;
  private totalRetried = 0;
  private totalExhausted = 0;

  private readonly maxCapacity: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly flushIntervalMs: number;

  constructor(
    private repos: TursoDatabaseRepositories,
    options: RetryQueueOptions = {},
  ) {
    this.maxCapacity = options.maxCapacity ?? 500;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.maxDelayMs = options.maxDelayMs ?? 60000;
    this.maxRetries = options.maxRetries ?? 5;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((err) => {
        logger.error("Error in Turso retry queue drain cycle", { error: (err as Error).message });
      });
    }, this.flushIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public enqueue(type: RetryQueueItem["type"], payload: unknown): boolean {
    if (this.queue.length >= this.maxCapacity) {
      const dropped = this.queue.shift();
      logger.warn("Turso retry queue overflow: oldest item evicted", {
        droppedType: dropped?.type,
        currentSize: this.queue.length,
        maxCapacity: this.maxCapacity,
      });
    }

    const item: RetryQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      payload,
      attempts: 0,
      nextRetryAt: Date.now() + this.baseDelayMs,
    };

    this.queue.push(item);
    this.totalEnqueued++;
    return true;
  }

  public async drain(): Promise<number> {
    if (this.isDraining || this.queue.length === 0) return 0;
    this.isDraining = true;

    let processedCount = 0;
    const now = Date.now();

    try {
      const itemsToProcess = this.queue.filter((item) => item.nextRetryAt <= now);

      for (const item of itemsToProcess) {
        let success = false;
        try {
          if (item.type === "telemetry") {
            await this.repos.telemetry.insert(item.payload as NormalizedTelemetry);
            success = true;
          } else if (item.type === "state") {
            await this.repos.state.save(item.payload as NormalizedDeviceState);
            success = true;
          } else if (item.type === "status") {
            await this.repos.status.save(item.payload as NormalizedDeviceStatus);
            success = true;
          } else if (item.type === "event") {
            await this.repos.event.insert(item.payload as NormalizedDeviceEvent);
            success = true;
          }
        } catch {
          success = false;
        }

        if (success) {
          this.queue = this.queue.filter((q) => q.id !== item.id);
          this.totalRetried++;
          processedCount++;
          logger.debug("Successfully persisted buffered MQTT item to Turso on retry", {
            type: item.type,
            attempts: item.attempts + 1,
            remainingQueue: this.queue.length,
          });
        } else {
          item.attempts++;
          if (item.attempts >= this.maxRetries) {
            this.queue = this.queue.filter((q) => q.id !== item.id);
            this.totalExhausted++;
            logger.error("Turso retry queue item exceeded max retries and was discarded", {
              type: item.type,
              attempts: item.attempts,
              maxRetries: this.maxRetries,
            });
          } else {
            const delay = Math.min(
              this.baseDelayMs * Math.pow(2, item.attempts),
              this.maxDelayMs,
            );
            item.nextRetryAt = Date.now() + delay;
          }
        }
      }
    } finally {
      this.isDraining = false;
    }

    return processedCount;
  }

  public getStats() {
    return {
      queued: this.queue.length,
      totalEnqueued: this.totalEnqueued,
      totalRetried: this.totalRetried,
      totalExhausted: this.totalExhausted,
    };
  }

  public clear(): void {
    this.queue = [];
  }
}

export class TursoMqttDatabaseBridge {
  private telemetryHandler: (t: NormalizedTelemetry) => void;
  private stateHandler: (s: NormalizedDeviceState) => void;
  private statusHandler: (st: NormalizedDeviceStatus) => void;
  private eventHandler: (e: NormalizedDeviceEvent) => void;
  private isAttached = false;
  public readonly retryQueue: TursoRetryQueue;

  constructor(
    private mqttService: NexGasMqttService,
    private repos: TursoDatabaseRepositories,
    retryOptions?: RetryQueueOptions,
  ) {
    this.retryQueue = new TursoRetryQueue(repos, retryOptions);

    this.telemetryHandler = async (telemetry: NormalizedTelemetry) => {
      try {
        const res = await this.repos.telemetry.insert(telemetry);
        if (res.inserted) {
          logger.debug("Persisted telemetry message to Turso", {
            deviceId: telemetry.deviceId,
            id: res.id,
          });
        } else {
          logger.debug("Skipped duplicate/replayed telemetry message in Turso", {
            deviceId: telemetry.deviceId,
            id: res.id,
          });
        }
      } catch (err) {
        logger.warn("Turso telemetry insert failed, queuing for retry", {
          deviceId: telemetry.deviceId,
          error: (err as Error).message,
        });
        this.retryQueue.enqueue("telemetry", telemetry);
      }
    };

    this.stateHandler = async (state: NormalizedDeviceState) => {
      try {
        await this.repos.state.save(state);
        logger.debug("Persisted state update to Turso", {
          deviceId: state.deviceId,
          valveOpen: state.valveOpen,
          mode: state.valveMode,
        });
      } catch (err) {
        logger.warn("Turso state insert failed, queuing for retry", {
          deviceId: state.deviceId,
          error: (err as Error).message,
        });
        this.retryQueue.enqueue("state", state);
      }
    };

    this.statusHandler = async (status: NormalizedDeviceStatus) => {
      try {
        await this.repos.status.save(status);
        logger.debug("Persisted status update to Turso", {
          deviceId: status.deviceId,
          status: status.status,
        });
      } catch (err) {
        logger.warn("Turso status insert failed, queuing for retry", {
          deviceId: status.deviceId,
          error: (err as Error).message,
        });
        this.retryQueue.enqueue("status", status);
      }
    };

    this.eventHandler = async (event: NormalizedDeviceEvent) => {
      try {
        const res = await this.repos.event.insert(event);
        logger.debug("Persisted alert event to Turso", {
          deviceId: event.deviceId,
          id: res.id,
          type: event.type,
          severity: event.severity,
        });
      } catch (err) {
        logger.warn("Turso event insert failed, queuing for retry", {
          deviceId: event.deviceId,
          error: (err as Error).message,
        });
        this.retryQueue.enqueue("event", event);
      }
    };
  }

  public attach(): void {
    if (this.isAttached) {
      logger.warn("TursoMqttDatabaseBridge is already attached");
      return;
    }

    this.mqttService.on("telemetry", this.telemetryHandler);
    this.mqttService.on("state", this.stateHandler);
    this.mqttService.on("status", this.statusHandler);
    this.mqttService.on("event", this.eventHandler);

    this.retryQueue.start();
    this.isAttached = true;
    logger.info("Turso MQTT-to-Database persistence bridge attached");
  }

  public detach(): void {
    if (!this.isAttached) return;

    this.mqttService.off("telemetry", this.telemetryHandler);
    this.mqttService.off("state", this.stateHandler);
    this.mqttService.off("status", this.statusHandler);
    this.mqttService.off("event", this.eventHandler);

    this.retryQueue.stop();
    this.isAttached = false;
    logger.info("Turso MQTT-to-Database persistence bridge detached");
  }
}
