import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../../utils/jwt.js";
import { getRepositories } from "../../db/index.js";
import { UserRole } from "../../types/index.js";
import { ValidatedCommand } from "../../validation/command.schema.js";

/**
 * Middleware: Verifies the Bearer JWT access token and loads the active user.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Missing or malformed Authorization header",
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Empty Bearer token provided",
    });
    return;
  }

  try {
    const payload = await verifyAccessToken(token);
    const repos = getRepositories();
    const user = repos.user.findById(Number(payload.sub));

    if (!user || !user.isActive) {
      res.status(401).json({
        error: "Unauthorized",
        message: "User account is disabled or no longer exists",
      });
      return;
    }

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({
      error: "Unauthorized",
      message: (err as Error).message || "Invalid access token",
    });
  }
}

/**
 * Middleware factory: Restricts endpoint access to specific roles.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: "Forbidden",
        message: `Forbidden: role "${req.user.role}" does not have required permissions`,
      });
      return;
    }

    next();
  };
}

/**
 * Granular RBAC enforcement for hardware commands:
 * - viewer: Cannot dispatch any commands.
 * - operator: Can dispatch valve operation and valve mode commands (mode, valve).
 *             Cannot dispatch tare or calibration commands.
 * - admin: Can dispatch all commands including tare and calibration.
 */
export function validateCommandRole(
  command: ValidatedCommand,
  role: UserRole,
): { allowed: boolean; reason?: string } {
  if (role === "admin") {
    return { allowed: true };
  }

  if (role === "viewer") {
    return {
      allowed: false,
      reason: "Viewer role is not authorized to dispatch hardware commands",
    };
  }

  if (role === "operator") {
    if ("mode" in command || "valve" in command) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason:
        "Operator role is not authorized to execute calibration or tare commands; Admin role is required",
    };
  }

  return {
    allowed: false,
    reason: `Unrecognized or unauthorized role: "${role}"`,
  };
}
