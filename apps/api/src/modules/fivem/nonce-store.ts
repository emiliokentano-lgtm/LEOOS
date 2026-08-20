import { FIVEM_NONCE_TTL_SECONDS } from '@leoos/contracts';

/**
 * Replay protection, first line.
 *
 * A captured request is worthless if it cannot be sent twice. The timestamp
 * window bounds how long a capture is interesting at all; this bounds it to
 * exactly once inside that window.
 *
 * TWO MECHANISMS, deliberately, because each covers the other's gap:
 *
 *   NONCE (here)  catches an exact replay within the skew window. Cheap, and it
 *                 does not care about ordering.
 *   SEQUENCE      a monotonic counter per server, persisted in
 *                 `game_server_state.last_ingest_seq`. It survives this cache's
 *                 TTL and an API restart, which a memory-resident nonce set
 *                 cannot.
 *
 * A nonce cache alone would let a request captured now be replayed in an hour if
 * the clock skew check were ever widened. A sequence alone would let two
 * requests with the same seq through if one arrived before the other committed.
 * Together they are strict.
 *
 * IN-PROCESS, like the ticket store and the position store, and for the same
 * reason: Redis is not provisioned. Stated rather than discovered — with more
 * than one API process a nonce accepted by one is unknown to another, so the
 * SEQUENCE check is what actually holds under horizontal scale. That is the
 * order the checks are written in.
 */

export class NonceStore {
  private readonly seen = new Map<string, number>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly ttlMs = FIVEM_NONCE_TTL_SECONDS * 1000) {}

  /**
   * Records a nonce, reporting whether it was already known.
   *
   * Scoped by key id: two game servers picking the same random value must not
   * lock each other out, and there is no reason to share the namespace.
   */
  remember(keyId: string, nonce: string, now = Date.now()): boolean {
    const key = `${keyId}:${nonce}`;
    const expiresAt = this.seen.get(key);

    if (expiresAt !== undefined && expiresAt > now) return false;

    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  start(): void {
    if (this.sweeper !== null) return;
    // Expired nonces are refused on their own merits; this only stops the map
    // growing on a long-running process.
    this.sweeper = setInterval(() => this.sweep(), this.ttlMs);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}
