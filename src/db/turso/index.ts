import { Client } from "@libsql/client";
import { getTursoClient } from "./client.js";
import { runTursoMigrations } from "./migrations.js";
import { TelemetryTursoRepository } from "./repositories/telemetry.turso.repository.js";
import { StateTursoRepository } from "./repositories/state.turso.repository.js";
import { StatusTursoRepository } from "./repositories/status.turso.repository.js";
import { EventTursoRepository } from "./repositories/event.turso.repository.js";
import { UserTursoRepository } from "./repositories/user.turso.repository.js";
import { RefreshSessionTursoRepository } from "./repositories/refresh-session.turso.repository.js";
import { AuditTursoRepository } from "./repositories/audit.turso.repository.js";
import {
  TursoMqttDatabaseBridge,
  TursoDatabaseRepositories,
} from "./turso-bridge.js";
import { NexGasMqttService, mqttService } from "../../mqtt/client.js";

export * from "./client.js";
export * from "./migrations.js";
export * from "./turso-bridge.js";
export * from "./repositories/telemetry.turso.repository.js";
export * from "./repositories/state.turso.repository.js";
export * from "./repositories/status.turso.repository.js";
export * from "./repositories/event.turso.repository.js";
export * from "./repositories/user.turso.repository.js";
export * from "./repositories/refresh-session.turso.repository.js";
export * from "./repositories/audit.turso.repository.js";

let defaultTursoRepositories: TursoDatabaseRepositories | null = null;
let defaultTursoBridge: TursoMqttDatabaseBridge | null = null;

export function createTursoRepositories(client: Client): TursoDatabaseRepositories {
  return {
    telemetry: new TelemetryTursoRepository(client),
    state: new StateTursoRepository(client),
    status: new StatusTursoRepository(client),
    event: new EventTursoRepository(client),
    user: new UserTursoRepository(client),
    refreshSession: new RefreshSessionTursoRepository(client),
    audit: new AuditTursoRepository(client),
  };
}

export interface TursoDatabaseLayerResult {
  client: Client;
  repositories: TursoDatabaseRepositories;
  bridge: TursoMqttDatabaseBridge;
}

export async function initializeTursoDatabaseLayer(
  client: Client = getTursoClient(),
  service: NexGasMqttService = mqttService,
): Promise<TursoDatabaseLayerResult> {
  // Apply schema migrations
  await runTursoMigrations(client);

  defaultTursoRepositories = createTursoRepositories(client);
  defaultTursoBridge = new TursoMqttDatabaseBridge(service, defaultTursoRepositories);
  defaultTursoBridge.attach();

  return {
    client,
    repositories: defaultTursoRepositories,
    bridge: defaultTursoBridge,
  };
}

export function getTursoRepositories(): TursoDatabaseRepositories {
  if (!defaultTursoRepositories) {
    const client = getTursoClient();
    defaultTursoRepositories = createTursoRepositories(client);
  }
  return defaultTursoRepositories;
}

