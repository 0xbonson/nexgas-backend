import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, Client } from "@libsql/client";
import { Database } from "better-sqlite3";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import {
  validateDatabaseUrl,
  createTursoClient,
  closeTursoClient,
} from "../src/db/turso/client.js";
import { runTursoMigrations } from "../src/db/turso/migrations.js";
import {
  createTursoRepositories,
  TursoDatabaseRepositories,
  TursoMqttDatabaseBridge,
} from "../src/db/turso/index.js";
import { importSqliteToTurso } from "../src/cli/turso-import-sqlite.ts";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { NormalizedTelemetry, NormalizedDeviceState, NormalizedDeviceStatus, NormalizedDeviceEvent } from "../src/types/index.js";

describe("Turso Cloud libSQL Integration & Migration Suite", () => {
  let client: Client;
  let repos: TursoDatabaseRepositories;

  beforeEach(async () => {
    // Use in-memory libSQL client for rapid isolated testing
    client = createClient({ url: ":memory:" });
    repos = createTursoRepositories(client);
  });

  afterEach(() => {
    closeTursoClient(client);
  });

  // --------------------------------------------------------------------------
  // 1. URL & Protocol Validation Tests
  // --------------------------------------------------------------------------
  describe("Client & Protocol Validation", () => {
    it("validates supported and unsupported database protocols", () => {
      expect(validateDatabaseUrl(":memory:")).toBe(true);
      expect(validateDatabaseUrl("file:./data/nexgas.sqlite")).toBe(true);
      expect(validateDatabaseUrl("libsql://nexgas-demo.turso.io")).toBe(true);
      expect(validateDatabaseUrl("https://nexgas-demo.turso.io")).toBe(true);
      expect(validateDatabaseUrl("wss://nexgas-demo.turso.io")).toBe(true);

      // Unsupported
      expect(validateDatabaseUrl("")).toBe(false);
      expect(validateDatabaseUrl("postgres://localhost:5432")).toBe(false);
      expect(validateDatabaseUrl("ftp://files.nexgas.io")).toBe(false);
    });

    it("throws clear error when creating client with invalid URL", () => {
      expect(() => {
        createTursoClient({ url: "ftp://invalid-url" });
      }).toThrow(/Invalid Turso database URL/);
    });

    it("successfully creates a memory libSQL client", () => {
      const memClient = createTursoClient({ url: ":memory:" });
      expect(memClient).toBeDefined();
      closeTursoClient(memClient);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Migration Runner Tests
  // --------------------------------------------------------------------------
  describe("Turso Schema Migrations", () => {
    it("runs migration 1 and 2 sequentially on a fresh database", async () => {
      const res = await runTursoMigrations(client);
      expect(res.applied).toBe(2);
      expect(res.currentVersion).toBe(2);

      // Verify all tables were created
      const tablesRes = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      );
      const tableNames = tablesRes.rows.map((r) => String(r.name));

      expect(tableNames).toContain("schema_migrations");
      expect(tableNames).toContain("telemetry_history");
      expect(tableNames).toContain("device_current_state");
      expect(tableNames).toContain("state_history");
      expect(tableNames).toContain("device_current_status");
      expect(tableNames).toContain("status_history");
      expect(tableNames).toContain("event_history");
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("refresh_sessions");
      expect(tableNames).toContain("audit_logs");
    });

    it("is strictly idempotent: second run applies 0 migrations", async () => {
      await runTursoMigrations(client);
      const secondRun = await runTursoMigrations(client);
      expect(secondRun.applied).toBe(0);
      expect(secondRun.currentVersion).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Telemetry Turso Repository Tests
  // --------------------------------------------------------------------------
  describe("TelemetryTursoRepository", () => {
    beforeEach(async () => {
      await runTursoMigrations(client);
    });

    const mockTelemetry: NormalizedTelemetry = {
      deviceId: "nexgas-001",
      isSynthetic: false,
      dataSource: "REAL_HARDWARE",
      receivedAt: "2026-10-31T10:00:00.000Z",
      deviceTimestamp: "2026-10-31T10:00:00.000Z",
      rawTimestamp: 1761904800,
      uptimeMs: 120000,
      h2sBefore: 5.2,
      h2sAfter: 0.8,
      ch4Estimate: 62.5,
      leakPpm: 12.0,
      pressureDigesterKpa: 102.3,
      pressureCollectorKpa: 101.9,
      temperatureC: 28.5,
      humidityPct: 65.0,
      gasLineTemperatureC: 27.8,
      gasLineHumidityPct: 60.5,
      ph: 7.2,
      flowEstimateLpm: 1.5,
      gasSinceStartTotalL: 145.0,
      sensorsReady: true,
      rssi: -65,
      raw: {
        ts: 1761904800,
        uptimeMs: 120000,
        h2sBefore: 5.2,
        h2sAfter: 0.8,
        ch4: 62.5,
        leak: 12.0,
        pressureDigester: 102.3,
        pressureCollector: 101.9,
        temperature: 28.5,
        humidity: 65.0,
        gasLineTemperature: 27.8,
        gasLineHumidity: 60.5,
        ph: 7.2,
        flow: 1.5,
        gasSinceStartL: 145.0,
        sensorsReady: true,
        rssi: -65,
      },
    };

    it("inserts telemetry and retrieves latest matching record", async () => {
      const insertRes = await repos.telemetry.insert(mockTelemetry);
      expect(insertRes.inserted).toBe(true);
      expect(insertRes.id).toBeGreaterThan(0);

      const latest = await repos.telemetry.getLatest("nexgas-001");
      expect(latest).not.toBeNull();
      expect(latest?.deviceId).toBe("nexgas-001");
      expect(latest?.ch4Estimate).toBe(62.5);
      expect(latest?.rawTimestamp).toBe(1761904800);
      expect(latest?.sensorsReady).toBe(true);
      expect(latest?.isSynthetic).toBe(false);
      expect(latest?.dataSource).toBe("REAL_HARDWARE");
    });

    it("detects duplicate replay messages with identical rawTimestamp and uptimeMs", async () => {
      const first = await repos.telemetry.insert(mockTelemetry);
      expect(first.inserted).toBe(true);

      const duplicate = await repos.telemetry.insert(mockTelemetry);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.id).toBe(first.id);

      const total = await repos.telemetry.count();
      expect(total).toBe(1);
    });

    it("queries history with pagination and date range", async () => {
      await repos.telemetry.insert(mockTelemetry);
      await repos.telemetry.insert({
        ...mockTelemetry,
        rawTimestamp: 1761904810,
        uptimeMs: 130000,
        receivedAt: "2026-10-31T10:00:10.000Z",
        ch4Estimate: 63.1,
      });

      const history = await repos.telemetry.getHistory({
        deviceId: "nexgas-001",
        limit: 10,
      });

      expect(history.total).toBe(2);
      expect(history.items.length).toBe(2);
      expect(history.items[0].ch4Estimate).toBe(63.1); // default order is DESC
    });
  });

  // --------------------------------------------------------------------------
  // 4. State & Status Turso Repository Tests
  // --------------------------------------------------------------------------
  describe("State & Status Turso Repositories", () => {
    beforeEach(async () => {
      await runTursoMigrations(client);
    });

    it("saves state atomically to current state and state history", async () => {
      const state1: NormalizedDeviceState = {
        deviceId: "nexgas-001",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        valveOpen: true,
        valveMode: "manual",
        filterWarning: false,
        leakWarning: false,
        filterHealth: 98,
        pressureCalibrated: true,
        phCalibrated: true,
        sensorsReady: true,
        buffered: 0,
        uptimeMs: 50000,
        firmware: "1.0.4",
        receivedAt: "2026-10-31T10:00:00.000Z",
      };

      await repos.state.save(state1);

      const current = await repos.state.getCurrent("nexgas-001");
      expect(current?.valveOpen).toBe(true);
      expect(current?.valveMode).toBe("manual");
      expect(current?.filterHealth).toBe(98);

      // Update state
      const state2: NormalizedDeviceState = {
        ...state1,
        valveOpen: false,
        valveMode: "auto",
        filterHealth: 95,
        uptimeMs: 60000,
        receivedAt: "2026-10-31T10:01:00.000Z",
      };
      await repos.state.save(state2);

      const updatedCurrent = await repos.state.getCurrent("nexgas-001");
      expect(updatedCurrent?.valveOpen).toBe(false);
      expect(updatedCurrent?.valveMode).toBe("auto");

      const history = await repos.state.getHistory({ deviceId: "nexgas-001" });
      expect(history.total).toBe(2);
      expect(history.items.length).toBe(2);
    });

    it("saves status atomically to current status and status history", async () => {
      const statusOnline: NormalizedDeviceStatus = {
        deviceId: "nexgas-001",
        status: "online",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T10:00:00.000Z",
      };

      await repos.status.save(statusOnline);

      const current = await repos.status.getCurrent("nexgas-001");
      expect(current?.status).toBe("online");

      const statusOffline: NormalizedDeviceStatus = {
        deviceId: "nexgas-001",
        status: "offline",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T10:05:00.000Z",
      };
      await repos.status.save(statusOffline);

      const updatedCurrent = await repos.status.getCurrent("nexgas-001");
      expect(updatedCurrent?.status).toBe("offline");

      const history = await repos.status.getHistory({ deviceId: "nexgas-001" });
      expect(history.total).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 5. User, Session, and Audit Turso Repository Tests
  // --------------------------------------------------------------------------
  describe("User, Session & Audit Turso Repositories", () => {
    beforeEach(async () => {
      await runTursoMigrations(client);
    });

    it("creates user, updates password, and lists users", async () => {
      const user = await repos.user.createUser({
        username: "operator_test",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$fakeHashValue",
        role: "operator",
        isActive: true,
      });

      expect(user.id).toBeGreaterThan(0);
      expect(user.username).toBe("operator_test");
      expect(user.role).toBe("operator");

      const found = await repos.user.findById(user.id);
      expect(found?.username).toBe("operator_test");

      const withPw = await repos.user.findByUsername("operator_test");
      expect(withPw?.passwordHash).toBe("$argon2id$v=19$m=65536,t=3,p=4$fakeHashValue");

      await repos.user.updatePassword(user.id, "$argon2id$newPasswordHash");
      const updatedPw = await repos.user.findByUsername("operator_test");
      expect(updatedPw?.passwordHash).toBe("$argon2id$newPasswordHash");

      const list = await repos.user.listUsers();
      expect(list.total).toBe(1);
      expect(list.items[0].username).toBe("operator_test");
    });

    it("handles refresh sessions creation, revocation, and expiration", async () => {
      const user = await repos.user.createUser({
        username: "admin_test",
        passwordHash: "hash123",
        role: "admin",
      });

      const session = await repos.refreshSession.createSession({
        userId: user.id,
        tokenHash: "token_hash_alpha",
        familyId: "family_alpha",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      expect(session.id).toBeGreaterThan(0);

      const found = await repos.refreshSession.findByTokenHash("token_hash_alpha");
      expect(found).not.toBeNull();
      expect(found?.revokedAt).toBeNull();

      // Revoke family
      await repos.refreshSession.revokeFamily("family_alpha");
      const revoked = await repos.refreshSession.findByTokenHash("token_hash_alpha");
      expect(revoked?.revokedAt).not.toBeNull();
    });

    it("inserts and retrieves audit logs", async () => {
      const user = await repos.user.createUser({
        username: "audit_admin",
        passwordHash: "hash123",
        role: "admin",
      });

      const audit = await repos.audit.insert({
        userId: user.id,
        username: "audit_admin",
        ipAddress: "127.0.0.1",
        action: "auth:login",
        resource: "user",
        details: { method: "password" },
        status: "success",
      });

      expect(audit.id).toBeGreaterThan(0);
      expect(audit.action).toBe("auth:login");

      const logs = await repos.audit.getLogs();
      expect(logs.total).toBe(1);
      expect(logs.items[0].action).toBe("auth:login");
    });
  });

  // --------------------------------------------------------------------------
  // 6. SQLite to Turso Data Import Verification
  // --------------------------------------------------------------------------
  describe("importSqliteToTurso End-to-End Migration", () => {
    let sqliteDb: Database;

    beforeEach(() => {
      sqliteDb = createDatabase({ inMemory: true });
      runMigrations(sqliteDb);
    });

    afterEach(() => {
      closeDatabase(sqliteDb);
    });

    it("safely and idempotently imports all tables from SQLite to Turso", async () => {
      // 1. Seed SQLite with real test records
      sqliteDb.exec(`
        INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
        VALUES (1, 'imported_admin', 'hash_admin', 'admin', 1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z'),
               (2, 'imported_viewer', 'hash_viewer', 'viewer', 1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z');

        INSERT INTO refresh_sessions (id, user_id, token_hash, family_id, expires_at, created_at)
        VALUES (1, 1, 'token_1', 'fam_1', '2030-01-01T00:00:00Z', '2026-10-31T00:00:00Z');

        INSERT INTO audit_logs (id, user_id, username, ip_address, action, status, created_at)
        VALUES (1, 1, 'imported_admin', '127.0.0.1', 'auth:login', 'success', '2026-10-31T00:00:00Z');

        INSERT INTO device_current_state (device_id, valve_open, valve_mode, filter_warning, leak_warning,
          filter_health, pressure_calibrated, ph_calibrated, sensors_ready, buffered, uptime_ms, firmware, updated_at)
        VALUES ('nexgas-001', 1, 'auto', 0, 0, 99, 1, 1, 1, 0, 45000, '1.0.4', '2026-10-31T00:00:00Z');

        INSERT INTO state_history (id, device_id, valve_open, valve_mode, filter_warning, leak_warning,
          filter_health, pressure_calibrated, ph_calibrated, sensors_ready, buffered, uptime_ms, firmware, received_at)
        VALUES (1, 'nexgas-001', 1, 'auto', 0, 0, 99, 1, 1, 1, 0, 45000, '1.0.4', '2026-10-31T00:00:00Z');

        INSERT INTO device_current_status (device_id, status, updated_at)
        VALUES ('nexgas-001', 'online', '2026-10-31T00:00:00Z');

        INSERT INTO status_history (id, device_id, status, received_at)
        VALUES (1, 'nexgas-001', 'online', '2026-10-31T00:00:00Z');

        INSERT INTO event_history (id, device_id, raw_timestamp, received_at, uptime_ms, event_type, severity, message)
        VALUES (1, 'nexgas-001', 1761900000, '2026-10-31T00:00:00Z', 45000, 'SYSTEM_START', 'INFO', 'Device booted');

        INSERT INTO telemetry_history (id, device_id, raw_timestamp, received_at, uptime_ms, ch4_estimate, sensors_ready, rssi)
        VALUES (1, 'nexgas-001', 1761900000, '2026-10-31T00:00:00Z', 45000, 61.2, 1, -68),
               (2, 'nexgas-001', 1761900010, '2026-10-31T00:00:10Z', 55000, 61.8, 1, -67);
      `);

      // 2. Run import to Turso
      const summary = await importSqliteToTurso(sqliteDb, client);

      expect(summary.users.read).toBe(2);
      expect(summary.users.inserted).toBe(2);
      expect(summary.refresh_sessions.read).toBe(1);
      expect(summary.audit_logs.read).toBe(1);
      expect(summary.device_current_state.read).toBe(1);
      expect(summary.state_history.read).toBe(1);
      expect(summary.device_current_status.read).toBe(1);
      expect(summary.status_history.read).toBe(1);
      expect(summary.event_history.read).toBe(1);
      expect(summary.telemetry_history.read).toBe(2);

      // 3. Verify content in Turso
      const userRes = await repos.user.findByUsername("imported_admin");
      expect(userRes).not.toBeNull();
      expect(userRes?.role).toBe("admin");

      const telemetryLatest = await repos.telemetry.getLatest("nexgas-001");
      expect(telemetryLatest).not.toBeNull();
      expect(telemetryLatest?.ch4Estimate).toBe(61.8);

      const statusRes = await repos.status.getCurrent("nexgas-001");
      expect(statusRes?.status).toBe("online");

      // 4. Idempotency check: run import again without duplicate key errors
      const secondSummary = await importSqliteToTurso(sqliteDb, client);
      expect(secondSummary.users.read).toBe(2);

      const userCount = await repos.user.count();
      expect(userCount).toBe(2); // Still exactly 2 users
    });
  });

  // --------------------------------------------------------------------------
  // 7. Turso MQTT Bridge Tests
  // --------------------------------------------------------------------------
  describe("TursoMqttDatabaseBridge", () => {
    it("attaches to MQTT service and asynchronously persists telemetry messages", async () => {
      await runTursoMigrations(client);

      const mqtt = new NexGasMqttService();
      const bridge = new TursoMqttDatabaseBridge(mqtt, repos);
      bridge.attach();

      const telemetryPayload: NormalizedTelemetry = {
        deviceId: "nexgas-001",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T12:00:00.000Z",
        rawTimestamp: 1761912000,
        uptimeMs: 300000,
        ch4Estimate: 65.0,
        sensorsReady: true,
        rssi: -60,
      };

      // Emit telemetry from MQTT service
      mqtt.emit("telemetry", telemetryPayload);

      // Allow microtask queue to process async write
      await new Promise((resolve) => setTimeout(resolve, 50));

      const saved = await repos.telemetry.getLatest("nexgas-001");
      expect(saved).not.toBeNull();
      expect(saved?.ch4Estimate).toBe(65.0);

      bridge.detach();
    });
  });
});
