import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FIELD_REQUEST_KIND_KEYS, MAP, type RealtimeActor } from '@leoos/contracts';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { resolveDispatchScope, type DispatchScope } from './dispatch.scope.js';
import { buildDispatchBoard, buildDispatchDelta, buildSelfState } from './board.service.js';
import { getIncidentDetail, listAssignments, listTimeline } from './dispatch.read.js';
import { toIncidentDetailDto } from './dispatch.dto.js';
import {
  addIncidentNote, assignUnit, changeIncidentPriority, changeIncidentStatus, closeIncident,
  createIncident, releaseUnit, reopenIncident, updateIncident,
} from './incident.service.js';
import {
  createUnit, disbandUnit, joinUnit, leaveUnit, setOwnStatus, setUnitStatus,
} from './unit.service.js';
import { acknowledgePanic, resolvePanic, triggerPanic } from './panic.service.js';
import {
  attachAcceptorToIncident, cancelFieldRequest, raiseFieldRequest, respondToFieldRequest,
} from './field-request.service.js';
import { getFieldRequestRevision, listLiveFieldRequests } from './field-request.read.js';
import { publishDispatchEvents, type DispatchEmission } from './dispatch.events.js';

/**
 * Dispatch routes.
 *
 * Not nested under an organization: a dispatcher watching a joint call needs one
 * board, not one per agency. What they may see and do is resolved per caller in
 * dispatch.scope.ts and enforced inside each mutating transaction — the route
 * layer is coarse on purpose (docs/architecture/02-authorization.md §B.7).
 *
 * SELF-ACTIONS ARE UNDER `/self`. That grouping is not cosmetic: it is exactly
 * the set of endpoints that act on the caller and therefore need no management
 * permission, and keeping them together makes it obvious when something has been
 * added there that should not be.
 *
 * THIS LAYER IS ALSO WHERE REAL-TIME EVENTS ARE PUBLISHED. Every mutation
 * returns a `DispatchOutcome` — its reply value plus what changed — and the
 * handler publishes the second half after awaiting the first. That ordering is
 * the point: the await is the commit, so nothing can be broadcast for a
 * transaction that rolled back (see dispatch.events.ts).
 */

const incidentIdParam = z.object({ incidentId: z.uuid() });
const unitIdParam = z.object({ unitId: z.uuid() });
const panicIdParam = z.object({ panicId: z.uuid() });

const worldX = z.number().finite().min(MAP.worldMinX).max(MAP.worldMaxX);
const worldY = z.number().finite().min(MAP.worldMinY).max(MAP.worldMaxY);
const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

const createIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(4000).nullish(),
  typeKey: z.string().trim().max(60).nullish(),
  priority: priority.default(3),
  locationText: z.string().trim().max(200).nullish(),
  x: worldX.nullish(),
  y: worldY.nullish(),
  callerPhone: z.string().trim().max(40).nullish(),
  organizationId: z.uuid().nullish(),
}).strict()
  // A coordinate is a pair. Half of one puts the pin in the sea.
  .refine((v) => (v.x === undefined || v.x === null) === (v.y === undefined || v.y === null), {
    message: 'Provide both x and y, or neither.',
  });

const updateIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().max(4000).nullish(),
  typeKey: z.string().trim().max(60).nullish(),
  locationText: z.string().trim().max(200).nullish(),
  x: worldX.nullish(),
  y: worldY.nullish(),
  callerPhone: z.string().trim().max(40).nullish(),
}).strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied.' })
  .refine((v) => (v.x === undefined) === (v.y === undefined), {
    message: 'Provide both x and y to move an incident.',
  });

const statusSchema = z.object({
  status: z.enum(['pending', 'dispatched', 'on_scene', 'contained', 'on_hold']),
}).strict();

const prioritySchema = z.object({
  priority,
  reason: z.string().trim().max(200).nullish(),
}).strict();

