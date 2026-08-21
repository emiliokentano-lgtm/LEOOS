import { and, eq, isNull, sql } from 'drizzle-orm';
import { authToken, userAccount, type Database } from '@leoos/db';
import { AUDIT_ACTIONS } from '@leoos/db';
import type { AppConfig } from '../../config.js';
import {
  AccountStateError, ConflictError, InvalidCredentialsError, ValidationError,
} from '../../lib/errors.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { writeAudit } from '../../lib/audit.js';
import {
  hashPassword, needsRehash, validatePassword, verifyAgainstDummy, verifyPassword,
} from '../../lib/password.js';
import type { MailTransport } from './mail.js';
import { issueSession, revokeAllSessions, type IssuedSession } from './session.service.js';

/**
 * Authentication operations.
 *
 * Every function here writes its audit row in the SAME transaction as the change
 * it makes, and none of them ever returns, logs or throws a password.
 */

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 60;

// ── Registration ───────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface RegisterResult {
  /** Always true — the response is identical whether or not the account is new. */
  accepted: true;
  /** Present only in non-production, so tests and local development can proceed
   *  without reading the console transport. */
  verificationToken?: string;
}

/**
 * Creates an account.
 *
 * NEW ACCOUNTS RECEIVE NOTHING: status `pending_verification`, no organization
 * membership, no role, no global capability. Organization access is granted
 * later by that organization's leadership, which is the only path that exists.
 *
 * The response does not reveal whether the email was already taken. A duplicate
 * is audited and, in a complete deployment, notified to the existing address —
 * that is where "someone tried to register with your email" belongs, not in an
 * HTTP response an attacker can read.
 */
export async function register(
  db: Database,
  config: AppConfig,
  mail: MailTransport,
  input: RegisterInput,
  meta: RequestMeta = {},
): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();

  const policy = validatePassword(input.password, { email, username });
  if (!policy.ok) throw new ValidationError({ password: policy.problems });

  const passwordHash = await hashPassword(input.password, config);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: userAccount.id })
      .from(userAccount)
      .where(sql`${userAccount.email} = ${email} OR ${userAccount.username} = ${username}`)
      .limit(1);

    if (existing.length > 0) {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.USER_CREATED,
        actorType: 'system',
        outcome: 'denied',
        metadata: { reason: 'duplicate_identifier', email },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
      // Same shape, same status, comparable timing as the success path.
      return { accepted: true as const };
    }

    const [account] = await tx
      .insert(userAccount)
      .values({
        email,
        username,
        displayName: input.displayName.trim(),
        passwordHash,
        status: 'pending_verification',
      })
      .returning({ id: userAccount.id });

    if (!account) throw new Error('failed to create account');

    const { token, hash } = generateToken();
    await tx.insert(authToken).values({
      userId: account.id,
      purpose: 'email_verification',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3600_000),
      createdIp: meta.ip ?? null,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.USER_CREATED,
      actorType: 'system',
      actorUserId: account.id,
      actorLabel: username,
      entityType: 'user_account',
      entityId: account.id,
      metadata: { email, selfRegistered: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    await mail.send({
      to: email,
      subject: 'Verify your LEOOS account',
      body:
        `Confirm your address to finish creating your LEOOS account.\n\n` +
        `  /verify?token=${token}\n\n` +
        `This link expires in ${VERIFICATION_TTL_HOURS} hours and can be used once.\n` +
        `Your account will still need an organization membership before you can ` +
        `access operational screens.`,
    });

    return config.NODE_ENV === 'production'
      ? { accepted: true as const }
      : { accepted: true as const, verificationToken: token };
  });
}

// ── Verification ───────────────────────────────────────────────────────────

export async function verifyEmail(
  db: Database,
  token: string,
  meta: RequestMeta = {},
): Promise<{ verified: boolean }> {
  const hash = hashToken(token);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: authToken.id, userId: authToken.userId,
        expiresAt: authToken.expiresAt, consumedAt: authToken.consumedAt,
      })
      .from(authToken)
      .where(and(eq(authToken.tokenHash, hash), eq(authToken.purpose, 'email_verification')))
      .limit(1);

    const record = rows[0];
    if (!record || record.consumedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      return { verified: false };
    }

    // Consumed inside the same transaction that activates the account, so the
    // token cannot be replayed even under concurrent submission.
    await tx.update(authToken).set({ consumedAt: new Date() }).where(eq(authToken.id, record.id));
    await tx
      .update(userAccount)
      .set({ emailVerifiedAt: new Date(), status: 'active' })
      .where(and(eq(userAccount.id, record.userId), eq(userAccount.status, 'pending_verification')));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EMAIL_VERIFIED,
      actorUserId: record.userId,
      entityType: 'user_account',
      entityId: record.userId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { verified: true };
  });
}

// ── Login ──────────────────────────────────────────────────────────────────

export interface LoginResult {
  session: IssuedSession;
  userId: string;
}

