import { Client, Row } from "@libsql/client";
import { NormalizedDeviceState, ValveMode } from "../../../types/index.js";
import { isSyntheticDevice } from "../../../validation/telemetry.schema.js";
import { StateQueryOptions } from "../../repositories/state.repository.js";
import { IStateRepository } from "../../interfaces.js";

export class StateTursoRepository implements IStateRepository {
  constructor(private client: Client) {}

  public async save(state: NormalizedDeviceState): Promise<void> {
    const valveOpenInt = state.valveOpen ? 1 : 0;
    const filterWarningInt = state.filterWarning ? 1 : 0;
    const leakWarningInt = state.leakWarning ? 1 : 0;
    const pressureCalibratedInt = state.pressureCalibrated ? 1 : 0;
    const phCalibratedInt = state.phCalibrated ? 1 : 0;
    const sensorsReadyInt = state.sensorsReady ? 1 : 0;

    const upsertStmt = {
      sql: `
        INSERT INTO device_current_state (
          device_id, valve_open, valve_mode, filter_warning, leak_warning,
          filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
          buffered, uptime_ms, firmware, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
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
      `,
      args: [
        state.deviceId,
        valveOpenInt,
        state.valveMode,
        filterWarningInt,
        leakWarningInt,
        state.filterHealth,
        pressureCalibratedInt,
        phCalibratedInt,
        sensorsReadyInt,
        state.buffered,
        state.uptimeMs,
        state.firmware,
        state.receivedAt,
      ],
    };

    const insertHistoryStmt = {
      sql: `
        INSERT INTO state_history (
          device_id, valve_open, valve_mode, filter_warning, leak_warning,
          filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
          buffered, uptime_ms, firmware, received_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `,
      args: [
        state.deviceId,
        valveOpenInt,
        state.valveMode,
        filterWarningInt,
        leakWarningInt,
        state.filterHealth,
        pressureCalibratedInt,
        phCalibratedInt,
        sensorsReadyInt,
        state.buffered,
        state.uptimeMs,
        state.firmware,
        state.receivedAt,
      ],
    };

    // Execute atomically via batch
    await this.client.batch([upsertStmt, insertHistoryStmt], "write");
  }

  public async getCurrent(
    deviceId: string,
  ): Promise<NormalizedDeviceState | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM device_current_state WHERE device_id = ?`,
      args: [deviceId],
    });

    if (res.rows.length === 0) return null;
    return this.mapRowToDomain(res.rows[0]);
  }

  public async getHistory(
    options: StateQueryOptions = {},
  ): Promise<{ items: NormalizedDeviceState[]; total: number }> {
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
      sql: `SELECT COUNT(*) as total FROM state_history ${whereClause}`,
      args: params,
    });
    const total = Number(countRes.rows[0]?.total ?? 0);

    const rowsRes = await this.client.execute({
      sql: `
        SELECT * FROM state_history
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
      "SELECT COUNT(*) as count FROM state_history",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private mapRowToDomain(row: Row): NormalizedDeviceState {
    const deviceId = String(row.device_id);
    const isSynthetic = isSyntheticDevice(deviceId);

    return {
      deviceId,
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      valveOpen: Boolean(row.valve_open),
      valveMode: String(row.valve_mode) as ValveMode,
      filterWarning: Boolean(row.filter_warning),
      leakWarning: Boolean(row.leak_warning),
      filterHealth: Number(row.filter_health),
      pressureCalibrated: Boolean(row.pressure_calibrated),
      phCalibrated: Boolean(row.ph_calibrated),
      sensorsReady: Boolean(row.sensors_ready),
      buffered: Number(row.buffered),
      uptimeMs: Number(row.uptime_ms),
      firmware: String(row.firmware),
      receivedAt: String(row.received_at || row.updated_at || new Date().toISOString()),
    };
  }
}

