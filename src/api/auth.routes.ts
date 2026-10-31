import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { getRepositories } from "../db/index.js";
import { config } from "../config/index.js";
import { verifyPassword, generateSecureToken, hashToken } from "../utils/crypto.js";
import { signAccessToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required"),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().optional(),
});

interface LoginRateLimitRecord {
  timestamps: number[];
}

const loginAttempts = new Map<string, LoginRateLimitRecord>();

// Clean up stale login rate limits every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    record.timestamps = record.timestamps.filter(
      (ts) => now - ts < config.RATE_LIMIT_LOGIN_WINDOW_MS,
    );
    if (record.timestamps.length === 0) {
      loginAttempts.delete(key);
    }
  }
}, 120000).unref();

export function loginRateLimiter(req: Request, res: Response, next: () => void): void {
  const clientKey = req.ip || req.socket.remoteAddress || "global";
  const now = Date.now();

  let record = loginAttempts.get(clientKey);
  if (!record) {
    record = { timestamps: [] };
    loginAttempts.set(clientKey, record);
  }

  record.timestamps = record.timestamps.filter(
    (ts) => now - ts < config.RATE_LIMIT_LOGIN_WINDOW_MS,
  );

  if (record.timestamps.length >= config.RATE_LIMIT_LOGIN_MAX) {
    logger.warn(`Login rate limit exceeded for client IP: ${clientKey}`);
    res.status(429).json({
      error: "Too Many Requests",
      message: `Too many login attempts. Please wait ${Math.ceil(config.RATE_LIMIT_LOGIN_WINDOW_MS / 1000)} seconds before trying again.`,
    });
    return;
  }

  record.timestamps.push(now);
  next();
}

export function resetLoginRateLimits(): void {
  loginAttempts.clear();
}