/**
 * Authenticates and issues a session.
 *
 * Unknown user, wrong password and locked account all raise the SAME error with
 * the same client message, and the unknown-user path still performs a full
 * Argon2 verification against a dummy hash so response time does not reveal
 * which case occurred.
 *
 * Account STATE (suspended/disabled) is reported distinctly, deliberately: that
 * only happens after correct credentials, so it discloses nothing to someone
 * who does not already hold the password, and "your account is suspended" is
 * information the legitimate user needs.
 */
export async function login(
  db: Database,
  config: AppConfig,
  input: { identifier: string; password: string },
  meta: RequestMeta = {},
): Promise<LoginResult> {
  const identifier = input.identifier.trim();

  const rows = await db
    .select({
      id: userAccount.id,
      username: userAccount.username,
      passwordHash: userAccount.passwordHash,
      status: userAccount.status,
      failedLoginCount: userAccount.failedLoginCount,
      lockedUntil: userAccount.lockedUntil,
    })
    .from(userAccount)
    .where(sql`${userAccount.email} = ${identifier} OR ${userAccount.username} = ${identifier}`)
    .limit(1);

  const account = rows[0];

  if (!account) {
    await verifyAgainstDummy(input.password, config);
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorType: 'system',
        outcome: 'denied',
        metadata: { reason: 'unknown_identifier' },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    });
    throw new InvalidCredentialsError('unknown identifier');
  }

  if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
    await verifyAgainstDummy(input.password, config);
    /**
     * AUDITED, which it was not before.
     *
     * Every other refusal on this path writes a row; this one returned silently,
     * so an attack went DARK at precisely the moment it became interesting. The
     * lockout engages after `LOGIN_MAX_ATTEMPTS`, and everything after that —
     * the hours of continued attempts that distinguish a forgetful user from
     * somebody working through a password list — left no trace at all.
     *
     * The password is not verified against the real hash here, so this row says
     * an attempt was made, not whether it would have succeeded.
     */
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: account.id,
        actorLabel: account.username,
        outcome: 'denied',
        metadata: { reason: 'account_locked', lockedUntil: account.lockedUntil?.toISOString() },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    });
    throw new InvalidCredentialsError('account temporarily locked');
  }

  const passwordOk = await verifyPassword(input.password, account.passwordHash);

  if (!passwordOk) {
    await db.transaction(async (tx) => {
      const nextCount = account.failedLoginCount + 1;
      const shouldLock = nextCount >= config.LOGIN_MAX_ATTEMPTS;
      await tx
        .update(userAccount)
        .set({
          failedLoginCount: nextCount,
          lockedUntil: shouldLock
            ? new Date(Date.now() + config.LOGIN_LOCKOUT_MINUTES * 60_000)
            : null,
        })
        .where(eq(userAccount.id, account.id));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: account.id,
        actorLabel: account.username,
        outcome: 'denied',
        metadata: { reason: 'bad_password', attempt: nextCount, locked: shouldLock },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    });
    throw new InvalidCredentialsError('bad password');
  }

  // Credentials are correct from here on.
  if (account.status !== 'active') {
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: account.id,
        actorLabel: account.username,
        outcome: 'denied',
        metadata: { reason: 'account_status', status: account.status },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    });
    throw new AccountStateError(account.status);
  }

  // Rehash transparently if the cost parameters have been raised since signup.
  if (needsRehash(account.passwordHash, config)) {
    const fresh = await hashPassword(input.password, config);
    await db.update(userAccount).set({ passwordHash: fresh }).where(eq(userAccount.id, account.id));
  }

  const issued = await db.transaction(async (tx) => {
    await tx
      .update(userAccount)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null })
      .where(eq(userAccount.id, account.id));

    // A brand-new row, not an update: rotating the identifier on login is what
    // defeats session fixation.
    const session = await issueSession(tx, config, {
      userId: account.id, ip: meta.ip, userAgent: meta.userAgent,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.LOGIN,
      actorUserId: account.id,
      actorLabel: account.username,
      entityType: 'session',
      entityId: session.id,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return session;
  });

  return { session: issued, userId: account.id };
}

// ── Logout ─────────────────────────────────────────────────────────────────

