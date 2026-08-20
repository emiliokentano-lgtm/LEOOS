import type { FastifyInstance } from 'fastify';
import {
  HEARTBEAT_INTERVAL_MS,
  type ClientMessage, type ServerMessage,
} from '@leoos/contracts';
import type { Connection } from './hub.js';

/**
 * The WebSocket endpoint.
 *
 * The connection is UNAUTHENTICATED until the client's first message carries a
 * valid ticket (ADR-0013). Until then it may do nothing, and it is closed if the
 * ticket does not arrive promptly — an open socket that never authenticates is
 * either a bug or a probe, and either way it should not hold a slot.
 *
 * Message handling is deliberately dull: parse, validate the shape, dispatch.
 * The socket carries only `auth`, `subscribe`, `unsubscribe`, `resync` and
 * `ping` — no mutations (03-realtime.md §4). Everything that changes state goes
 * through REST, so there is one authorization path, one validation path and one
 * audit path for every change in the system.
 */

/** How long an unauthenticated socket may stay open. */
const AUTH_GRACE_MS = 10_000;

/** A single message is small; anything large is not one of ours. */
const MAX_MESSAGE_BYTES = 8 * 1024;

export default async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    let connection: Connection | null = null;

    const send = (message: ServerMessage): void => {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // Nothing useful to do — the socket is gone and will be cleaned up.
      }
    };

    /**
     * Close an unauthenticated socket.
     *
     * `unref` so a pending grace timer never keeps the process alive.
     */
    const authTimer = setTimeout(() => {
      if (connection === null) {
        send({ t: 'auth-failed', reason: 'No ticket presented.' });
        socket.close(4401, 'unauthenticated');
      }
    }, AUTH_GRACE_MS);
    authTimer.unref?.();

    socket.on('message', (raw: Buffer) => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        send({ t: 'error', code: 'MESSAGE_TOO_LARGE', message: 'Message too large.' });
        return;
      }

      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString('utf8')) as ClientMessage;
      } catch {
        send({ t: 'error', code: 'BAD_JSON', message: 'Message was not valid JSON.' });
        return;
      }
      if (typeof message !== 'object' || message === null || typeof message.t !== 'string') {
        send({ t: 'error', code: 'BAD_MESSAGE', message: 'Unrecognised message.' });
        return;
      }

      // ── Authentication ───────────────────────────────────────────────────
      if (message.t === 'auth') {
        if (connection !== null) {
          send({ t: 'error', code: 'ALREADY_AUTHENTICATED', message: 'Already authenticated.' });
          return;
        }

        const ticket = app.wsTickets.redeem(
          typeof message.ticket === 'string' ? message.ticket : '',
        );
        if (ticket === null) {
          // No distinction between wrong, expired and already-used: that is free
          // information a client does not need.
          send({ t: 'auth-failed', reason: 'Ticket was not valid.' });
          socket.close(4401, 'unauthenticated');
          return;
        }

        clearTimeout(authTimer);
        connection = app.realtime.add({
          userId: ticket.userId,
          sessionId: ticket.sessionId,
          organizationId: ticket.organizationId,
          socket: {
            send: (data: string) => socket.send(data),
            close: (code?: number, reason?: string) => socket.close(code, reason),
          },
        });

        send({
          t: 'ready',
          connectionId: connection.id,
          userId: ticket.userId,
          heartbeatMs: HEARTBEAT_INTERVAL_MS,
        });
        return;
      }

      // Everything below requires authentication.
      if (connection === null) {
        send({ t: 'auth-failed', reason: 'Authenticate before subscribing.' });
        socket.close(4401, 'unauthenticated');
        return;
      }

      app.realtime.touch(connection.id);

      switch (message.t) {
        case 'ping':
          send({ t: 'pong' });
          return;

        case 'subscribe': {
          if (!Array.isArray(message.topics)) {
            send({ t: 'error', code: 'BAD_MESSAGE', message: 'topics must be an array.' });
            return;
          }
          const id = connection.id;
          void app.realtime.subscribe(id, message.topics.filter((t) => typeof t === 'string'))
            .then((result) => {
              send({
                t: 'subscribed',
                ok: result.ok,
                denied: result.denied as { topic: string; reason: never }[],
              });
            })
            .catch(() => {
              send({ t: 'error', code: 'SUBSCRIBE_FAILED', message: 'Could not subscribe.' });
            });
          return;
        }

        case 'unsubscribe': {
          if (!Array.isArray(message.topics)) return;
          const removed = app.realtime.unsubscribe(
            connection.id, message.topics.filter((t) => typeof t === 'string'),
          );
          send({ t: 'unsubscribed', topics: removed });
          return;
        }

        case 'resync': {
          if (!Array.isArray(message.topics)) return;
          send({
            t: 'seq',
            topics: app.realtime.sequencesFor(
              message.topics.filter((t) => typeof t === 'string'),
            ),
          });
          return;
        }

        default:
          send({ t: 'error', code: 'BAD_MESSAGE', message: 'Unrecognised message.' });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (connection !== null) app.realtime.remove(connection.id);
    });

    socket.on('error', () => {
      clearTimeout(authTimer);
      if (connection !== null) app.realtime.remove(connection.id);
    });
  });
}