const closeSchema = z.object({
  cancelled: z.boolean().default(false),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const reopenSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

const assignSchema = z.object({
  unitId: z.uuid(),
  role: z.string().trim().max(40).nullish(),
}).strict();

const noteSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

const createUnitSchema = z.object({
  callsign: z.string().trim().min(1).max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'A callsign may contain letters, numbers and hyphens.')
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().max(60).nullish(),
  unitType: z.string().trim().max(40).default('patrol'),
  vehicleId: z.uuid().nullish(),
  isCovert: z.boolean().default(false),
  joinSelf: z.boolean().default(true),
}).strict();

const ownStatusSchema = z.object({ statusKey: z.string().trim().min(1).max(60) }).strict();
const unitStatusSchema = z.object({ statusKey: z.string().trim().min(1).max(60) }).strict();

const panicSchema = z.object({ x: worldX.nullish(), y: worldY.nullish() }).strict();
const resolvePanicSchema = z.object({
  restoreStatusKey: z.string().trim().max(60).nullish(),
}).strict();

/**
 * Raising a field request.
 *
 * `.strict()`, so a client cannot smuggle a recipient list, an organization or
 * a member id past the audience derivation. Everything except the kind, an
 * optional note and an optional position is read from the asker's membership.
 */
const fieldRequestSchema = z.object({
  kind: z.enum(FIELD_REQUEST_KIND_KEYS),
  /**
   * Bounded, and short on purpose.
   *
   * This is the one free-text field a field request carries, and it reaches
   * every on-duty colleague — so it is not private, and the screen where it is
   * typed says so. Short enough that it cannot become a place to paste somebody
   * else's record.
   */
  note: z.string().trim().max(200).nullish(),
  x: worldX.nullish(),
  y: worldY.nullish(),
}).strict();

const respondSchema = z.object({
  action: z.enum(['accept', 'decline']),
}).strict();

const deltaSchema = z.object({
  revision: z.string().max(200).nullish(),
  includeClosed: z.boolean().default(false),
}).strict();

/**
 * Who to attribute an event to.
 *
 * A display name and a user id, and nothing else — the actor travels to every
 * subscribed console, and an event envelope is the easiest place in the system
 * to leak a detail nobody asked for (rule 16).
 */
function realtimeActor(request: FastifyRequest): RealtimeActor {
  return {
    kind: 'user',
    userId: request.auth?.userId ?? null,
    label: request.auth?.identity.account.displayName ?? null,
  };
}

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function dispatchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /**
   * `dispatch.view` gates the subsystem. 404 rather than 403, as everywhere
   * else: a caller who may not use dispatch learns nothing about what is on it.
   */
  function requireDispatch(request: FastifyRequest): DispatchScope {
    const actor = app.actorContext(request);
    const scope = resolveDispatchScope(actor, request.auth!.userId);
    if (!scope.canView) throw new NotFoundError('dispatch');
    return scope;
  }

  /** Publishes what a mutation reported. Never awaited — see publisher.ts. */
  function publish(request: FastifyRequest, events: readonly DispatchEmission[]): void {
    publishDispatchEvents(app.events, realtimeActor(request), events);
  }

  // ── Board ────────────────────────────────────────────────────────────────
  app.get('/board', async (request, reply) => {
    const scope = requireDispatch(request);
    const includeClosed = (request.query as { includeClosed?: string } | undefined)
      ?.includeClosed === 'true';
    reply.header('cache-control', 'no-store');
    return reply.send(await buildDispatchBoard(app.db, scope, { includeClosed }));
  });

  /**
   * Poll. POST because it carries the client's last revision, and `no-store`
   * because a cached dispatch board is a board showing calls that already
   * finished.
   */
  app.post('/board/poll', async (request, reply) => {
    const scope = requireDispatch(request);
    const body = deltaSchema.parse(request.body ?? {});
    reply.header('cache-control', 'no-store');
    return reply.send(await buildDispatchDelta(
      app.db, scope, body.revision ?? null, { includeClosed: body.includeClosed },
    ));
  });

  /**
   * The caller's own state, without the board.
   *
   * The shell renders a status control and a panic button on every screen; making
   * that cost a full board render per page would be absurd.
   */
  app.get('/self', async (request, reply) => {
    const scope = requireDispatch(request);
    reply.header('cache-control', 'no-store');
    return reply.send(await buildSelfState(app.db, scope));
  });

  // ── Incident detail ──────────────────────────────────────────────────────
  app.get('/incidents/:incidentId', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);

    const core = await getIncidentDetail(app.db, scope, incidentId);
    if (!core) throw new NotFoundError('incident');

    const [assignments, timeline] = await Promise.all([
      // Released assignments included: the detail view is the record of who
      // attended, and a unit that came and went is part of that record.
      listAssignments(app.db, [incidentId], { includeReleased: true }),
      listTimeline(app.db, incidentId),
    ]);

    return reply.send(toIncidentDetailDto({ core, assignments, timeline }));
  });

  // ── Incident mutations ───────────────────────────────────────────────────
  app.post('/incidents', async (request, reply) => {
    const scope = requireDispatch(request);
    const body = createIncidentSchema.parse(request.body);

    const { result, events } = await createIncident(app.db, scope, {
      title: body.title,
      description: body.description ?? null,
      typeKey: body.typeKey ?? null,
      priority: body.priority,
      locationText: body.locationText ?? null,
      x: body.x ?? null,
      y: body.y ?? null,
      callerPhone: body.callerPhone ?? null,
      organizationId: body.organizationId ?? null,
    }, meta(request));

    publish(request, events);
    return reply.status(201).send(result);
  });

  app.patch('/incidents/:incidentId', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const body = updateIncidentSchema.parse(request.body);

    const { events } = await updateIncident(app.db, scope, incidentId, {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description ?? null }),
      ...(body.typeKey === undefined ? {} : { typeKey: body.typeKey ?? null }),
      ...(body.locationText === undefined ? {} : { locationText: body.locationText ?? null }),
      ...(body.x === undefined ? {} : { x: body.x ?? null }),
      ...(body.y === undefined ? {} : { y: body.y ?? null }),
      ...(body.callerPhone === undefined ? {} : { callerPhone: body.callerPhone ?? null }),
    }, meta(request));

    publish(request, events);
    return reply.send({ updated: true });
  });

  app.post('/incidents/:incidentId/status', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const { status } = statusSchema.parse(request.body);
    const { events } = await changeIncidentStatus(
      app.db, scope, incidentId, status, meta(request),
    );
    publish(request, events);
    return reply.send({ updated: true });
  });

  app.post('/incidents/:incidentId/priority', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const body = prioritySchema.parse(request.body);
    const { events } = await changeIncidentPriority(
      app.db, scope, incidentId, body.priority, body.reason ?? null, meta(request),
    );
    publish(request, events);
    return reply.send({ updated: true });
  });

  app.post('/incidents/:incidentId/close', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const body = closeSchema.parse(request.body ?? {});
    const { events } = await closeIncident(
      app.db, scope, incidentId, { cancelled: body.cancelled, notes: body.notes ?? null },
      meta(request),
    );
    publish(request, events);
    return reply.send({ closed: true });
  });

  app.post('/incidents/:incidentId/reopen', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const { reason } = reopenSchema.parse(request.body);
    const { events } = await reopenIncident(app.db, scope, incidentId, reason, meta(request));
    publish(request, events);
    return reply.send({ reopened: true });
  });

  app.post('/incidents/:incidentId/notes', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const { body } = noteSchema.parse(request.body);
    const { events } = await addIncidentNote(app.db, scope, incidentId, body, meta(request));
    publish(request, events);
    return reply.status(201).send({ added: true });
  });

  // ── Assignment ───────────────────────────────────────────────────────────
  app.post('/incidents/:incidentId/units', async (request, reply) => {
    const scope = requireDispatch(request);
    const { incidentId } = incidentIdParam.parse(request.params);
    const body = assignSchema.parse(request.body);
    const { events } = await assignUnit(
      app.db, scope, incidentId, body.unitId, body.role ?? null, meta(request),
    );
    publish(request, events);
    return reply.status(201).send({ assigned: true });
  });

  app.delete('/incidents/:incidentId/units/:unitId', async (request, reply) => {
    const scope = requireDispatch(request);
    const params = z.object({ incidentId: z.uuid(), unitId: z.uuid() }).parse(request.params);
    const { events } = await releaseUnit(
      app.db, scope, params.incidentId, params.unitId, meta(request),
    );
    publish(request, events);
    return reply.send({ released: true });
  });

  // ── Units ────────────────────────────────────────────────────────────────
  app.post('/units', async (request, reply) => {
    const scope = requireDispatch(request);
    const body = createUnitSchema.parse(request.body);
    const { result, events } = await createUnit(app.db, scope, {
      callsign: body.callsign,
      name: body.name ?? null,
      unitType: body.unitType,
      vehicleId: body.vehicleId ?? null,
      isCovert: body.isCovert,
      joinSelf: body.joinSelf,
    }, meta(request));
    publish(request, events);
    return reply.status(201).send(result);
  });

  app.delete('/units/:unitId', async (request, reply) => {
    const scope = requireDispatch(request);
    const { unitId } = unitIdParam.parse(request.params);
    const { events } = await disbandUnit(app.db, scope, unitId, meta(request));
    publish(request, events);
    return reply.send({ disbanded: true });
  });

  app.post('/units/:unitId/status', async (request, reply) => {
    const scope = requireDispatch(request);
    const { unitId } = unitIdParam.parse(request.params);
    const { statusKey } = unitStatusSchema.parse(request.body);
    const { events } = await setUnitStatus(app.db, scope, unitId, statusKey, meta(request));
    publish(request, events);
    return reply.send({ updated: true });
  });

  // ── Self ─────────────────────────────────────────────────────────────────
  //
  // Everything below acts on the CALLER and needs no management permission. An
  // officer with no dispatch authority still has to be able to go available, get
  // in a car, and call for help.

  app.post('/self/status', async (request, reply) => {
    const scope = requireDispatch(request);
    const { statusKey } = ownStatusSchema.parse(request.body);
    const { events } = await setOwnStatus(app.db, scope, statusKey, meta(request));
    publish(request, events);
    return reply.send({ updated: true });
  });

  app.post('/self/unit/:unitId', async (request, reply) => {
    const scope = requireDispatch(request);
    const { unitId } = unitIdParam.parse(request.params);
    const { events } = await joinUnit(app.db, scope, unitId, meta(request));
    publish(request, events);
    return reply.send({ joined: true });
  });

  app.delete('/self/unit', async (request, reply) => {
    const scope = requireDispatch(request);
    const { events } = await leaveUnit(app.db, scope, meta(request));
    publish(request, events);
    return reply.send({ left: true });
  });

  app.post('/self/panic', async (request, reply) => {
    const scope = requireDispatch(request);
    const body = panicSchema.parse(request.body ?? {});
    const { result, events } = await triggerPanic(
      app.db, scope, { x: body.x ?? null, y: body.y ?? null, source: 'web' }, meta(request),
    );
    publish(request, events);
    return reply.status(201).send(result);
  });

  // ── Field requests ───────────────────────────────────────────────────────
  //
  // Asking for backup, and saying where you are. See
  // docs/architecture/09-dispatch.md §6b for why these are not incidents.

  app.get('/field-requests', async (request, reply) => {
    const scope = requireDispatch(request);
    const [requests, revision] = await Promise.all([
      listLiveFieldRequests(app.db, scope),
      getFieldRequestRevision(app.db, scope),
    ]);
    return reply.send({ requests, revision });
  });

  app.post('/field-requests', async (request, reply) => {
    const scope = requireDispatch(request);
    const body = fieldRequestSchema.parse(request.body ?? {});

    const { result, events } = await raiseFieldRequest(app.db, scope, {
      kind: body.kind,
      note: body.note ?? null,
      x: body.x ?? null,
      y: body.y ?? null,
      source: 'web',
    }, meta(request));

    publish(request, events);
    // 200 rather than 201 for a repeat: nothing was created, and telling the
    // client otherwise would have it render a second card for one request.
    return reply.status(result.alreadyLive ? 200 : 201).send(result);
  });

  app.post('/field-requests/:requestId/respond', async (request, reply) => {
    const scope = requireDispatch(request);
    const { requestId } = request.params as { requestId: string };
    const body = respondSchema.parse(request.body ?? {});

    const { result, events } = await respondToFieldRequest(
      app.db, scope, requestId, body.action, meta(request),
    );
    publish(request, events);

    /**
     * The attachment is a SECOND, ordinary assignment.
     *
     * Made through `assignUnit` in its own transaction, so it carries the same
     * authorization, the same audit row and the same timeline entry a
     * dispatcher's assignment would. A refusal there does not undo the
     * acceptance — see the service.
     */
    if (body.action === 'accept') {
      const attached = await attachAcceptorToIncident(
        app.db, scope, result.attachedToIncidentId, meta(request),
      );
      if (attached !== null) publish(request, attached.events);
    }

    return reply.send(result);
  });

  app.post('/field-requests/:requestId/cancel', async (request, reply) => {
    const scope = requireDispatch(request);
    const { requestId } = request.params as { requestId: string };
    const { result, events } = await cancelFieldRequest(
      app.db, scope, requestId, meta(request),
    );
    publish(request, events);
    return reply.send(result);
  });

  // ── Panic handling ───────────────────────────────────────────────────────
  app.post('/panics/:panicId/acknowledge', async (request, reply) => {
    const scope = requireDispatch(request);
    const { panicId } = panicIdParam.parse(request.params);
    const { events } = await acknowledgePanic(app.db, scope, panicId, meta(request));
    publish(request, events);
    return reply.send({ acknowledged: true });
  });

  app.post('/panics/:panicId/resolve', async (request, reply) => {
    const scope = requireDispatch(request);
    const { panicId } = panicIdParam.parse(request.params);
    const body = resolvePanicSchema.parse(request.body ?? {});
    const { events } = await resolvePanic(
      app.db, scope, panicId, body.restoreStatusKey ?? null, meta(request),
    );
    publish(request, events);
    return reply.send({ resolved: true });
  });
}
