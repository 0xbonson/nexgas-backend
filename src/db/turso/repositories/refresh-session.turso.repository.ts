import { Client, Row } from "@libsql/client";
import {
  RefreshSession,
  CreateRefreshSessionInput,
} from "../../../types/index.js";
import { IRefreshSessionRepository } from "../../interfaces.js";

export class RefreshSessionTursoRepository implements IRefreshSessionRepository {
  constructor(private client: Client) {}

  public async createSession(
    input: CreateRefreshSessionInput,
  ): Promise<RefreshSession> {
    const now = new Date().toISOString();

    const res = await this.client.execute({
      sql: `
        INSERT INTO refresh_sessions (user_id, token_hash, family_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        input.userId,
        input.tokenHash,
        input.familyId,
        input.expiresAt,
        now,
      ],
    });

    return {
      id: Number(res.lastInsertRowid ?? 0),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      createdAt: now,
      revokedAt: null,
      replacedByHash: null,
    };
  }

  public async findByTokenHash(
    tokenHash: string,
  ): Promise<RefreshSession | null> {
    const res = await this.client.execute({
      sql: `
        SELECT id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by_hash
        FROM refresh_sessions
        WHERE token_hash = ?
      `,
      args: [tokenHash],
    });

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  public async revokeSession(
    tokenHash: string,
    replacedByHash?: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.client.execute({
      sql: `
        UPDATE refresh_sessions
        SET revoked_at = ?, replaced_by_hash = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      `,
      args: [now, replacedByHash || null, tokenHash],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  public async revokeFamily(familyId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE refresh_sessions
        SET revoked_at = ?
        WHERE family_id = ? AND revoked_at IS NULL
      `,
      args: [now, familyId],
    });
  }

  public async revokeAllForUser(userId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE refresh_sessions
        SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `,
      args: [now, userId],
    });
  }

  public async deleteExpired(): Promise<number> {
    const now = new Date().toISOString();
    const res = await this.client.execute({
      sql: `
        DELETE FROM refresh_sessions
        WHERE expires_at < ?
      `,
      args: [now],
    });
    return Number(res.rowsAffected ?? 0);
  }

  public async count(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM refresh_sessions",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private mapRow(row: Row): RefreshSession {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      tokenHash: String(row.token_hash),
      familyId: String(row.family_id),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      revokedAt: (row.revoked_at as string | null) ?? null,
      replacedByHash: (row.replaced_by_hash as string | null) ?? null,
    };
  }
}