export async function logout(
  db: Database,
  input: { sessionId: string; userId: string },
  meta: RequestMeta = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE "session" SET revoked_at = now(), revoked_reason = 'logout'
      WHERE id = ${input.sessionId} AND revoked_at IS NULL
    `);
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.LOGOUT,
      actorUserId: input.userId,
      entityType: 'session',
      entityId: input.sessionId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

// ── Password reset ─────────────────────────────────────────────────────────

/**
 * Issues a reset token.
 *
 * ALWAYS returns the same result regardless of whether the account exists —
 * this endpoint is the most direct account-enumeration oracle in any application
 * and must not be one here.
 *
 * Issuing a new token invalidates every prior unconsumed reset token, so a
 * request made because the first mail did not arrive does not leave two live
 * tokens.
 */
export async function requestPasswordReset(
  db: Database,
  config: AppConfig,
  mail: MailTransport,
  email: string,
  meta: RequestMeta = {},
): Promise<{ accepted: true; resetToken?: string }> {
  const normalised = email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: userAccount.id, username: userAccount.username, status: userAccount.status })
      .from(userAccount)
      .where(eq(userAccount.email, normalised))
      .limit(1);

    const account = rows[0];
    if (!account || account.status === 'disabled') {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
        actorType: 'system',
        outcome: 'denied',
        metadata: { reason: account ? 'account_disabled' : 'unknown_email' },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
      return { accepted: true as const };
    }

    await tx
      .update(authToken)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authToken.userId, account.id),
          eq(authToken.purpose, 'password_reset'),
          isNull(authToken.consumedAt),
        ),
      );

    const { token, hash } = generateToken();
    await tx.insert(authToken).values({
      userId: account.id,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      createdIp: meta.ip ?? null,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      actorUserId: account.id,
      actorLabel: account.username,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    await mail.send({
      to: normalised,
      subject: 'Reset your LEOOS password',
      body:
        `A password reset was requested for your LEOOS account.\n\n` +
        `  /reset-password?token=${token}\n\n` +
        `This link expires in ${RESET_TTL_MINUTES} minutes and can be used once.\n` +
        `Setting a new password signs out every other session on this account.\n\n` +
        `If this was not you, no action is needed — the link cannot be used ` +
        `without access to this mailbox.`,
    });

    return config.NODE_ENV === 'production'
      ? { accepted: true as const }
      : { accepted: true as const, resetToken: token };
  });
}

/**
 * Consumes a reset token and sets a new password.
 *
 * Revokes every session for the account: if the reset happened because of a
 * compromise, leaving the attacker's session live would defeat the point.
 */
export async function resetPassword(
  db: Database,
  config: AppConfig,
  input: { token: string; newPassword: string },
  meta: RequestMeta = {},
): Promise<{ reset: boolean }> {
  const hash = hashToken(input.token);

  const rows = await db
    .select({
      id: authToken.id, userId: authToken.userId,
      expiresAt: authToken.expiresAt, consumedAt: authToken.consumedAt,
      email: userAccount.email, username: userAccount.username,
    })
    .from(authToken)
    .innerJoin(userAccount, eq(userAccount.id, authToken.userId))
    .where(and(eq(authToken.tokenHash, hash), eq(authToken.purpose, 'password_reset')))
    .limit(1);

  const record = rows[0];
  if (!record || record.consumedAt !== null || record.expiresAt.getTime() <= Date.now()) {
    return { reset: false };
  }

  const policy = validatePassword(input.newPassword, {
    email: record.email, username: record.username,
  });
  if (!policy.ok) throw new ValidationError({ password: policy.problems });

  const passwordHash = await hashPassword(input.newPassword, config);

  await db.transaction(async (tx) => {
    const consumed = await tx
      .update(authToken)
      .set({ consumedAt: new Date() })
      .where(and(eq(authToken.id, record.id), isNull(authToken.consumedAt)))
      .returning({ id: authToken.id });

    // Lost the race with a concurrent submission of the same token.
    if (consumed.length === 0) throw new ConflictError('TOKEN_CONSUMED', 'This link was already used.');

    await tx
      .update(userAccount)
      .set({ passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(userAccount.id, record.userId));

    await revokeAllSessions(tx, record.userId, 'password_change');

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      actorUserId: record.userId,
      actorLabel: record.username,
      entityType: 'user_account',
      entityId: record.userId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });

  return { reset: true };
}

/** Change password while signed in. Requires the current password. */
export async function changePassword(
  db: Database,
  config: AppConfig,
  input: { userId: string; currentPassword: string; newPassword: string; keepSessionId: string },
  meta: RequestMeta = {},
): Promise<void> {
  const rows = await db
    .select({
      passwordHash: userAccount.passwordHash,
      email: userAccount.email,
      username: userAccount.username,
    })
    .from(userAccount)
    .where(eq(userAccount.id, input.userId))
    .limit(1);

  const account = rows[0];
  if (!account) throw new InvalidCredentialsError('account missing');

  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new InvalidCredentialsError('current password incorrect');
  }

  const policy = validatePassword(input.newPassword, {
    email: account.email, username: account.username,
  });
  if (!policy.ok) throw new ValidationError({ password: policy.problems });

  const passwordHash = await hashPassword(input.newPassword, config);

  await db.transaction(async (tx) => {
    await tx
      .update(userAccount)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(userAccount.id, input.userId));

    // Every OTHER session goes; the one making the change stays signed in.
    await revokeAllSessions(tx, input.userId, 'password_change', input.keepSessionId);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      actorUserId: input.userId,
      actorLabel: account.username,
      entityType: 'user_account',
      entityId: input.userId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}
