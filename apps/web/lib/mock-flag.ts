/**
 * Demo-mode flag (engineering rules 34, 35, 45).
 *
 * While true, every screen is backed by fixtures from `apps/web/mocks` and the
 * top bar shows a persistent "Demo data" indicator. It is never enabled in a
 * production build: the value is inlined at build time, and the production
 * deployment does not set the variable.
 */
export const IS_DEMO_DATA = process.env.NEXT_PUBLIC_LEOOS_DEMO === '1';

/** Integrations that exist only as placeholders in this phase. Surfaced in the
 *  UI as their real state rather than as a success indicator. */
export const INTEGRATION_STATUS = {
  api: { label: 'API', state: 'not-connected', detail: 'No backend — UI phase' },
  /**
   * The WebSocket transport has shipped, so this is no longer a fixed label —
   * the status bar reads the connection's actual state and prints that. This
   * entry survives as the tooltip text, and says what the fallback is rather
   * than implying the socket is the only path.
   */
  liveFeed: {
    label: 'Feed',
    state: 'partial',
    detail: 'Live updates over WebSocket, with revision polling as the fallback.',
  },
  fivem: { label: 'FiveM bridge', state: 'not-connected', detail: 'Bridge lands in Phase 7' },
  mail: { label: 'Mail', state: 'not-connected', detail: 'Console transport — not delivering' },
} as const;
