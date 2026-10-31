import { Client, Row } from "@libsql/client";
import {
  User,
  UserRole,
  UserWithPassword,
  CreateUserInput,
} from "../../../types/index.js";
import { IUserRepository } from "../../interfaces.js";

export class UserTursoRepository implements IUserRepository {
  constructor(private client: Client) {}

  public async createUser(input: CreateUserInput): Promise<User> {
    const now = new Date().toISOString();
    const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : 1;

    const res = await this.client.execute({
      sql: `
        INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [
        input.username.trim(),
        input.passwordHash,
        input.role,
        isActive,
        now,
        now,
      ],
    });

    return {
      id: Number(res.lastInsertRowid ?? 0),
      username: input.username.trim(),
      role: input.role,
      isActive: isActive === 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  public async findById(id: number): Promise<User | null> {
    const res = await this.client.execute({
      sql: `
        SELECT id, username, password_hash, role, is_active, created_at, updated_at
        FROM users
        WHERE id = ?
      `,
      args: [id],
    });

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  public async findByUsername(
    username: string,
  ): Promise<UserWithPassword | null> {
    const res = await this.client.execute({
      sql: `
        SELECT id, username, password_hash, role, is_active, created_at, updated_at
        FROM users
        WHERE username = ?
      `,
      args: [username.trim()],
    });

    if (res.rows.length === 0) return null;
    return this.mapRowWithPassword(res.rows[0]);
  }

  public async findSafeByUsername(username: string): Promise<User | null> {
    const user = await this.findByUsername(username);
    if (!user) return null;
    const { passwordHash: _hash, ...safeUser } = user;
    return safeUser;
  }

  public async count(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM users",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  public async countByRole(role: UserRole): Promise<number> {
    const res = await this.client.execute({
      sql: "SELECT COUNT(*) as count FROM users WHERE role = ?",
      args: [role],
    });
    return Number(res.rows[0]?.count ?? 0);
  }

  public async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      args: [passwordHash, new Date().toISOString(), id],
    });
  }

  public async setActive(id: number, isActive: boolean): Promise<void> {
    await this.client.execute({
      sql: "UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?",
      args: [isActive ? 1 : 0, new Date().toISOString(), id],
    });
  }

  public async listUsers(
    limit = 50,
    offset = 0,
  ): Promise<{ items: User[]; total: number }> {
    const rowsRes = await this.client.execute({
      sql: `
        SELECT id, username, role, is_active, created_at, updated_at
        FROM users
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `,
      args: [limit, offset],
    });

    const total = await this.count();

    return {
      items: rowsRes.rows.map((r) => this.mapRow(r)),
      total,
    };
  }

  private mapRow(row: Row): User {
    return {
      id: Number(row.id),
      username: String(row.username),
      role: String(row.role) as UserRole,
      isActive: Number(row.is_active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRowWithPassword(row: Row): UserWithPassword {
    return {
      ...this.mapRow(row),
      passwordHash: String(row.password_hash),
    };
  }
}

