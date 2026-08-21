import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adminCapabilities, canAdministerUsers, canManageOrganizationLead, canViewAuditLog,
  canViewPermissionOverview, canViewSystemConfiguration,
  type ActorContext, type Decision,
} from '@leoos/authz-core';
import {
  GLOBAL_CAPABILITY_KEYS, SETTABLE_ACCOUNT_STATUSES,
  type AdminLeadOverview, type AdminUserCapabilities, type AdminUserList,
  type AuditPage, type GlobalCapabilityKey,
} from '@leoos/contracts';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  toAdminLeadEntry, toAdminUserDetail, toAdminUserSummary, toAuditEntry,
  accountStatusCatalogue,
} from './admin.dto.js';
import {
  activeSessionCount, capabilitiesFor, capabilityGrantsFor, findAdminUser,
  listAdminUsers, membershipSummaryFor, membershipsFor,
} from './user.read.js';
import {
  changeAccountStatus, grantGlobalCapability, revokeGlobalCapability,
} from './user.service.js';
import { distinctAuditActions, resolveEntityLabels, searchAuditLog } from './audit.read.js';
import { buildPermissionOverview, listActiveOrganizations, listAllLeads } from './overview.read.js';
import { buildSystemStatus } from './system.read.js';

/**
 * The global administration surface.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY ROUTE IS GATED ON A GLOBAL CAPABILITY, INDIVIDUALLY.
 *
 * There is no blanket `onRequest` guard beyond requiring a session, and that is
 * deliberate. A prefix-wide "must be an administrator" hook is the kind of
 * protection that silently stops matching when somebody adds a route with a
 * slightly different path, and it flattens five capabilities into one — an
 * `audit_viewer` would either reach the account register or be locked out of
 * the log they exist to read.
 *
 * So each handler asks its own question, using the same decision functions the
 * UI's capability block is built from. A screen cannot appear for a caller
 * whose requests would be refused.
 *
 * NOTHING HERE IS REACHABLE BY AN ORGANIZATION LEAD. Their authority is
 * unbounded inside one organization and empty outside it; every check below
 * reads `globalCapabilities`, which no organization operation can write to.
 * ────────────────────────────────────────────────────────────────────────────
 */

