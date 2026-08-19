import type { MapSourceStatus } from '@leoos/contracts';

/**
 * Where unit positions come from.
 *
 * THIS IS THE SEAM the FiveM bridge plugs into. Everything above it — the
 * snapshot builder, the routes, the map screen — depends on this interface and
 * on the `LivePositionStore` it fills, never on how positions are produced.
 *
 * There are exactly two implementations planned:
 *
 *   MockPositionSource   simulated movement, for development and for every
 *                        environment where no game server exists. What ships
 *                        today.
 *   FiveMPositionSource  the bridge described in
 *                        docs/architecture/04-fivem-integration.md, reading
 *                        server-side natives and pushing samples in.
 *
 * The interface is deliberately narrow — start, stop, describe yourself — so
 * that the second implementation is a genuine drop-in rather than a rewrite of
 * everything that consumes it. In particular, nothing here returns positions:
 * a source PUSHES into the store, because a polling interface would force the
 * real bridge to buffer and would put per-request latency on the game server.
 */
export interface PositionSource {
  /** Names what this is, honestly. Reaches the UI as-is. */
  status(): MapSourceStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Chooses the position source for an environment.
 *
 * Engineering rules 34, 35 and 45: a mock is a mock. It is named `Mock*`, it
 * refuses to register in production without an explicit override, it logs a
 * warning at boot, and its status object says `kind: 'mock'` so the map screen
 * reports simulated movement instead of showing a green "live" indicator.
 *
 * The production refusal is not paranoia about a bad deploy. A dispatcher
 * looking at a map of units that are not really there, with nothing on screen
 * saying so, is the single most dangerous failure this system could have: it
 * looks exactly like working software.
 */
export function assertMockSourceAllowed(nodeEnv: string): void {
  if (nodeEnv === 'production' && process.env.ALLOW_MOCK_ADAPTERS !== 'true') {
    throw new Error(
      'No FiveM position bridge is configured. LEOOS refuses to start in production ' +
        'with simulated unit positions, because a map of units that are not really ' +
        'there is indistinguishable from a working one. Configure the bridge, or set ' +
        'ALLOW_MOCK_ADAPTERS=true to accept a simulated map.',
    );
  }
}
