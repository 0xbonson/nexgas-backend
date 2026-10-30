import * as argon2 from "@node-rs/argon2";
import crypto from "node:crypto";

/**
 * Hash a plain password using Argon2id with OWASP-recommended parameters:
 * Algorithm: Argon2id (algorithm = 2)
 * Memory: 19 MiB (19456 KiB)
 * Iterations / Time Cost: 2
 * Parallelism: 1
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  return argon2.hash(password, {
    algorithm: 2, // Argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verify a plain password against an Argon2id hash.
 * Returns false on failure without throwing.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || !password || typeof hash !== "string" || typeof password !== "string") {
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically strong random hex token.
 */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Compute SHA-256 hash of a token for secure database storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
