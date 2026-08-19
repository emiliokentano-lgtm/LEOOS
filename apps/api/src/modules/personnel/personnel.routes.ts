import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canViewOrganizationSection, UNBOUNDED_LEVEL } from '@leoos/authz-core';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  getPersonnelProfile, listAssignableRoles, listHireCandidates, listPersonnel,
  memberBelongsToOrganization,
} from './personnel.read.js';
import {
  addMemberRole, changeMemberRank, editMember, hireMember, removeMemberRole,
  terminateMember,
} from './personnel.service.js';
import {
  toPersonnelListItemDto, toPersonnelProfileDto,
  type PersonnelCapabilitiesDto, type ViewerContext,
} from './personnel.dto.js';

/**
 * Personnel routes.
 *
 * ORGANIZATION SCOPE COMES FROM THE PATH, NEVER FROM THE BODY — the prefix is
 * `/api/v1/organizations/:organizationId/personnel`, and no request body below
 * carries an organization id. A PD sergeant who rewrites the path to an MD id is
 * refused because their authority over the organization named in the path is
 * resolved from the database (engineering rule 11).
 *
 * The guards here are COARSE. They decide whether the caller may see the screen
 * at all. Whether they may act on a particular person is decided in
 * `personnel.service.ts`, inside the mutating transaction, with both membership
 * rows locked — a route guard cannot know the target's rank
 * (docs/architecture/02-authorization.md §B.7).
 */

const orgParam = z.object({ organizationId: z.uuid() });
const memberParam = z.object({ organizationId: z.uuid(), memberId: z.uuid() });
const memberRoleParam = z.object({
  organizationId: z.uuid(), memberId: z.uuid(), roleId: z.uuid(),
});

