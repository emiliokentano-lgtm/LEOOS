import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  canEditOrganization, canManageOrganizationLead, canViewOrganizationSection,
} from '@leoos/authz-core';
import { NotFoundError } from '../../lib/errors.js';
import { toActorContext } from '../auth/context.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  archiveOrganization, createOrganization, getOrganization, getOrganizationStats,
  listOrganizationLeads, listOrganizations, updateOrganization,
} from './organization.service.js';
import {
  grantOrganizationLead, listLeadCandidates, revokeOrganizationLead,
} from './lead.service.js';
import {
  toLeadDto, toOrganizationDto, type OrganizationDetailDto,
} from './organization.dto.js';
import {
  listOrganizationMembers, listOrganizationUnits, listOrganizationVehicles,
} from './organization.read.js';

/**
 * Organization routes.
 *
 * ORGANIZATION SCOPE COMES FROM THE PATH, NEVER FROM THE BODY.
 *
 * Every route below takes `:organizationId` in the URL and resolves the actor's
 * authority over THAT organization from the database. There is no
 * `organizationId` field in any request body, so there is nothing for a client
 * to rewrite — a PD lead who edits the path to an MD id is refused because their
 * lead grant and membership are looked up fresh for the organization they named
 * (engineering rule 11).
 */

const categoryEnum = z.enum([
  'law_enforcement', 'medical', 'federal', 'military', 'civil_service', 'other',
]);

const createSchema = z.object({
  key: z.string().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/,
    'Key may contain letters, numbers, underscores and hyphens.'),
  name: z.string().min(2).max(120),
  shortName: z.string().min(1).max(24),
  description: z.string().max(500).optional(),
  category: categoryEnum,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  shortName: z.string().min(1).max(24).optional(),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  category: categoryEnum.optional(),
  isActive: z.boolean().optional(),
  /**
   * Operational toggles only, and an explicit allow-list rather than a free
   * object: settings are readable by everyone who can read the organization, so
   * an open bag would invite storing something that should not be there.
   */
  settings: z.object({
    shareOnPublicMap: z.boolean().optional(),
    allowSelfDispatch: z.boolean().optional(),
    requireCallsignOnDuty: z.boolean().optional(),
    panicNotifiesAllOrganizations: z.boolean().optional(),
  }).optional(),
});

