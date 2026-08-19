import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RateLimitedError } from '../../lib/errors.js';
import { LIMITS } from '../../lib/rate-limit.js';
import { generateCsrfToken } from '../../lib/tokens.js';
import { clearSessionCookies, setSessionCookies } from '../../lib/cookies.js';
import {
  changePassword, login, logout, register, requestPasswordReset, resetPassword, verifyEmail,
  type RequestMeta,
} from './auth.service.js';
import { listSessions, revokeAllSessions, revokeSession } from './session.service.js';
import { toSessionDto, type ActiveSessionDto } from './auth.dto.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../lib/password.js';

/**
 * Authentication routes.
 *
 * Every payload is validated by a Zod schema before it reaches a service —
 * unvalidated `request.body` access is prohibited (engineering rule 18).
 */

const passwordField = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

const registerSchema = z.object({
  email: z.email().max(254),
  username: z.string().min(3).max(32).regex(
    /^[a-zA-Z0-9._-]+$/,
    'Username may contain letters, numbers, dots, underscores and hyphens.',
  ),
  displayName: z.string().min(1).max(120),
  password: passwordField,
});

const loginSchema = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const tokenSchema = z.object({ token: z.string().min(10).max(256) });
const emailSchema = z.object({ email: z.email().max(254) });
const resetSchema = z.object({ token: z.string().min(10).max(256), newPassword: passwordField });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: passwordField,
});

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

function limit(
  app: FastifyInstance,
  key: string,
  spec: { limit: number; windowSeconds: number },
): void {
  const result = app.limiter.consume(key, spec.limit, spec.windowSeconds);
  if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── Registration ─────────────────────────────────────────────────────────
  app.post('/register', async (request, reply) => {
    limit(app, `register:${request.ip}`, LIMITS.register);
    const body = registerSchema.parse(request.body);

    const result = await register(app.db, app.config, app.mail, body, meta(request));

    // 202: the request was accepted. Deliberately NOT 201 — saying "created"
    // would reveal that the address was previously unused.
    return reply.status(202).send({
      accepted: true,
      message:
        'If that address is available, a verification link has been sent. ' +
        'Your account will need an organization membership before you can sign in to operational screens.',
      ...(result.verificationToken ? { devVerificationToken: result.verificationToken } : {}),
    });
  });

  app.post('/verify', async (request, reply) => {
    const { token } = tokenSchema.parse(request.body);
    const result = await verifyEmail(app.db, token, meta(request));
    // Same response either way: a valid-looking token that fails tells an
    // attacker nothing about whether it ever existed.
    return reply.send({ verified: result.verified });
  });

  // ── Login ────────────────────────────────────────────────────────────────
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const identifierKey = body.identifier.trim().toLowerCase();

    limit(app, `login:ip:${request.ip}`, LIMITS.loginPerIp);
    limit(app, `login:id:${identifierKey}`, LIMITS.login);

    const result = await login(app.db, app.config, body, meta(request));

    app.limiter.reset(`login:id:${identifierKey}`);

    const csrfToken = generateCsrfToken();
    setSessionCookies(reply, app.config, {
      sessionToken: result.session.token,
      csrfToken,
      expiresAt: result.session.expiresAt,
    });

    const identity = await import('./context.service.js').then((m) =>
      m.resolveIdentity(app.db, result.userId),
    );
    if (!identity) throw new Error('identity vanished after login');

    const active = identity.memberships.find((m) => m.status === 'active');
    return reply.send({
      session: toSessionDto(identity, active?.organizationId ?? null),
      csrfToken,
      expiresAt: result.session.expiresAt.toISOString(),
    });
  });

  // ── Logout ───────────────────────────────────────────────────────────────
  app.post('/logout', async (request, reply) => {
    if (request.auth) {
      await logout(
        app.db,
        { sessionId: request.auth.sessionId, userId: request.auth.userId },
        meta(request),
      );
    }
    // Idempotent: logging out without a session is success, not an error.
    clearSessionCookies(reply, app.config);
    return reply.send({ ok: true });
  });

  // ── Current session ──────────────────────────────────────────────────────
  app.get('/me', { onRequest: app.requireSession }, async (request, reply) => {
    const auth = request.auth!;
    return reply.send({ session: toSessionDto(auth.identity, auth.organizationId) });
  });

  // ── Password reset ───────────────────────────────────────────────────────
  app.post('/password/forgot', async (request, reply) => {
    const { email } = emailSchema.parse(request.body);
    limit(app, `reset:ip:${request.ip}`, LIMITS.passwordResetPerIp);
    limit(app, `reset:email:${email.toLowerCase()}`, LIMITS.passwordResetRequest);

    const result = await requestPasswordReset(app.db, app.config, app.mail, email, meta(request));

    return reply.send({
      accepted: true,
      message: 'If an account exists for that address, a reset link is on its way.',
      ...(result.resetToken ? { devResetToken: result.resetToken } : {}),
    });
  });

  app.post('/password/reset', async (request, reply) => {
    const body = resetSchema.parse(request.body);
    const result = await resetPassword(app.db, app.config, body, meta(request));
    if (!result.reset) {
      return reply.status(400).send({
        error: {
          code: 'RESET_TOKEN_INVALID',
          message: 'This link is invalid or has expired. Request a new one.',
        },
        requestId: request.requestId,
      });
    }
    // Every session was revoked; clear whatever this browser was holding.
    clearSessionCookies(reply, app.config);
    return reply.send({ reset: true });
  });

  app.post('/password/change', { onRequest: app.requireSession }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    const auth = request.auth!;
    await changePassword(
      app.db,
      app.config,
      { ...body, userId: auth.userId, keepSessionId: auth.sessionId },
      meta(request),
    );
    return reply.send({ ok: true });
  });

  // ── Session management ───────────────────────────────────────────────────
  app.get('/sessions', { onRequest: app.requireSession }, async (request, reply) => {
    const auth = request.auth!;
    const rows = await listSessions(app.db, auth.userId);
    const dto: ActiveSessionDto[] = rows.map((r) => ({
      id: r.id,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      current: r.id === auth.sessionId,
    }));
    return reply.send({ sessions: dto });
  });

  app.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    { onRequest: app.requireSession },
    async (request, reply) => {
      const auth = request.auth!;
      const own = await listSessions(app.db, auth.userId);
      // Scoped to the caller's own sessions — a session id from elsewhere reads
      // as not-found rather than forbidden.
      if (!own.some((s) => s.id === request.params.id)) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Not found.' },
          requestId: request.requestId,
        });
      }
      await revokeSession(app.db, request.params.id, 'logout');
      if (request.params.id === auth.sessionId) clearSessionCookies(reply, app.config);
      return reply.send({ ok: true });
    },
  );

  app.post('/sessions/revoke-others', { onRequest: app.requireSession }, async (request, reply) => {
    const auth = request.auth!;
    const revoked = await revokeAllSessions(app.db, auth.userId, 'logout', auth.sessionId);
    return reply.send({ revoked });
  });
}
