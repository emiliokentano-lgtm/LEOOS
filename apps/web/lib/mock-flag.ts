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
  liveFeed: { label: 'Live feed', state: 'not-connected', detail: 'WebSocket lands in Phase 5' },
  fivem: { label: 'FiveM bridge', state: 'not-connected', detail: 'Bridge lands in Phase 7' },
  mail: { label: 'Mail', state: 'not-connected', detail: 'Console transport — not delivering' },
} as const;
