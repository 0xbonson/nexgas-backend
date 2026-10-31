import { Client, Row } from "@libsql/client";
import {
  NormalizedDeviceEvent,
  DeviceEventPayload,
  EventSeverity,
} from "../../../types/index.js";
import { sanitize } from "../../../utils/logger.js";
import { isSyntheticDevice } from "../../../validation/telemetry.schema.js";
import { EventQueryOptions } from "../../repositories/event.repository.js";
import { IEventRepository } from "../../interfaces.js";

export class EventTursoRepository implements IEventRepository {
  constructor(private client: Client) {}

  public async insert(
    event: NormalizedDeviceEvent,
  ): Promise<{ id: number }> {
    const rawPayloadJson = event.raw
      ? JSON.stringify(sanitize(event.raw))
      : null;

    const res = await this.client.execute({
      sql: `
        INSERT INTO event_history (
          device_id, device_timestamp, raw_timestamp, received_at,
          uptime_ms, event_type, severity, message, raw_payload
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `,
      args: [
        event.deviceId,
        event.deviceTimestamp ?? null,
        event.raw?.ts ?? 0,
        event.receivedAt,
        event.uptimeMs,
        event.type,
        event.severity,
        event.message,
        rawPayloadJson,
      ],
    });

    return { id: Number(res.lastInsertRowid ?? 0) };
  }

  public async getHistory(
    options: EventQueryOptions = {},
  ): Promise<{ items: NormalizedDeviceEvent[]; total: number }> {
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

    const countRes = await this.client.execute({
      sql: `SELECT COUNT(*) as total FROM event_history ${whereClause}`,
      args: params,
    });
    const total = Number(countRes.rows[0]?.total ?? 0);

    const rowsRes = await this.client.execute({
      sql: `
        SELECT * FROM event_history
        ${whereClause}
        ORDER BY received_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      args: [...params, limit, offset],
    });

    return {
      items: rowsRes.rows.map((r) => this.mapRowToDomain(r)),
      total,
    };
  }

  public async count(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM event_history",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private mapRowToDomain(row: Row): NormalizedDeviceEvent {
    let rawParsed: DeviceEventPayload | undefined;
    const rawPayload = row.raw_payload as string | null;

    if (rawPayload) {
      try {
        rawParsed = JSON.parse(rawPayload);
      } catch {
        // Fallback if corrupt
      }
    }

    const deviceId = String(row.device_id);
    const isSynthetic = isSyntheticDevice(deviceId);

    return {
      deviceId,
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      type: String(row.event_type),
      severity: String(row.severity) as EventSeverity,
      message: String(row.message),
      receivedAt: String(row.received_at),
      deviceTimestamp: (row.device_timestamp as string | null) ?? null,
      uptimeMs: Number(row.uptime_ms ?? 0),
      raw: rawParsed ?? {
        ts: Number(row.raw_timestamp ?? 0),
        uptimeMs: Number(row.uptime_ms ?? 0),
        type: String(row.event_type),
        severity: String(row.severity),
        message: String(row.message),
      },
    };
  }
}
