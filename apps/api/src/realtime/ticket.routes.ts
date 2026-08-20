import type { FastifyInstance } from 'fastify';
import { HEARTBEAT_INTERVAL_MS } from '@leoos/contracts';

/**
 * Minting a WebSocket ticket.
 *
 * This is an ordinary authenticated HTTP endpoint, which is the whole point: the
 * session cookie works here because the web tier calls it server-to-server, and
 * the browser never has to present a credential the socket handshake cannot
 * carry. See tickets.ts for why the socket cannot simply read the cookie, and
 * ADR-0013 for the decision.
 *
 * The ticket is bound to the SESSION and the ACTIVE ORGANIZATION resolved on
 * this request — both already validated by the auth plugin against the user's
 * real memberships, so a crafted organization header cannot widen what the
 * resulting socket may subscribe to (rule 11).
 *
 * `no-store`, without exception. A ticket that reaches a shared cache is a
 * ticket that authenticates somebody else.
 */
export default async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  app.post('/ticket', async (request, reply) => {
    const auth = request.auth!;

    const minted = app.wsTickets.mint({
      userId: auth.userId,
      sessionId: auth.sessionId,
      organizationId: auth.organizationId,
    });

    reply.header('cache-control', 'no-store');
    return reply.status(201).send({
      ticket: minted.ticket,
      expiresAt: minted.expiresAt,
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
    });
  });
}
