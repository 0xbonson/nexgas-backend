import DatabaseConstructor, { Database } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export interface DatabaseOptions {
  path?: string;
  inMemory?: boolean;
  verbose?: boolean;
}

let activeDatabase: Database | null = null;

/**
 * Initializes and configures a SQLite connection with WAL mode and foreign keys.
 */
export function createDatabase(options: DatabaseOptions = {}): Database {
  const dbPath = options.inMemory
    ? ":memory:"
    : options.path || config.DB_PATH;

  if (dbPath !== ":memory:") {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  logger.info(`Opening SQLite database at "${dbPath}"...`);

  const db = new DatabaseConstructor(dbPath, {
    verbose: options.verbose
      ? (msg: unknown) => logger.debug(String(msg))
      : undefined,
  });

  // Performance and integrity pragma settings
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  return db;
}

/**
 * Gets or initializes the default application database singleton.
 */
export function getDatabase(): Database {
  if (!activeDatabase) {
    activeDatabase = createDatabase();
  }
  return activeDatabase;
}

/**
 * Sets an explicit database instance (e.g. for testing with an in-memory database).
 */
export function setDatabase(db: Database | null): void {
  activeDatabase = db;
}

/**
 * Gracefully flushes WAL journal and closes the database connection.
 */
export function closeDatabase(db: Database | null = activeDatabase): void {
  if (!db) return;

  try {
    if (db.open) {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // In-memory or locked databases might skip checkpoint
      }
      db.close();
      logger.info("SQLite database connection closed cleanly");
    }
  } catch (err) {
    logger.error("Error closing SQLite database", { error: (err as Error).message });
  } finally {
    if (db === activeDatabase) {
      activeDatabase = null;
    }
  }
}
