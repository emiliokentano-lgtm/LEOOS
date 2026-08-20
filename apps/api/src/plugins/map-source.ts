import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import {
  InMemoryPositionStore, type LivePositionStore,
} from '../modules/map/sources/live-positions.js';
import { MockPositionSource } from '../modules/map/sources/mock-position-source.js';
import { FiveMPositionSource } from '../modules/fivem/fivem.source.js';
import type { PositionSource } from '../modules/map/sources/position-source.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Live unit positions. A Redis stand-in — see live-positions.ts. */
    mapPositions: LivePositionStore;
    /** Where those positions come from. Mock until the FiveM bridge lands. */
    mapSource: PositionSource;
  }
}

export interface MapSourceOptions {
  config: AppConfig;
  /** Injected by tests, which drive positions directly rather than simulating. */
  store?: LivePositionStore;
  source?: PositionSource;
}

/**
 * Registers the position feed.
 *
 * There is exactly one source per process and it is chosen here, at boot, rather
 * than per request — so there is one place to look to answer "is this map real?".
 *
 * The choice is EXPLICIT configuration (`POSITION_SOURCE`), not inference from
 * whether a game server happens to be registered. "Is this map real?" must be
 * answerable from configuration rather than from the current contents of a
 * table, and an installation that meant to be live must fail loudly when it is
 * not — which is what `assertMockSourceAllowed` does in production.
 *
 * The simulator is not started under NODE_ENV=test: a background timer mutating
 * unit positions while an authorization test asserts on them is a flake
 * generator, and every test that needs a position sets one explicitly.
 */
export default fp<MapSourceOptions>(async (app, opts) => {
  const store = opts.store ?? new InMemoryPositionStore();
  app.decorate('mapPositions', store);

  const source = opts.source ?? (
    opts.config.POSITION_SOURCE === 'fivem'
      ? new FiveMPositionSource({
        db: app.db,
        store,
        log: (message) => app.log.warn(message),
      })
      : new MockPositionSource({
        db: app.db,
        store,
        nodeEnv: opts.config.NODE_ENV,
        log: (message) => app.log.warn(message),
      })
  );
  app.decorate('mapSource', source);

  if (opts.config.NODE_ENV !== 'test') {
    await source.start();
  }

  /**
   * Prune on a slow timer so a long-lived process does not accumulate positions
   * for units that were disbanded hours ago. The map's own staleness rule stops
   * them being drawn long before this; this is about memory over an 8-hour
   * shift (docs/architecture/05-map.md §7).
   */
  const pruneTimer = setInterval(() => {
    store.prune(30 * 60_000);
  }, 5 * 60_000);
  pruneTimer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(pruneTimer);
    await source.stop();
  });
});
