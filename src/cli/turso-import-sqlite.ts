import fs from "fs";
import path from "path";
import DatabaseConstructor, { Database } from "better-sqlite3";
import { Client } from "@libsql/client";
import { config } from "../config/index.js";
import { createTursoClient, closeTursoClient } from "../db/turso/client.js";
import { runTursoMigrations } from "../db/turso/migrations.js";
import { logger } from "../utils/logger.js";

export interface ImportOptions {
  batchSize?: number;
  skipExpiredSessions?: boolean;
}

export interface TableImportResult {
  sourceRows: number;
  importedRows: number;
  read: number;
  inserted: number;
  targetCountAfter: number;
  verified: boolean;
}

export type ImportSummary = Record<string, TableImportResult>;

/**
 * Imports all data from a local SQLite database into Turso Cloud.
 *
 * SAFETY GUARDS:
 * 1. The SQLite source database is opened strictly in READONLY mode.
 * 2. All target inserts use ON CONFLICT DO NOTHING / ON CONFLICT DO UPDATE so imports are idempotent.
 * 3. Timestamp guards prevent overwriting newer device_current_state / device_current_status in Turso.
 * 4. Expired or revoked refresh sessions are filtered out by default.
 * 5. Explicit post-import COUNT(*) verification runs against Turso for every table.
 */
