import { hash, verify } from '@node-rs/argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import COMMON_PASSWORDS from './common-passwords.js';

/**
 * Password hashing and validation.
 *
 * Argon2id at the OWASP 2024 baseline. Parameters are encoded in the stored
 * hash, so they can be raised later and existing hashes rehash transparently on
 * next successful login.
 *
 * Nothing in this module ever logs, returns or throws a password.
 */

export function hashPassword(plain: string, config: AppConfig): Promise<string> {
  return hash(plain, {
    // 2 = Argon2id. The numeric literal rather than the `Algorithm` enum: it is
    // an ambient const enum, which cannot be read under `isolatedModules`.
    algorithm: 2,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  });
}

export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    // A malformed hash must read as "wrong password", never as a server error —
    // a 500 here would tell an attacker the account exists but is broken.
    return false;
  }
}

/**
 * A hash to verify against when the account does not exist.
 *
 * Without this, an unknown username returns in ~0 ms while a known one costs a
 * full Argon2 verification, and the difference is a reliable account oracle.
 * Generated once at boot with the live parameters so the cost matches exactly.
 */
let dummyHash: string | null = null;

export async function getDummyHash(config: AppConfig): Promise<string> {
  dummyHash ??= await hashPassword('leoos-timing-equalisation-placeholder', config);
  return dummyHash;
}

/** Burns the same CPU as a real verification, then reports failure. */
export async function verifyAgainstDummy(plain: string, config: AppConfig): Promise<false> {
  await verifyPassword(plain, await getDummyHash(config));
  return false;
}

/**
 * Does this hash need re-hashing because the parameters were raised?
 * Cheap string inspection — the parameters are in the encoded hash.
 */
export function needsRehash(storedHash: string, config: AppConfig): boolean {
  const match = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < config.ARGON2_MEMORY_KIB ||
    Number(t) < config.ARGON2_TIME_COST ||
    Number(p) !== config.ARGON2_PARALLELISM
  );
}

// ── Validation ─────────────────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // bounded so a huge input cannot be a DoS

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Password policy.
 *
 * Length, not composition. Enforced character classes push people toward
 * `Password1!` — predictable, and no stronger than a longer passphrase. What is
 * checked instead is length and whether the password is already known to be
 * compromised.
 */
export function validatePassword(plain: string, context: { email?: string; username?: string } = {}): PasswordCheck {
  const problems: string[] = [];

  if (plain.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (isCompromised(plain)) {
    problems.push('This password appears in known breach lists. Choose a different one.');
  }

  const lowered = plain.toLowerCase();
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (context.username && lowered.includes(context.username.toLowerCase())) {
    problems.push('Password must not contain your username.');
  }
  if (localPart && localPart.length >= 3 && lowered.includes(localPart)) {
    problems.push('Password must not contain your email address.');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Offline compromised-password check.
 *
 * A bundled list rather than a call to an external breach API: this runs on
 * every registration and password change, and a third-party dependency on that
 * path would mean an outage there blocks account recovery here. It also keeps
 * candidate passwords inside the process (engineering rule 16).
 *
 * Comparison is timing-safe on the hash, which costs nothing and avoids leaking
 * list membership through response time.
 */
const COMMON_HASHES = new Set(
  COMMON_PASSWORDS.map((p) => createHash('sha256').update(p).digest('hex')),
);

export function isCompromised(plain: string): boolean {
  const digest = createHash('sha256').update(plain.toLowerCase()).digest();
  for (const known of COMMON_HASHES) {
    const knownBuf = Buffer.from(known, 'hex');
    if (knownBuf.length === digest.length && timingSafeEqual(knownBuf, digest)) return true;
  }
  return false;
}
