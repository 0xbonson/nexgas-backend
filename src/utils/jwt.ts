import * as jose from "jose";
import { config } from "../config/index.js";
import { AuthTokenPayload, UserRole } from "../types/index.js";

const JWT_ISSUER = "nexgas-backend";
const JWT_AUDIENCE = "nexgas-app";

function getJwtSecretKey(): Uint8Array {
  const secret = config.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign a short-lived access token (~15m).
 */
export async function signAccessToken(payload: AuthTokenPayload): Promise<string> {
  const secretKey = getJwtSecretKey();

  return new jose.SignJWT({
    username: payload.username,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.JWT_ACCESS_EXPIRATION)
    .sign(secretKey);
}

/**
 * Verify an access token.
 * Validates algorithm (strictly HS256), signature, issuer, audience, and expiration.
 */
export async function verifyAccessToken(token: string): Promise<AuthTokenPayload> {
  const secretKey = getJwtSecretKey();

  const { payload } = await jose.jwtVerify(token, secretKey, {
    algorithms: ["HS256"],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid JWT: missing subject (sub)");
  }
  if (!payload.username || typeof payload.username !== "string") {
    throw new Error("Invalid JWT: missing username claim");
  }
  if (
    !payload.role ||
    typeof payload.role !== "string" ||
    !["viewer", "operator", "admin"].includes(payload.role)
  ) {
    throw new Error("Invalid JWT: missing or invalid role claim");
  }

  return {
    sub: payload.sub,
    username: payload.username,
    role: payload.role as UserRole,
  };
}
