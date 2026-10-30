import { Database, Statement } from "better-sqlite3";
import { NormalizedDeviceState, ValveMode } from "../../types/index.js";

export interface StateQueryOptions {
  deviceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface StateRow {
  id?: number;
  device_id: string;
  valve_open: number;
  valve_mode: string;
  filter_warning: number;
  leak_warning: number;
  filter_health: number;
  pressure_calibrated: number;
  ph_calibrated: number;
  sensors_ready: number;
  buffered: number;
  uptime_ms: number;
  firmware: string;
  updated_at?: string;
  received_at?: string;
}

export class StateRepository {
  private upsertCurrentStmt: Statement;
  private insertHistoryStmt: Statement;

  constructor(private db: Database) {
    this.upsertCurrentStmt = this.db.prepare(`
      INSERT INTO device_current_state (
        device_id, valve_open, valve_mode, filter_warning, leak_warning,
        filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
        buffered, uptime_ms, firmware, updated_at
      ) VALUES (
        @device_id, @valve_open, @valve_mode, @filter_warning, @leak_warning,
        @filter_health, @pressure_calibrated, @ph_calibrated, @sensors_ready,
        @buffered, @uptime_ms, @firmware, @updated_at
      )
      ON CONFLICT(device_id) DO UPDATE SET
        valve_open = excluded.valve_open,
        valve_mode = excluded.valve_mode,
        filter_warning = excluded.filter_warning,
        leak_warning = excluded.leak_warning,
        filter_health = excluded.filter_health,
        pressure_calibrated = excluded.pressure_calibrated,
        ph_calibrated = excluded.ph_calibrated,
        sensors_ready = excluded.sensors_ready,
        buffered = excluded.buffered,
        uptime_ms = excluded.uptime_ms,
        firmware = excluded.firmware,
        updated_at = excluded.updated_at
    `);

    this.insertHistoryStmt = this.db.prepare(`
      INSERT INTO state_history (
        device_id, valve_open, valve_mode, filter_warning, leak_warning,
        filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
        buffered, uptime_ms, firmware, received_at
      ) VALUES (
        @device_id, @valve_open, @valve_mode, @filter_warning, @leak_warning,
        @filter_health, @pressure_calibrated, @ph_calibrated, @sensors_ready,
        @buffered, @uptime_ms, @firmware, @received_at
      )
    `);
  }

  public save(state: NormalizedDeviceState): void {
    const params = {
      device_id: state.deviceId,
      valve_open: state.valveOpen ? 1 : 0,
      valve_mode: state.valveMode,
      filter_warning: state.filterWarning ? 1 : 0,
      leak_warning: state.leakWarning ? 1 : 0,
      filter_health: state.filterHealth,
      pressure_calibrated: state.pressureCalibrated ? 1 : 0,
      ph_calibrated: state.phCalibrated ? 1 : 0,
      sensors_ready: state.sensorsReady ? 1 : 0,
      buffered: state.buffered,
      uptime_ms: state.uptimeMs,
      firmware: state.firmware,
      updated_at: state.receivedAt,
      received_at: state.receivedAt,
    };

    const runTx = this.db.transaction(() => {
      this.upsertCurrentStmt.run(params);
      this.insertHistoryStmt.run(params);
    });

    runTx();
  }

  public getCurrent(deviceId: string): NormalizedDeviceState | null {
    const row = this.db
      .prepare(`SELECT * FROM device_current_state WHERE device_id = ?`)
      .get(deviceId) as StateRow | undefined;

    return row ? this.mapRowToDomain(row) : null;
  }

  public getHistory(options: StateQueryOptions = {}): {
    items: NormalizedDeviceState[];
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
      .prepare(`SELECT COUNT(*) as total FROM state_history ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM state_history
         ${whereClause}
         ORDER BY received_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as StateRow[];

    return {
      items: rows.map((r) => this.mapRowToDomain(r)),
      total: countRow.total,
    };
  }

  private mapRowToDomain(row: StateRow): NormalizedDeviceState {
    return {
      deviceId: row.device_id,
      valveOpen: Boolean(row.valve_open),
      valveMode: row.valve_mode as ValveMode,
      filterWarning: Boolean(row.filter_warning),
      leakWarning: Boolean(row.leak_warning),
      filterHealth: row.filter_health,
      pressureCalibrated: Boolean(row.pressure_calibrated),
      phCalibrated: Boolean(row.ph_calibrated),
      sensorsReady: Boolean(row.sensors_ready),
      buffered: row.buffered,
      uptimeMs: row.uptime_ms,
      firmware: row.firmware,
      receivedAt: row.updated_at || row.received_at || new Date().toISOString(),
    };
  }
}
