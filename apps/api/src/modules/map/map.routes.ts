import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAP } from '@leoos/contracts';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { resolveMapScope, type MapScope } from './map.scope.js';
import {
  buildMapSnapshot, buildMapTick, createMapMarker, removeMapMarker, updateMapMarker,
} from './map.service.js';

/**
 * Map routes.
 *
 * The map is not nested under an organization: a dispatcher watching a pursuit
 * cross from PD into Sheriff territory needs one view, not one per agency. What
 * they may SEE is decided per caller by `resolveMapScope` and applied in SQL —
 * see the module comment in map.scope.ts.
 *
 * TRANSPORT NOTE. Positions are delivered here as a snapshot plus a polled tick.
 * The architecture calls for the `map:units` WebSocket topic
 * (docs/architecture/03-realtime.md §3) and that is still the destination; the
 * socket hub is Phase 5 work. The shapes on the wire are already the ones the
 * socket will carry, so moving to it changes the transport and nothing else.
 * Both paths recompute visibility per delivery rather than caching it, which is
 * what makes a mid-session permission change take effect immediately.
 */

const markerIdParam = z.object({ markerId: z.uuid() });

/** Coordinates are bounded at the edge, not merely typed as numbers. */
const worldX = z.number().finite().min(MAP.worldMinX).max(MAP.worldMaxX);
const worldY = z.number().finite().min(MAP.worldMinY).max(MAP.worldMaxY);

const markerTypes = ['hazard', 'roadblock', 'staging', 'command_post', 'poi', 'custom'] as const;

const createMarkerSchema = z.object({
  type: z.enum(markerTypes).default('poi'),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullish(),
  x: worldX,
  y: worldY,
  z: z.number().finite().nullish(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour.').nullish(),
  /**
   * Requested organization. Validated against the caller's own scope in the
   * service — it is a REQUEST, never the decision (engineering rule 11).
   */
  organizationId: z.uuid().nullish(),
  expiresAt: z.iso.datetime().nullish(),
}).strict();

const updateMarkerSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullish(),
  x: worldX.optional(),
  y: worldY.optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  expiresAt: z.iso.datetime().nullish(),
}).strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied.' })
  // Moving a marker means both coordinates: accepting one would place it
  // somewhere neither the operator nor the map intended.
  .refine((v) => (v.x === undefined) === (v.y === undefined), {
    message: 'Provide both x and y to move a marker.',
  });

const tickSchema = z.object({
  /**
   * Units the client already has metadata for. Used ONLY to compute removals and
   * to detect that a resync is needed — it can never widen what is returned, so
   * a forged list gains the caller nothing.
   */
  knownUnitIds: z.array(z.uuid()).max(1000).optional(),
}).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /**
   * `map.view` gates the whole subsystem. 404 rather than 403, as everywhere
   * else: a caller who may not use the map learns nothing about what is on it,
   * including whether it exists.
   */
  function requireMap(request: FastifyRequest): MapScope {
    const actor = app.actorContext(request);
    const scope = resolveMapScope(actor, request.auth!.userId);
    if (!scope.canViewMap) throw new NotFoundError('map');
    return scope;
  }

  function deps() {
    return { db: app.db, store: app.mapPositions, source: app.mapSource.status() };
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────
  app.get('/snapshot', async (request, reply) => {
    const scope = requireMap(request);
    return reply.send(await buildMapSnapshot(deps(), scope));
  });

  /**
   * Position tick.
   *
   * POST rather than GET because it carries a body, and explicitly `no-store`:
   * a cached position is a wrong position, and an intermediary holding one for
   * even a few seconds would show a dispatcher a unit that has moved.
   */
  app.post('/tick', async (request, reply) => {
    const scope = requireMap(request);
    const body = tickSchema.parse(request.body ?? {});
    reply.header('cache-control', 'no-store');
    return reply.send(await buildMapTick(deps(), scope, body.knownUnitIds ?? []));
  });

  // ── Markers ──────────────────────────────────────────────────────────────
  app.post('/markers', async (request, reply) => {
    const actor = app.actorContext(request);
    const scope = requireMap(request);
    const body = createMarkerSchema.parse(request.body);

    const result = await createMapMarker(
      app.db, actor, request.auth!.userId, scope,
      {
        type: body.type,
        label: body.label,
        description: body.description ?? null,
        x: body.x,
        y: body.y,
        z: body.z ?? null,
        color: body.color ?? null,
        organizationId: body.organizationId ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      meta(request),
    );
    return reply.status(201).send(result);
  });

  app.patch('/markers/:markerId', async (request, reply) => {
    const actor = app.actorContext(request);
    const scope = requireMap(request);
    const { markerId } = markerIdParam.parse(request.params);
    const body = updateMarkerSchema.parse(request.body);

    await updateMapMarker(
      app.db, actor, request.auth!.userId, scope, markerId,
      {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.description === undefined ? {} : { description: body.description ?? null }),
        ...(body.x === undefined ? {} : { x: body.x }),
        ...(body.y === undefined ? {} : { y: body.y }),
        ...(body.color === undefined ? {} : { color: body.color ?? null }),
        ...(body.expiresAt === undefined
          ? {}
          : { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null }),
      },
      meta(request),
    );
    return reply.send({ updated: true });
  });

  app.delete('/markers/:markerId', async (request, reply) => {
    const actor = app.actorContext(request);
    const scope = requireMap(request);
    const { markerId } = markerIdParam.parse(request.params);

    await removeMapMarker(
      app.db, actor, request.auth!.userId, scope, markerId, meta(request),
    );
    return reply.send({ removed: true });
  });
}
