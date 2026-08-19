import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, organization, organizationLead, organizationMember, userAccount,
  type Database,
} from '@leoos/db';
import { canManageOrganizationLead } from '@leoos/authz-core';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import { loadActorContextLocked } from '../auth/context.service.js';
import { bumpPermissionVersion } from '../auth/context.service.js';
import { revokeAllSessions } from '../auth/session.service.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * The Organization Lead capability.
 *
 * This is the most privileged operation in the organization module, and it is
 * deliberately the least delegable: GLOBAL ADMINISTRATORS ONLY.
 *
 * A lead cannot appoint another lead. If they could, the capability would be
 * self-propagating and "the global administrator decides who leads an
 * organization" would stop being true after the first grant. That is why the
 * grant lives in its own table rather than as a role or a permission — no amount
 * of role editing inside an organization can reach it (data model §3, ADR
 * reasoning in docs/architecture/02-authorization.md §B.3).
 *
 * Being a lead of PD confers NOTHING in MD, FIB, Army, ICE or Mechanic. The
 * grant is a row keyed on (user, organization); there is no global variant.
 */

export interface GrantLeadResult {
  userId: string;
  organizationId: string;
  grantedAt: Date;
}

/**
 * Grants the capability.
 *
 * Requires an ACTIVE membership in that organization first — enforced by the
 * database trigger `organization_lead_membership_check` as well as here, because
 * a lead who is not a member has authority over an organization they do not
 * belong to, which no screen would ever show correctly.
 */
export async function grantOrganizationLead(
  db: Database,
  actorUserId: string,
  input: { organizationId: string; userId: string; reason?: string },
  meta: RequestMeta = {},
): Promise<GrantLeadResult> {
  // A refused attempt at this is exactly the signal an operations lead needs to
  // see, so it is audited with the same care as a success — and outside the
  // transaction, which has already rolled back by then.
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ORG_LEAD_GRANTED,
      actorUserId,
      organizationId: input.organizationId,
      entityType: 'user_account',
      entityId: input.userId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
    const actor = await loadActorContextLocked(tx, actorUserId, null);
    const decision = canManageOrganizationLead(actor);

    if (!decision.allowed) {
      throw new ForbiddenError(
        'granting Organization Lead is reserved to global administrators',
        { reason: decision.reason },
        // Safe to tell the caller: it names a policy, not a resource.
        'Granting Organization Lead is reserved to global administrators.',
      );
    }

    const orgRows = await tx
      .select({ id: organization.id, key: organization.key, name: organization.name })
      .from(organization)
      .where(and(eq(organization.id, input.organizationId), isNull(organization.deletedAt)))
      .limit(1);
    const org = orgRows[0];
    if (!org) throw new NotFoundError('organization');

    const targetRows = await tx
      .select({ id: userAccount.id, username: userAccount.username, displayName: userAccount.displayName })
      .from(userAccount)
      .where(eq(userAccount.id, input.userId))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw new NotFoundError('user');

    const membership = await tx
      .select({ id: organizationMember.id, status: organizationMember.status })
      .from(organizationMember)
      .where(and(
        eq(organizationMember.userId, input.userId),
        eq(organizationMember.organizationId, input.organizationId),
      ))
      .limit(1);

    if (!membership[0] || membership[0].status !== 'active') {
      throw new ConflictError(
        'LEAD_REQUIRES_MEMBERSHIP',
        `${target.displayName} must be an active member of ${org.name} before being made its lead.`,
      );
    }

    const existing = await tx
      .select({ revokedAt: organizationLead.revokedAt })
      .from(organizationLead)
      .where(and(
        eq(organizationLead.userId, input.userId),
        eq(organizationLead.organizationId, input.organizationId),
      ))
      .limit(1);

    if (existing[0] && existing[0].revokedAt === null) {
      throw new ConflictError('ALREADY_LEAD', `${target.displayName} already leads ${org.name}.`);
    }

    const grantedAt = new Date();

    // Re-granting a previously revoked capability updates the same row, so the
    // (user, organization) pair stays unique and the history stays legible.
    await tx
      .insert(organizationLead)
      .values({
        userId: input.userId,
        organizationId: input.organizationId,
        grantedBy: actorUserId,
        grantedAt,
      })
      .onConflictDoUpdate({
        target: [organizationLead.userId, organizationLead.organizationId],
        set: { grantedBy: actorUserId, grantedAt, revokedAt: null, revokedBy: null },
      });

    // The target's effective permissions just changed enormously. Bumping the
    // version invalidates any cached authorization view of them.
    await bumpPermissionVersion(tx, input.userId);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ORG_LEAD_GRANTED,
      actorUserId,
      organizationId: input.organizationId,
      entityType: 'user_account',
      entityId: input.userId,
      after: { isOrgLead: true, organizationKey: org.key },
      metadata: {
        targetUsername: target.username,
        targetName: target.displayName,
        organizationKey: org.key,
        organizationName: org.name,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { userId: input.userId, organizationId: input.organizationId, grantedAt };
    }),
  );
}

