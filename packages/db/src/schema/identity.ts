import { relations, sql } from 'drizzle-orm';
import {
  check, index, inet, integer, pgTable, primaryKey, text, timestamp,
  uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  accountStatusEnum, authTokenPurposeEnum, citext, createdAt, gameIdentityProviderEnum,
  globalCapabilityEnum, primaryId, sessionRevokeReasonEnum, timestamps, updatedAt,
} from './_shared';

/**
 * Identity & access.
 *
 * A USER ACCOUNT is an authentication identity. It is deliberately NOT a person
 * and NOT an employment relationship — see ./organization.ts and ./person.ts.
 * Merging them would make ordinary situations unrepresentable: a dispatcher with
 * no in-game character, a wanted criminal with no account.
 */

// ── user_account ───────────────────────────────────────────────────────────

export const userAccount = pgTable(
  'user_account',
  {
    id: primaryId(),

    /** citext — case-insensitive natural key. Enabled in the base migration. */
    email: citext('email').notNull(),
    username: citext('username').notNull(),

    /**
     * Argon2id hash. NEVER leaves the API process (engineering rule 16); the
     * serialization boundary in packages/contracts enforces that structurally.
     */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    status: accountStatusEnum('status').notNull().default('pending_verification'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /** Encrypted at rest with a key from config. Never serialized. */
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),

    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: inet('last_login_ip'),

    /**
     * Bumped whenever anything that could change this user's effective
     * permissions changes. The authorization cache is keyed on it, so
     * invalidation is a key change rather than a delete — race-free
     * (docs/architecture/02-authorization.md §B.6).
     */
    permissionVersion: integer('permission_version').notNull().default(1),

    displayName: text('display_name').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_account_email_key').on(t.email),
    uniqueIndex('user_account_username_key').on(t.username),
    index('user_account_status_idx').on(t.status),
    // An account cannot be active until its email is verified.
    check(
      'user_account_active_requires_verification',
      sql`${t.status} <> 'active' OR ${t.emailVerifiedAt} IS NOT NULL`,
    ),
  ],
);

// ── user_global_role ───────────────────────────────────────────────────────

/**
 * Global capabilities, deliberately in their own table.
 *
 * Keeping these out of organization roles is what makes it structurally
 * impossible for an organization role edit to produce a global privilege
 * (engineering rules 12, 15).
 */
export const userGlobalRole = pgTable(
  'user_global_role',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    capability: globalCapabilityEnum('capability').notNull(),
    grantedBy: uuid('granted_by').references(() => userAccount.id, { onDelete: 'restrict' }),
    grantedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.capability] }),
    index('user_global_role_capability_idx').on(t.capability),
  ],
);

// ── session ────────────────────────────────────────────────────────────────

/**
 * Opaque, server-side, revocable sessions (ADR-0004).
 *
 * Only SHA-256(token) is stored, so a database leak yields no usable sessions.
 */
export const session = pgTable(
  'session',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: sessionRevokeReasonEnum('revoked_reason'),
  },
  (t) => [
    uniqueIndex('session_token_hash_key').on(t.tokenHash),
    // Partial index: the hot path only ever looks up live sessions.
    index('session_user_live_idx').on(t.userId).where(sql`revoked_at IS NULL`),
    index('session_expires_idx').on(t.expiresAt).where(sql`revoked_at IS NULL`),
  ],
);

// ── auth_token ─────────────────────────────────────────────────────────────

/** Verification, password reset and email change share one shape and lifecycle. */
export const authToken = pgTable(
  'auth_token',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    purpose: authTokenPurposeEnum('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Only for `email_change`. */
    newEmail: citext('new_email'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdIp: inet('created_ip'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_token_hash_key').on(t.tokenHash),
    index('auth_token_user_purpose_idx')
      .on(t.userId, t.purpose)
      .where(sql`consumed_at IS NULL`),
    check(
      'auth_token_new_email_only_for_change',
      sql`${t.purpose} = 'email_change' OR ${t.newEmail} IS NULL`,
    ),
  ],
);

// ── game_identity ──────────────────────────────────────────────────────────

/**
 * The bridge between a FiveM player and LEOOS — and the ONLY trusted mapping.
 *
 * The game server reports which identifier is online; organization, rank and
 * callsign always resolve from this database (engineering rules 19, 20).
 */
export const gameIdentity = pgTable(
  'game_identity',
  {
    id: primaryId(),
    provider: gameIdentityProviderEnum('provider').notNull(),
    identifier: text('identifier').notNull(),
    userId: uuid('user_id').references(() => userAccount.id, { onDelete: 'set null' }),
    /** Set by ./person.ts via a deferred FK added in the migration. */
    personId: uuid('person_id'),
    /** Null until the link is proven from both sides by an in-game claim code. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    firstSeenAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('game_identity_provider_identifier_key').on(t.provider, t.identifier),
    index('game_identity_user_idx').on(t.userId),
    index('game_identity_person_idx').on(t.personId),
    check(
      'game_identity_requires_subject',
      sql`${t.userId} IS NOT NULL OR ${t.personId} IS NOT NULL`,
    ),
  ],
);

// ── claim codes for identity linking ───────────────────────────────────────

export const identityClaimCode = pgTable(
  'identity_claim_code',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    code: citext('code').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedIdentity: text('consumed_identity'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('identity_claim_code_key').on(t.code),
    index('identity_claim_user_idx').on(t.userId).where(sql`consumed_at IS NULL`),
  ],
);

// ── relations ──────────────────────────────────────────────────────────────

export const userAccountRelations = relations(userAccount, ({ many }) => ({
  sessions: many(session),
  globalRoles: many(userGlobalRole),
  authTokens: many(authToken),
  gameIdentities: many(gameIdentity),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(userAccount, { fields: [session.userId], references: [userAccount.id] }),
}));

export const userGlobalRoleRelations = relations(userGlobalRole, ({ one }) => ({
  user: one(userAccount, { fields: [userGlobalRole.userId], references: [userAccount.id] }),
}));

export const authTokenRelations = relations(authToken, ({ one }) => ({
  user: one(userAccount, { fields: [authToken.userId], references: [userAccount.id] }),
}));

export const gameIdentityRelations = relations(gameIdentity, ({ one }) => ({
  user: one(userAccount, { fields: [gameIdentity.userId], references: [userAccount.id] }),
}));
