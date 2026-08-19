import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@leoos/authz-core';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  getVehicleCore, listOrganizationOptions, listVehicleFlags, listVehicleHistory,
  searchOwnerCandidates, searchVehicles,
} from './vehicle.read.js';
import {
  addVehicleFlag, archiveVehicle, auditVehicleRead, createVehicle, resolveVehicleFlag,
  restoreVehicle, updateVehicle,
} from './vehicle.service.js';
import {
  toVehicleListItemDto, toVehicleProfileDto, toVehicleScreenCapabilitiesDto,
} from './vehicle.dto.js';

/**
 * Vehicle routes.
 *
 * Shared register, permission-gated — the same shape as persons and for the same
 * reason: a plate is looked up by whoever stops the car, not by whoever owns the
 * database row. Fleet ownership is enforced on WRITES only (see the service);
 * reads stay open so an operator can see that a unit belongs to MD.
 */

const idParam = z.object({ vehicleId: z.uuid() });
const flagParam = z.object({ vehicleId: z.uuid(), flagId: z.uuid() });

const searchQuery = z.object({
  search: z.string().max(120).optional(),
  registrationStatus: z.enum(['registered', 'expired', 'unregistered', 'all']).optional(),
  insuranceStatus: z.enum(['insured', 'uninsured', 'expired', 'all']).optional(),
  ownerPersonId: z.uuid().optional(),
  organizationId: z.uuid().optional(),
  onlyFleet: z.enum(['true', 'false']).optional(),
  onlyFlagged: z.enum(['true', 'false']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Plates are compared case-insensitively by the database (`citext`), so they are
 * normalised to upper case on the way in — otherwise the same plate reads back
 * differently depending on who typed it.
 */
const plateField = z.string().trim().min(1).max(12)
  .regex(/^[A-Za-z0-9 -]+$/, 'A plate may contain letters, numbers, spaces and hyphens.')
  .transform((v) => v.toUpperCase());

const vehicleBody = {
  plate: plateField,
  model: z.string().trim().min(1).max(60),
  displayName: z.string().trim().max(80).nullish(),
  color: z.string().trim().max(40).nullish(),
  vehicleClass: z.string().trim().max(40).nullish(),
  ownerPersonId: z.uuid().nullish(),
  ownerOrganizationId: z.uuid().nullish(),
  registrationStatus: z.enum(['registered', 'expired', 'unregistered']).optional(),
  insuranceStatus: z.enum(['insured', 'uninsured', 'expired']).optional(),
  isFleet: z.boolean().optional(),
  notes: z.string().max(4000).nullish(),
};

const createSchema = z.object(vehicleBody).strict();
const updateSchema = z.object(vehicleBody).partial().strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'No changes supplied.' },
);

const archiveSchema = z.object({ reason: z.string().trim().min(3).max(280) });
const flagSchema = z.object({
  type: z.string().trim().min(2).max(60),
  note: z.string().trim().max(500).nullish(),
}).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function vehicleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /** Everything here needs `vehicles.view`. 404, not 403. */
  function requireView(request: FastifyRequest) {
    const actor = app.actorContext(request);
    if (!can(actor, 'vehicles.view')) throw new NotFoundError('vehicles');
    return actor;
  }

  // ── Search ───────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const actor = requireView(request);
    const query = searchQuery.parse(request.query ?? {});

    const includeArchived = query.includeArchived === 'true'
      && can(actor, 'vehicles.view_deleted');

    const page = await searchVehicles(app.db, {
      search: query.search,
      registrationStatus: query.registrationStatus,
      insuranceStatus: query.insuranceStatus,
      ownerPersonId: query.ownerPersonId,
      organizationId: query.organizationId,
      onlyFleet: query.onlyFleet === 'true',
      onlyFlagged: query.onlyFlagged === 'true',
      includeArchived,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    });

    return reply.send({
      vehicles: page.rows.map((row) => toVehicleListItemDto(row, actor)),
      total: page.total,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
      capabilities: toVehicleScreenCapabilitiesDto(actor),
    });
  });

  // ── Reference data for the editor ────────────────────────────────────────
  app.get('/owner-candidates', async (request, reply) => {
    const actor = requireView(request);
    const search = z.object({ search: z.string().min(1).max(120) })
      .parse(request.query ?? {}).search;

    // Reserved to whoever may actually set an owner — this reads across the
    // person register, so `vehicles.view` alone is not enough.
    if (!can(actor, 'vehicles.edit') && !can(actor, 'vehicles.create')) {
      throw new NotFoundError('owner candidates');
    }
    return reply.send({ candidates: await searchOwnerCandidates(app.db, search) });
  });

  app.get('/organizations', async (request, reply) => {
    requireView(request);
    return reply.send({ organizations: await listOrganizationOptions(app.db) });
  });

  // ── Profile ──────────────────────────────────────────────────────────────
  app.get('/:vehicleId', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId } = idParam.parse(request.params);

    const core = await getVehicleCore(app.db, vehicleId);
    if (!core) throw new NotFoundError('vehicle');
    if (core.isArchived && !can(actor, 'vehicles.view_deleted')) {
      throw new NotFoundError('vehicle');
    }

    const [flags, history] = await Promise.all([
      listVehicleFlags(app.db, vehicleId, true),
      listVehicleHistory(app.db, vehicleId),
    ]);

    // A plate lookup is itself an event worth recording.
    await auditVehicleRead(app.db, actor, request.auth!.userId, vehicleId, meta(request));

    return reply.send(toVehicleProfileDto({ core, flags, history, actor }));
  });

  // ── Create / update ──────────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const actor = requireView(request);
    const body = createSchema.parse(request.body);

    const result = await createVehicle(
      app.db, actor, request.auth!.userId,
      {
        plate: body.plate,
        model: body.model,
        displayName: body.displayName ?? null,
        color: body.color ?? null,
        vehicleClass: body.vehicleClass ?? null,
        ownerPersonId: body.ownerPersonId ?? null,
        ownerOrganizationId: body.ownerOrganizationId ?? null,
        registrationStatus: body.registrationStatus,
        insuranceStatus: body.insuranceStatus,
        isFleet: body.isFleet,
        notes: body.notes ?? null,
      },
      meta(request),
    );
    return reply.status(201).send(result);
  });

  app.patch('/:vehicleId', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);

    await updateVehicle(app.db, actor, request.auth!.userId, vehicleId, body, meta(request));
    return reply.send({ updated: true });
  });

  app.delete('/:vehicleId', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId } = idParam.parse(request.params);
    const { reason } = archiveSchema.parse(request.body ?? {});

    await archiveVehicle(app.db, actor, request.auth!.userId, vehicleId, reason, meta(request));
    return reply.send({ archived: true });
  });

  app.post('/:vehicleId/restore', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId } = idParam.parse(request.params);

    await restoreVehicle(app.db, actor, request.auth!.userId, vehicleId, meta(request));
    return reply.send({ restored: true });
  });

  // ── Flags ────────────────────────────────────────────────────────────────
  app.post('/:vehicleId/flags', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId } = idParam.parse(request.params);
    const body = flagSchema.parse(request.body);

    await addVehicleFlag(
      app.db, actor, request.auth!.userId, vehicleId,
      { type: body.type, note: body.note ?? null }, meta(request),
    );
    return reply.status(201).send({ added: true });
  });

  app.post('/:vehicleId/flags/:flagId/resolve', async (request, reply) => {
    const actor = requireView(request);
    const { vehicleId, flagId } = flagParam.parse(request.params);

    await resolveVehicleFlag(
      app.db, actor, request.auth!.userId, vehicleId, flagId, meta(request),
    );
    return reply.send({ resolved: true });
  });
}
