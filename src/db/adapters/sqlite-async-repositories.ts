import { Database } from "better-sqlite3";
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
} from "../../types/index.js";
import {
  ITelemetryRepository,
  IStateRepository,
  IStatusRepository,
  IEventRepository,
  IUserRepository,
  IRefreshSessionRepository,
  IAuditRepository,
  DatabaseRepositories,
} from "../interfaces.js";
import { TelemetryRepository, TelemetryQueryOptions } from "../repositories/telemetry.repository.js";
import { StateRepository, StateQueryOptions } from "../repositories/state.repository.js";
import { StatusRepository, StatusQueryOptions } from "../repositories/status.repository.js";
import { EventRepository, EventQueryOptions } from "../repositories/event.repository.js";
import { UserRepository } from "../repositories/user.repository.js";
import { RefreshSessionRepository } from "../repositories/refresh-session.repository.js";
import { AuditRepository } from "../repositories/audit.repository.js";

export class SqliteTelemetryAdapter implements ITelemetryRepository {
  constructor(private syncRepo: TelemetryRepository) {}

  public async insert(telemetry: NormalizedTelemetry): Promise<{ inserted: boolean; id: number }> {
    return this.syncRepo.insert(telemetry);
  }

  public async getLatest(deviceId: string): Promise<NormalizedTelemetry | null> {
    return this.syncRepo.getLatest(deviceId);
  }

  public async getHistory(options: TelemetryQueryOptions = {}): Promise<{ items: NormalizedTelemetry[]; total: number }> {
    return this.syncRepo.getHistory(options);
  }

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    return this.syncRepo.deleteOlderThan(cutoffIso);
  }
}

export class SqliteStateAdapter implements IStateRepository {
  constructor(private syncRepo: StateRepository) {}

  public async save(state: NormalizedDeviceState): Promise<void> {
    this.syncRepo.save(state);
  }

  public async getCurrent(deviceId: string): Promise<NormalizedDeviceState | null> {
    return this.syncRepo.getCurrent(deviceId);
  }

  public async getHistory(options: StateQueryOptions = {}): Promise<{ items: NormalizedDeviceState[]; total: number }> {
    return this.syncRepo.getHistory(options);
  }

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    return this.syncRepo.deleteOlderThan(cutoffIso);
  }
}

export class SqliteStatusAdapter implements IStatusRepository {
  constructor(private syncRepo: StatusRepository) {}

  public async save(status: NormalizedDeviceStatus): Promise<void> {
    this.syncRepo.save(status);
  }

  public async getCurrent(deviceId: string): Promise<NormalizedDeviceStatus | null> {
    return this.syncRepo.getCurrent(deviceId);
  }

  public async getHistory(options: StatusQueryOptions = {}): Promise<{ items: NormalizedDeviceStatus[]; total: number }> {
    return this.syncRepo.getHistory(options);
  }

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    return this.syncRepo.deleteOlderThan(cutoffIso);
  }
}

export class SqliteEventAdapter implements IEventRepository {
  constructor(private syncRepo: EventRepository) {}

  public async insert(event: NormalizedDeviceEvent): Promise<{ id: number }> {
    return this.syncRepo.insert(event);
  }

  public async getHistory(options: EventQueryOptions = {}): Promise<{ items: NormalizedDeviceEvent[]; total: number }> {
    return this.syncRepo.getHistory(options);
  }
}

export class SqliteUserAdapter implements IUserRepository {
  constructor(private syncRepo: UserRepository) {}

  public async createUser(input: CreateUserInput): Promise<User> {
    return this.syncRepo.createUser(input);
  }

  public async findById(id: number): Promise<User | null> {
    return this.syncRepo.findById(id);
  }

  public async findByUsername(username: string): Promise<UserWithPassword | null> {
    return this.syncRepo.findByUsername(username);
  }

  public async findSafeByUsername(username: string): Promise<User | null> {
    return this.syncRepo.findSafeByUsername(username);
  }

  public async count(): Promise<number> {
    return this.syncRepo.count();
  }

  public async countByRole(role: UserRole): Promise<number> {
    return this.syncRepo.countByRole(role);
  }

  public async updatePassword(id: number, passwordHash: string): Promise<void> {
    this.syncRepo.updatePassword(id, passwordHash);
  }

  public async setActive(id: number, isActive: boolean): Promise<void> {
    this.syncRepo.setActive(id, isActive);
  }

  public async listUsers(limit = 50, offset = 0): Promise<{ items: User[]; total: number }> {
    return this.syncRepo.listUsers(limit, offset);
  }
}

export class SqliteRefreshSessionAdapter implements IRefreshSessionRepository {
  constructor(private syncRepo: RefreshSessionRepository) {}

  public async createSession(input: CreateRefreshSessionInput): Promise<RefreshSession> {
    return this.syncRepo.createSession(input);
  }

  public async findByTokenHash(tokenHash: string): Promise<RefreshSession | null> {
    return this.syncRepo.findByTokenHash(tokenHash);
  }

  public async revokeSession(tokenHash: string, replacedByHash?: string): Promise<boolean> {
    return this.syncRepo.revokeSession(tokenHash, replacedByHash);
  }

  public async revokeFamily(familyId: string): Promise<void> {
    this.syncRepo.revokeFamily(familyId);
  }

  public async revokeAllForUser(userId: number): Promise<void> {
    this.syncRepo.revokeAllForUser(userId);
  }

  public async deleteExpired(): Promise<number> {
    return this.syncRepo.deleteExpired();
  }
}

export class SqliteAuditAdapter implements IAuditRepository {
  constructor(private syncRepo: AuditRepository) {}

  public async insert(entry: CreateAuditLogInput): Promise<AuditLogEntry> {
    return this.syncRepo.insert(entry);
  }

  public async getLogs(limit = 50, offset = 0): Promise<{ items: AuditLogEntry[]; total: number }> {
    return this.syncRepo.getLogs(limit, offset);
  }

  public async count(): Promise<number> {
    return this.syncRepo.count();
  }
}

export function createSqliteAsyncRepositories(db: Database): DatabaseRepositories {
  return {
    telemetry: new SqliteTelemetryAdapter(new TelemetryRepository(db)),
    state: new SqliteStateAdapter(new StateRepository(db)),
    status: new SqliteStatusAdapter(new StatusRepository(db)),
    event: new SqliteEventAdapter(new EventRepository(db)),
    user: new SqliteUserAdapter(new UserRepository(db)),
    refreshSession: new SqliteRefreshSessionAdapter(new RefreshSessionRepository(db)),
    audit: new SqliteAuditAdapter(new AuditRepository(db)),
  };
}

