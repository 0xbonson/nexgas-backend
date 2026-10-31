import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, Client } from "@libsql/client";
import { Database } from "better-sqlite3";
import {
  initializeDatabase,
  closeDatabaseLayer,
  getActiveDriver,
  getRepositories,
  setRepositories,
  createDatabase,
  closeDatabase,
  runMigrations,
  runTursoMigrations,
} from "../src/db/index.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { TursoRetryQueue, TursoMqttDatabaseBridge } from "../src/db/turso/turso-bridge.js";
import { importSqliteToTurso } from "../src/cli/turso-import-sqlite.js";
import { createApp } from "../src/app.js";
import { NexGasWebSocketGateway } from "../src/ws/gateway.js";
import { createServer, Server } from "http";
import { WebSocket } from "ws";
import { signAccessToken } from "../src/utils/jwt.js";
import { NormalizedTelemetry, NormalizedDeviceState, NormalizedDeviceStatus } from "../src/types/index.js";

describe("Unified Async Database Runtime Suite (Phase 2)", () => {
  let mqtt: NexGasMqttService;

  beforeEach(() => {
    mqtt = new NexGasMqttService();
  });

  afterEach(async () => {
    await closeDatabaseLayer();
  });

  // --------------------------------------------------------------------------
  // 1. Driver Switching & Fail-Fast Verification
  // --------------------------------------------------------------------------
  describe("Driver Switching & Fail-Fast Behavior", () => {
    it("successfully initializes SQLite driver and sets active driver to 'sqlite'", async () => {
      const memSqlite = createDatabase({ inMemory: true });
      const layer = await initializeDatabase("sqlite", mqtt, { sqliteDb: memSqlite });

      expect(layer.driver).toBe("sqlite");
      expect(getActiveDriver()).toBe("sqlite");
      expect(layer.repositories).toBeDefined();

      const repos = getRepositories();
      expect(repos).toBe(layer.repositories);
    });

    it("STRICT FAIL-FAST: throws fatal error and NEVER silently falls back to SQLite if Turso URL is missing", async () => {
      // Ensure no tursoClient is passed and URL is empty
      const originalEnv = process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_DATABASE_URL;

      await expect(initializeDatabase("turso", mqtt)).rejects.toThrow(
        /FATAL: DATABASE_DRIVER is set to 'turso' but TURSO_DATABASE_URL is not configured/,
      );

      // Verify no silent fallback occurred
      expect(getActiveDriver()).toBeNull();

      if (originalEnv) process.env.TURSO_DATABASE_URL = originalEnv;
    });

    it("successfully initializes Turso driver with libSQL client and sets active driver to 'turso'", async () => {
      const memTurso = createClient({ url: ":memory:" });
      const layer = await initializeDatabase("turso", mqtt, { tursoClient: memTurso });

      expect(layer.driver).toBe("turso");
      expect(getActiveDriver()).toBe("turso");
      expect(layer.repositories).toBeDefined();

      const repos = getRepositories();
      expect(repos).toBe(layer.repositories);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Turso In-Memory Retry Queue Tests
  // --------------------------------------------------------------------------
  describe("Turso In-Memory Retry Queue & Failure Resilience", () => {
    it("buffers failed items and successfully retries when database recovers", async () => {
      const memTurso = createClient({ url: ":memory:" });
      await runTursoMigrations(memTurso);
      const layer = await initializeDatabase("turso", mqtt, { tursoClient: memTurso });

      const retryQueue = new TursoRetryQueue(layer.repositories, {
        baseDelayMs: 10,
        maxRetries: 3,
        flushIntervalMs: 50,
      });

      const sampleTelemetry: NormalizedTelemetry = {
        deviceId: "nexgas-001",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T15:00:00.000Z",
        rawTimestamp: 1761922800,
        uptimeMs: 100000,
        ch4Estimate: 62.8,
        sensorsReady: true,
        rssi: -65,
      };

      // Enqueue failed telemetry
      retryQueue.enqueue("telemetry", sampleTelemetry);
      expect(retryQueue.getStats().queued).toBe(1);

      // Wait for backoff delay
      await new Promise((r) => setTimeout(r, 20));

      // Drain queue
      const processed = await retryQueue.drain();
      expect(processed).toBe(1);
      expect(retryQueue.getStats().queued).toBe(0);
      expect(retryQueue.getStats().totalRetried).toBe(1);

      // Verify item actually made it into Turso
      const saved = await layer.repositories.telemetry.getLatest("nexgas-001");
      expect(saved).not.toBeNull();
      expect(saved?.ch4Estimate).toBe(62.8);

      retryQueue.stop();
    });

    it("enforces maxCapacity and evicts oldest items on buffer overflow", () => {
      const memTurso = createClient({ url: ":memory:" });
      const layer = {
        repositories: {} as any,
      };

      const boundedQueue = new TursoRetryQueue(layer.repositories, {
        maxCapacity: 3,
        baseDelayMs: 1000,
      });

      boundedQueue.enqueue("telemetry", { id: 1 });
      boundedQueue.enqueue("telemetry", { id: 2 });
      boundedQueue.enqueue("telemetry", { id: 3 });
      expect(boundedQueue.getStats().queued).toBe(3);

      // Enqueue 4th item -> oldest (id: 1) is evicted
      boundedQueue.enqueue("telemetry", { id: 4 });
      expect(boundedQueue.getStats().queued).toBe(3);
      expect(boundedQueue.getStats().totalEnqueued).toBe(4);

      boundedQueue.stop();
    });
  });

  // --------------------------------------------------------------------------
  // 3. REST Routes & Authentication over Turso Runtime
  // --------------------------------------------------------------------------
  describe("REST API & Auth over Turso Driver", () => {
    let app: ReturnType<typeof createApp>;
    let server: Server;
    let baseUrl: string;
    let adminToken: string;
    let memTurso: Client;

    beforeEach(async () => {
      memTurso = createClient({ url: ":memory:" });
      await runTursoMigrations(memTurso);
      const layer = await initializeDatabase("turso", mqtt, { tursoClient: memTurso });

      // Seed admin user in Turso
      const user = await layer.repositories.user.createUser({
        username: "turso_admin",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$fakeHash",
        role: "admin",
        isActive: true,
      });

      adminToken = await signAccessToken({
        sub: String(user.id),
        username: user.username,
        role: "admin",
      });

      // Seed telemetry in Turso
      await layer.repositories.telemetry.insert({
        deviceId: "nexgas-001",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T15:30:00.000Z",
        rawTimestamp: 1761924600,
        uptimeMs: 120000,
        ch4Estimate: 64.2,
        sensorsReady: true,
        rssi: -60,
      });

      app = createApp(mqtt);
      server = createServer(app);

      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("fetches latest telemetry from Turso database via REST API", async () => {
      const res = await fetch(`${baseUrl}/api/telemetry/latest?deviceId=nexgas-001`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deviceId).toBe("nexgas-001");
      expect(data.data.ch4Estimate).toBe(64.2);
      expect(data.dataSource).toBe("REAL_HARDWARE");
    });

    it("authenticates access token against Turso user repository", async () => {
      const res = await fetch(`${baseUrl}/api/telemetry/latest`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);

      // Invalid token
      const resBad = await fetch(`${baseUrl}/api/telemetry/latest`, {
        headers: { Authorization: "Bearer bad.token.here" },
      });
      expect(resBad.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // 4. WebSocket Initial Snapshot over Turso Runtime
  // --------------------------------------------------------------------------
  describe("WebSocket Gateway over Turso Driver", () => {
    let server: Server;
    let wsGateway: NexGasWebSocketGateway;
    let wsUrl: string;

    beforeEach(async () => {
      const memTurso = createClient({ url: ":memory:" });
      await runTursoMigrations(memTurso);
      const layer = await initializeDatabase("turso", mqtt, { tursoClient: memTurso });

      // Save status in Turso
      await layer.repositories.status.save({
        deviceId: "nexgas-001",
        status: "online",
        isSynthetic: false,
        dataSource: "REAL_HARDWARE",
        receivedAt: "2026-10-31T16:00:00.000Z",
      });

      server = createServer();
      wsGateway = new NexGasWebSocketGateway(mqtt);

      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const addr = server.address() as { port: number };
          wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
          wsGateway.attach(server, "/ws");
          resolve();
        });
      });
    });

    afterEach(async () => {
      await wsGateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("pushes initial device status snapshot from Turso upon WebSocket connection", async () => {
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "status") {
            expect(msg.deviceId).toBe("nexgas-001");
            expect(msg.data.status).toBe("online");
            expect(msg.dataSource).toBe("REAL_HARDWARE");
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
      });
    });
  });

  // --------------------------------------------------------------------------
  // 5. Enhanced SQLite Import Guards
  // --------------------------------------------------------------------------
  describe("Enhanced SQLite Import Verification & Timestamp Guard", () => {
    let sqliteDb: Database;
    let tursoClient: Client;

    beforeEach(async () => {
      sqliteDb = createDatabase({ inMemory: true });
      runMigrations(sqliteDb);

      tursoClient = createClient({ url: ":memory:" });
      await runTursoMigrations(tursoClient);
    });

    afterEach(() => {
      closeDatabase(sqliteDb);
      tursoClient.close();
    });

    it("verifies row counts match after import and respects verification status", async () => {
      sqliteDb.exec(`
        INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
        VALUES (1, 'u1', 'p1', 'admin', 1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z'),
               (2, 'u2', 'p2', 'operator', 1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z');
      `);

      const summary = await importSqliteToTurso(sqliteDb, tursoClient);

      expect(summary.users.sourceRows).toBe(2);
      expect(summary.users.targetCountAfter).toBe(2);
      expect(summary.users.verified).toBe(true);
    });

    it("filters out expired and revoked refresh sessions during import", async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      sqliteDb.exec(`
        INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
        VALUES (1, 'user_sessions', 'p', 'viewer', 1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z');

        -- Expired session
        INSERT INTO refresh_sessions (id, user_id, token_hash, family_id, expires_at, created_at)
        VALUES (1, 1, 'hash_expired', 'fam1', '${pastDate}', '2026-10-30T00:00:00Z');

        -- Revoked session
        INSERT INTO refresh_sessions (id, user_id, token_hash, family_id, expires_at, created_at, revoked_at)
        VALUES (2, 1, 'hash_revoked', 'fam2', '${futureDate}', '2026-10-30T00:00:00Z', '2026-10-30T12:00:00Z');

        -- Valid active session
        INSERT INTO refresh_sessions (id, user_id, token_hash, family_id, expires_at, created_at)
        VALUES (3, 1, 'hash_valid', 'fam3', '${futureDate}', '2026-10-30T00:00:00Z');
      `);

      const summary = await importSqliteToTurso(sqliteDb, tursoClient, { skipExpiredSessions: true });

      // Out of 3 sessions, only 1 valid active session should be imported!
      expect(summary.refresh_sessions.sourceRows).toBe(1);
      expect(summary.refresh_sessions.targetCountAfter).toBe(1);

      const targetRow = await tursoClient.execute("SELECT token_hash FROM refresh_sessions");
      expect(targetRow.rows.length).toBe(1);
      expect(targetRow.rows[0].token_hash).toBe("hash_valid");
    });

    it("protects cloud device_current_state from being overwritten by older SQLite timestamp", async () => {
      // 1. Seed cloud with newer live state
      await tursoClient.execute({
        sql: `INSERT INTO device_current_state (
                device_id, valve_open, valve_mode, filter_warning, leak_warning,
                filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
                buffered, uptime_ms, firmware, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "nexgas-001",
          1, // newer state: valve is open
          "auto",
          0,
          0,
          100,
          1,
          1,
          1,
          0,
          80000,
          "1.0.4",
          "2026-10-31T18:00:00.000Z", // Newer timestamp
        ],
      });

      // 2. Local SQLite has older state
      sqliteDb.exec(`
        INSERT INTO device_current_state (
          device_id, valve_open, valve_mode, filter_warning, leak_warning,
          filter_health, pressure_calibrated, ph_calibrated, sensors_ready,
          buffered, uptime_ms, firmware, updated_at
        ) VALUES (
          'nexgas-001',
          0, -- older state: valve was closed
          'manual',
          0,
          0,
          90,
          1,
          1,
          1,
          0,
          20000,
          '1.0.3',
          '2026-10-31T10:00:00.000Z' -- Older timestamp
        );
      `);

      // 3. Import SQLite to Turso
      await importSqliteToTurso(sqliteDb, tursoClient);

      // 4. Verify cloud state was NOT overwritten!
      const cloudState = await tursoClient.execute({
        sql: "SELECT valve_open, valve_mode, updated_at FROM device_current_state WHERE device_id = 'nexgas-001'",
      });

      expect(cloudState.rows.length).toBe(1);
      expect(Number(cloudState.rows[0].valve_open)).toBe(1); // Still 1 (newer cloud value protected!)
      expect(cloudState.rows[0].valve_mode).toBe("auto");
      expect(cloudState.rows[0].updated_at).toBe("2026-10-31T18:00:00.000Z");
    });
  });
});
