import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveDispatchScope } from '../dispatch/dispatch.scope.js';
import { publishDispatchEvents, realtimeActorOf } from '../dispatch/dispatch.events.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { cancelTask, completeTask, createTask } from './task.service.js';
import { listOrganizationTasks, listOwnTasks } from './task.read.js';

/**
 * Tasks.
 *
 * Its own module rather than a corner of dispatch: a task is not an operational
 * event, it does not appear on a board, and it has a different authority model
 * (see docs/architecture/10-dashboard.md §4b). It reuses the DISPATCH SCOPE
 * because organization membership and permissions are resolved the same way for
 * everything — that is one resolution path, not a shared bounded context.
 */

const createSchema = z.object({
  assigneeMemberId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(2000).nullish(),
  priorityKey: z.string().trim().min(1).max(40),
  /**
   * ISO, or nothing.
   *
   * Bounded a decade out. A deadline in 2140 is a typo or a way of hiding a
   * task at the bottom of a list forever, and neither is worth storing.
   */
  dueAt: z.iso.datetime().nullish(),
}).strict();

const completeSchema = z.object({ completed: z.boolean() }).strict();

const cancelSchema = z.object({
  reason: z.string().trim().max(200).nullish(),
}).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

const MAX_DUE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export default async function taskRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The caller's scope, resolved the same way every other module resolves it.
   *
   * Deliberately NOT gated on `canView` here, unlike the dispatch routes: tasks
   * are not board content, and an operator who may not see dispatch may still
   * have work assigned to them. The gate that matters — `tasks.assign` — is
   * checked in the service.
   */
  function scopeOf(request: FastifyRequest) {
    return resolveDispatchScope(app.actorContext(request), request.auth!.userId);
  }

  function publish(request: FastifyRequest, events: Parameters<typeof publishDispatchEvents>[2]) {
    publishDispatchEvents(app.events, realtimeActorOf(request), events);
  }

  /** The caller's own tasks. What the dashboard panel renders. */
  app.get('/', async (request, reply) => {
    const scope = scopeOf(request);
    const includeCompleted = (request.query as { includeCompleted?: string } | undefined)
      ?.includeCompleted === 'true';
    return reply.send(await listOwnTasks(app.db, scope, { includeCompleted }));
  });

  /**
   * Everything outstanding in the organization.
   *
   * Gated on `tasks.assign` inside the read, not here: a member who cannot
   * assign has no reason to read everybody's workload, and the read returns an
   * empty list rather than a 403 so the screen shows "nothing" instead of an
   * error for a perfectly ordinary lack of permission.
   */
  app.get('/organization', async (request, reply) => {
    const scope = scopeOf(request);
    return reply.send(await listOrganizationTasks(app.db, scope));
  });

  app.post('/', async (request, reply) => {
    const scope = scopeOf(request);
    const body = createSchema.parse(request.body ?? {});

    const dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (dueAt !== null && dueAt.getTime() > Date.now() + MAX_DUE_MS) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'That deadline is too far away.' },
        requestId: request.requestId,
      });
    }

    const { result, events } = await createTask(app.db, scope, {
      assigneeMemberId: body.assigneeMemberId,
      title: body.title,
      detail: body.detail ?? null,
      priorityKey: body.priorityKey,
      dueAt,
    }, meta(request));

    publish(request, events);
    return reply.status(201).send(result);
  });

  app.post('/:taskId/complete', async (request, reply) => {
    const scope = scopeOf(request);
    const { taskId } = request.params as { taskId: string };
    const body = completeSchema.parse(request.body ?? {});

    const { result, events } = await completeTask(
      app.db, scope, taskId, body.completed, meta(request),
    );
    publish(request, events);
    return reply.send(result);
  });

  app.post('/:taskId/cancel', async (request, reply) => {
    const scope = scopeOf(request);
    const { taskId } = request.params as { taskId: string };
    const body = cancelSchema.parse(request.body ?? {});

    const { result, events } = await cancelTask(
      app.db, scope, taskId, body.reason ?? null, meta(request),
    );
    publish(request, events);
    return reply.send(result);
  });
}
