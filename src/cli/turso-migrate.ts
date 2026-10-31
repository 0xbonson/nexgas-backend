import { Client } from "@libsql/client";
import { createTursoClient, closeTursoClient } from "../db/turso/client.js";
import { runTursoMigrations } from "../db/turso/migrations.js";
import { logger } from "../utils/logger.js";

export interface TursoMigrateCliOptions {
  url?: string;
  authToken?: string;
}

export async function migrateTurso(
  client: Client,
): Promise<{ applied: number; currentVersion: number }> {
  return await runTursoMigrations(client);
}

// Direct CLI execution
if (
  process.argv[1]?.endsWith("turso-migrate.ts") ||
  process.argv[1]?.endsWith("turso-migrate.js")
) {
  const args = process.argv.slice(2);
  let cliUrl: string | undefined;
  let cliToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      cliUrl = args[i + 1];
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      cliToken = args[i + 1];
      i++;
    }
  }

  console.log("==================================================");
  console.log("  NEX-GAS — Turso Cloud Database Migration Runner");
  console.log("==================================================");

  let client: Client | null = null;
  try {
    client = createTursoClient({
      url: cliUrl,
      authToken: cliToken,
    });

    const result = await migrateTurso(client);

    console.log(`\n[SUCCESS] Migrations complete.`);
    console.log(`- Newly applied migrations: ${result.applied}`);
    console.log(`- Current schema version:   ${result.currentVersion}`);
    closeTursoClient(client);
    process.exit(0);
  } catch (err) {
    console.error(`\n[FATAL ERROR] Migration failed: ${(err as Error).message}`);
    if (client) closeTursoClient(client);
    process.exit(1);
  }
}

