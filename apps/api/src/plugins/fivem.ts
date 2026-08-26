import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import { SecretBox } from '../lib/secret-box.js';
import { NonceStore } from '../modules/fivem/nonce-store.js';
import { FiveMCommandQueue } from '../modules/fivem/command-queue.js';
import { LivenessStore } from '../modules/fivem/liveness-store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Replay protection for signed ingest requests. */
    fivemNonces: NonceStore;
    /**
     * Encrypts and decrypts ingest secrets. Null when no key is configured, in
     * which case credentials can be neither issued nor verified — and both paths
     * say so rather than degrading.
     */
    secretBox: SecretBox | null;
    /** Decides when the Postgres position cache is due a write. */
    fivemFlush: FlushClock;
    /**
     * Things LEOOS wants a game client to do, waiting for that game server's
     * next request. The ONLY path from the API into a game — there is no
     * inbound endpoint on the game host.
     */
    fivemCommands: FiveMCommandQueue;
    /**
     * What the game server last said about whether a player is dead or dying.
     * An assertion LEOOS records, never a fact it verifies.
     */
    fivemLiveness: LivenessStore;
  }
}

/**
 * How often the `unit.pos_*` cache is written.
 *
 * Telemetry arrives at 1 Hz and every tick goes to the in-memory store, which is
 * the live truth. Postgres gets a flush at a fraction of that rate: writing
 * positions at 1 Hz across a shift is the ~13M rows/day that engineering rules
 * 21 and 22 exist to prevent. What the cache is for is surviving a restart and
 * rendering a cold page load before the first socket batch arrives — neither of
 * which needs second-by-second accuracy.
 */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * A clock, not a timer.
 *
 * The flush is driven by the ingest request that happens to arrive after the
 * interval elapsed, rather than by a background timer. That means no work
 * happens when no game server is reporting — a quiet installation writes
 * nothing at all — and it keeps the write on the same path as the data, so a
 * flush can never race a tick that is still being processed.
 */
export class FlushClock {
  private lastFlushAt = 0;

  constructor(private readonly intervalMs = FLUSH_INTERVAL_MS) {}

  due(now = Date.now()): boolean {
    if (now - this.lastFlushAt < this.intervalMs) return false;
    this.lastFlushAt = now;
    return true;
  }
}

export interface FiveMPluginOptions {
  config: AppConfig;
}

export default fp<FiveMPluginOptions>(async (app, opts) => {
  const nonces = new NonceStore();
  nonces.start();
  app.decorate('fivemNonces', nonces);

  /**
   * Built at boot so a bad key is a start-up failure rather than a runtime one.
   *
   * `SecretBox.fromBase64` throws on a key that is the wrong length or not
   * base64 — a misconfiguration that would otherwise surface as every game
   * server failing to authenticate, which reads like a bug in the resource.
   */
  const secretBox = SecretBox.fromBase64(opts.config.LEOOS_FIVEM_SECRET_KEY);
  app.decorate('secretBox', secretBox);
  app.decorate('fivemFlush', new FlushClock());
  app.decorate('fivemCommands', new FiveMCommandQueue());
  app.decorate('fivemLiveness', new LivenessStore());

  if (opts.config.POSITION_SOURCE === 'fivem' && secretBox === null) {
    // Belt and braces: `loadConfig` already refuses this combination. Repeated
    // here because the consequence — an ingest surface that authenticates
    // nobody — is quiet enough to deserve two guards.
    throw new Error('POSITION_SOURCE=fivem requires LEOOS_FIVEM_SECRET_KEY.');
  }

  app.addHook('onClose', async () => {
    nonces.stop();
  });
});