const listQuery = z.object({
  search: z.string().max(120).optional(),
  status: z.enum(['active', 'on_leave', 'suspended', 'terminated', 'all']).optional(),
  roleId: z.uuid().optional(),
  dutyStatus: z.string().max(40).optional(),
  minLevel: z.coerce.number().int().min(0).max(1000).optional(),
  maxLevel: z.coerce.number().int().min(0).max(1000).optional(),
  // Bounded at 200: a client cannot ask for the whole roster in one response.
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const callsignSchema = z.string().trim().min(1).max(16)
  .regex(/^[A-Za-z0-9-]+$/, 'A callsign may contain letters, numbers and hyphens.');

const hireSchema = z.object({
  userId: z.uuid(),
  roleId: z.uuid(),
  callsign: callsignSchema.nullish(),
  employeeNumber: z.string().trim().max(24).nullish(),
  notes: z.string().max(2000).nullish(),
});

const terminateSchema = z.object({ reason: z.string().trim().min(3).max(280) });

const rankSchema = z.object({
  roleId: z.uuid(),
  reason: z.string().trim().max(280).optional(),
});

const assignRoleSchema = z.object({ roleId: z.uuid() });

/**
 * `.nullable()` on every field so a caller can clear one, and `strict()` so an
 * unexpected key is a 400 rather than a silently ignored field — a request that
 * looks like it set something it did not is worse than a refusal.
 */
const editSchema = z.object({
  callsign: callsignSchema.nullable().optional(),
  employeeNumber: z.string().trim().max(24).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'on_leave', 'suspended']).optional(),
}).strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'No changes supplied.' },
);

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function personnelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /**
   * Coarse scope guard, applied to READS AND WRITES ALIKE.
   *
   * Out of scope answers 404, not 403: a 403 on a write would confirm that a
   * member with that id exists in an organization the caller cannot see
   * (docs/architecture/02-authorization.md §B.8). The domain service refuses the
   * same request independently — this only decides which answer leaves the
   * building.
   */
  function requireScope(request: FastifyRequest, organizationId: string): ViewerContext {
    const actor = app.actorContext(request);
    if (!canViewOrganizationSection(actor, organizationId, 'personnel.view').allowed) {
      throw new NotFoundError('personnel');
    }
    return {
      userId: actor.userId,
      level: actor.level,
      isOrgLead: actor.isOrgLead,
      isGlobalAdmin: actor.isGlobalAdmin,
    };
  }

  /**
   * Write guard: the caller must be able to see this organization's personnel
   * AND the member id in the path must genuinely belong to it. A member id from
   * elsewhere presented under this path is 404 — the URL should mean what it
   * says, and a global administrator should not be able to act on MD through
   * PD's path by accident.
   */
  async function requireWriteScope(
    request: FastifyRequest, organizationId: string, memberId: string,
  ): Promise<void> {
    requireScope(request, organizationId);
    if (!(await memberBelongsToOrganization(app.db, organizationId, memberId))) {
      throw new NotFoundError('member');
    }
  }

  // ── Roster ───────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const query = listQuery.parse(request.query ?? {});
    const viewer = requireScope(request, organizationId);
    const actor = app.actorContext(request);

    const page = await listPersonnel(app.db, organizationId, query);

    const capabilities: PersonnelCapabilitiesDto = {
      canHire: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.hire'),
      canFire: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.fire'),
      canPromote: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.promote'),
      canDemote: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.demote'),
      canAssignRoles: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('roles.assign'),
      canEdit: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.edit'),
      canSetCallsign: actor.isGlobalAdmin || actor.isOrgLead || actor.permissions.has('personnel.callsign'),
      actorLevel: actor.level === UNBOUNDED_LEVEL ? 'unbounded' : actor.level,
      actorUserId: actor.userId,
    };

    return reply.send({
      personnel: page.rows.map((row) => toPersonnelListItemDto(row, viewer)),
      total: page.total,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      capabilities,
    });
  });

  // ── Reference data for the dialogs ───────────────────────────────────────
  app.get('/roles', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    requireScope(request, organizationId);
    return reply.send({ roles: await listAssignableRoles(app.db, organizationId) });
  });

  app.get('/candidates', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const search = z.object({ search: z.string().max(120).optional() })
      .parse(request.query ?? {}).search;
    const actor = app.actorContext(request);

    // Only whoever may actually hire may enumerate accounts. This endpoint
    // reads across the whole account table, so the guard is `personnel.hire`
    // rather than `personnel.view`.
    const permitted = actor.isGlobalAdmin
      || (actor.organizationId === organizationId
        && (actor.isOrgLead || actor.permissions.has('personnel.hire')));
    if (!permitted) throw new NotFoundError('hire candidates');

    return reply.send({ candidates: await listHireCandidates(app.db, organizationId, search) });
  });

  // ── Profile ──────────────────────────────────────────────────────────────
  app.get('/:memberId', async (request, reply) => {
    const { organizationId, memberId } = memberParam.parse(request.params);
    const viewer = requireScope(request, organizationId);

    const profile = await getPersonnelProfile(app.db, organizationId, memberId);
    if (!profile) throw new NotFoundError('member');

    return reply.send({ member: toPersonnelProfileDto(profile, viewer) });
  });

  // ── Hire ─────────────────────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const body = hireSchema.parse(request.body);
    requireScope(request, organizationId);

    const result = await hireMember(
      app.db, request.auth!.userId,
      {
        organizationId,
        userId: body.userId,
        roleId: body.roleId,
        callsign: body.callsign ?? null,
        employeeNumber: body.employeeNumber ?? null,
        notes: body.notes ?? null,
      },
      meta(request),
    );
    return reply.status(201).send({ memberId: result.memberId });
  });

  // ── Terminate ────────────────────────────────────────────────────────────
  app.post('/:memberId/termination', async (request, reply) => {
    const { organizationId, memberId } = memberParam.parse(request.params);
    const body = terminateSchema.parse(request.body);
    await requireWriteScope(request, organizationId, memberId);

    await terminateMember(
      app.db, request.auth!.userId, { memberId, reason: body.reason }, meta(request),
    );
    return reply.send({ terminated: true });
  });

  // ── Promote / demote ─────────────────────────────────────────────────────
  // One route, not two: the direction is derived from the levels server-side, so
  // there is no "promote" flag for a client to lie about.
  app.post('/:memberId/rank', async (request, reply) => {
    const { organizationId, memberId } = memberParam.parse(request.params);
    const body = rankSchema.parse(request.body);
    await requireWriteScope(request, organizationId, memberId);

    const result = await changeMemberRank(
      app.db, request.auth!.userId,
      { memberId, roleId: body.roleId, reason: body.reason },
      meta(request),
    );
    return reply.send(result);
  });

  // ── Individual role grants ───────────────────────────────────────────────
  app.post('/:memberId/roles', async (request, reply) => {
    const { organizationId, memberId } = memberParam.parse(request.params);
    const body = assignRoleSchema.parse(request.body);
    await requireWriteScope(request, organizationId, memberId);

    await addMemberRole(
      app.db, request.auth!.userId, { memberId, roleId: body.roleId }, meta(request),
    );
    return reply.status(201).send({ assigned: true });
  });

  app.delete('/:memberId/roles/:roleId', async (request, reply) => {
    const { organizationId, memberId, roleId } = memberRoleParam.parse(request.params);
    await requireWriteScope(request, organizationId, memberId);

    await removeMemberRole(
      app.db, request.auth!.userId, { memberId, roleId }, meta(request),
    );
    return reply.send({ removed: true });
  });

  // ── Edit details / callsign ──────────────────────────────────────────────
  app.patch('/:memberId', async (request, reply) => {
    const { organizationId, memberId } = memberParam.parse(request.params);
    const body = editSchema.parse(request.body);
    await requireWriteScope(request, organizationId, memberId);

    await editMember(app.db, request.auth!.userId, memberId, body, meta(request));
    return reply.send({ updated: true });
  });
}
