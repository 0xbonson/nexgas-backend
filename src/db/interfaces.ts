import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
  User,
  UserRole,
  UserWithPassword,
  CreateUserInput,
  RefreshSession,
  CreateRefreshSessionInput,
  AuditLogEntry,
  CreateAuditLogInput,
} from "../types/index.js";
import { TelemetryQueryOptions } from "./repositories/telemetry.repository.js";
import { StateQueryOptions } from "./repositories/state.repository.js";
import { StatusQueryOptions } from "./repositories/status.repository.js";
import { EventQueryOptions } from "./repositories/event.repository.js";

export interface ITelemetryRepository {
  insert(telemetry: NormalizedTelemetry): Promise<{ inserted: boolean; id: number }>;
  getLatest(deviceId: string): Promise<NormalizedTelemetry | null>;
  getHistory(options?: TelemetryQueryOptions): Promise<{ items: NormalizedTelemetry[]; total: number }>;
  count?(): Promise<number>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}

export interface IStateRepository {
  save(state: NormalizedDeviceState): Promise<void>;
  getCurrent(deviceId: string): Promise<NormalizedDeviceState | null>;
  getHistory(options?: StateQueryOptions): Promise<{ items: NormalizedDeviceState[]; total: number }>;
  countHistory?(): Promise<number>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}

export interface IStatusRepository {
  save(status: NormalizedDeviceStatus): Promise<void>;
  getCurrent(deviceId: string): Promise<NormalizedDeviceStatus | null>;
  getHistory(options?: StatusQueryOptions): Promise<{ items: NormalizedDeviceStatus[]; total: number }>;
  countHistory?(): Promise<number>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}

export interface IEventRepository {
  insert(event: NormalizedDeviceEvent): Promise<{ id: number }>;
  getHistory(options?: EventQueryOptions): Promise<{ items: NormalizedDeviceEvent[]; total: number }>;
  count?(): Promise<number>;
}

export interface IUserRepository {
  createUser(input: CreateUserInput): Promise<User>;
  findById(id: number): Promise<User | null>;
  findByUsername(username: string): Promise<UserWithPassword | null>;
  findSafeByUsername(username: string): Promise<User | null>;
  count(): Promise<number>;
  countByRole(role: UserRole): Promise<number>;
  updatePassword(id: number, passwordHash: string): Promise<void>;
  setActive(id: number, isActive: boolean): Promise<void>;
  listUsers(limit?: number, offset?: number): Promise<{ items: User[]; total: number }>;
}

export interface IRefreshSessionRepository {
  createSession(input: CreateRefreshSessionInput): Promise<RefreshSession>;
  findByTokenHash(tokenHash: string): Promise<RefreshSession | null>;
  revokeSession(tokenHash: string, replacedByHash?: string): Promise<boolean>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: number): Promise<void>;
  deleteExpired(): Promise<number>;
  count?(): Promise<number>;
}

export interface IAuditRepository {
  insert(entry: CreateAuditLogInput): Promise<AuditLogEntry>;
  getLogs(limit?: number, offset?: number): Promise<{ items: AuditLogEntry[]; total: number }>;
  count(): Promise<number>;
}

export interface DatabaseRepositories {
  telemetry: ITelemetryRepository;
  state: IStateRepository;
  status: IStatusRepository;
  event: IEventRepository;
  user: IUserRepository;
  refreshSession: IRefreshSessionRepository;
  audit: IAuditRepository;
}

export interface IMqttDatabaseBridge {
  attach(): void;
  detach(): void;
}

