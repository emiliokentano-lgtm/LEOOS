import { and, eq } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, userAccount, userGlobalRole, type Database,
} from '@leoos/db';
import {
  canAdministerUsers, canChangeAccountStatus, canGrantGlobalCapability,
  canRevokeGlobalCapability,
} from '@leoos/authz-core';
import type { AccountStatus, GlobalCapabilityKey } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import { bumpPermissionVersion, loadActorContextLocked } from '../auth/context.service.js';
import { revokeAllSessions } from '../auth/session.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { countOtherEnabledGlobalAdmins, countOtherGlobalAdminGrants } from './user.read.js';
import { createNotifications } from '../notifications/notification.service.js';
import { singleRecipient } from '../notifications/recipients.js';

/**
 * ADMINISTRATIVE NOTIFICATIONS ARE WRITTEN, NOT PUSHED.
 *
 * Every action in this file revokes the subject's sessions — that is the point
 * of a status change or a capability change. So the subject has no socket to
 * deliver to, and there is nothing for the route to publish: the row is the
 * whole mechanism. They read it when they sign back in, which is the only moment
 * they could have read it anyway.
 *
 * Only some of these are worth writing at all:
 *
 *   · REINSTATEMENT is. The person can sign in again and should be told why the
 *     last week did not work.
 *   · SUSPENSION and DISABLING are NOT. A disabled account cannot sign in to
 *     read its own notification, so the row would be one nobody will ever see —
 *     and telling somebody they are suspended is a conversation, not a toast.
 *     The audit row is where that fact lives.
 *   · CAPABILITY changes are. The account stays active, and finding out that you
 *     now hold — or no longer hold — an administrative capability by discovering
 *     a screen has appeared or vanished is exactly the confusion worth avoiding.
 */

/**
 * Account administration.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHAPE EVERY MUTATION HERE TAKES
 *
 *   transaction
 *     → load the actor's context UNDER A LOCK
 *     → load the target UNDER A LOCK
 *     → count what the guard needs, inside the same transaction
 *     → decide
 *     → mutate
 *     → revoke sessions / bump the permission version
 *     → audit
 *
 * The counting step is inside the lock for a specific reason. "Is this the last
 * global administrator" is a read-decide-write, and two administrators disabling
 * each other at the same moment would each read one remaining and both succeed,
 * leaving zero. The row lock on the target and the count in the same transaction
 * is what makes the guard hold under concurrency rather than only in a demo.
 *
 * Refusals are audited too, outside the transaction that rolled back. An account
 * administrator repeatedly trying to disable a global administrator is precisely
 * the signal this log exists to surface.
 * ────────────────────────────────────────────────────────────────────────────
 */

async function requireTarget(tx: Database, userId: string) {
  const rows = await tx
    .select({
      id: userAccount.id,
      username: userAccount.username,
      displayName: userAccount.displayName,
      status: userAccount.status,
      emailVerifiedAt: userAccount.emailVerifiedAt,
    })
    .from(userAccount)
    .where(eq(userAccount.id, userId))
    // Locked for the duration: the status we decide against is the status we
    // write over.
    .for('update')
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError('user account');
  return row;
}

async function isGlobalAdmin(tx: Database, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ capability: userGlobalRole.capability })
    .from(userGlobalRole)
    .where(and(
      eq(userGlobalRole.userId, userId),
      eq(userGlobalRole.capability, 'global_admin'),
    ))
    .limit(1);
  return rows.length > 0;
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * The read guard, as a function rather than a route hook.
 *
 * Called by every read endpoint in the module. A hook would be one line
 * shorter and would apply to whatever routes happened to be registered under
 * the prefix later; this applies to the ones that ask for it.
 */
export function assertCanAdministerUsers(actor: Parameters<typeof canAdministerUsers>[0]): void {
  const decision = canAdministerUsers(actor);
  if (!decision.allowed) {
    throw new ForbiddenError(
      'account administration requires a global capability',
      { reason: decision.reason },
      'Account administration is reserved to global administrators.',
    );
  }
}

// ── Account status ─────────────────────────────────────────────────────────

export interface StatusChangeResult {
  userId: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  sessionsRevoked: number;
}

const STATUS_AUDIT_ACTION: Record<AccountStatus, string> = {
  active: AUDIT_ACTIONS.USER_REINSTATED,
  suspended: AUDIT_ACTIONS.USER_SUSPENDED,
  disabled: AUDIT_ACTIONS.USER_DISABLED,
  // Never settable — see SETTABLE_ACCOUNT_STATUSES. Present so the map is total.
  pending_verification: AUDIT_ACTIONS.USER_SUSPENDED,
};

