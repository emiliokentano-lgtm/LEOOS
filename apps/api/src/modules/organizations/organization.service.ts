import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, organization, organizationLead, organizationMember, role,
  unit, userAccount, vehicle, type Database,
} from '@leoos/db';
import {
  canArchiveOrganization, canCreateOrganization, canEditOrganization,
  canViewOrganization, canViewOrganizationLeads,
  type ActorContext, type Decision,
} from '@leoos/authz-core';
import type { OrganizationCategory } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import { loadActorContextLocked } from '../auth/context.service.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * Organization management.
 *
 * THE CENTRAL RULE OF THIS MODULE: the organization an operation applies to is
 * always the one named in the URL path, and the actor's authority over it is
 * re-derived from the database for that specific organization. A PD lead who
 * rewrites a request to target MD is refused — not because the frontend picked
 * PD, but because their membership and lead grant are in PD and the API looks
 * them up fresh (engineering rule 11).
 *
 * Every mutation resolves its actor context INSIDE the transaction with
 * `loadActorContextLocked`, so a lead revocation racing a lead's own request
 * cannot be won by the stale side.
 */

function enforce(decision: Decision, what: string): void {
  if (!decision.allowed) {
    throw new ForbiddenError(`${what}: ${decision.reason}`, {
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface OrganizationSummaryRow {
  id: string;
  key: string;
  name: string;
  shortName: string;
  description: string | null;
  category: OrganizationCategory;
  color: string;
  logoUrl: string | null;
  isActive: boolean;
  settings: Record<string, unknown>;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface OrganizationStats {
  activeMembers: number;
  totalMembers: number;
  roles: number;
  activeUnits: number;
  fleetVehicles: number;
  leads: number;
}

export interface OrganizationLeadRow {
  userId: string;
  displayName: string;
  username: string;
  email: string;
  grantedAt: Date;
  grantedByName: string | null;
}

/**
 * Lists organizations the actor may see.
 *
 * A global admin sees all of them, including archived ones. Everyone else sees
 * only the organizations they belong to — the list is built from membership, so
 * there is no "all organizations" query for a non-admin to reach.
 */
export async function listOrganizations(
  db: Database,
  actor: ActorContext,
  options: { includeArchived?: boolean } = {},
): Promise<OrganizationSummaryRow[]> {
  const isGlobal = actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin');
  const includeArchived = isGlobal && options.includeArchived === true;

  const rows = await db
    .select({
      id: organization.id,
      key: organization.key,
      name: organization.name,
      shortName: organization.shortName,
      description: organization.description,
      category: organization.category,
      color: organization.color,
      logoUrl: organization.logoUrl,
      isActive: organization.isActive,
      settings: organization.settings,
      createdAt: organization.createdAt,
      archivedAt: organization.deletedAt,
    })
    .from(organization)
    .where(
      isGlobal
        ? includeArchived
          ? undefined
          : isNull(organization.deletedAt)
        : and(
            isNull(organization.deletedAt),
            sql`${organization.id} IN (
              SELECT organization_id FROM organization_member WHERE user_id = ${actor.userId}
            )`,
          ),
    )
    .orderBy(organization.name);

  return rows.map((r) => ({
    ...r,
    category: r.category as OrganizationCategory,
    settings: (r.settings ?? {}) as Record<string, unknown>,
  }));
}

export async function getOrganization(
  db: Database,
  actor: ActorContext,
  organizationId: string,
): Promise<OrganizationSummaryRow> {
  const decision = canViewOrganization(actor, organizationId);
  // Out of scope reads as NOT FOUND, never FORBIDDEN — a 403 would confirm the
  // organization exists (docs/architecture/02-authorization.md §B.8).
  if (!decision.allowed) throw new NotFoundError('organization');

  const rows = await db
    .select({
      id: organization.id, key: organization.key, name: organization.name,
      shortName: organization.shortName, description: organization.description,
      category: organization.category, color: organization.color,
      logoUrl: organization.logoUrl, isActive: organization.isActive,
      settings: organization.settings, createdAt: organization.createdAt,
      archivedAt: organization.deletedAt,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError('organization');

  return {
    ...row,
    category: row.category as OrganizationCategory,
    settings: (row.settings ?? {}) as Record<string, unknown>,
  };
}

export async function getOrganizationStats(
  db: Database,
  organizationId: string,
): Promise<OrganizationStats> {
  const [members] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) FILTER (WHERE ${organizationMember.status} = 'active')::int`,
    })
    .from(organizationMember)
    .where(eq(organizationMember.organizationId, organizationId));

  const [roles] = await db
    .select({ total: count() })
    .from(role)
    .where(and(eq(role.organizationId, organizationId), isNull(role.deletedAt)));

  const [units] = await db
    .select({ total: count() })
    .from(unit)
    .where(and(eq(unit.organizationId, organizationId), eq(unit.status, 'active')));

  const [vehicles] = await db
    .select({ total: count() })
    .from(vehicle)
    .where(and(eq(vehicle.ownerOrganizationId, organizationId), isNull(vehicle.deletedAt)));

  const [leads] = await db
    .select({ total: count() })
    .from(organizationLead)
    .where(and(
      eq(organizationLead.organizationId, organizationId),
      isNull(organizationLead.revokedAt),
    ));

  return {
    activeMembers: Number(members?.active ?? 0),
    totalMembers: Number(members?.total ?? 0),
    roles: Number(roles?.total ?? 0),
    activeUnits: Number(units?.total ?? 0),
    fleetVehicles: Number(vehicles?.total ?? 0),
    leads: Number(leads?.total ?? 0),
  };
}

export async function listOrganizationLeads(
  db: Database,
  actor: ActorContext,
  organizationId: string | null,
): Promise<(OrganizationLeadRow & { organizationId: string })[]> {
  enforce(canViewOrganizationLeads(actor, organizationId), 'view organization leads');

  const granter = sql<string | null>`(SELECT display_name FROM user_account g WHERE g.id = ${organizationLead.grantedBy})`;

  return db
    .select({
      organizationId: organizationLead.organizationId,
      userId: organizationLead.userId,
      displayName: userAccount.displayName,
      username: userAccount.username,
      email: userAccount.email,
      grantedAt: organizationLead.grantedAt,
      grantedByName: granter.as('granted_by_name'),
    })
    .from(organizationLead)
    .innerJoin(userAccount, eq(userAccount.id, organizationLead.userId))
    .where(
      and(
        isNull(organizationLead.revokedAt),
        organizationId ? eq(organizationLead.organizationId, organizationId) : undefined,
      ),
    )
    .orderBy(desc(organizationLead.grantedAt));
}

// ── Mutations ──────────────────────────────────────────────────────────────

export interface CreateOrganizationInput {
  key: string;
  name: string;
  shortName: string;
  description?: string;
  category: OrganizationCategory;
  color?: string;
}

/**
 * Creates an organization. Global administrators only.
 *
 * Organizations stay database rows — this is the whole point of the data-driven
 * model (engineering rules 5, 8). A seventh organization needs no code change,
 * and this endpoint is how it gets made.
 */
export async function createOrganization(
  db: Database,
  actorUserId: string,
  input: CreateOrganizationInput,
  meta: RequestMeta = {},
): Promise<OrganizationSummaryRow> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
      actorUserId,
      metadata: { attemptedKey: input.key },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
    const actor = await loadActorContextLocked(tx, actorUserId, null);
    enforce(canCreateOrganization(actor), 'create organization');

    const key = input.key.trim().toUpperCase();
    const existing = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.key, key), isNull(organization.deletedAt)))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError('ORGANIZATION_KEY_TAKEN', `An organization with key ${key} already exists.`);
    }

    const [created] = await tx
      .insert(organization)
      .values({
        key,
        name: input.name.trim(),
        shortName: input.shortName.trim(),
        description: input.description?.trim() ?? null,
        category: input.category,
        color: input.color ?? '#6b7686',
      })
      .returning();

    if (!created) throw new Error('organization insert returned nothing');

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
      actorUserId,
      organizationId: created.id,
      entityType: 'organization',
      entityId: created.id,
      after: { key: created.key, name: created.name, category: created.category },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return {
      ...created,
      category: created.category as OrganizationCategory,
      settings: (created.settings ?? {}) as Record<string, unknown>,
      archivedAt: created.deletedAt,
    };
    }),
  );
}

export interface UpdateOrganizationInput {
  name?: string;
  shortName?: string;
  description?: string | null;
  color?: string;
  logoUrl?: string | null;
  category?: OrganizationCategory;
  settings?: Record<string, unknown>;
  isActive?: boolean;
}

/**
 * Updates an organization.
 *
 * The organization id comes from the PATH. The actor's authority over that
 * specific organization is resolved inside the transaction — this is the point
 * where a cross-organization attempt dies.
 *
 * `category` and `isActive` are restricted to global administrators: category
 * drives cross-organization visibility rules (medical records), and
 * deactivation is an operational decision above a single organization's lead.
 */
export async function updateOrganization(
  db: Database,
  actorUserId: string,
  organizationId: string,
  input: UpdateOrganizationInput,
  meta: RequestMeta = {},
): Promise<OrganizationSummaryRow> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
      actorUserId, organizationId,
      entityType: 'organization', entityId: organizationId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
    const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
    enforce(canEditOrganization(actor, organizationId), 'edit organization');

    const before = await tx
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const current = before[0];
    if (!current || current.deletedAt !== null) throw new NotFoundError('organization');

    const isGlobal = actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin');
    if (!isGlobal && (input.category !== undefined || input.isActive !== undefined)) {
      throw new ForbiddenError('category and activation are global-administrator decisions', {
        reason: 'PERMISSION_NOT_HELD',
        detail: 'admin.organizations',
      });
    }

    const [updated] = await tx
      .update(organization)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.shortName !== undefined ? { shortName: input.shortName.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.settings !== undefined
          ? { settings: { ...(current.settings as object), ...input.settings } }
          : {}),
      })
      .where(eq(organization.id, organizationId))
      .returning();

    if (!updated) throw new NotFoundError('organization');

    await writeAudit(tx, {
      action: input.isActive === false
        ? AUDIT_ACTIONS.ORGANIZATION_ARCHIVED
        : AUDIT_ACTIONS.ORGANIZATION_UPDATED,
      actorUserId,
      organizationId,
      entityType: 'organization',
      entityId: organizationId,
      before: {
        name: current.name, shortName: current.shortName, color: current.color,
        category: current.category, isActive: current.isActive, settings: current.settings,
      },
      after: {
        name: updated.name, shortName: updated.shortName, color: updated.color,
        category: updated.category, isActive: updated.isActive, settings: updated.settings,
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return {
      ...updated,
      category: updated.category as OrganizationCategory,
      settings: (updated.settings ?? {}) as Record<string, unknown>,
      archivedAt: updated.deletedAt,
    };
    }),
  );
}

/**
 * Archives an organization (soft delete, ADR-0008).
 *
 * The database refuses this while active members remain
 * (`organization_archive_empty_check`), so the operational history of a
 * disbanded department cannot be orphaned by a single click.
 */
export async function archiveOrganization(
  db: Database,
  actorUserId: string,
  organizationId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ORGANIZATION_ARCHIVED,
      actorUserId, organizationId,
      entityType: 'organization', entityId: organizationId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
    const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
    enforce(canArchiveOrganization(actor), 'archive organization');

    const rows = await tx
      .select({ key: organization.key, name: organization.name, deletedAt: organization.deletedAt })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const current = rows[0];
    if (!current || current.deletedAt !== null) throw new NotFoundError('organization');

    /**
     * THE ACTIVE-MEMBER RULE IS ANSWERED HERE, NOT ONLY BY THE TRIGGER.
     *
     * `organization_archive_empty_check` refuses to archive an organization that
     * still has active members, and it stays exactly as it is — a rule that
     * matters this much belongs in the database, where no code path can go round
     * it. But a trigger's `RAISE` is a raw Postgres error: it escaped the service
     * unhandled, and an administrator archiving a department that still has staff
     * got a 500 and "Something went wrong." The condition is ordinary, expected
     * and entirely their fault to fix, and the answer told them none of that.
     *
     * So the precondition is CHECKED in the same transaction, under the same
     * lock, and refused as a conflict that names the number of people still to
     * be transferred or terminated. The trigger remains the backstop; this is
     * the message.
     *
     * The count is read inside the transaction rather than before it for the
     * usual reason: a hire committing between a check and an update would
     * otherwise slip past, and the trigger would turn back into a 500.
     */
    const active = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM organization_member
       WHERE organization_id = ${organizationId} AND status = 'active'
    `);
    const activeCount = active[0]?.n ?? 0;
    if (activeCount > 0) {
      throw new ConflictError(
        'ORGANIZATION_HAS_MEMBERS',
        `${current.name} still has ${activeCount} active member(s). `
        + 'Transfer or terminate them before archiving it.',
      );
    }

    await tx
      .update(organization)
      .set({
        deletedAt: new Date(),
        deletedBy: actorUserId,
        deletionReason: reason,
        isActive: false,
      })
      .where(eq(organization.id, organizationId));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ORGANIZATION_ARCHIVED,
      actorUserId, organizationId,
      entityType: 'organization', entityId: organizationId,
      before: { key: current.key, name: current.name, archived: false },
      after: { archived: true },
      metadata: { reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
    }),
  );
}