export async function importSqliteToTurso(
  sqliteDb: Database,
  tursoClient: Client,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const batchSize = options.batchSize || 50;
  const skipExpiredSessions = options.skipExpiredSessions !== false;

  // Ensure Turso migrations are up to date before importing
  await runTursoMigrations(tursoClient);

  const summary: ImportSummary = {};

  // Helper for count query
  async function getTargetCount(table: string): Promise<number> {
    const res = await tursoClient.execute(`SELECT COUNT(*) as count FROM ${table}`);
    return Number(res.rows[0]?.count ?? 0);
  }

  // 1. USERS
  {
    const rows = sqliteDb
      .prepare(
        "SELECT id, username, password_hash, role, is_active, created_at, updated_at FROM users ORDER BY id ASC",
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.username,
          r.password_hash,
          r.role,
          r.is_active,
          r.created_at,
          r.updated_at,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("users");
    summary.users = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 2. REFRESH SESSIONS (Security filtered)
  {
    const nowIso = new Date().toISOString();
    let query = "SELECT id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by_hash FROM refresh_sessions";
    const args: any[] = [];

    if (skipExpiredSessions) {
      query += " WHERE expires_at > ? AND revoked_at IS NULL AND replaced_by_hash IS NULL";
      args.push(nowIso);
    }
    query += " ORDER BY id ASC";

    const rows = sqliteDb.prepare(query).all(...args) as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO refresh_sessions (id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by_hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.user_id,
          r.token_hash,
          r.family_id,
          r.expires_at,
          r.created_at,
          r.revoked_at,
          r.replaced_by_hash,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("refresh_sessions");
    summary.refresh_sessions = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 3. AUDIT LOGS
  {
    const rows = sqliteDb
      .prepare(
        "SELECT id, user_id, username, ip_address, action, resource, details, status, created_at FROM audit_logs ORDER BY id ASC",
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO audit_logs (id, user_id, username, ip_address, action, resource, details, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.user_id,
          r.username,
          r.ip_address,
          r.action,
          r.resource,
          r.details,
          r.status,
          r.created_at,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("audit_logs");
    summary.audit_logs = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 4. DEVICE CURRENT STATE (Timestamp Guarded)
  {
    const rows = sqliteDb
      .prepare(
        `SELECT device_id, valve_open, valve_mode, filter_warning, leak_warning,
                filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
                buffered, uptime_ms, firmware, updated_at
         FROM device_current_state`,
      )
      .all() as any[];

    let inserted = 0;
    if (rows.length > 0) {
      const statements = rows.map((r) => ({
        sql: `INSERT INTO device_current_state (
                device_id, valve_open, valve_mode, filter_warning, leak_warning,
                filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
                buffered, uptime_ms, firmware, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              WHERE excluded.updated_at >= device_current_state.updated_at`,
        args: [
          r.device_id,
          r.valve_open,
          r.valve_mode,
          r.filter_warning,
          r.leak_warning,
          r.filter_health,
          r.pressure_calibrated,
          r.ph_calibrated,
          r.sensors_ready,
          r.buffered,
          r.uptime_ms,
          r.firmware,
          r.updated_at,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted = rows.length;
    }

    const targetCount = await getTargetCount("device_current_state");
    summary.device_current_state = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 5. STATE HISTORY
  {
    const rows = sqliteDb
      .prepare(
        `SELECT id, device_id, valve_open, valve_mode, filter_warning, leak_warning,
                filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
                buffered, uptime_ms, firmware, received_at
         FROM state_history ORDER BY id ASC`,
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO state_history (
                id, device_id, valve_open, valve_mode, filter_warning, leak_warning,
                filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
                buffered, uptime_ms, firmware, received_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.device_id,
          r.valve_open,
          r.valve_mode,
          r.filter_warning,
          r.leak_warning,
          r.filter_health,
          r.pressure_calibrated,
          r.ph_calibrated,
          r.sensors_ready,
          r.buffered,
          r.uptime_ms,
          r.firmware,
          r.received_at,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("state_history");
    summary.state_history = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 6. DEVICE CURRENT STATUS (Timestamp Guarded)
  {
    const rows = sqliteDb
      .prepare(
        "SELECT device_id, status, updated_at FROM device_current_status",
      )
      .all() as any[];

    let inserted = 0;
    if (rows.length > 0) {
      const statements = rows.map((r) => ({
        sql: `INSERT INTO device_current_status (device_id, status, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(device_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at
              WHERE excluded.updated_at >= device_current_status.updated_at`,
        args: [r.device_id, r.status, r.updated_at],
      }));
      await tursoClient.batch(statements, "write");
      inserted = rows.length;
    }

    const targetCount = await getTargetCount("device_current_status");
    summary.device_current_status = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 7. STATUS HISTORY
  {
    const rows = sqliteDb
      .prepare(
        "SELECT id, device_id, status, received_at FROM status_history ORDER BY id ASC",
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO status_history (id, device_id, status, received_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [r.id, r.device_id, r.status, r.received_at],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("status_history");
    summary.status_history = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 8. EVENT HISTORY
  {
    const rows = sqliteDb
      .prepare(
        `SELECT id, device_id, device_timestamp, raw_timestamp, received_at,
                uptime_ms, event_type, severity, message, raw_payload
         FROM event_history ORDER BY id ASC`,
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO event_history (
                id, device_id, device_timestamp, raw_timestamp, received_at,
                uptime_ms, event_type, severity, message, raw_payload
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.device_id,
          r.device_timestamp,
          r.raw_timestamp,
          r.received_at,
          r.uptime_ms,
          r.event_type,
          r.severity,
          r.message,
          r.raw_payload,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("event_history");
    summary.event_history = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  // 9. TELEMETRY HISTORY
  {
    const rows = sqliteDb
      .prepare(
        `SELECT id, device_id, device_timestamp, raw_timestamp, received_at, uptime_ms,
                h2s_before, h2s_after, ch4_estimate, leak_ppm,
                pressure_digester_kpa, pressure_collector_kpa,
                temperature_c, humidity_pct, gas_line_temperature_c, gas_line_humidity_pct,
                ph, flow_estimate_lpm, gas_since_start_total_l,
                sensors_ready, rssi, raw_payload
         FROM telemetry_history ORDER BY id ASC`,
      )
      .all() as any[];

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const statements = chunk.map((r) => ({
        sql: `INSERT INTO telemetry_history (
                id, device_id, device_timestamp, raw_timestamp, received_at, uptime_ms,
                h2s_before, h2s_after, ch4_estimate, leak_ppm,
                pressure_digester_kpa, pressure_collector_kpa,
                temperature_c, humidity_pct, gas_line_temperature_c, gas_line_humidity_pct,
                ph, flow_estimate_lpm, gas_since_start_total_l,
                sensors_ready, rssi, raw_payload
              ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?
              )
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.device_id,
          r.device_timestamp,
          r.raw_timestamp,
          r.received_at,
          r.uptime_ms,
          r.h2s_before,
          r.h2s_after,
          r.ch4_estimate,
          r.leak_ppm,
          r.pressure_digester_kpa,
          r.pressure_collector_kpa,
          r.temperature_c,
          r.humidity_pct,
          r.gas_line_temperature_c,
          r.gas_line_humidity_pct,
          r.ph,
          r.flow_estimate_lpm,
          r.gas_since_start_total_l,
          r.sensors_ready,
          r.rssi,
          r.raw_payload,
        ],
      }));
      await tursoClient.batch(statements, "write");
      inserted += chunk.length;
    }

    const targetCount = await getTargetCount("telemetry_history");
    summary.telemetry_history = {
      sourceRows: rows.length,
      importedRows: inserted,
      read: rows.length,
      inserted,
      targetCountAfter: targetCount,
      verified: targetCount >= rows.length,
    };
  }

  return summary;
}

// Direct CLI execution
if (
  process.argv[1]?.endsWith("turso-import-sqlite.ts") ||
  process.argv[1]?.endsWith("turso-import-sqlite.js")
) {
  const args = process.argv.slice(2);
  let cliSqlitePath: string | undefined;
  let cliUrl: string | undefined;
  let cliToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sqlite" && args[i + 1]) {
      cliSqlitePath = args[i + 1];
      i++;
    } else if (args[i] === "--url" && args[i + 1]) {
      cliUrl = args[i + 1];
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      cliToken = args[i + 1];
      i++;
    }
  }

  const sqlitePath = cliSqlitePath || config.DB_PATH;
  const resolvedSqlitePath = path.resolve(sqlitePath);

  console.log("==================================================");
  console.log("  NEX-GAS — SQLite to Turso Data Import Utility");
  console.log("==================================================");
  console.log(`Source SQLite: ${resolvedSqlitePath} (READ-ONLY)`);

  if (!fs.existsSync(resolvedSqlitePath)) {
    console.error(`\n[FATAL ERROR] Source SQLite database file not found at: ${resolvedSqlitePath}`);
    process.exit(1);
  }

  let sqliteDb: Database | null = null;
  let tursoClient: Client | null = null;

  try {
    // Open SQLite strictly in readonly mode
    sqliteDb = new DatabaseConstructor(resolvedSqlitePath, {
      readonly: true,
      fileMustExist: true,
    });

    tursoClient = createTursoClient({
      url: cliUrl,
      authToken: cliToken,
    });

    console.log("Connecting to Turso and executing migration check...");
    const summary = await importSqliteToTurso(sqliteDb, tursoClient);

    console.log("\n================================================================================");
    console.log("  IMPORT & COUNT VERIFICATION SUMMARY");
    console.log("================================================================================");
    console.log(
      `${"Table Name".padEnd(23)} | ${"SQLite Rows".padEnd(12)} | ${"Imported".padEnd(10)} | ${"Target Total".padEnd(14)} | Status`,
    );
    console.log("-".repeat(80));

    let allVerified = true;
    for (const [table, res] of Object.entries(summary)) {
      const statusStr = res.verified ? "VERIFIED OK" : "MISMATCH";
      if (!res.verified) allVerified = false;
      console.log(
        `${table.padEnd(23)} | ${String(res.sourceRows).padEnd(12)} | ${String(res.importedRows).padEnd(10)} | ${String(res.targetCountAfter).padEnd(14)} | ${statusStr}`,
      );
    }
    console.log("================================================================================");
    if (allVerified) {
      console.log("[SUCCESS] All tables safely imported and 100% verified against Turso Cloud.");
    } else {
      console.warn("[WARNING] One or more tables had row count discrepancies.");
    }

    sqliteDb.close();
    closeTursoClient(tursoClient);
    process.exit(allVerified ? 0 : 1);
  } catch (err) {
    console.error(`\n[FATAL ERROR] Import failed: ${(err as Error).message}`);
    if (sqliteDb) sqliteDb.close();
    if (tursoClient) closeTursoClient(tursoClient);
    process.exit(1);
  }
}
