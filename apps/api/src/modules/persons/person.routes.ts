import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  getMedical, getPersonCore, listAffiliations, listAliases, listCharges, listFlagTypes,
  listFlags, listLicenses, listOwnedVehicles, listWarrants, searchPersons,
} from './person.read.js';
import {
  addAlias, addFlag, archivePerson, auditPersonRead, createPerson, issueWarrant,
  removeAlias, resolveFlag, resolveWarrant, restorePerson, updateMedical, updatePerson,
} from './person.service.js';
import {
  holds, toPersonCapabilitiesDto, toPersonListItemDto, toPersonProfileDto,
} from './person.dto.js';

/**
 * Person routes.
 *
 * NOT NESTED UNDER AN ORGANIZATION, and that is the design rather than an
 * oversight. A citizen register is shared: a person is not owned by PD or MD,
 * and scoping the register by organization would mean six copies of the same
 * citizen. Access is decided by PERMISSION, which is exactly the mechanism that
 * lets one organization see more than another — PD holds `persons.criminal.view`
 * and not `persons.medical.view`, MD the reverse — without a line of
 * organization-specific code (engineering rules 5, 7, 8).
 *
 * The actor's permission set still comes from their active membership, so
 * "which organization am I acting as" is answered by the session, never by the
 * request.
 */

const idParam = z.object({ personId: z.uuid() });
const flagParam = z.object({ personId: z.uuid(), flagId: z.uuid() });
const aliasParam = z.object({ personId: z.uuid(), aliasId: z.uuid() });
const warrantParam = z.object({ personId: z.uuid(), warrantId: z.uuid() });

