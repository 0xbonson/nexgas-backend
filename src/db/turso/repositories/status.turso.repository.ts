import { Client, Row } from "@libsql/client";
import { NormalizedDeviceStatus } from "../../../types/index.js";
import { isSyntheticDevice } from "../../../validation/telemetry.schema.js";
import { StatusQueryOptions } from "../../repositories/status.repository.js";
import { IStatusRepository } from "../../interfaces.js";

export class StatusTursoRepository implements IStatusRepository {
  constructor(private client: Client) {}

  public async save(status: NormalizedDeviceStatus): Promise<void> {
    const upsertStmt = {
      sql: `
        INSERT INTO device_current_status (device_id, status, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
      args: [status.deviceId, status.status, status.receivedAt],
    };

    const insertHistoryStmt = {
      sql: `
        INSERT INTO status_history (device_id, status, received_at)
        VALUES (?, ?, ?)
      `,
      args: [status.deviceId, status.status, status.receivedAt],
    };

    // Execute atomically via batch
    await this.client.batch([upsertStmt, insertHistoryStmt], "write");
  }

  public async getCurrent(
    deviceId: string,
  ): Promise<NormalizedDeviceStatus | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM device_current_status WHERE device_id = ?`,
      args: [deviceId],
    });

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    const isSynthetic = isSyntheticDevice(String(row.device_id));

    return {
      deviceId: String(row.device_id),
      status: String(row.status) as "online" | "offline",
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      receivedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  public async getHistory(
    options: StatusQueryOptions = {},
  ): Promise<{ items: NormalizedDeviceStatus[]; total: number }> {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.deviceId) {
      conditions.push("device_id = ?");
      params.push(options.deviceId);
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
      sql: `SELECT COUNT(*) as total FROM status_history ${whereClause}`,
      args: params,
    });
    const total = Number(countRes.rows[0]?.total ?? 0);

    const rowsRes = await this.client.execute({
      sql: `
        SELECT * FROM status_history
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

  public async countHistory(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM status_history",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private mapRowToDomain(row: Row): NormalizedDeviceStatus {
    const deviceId = String(row.device_id);
    const isSynthetic = isSyntheticDevice(deviceId);

    return {
      deviceId,
      status: String(row.status) as "online" | "offline",
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      receivedAt: String(row.received_at || new Date().toISOString()),
    };
  }
}

