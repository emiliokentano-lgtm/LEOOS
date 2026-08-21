import fp from 'fastify-plugin';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionKey } from '@leoos/contracts';
import { can, type ActorContext } from '@leoos/authz-core';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import { resolveSession, touchSession } from '../modules/auth/session.service.js';
import { resolveIdentityCached, toActorContext } from '../modules/auth/context.service.js';

/**
 * Authentication middleware.
 *
 * Establishes WHO is calling. It does not decide what they may do beyond the
 * coarse route guard below — fine-grained authorization happens in the domain
 * service, inside the mutating transaction, because only there is the target's
 * rank known and only there is the decision race-free
 * (docs/architecture/02-authorization.md §B.7).
 */

export const SESSION_COOKIE = 'leoos_session';
export const CSRF_COOKIE = 'leoos_csrf';
export const CSRF_HEADER = 'x-leoos-csrf';
export const ORG_HEADER = 'x-leoos-organization';

declare module 'fastify' {
  interface FastifyInstance {
    /** Requires a live session. Use as an `onRequest`/`preHandler` hook. */
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Coarse route guard. NEVER sufficient on its own for a rank-sensitive
     *  operation — the guard cannot know the target's rank. */
    requirePermission: (
      permission: PermissionKey,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    actorContext: (request: FastifyRequest) => ActorContext;
  }
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Constant-time comparison for the internal service token.
 *
 * This token is a complete CSRF exemption, so it is a secret and is compared
 * like one. `===` on a string short-circuits at the first differing byte; over a
 * local network that is a narrow channel, but it costs nothing to close and the
 * rule "secrets are never compared with ===" is easier to hold than a
 * case-by-case judgement about how narrow is narrow enough.
 */
function matchesInternalToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default fp(async (app) => {
  /**
   * CSRF defence, three independent layers:
   *   1. the session cookie is SameSite=Lax (set at issue time)
   *   2. Origin must be allow-listed on state-changing requests
   *   3. double-submit: header must equal the non-HttpOnly companion cookie
   *
   * None is load-bearing alone. The internal service token from the web tier is
   * exempt from 2 and 3 — it is not a browser and carries no ambient cookie.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.url.startsWith('/health')) return;

    const internal = request.headers['x-leoos-internal'];
    if (typeof internal === 'string' && matchesInternalToken(internal, app.config.INTERNAL_API_TOKEN)) {
      return;
    }

    const origin = request.headers.origin;
    if (origin && !app.config.allowedOrigins.includes(origin)) {
      request.log.warn({ origin }, 'rejected cross-origin state-changing request');
      return reply.status(403).send({
        error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed.' },
        requestId: request.requestId,
      });
    }

    const cookieToken = readCookie(request, CSRF_COOKIE);
    const headerToken = request.headers[CSRF_HEADER];
    // Only enforced once a CSRF cookie exists — pre-login requests have none.
    if (cookieToken && cookieToken !== headerToken) {
      request.log.warn('csrf token mismatch');
      return reply.status(403).send({
        error: { code: 'CSRF_FAILED', message: 'Request could not be verified. Reload and try again.' },
        requestId: request.requestId,
      });
    }
  });

  /**
   * Attaches identity when a valid session cookie or bearer token is present.
   *
   * MUST be `onRequest`, not `preHandler`: route guards are declared as
   * route-level `onRequest` hooks, and Fastify runs every application-level hook
   * of a phase before the route-level ones of that same phase. In `preHandler`
   * this would run AFTER `requireSession`, so every protected route would see no
   * session and reject a perfectly valid cookie.
   */
  app.addHook('onRequest', async (request) => {
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : undefined;
    const token = readCookie(request, SESSION_COOKIE) ?? bearer;
    if (!token) return;

    const record = await resolveSession(app.db, token);
    if (!record) return;

    /**
     * Cached on the user's `permission_version`, NOT on a timer alone — see the
     * block above `resolveIdentityCached`. On a hit this is one indexed read
     * instead of seven queries; a permission change invalidates it by moving the
     * key, so a demotion takes effect on the very next request.
     */
    const identity = await resolveIdentityCached(app.db, record.userId);
    if (!identity) return;

    const requested = request.headers[ORG_HEADER];
    const requestedOrgId = typeof requested === 'string' ? requested : undefined;

    // The active organization is only honoured if the user is genuinely a member
    // of it. A crafted header can therefore never widen scope (rule 11).
    const membership = requestedOrgId
      ? identity.memberships.find((m) => m.organizationId === requestedOrgId)
      : identity.memberships.find((m) => m.status === 'active');

    request.auth = {
      sessionId: record.id,
      userId: record.userId,
      identity,
      organizationId: membership?.organizationId ?? null,
    };

    await touchSession(app.db, app.config, record);
  });

  /**
   * NOTHING THIS API SERVES IS CACHEABLE BY DEFAULT.
   *
   * Individual routes had been setting `cache-control: no-store` by hand — the
   * dispatch board, the map, the dashboard, notifications, the ticket endpoint.
   * The ones that remembered were the ones whose author was thinking about
   * freshness. The rest — the organization panels, personnel, the person and
   * vehicle registers, search, roles, the whole admin surface — sent no
   * `cache-control` at all, which leaves the decision to a heuristic in whatever
   * sits between the browser and the API.
   *
   * That is the wrong default twice over. Operationally, a stale roster or a
   * stale audit page is a screen lying to a dispatcher. For security, a cached
   * authenticated response is a response that can be replayed to somebody else
   * by a shared proxy — the same class of problem as the serialization boundary,
   * reached through the transport instead of the DTO.
   *
   * So the default inverts: every response leaves with `no-store` unless the
   * route set something itself. A route that genuinely serves cacheable public
   * content states so explicitly, which is a decision worth making visible.
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.decorate('requireSession', async (request: FastifyRequest) => {
    if (!request.auth) throw new UnauthenticatedError();
  });

  app.decorate('actorContext', (request: FastifyRequest): ActorContext => {
    if (!request.auth) throw new UnauthenticatedError();
    return toActorContext(request.auth.identity, request.auth.organizationId);
  });

  app.decorate(
    'requirePermission',
    (permission: PermissionKey) => async (request: FastifyRequest) => {
      if (!request.auth) throw new UnauthenticatedError();
      const actor = toActorContext(request.auth.identity, request.auth.organizationId);
      if (!can(actor, permission)) {
        throw new ForbiddenError(`missing permission ${permission}`, { permission });
      }
    },
  );
});