export async function changeAccountStatus(
  db: Database,
  actorUserId: string,
  input: { userId: string; status: AccountStatus; reason?: string },
  meta: RequestMeta = {},
): Promise<StatusChangeResult> {
  return withDenialAudit(
    db,
    () => ({
      action: STATUS_AUDIT_ACTION[input.status] as never,
      actorUserId,
      entityType: 'user_account',
      entityId: input.userId,
      metadata: { requestedStatus: input.status },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const actor = await loadActorContextLocked(tx, actorUserId, null);
      const target = await requireTarget(tx, input.userId);
      const targetIsGlobalAdmin = await isGlobalAdmin(tx, input.userId);

      const decision = canChangeAccountStatus(actor, {
        targetUserId: input.userId,
        targetIsGlobalAdmin,
        currentStatus: target.status as AccountStatus,
        nextStatus: input.status,
        remainingEnabledGlobalAdmins: await countOtherEnabledGlobalAdmins(tx, input.userId),
      });

      if (!decision.allowed) {
        throw new ForbiddenError(
          `account status change refused: ${decision.reason}`,
          { reason: decision.reason },
          messageFor(decision.reason),
        );
      }

      if (target.status === input.status) {
        throw new ConflictError(
          'ALREADY_IN_STATE', `The account is already ${input.status}.`,
        );
      }

      /**
       * Re-activating an unverified account is refused HERE, with a sentence.
       *
       * A database CHECK already forbids it (`user_account_active_requires_
       * verification`), and letting the constraint fire would surface as a 500
       * with a Postgres error string — technically safe, operationally useless.
       * The administrator needs to be told that the person has not verified
       * their email, which is a different problem with a different fix.
       */
      if (input.status === 'active' && target.emailVerifiedAt === null) {
        throw new ValidationError(
          'This account has not verified its email address, so it cannot be activated. '
          + 'The account holder must complete verification first.',
        );
      }

      await tx
        .update(userAccount)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(userAccount.id, input.userId));

      /**
       * Sessions go immediately, and the permission version moves with them.
       *
       * A suspension that leaves the person signed in until their cookie
       * expires is not a suspension. The version bump invalidates the
       * authorization cache for any request already in flight.
       */
      let sessionsRevoked = 0;
      if (input.status !== 'active') {
        sessionsRevoked = await revokeAllSessions(tx, input.userId, 'admin');
      }
      await bumpPermissionVersion(tx, input.userId);

      await writeAudit(tx, {
        action: STATUS_AUDIT_ACTION[input.status] as never,
        actorUserId,
        entityType: 'user_account',
        entityId: input.userId,
        before: { status: target.status },
        after: { status: input.status },
        metadata: {
          username: target.username,
          reason: input.reason ?? null,
          sessionsRevoked,
          targetWasGlobalAdmin: targetIsGlobalAdmin,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      if (input.status === 'active') {
        await createNotifications(tx, singleRecipient(input.userId), {
          type: 'admin.account_status',
          title: 'Your account has been reinstated',
          body: input.reason
            ?? 'An administrator restored access to your account. You can sign in normally.',
          severity: 'info',
          href: '/dashboard',
          entityType: 'user_account',
          entityId: input.userId,
          target: 'dashboard',
          // The REASON is carried; the administrator is not. Who acted is in the
          // audit log, where it belongs — a notification naming the person who
          // suspended you is an invitation to go and argue with them.
          metadata: { previousStatus: target.status, status: input.status },
        });
      }

      return {
        userId: input.userId,
        previousStatus: target.status as AccountStatus,
        status: input.status,
        sessionsRevoked,
      };
    }),
  );
}

// ── Global capabilities ────────────────────────────────────────────────────

export interface CapabilityChangeResult {
  userId: string;
  capability: GlobalCapabilityKey;
  granted: boolean;
  sessionsRevoked: number;
}

export async function grantGlobalCapability(
  db: Database,
  actorUserId: string,
  input: { userId: string; capability: GlobalCapabilityKey; reason?: string },
  meta: RequestMeta = {},
): Promise<CapabilityChangeResult> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.GLOBAL_CAPABILITY_GRANTED,
      actorUserId,
      entityType: 'user_account',
      entityId: input.userId,
      metadata: { capability: input.capability },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const actor = await loadActorContextLocked(tx, actorUserId, null);
      const target = await requireTarget(tx, input.userId);

      const decision = canGrantGlobalCapability(actor, {
        targetUserId: input.userId,
        capability: input.capability,
        remainingGlobalAdmins: await countOtherGlobalAdminGrants(tx, input.userId),
      });
      if (!decision.allowed) {
        throw new ForbiddenError(
          `capability grant refused: ${decision.reason}`,
          { reason: decision.reason },
          messageFor(decision.reason),
        );
      }

      /**
       * A capability on a disabled account is a trap.
       *
       * It grants nothing today — the account cannot sign in — and grants
       * everything the moment somebody re-enables the account without
       * remembering what it carries.
       */
      if (target.status !== 'active') {
        throw new ValidationError(
          `This account is ${target.status}. Capabilities may only be granted to active accounts.`,
        );
      }

      const inserted = await tx
        .insert(userGlobalRole)
        .values({
          userId: input.userId,
          capability: input.capability,
          grantedBy: actorUserId,
        })
        .onConflictDoNothing()
        .returning({ capability: userGlobalRole.capability });

      if (inserted.length === 0) {
        throw new ConflictError(
          'CAPABILITY_ALREADY_HELD',
          `This account already holds ${input.capability}.`,
        );
      }

      /**
       * The holder is signed out.
       *
       * Their authorization context is cached against a permission version, and
       * a capability change is exactly the event the version exists for. Signing
       * them out is the blunt, correct version of invalidation: they sign back
       * in and the new capability is in force from the first request rather than
       * from whenever their cache happened to expire.
       */
      await bumpPermissionVersion(tx, input.userId);
      const sessionsRevoked = await revokeAllSessions(tx, input.userId, 'privilege_change');

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.GLOBAL_CAPABILITY_GRANTED,
        actorUserId,
        entityType: 'user_account',
        entityId: input.userId,
        after: { capability: input.capability },
        metadata: {
          username: target.username,
          capability: input.capability,
          reason: input.reason ?? null,
          sessionsRevoked,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      await createNotifications(tx, singleRecipient(input.userId), {
        type: 'admin.capability_granted',
        title: `You were granted the ${input.capability} capability`,
        body: input.reason
          ?? 'Sign in again for it to take effect. Your current sessions were ended.',
        href: '/admin',
        entityType: 'user_account',
        entityId: input.userId,
        metadata: { capability: input.capability },
      });

      return { userId: input.userId, capability: input.capability, granted: true, sessionsRevoked };
    }),
  );
}

