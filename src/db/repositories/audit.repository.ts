import { Database, Statement } from "better-sqlite3";
import { AuditLogEntry, CreateAuditLogInput } from "../../types/index.js";
import { sanitize } from "../../utils/logger.js";

interface AuditLogRow {
  id: number;
  user_id: number | null;
  username: string | null;
  ip_address: string | null;
  action: string;
  resource: string | null;
  details: string | null;
  status: string;
  created_at: string;
}

export class AuditRepository {
  private stmtInsert: Statement;
  private stmtList: Statement;
  private stmtCount: Statement;

  constructor(private db: Database) {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO audit_logs (user_id, username, ip_address, action, resource, details, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtList = this.db.prepare(`
      SELECT id, user_id, username, ip_address, action, resource, details, status, created_at
      FROM audit_logs
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `);

    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_logs
    `);
  }

  private mapRow(row: AuditLogRow): AuditLogEntry {
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      ipAddress: row.ip_address,
      action: row.action,
      resource: row.resource,
      details: row.details,
      status: row.status as "success" | "rejected" | "failed",
      createdAt: row.created_at,
    };
  }

  public insert(entry: CreateAuditLogInput): AuditLogEntry {
    const now = new Date().toISOString();

    // Ensure details are sanitized against any secrets/tokens before saving
    let serializedDetails: string | null = null;
    if (entry.details !== undefined && entry.details !== null) {
      if (typeof entry.details === "string") {
        serializedDetails = entry.details;
      } else {
        serializedDetails = JSON.stringify(sanitize(entry.details));
      }
    }

    const info = this.stmtInsert.run(
      entry.userId ?? null,
      entry.username ?? null,
      entry.ipAddress ?? null,
      entry.action,
      entry.resource ?? null,
      serializedDetails,
      entry.status,
      now,
    );

    return {
      id: Number(info.lastInsertRowid),
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

  public count(): number {
    const countRow = this.stmtCount.get() as { count: number };
    return countRow.count;
  }

  public getLogs(limit = 50, offset = 0): { items: AuditLogEntry[]; total: number } {
    const rows = this.stmtList.all(limit, offset) as AuditLogRow[];
    const countRow = this.stmtCount.get() as { count: number };

    return {
      items: rows.map((r) => this.mapRow(r)),
      total: countRow.count,
    };
  }
}
