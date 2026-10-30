import { Database } from "better-sqlite3";
import { logger } from "../../utils/logger.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const MIGRATION_001_SQL = `
-- 1. Telemetry History: immutable time-series sensor readings
CREATE TABLE IF NOT EXISTS telemetry_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  device_timestamp TEXT,
  raw_timestamp INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  uptime_ms INTEGER NOT NULL,
  h2s_before REAL,
  h2s_after REAL,
  ch4_estimate REAL,
  leak_ppm REAL,
  pressure_digester_kpa REAL,
  pressure_collector_kpa REAL,
  temperature_c REAL,
  humidity_pct REAL,
  gas_line_temperature_c REAL,
  gas_line_humidity_pct REAL,
  ph REAL,
  flow_estimate_lpm REAL,
  gas_since_start_total_l REAL,
  sensors_ready INTEGER NOT NULL,
  rssi INTEGER NOT NULL,
  raw_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_received
  ON telemetry_history (device_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts
  ON telemetry_history (device_id, raw_timestamp, uptime_ms);

CREATE INDEX IF NOT EXISTS idx_telemetry_received_at
  ON telemetry_history (received_at DESC);

-- 2. Device Current State: fast O(1) state lookup
CREATE TABLE IF NOT EXISTS device_current_state (
  device_id TEXT PRIMARY KEY,
  valve_open INTEGER NOT NULL,
  valve_mode TEXT NOT NULL,
  filter_warning INTEGER NOT NULL,
  leak_warning INTEGER NOT NULL,
  filter_health INTEGER NOT NULL,
  pressure_calibrated INTEGER NOT NULL,
  ph_calibrated INTEGER NOT NULL,
  sensors_ready INTEGER NOT NULL,
  buffered INTEGER NOT NULL,
  uptime_ms INTEGER NOT NULL,
  firmware TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Device State Transition History: chronological transitions log
CREATE TABLE IF NOT EXISTS state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  valve_open INTEGER NOT NULL,
  valve_mode TEXT NOT NULL,
  filter_warning INTEGER NOT NULL,
  leak_warning INTEGER NOT NULL,
  filter_health INTEGER NOT NULL,
  pressure_calibrated INTEGER NOT NULL,
  ph_calibrated INTEGER NOT NULL,
  sensors_ready INTEGER NOT NULL,
  buffered INTEGER NOT NULL,
  uptime_ms INTEGER NOT NULL,
  firmware TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_history_device_received
  ON state_history (device_id, received_at DESC);

-- 4. Device Current Status: online/offline status
CREATE TABLE IF NOT EXISTS device_current_status (
  device_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 5. Device Status History: transition history for uptime analysis
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_history_device_received
  ON status_history (device_id, received_at DESC);

-- 6. Event History: hardware and system alerts
CREATE TABLE IF NOT EXISTS event_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  device_timestamp TEXT,
  raw_timestamp INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  uptime_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_device_received
  ON event_history (device_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_severity
  ON event_history (severity, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_type
  ON event_history (event_type, received_at DESC);
`;

export const migrations: Migration[] = [
  {
    version: 1,
    name: "001_initial_schema",
    up: (db: Database) => {
      db.exec(MIGRATION_001_SQL);
    },
  },
];

/**
 * Initializes migrations tracking and applies all pending migrations in order.
 * Safe to call repeatedly; will never re-apply already executed migrations.
 */
export function runMigrations(db: Database): { applied: number } {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as { version: number }[];

  const appliedVersions = new Set(appliedRows.map((r) => r.version));
  let count = 0;

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      logger.info(
        `Applying database migration ${migration.version}: ${migration.name}...`,
      );

      const runInTx = db.transaction(() => {
        migration.up(db);
        insertMigration.run(
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
      });

      runInTx();
      count++;
      logger.info(`Migration ${migration.version} successfully applied`);
    }
  }

  return { applied: count };
}
