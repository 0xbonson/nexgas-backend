import { Database, Statement } from "better-sqlite3";
import { RefreshSession, CreateRefreshSessionInput } from "../../types/index.js";

interface RefreshSessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  family_id: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  replaced_by_hash: string | null;
}

export class RefreshSessionRepository {
  private stmtInsert: Statement;
  private stmtFindByHash: Statement;
  private stmtRevokeSession: Statement;
  private stmtRevokeFamily: Statement;
  private stmtRevokeAllForUser: Statement;
  private stmtDeleteExpired: Statement;

  constructor(private db: Database) {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO refresh_sessions (user_id, token_hash, family_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtFindByHash = this.db.prepare(`
      SELECT id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by_hash
      FROM refresh_sessions
      WHERE token_hash = ?
    `);

    this.stmtRevokeSession = this.db.prepare(`
      UPDATE refresh_sessions
      SET revoked_at = ?, replaced_by_hash = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `);

    this.stmtRevokeFamily = this.db.prepare(`
      UPDATE refresh_sessions
      SET revoked_at = ?
      WHERE family_id = ? AND revoked_at IS NULL
    `);

    this.stmtRevokeAllForUser = this.db.prepare(`
      UPDATE refresh_sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `);

    this.stmtDeleteExpired = this.db.prepare(`
      DELETE FROM refresh_sessions
      WHERE expires_at < ?
    `);
  }

  private mapRow(row: RefreshSessionRow): RefreshSession {
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      familyId: row.family_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      replacedByHash: row.replaced_by_hash,
    };
  }

  public createSession(input: CreateRefreshSessionInput): RefreshSession {
    const now = new Date().toISOString();
    const info = this.stmtInsert.run(
      input.userId,
      input.tokenHash,
      input.familyId,
      input.expiresAt,
      now,
    );

    return {
      id: Number(info.lastInsertRowid),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      createdAt: now,
      revokedAt: null,
      replacedByHash: null,
    };
  }

  public findByTokenHash(tokenHash: string): RefreshSession | null {
    const row = this.stmtFindByHash.get(tokenHash) as RefreshSessionRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  public revokeSession(tokenHash: string, replacedByHash?: string): boolean {
    const now = new Date().toISOString();
    const info = this.stmtRevokeSession.run(now, replacedByHash || null, tokenHash);
    return info.changes > 0;
  }

  public revokeFamily(familyId: string): void {
    const now = new Date().toISOString();
    this.stmtRevokeFamily.run(now, familyId);
  }

  public revokeAllForUser(userId: number): void {
    const now = new Date().toISOString();
    this.stmtRevokeAllForUser.run(now, userId);
  }

  public deleteExpired(): number {
    const now = new Date().toISOString();
    const info = this.stmtDeleteExpired.run(now);
    return Number(info.changes);
  }
}
