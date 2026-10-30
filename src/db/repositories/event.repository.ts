import { Database, Statement } from "better-sqlite3";
import {
  NormalizedDeviceEvent,
  DeviceEventPayload,
  EventSeverity,
} from "../../types/index.js";
import { sanitize } from "../../utils/logger.js";
import { isSyntheticDevice } from "../../validation/telemetry.schema.js";

export interface EventQueryOptions {
  deviceId?: string;
  severity?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface EventRow {
  id: number;
  device_id: string;
  device_timestamp: string | null;
  raw_timestamp: number;
  received_at: string;
  uptime_ms: number;
  event_type: string;
  severity: string;
  message: string;
  raw_payload: string | null;
}

export class EventRepository {
  private insertStmt: Statement;

  constructor(private db: Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO event_history (
        device_id, device_timestamp, raw_timestamp, received_at,
        uptime_ms, event_type, severity, message, raw_payload
      ) VALUES (
        @device_id, @device_timestamp, @raw_timestamp, @received_at,
        @uptime_ms, @event_type, @severity, @message, @raw_payload
      )
    `);
  }

  public insert(event: NormalizedDeviceEvent): { id: number } {
    const rawPayloadJson = event.raw
      ? JSON.stringify(sanitize(event.raw))
      : null;

    const info = this.insertStmt.run({
      device_id: event.deviceId,
      device_timestamp: event.deviceTimestamp,
      raw_timestamp: event.raw?.ts ?? 0,
      received_at: event.receivedAt,
      uptime_ms: event.uptimeMs,
      event_type: event.type,
      severity: event.severity,
      message: event.message,
      raw_payload: rawPayloadJson,
    });

    return { id: Number(info.lastInsertRowid) };
  }

  public getHistory(options: EventQueryOptions = {}): {
    items: NormalizedDeviceEvent[];
    total: number;
  } {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.deviceId) {
      conditions.push("device_id = ?");
      params.push(options.deviceId);
    }

    if (options.severity) {
      conditions.push("severity = ?");
      params.push(options.severity);
    }

    if (options.type) {
      conditions.push("event_type = ?");
      params.push(options.type);
    }

    if (options.from) {
      conditions.push("received_at >= ?");
      params.push(options.from);
    }

    if (options.to) {
      conditions.push("received_at <= ?");
      params.push(options.to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM event_history ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM event_history
         ${whereClause}
         ORDER BY received_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as EventRow[];

    return {
      items: rows.map((r) => this.mapRowToDomain(r)),
      total: countRow.total,
    };
  }

  private mapRowToDomain(row: EventRow): NormalizedDeviceEvent {
    let rawParsed: DeviceEventPayload | undefined;
    if (row.raw_payload) {
      try {
        rawParsed = JSON.parse(row.raw_payload);
      } catch {
        // Fallback
      }
    }

    const isSynthetic = isSyntheticDevice(row.device_id);

    return {
      deviceId: row.device_id,
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      receivedAt: row.received_at,
      deviceTimestamp: row.device_timestamp,
      uptimeMs: row.uptime_ms,
      type: row.event_type,
      severity: row.severity as EventSeverity,
      message: row.message,
      raw: rawParsed ?? {
        ts: row.raw_timestamp,
        uptimeMs: row.uptime_ms,
        type: row.event_type,
        severity: row.severity,
        message: row.message,
      },
    };
  }
}
