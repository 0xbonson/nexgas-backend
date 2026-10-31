import { createClient, Client, Config as LibsqlConfig } from "@libsql/client";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

export interface TursoClientOptions {
  url?: string;
  authToken?: string;
}

let activeTursoClient: Client | null = null;

/**
 * Validates the database URL to ensure supported protocol.
 * Supported: libsql://, https://, http://, ws://, wss://, file:, :memory:
 */
export function validateDatabaseUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (trimmed === ":memory:") return true;
  if (trimmed.startsWith("file:")) return true;
  return /^(libsql|https?|wss?):\/\//i.test(trimmed);
}

/**
 * Creates and initializes a Turso libSQL client.
 * Supports Turso Cloud (libsql:// or https:// with authToken) and local file/memory modes.
 */
export function createTursoClient(options: TursoClientOptions = {}): Client {
  const url = options.url || config.TURSO_DATABASE_URL || "file:./data/nexgas.sqlite";
  const authToken = options.authToken || config.TURSO_AUTH_TOKEN;

  if (!validateDatabaseUrl(url)) {
    throw new Error(
      `Invalid Turso database URL "${url}". Must start with libsql://, https://, http://, file:, or be ":memory:".`,
    );
  }

  const isRemote = url.startsWith("libsql://") || url.startsWith("https://") || url.startsWith("http://");

  if (isRemote && !authToken) {
    logger.warn(
      "Connecting to remote Turso database without TURSO_AUTH_TOKEN. Requests may be rejected if the database is authenticated.",
    );
  }

  logger.info(`Initializing Turso libSQL client connection...`, {
    target: isRemote ? url.replace(/:\/\/[^@]+@/, "://[USER]:***@") : url,
    isRemote,
    hasAuthToken: Boolean(authToken),
  });

  const clientConfig: LibsqlConfig = {
    url,
    authToken: authToken || undefined,
  };

  return createClient(clientConfig);
}

/**
 * Gets or initializes the singleton Turso client instance.
 */
export function getTursoClient(): Client {
  if (!activeTursoClient) {
    activeTursoClient = createTursoClient();
  }
  return activeTursoClient;
}

/**
 * Sets an explicit Turso client instance (e.g. for testing with an in-memory client).
 */
export function setTursoClient(client: Client | null): void {
  activeTursoClient = client;
}

/**
 * Gracefully closes the active Turso client connection.
 */
export function closeTursoClient(client: Client | null = activeTursoClient): void {
  if (!client) return;

  try {
    client.close();
    logger.info("Turso libSQL client closed cleanly");
  } catch (err) {
    logger.error("Error closing Turso client", { error: (err as Error).message });
  } finally {
    if (client === activeTursoClient) {
      activeTursoClient = null;
    }
  }
}

