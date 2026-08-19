import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque token generation and storage.
 *
 * Session tokens, verification tokens, reset tokens and claim codes all follow
 * the same rule: the raw value is returned to the caller ONCE and only its
 * SHA-256 digest is persisted. A database leak therefore yields no usable
 * tokens (ADR-0004).
 *
 * SHA-256 rather than Argon2 is correct here — these are 256-bit random values,
 * not low-entropy secrets, so there is nothing for an attacker to brute-force
 * and the per-request cost of a slow KDF would buy nothing.
 */

const TOKEN_BYTES = 32; // 256 bits

export interface GeneratedToken {
  /** Returned to the caller once. Never persisted, never logged. */
  token: string;
  /** Persisted. */
  hash: string;
}

export function generateToken(): GeneratedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison, so lookup time cannot confirm a partial match. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Short human-typeable code for in-game identity claiming.
 * Excludes visually ambiguous characters (0/O, 1/I/L) — these are read off a
 * screen and typed into a game console.
 */
const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateClaimCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CLAIM_ALPHABET[bytes[i]! % CLAIM_ALPHABET.length];
  }
  return out;
}

/** CSRF token for the double-submit cookie pair. */
export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}