export function createAuthRouter(): Router {
  const router = Router();
  const repos = getRepositories();

  // --------------------------------------------------------------------------
  // POST /api/auth/login
  // --------------------------------------------------------------------------
  router.post("/login", loginRateLimiter, async (req: Request, res: Response) => {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Bad Request",
        message: "Invalid login credentials structure",
        details: parseResult.error.format(),
      });
      return;
    }

    const { username, password } = parseResult.data;
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    const userWithPw = await repos.user.findByUsername(username);

    // Constant-time mitigation against user enumeration / timing attacks:
    // If user does not exist, run a dummy Argon2id verification with a valid hash
    if (!userWithPw) {
      await verifyPassword(
        "$argon2id$v=19$m=19456,t=2,p=1$7438493829482938492839$abcdefghijklmnopqrstuvwx",
        password,
      );

      await repos.audit.insert({
        username,
        ipAddress: clientIp,
        action: "auth:login",
        resource: "user",
        details: { reason: "invalid_credentials" },
        status: "failed",
      });

      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
      return;
    }

    if (!userWithPw.isActive) {
      await repos.audit.insert({
        userId: userWithPw.id,
        username: userWithPw.username,
        ipAddress: clientIp,
        action: "auth:login",
        resource: "user",
        details: { reason: "account_inactive" },
        status: "failed",
      });

      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
      return;
    }

    const isMatch = await verifyPassword(userWithPw.passwordHash, password);
    if (!isMatch) {
      await repos.audit.insert({
        userId: userWithPw.id,
        username: userWithPw.username,
        ipAddress: clientIp,
        action: "auth:login",
        resource: "user",
        details: { reason: "invalid_credentials" },
        status: "failed",
      });

      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
      return;
    }

    // 1. Generate access token
    const accessToken = await signAccessToken({
      sub: String(userWithPw.id),
      username: userWithPw.username,
      role: userWithPw.role,
    });

    // 2. Generate refresh token & session
    const rawRefreshToken = generateSecureToken(32);
    const refreshTokenHash = hashToken(rawRefreshToken);
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + config.JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    await repos.refreshSession.createSession({
      userId: userWithPw.id,
      tokenHash: refreshTokenHash,
      familyId,
      expiresAt,
    });

    // 3. Set secure HttpOnly cookie
    res.cookie("refreshToken", rawRefreshToken, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
      domain: config.COOKIE_DOMAIN,
      path: "/api/auth",
      maxAge: config.JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    });

    // 4. Record audit log
    await repos.audit.insert({
      userId: userWithPw.id,
      username: userWithPw.username,
      ipAddress: clientIp,
      action: "auth:login",
      resource: "user",
      details: { role: userWithPw.role },
      status: "success",
    });

    res.status(200).json({
      status: "success",
      user: {
        id: userWithPw.id,
        username: userWithPw.username,
        role: userWithPw.role,
      },
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 900, // 15 minutes in seconds
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/auth/refresh
  // --------------------------------------------------------------------------
  router.post("/refresh", async (req: Request, res: Response) => {
    const bodyResult = refreshBodySchema.safeParse(req.body);
    const rawRefreshToken =
      req.cookies?.refreshToken ||
      (bodyResult.success ? bodyResult.data.refreshToken : undefined);

    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    if (!rawRefreshToken || typeof rawRefreshToken !== "string") {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing refresh token",
      });
      return;
    }

    const tokenHash = hashToken(rawRefreshToken);
    const session = await repos.refreshSession.findByTokenHash(tokenHash);

    if (!session) {
      await repos.audit.insert({
        ipAddress: clientIp,
        action: "auth:refresh",
        resource: "session",
        details: { reason: "session_not_found" },
        status: "failed",
      });

      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid refresh token",
      });
      return;
    }

    // Reuse detection: If token was already revoked or replaced, this is a replay attempt!
    if (session.revokedAt !== null || session.replacedByHash !== null) {
      logger.error("Refresh token reuse detected! Revoking token family.", {
        familyId: session.familyId,
        userId: session.userId,
      });

      await repos.refreshSession.revokeFamily(session.familyId);

      await repos.audit.insert({
        userId: session.userId,
        ipAddress: clientIp,
        action: "auth:token_reuse",
        resource: "session",
        details: { familyId: session.familyId },
        status: "rejected",
      });

      res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: config.COOKIE_SAME_SITE,
        domain: config.COOKIE_DOMAIN,
        path: "/api/auth",
      });

      res.status(401).json({
        error: "Unauthorized",
        message: "Refresh token reuse detected; all sessions have been revoked. Please log in again.",
      });
      return;
    }

    // Check expiration
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await repos.refreshSession.revokeSession(tokenHash);
      res.status(401).json({
        error: "Unauthorized",
        message: "Refresh token has expired. Please log in again.",
      });
      return;
    }

    // Verify user is still active
    const user = await repos.user.findById(session.userId);
    if (!user || !user.isActive) {
      await repos.refreshSession.revokeSession(tokenHash);
      res.status(401).json({
        error: "Unauthorized",
        message: "User account is disabled or no longer exists",
      });
      return;
    }

    // Token rotation: Create new refresh token, mark old one as replaced
    const newRawRefreshToken = generateSecureToken(32);
    const newTokenHash = hashToken(newRawRefreshToken);
    const newExpiresAt = new Date(
      Date.now() + config.JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    await repos.refreshSession.revokeSession(tokenHash, newTokenHash);

    await repos.refreshSession.createSession({
      userId: user.id,
      tokenHash: newTokenHash,
      familyId: session.familyId,
      expiresAt: newExpiresAt,
    });

    const newAccessToken = await signAccessToken({
      sub: String(user.id),
      username: user.username,
      role: user.role,
    });

    res.cookie("refreshToken", newRawRefreshToken, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
      domain: config.COOKIE_DOMAIN,
      path: "/api/auth",
      maxAge: config.JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    });

    await repos.audit.insert({
      userId: user.id,
      username: user.username,
      ipAddress: clientIp,
      action: "auth:refresh",
      resource: "session",
      details: { familyId: session.familyId },
      status: "success",
    });

    res.status(200).json({
      status: "success",
      accessToken: newAccessToken,
      refreshToken: newRawRefreshToken,
      expiresIn: 900,
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/auth/logout
  // --------------------------------------------------------------------------
  router.post("/logout", async (req: Request, res: Response) => {
    const rawRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    if (rawRefreshToken && typeof rawRefreshToken === "string") {
      const tokenHash = hashToken(rawRefreshToken);
      await repos.refreshSession.revokeSession(tokenHash);
    }

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
      domain: config.COOKIE_DOMAIN,
      path: "/api/auth",
    });

    await repos.audit.insert({
      userId: req.user?.id ?? null,
      username: req.user?.username ?? null,
      ipAddress: clientIp,
      action: "auth:logout",
      resource: "session",
      details: null,
      status: "success",
    });

    res.status(200).json({
      status: "success",
      message: "Logged out successfully",
    });
  });

  return router;
}
