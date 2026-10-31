import { Client, Row } from "@libsql/client";
import { AuditLogEntry, CreateAuditLogInput } from "../../../types/index.js";
import { sanitize } from "../../../utils/logger.js";
import { IAuditRepository } from "../../interfaces.js";

export class AuditTursoRepository implements IAuditRepository {
  constructor(private client: Client) {}

  public async insert(entry: CreateAuditLogInput): Promise<AuditLogEntry> {
    const now = new Date().toISOString();

    let serializedDetails: string | null = null;
    if (entry.details !== undefined && entry.details !== null) {
      if (typeof entry.details === "string") {
        serializedDetails = entry.details;
      } else {
        serializedDetails = JSON.stringify(sanitize(entry.details));
      }
    }

    const res = await this.client.execute({
      sql: `
        INSERT INTO audit_logs (
          user_id, username, ip_address, action, resource, details, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        entry.userId ?? null,
        entry.username ?? null,
        entry.ipAddress ?? null,
        entry.action,
        entry.resource ?? null,
        serializedDetails,
        entry.status,
        now,
      ],
    });

    return {
      id: Number(res.lastInsertRowid ?? 0),
      userId: entry.userId ?? null,
      username: entry.username ?? null,
      ipAddress: entry.ipAddress ?? null,
      action: entry.action,
      resource: entry.resource ?? null,
      details: serializedDetails,
      status: entry.status,
      createdAt: now,
    };
  }

  public async getLogs(
    limit = 50,
    offset = 0,
  ): Promise<{ items: AuditLogEntry[]; total: number }> {
    const rowsRes = await this.client.execute({
      sql: `
        SELECT id, user_id, username, ip_address, action, resource, details, status, created_at
        FROM audit_logs
        ORDER BY id DESC
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

  public async count(): Promise<number> {
    const res = await this.client.execute(
      "SELECT COUNT(*) as count FROM audit_logs",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private mapRow(row: Row): AuditLogEntry {
    return {
      id: Number(row.id),
      userId: row.user_id !== null ? Number(row.user_id) : null,
      username: (row.username as string | null) ?? null,
      ipAddress: (row.ip_address as string | null) ?? null,
      action: String(row.action),
      resource: (row.resource as string | null) ?? null,
      details: (row.details as string | null) ?? null,
      status: String(row.status) as "success" | "rejected" | "failed",
      createdAt: String(row.created_at),
    };
  }
}

