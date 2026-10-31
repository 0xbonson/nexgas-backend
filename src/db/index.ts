import { Database } from "better-sqlite3";
import { Client } from "@libsql/client";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { NexGasMqttService, mqttService } from "../mqtt/client.js";
import {
  DatabaseRepositories,
  IMqttDatabaseBridge,
  ITelemetryRepository,
  IStateRepository,
  IStatusRepository,
  IEventRepository,
  IUserRepository,
  IRefreshSessionRepository,
  IAuditRepository,
} from "./interfaces.js";
import { getDatabase, closeDatabase } from "./database.js";
import { runMigrations } from "./migrations/index.js";
import {
  TelemetryRepository,
} from "./repositories/telemetry.repository.js";
import { StateRepository } from "./repositories/state.repository.js";
import { StatusRepository } from "./repositories/status.repository.js";
import { EventRepository } from "./repositories/event.repository.js";
import { UserRepository } from "./repositories/user.repository.js";
import { RefreshSessionRepository } from "./repositories/refresh-session.repository.js";
import { AuditRepository } from "./repositories/audit.repository.js";
import { MqttDatabaseBridge } from "./bridge.js";
import { createSqliteAsyncRepositories } from "./adapters/sqlite-async-repositories.js";

// Turso imports
import {
  createTursoClient,
  closeTursoClient,
  runTursoMigrations,
  createTursoRepositories,
  TursoMqttDatabaseBridge,
} from "./turso/index.js";

export * from "./interfaces.js";
export * from "./database.js";
export * from "./migrations/index.js";
export * from "./repositories/telemetry.repository.js";
export * from "./repositories/state.repository.js";
export * from "./repositories/status.repository.js";
export * from "./repositories/event.repository.js";
export * from "./repositories/user.repository.js";
export * from "./repositories/refresh-session.repository.js";
export * from "./repositories/audit.repository.js";
export * from "./bridge.js";
export * from "./adapters/sqlite-async-repositories.js";
export * from "./turso/index.js";

export type DatabaseDriverType = "sqlite" | "turso";

export interface UnifiedDatabaseLayerResult {
  driver: DatabaseDriverType;
  sqliteDb?: Database;
  tursoClient?: Client;
  repositories: DatabaseRepositories;
  bridge: IMqttDatabaseBridge;
}

export interface InitializeDatabaseOptions {
  sqliteDb?: Database;
  tursoClient?: Client;
}

let activeDriver: DatabaseDriverType | null = null;
let activeRepositories: DatabaseRepositories | null = null;
let activeBridge: IMqttDatabaseBridge | null = null;
let activeTursoClientInstance: Client | null = null;

/**
 * Initializes the unified asynchronous database layer based on DATABASE_DRIVER.
 *
 * If driver is 'turso':
 * - Validates TURSO_DATABASE_URL presence (fails fast, NEVER silently falls back to SQLite).
 * - Connects to Turso libSQL client.
 * - Applies Turso schema migrations.
 * - Instantiates asynchronous Turso repositories and Turso MQTT persistence bridge.
 *
 * If driver is 'sqlite':
 * - Opens SQLite database.
 * - Applies SQLite schema migrations.
 * - Instantiates SQLite repositories (wrapped in async adapter) and SQLite MQTT bridge.
 */
