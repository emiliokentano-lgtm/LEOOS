/**
 * Demo-mode flag (engineering rules 34, 35, 45).
 *
 * While true, the shell shows a persistent "Demo data" indicator. It is never
 * enabled in a production build: the value is inlined at build time and the
 * production deployment does not set the variable.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS REMOVED, AND WHY IT MATTERED
 *
 * This file also exported an `INTEGRATION_STATUS` catalogue describing each
 * integration's state. It was written in the UI phase and never revisited, so
 * by the time the product was finished it was asserting:
 *
 *   api    'No backend — UI phase'      (the API had shipped)
 *   fivem  'Bridge lands in Phase 7'    (the bridge had shipped)
 *
 * and the status bar was rendering the second one as a permanent
 * "FiveM not connected" chip on every page. A hard-coded status is not a status.
 * Every surface that reports an integration now reads its ACTUAL state from the
 * API — `MapSourceStatus` for the bridge, the socket's own state for the feed,
 * the admin system screen for the mail transport.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const IS_DEMO_DATA = process.env.NEXT_PUBLIC_LEOOS_DEMO === '1';
