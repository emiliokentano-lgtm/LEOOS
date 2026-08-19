import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.js';
import { resolveDispatchScope, type DispatchScope } from '../dispatch/dispatch.scope.js';
import { buildDashboard, buildDashboardDelta } from './dashboard.service.js';

/**
 * Dashboard routes.
 *
 * Gated on `dispatch.view`, the same permission as the board — the dashboard is
 * a summary of exactly that data, so a caller who may not see the board must not
 * see its totals either. 404 rather than 403, as everywhere else.
 */

const pollSchema = z.object({
  revision: z.string().max(200).nullish(),
}).strict();

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  function requireDashboard(request: FastifyRequest): DispatchScope {
    const actor = app.actorContext(request);
    const scope = resolveDispatchScope(actor, request.auth!.userId);
    if (!scope.canView) throw new NotFoundError('dashboard');
    return scope;
  }

  /**
   * The FiveM connection state is read from the map's position source, not
   * assumed. One place decides whether the bridge is live (engineering rules 34,
   * 35, 45); the dashboard reports what it says.
   */
  function deps() {
    return { db: app.db, fivemConnected: app.mapSource.status().connected };
  }

  app.get('/', async (request, reply) => {
    const scope = requireDashboard(request);
    reply.header('cache-control', 'no-store');
    return reply.send(await buildDashboard(deps(), scope));
  });

  app.post('/poll', async (request, reply) => {
    const scope = requireDashboard(request);
    const body = pollSchema.parse(request.body ?? {});
    reply.header('cache-control', 'no-store');
    return reply.send(await buildDashboardDelta(deps(), scope, body.revision ?? null));
  });
}