const userQuerySchema = z.object({
  search: z.string().max(120).optional(),
  status: z.enum(['pending_verification', 'active', 'suspended', 'disabled']).optional(),
  capability: z.enum(GLOBAL_CAPABILITY_KEYS as [GlobalCapabilityKey, ...GlobalCapabilityKey[]])
    .optional(),
  organizationId: z.uuid().optional(),
  unaffiliated: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const userIdParam = z.object({ userId: z.uuid() });

const statusSchema = z.object({
  status: z.enum(SETTABLE_ACCOUNT_STATUSES as [string, ...string[]]),
  reason: z.string().max(280).optional(),
});

const capabilitySchema = z.object({
  capability: z.enum(GLOBAL_CAPABILITY_KEYS as [GlobalCapabilityKey, ...GlobalCapabilityKey[]]),
  reason: z.string().max(280).optional(),
});

const capabilityParams = z.object({
  userId: z.uuid(),
  capability: z.enum(GLOBAL_CAPABILITY_KEYS as [GlobalCapabilityKey, ...GlobalCapabilityKey[]]),
});

const auditQuerySchema = z.object({
  search: z.string().max(120).optional(),
  actorUserId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  actionPrefix: z.string().max(40).optional(),
  organizationId: z.uuid().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.uuid().optional(),
  outcome: z.enum(['success', 'denied', 'error']).optional(),
  severity: z.enum(['critical', 'high', 'notice', 'info']).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
});

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

/**
 * Refuses with a sentence naming the POLICY, never the resource.
 *
 * "Reserved to global administrators" tells an operator what to do about it and
 * reveals nothing — unlike a message that confirms the account they were
 * probing exists.
 */
function assertAllowed(decision: Decision, message: string): void {
  if (decision.allowed) return;
  throw new ForbiddenError(
    `admin route refused: ${decision.reason}`,
    { reason: decision.reason },
    message,
  );
}

/**
 * What the CALLER may do to one account.
 *
 * The per-target rules (self, last administrator, a user_admin reaching a global
 * admin) are decided at the point of use with the counts in hand; this is the
 * capability half, which is all a UI can honestly show before the attempt.
 */
function userCapabilitiesFor(
  actor: ActorContext,
  target: { id: string; isGlobalAdmin: boolean },
): AdminUserCapabilities {
  const capabilities = adminCapabilities(actor);
  const restrictions: string[] = [];

  const isSelf = target.id === actor.userId;
  if (isSelf) {
    restrictions.push('You cannot change your own account status or capabilities.');
  }
  if (target.isGlobalAdmin && !actor.isGlobalAdmin) {
    restrictions.push('Only a global administrator can change a global administrator’s account.');
  }

  return {
    canChangeStatus: capabilities.canChangeAccountStatus && !isSelf
      && (!target.isGlobalAdmin || actor.isGlobalAdmin),
    canGrantCapabilities: capabilities.canGrantCapabilities && !isSelf,
    restrictions,
  };
}

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  // ── What the caller may reach ────────────────────────────────────────────
  //
  // The panel's navigation is built from this. Computed from the same decision
  // functions the endpoints use, so the menu and the endpoints cannot drift.
  app.get('/capabilities', async (request, reply) => {
    const actor = app.actorContext(request);
    return reply.send({ capabilities: adminCapabilities(actor) });
  });

  // ── Users ────────────────────────────────────────────────────────────────

  app.get('/users', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canAdministerUsers(actor),
      'Account administration is reserved to global administrators.',
    );

    const query = userQuerySchema.parse(request.query ?? {});
    const { rows, total } = await listAdminUsers(app.db, query);
    const ids = rows.map((r) => r.id);
    const [capabilities, memberships] = await Promise.all([
      capabilitiesFor(app.db, ids),
      membershipSummaryFor(app.db, ids),
    ]);

    const body: AdminUserList = {
      users: rows.map((row) => toAdminUserSummary(
        row, capabilities.get(row.id) ?? [], memberships.get(row.id),
      )),
      total,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    };
    return reply.send(body);
  });

  /** The status catalogue as data, so no component hardcodes a label. */
  app.get('/account-statuses', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canAdministerUsers(actor),
      'Account administration is reserved to global administrators.',
    );
    return reply.send({ statuses: accountStatusCatalogue() });
  });

  app.get('/users/:userId', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canAdministerUsers(actor),
      'Account administration is reserved to global administrators.',
    );

    const { userId } = userIdParam.parse(request.params);
    const row = await findAdminUser(app.db, userId);
    if (!row) throw new NotFoundError('user account');

    const [capabilities, memberships, sessions] = await Promise.all([
      capabilityGrantsFor(app.db, userId),
      membershipsFor(app.db, userId),
      activeSessionCount(app.db, userId),
    ]);

    return reply.send({
      user: toAdminUserDetail(row, {
        capabilities,
        memberships,
        activeSessionCount: sessions,
        callerCapabilities: userCapabilitiesFor(actor, {
          id: userId,
          isGlobalAdmin: capabilities.some((c) => c.key === 'global_admin'),
        }),
      }),
    });
  });

  // ── Account status ───────────────────────────────────────────────────────
  //
  // No guard here: the service decides, under a lock, with the administrator
  // count in hand. A check in this handler would be a second opinion formed
  // from stale reads (engineering rule 10).
  app.post('/users/:userId/status', async (request, reply) => {
    const { userId } = userIdParam.parse(request.params);
    const body = statusSchema.parse(request.body);

    const result = await changeAccountStatus(
      app.db,
      request.auth!.userId,
      { userId, status: body.status as never, reason: body.reason },
      meta(request),
    );
    return reply.send(result);
  });

  // ── Global capabilities ──────────────────────────────────────────────────

  app.post('/users/:userId/capabilities', async (request, reply) => {
    const { userId } = userIdParam.parse(request.params);
    const body = capabilitySchema.parse(request.body);

    const result = await grantGlobalCapability(
      app.db,
      request.auth!.userId,
      { userId, capability: body.capability, reason: body.reason },
      meta(request),
    );
    return reply.status(201).send(result);
  });

  app.delete('/users/:userId/capabilities/:capability', async (request, reply) => {
    const { userId, capability } = capabilityParams.parse(request.params);
    const body = z.object({ reason: z.string().max(280).optional() })
      .parse(request.body ?? {});

    const result = await revokeGlobalCapability(
      app.db,
      request.auth!.userId,
      { userId, capability, reason: body.reason },
      meta(request),
    );
    return reply.send(result);
  });

  /** The capability catalogue, so the UI describes each one from one source. */
  app.get('/capability-catalogue', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canAdministerUsers(actor),
      'Account administration is reserved to global administrators.',
    );
    const { GLOBAL_CAPABILITIES } = await import('@leoos/contracts');
    return reply.send({ capabilities: Object.values(GLOBAL_CAPABILITIES) });
  });

  // ── Organization leads, across every organization ────────────────────────

  app.get('/leads', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canManageOrganizationLead(actor),
      'Organization Lead administration is reserved to global administrators.',
    );

    const [leads, organizations] = await Promise.all([
      listAllLeads(app.db),
      listActiveOrganizations(app.db),
    ]);

    const ledOrgIds = new Set(leads.map((l) => l.organizationId));

    const body: AdminLeadOverview = {
      leads: leads.map(toAdminLeadEntry),
      /**
       * The actionable half of this screen.
       *
       * A list of who leads what is a report; the organizations with NOBODY
       * leading them is the thing an administrator has to do something about,
       * and it is invisible in a list of grants.
       */
      organizationsWithoutLead: organizations.filter((o) => !ledOrgIds.has(o.id)),
      canManage: canManageOrganizationLead(actor).allowed,
    };
    return reply.send(body);
  });

  // ── Permission overview ──────────────────────────────────────────────────

  app.get('/permissions', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canViewPermissionOverview(actor),
      'The permission overview is reserved to administrators.',
    );
    return reply.send(await buildPermissionOverview(app.db));
  });

  // ── Audit log ────────────────────────────────────────────────────────────

  app.get('/audit', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canViewAuditLog(actor),
      'The audit log is reserved to global administrators and audit viewers.',
    );

    const query = auditQuerySchema.parse(request.query ?? {});
    const result = await searchAuditLog(app.db, query);
    const labels = await resolveEntityLabels(app.db, result.rows);

    const body: AuditPage = {
      entries: result.rows.map((row) => toAuditEntry(
        row,
        row.entityType && row.entityId
          ? labels.get(`${row.entityType}:${row.entityId}`) ?? null
          : null,
      )),
      nextCursor: result.nextCursor,
      approximateTotal: result.approximateTotal,
      totalIsExact: result.totalIsExact,
    };
    return reply.send(body);
  });

  /** The action vocabulary actually present in this installation's log. */
  app.get('/audit/actions', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canViewAuditLog(actor),
      'The audit log is reserved to global administrators and audit viewers.',
    );
    const [actions, organizations] = await Promise.all([
      distinctAuditActions(app.db),
      listActiveOrganizations(app.db),
    ]);
    return reply.send({ actions, organizations });
  });

  // ── System configuration ─────────────────────────────────────────────────

  app.get('/system', async (request, reply) => {
    const actor = app.actorContext(request);
    assertAllowed(
      canViewSystemConfiguration(actor),
      'System configuration is reserved to global administrators.',
    );

    return reply.send(await buildSystemStatus(
      app.db,
      app.config,
      app.mapSource.status(),
      app.secretBox !== null,
    ));
  });
}
