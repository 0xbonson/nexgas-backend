import { Database, Statement } from "better-sqlite3";
import { User, UserRole, UserWithPassword, CreateUserInput } from "../../types/index.js";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export class UserRepository {
  private stmtInsert: Statement;
  private stmtFindById: Statement;
  private stmtFindByUsername: Statement;
  private stmtCount: Statement;
  private stmtCountByRole: Statement;
  private stmtUpdatePassword: Statement;
  private stmtSetActive: Statement;
  private stmtList: Statement;

  constructor(private db: Database) {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtFindById = this.db.prepare(`
      SELECT id, username, password_hash, role, is_active, created_at, updated_at
      FROM users
      WHERE id = ?
    `);

    this.stmtFindByUsername = this.db.prepare(`
      SELECT id, username, password_hash, role, is_active, created_at, updated_at
      FROM users
      WHERE username = ?
    `);

    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM users
    `);

    this.stmtCountByRole = this.db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE role = ?
    `);

    this.stmtUpdatePassword = this.db.prepare(`
      UPDATE users
      SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtSetActive = this.db.prepare(`
      UPDATE users
      SET is_active = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtList = this.db.prepare(`
      SELECT id, username, role, is_active, created_at, updated_at
      FROM users
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `);
  }

  private mapRow(row: UserRow): User {
    return {
      id: row.id,
      username: row.username,
      role: row.role as UserRole,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRowWithPassword(row: UserRow): UserWithPassword {
    return {
      ...this.mapRow(row),
      passwordHash: row.password_hash,
    };
  }

  public createUser(input: CreateUserInput): User {
    const now = new Date().toISOString();
    const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : 1;

    const info = this.stmtInsert.run(
      input.username.trim(),
      input.passwordHash,
      input.role,
      isActive,
      now,
      now,
    );

    return {
      id: Number(info.lastInsertRowid),
      username: input.username.trim(),
      role: input.role,
      isActive: isActive === 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  public findById(id: number): User | null {
    const row = this.stmtFindById.get(id) as UserRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  public findByUsername(username: string): UserWithPassword | null {
    const row = this.stmtFindByUsername.get(username.trim()) as UserRow | undefined;
    return row ? this.mapRowWithPassword(row) : null;
  }

  public findSafeByUsername(username: string): User | null {
    const user = this.findByUsername(username);
    if (!user) return null;
    const { passwordHash: _hash, ...safeUser } = user;
    return safeUser;
  }

  public count(): number {
    const row = this.stmtCount.get() as { count: number };
    return row.count;
  }

  public countByRole(role: UserRole): number {
    const row = this.stmtCountByRole.get(role) as { count: number };
    return row.count;
  }

  public updatePassword(id: number, passwordHash: string): void {
    this.stmtUpdatePassword.run(passwordHash, new Date().toISOString(), id);
  }

  public setActive(id: number, isActive: boolean): void {
    this.stmtSetActive.run(isActive ? 1 : 0, new Date().toISOString(), id);
  }

  public listUsers(limit = 50, offset = 0): { items: User[]; total: number } {
    const rows = this.stmtList.all(limit, offset) as UserRow[];
    const total = this.count();
    return {
      items: rows.map((r) => this.mapRow(r)),
      total,
    };
  }
}
