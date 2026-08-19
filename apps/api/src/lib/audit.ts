import { sql } from 'drizzle-orm';
import { auditLog, type Database } from '@leoos/db';
import type { AuditAction } from '@leoos/db';

/**
 * The single audit write path.
 *
 * Every security-sensitive operation goes through this helper, and it takes a
 * transaction handle rather than a database — the audit row is written INSIDE
 * the transaction that performs the change, so a rolled-back change leaves no
 * audit row and a committed change always leaves one (engineering rule 23).
 *
 * Denied attempts are recorded too. A user repeatedly trying to promote above
 * their rank is exactly the signal an operations lead needs to see.
 */
export interface AuditEntry {
  action: AuditAction;
  actorType?: 'user' | 'system' | 'game_server' | 'job';
  actorUserId?: string | null;
  actorLabel?: string | null;
  organizationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Keys that must never reach an audit row, however they were passed in. */
const REDACTED_KEYS = new Set([
  'password', 'newPassword', 'currentPassword', 'passwordHash', 'password_hash',
  'token', 'tokenHash', 'token_hash', 'secret', 'secretHash', 'secret_hash',
  'totpSecret', 'totp_secret_enc', 'authorization', 'cookie',
]);

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(val);
  }
  return out as T;
}

export async function writeAudit(tx: Database, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    action: entry.action,
    actorType: entry.actorType ?? 'user',
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel ?? null,
    organizationId: entry.organizationId ?? null,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    outcome: entry.outcome ?? 'success',
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    metadata: redact(entry.metadata ?? {}),
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId ?? null,
  });
}

/** Convenience for the common "this was refused" case. */
export function deniedEntry(entry: AuditEntry): AuditEntry {
  return { ...entry, outcome: 'denied' };
}

export const auditSql = sql;

/**
 * Records a refused attempt.
 *
 * MUST be called on the pool, never on the transaction that was rolled back.
 * Writing a denial audit inside the failing transaction is self-defeating: the
 * rollback takes the audit row with it, and the refusal leaves no trace — which
 * is precisely the case an operations lead most needs to see.
 */
export async function auditDenied(db: Database, entry: AuditEntry): Promise<void> {
  await writeAudit(db, { ...entry, outcome: 'denied' });
}

/**
 * Runs a mutation and records a denial if authorization refuses it.
 *
 * The audit write happens after the transaction has already rolled back, on the
 * pool, so it survives.
 */
export async function withDenialAudit<T>(
  db: Database,
  entry: () => AuditEntry,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const isForbidden =
      typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code: unknown }).code === 'FORBIDDEN';
    if (isForbidden) {
      const detail = (error as { detail?: { reason?: string } }).detail;
      const base = entry();
      await auditDenied(db, {
        ...base,
        metadata: { ...(base.metadata ?? {}), reason: detail?.reason ?? 'FORBIDDEN' },
      }).catch(() => {
        // Never let an audit failure mask the original refusal.
      });
    }
    throw error;
  }
}
