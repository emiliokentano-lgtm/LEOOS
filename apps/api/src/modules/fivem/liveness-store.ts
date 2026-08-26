import { FIVEM_POSITION_TTL_MS } from '@leoos/contracts';

/**
 * Whether the game last saw a player alive.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND MORE IMPORTANTLY WHAT IT IS NOT
 *
 * LEOOS cannot observe a player's health. It has no view into the game world at
 * all. What it has is a game server that ASSERTS liveness with a server-side
 * native, in exactly the same trust class as the coordinates it asserts — and a
 * compromised game server can lie about both.
 *
 * So this store does not answer "is this player alive". It answers "what did the
 * game server last tell us", which is a different and weaker claim, and every
 * caller is written against the weaker one. See
 * docs/architecture/04-fivem-integration.md §1.
 *
 * A browser has nowhere to write here. No session-authenticated route carries a
 * liveness field, and `fivem.test.ts` asserts it.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * KEYED BY FIVEM IDENTIFIER, not by unit or by user. A player who is not crewed
 * into a unit still has a body, and liveness is a fact about the body. It is
 * also what the panic path has in hand at the moment it needs the answer.
 *
 * In-process, like every other live store here, and wrong on two nodes for the
 * same reason.
 */
interface Entry {
  down: boolean;
  at: number;
}

/**
 * How long a liveness report stays meaningful.
 *
 * The SAME constant the map uses to decide a unit has gone offline — not a
 * matching number, the same one. A report older than this describes a player
 * the rest of the system has already stopped believing in, and treating it as
 * current would let one stale sample suppress a panic minutes later.
 */
export const LIVENESS_TTL_MS = FIVEM_POSITION_TTL_MS;

export class LivenessStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs = LIVENESS_TTL_MS) {}

  /**
   * Called from telemetry ingest.
   *
   * A sample that OMITS the field records nothing, rather than coercing to
   * `false`. A stored `false` would be an assertion the game server never made,
   * and an older bridge sends no liveness at all.
   */
  set(identifier: string, down: boolean | null | undefined, now = Date.now()): void {
    if (down === null || down === undefined) return;
    this.entries.set(identifier, { down, at: now });
  }

  /**
   * `true` only when the game server RECENTLY said this player was down.
   *
   * Unknown and stale both return false, and that direction is deliberate.
   * This gates a panic button: refusing on absent information would mean a
   * telemetry gap silences somebody's alarm, which is a far worse failure than
   * a dead player managing to send one. The consequence is stated plainly in
   * the FiveM document rather than left for somebody to find.
   */
  isDown(identifier: string, now = Date.now()): boolean {
    const entry = this.entries.get(identifier);
    if (entry === undefined) return false;
    if (now - entry.at >= this.ttlMs) return false;
    return entry.down;
  }

  /** Dropped on disconnect, so a rejoining player starts with no assertion. */
  forget(identifier: string): void {
    this.entries.delete(identifier);
  }

  /**
   * Drops expired entries.
   *
   * Called from the ingest path rather than a timer, like the position flush:
   * an installation with no game server reporting does no work at all.
   */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [identifier, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) {
        this.entries.delete(identifier);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
