import { Database, Statement } from "better-sqlite3";
import { NormalizedTelemetry, RawTelemetryPayload } from "../../types/index.js";
import { sanitize } from "../../utils/logger.js";

export interface TelemetryQueryOptions {
  deviceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

interface TelemetryRow {
  id: number;
  device_id: string;
  device_timestamp: string | null;
  raw_timestamp: number;
  received_at: string;
  uptime_ms: number;
  h2s_before: number | null;
  h2s_after: number | null;
  ch4_estimate: number | null;
  leak_ppm: number | null;
  pressure_digester_kpa: number | null;
  pressure_collector_kpa: number | null;
  temperature_c: number | null;
  humidity_pct: number | null;
  gas_line_temperature_c: number | null;
  gas_line_humidity_pct: number | null;
  ph: number | null;
  flow_estimate_lpm: number | null;
  gas_since_start_total_l: number | null;
  sensors_ready: number;
  rssi: number;
  raw_payload: string | null;
}

export class TelemetryRepository {
  private insertStmt: Statement;
  private checkDuplicateStmt: Statement;

  constructor(private db: Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO telemetry_history (
        device_id, device_timestamp, raw_timestamp, received_at, uptime_ms,
        h2s_before, h2s_after, ch4_estimate, leak_ppm,
        pressure_digester_kpa, pressure_collector_kpa,
        temperature_c, humidity_pct, gas_line_temperature_c, gas_line_humidity_pct,
        ph, flow_estimate_lpm, gas_since_start_total_l,
        sensors_ready, rssi, raw_payload
      ) VALUES (
        @device_id, @device_timestamp, @raw_timestamp, @received_at, @uptime_ms,
        @h2s_before, @h2s_after, @ch4_estimate, @leak_ppm,
        @pressure_digester_kpa, @pressure_collector_kpa,
        @temperature_c, @humidity_pct, @gas_line_temperature_c, @gas_line_humidity_pct,
        @ph, @flow_estimate_lpm, @gas_since_start_total_l,
        @sensors_ready, @rssi, @raw_payload
      )
    `);

    this.checkDuplicateStmt = this.db.prepare(`
      SELECT id FROM telemetry_history
      WHERE device_id = ? AND raw_timestamp = ? AND uptime_ms = ?
      LIMIT 1
    `);
  }

  public insert(telemetry: NormalizedTelemetry): { inserted: boolean; id: number } {
    // Replay / duplicate detection: if device timestamp is non-zero, check existing entry
    if (telemetry.rawTimestamp > 0) {
      const existing = this.checkDuplicateStmt.get(
        telemetry.deviceId,
        telemetry.rawTimestamp,
        telemetry.uptimeMs,
      ) as { id: number } | undefined;

      if (existing) {
        return { inserted: false, id: existing.id };
      }
    }

    const rawPayloadJson = telemetry.raw
      ? JSON.stringify(sanitize(telemetry.raw))
      : null;

    const info = this.insertStmt.run({
      device_id: telemetry.deviceId,
      device_timestamp: telemetry.deviceTimestamp,
      raw_timestamp: telemetry.rawTimestamp,
      received_at: telemetry.receivedAt,
      uptime_ms: telemetry.uptimeMs,
      h2s_before: telemetry.h2sBefore,
      h2s_after: telemetry.h2sAfter,
      ch4_estimate: telemetry.ch4Estimate,
      leak_ppm: telemetry.leakPpm,
      pressure_digester_kpa: telemetry.pressureDigesterKpa,
      pressure_collector_kpa: telemetry.pressureCollectorKpa,
      temperature_c: telemetry.temperatureC,
      humidity_pct: telemetry.humidityPct,
      gas_line_temperature_c: telemetry.gasLineTemperatureC,
      gas_line_humidity_pct: telemetry.gasLineHumidityPct,
      ph: telemetry.ph,
      flow_estimate_lpm: telemetry.flowEstimateLpm,
      gas_since_start_total_l: telemetry.gasSinceStartTotalL,
      sensors_ready: telemetry.sensorsReady ? 1 : 0,
      rssi: telemetry.rssi,
      raw_payload: rawPayloadJson,
    });

    return { inserted: true, id: Number(info.lastInsertRowid) };
  }

  public getLatest(deviceId: string): NormalizedTelemetry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM telemetry_history
         WHERE device_id = ?
         ORDER BY received_at DESC, id DESC
         LIMIT 1`,
      )
      .get(deviceId) as TelemetryRow | undefined;

    return row ? this.mapRowToDomain(row) : null;
  }

  public getHistory(options: TelemetryQueryOptions = {}): {
    items: NormalizedTelemetry[];
    total: number;
  } {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);
    const orderDirection = options.order === "asc" ? "ASC" : "DESC";

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

    // Count total matching
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM telemetry_history ${whereClause}`)
      .get(...params) as { total: number };

    // Select paginated items
    const query = `
      SELECT * FROM telemetry_history
      ${whereClause}
      ORDER BY received_at ${orderDirection}, id ${orderDirection}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db
      .prepare(query)
      .all(...params, limit, offset) as TelemetryRow[];

    return {
      items: rows.map((r) => this.mapRowToDomain(r)),
      total: countRow.total,
    };
  }

  private mapRowToDomain(row: TelemetryRow): NormalizedTelemetry {
    let rawParsed: RawTelemetryPayload | undefined;
    if (row.raw_payload) {
      try {
        rawParsed = JSON.parse(row.raw_payload);
      } catch {
        // Fallback if corrupt
      }
    }

    return {
      deviceId: row.device_id,
      receivedAt: row.received_at,
      deviceTimestamp: row.device_timestamp,
      rawTimestamp: row.raw_timestamp,
      uptimeMs: row.uptime_ms,
      h2sBefore: row.h2s_before,
      h2sAfter: row.h2s_after,
      ch4Estimate: row.ch4_estimate,
      leakPpm: row.leak_ppm,
      pressureDigesterKpa: row.pressure_digester_kpa,
      pressureCollectorKpa: row.pressure_collector_kpa,
      temperatureC: row.temperature_c,
      humidityPct: row.humidity_pct,
      gasLineTemperatureC: row.gas_line_temperature_c,
      gasLineHumidityPct: row.gas_line_humidity_pct,
      ph: row.ph,
      flowEstimateLpm: row.flow_estimate_lpm,
      gasSinceStartTotalL: row.gas_since_start_total_l,
      sensorsReady: Boolean(row.sensors_ready),
      rssi: row.rssi,
      raw: rawParsed ?? {
        ts: row.raw_timestamp,
        uptimeMs: row.uptime_ms,
        h2sBefore: row.h2s_before ?? -1,
        h2sAfter: row.h2s_after ?? -1,
        ch4: row.ch4_estimate ?? -1,
        leak: row.leak_ppm ?? -1,
        pressureDigester: row.pressure_digester_kpa ?? -1,
        pressureCollector: row.pressure_collector_kpa ?? -1,
        temperature: row.temperature_c ?? -1,
        humidity: row.humidity_pct ?? -1,
        gasLineTemperature: row.gas_line_temperature_c ?? -1,
        gasLineHumidity: row.gas_line_humidity_pct ?? -1,
        ph: row.ph ?? -1,
        flow: row.flow_estimate_lpm ?? -1,
        gasSinceStartL: row.gas_since_start_total_l ?? -1,
        sensorsReady: Boolean(row.sensors_ready),
        rssi: row.rssi,
      },
    };
  }
}
