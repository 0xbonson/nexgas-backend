/**
 * NEX-GAS Authentication, RBAC, and Audit Logging Types
 */

export type UserRole = "viewer" | "operator" | "admin";

export interface User {
  id: number;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: UserRole;
  isActive?: boolean;
}

export interface RefreshSession {
  id: number;
  userId: number;
  tokenHash: string;
  familyId: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  replacedByHash: string | null;
}

export interface CreateRefreshSessionInput {
  userId: number;
  tokenHash: string;
  familyId: string;
  expiresAt: string;
}

export interface AuditLogEntry {
  id: number;
  userId: number | null;
  username: string | null;
  ipAddress: string | null;
  action: string;
  resource: string | null;
  details: string | null;
  status: "success" | "rejected" | "failed";
  createdAt: string;
}

export interface CreateAuditLogInput {
  userId?: number | null;
  username?: string | null;
  ipAddress?: string | null;
  action: string;
  resource?: string | null;
  details?: Record<string, unknown> | string | null;
  status: "success" | "rejected" | "failed";
}

export interface AuthTokenPayload {
  sub: string; // userId as string
  username: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
