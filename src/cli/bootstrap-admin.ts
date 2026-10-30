import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDatabase, closeDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations/index.js";
import { UserRepository } from "../db/repositories/user.repository.js";
import { AuditRepository } from "../db/repositories/audit.repository.js";
import { hashPassword } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { Database } from "better-sqlite3";

export interface BootstrapAdminOptions {
  username?: string;
  password?: string;
}

export async function bootstrapAdmin(
  db: Database,
  options?: BootstrapAdminOptions,
): Promise<{ id: number; username: string }> {
  runMigrations(db);

  const userRepo = new UserRepository(db);
  const auditRepo = new AuditRepository(db);

  let username = options?.username?.trim();
  let password = options?.password;

  // Interactive CLI prompt if arguments are not provided
  if (!username || !password) {
    const rl = readline.createInterface({ input, output });
    try {
      if (!username) {
        username = (await rl.question("Enter admin username [admin]: ")).trim() || "admin";
      }

      if (!password) {
        password = await rl.question("Enter secure admin password (min 8 chars): ");
      }
    } finally {
      rl.close();
    }
  }

  if (!username || username.length < 3) {
    throw new Error("Admin username must be at least 3 characters long");
  }

  if (!password || password.length < 8) {
    throw new Error("Admin password must be at least 8 characters long");
  }

  // Check duplicate
  const existingUser = userRepo.findByUsername(username);
  if (existingUser) {
    throw new Error(
      `Cannot bootstrap: user with username "${username}" already exists. Duplicate bootstrap rejected.`,
    );
  }

  const passwordHash = await hashPassword(password);
  const user = userRepo.createUser({
    username,
    passwordHash,
    role: "admin",
    isActive: true,
  });

  auditRepo.insert({
    userId: user.id,
    username: user.username,
    ipAddress: "cli-local",
    action: "auth:bootstrap_admin",
    resource: "user",
    details: { username: user.username, role: user.role },
    status: "success",
  });

  logger.info(`Successfully bootstrapped admin user "${user.username}" (ID: ${user.id})`);
  return { id: user.id, username: user.username };
}

// Direct execution from CLI
if (process.argv[1]?.endsWith("bootstrap-admin.ts") || process.argv[1]?.endsWith("bootstrap-admin.js")) {
  const db = getDatabase();
  const cliUsername = process.argv[2];
  const cliPassword = process.argv[3];

  bootstrapAdmin(db, { username: cliUsername, password: cliPassword })
    .then((res) => {
      console.log(`[NEX-GAS] Admin user "${res.username}" created successfully.`);
      closeDatabase(db);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[NEX-GAS ERROR] ${(err as Error).message}`);
      closeDatabase(db);
      process.exit(1);
    });
}