const searchQuery = z.object({
  search: z.string().max(120).optional(),
  status: z.enum(['alive', 'deceased', 'missing', 'incarcerated', 'all']).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  phone: z.string().max(32).optional(),
  onlyFlagged: z.enum(['true', 'false']).optional(),
  onlyWanted: z.enum(['true', 'false']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  // Bounded: the register is the largest table in the system and a client must
  // not be able to ask for all of it (engineering rule 21).
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const nameField = z.string().trim().min(1).max(80);
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullish();

const personBody = {
  firstName: nameField,
  lastName: nameField,
  dateOfBirth: dateField,
  gender: z.string().trim().max(40).nullish(),
  phoneNumber: z.string().trim().max(32).nullish(),
  address: z.string().trim().max(240).nullish(),
  heightCm: z.coerce.number().int().min(50).max(280).nullish(),
  weightKg: z.coerce.number().int().min(20).max(400).nullish(),
  eyeColor: z.string().trim().max(40).nullish(),
  hairColor: z.string().trim().max(40).nullish(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(['alive', 'deceased', 'missing', 'incarcerated']).optional(),
};

const createSchema = z.object(personBody).strict();
const updateSchema = z.object(personBody).partial().strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'No changes supplied.' },
);

const archiveSchema = z.object({ reason: z.string().trim().min(3).max(280) });
const aliasSchema = z.object({
  alias: z.string().trim().min(1).max(80),
  note: z.string().trim().max(240).nullish(),
}).strict();
const flagSchema = z.object({
  type: z.string().trim().min(2).max(60),
  severity: z.enum(['info', 'caution', 'critical']),
  note: z.string().trim().max(500).nullish(),
}).strict();
const warrantSchema = z.object({
  type: z.enum(['arrest', 'search', 'bench']),
  reason: z.string().trim().min(3).max(500),
  expiresAt: z.string().datetime().nullish(),
}).strict();
const warrantResolveSchema = z.object({ outcome: z.enum(['served', 'revoked']) }).strict();
const medicalSchema = z.object({
  bloodType: z.string().trim().max(8).nullish(),
  allergies: z.array(z.string().trim().max(80)).max(50).optional(),
  conditions: z.array(z.string().trim().max(120)).max(50).optional(),
  medications: z.array(z.string().trim().max(120)).max(50).optional(),
  emergencyContact: z.string().trim().max(160).nullish(),
  notes: z.string().max(4000).nullish(),
}).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function personRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /** Everything here needs `persons.view` at minimum. 404, not 403. */
  function requireView(request: FastifyRequest) {
    const actor = app.actorContext(request);
    if (!holds(actor, 'persons.view')) throw new NotFoundError('persons');
    return actor;
  }

  // ── Search ───────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const actor = requireView(request);
    const query = searchQuery.parse(request.query ?? {});

    // Archived records are a separate permission: a soft-deleted person is
    // hidden from ordinary lookup, not merely styled differently.
    const includeArchived = query.includeArchived === 'true'
      && holds(actor, 'persons.view_deleted');

    const page = await searchPersons(app.db, {
      search: query.search,
      status: query.status,
      dateOfBirth: query.dateOfBirth,
      phone: query.phone,
      onlyFlagged: query.onlyFlagged === 'true',
      onlyWanted: query.onlyWanted === 'true',
      includeArchived,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    });

    return reply.send({
      persons: page.rows.map(toPersonListItemDto),
      total: page.total,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
      capabilities: toPersonCapabilitiesDto(actor),
    });
  });

  app.get('/flag-types', async (request, reply) => {
    requireView(request);
    return reply.send({ types: await listFlagTypes(app.db) });
  });

  // ── Profile ──────────────────────────────────────────────────────────────
  app.get('/:personId', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);

    const core = await getPersonCore(app.db, personId);
    if (!core) throw new NotFoundError('person');
    if (core.isArchived && !holds(actor, 'persons.view_deleted')) {
      throw new NotFoundError('person');
    }

    const canCriminal = holds(actor, 'persons.criminal.view');
    const canMedical = holds(actor, 'persons.medical.view');

    // The gated sections are not fetched at all without the permission.
    const [aliases, flags, warrants, licenses, vehicles, affiliations, criminal, medical] =
      await Promise.all([
        listAliases(app.db, personId),
        listFlags(app.db, personId, true),
        listWarrants(app.db, personId),
        listLicenses(app.db, personId),
        listOwnedVehicles(app.db, personId),
        listAffiliations(app.db, personId),
        canCriminal ? listCharges(app.db, personId) : Promise.resolve(null),
        canMedical ? getMedical(app.db, personId) : Promise.resolve(undefined),
      ]);

    // Opening a record is itself an event worth recording.
    await auditPersonRead(
      app.db, actor, request.auth!.userId, personId,
      { medical: canMedical, criminal: canCriminal }, meta(request),
    );

    return reply.send(toPersonProfileDto({
      core, aliases, flags, warrants, licenses, vehicles, affiliations,
      criminal, medical, actor,
    }));
  });

  // ── Create / update ──────────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const actor = requireView(request);
    const body = createSchema.parse(request.body);

    const result = await createPerson(
      app.db, actor, request.auth!.userId,
      {
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ?? null,
        gender: body.gender ?? null,
        phoneNumber: body.phoneNumber ?? null,
        address: body.address ?? null,
        heightCm: body.heightCm ?? null,
        weightKg: body.weightKg ?? null,
        eyeColor: body.eyeColor ?? null,
        hairColor: body.hairColor ?? null,
        notes: body.notes ?? null,
        status: body.status,
      },
      meta(request),
    );
    return reply.status(201).send({ personId: result.personId });
  });

  app.patch('/:personId', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);

    await updatePerson(app.db, actor, request.auth!.userId, personId, body, meta(request));
    return reply.send({ updated: true });
  });

  app.delete('/:personId', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const { reason } = archiveSchema.parse(request.body ?? {});

    await archivePerson(app.db, actor, request.auth!.userId, personId, reason, meta(request));
    return reply.send({ archived: true });
  });

  app.post('/:personId/restore', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);

    await restorePerson(app.db, actor, request.auth!.userId, personId, meta(request));
    return reply.send({ restored: true });
  });

  // ── Aliases ──────────────────────────────────────────────────────────────
  app.post('/:personId/aliases', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const body = aliasSchema.parse(request.body);

    await addAlias(
      app.db, actor, request.auth!.userId, personId, body.alias, body.note ?? null, meta(request),
    );
    return reply.status(201).send({ added: true });
  });

  app.delete('/:personId/aliases/:aliasId', async (request, reply) => {
    const actor = requireView(request);
    const { personId, aliasId } = aliasParam.parse(request.params);

    await removeAlias(app.db, actor, request.auth!.userId, personId, aliasId, meta(request));
    return reply.send({ removed: true });
  });

  // ── Flags ────────────────────────────────────────────────────────────────
  app.post('/:personId/flags', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const body = flagSchema.parse(request.body);

    await addFlag(
      app.db, actor, request.auth!.userId, personId,
      { type: body.type, severity: body.severity, note: body.note ?? null },
      meta(request),
    );
    return reply.status(201).send({ added: true });
  });

  app.post('/:personId/flags/:flagId/resolve', async (request, reply) => {
    const actor = requireView(request);
    const { personId, flagId } = flagParam.parse(request.params);

    await resolveFlag(app.db, actor, request.auth!.userId, personId, flagId, meta(request));
    return reply.send({ resolved: true });
  });

  // ── Warrants ─────────────────────────────────────────────────────────────
  app.post('/:personId/warrants', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const body = warrantSchema.parse(request.body);

    const result = await issueWarrant(
      app.db, actor, request.auth!.userId, personId,
      { type: body.type, reason: body.reason, expiresAt: body.expiresAt ?? null },
      meta(request),
    );
    return reply.status(201).send(result);
  });

  app.post('/:personId/warrants/:warrantId/resolve', async (request, reply) => {
    const actor = requireView(request);
    const { personId, warrantId } = warrantParam.parse(request.params);
    const { outcome } = warrantResolveSchema.parse(request.body);

    await resolveWarrant(
      app.db, actor, request.auth!.userId, personId, warrantId, outcome, meta(request),
    );
    return reply.send({ outcome });
  });

  // ── Medical ──────────────────────────────────────────────────────────────
  app.put('/:personId/medical', async (request, reply) => {
    const actor = requireView(request);
    const { personId } = idParam.parse(request.params);
    const body = medicalSchema.parse(request.body);

    await updateMedical(app.db, actor, request.auth!.userId, personId, body, meta(request));
    return reply.send({ updated: true });
  });
}
