import { Client, Row } from "@libsql/client";
import { NormalizedTelemetry, RawTelemetryPayload } from "../../../types/index.js";
import { sanitize } from "../../../utils/logger.js";
import { isSyntheticDevice } from "../../../validation/telemetry.schema.js";
import { TelemetryQueryOptions } from "../../repositories/telemetry.repository.js";
import { ITelemetryRepository } from "../../interfaces.js";

export class TelemetryTursoRepository implements ITelemetryRepository {
  constructor(private client: Client) {}

  public async insert(
    telemetry: NormalizedTelemetry,
  ): Promise<{ inserted: boolean; id: number }> {
    // Replay / duplicate detection: if raw timestamp > 0, check existing entry
    if (telemetry.rawTimestamp > 0) {
      const existing = await this.client.execute({
        sql: `SELECT id FROM telemetry_history
              WHERE device_id = ? AND raw_timestamp = ? AND uptime_ms = ?
              LIMIT 1`,
        args: [telemetry.deviceId, telemetry.rawTimestamp, telemetry.uptimeMs],
      });

      if (existing.rows.length > 0) {
        return {
          inserted: false,
          id: Number(existing.rows[0].id),
        };
      }
    }

    const rawPayloadJson = telemetry.raw
      ? JSON.stringify(sanitize(telemetry.raw))
      : null;

    const res = await this.client.execute({
      sql: `
        INSERT INTO telemetry_history (
          device_id, device_timestamp, raw_timestamp, received_at, uptime_ms,
          h2s_before, h2s_after, ch4_estimate, leak_ppm,
          pressure_digester_kpa, pressure_collector_kpa,
          temperature_c, humidity_pct, gas_line_temperature_c, gas_line_humidity_pct,
          ph, flow_estimate_lpm, gas_since_start_total_l,
          sensors_ready, rssi, raw_payload
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `,
      args: [
        telemetry.deviceId,
        telemetry.deviceTimestamp ?? null,
        telemetry.rawTimestamp,
        telemetry.receivedAt,
        telemetry.uptimeMs,
        telemetry.h2sBefore ?? null,
        telemetry.h2sAfter ?? null,
        telemetry.ch4Estimate ?? null,
        telemetry.leakPpm ?? null,
        telemetry.pressureDigesterKpa ?? null,
        telemetry.pressureCollectorKpa ?? null,
        telemetry.temperatureC ?? null,
        telemetry.humidityPct ?? null,
        telemetry.gasLineTemperatureC ?? null,
        telemetry.gasLineHumidityPct ?? null,
        telemetry.ph ?? null,
        telemetry.flowEstimateLpm ?? null,
        telemetry.gasSinceStartTotalL ?? null,
        telemetry.sensorsReady ? 1 : 0,
        telemetry.rssi,
        rawPayloadJson,
      ],
    });

    return {
      inserted: true,
      id: Number(res.lastInsertRowid ?? 0),
    };
  }

  public async getLatest(
    deviceId: string,
  ): Promise<NormalizedTelemetry | null> {
    const res = await this.client.execute({
      sql: `
        SELECT * FROM telemetry_history
        WHERE device_id = ?
        ORDER BY received_at DESC, id DESC
        LIMIT 1
      `,
      args: [deviceId],
    });

    if (res.rows.length === 0) return null;
    return this.mapRowToDomain(res.rows[0]);
  }

  public async getHistory(
    options: TelemetryQueryOptions = {},
  ): Promise<{ items: NormalizedTelemetry[]; total: number }> {
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

    const countRes = await this.client.execute({
      sql: `SELECT COUNT(*) as total FROM telemetry_history ${whereClause}`,
      args: params,
    });
    const total = Number(countRes.rows[0]?.total ?? 0);

    const query = `
      SELECT * FROM telemetry_history
      ${whereClause}
      ORDER BY received_at ${orderDirection}, id ${orderDirection}
      LIMIT ? OFFSET ?
    `;

    const rowsRes = await this.client.execute({
      sql: query,
      args: [...params, limit, offset],
    });

    return {
      items: rowsRes.rows.map((r) => this.mapRowToDomain(r)),
      total,
    };
  }

