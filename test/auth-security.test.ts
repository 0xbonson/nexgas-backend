import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Server } from "http";
import { Database } from "better-sqlite3";
import { EventEmitter } from "events";
import { MqttClient } from "mqtt";
import * as jose from "jose";

import { createApp } from "../src/app.js";
import { createDatabase, closeDatabase, setDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { UserRepository } from "../src/db/repositories/user.repository.js";
import { RefreshSessionRepository } from "../src/db/repositories/refresh-session.repository.js";
import { AuditRepository } from "../src/db/repositories/audit.repository.js";
import { NexGasMqttService } from "../src/mqtt/client.js";
import { hashPassword, verifyPassword, hashToken } from "../src/utils/crypto.js";
import { signAccessToken, verifyAccessToken } from "../src/utils/jwt.js";
import { sanitize } from "../src/utils/logger.js";
import { resetLoginRateLimits } from "../src/api/auth.routes.js";
import { resetCommandRateLimits } from "../src/api/middleware/rate-limit.js";
import { config } from "../src/config/index.js";

class MockMqttClient extends EventEmitter {
  public connected = true;
  public publishedMessages: Array<{ topic: string; message: string; opts: any }> = [];

  public subscribe = (_topics: any, _opts: any, cb: any) => cb && cb(null, []);
  public publish = (topic: any, payload: any, opts: any, cb: any) => {
    this.publishedMessages.push({ topic, message: payload.toString(), opts });
    if (cb) cb(null);
  };
  public end = (_force: any, _opts: any, cb: any) => {
    this.connected = false;
    if (cb) cb();
  };
}

describe("NEX-GAS Phase 7B: Security & Authentication Architecture Verification", () => {
  let db: Database;
  let server: Server;
  let baseUrl: string;
  let mockMqttClient: MockMqttClient;
  let mqttService: NexGasMqttService;

  let userRepo: UserRepository;
  let sessionRepo: RefreshSessionRepository;
  let auditRepo: AuditRepository;

  let adminUser: any;
  let operatorUser: any;
  let viewerUser: any;
  let inactiveUser: any;

  beforeAll(async () => {
    db = createDatabase({ inMemory: true });
    runMigrations(db);
    setDatabase(db);

    userRepo = new UserRepository(db);
    sessionRepo = new RefreshSessionRepository(db);
    auditRepo = new AuditRepository(db);

    // Create test accounts with Argon2id hashed passwords
    const adminHash = await hashPassword("AdminSecretPassword123!");
    const operatorHash = await hashPassword("OperatorSecretPassword123!");
    const viewerHash = await hashPassword("ViewerSecretPassword123!");
    const inactiveHash = await hashPassword("InactiveSecretPassword123!");

    adminUser = userRepo.createUser({
      username: "admin_test",
      passwordHash: adminHash,
      role: "admin",
      isActive: true,
    });

    operatorUser = userRepo.createUser({
      username: "operator_test",
      passwordHash: operatorHash,
      role: "operator",
      isActive: true,
    });

    viewerUser = userRepo.createUser({
      username: "viewer_test",
      passwordHash: viewerHash,
      role: "viewer",
      isActive: true,
    });

    inactiveUser = userRepo.createUser({
      username: "inactive_test",
      passwordHash: inactiveHash,
      role: "operator",
      isActive: false,
    });

    mockMqttClient = new MockMqttClient();
    mqttService = new NexGasMqttService(mockMqttClient as unknown as MqttClient);

    const app = createApp(mqttService);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    mockMqttClient.emit("connect");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    setDatabase(null);
  });

  beforeEach(() => {
    resetLoginRateLimits();
    resetCommandRateLimits();
    mockMqttClient.publishedMessages = [];
    mockMqttClient.emit("connect");
  });

  // ==========================================================================
  // 1. Password Hashing & Verification (Argon2id)
  // ==========================================================================
  it("Requirement 1: Argon2id securely hashes passwords and verifies valid vs invalid passwords", async () => {
    const rawPassword = "StrongUserPassword#2026";
    const hash = await hashPassword(rawPassword);

    expect(hash).toContain("$argon2id$");
    expect(hash).not.toBe(rawPassword);

    const isMatch = await verifyPassword(hash, rawPassword);
    expect(isMatch).toBe(true);

    const isWrongMatch = await verifyPassword(hash, "WrongPassword#2026");
    expect(isWrongMatch).toBe(false);
  });

  // ==========================================================================
  // 2. Login Berhasil
  // ==========================================================================
  it("Requirement 2: Successful login returns 200, JWT access token, and sets HttpOnly cookie", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin_test",
        password: "AdminSecretPassword123!",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.status).toBe("success");
    expect(body.user.username).toBe("admin_test");
    expect(body.user.role).toBe("admin");
    expect(body.user.passwordHash).toBeUndefined(); // Never leak password hash
    expect(typeof body.accessToken).toBe("string");
    expect(body.expiresIn).toBe(900);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("refreshToken=");
    expect(setCookie).toContain("HttpOnly");
  });

  // ==========================================================================
  // 3. Login Password Salah
  // ==========================================================================
  it("Requirement 3: Incorrect password returns 401 with generic error message", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin_test",
        password: "TotallyWrongPassword!",
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toBe("Invalid username or password");
  });

  // ==========================================================================
  // 4. Username Tidak Ditemukan
  // ==========================================================================
  it("Requirement 4: Non-existent username returns 401 with identical generic message (no user enumeration)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "non_existent_user_999",
        password: "SomePassword123!",
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toBe("Invalid username or password");
  });

  // ==========================================================================
  // 5. User Nonaktif
  // ==========================================================================
  it("Requirement 5: Inactive user account is rejected upon login", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "inactive_test",
        password: "InactiveSecretPassword123!",
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toBe("Invalid username or password");
  });

  // ==========================================================================
  // 6. JWT Valid
  // ==========================================================================
  it("Requirement 6: Valid JWT access token is signed and verified cleanly", async () => {
    const token = await signAccessToken({
      sub: String(adminUser.id),
      username: adminUser.username,
      role: adminUser.role,
    });

    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe(String(adminUser.id));
    expect(payload.username).toBe("admin_test");
    expect(payload.role).toBe("admin");
  });

  // ==========================================================================
  // 7. JWT Invalid
  // ==========================================================================
  it("Requirement 7: Tampered or invalid JWT signature is rejected", async () => {
    const validToken = await signAccessToken({
      sub: String(adminUser.id),
      username: adminUser.username,
      role: adminUser.role,
    });

    // Tamper token payload by replacing characters
    const tamperedToken = validToken.slice(0, -6) + "xxxxxx";
    await expect(verifyAccessToken(tamperedToken)).rejects.toThrow();
  });

  // ==========================================================================
  // 8. JWT Expired
  // ==========================================================================
  it("Requirement 8: Expired JWT is rejected with expiration error", async () => {
    const secretKey = new TextEncoder().encode(config.JWT_SECRET);
    const expiredToken = await new jose.SignJWT({
      username: adminUser.username,
      role: adminUser.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(adminUser.id))
      .setIssuer("nexgas-backend")
      .setAudience("nexgas-app")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800) // expired 30 mins ago
      .sign(secretKey);

    await expect(verifyAccessToken(expiredToken)).rejects.toThrow();
  });

  // ==========================================================================
  // 9. Refresh Berhasil
  // ==========================================================================
  it("Requirement 9: Valid refresh token rotates and yields new access token", async () => {
    // 1. Log in to get tokens
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator_test",
        password: "OperatorSecretPassword123!",
      }),
    });
    const loginBody = (await loginRes.json()) as any;
    const initialRefreshToken = loginBody.refreshToken;

    // 2. Call refresh
    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: initialRefreshToken }),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as any;
    expect(refreshBody.status).toBe("success");
    expect(typeof refreshBody.accessToken).toBe("string");
    expect(typeof refreshBody.refreshToken).toBe("string");
  });

  // ==========================================================================
  // 10. Refresh Token Rotation
  // ==========================================================================
  it("Requirement 10: Refresh token is rotated upon use; new token differs from old token", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator_test",
        password: "OperatorSecretPassword123!",
      }),
    });
    const loginBody = (await loginRes.json()) as any;
    const oldRefreshToken = loginBody.refreshToken;

    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: oldRefreshToken }),
    });

    const refreshBody = (await refreshRes.json()) as any;
    const newRefreshToken = refreshBody.refreshToken;

    expect(newRefreshToken).not.toBe(oldRefreshToken);

    // Verify in database that old token session is marked as replaced
    const oldSession = sessionRepo.findByTokenHash(hashToken(oldRefreshToken));
    expect(oldSession?.revokedAt).not.toBeNull();
    expect(oldSession?.replacedByHash).toBe(hashToken(newRefreshToken));
  });

  // ==========================================================================
  // 11. Refresh Token Reuse Ditolak (Replay Detection)
  // ==========================================================================
  it("Requirement 11: Reusing an already-rotated refresh token triggers immediate family revocation", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator_test",
        password: "OperatorSecretPassword123!",
      }),
    });
    const loginBody = (await loginRes.json()) as any;
    const token1 = loginBody.refreshToken;

    // First rotation (valid)
    const refreshRes1 = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token1 }),
    });
    expect(refreshRes1.status).toBe(200);
    const body1 = (await refreshRes1.json()) as any;
    const token2 = body1.refreshToken;

    // REPLAY ATTACK: Re-use token1!
    const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token1 }),
    });

    expect(replayRes.status).toBe(401);
    const replayBody = (await replayRes.json()) as any;
    expect(replayBody.message).toContain("Refresh token reuse detected");

    // Verify token2 is NOW ALSO REVOKED because the whole family was revoked
    const session2 = sessionRepo.findByTokenHash(hashToken(token2));
    expect(session2?.revokedAt).not.toBeNull();

    // Trying to use token2 now must also fail
    const subsequentRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token2 }),
    });
    expect(subsequentRes.status).toBe(401);
  });

  // ==========================================================================
  // 12. Logout & Revocation
  // ==========================================================================
  it("Requirement 12: Logout revokes refresh token session and clears cookie", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin_test",
        password: "AdminSecretPassword123!",
      }),
    });
    const loginBody = (await loginRes.json()) as any;
    const tokenToRevoke = loginBody.refreshToken;

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokenToRevoke }),
    });

    expect(logoutRes.status).toBe(200);

    // Refreshing with revoked token must fail
    const tryRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokenToRevoke }),
    });
    expect(tryRefresh.status).toBe(401);
  });

  // ==========================================================================
  // 13. Viewer Ditolak Saat Mengirim Command
  // ==========================================================================
  it("Requirement 13: Viewer role is rejected with 403 when attempting to dispatch any command", async () => {
    const viewerToken = await signAccessToken({
      sub: String(viewerUser.id),
      username: viewerUser.username,
      role: "viewer",
    });

    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "open" },
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Forbidden");
    expect(body.message).toContain("Viewer role is not authorized");
    expect(mockMqttClient.publishedMessages.length).toBe(0);
  });

  // ==========================================================================
  // 14. Operator Dapat Meminta Command yang Diizinkan (Valve & Mode)
  // ==========================================================================
  it("Requirement 14: Operator role can dispatch valve and mode commands", async () => {
    const operatorToken = await signAccessToken({
      sub: String(operatorUser.id),
      username: operatorUser.username,
      role: "operator",
    });

    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "close" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("published");
    expect(body.verificationStatus).toBe("pending_execution");
    expect(mockMqttClient.publishedMessages.length).toBe(1);
    expect(mockMqttClient.publishedMessages[0].topic).toBe("nexgas/nexgas-001/cmd");
  });

  // ==========================================================================
  // 15. Operator Ditolak Saat Melakukan Kalibrasi
  // ==========================================================================
  it("Requirement 15: Operator role is rejected with 403 when attempting calibration or tare commands", async () => {
    const operatorToken = await signAccessToken({
      sub: String(operatorUser.id),
      username: operatorUser.username,
      role: "operator",
    });

    // Tare attempt
    const tareRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { tare: true },
      }),
    });

    expect(tareRes.status).toBe(403);
    const tareBody = (await tareRes.json()) as any;
    expect(tareBody.error).toBe("Forbidden");
    expect(tareBody.message).toContain("calibration or tare commands; Admin role is required");

    // Calibration attempt
    const calRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { cal_ph: { ph: 7.0 } },
      }),
    });

    expect(calRes.status).toBe(403);
    expect(mockMqttClient.publishedMessages.length).toBe(0); // Zero messages published
  });

  // ==========================================================================
  // 16. Admin Dapat Melakukan Kalibrasi
  // ==========================================================================
  it("Requirement 16: Admin role can successfully dispatch tare and calibration commands", async () => {
    const adminToken = await signAccessToken({
      sub: String(adminUser.id),
      username: adminUser.username,
      role: "admin",
    });

    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { cal_ph: { ph: 6.8 } },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockMqttClient.publishedMessages.length).toBe(1);
    expect(JSON.parse(mockMqttClient.publishedMessages[0].message)).toEqual({
      cal_ph: { ph: 6.8 },
    });
  });

  // ==========================================================================
  // 17. Request Tanpa Token Mendapat 401
  // ==========================================================================
  it("Requirement 17: Request without Authorization header returns 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "open" },
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Unauthorized");
    expect(mockMqttClient.publishedMessages.length).toBe(0);
  });

  // ==========================================================================
  // 18. Role Tidak Cukup Mendapat 403
  // ==========================================================================
  it("Requirement 18: Non-admin users are rejected with 403 on admin-only endpoints (/api/config)", async () => {
    const operatorToken = await signAccessToken({
      sub: String(operatorUser.id),
      username: operatorUser.username,
      role: "operator",
    });

    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Forbidden");
  });

  // ==========================================================================
  // 19. Tidak Ada Command Tidak Sah yang Sampai ke MQTT Mock
  // ==========================================================================
  it("Requirement 19: Absolutely no unauthorized or rejected commands reach MQTT mock", async () => {
    mockMqttClient.publishedMessages = [];

    // 1. Unauthenticated attempt
    await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "open" },
      }),
    });

    // 2. Viewer attempt
    const viewerToken = await signAccessToken({
      sub: String(viewerUser.id),
      username: viewerUser.username,
      role: "viewer",
    });
    await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { valve: "close" },
      }),
    });

    // 3. Operator calibration attempt
    const operatorToken = await signAccessToken({
      sub: String(operatorUser.id),
      username: operatorUser.username,
      role: "operator",
    });
    await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        deviceId: "nexgas-001",
        command: { tare: true },
      }),
    });

    expect(mockMqttClient.publishedMessages.length).toBe(0);
  });

  // ==========================================================================
  // 20. Tidak Ada Password atau Token Sensitif dalam Log & Audit Details
  // ==========================================================================
  it("Requirement 20: Passwords, secrets, and auth tokens are sanitized and redacted from logs", async () => {
    const sensitivePayload = {
      username: "admin_test",
      password: "SuperSecretPassword123",
      accessToken: "eyJhbGciOiJIUzI1NiJ9.secretToken",
      refreshToken: "a9f87c2b3d4e5f6a",
      jwt_secret: "my-long-jwt-secret-string",
      safeField: "safe-data",
    };

    const sanitized = sanitize(sensitivePayload);
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.accessToken).toBe("[REDACTED]");
    expect(sanitized.refreshToken).toBe("[REDACTED]");
    expect(sanitized.jwt_secret).toBe("[REDACTED]");
    expect(sanitized.safeField).toBe("safe-data");

    // Verify audit logs table in DB has no plain passwords
    const logs = auditRepo.getLogs(10, 0);
    for (const log of logs.items) {
      if (log.details) {
        expect(log.details).not.toContain("AdminSecretPassword123!");
        expect(log.details).not.toContain("OperatorSecretPassword123!");
      }
    }
  });
});
