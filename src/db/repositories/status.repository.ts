import { Database, Statement } from "better-sqlite3";
import { NormalizedDeviceStatus } from "../../types/index.js";
import { isSyntheticDevice } from "../../validation/telemetry.schema.js";

export interface StatusQueryOptions {
  deviceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface StatusRow {
  id?: number;
  device_id: string;
  status: string;
  updated_at?: string;
  received_at?: string;
}

export class StatusRepository {
  private upsertCurrentStmt: Statement;
  private insertHistoryStmt: Statement;

  constructor(private db: Database) {
    this.upsertCurrentStmt = this.db.prepare(`
      INSERT INTO device_current_status (device_id, status, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    this.insertHistoryStmt = this.db.prepare(`
      INSERT INTO status_history (device_id, status, received_at)
      VALUES (?, ?, ?)
    `);
  }

  public save(status: NormalizedDeviceStatus): void {
    const runTx = this.db.transaction(() => {
      this.upsertCurrentStmt.run(
        status.deviceId,
        status.status,
        status.receivedAt,
      );
      this.insertHistoryStmt.run(
        status.deviceId,
        status.status,
        status.receivedAt,
      );
    });

    runTx();
  }

  public getCurrent(deviceId: string): NormalizedDeviceStatus | null {
    const row = this.db
      .prepare(`SELECT * FROM device_current_status WHERE device_id = ?`)
      .get(deviceId) as StatusRow | undefined;

    if (!row) return null;

    const isSynthetic = isSyntheticDevice(row.device_id);

    return {
      deviceId: row.device_id,
      status: row.status as "online" | "offline",
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      receivedAt: row.updated_at || new Date().toISOString(),
    };
  }

  public getHistory(options: StatusQueryOptions = {}): {
    items: NormalizedDeviceStatus[];
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
      .prepare(`SELECT COUNT(*) as total FROM status_history ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM status_history
         ${whereClause}
         ORDER BY received_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as StatusRow[];

    return {
      items: rows.map((r) => {
        const isSynthetic = isSyntheticDevice(r.device_id);
        return {
          deviceId: r.device_id,
          status: r.status as "online" | "offline",
          isSynthetic,
          dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
          receivedAt: r.received_at || new Date().toISOString(),
        };
      }),
      total: countRow.total,
    };
  }
}