  public async count(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM telemetry_history",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    const res = await this.client.execute({
      sql: "DELETE FROM telemetry_history WHERE received_at < ?",
      args: [cutoffIso],
    });
    return Number(res.rowsAffected ?? 0);
  }

  private mapRowToDomain(row: Row): NormalizedTelemetry {
    let rawParsed: RawTelemetryPayload | undefined;
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

    const rawTimestamp = Number(row.raw_timestamp ?? 0);
    const uptimeMs = Number(row.uptime_ms ?? 0);
    const h2sBefore = row.h2s_before !== null ? Number(row.h2s_before) : null;
    const h2sAfter = row.h2s_after !== null ? Number(row.h2s_after) : null;
    const ch4Estimate = row.ch4_estimate !== null ? Number(row.ch4_estimate) : null;
    const leakPpm = row.leak_ppm !== null ? Number(row.leak_ppm) : null;
    const pressureDigesterKpa =
      row.pressure_digester_kpa !== null ? Number(row.pressure_digester_kpa) : null;
    const pressureCollectorKpa =
      row.pressure_collector_kpa !== null ? Number(row.pressure_collector_kpa) : null;
    const temperatureC =
      row.temperature_c !== null ? Number(row.temperature_c) : null;
    const humidityPct =
      row.humidity_pct !== null ? Number(row.humidity_pct) : null;
    const gasLineTemperatureC =
      row.gas_line_temperature_c !== null ? Number(row.gas_line_temperature_c) : null;
    const gasLineHumidityPct =
      row.gas_line_humidity_pct !== null ? Number(row.gas_line_humidity_pct) : null;
    const ph = row.ph !== null ? Number(row.ph) : null;
    const flowEstimateLpm =
      row.flow_estimate_lpm !== null ? Number(row.flow_estimate_lpm) : null;
    const gasSinceStartTotalL =
      row.gas_since_start_total_l !== null ? Number(row.gas_since_start_total_l) : null;
    const sensorsReady = Boolean(row.sensors_ready);
    const rssi = Number(row.rssi ?? 0);

    return {
      deviceId,
      isSynthetic,
      dataSource: isSynthetic ? "SYNTHETIC_DEMO" : "REAL_HARDWARE",
      receivedAt: String(row.received_at),
      deviceTimestamp: (row.device_timestamp as string | null) ?? null,
      rawTimestamp,
      uptimeMs,
      h2sBefore,
      h2sAfter,
      ch4Estimate,
      leakPpm,
      pressureDigesterKpa,
      pressureCollectorKpa,
      temperatureC,
      humidityPct,
      gasLineTemperatureC,
      gasLineHumidityPct,
      ph,
      flowEstimateLpm,
      gasSinceStartTotalL,
      sensorsReady,
      rssi,
      raw: rawParsed ?? {
        ts: rawTimestamp,
        uptimeMs,
        h2sBefore: h2sBefore ?? -1,
        h2sAfter: h2sAfter ?? -1,
        ch4: ch4Estimate ?? -1,
        leak: leakPpm ?? -1,
        pressureDigester: pressureDigesterKpa ?? -1,
        pressureCollector: pressureCollectorKpa ?? -1,
        temperature: temperatureC ?? -1,
        humidity: humidityPct ?? -1,
        gasLineTemperature: gasLineTemperatureC ?? -1,
        gasLineHumidity: gasLineHumidityPct ?? -1,
        ph: ph ?? -1,
        flow: flowEstimateLpm ?? -1,
        gasSinceStartL: gasSinceStartTotalL ?? -1,
        sensorsReady,
        rssi,
      },
    };
  }
}

