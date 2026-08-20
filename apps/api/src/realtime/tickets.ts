import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TICKET_TTL_MS } from '@leoos/contracts';

/**
 * WebSocket connection tickets.
 *
 * THE PROBLEM THESE SOLVE.
 *
 * `docs/architecture/03-realtime.md` §2 says authentication happens at the HTTP
 * upgrade, from the session cookie. That was written before ADR-0001 and
 * ADR-0010 settled the topology, and it is not achievable as written: the web
 * tier re-sets `leoos_session` on ITS OWN origin, HttpOnly and SameSite=Lax, so
 * a browser opening a socket to the API origin sends no cookie at all. The
 * options were to proxy every position tick through Next, to widen the cookie
 * across origins, or this.
 *
 * WHAT A TICKET IS. A 32-byte random value, minted by the API through the
 * authenticated server-to-server path the web tier already uses, handed to the
 * browser, and presented as the FIRST WEBSOCKET MESSAGE.
 *
 * Why that is not a token in a query string — the thing 03-realtime.md was
 * actually protecting against. A query string lands in access logs, proxy logs
 * and `Referer` headers. A first-message credential lands in none of them. The
 * constraint is honoured; only the mechanism differs.
 *
 * Why it is safe to hand a browser:
 *   • It expires in 30 seconds.
 *   • It is SINGLE USE — redeeming deletes it, so a captured ticket is already
 *     spent by the time anyone could replay it.
 *   • It is bound to the session that minted it, so revoking the session kills
 *     every connection it authorised.
 *   • It grants no authority of its own. It names a user; every topic is then
 *     authorized from that user's live permissions on every delivery.
 *
 * STORAGE. In-process, like the live position store, and for the same reason:
 * Redis is not provisioned. The cost is stated rather than discovered — tickets
 * do not survive a restart (the client simply mints another) and do not span
 * instances, so this is single-node until Redis lands.
 */

export interface Ticket {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  expiresAt: number;
}

/** What the API hands back. The raw value is shown once and never stored. */
export interface MintedTicket {
  ticket: string;
  expiresAt: string;
}

/**
 * Tickets are stored HASHED.
 *
 * They are short-lived and single-use, so this is belt and braces — but a heap
 * dump or a stray log of the store should not yield anything replayable, and the
 * hash costs nothing at this volume.
 */
function fingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  private sweeper: NodeJS.Timeout | null = null;

  mint(input: { userId: string; sessionId: string; organizationId: string | null }): MintedTicket {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TICKET_TTL_MS;

    this.tickets.set(fingerprint(raw), {
      userId: input.userId,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      expiresAt,
    });

    return { ticket: raw, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Redeems a ticket, consuming it.
   *
   * Returns null for anything that is not a live, unexpired, unredeemed ticket —
   * the caller closes the socket without distinguishing the cases, because
   * telling a client whether a ticket was wrong or merely expired is free
   * information it does not need.
   */
  redeem(raw: string): Ticket | null {
    if (typeof raw !== 'string' || raw.length < 16 || raw.length > 128) return null;

    const key = fingerprint(raw);
    const found = this.tickets.get(key);

    /**
     * Compared in constant time even though the lookup above is a hash map.
     *
     * The map lookup already leaks nothing useful, but the comparison is written
     * this way so that a future change to a scan-based store does not silently
     * introduce a timing oracle.
     */
    if (found === undefined) {
      const decoy = fingerprint('decoy');
      timingSafeEqual(Buffer.from(key), Buffer.from(decoy.length === key.length ? decoy : key));
      return null;
    }

    // Single use: gone whether or not it turns out to be expired.
    this.tickets.delete(key);
    if (found.expiresAt < Date.now()) return null;

    return found;
  }

  /** Invalidates every ticket minted for a session. Used when a session ends. */
  revokeSession(sessionId: string): number {
    let removed = 0;
    for (const [key, ticket] of this.tickets) {
      if (ticket.sessionId === sessionId) {
        this.tickets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  start(): void {
    if (this.sweeper !== null) return;
    // Expired tickets are refused on redemption regardless; this only stops the
    // map growing on a long-running process.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt < now) {
        this.tickets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.tickets.size;
  }
}