const idParam = z.object({ organizationId: z.uuid() });
const leadParams = z.object({ organizationId: z.uuid(), userId: z.uuid() });
const grantSchema = z.object({ userId: z.uuid(), reason: z.string().max(280).optional() });
const revokeSchema = z.object({ reason: z.string().max(280).optional() });
const archiveSchema = z.object({ reason: z.string().min(3).max(280) });

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function organizationRoutes(app: FastifyInstance): Promise<void> {
  // Everything here requires a session. Authorization is per-route below.
  app.addHook('onRequest', app.requireSession);

  // ── List ─────────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const actor = app.actorContext(request);
    const includeArchived = (request.query as { includeArchived?: string })?.includeArchived === 'true';
    const rows = await listOrganizations(app.db, actor, { includeArchived });
    return reply.send({ organizations: rows.map(toOrganizationDto) });
  });

  // ── Create (global admin) ────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const created = await createOrganization(
      app.db, request.auth!.userId, body, meta(request),
    );
    return reply.status(201).send({ organization: toOrganizationDto(created) });
  });

  // ── Detail ───────────────────────────────────────────────────────────────
  app.get('/:organizationId', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);

    // Throws NOT_FOUND rather than FORBIDDEN when out of scope, so the endpoint
    // cannot be used to discover which organizations exist.
    const org = await getOrganization(app.db, actor, organizationId);
    const [stats, leads] = await Promise.all([
      getOrganizationStats(app.db, organizationId),
      listOrganizationLeads(app.db, actor, organizationId).catch(() => []),
    ]);

    const detail: OrganizationDetailDto = {
      organization: toOrganizationDto(org),
      stats,
      leads: leads.map(toLeadDto),
      capabilities: {
        canEdit: canEditOrganization(actor, organizationId).allowed,
        canManageLeads: canManageOrganizationLead(actor).allowed,
        canViewPersonnel: canViewOrganizationSection(actor, organizationId, 'personnel.view').allowed,
        canViewRoles: canViewOrganizationSection(actor, organizationId, 'roles.view').allowed,
        canViewVehicles: canViewOrganizationSection(actor, organizationId, 'vehicles.view').allowed,
      },
    };
    return reply.send(detail);
  });

  // ── Update ───────────────────────────────────────────────────────────────
  app.patch('/:organizationId', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);
    const updated = await updateOrganization(
      app.db, request.auth!.userId, organizationId, body, meta(request),
    );
    return reply.send({ organization: toOrganizationDto(updated) });
  });

  // ── Archive ──────────────────────────────────────────────────────────────
  app.delete('/:organizationId', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const { reason } = archiveSchema.parse(request.body ?? {});
    await archiveOrganization(app.db, request.auth!.userId, organizationId, reason, meta(request));
    return reply.send({ archived: true });
  });

  // ── Organization leads ───────────────────────────────────────────────────
  app.get('/:organizationId/leads', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);
    // Reading the detail first scopes the request: out of scope 404s here too.
    await getOrganization(app.db, actor, organizationId);
    const leads = await listOrganizationLeads(app.db, actor, organizationId);
    return reply.send({ leads: leads.map(toLeadDto) });
  });

  app.get('/:organizationId/lead-candidates', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);
    // Only whoever may actually grant the capability may enumerate candidates.
    const decision = canManageOrganizationLead(actor);
    if (!decision.allowed) throw new NotFoundError('organization');
    const candidates = await listLeadCandidates(app.db, organizationId);
    return reply.send({ candidates });
  });

  app.post('/:organizationId/leads', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const body = grantSchema.parse(request.body);
    const result = await grantOrganizationLead(
      app.db, request.auth!.userId,
      { organizationId, userId: body.userId, reason: body.reason },
      meta(request),
    );
    return reply.status(201).send({
      granted: true,
      userId: result.userId,
      organizationId: result.organizationId,
      grantedAt: result.grantedAt.toISOString(),
    });
  });

  app.delete('/:organizationId/leads/:userId', async (request, reply) => {
    const { organizationId, userId } = leadParams.parse(request.params);
    const body = revokeSchema.parse(request.body ?? {});
    await revokeOrganizationLead(
      app.db, request.auth!.userId,
      { organizationId, userId, reason: body.reason },
      meta(request),
    );
    return reply.send({ revoked: true });
  });

  // ── Scoped sections for the organization admin screen ─────────────────────
  // Each is authorized independently, so a partial permission set yields a
  // partial page rather than a blanket refusal.

  app.get('/:organizationId/members', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);
    const decision = canViewOrganizationSection(actor, organizationId, 'personnel.view');
    if (!decision.allowed) throw new NotFoundError('organization members');
    return reply.send({ members: await listOrganizationMembers(app.db, organizationId) });
  });

  // Roles are served by the roles module at this same path — see
  // `modules/roles/role.routes.ts`. Its response is a superset of what this
  // handler returned (the same fields plus per-role capabilities and the
  // permission set), so the organization screen reads it unchanged.

  app.get('/:organizationId/units', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);
    const decision = canViewOrganizationSection(actor, organizationId, 'dispatch.view');
    if (!decision.allowed) throw new NotFoundError('organization units');
    return reply.send({ units: await listOrganizationUnits(app.db, organizationId) });
  });

  app.get('/:organizationId/vehicles', async (request, reply) => {
    const { organizationId } = idParam.parse(request.params);
    const actor = app.actorContext(request);
    const decision = canViewOrganizationSection(actor, organizationId, 'vehicles.view');
    if (!decision.allowed) throw new NotFoundError('organization vehicles');
    return reply.send({ vehicles: await listOrganizationVehicles(app.db, organizationId) });
  });
}

export { toActorContext };
