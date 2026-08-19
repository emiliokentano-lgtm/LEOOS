import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  canViewOrganizationSection, MAX_HIERARCHY_LEVEL, MIN_HIERARCHY_LEVEL,
} from '@leoos/authz-core';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  archivedRoleCount, getRole, listRoleHolders, listRoles,
} from './role.read.js';
import {
  archiveRole, createRole, reorderRoles, restoreRole, setDefaultRole,
  setRolePermissions, updateRole,
} from './role.service.js';
import {
  toPermissionCatalogueDto, toRoleDto, toRoleScreenCapabilitiesDto,
} from './role.dto.js';

/**
 * Role routes.
 *
 * ORGANIZATION SCOPE COMES FROM THE PATH, NEVER FROM THE BODY — the prefix is
 * `/api/v1/organizations/:organizationId/roles`, and no body below carries an
 * organization id. Authority over the organization named in the path is
 * re-derived from the actor's own membership on every request
 * (engineering rule 11).
 *
 * The guards here are COARSE: they decide whether the caller may see the screen.
 * Whether they may act on a particular role — its rank against theirs, the
 * permissions it would confer — is decided in `role.service.ts` inside the
 * mutating transaction, with the role row locked. A route guard cannot know a
 * role's level without reading it, and a read taken before the transaction is a
 * statement about the past.
 */

const orgParam = z.object({ organizationId: z.uuid() });
const roleParam = z.object({ organizationId: z.uuid(), roleId: z.uuid() });

const levelField = z.coerce.number().int().min(MIN_HIERARCHY_LEVEL).max(MAX_HIERARCHY_LEVEL);

const keyField = z.string().trim().min(2).max(40).regex(
  /^[a-z0-9_]+$/,
  'A role key may contain lowercase letters, numbers and underscores.',
);

const colorField = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish();

const createSchema = z.object({
  key: keyField,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
  hierarchyLevel: levelField,
  color: colorField,
  permissions: z.array(z.string().max(64)).max(200).optional(),
}).strict();

/** `.strict()` so an unexpected field is a 400 rather than a silent no-op. */
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  hierarchyLevel: levelField.optional(),
  color: colorField,
}).strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'No changes supplied.' },
);

const permissionsSchema = z.object({
  // The WHOLE desired set. The server diffs it against the locked row and
  // applies the subset rule to the additions it derives, so the client cannot
  // mislabel an addition as something else.
  permissions: z.array(z.string().max(64)).max(200),
}).strict();

const archiveSchema = z.object({ reason: z.string().trim().min(3).max(280) });

const reorderSchema = z.object({
  order: z.array(z.object({
    roleId: z.uuid(),
    hierarchyLevel: levelField,
  })).min(1).max(100),
}).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /**
   * Coarse scope guard, on reads and writes alike.
   *
   * Out of scope answers 404, not 403: a 403 on a write would confirm that a
   * role with that id exists in an organization the caller cannot see.
   */
  function requireScope(request: FastifyRequest, organizationId: string) {
    const actor = app.actorContext(request);
    if (!canViewOrganizationSection(actor, organizationId, 'roles.view').allowed) {
      throw new NotFoundError('roles');
    }
    return actor;
  }

  // ── List ─────────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const includeArchived =
      (request.query as { includeArchived?: string })?.includeArchived === 'true';
    const actor = requireScope(request, organizationId);

    const rows = await listRoles(app.db, organizationId, { includeArchived });

    return reply.send({
      roles: rows.map((row) => toRoleDto(row, actor)),
      archivedCount: await archivedRoleCount(app.db, organizationId),
      capabilities: toRoleScreenCapabilitiesDto(actor),
    });
  });

  // ── Permission catalogue for the editor ──────────────────────────────────
  app.get('/permissions', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const actor = requireScope(request, organizationId);
    return reply.send(toPermissionCatalogueDto(actor));
  });

  // ── Detail ───────────────────────────────────────────────────────────────
  app.get('/:roleId', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    const actor = requireScope(request, organizationId);

    const row = await getRole(app.db, organizationId, roleId);
    if (!row) throw new NotFoundError('role');

    return reply.send({
      role: toRoleDto(row, actor),
      holders: await listRoleHolders(app.db, organizationId, roleId),
    });
  });

  // ── Create ───────────────────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const body = createSchema.parse(request.body);
    requireScope(request, organizationId);

    const result = await createRole(
      app.db, request.auth!.userId, organizationId,
      {
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        hierarchyLevel: body.hierarchyLevel,
        color: body.color ?? null,
        permissions: body.permissions ?? [],
      },
      meta(request),
    );
    return reply.status(201).send({ roleId: result.roleId });
  });

  // ── Reorder ──────────────────────────────────────────────────────────────
  // Declared before `/:roleId` variants that could otherwise shadow it.
  app.post('/order', async (request, reply) => {
    const { organizationId } = orgParam.parse(request.params);
    const body = reorderSchema.parse(request.body);
    requireScope(request, organizationId);

    const result = await reorderRoles(
      app.db, request.auth!.userId, organizationId, body.order, meta(request),
    );
    return reply.send(result);
  });

  // ── Update ───────────────────────────────────────────────────────────────
  app.patch('/:roleId', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    const body = updateSchema.parse(request.body);
    requireScope(request, organizationId);

    await updateRole(
      app.db, request.auth!.userId, organizationId, roleId, body, meta(request),
    );
    return reply.send({ updated: true });
  });

  // ── Permission set ───────────────────────────────────────────────────────
  app.put('/:roleId/permissions', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    const body = permissionsSchema.parse(request.body);
    requireScope(request, organizationId);

    const result = await setRolePermissions(
      app.db, request.auth!.userId, organizationId, roleId, body.permissions, meta(request),
    );
    return reply.send(result);
  });

  // ── Default role ─────────────────────────────────────────────────────────
  app.post('/:roleId/default', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    requireScope(request, organizationId);

    await setDefaultRole(app.db, request.auth!.userId, organizationId, roleId, meta(request));
    return reply.send({ isDefault: true });
  });

  // ── Archive / restore ────────────────────────────────────────────────────
  app.delete('/:roleId', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    const { reason } = archiveSchema.parse(request.body ?? {});
    requireScope(request, organizationId);

    await archiveRole(
      app.db, request.auth!.userId, organizationId, roleId, reason, meta(request),
    );
    return reply.send({ archived: true });
  });

  app.post('/:roleId/restore', async (request, reply) => {
    const { organizationId, roleId } = roleParam.parse(request.params);
    requireScope(request, organizationId);

    await restoreRole(app.db, request.auth!.userId, organizationId, roleId, meta(request));
    return reply.send({ restored: true });
  });
}