export async function revokeGlobalCapability(
  db: Database,
  actorUserId: string,
  input: { userId: string; capability: GlobalCapabilityKey; reason?: string },
  meta: RequestMeta = {},
): Promise<CapabilityChangeResult> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.GLOBAL_CAPABILITY_REVOKED,
      actorUserId,
      entityType: 'user_account',
      entityId: input.userId,
      metadata: { capability: input.capability },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const actor = await loadActorContextLocked(tx, actorUserId, null);
      const target = await requireTarget(tx, input.userId);

      const decision = canRevokeGlobalCapability(actor, {
        targetUserId: input.userId,
        capability: input.capability,
        remainingGlobalAdmins: await countOtherGlobalAdminGrants(tx, input.userId),
      });
      if (!decision.allowed) {
        throw new ForbiddenError(
          `capability revocation refused: ${decision.reason}`,
          { reason: decision.reason },
          messageFor(decision.reason),
        );
      }

      const removed = await tx
        .delete(userGlobalRole)
        .where(and(
          eq(userGlobalRole.userId, input.userId),
          eq(userGlobalRole.capability, input.capability),
        ))
        .returning({ capability: userGlobalRole.capability });

      if (removed.length === 0) {
        throw new NotFoundError('capability grant');
      }

      await bumpPermissionVersion(tx, input.userId);
      const sessionsRevoked = await revokeAllSessions(tx, input.userId, 'privilege_change');

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.GLOBAL_CAPABILITY_REVOKED,
        actorUserId,
        entityType: 'user_account',
        entityId: input.userId,
        before: { capability: input.capability },
        metadata: {
          username: target.username,
          capability: input.capability,
          reason: input.reason ?? null,
          sessionsRevoked,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      await createNotifications(tx, singleRecipient(input.userId), {
        type: 'admin.capability_revoked',
        title: `The ${input.capability} capability was removed from your account`,
        body: input.reason
          ?? 'Screens that relied on it are no longer available to you.',
        href: '/dashboard',
        entityType: 'user_account',
        entityId: input.userId,
        target: 'dashboard',
        metadata: { capability: input.capability },
      });

      return {
        userId: input.userId, capability: input.capability, granted: false, sessionsRevoked,
      };
    }),
  );
}

/**
 * What the administrator is told.
 *
 * Each of these names a POLICY rather than a resource, so saying it out loud
 * leaks nothing — and a refusal an administrator cannot interpret is a support
 * ticket. "Forbidden" would leave them wondering whether they have the wrong
 * capability or hit a rule.
 */
function messageFor(reason: string): string {
  switch (reason) {
    case 'SELF_ACTION_FORBIDDEN':
      return 'You cannot perform this action on your own account. Ask another '
        + 'global administrator to do it.';
    case 'TARGET_IS_GLOBAL_ADMIN':
      return 'Only a global administrator can change another global administrator’s account.';
    case 'LAST_GLOBAL_ADMIN':
      return 'This is the last global administrator. Grant the capability to somebody '
        + 'else first — nothing inside the application can restore it once it is gone.';
    case 'CAPABILITY_NOT_GRANTABLE':
      return 'Granting global capabilities is reserved to global administrators.';
    default:
      return 'Account administration is reserved to global administrators.';
  }
}
