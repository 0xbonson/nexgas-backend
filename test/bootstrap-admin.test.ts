import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Database } from "better-sqlite3";
import { createDatabase, closeDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { UserRepository } from "../src/db/repositories/user.repository.js";
import { bootstrapAdmin } from "../src/cli/bootstrap-admin.js";
import { verifyPassword } from "../src/utils/crypto.js";

describe("CLI Admin Bootstrap Verification", () => {
  let db: Database;
  let userRepo: UserRepository;

  beforeAll(() => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    userRepo = new UserRepository(db);
  });

  afterAll(() => {
    closeDatabase(db);
  });

  it("successfully bootstraps first admin user with secure password hash", async () => {
    const res = await bootstrapAdmin(db, {
      username: "super_admin",
      password: "SuperSecretPassword123!",
    });

    expect(res.username).toBe("super_admin");
    expect(res.id).toBeGreaterThan(0);

    const user = userRepo.findByUsername("super_admin");
    expect(user).toBeTruthy();
    expect(user?.role).toBe("admin");
    expect(user?.isActive).toBe(true);
    expect(user?.passwordHash).toContain("$argon2id$");

    const verified = await verifyPassword(user!.passwordHash, "SuperSecretPassword123!");
    expect(verified).toBe(true);
  });

  it("strictly prevents creating a duplicate admin user with the same username", async () => {
    await expect(
      bootstrapAdmin(db, {
        username: "super_admin",
        password: "AnotherPassword123!",
      }),
    ).rejects.toThrow(/already exists.*Duplicate bootstrap rejected/);
  });

  it("rejects password shorter than 8 characters", async () => {
    await expect(
      bootstrapAdmin(db, {
        username: "short_pw_admin",
        password: "short",
      }),
    ).rejects.toThrow(/at least 8 characters/);
  });

  it("rejects username shorter than 3 characters", async () => {
    await expect(
      bootstrapAdmin(db, {
        username: "ad",
        password: "ValidPassword123!",
      }),
    ).rejects.toThrow(/at least 3 characters/);
  });
});