/**
 * Revokes the capability.
 *
 * Also revokes the target's sessions. Removing this much authority and leaving
 * their open tabs running on a cached view of it would leave a window where the
 * capability is gone on paper but still effective in practice.
 */
export async function revokeOrganizationLead(
  db: Database,
  actorUserId: string,
  input: { organizationId: string; userId: string; reason?: string },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ORG_LEAD_REVOKED,
      actorUserId,
      organizationId: input.organizationId,
      entityType: 'user_account',
      entityId: input.userId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
    const actor = await loadActorContextLocked(tx, actorUserId, null);
    const decision = canManageOrganizationLead(actor);

    if (!decision.allowed) {
      throw new ForbiddenError(
        'revoking Organization Lead is reserved to global administrators',
        { reason: decision.reason },
        'Revoking Organization Lead is reserved to global administrators.',
      );
    }

    const rows = await tx
      .select({
        revokedAt: organizationLead.revokedAt,
        grantedAt: organizationLead.grantedAt,
        username: userAccount.username,
        displayName: userAccount.displayName,
        orgKey: organization.key,
      })
      .from(organizationLead)
      .innerJoin(userAccount, eq(userAccount.id, organizationLead.userId))
      .innerJoin(organization, eq(organization.id, organizationLead.organizationId))
      .where(and(
        eq(organizationLead.userId, input.userId),
        eq(organizationLead.organizationId, input.organizationId),
      ))
      .limit(1);

    const current = rows[0];
    if (!current || current.revokedAt !== null) throw new NotFoundError('organization lead grant');

    await tx
      .update(organizationLead)
      .set({ revokedAt: new Date(), revokedBy: actorUserId })
      .where(and(
        eq(organizationLead.userId, input.userId),
        eq(organizationLead.organizationId, input.organizationId),
      ));

    await bumpPermissionVersion(tx, input.userId);
    await revokeAllSessions(tx, input.userId, 'privilege_change');

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ORG_LEAD_REVOKED,
      actorUserId,
      organizationId: input.organizationId,
      entityType: 'user_account',
      entityId: input.userId,
      before: { isOrgLead: true, organizationKey: current.orgKey },
      after: { isOrgLead: false },
      metadata: {
        targetUsername: current.username,
        targetName: current.displayName,
        organizationKey: current.orgKey,
        heldSince: current.grantedAt.toISOString(),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
    }),
  );
}

/** Candidates for the lead capability: active members who do not already hold it. */
export async function listLeadCandidates(
  db: Database,
  organizationId: string,
): Promise<{ userId: string; displayName: string; username: string; roleName: string | null }[]> {
  return db
    .select({
      userId: organizationMember.userId,
      displayName: userAccount.displayName,
      username: userAccount.username,
      roleName: sql<string | null>`(
        SELECT r.name FROM member_role mr
        JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = ${organizationMember.id}
        ORDER BY r.hierarchy_level DESC LIMIT 1
      )`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .where(and(
      eq(organizationMember.organizationId, organizationId),
      eq(organizationMember.status, 'active'),
      sql`NOT EXISTS (
        SELECT 1 FROM organization_lead ol
        WHERE ol.user_id = ${organizationMember.userId}
          AND ol.organization_id = ${organizationId}
          AND ol.revoked_at IS NULL
      )`,
    ))
    .orderBy(userAccount.displayName);
}