export async function initializeDatabase(
  driver: DatabaseDriverType = config.DATABASE_DRIVER,
  service: NexGasMqttService = mqttService,
  options: InitializeDatabaseOptions = {},
): Promise<UnifiedDatabaseLayerResult> {
  // Gracefully close any previously active connection if re-initializing
  if (activeBridge) {
    activeBridge.detach();
    activeBridge = null;
  }

  logger.info(`Initializing NEX-GAS database runtime with driver: "${driver}"...`);

  if (driver === "turso") {
    const url = options.tursoClient ? ":memory:" : config.TURSO_DATABASE_URL;

    // Fail-fast guard: NO SILENT FALLBACK to SQLite
    if (!url && !options.tursoClient) {
      const errMsg =
        "FATAL: DATABASE_DRIVER is set to 'turso' but TURSO_DATABASE_URL is not configured in environment. Backend will not start.";
      logger.error(errMsg);
      throw new Error(errMsg);
    }

    try {
      const client = options.tursoClient || createTursoClient();
      activeTursoClientInstance = client;

      // Apply schema migrations
      await runTursoMigrations(client);

      // Create unified repositories
      activeRepositories = createTursoRepositories(client);

      // Attach Turso MQTT bridge (with retry queue)
      const tursoBridge = new TursoMqttDatabaseBridge(service, activeRepositories);
      tursoBridge.attach();
      activeBridge = tursoBridge;
      activeDriver = "turso";

      logger.info("Turso Cloud libSQL database runtime initialized successfully");

      return {
        driver: "turso",
        tursoClient: client,
        repositories: activeRepositories,
        bridge: activeBridge,
      };
    } catch (err) {
      const errMsg = `FATAL: Failed to initialize Turso database: ${(err as Error).message}`;
      logger.error(errMsg);
      throw new Error(errMsg);
    }
  } else {
    // SQLite driver
    const db = options.sqliteDb || getDatabase();
    runMigrations(db);

    // Create unified async repositories
    activeRepositories = createSqliteAsyncRepositories(db);

    // Synchronous repositories for SQLite bridge
    const syncRepos = {
      telemetry: new TelemetryRepository(db),
      state: new StateRepository(db),
      status: new StatusRepository(db),
      event: new EventRepository(db),
      user: new UserRepository(db),
      refreshSession: new RefreshSessionRepository(db),
      audit: new AuditRepository(db),
    };

    const sqliteBridge = new MqttDatabaseBridge(service, syncRepos);
    sqliteBridge.attach();
    activeBridge = sqliteBridge;
    activeDriver = "sqlite";

    logger.info("SQLite local database runtime initialized successfully");

    return {
      driver: "sqlite",
      sqliteDb: db,
      repositories: activeRepositories,
      bridge: activeBridge,
    };
  }
}

/**
 * Backward-compatible synchronous initializer for existing tests.
 * Defaults to initializing SQLite.
 */
export function initializeDatabaseLayer(
  service: NexGasMqttService = mqttService,
): { db: Database; repositories: DatabaseRepositories; bridge: IMqttDatabaseBridge } {
  const db = getDatabase();
  runMigrations(db);

  activeRepositories = createSqliteAsyncRepositories(db);

  const syncRepos = {
    telemetry: new TelemetryRepository(db),
    state: new StateRepository(db),
    status: new StatusRepository(db),
    event: new EventRepository(db),
    user: new UserRepository(db),
    refreshSession: new RefreshSessionRepository(db),
    audit: new AuditRepository(db),
  };

  const bridge = new MqttDatabaseBridge(service, syncRepos);
  bridge.attach();
  activeBridge = bridge;
  activeDriver = "sqlite";

  return {
    db,
    repositories: activeRepositories,
    bridge,
  };
}

/**
 * Returns the currently active unified repository layer.
 * If not yet initialized, lazily initializes according to DATABASE_DRIVER.
 */
export function getRepositories(): DatabaseRepositories {
  if (!activeRepositories) {
    if (config.DATABASE_DRIVER === "turso") {
      throw new Error(
        "Turso database layer must be initialized asynchronously using await initializeDatabase('turso') before calling getRepositories().",
      );
    }
    initializeDatabaseLayer();
  }
  return activeRepositories!;
}

/**
 * Explicitly sets the active repositories instance (e.g. for testing with mocks).
 */
export function setRepositories(repos: DatabaseRepositories | null): void {
  activeRepositories = repos;
}

/**
 * Returns currently active database driver ("sqlite" | "turso" | null).
 */
export function getActiveDriver(): DatabaseDriverType | null {
  return activeDriver;
}

/**
 * Gracefully detaches bridges and closes database connections.
 */
export async function closeDatabaseLayer(): Promise<void> {
  if (activeBridge) {
    activeBridge.detach();
    activeBridge = null;
  }

  if (activeDriver === "turso") {
    if (activeTursoClientInstance) {
      closeTursoClient(activeTursoClientInstance);
      activeTursoClientInstance = null;
    }
  } else if (activeDriver === "sqlite") {
    closeDatabase();
  }

  activeDriver = null;
  activeRepositories = null;
  logger.info("NEX-GAS database layer closed cleanly");
}
