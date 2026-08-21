import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { session, userAccount, type Database } from '@leoos/db';
import { generateToken, hashToken } from '../../lib/tokens.js';
import type { AppConfig } from '../../config.js';

/**
 * Session lifecycle (ADR-0004).
 *
 * Opaque, server-side, instantly revocable. When someone is fired or an account
 * is compromised, access must end NOW — a stateless token cannot be withdrawn.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface IssuedSession extends SessionRecord {
  /** Returned once, set as a cookie, never persisted. */
  token: string;
}

export type RevokeReason =
  | 'logout' | 'admin' | 'password_change' | 'privilege_change' | 'expired';

export function idleExpiry(config: AppConfig, from = new Date()): Date {
  return new Date(from.getTime() + config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
}

function absoluteExpiry(config: AppConfig, from = new Date()): Date {
  return new Date(from.getTime() + config.SESSION_ABSOLUTE_TIMEOUT_MINUTES * 60_000);
}

/**
 * Issues a new session.
 *
 * Always called on a FRESH row — never by updating an existing one. Rotating the
 * identifier on login is what defeats session fixation: a token an attacker
 * planted before authentication is not the token that ends up authenticated.
 */
export async function issueSession(
  db: Database,
  config: AppConfig,
  input: { userId: string; ip?: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const { token, hash } = generateToken();
  const now = new Date();

  // Sliding window capped by an absolute lifetime: whichever comes first.
  const expiresAt = new Date(
    Math.min(idleExpiry(config, now).getTime(), absoluteExpiry(config, now).getTime()),
  );

  const [row] = await db
    .insert(session)
    .values({
      userId: input.userId,
      tokenHash: hash,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    })
    .returning();

  if (!row) throw new Error('failed to issue session');
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt, token };
}

/**
 * Resolves a raw token to a live session, or null.
 *
 * Never distinguishes "unknown token" from "expired" from "revoked" in its
 * return value — all three mean "not authenticated", and telling them apart
 * would leak whether a token was ever valid.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<SessionRecord | null> {
  const hash = hashToken(token);
  const rows = await db
    .select({
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      revokedAt: session.revokedAt,
      accountStatus: userAccount.status,
      passwordChangedAt: userAccount.passwordChangedAt,
      sessionCreatedAt: session.createdAt,
    })
    .from(session)
    .innerJoin(userAccount, eq(userAccount.id, session.userId))
    .where(eq(session.tokenHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  // A password change invalidates every session issued before it, including
  // ones that were not explicitly revoked (e.g. a revoke that raced a commit).
  if (row.passwordChangedAt.getTime() > row.sessionCreatedAt.getTime()) return null;

  // Suspended and disabled accounts cannot hold a live session.
  if (row.accountStatus !== 'active') return null;

  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt };
}

/**
 * Is this session still usable, by id?
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM `resolveSession`
 *
 * `resolveSession` starts from a raw token, which is what an HTTP request
 * carries. A LIVE WEBSOCKET does not: it authenticated once, with a single-use
 * ticket, and holds only the session id from then on. Without a by-id check
 * there was nothing on the socket path that noticed a logout, a revocation, an
 * expiry, a password change or an account being disabled — so a fired
 * operator's socket kept streaming live officer positions and panic alerts
 * until the process restarted.
 *
 * The RULES ARE THE SAME as `resolveSession`'s, deliberately and in the same
 * order, so the two answers cannot drift: revoked, expired, superseded by a
 * password change, or attached to an account that is no longer active.
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function isSessionLive(db: Database, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      sessionCreatedAt: session.createdAt,
      accountStatus: userAccount.status,
      passwordChangedAt: userAccount.passwordChangedAt,
    })
    .from(session)
    .innerJoin(userAccount, eq(userAccount.id, session.userId))
    .where(eq(session.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return false;
  if (row.revokedAt !== null) return false;
  if (row.expiresAt.getTime() <= Date.now()) return false;
  if (row.passwordChangedAt.getTime() > row.sessionCreatedAt.getTime()) return false;
  if (row.accountStatus !== 'active') return false;
  return true;
}

/**
 * Extends the sliding window.
 *
 * Throttled to once a minute: without that, a dispatcher's open map tab writes
 * to this row on every poll for an entire shift.
 */
export async function touchSession(
  db: Database,
  config: AppConfig,
  record: SessionRecord,
): Promise<void> {
  const now = Date.now();
  if (now - record.lastSeenAt.getTime() < 60_000) return;

  await db
    .update(session)
    .set({ lastSeenAt: new Date(now), expiresAt: idleExpiry(config, new Date(now)) })
    .where(and(eq(session.id, record.id), isNull(session.revokedAt)));
}

export async function revokeSession(
  db: Database,
  sessionId: string,
  reason: RevokeReason,
): Promise<void> {
  await db
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
}

/** Revokes every session for a user, optionally sparing the current one. */
export async function revokeAllSessions(
  db: Database,
  userId: string,
  reason: RevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await db
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        eq(session.userId, userId),
        isNull(session.revokedAt),
        exceptSessionId ? ne(session.id, exceptSessionId) : undefined,
      ),
    )
    .returning({ id: session.id });
  return rows.length;
}

export async function listSessions(db: Database, userId: string) {
  return db
    .select({
      id: session.id,
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
    .orderBy(sql`${session.lastSeenAt} DESC`);
}

/** Retention: expired sessions carry no value and are hard-deleted. */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const rows = await db
    .delete(session)
    .where(or(lt(session.expiresAt, new Date()), sql`${session.revokedAt} < now() - interval '30 days'`))
    .returning({ id: session.id });
  return rows.length;
}
