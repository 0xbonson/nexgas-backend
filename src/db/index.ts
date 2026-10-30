import { Database } from "better-sqlite3";
export * from "./database.js";
export * from "./migrations/index.js";
export * from "./repositories/telemetry.repository.js";
export * from "./repositories/state.repository.js";
export * from "./repositories/status.repository.js";
export * from "./repositories/event.repository.js";
export * from "./bridge.js";

import { getDatabase } from "./database.js";
import { runMigrations } from "./migrations/index.js";
import { TelemetryRepository } from "./repositories/telemetry.repository.js";
import { StateRepository } from "./repositories/state.repository.js";
import { StatusRepository } from "./repositories/status.repository.js";
import { EventRepository } from "./repositories/event.repository.js";
import { MqttDatabaseBridge, DatabaseRepositories } from "./bridge.js";
import { NexGasMqttService, mqttService } from "../mqtt/client.js";

let defaultRepositories: DatabaseRepositories | null = null;
let defaultBridge: MqttDatabaseBridge | null = null;

export interface DatabaseLayerResult {
  db: Database;
  repositories: DatabaseRepositories;
  bridge: MqttDatabaseBridge;
}

export function initializeDatabaseLayer(
  service: NexGasMqttService = mqttService,
): DatabaseLayerResult {
  const db = getDatabase();
  runMigrations(db);

  defaultRepositories = {
    telemetry: new TelemetryRepository(db),
    state: new StateRepository(db),
    status: new StatusRepository(db),
    event: new EventRepository(db),
  };

  defaultBridge = new MqttDatabaseBridge(service, defaultRepositories);
  defaultBridge.attach();

  return {
    db,
    repositories: defaultRepositories,
    bridge: defaultBridge,
  };
}

export function getRepositories(): DatabaseRepositories {
  if (!defaultRepositories) {
    initializeDatabaseLayer();
  }
  return defaultRepositories!;
}