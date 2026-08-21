import fp from 'fastify-plugin';
import { purgeOldNotifications } from '../modules/notifications/notification.service.js';
import { purgeExpiredSessions } from '../modules/auth/session.service.js';

/**
 * Retention.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO TABLES THAT GROW PER OPERATOR AND WERE NEVER SWEPT
 *
 * `purgeOldNotifications` and `purgeExpiredSessions` both existed, both were
 * correct, and neither had a caller. So `notification` — which takes a row per
 * recipient per event, and is therefore the fastest-growing table in the system
 * — grew forever, and `session` accumulated every expired row since install.
 *
 * The cost of that is not disk. It is the BADGE QUERY: an unread count is a
 * partial-index scan whose index keeps growing with rows the partial predicate
 * excludes, and every operator runs it every thirty seconds on every screen.
 *
 * WHAT IS AND IS NOT DELETED:
 *
 *   · READ notifications past the window go. Unread ones NEVER go by age —
 *     somebody back from two weeks off still needs to see that they were
 *     assigned to something.
 *   · EXPIRED sessions go, and revoked ones after thirty days. A revoked
 *     session is evidence for that long, then it is noise.
 *   · The AUDIT LOG is not touched, by anything, ever. It is the legal record
 *     and it is append-only by database trigger — see migration 0009.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY AN IN-PROCESS TIMER RATHER THAN A CRON
 *
 * Stated rather than discovered, like the other single-node decisions here: with
 * more than one API instance every instance runs this, and the sweeps race. They
 * are idempotent deletes so racing is harmless — the loser deletes nothing — but
 * it is wasted work, and the right home for this is a scheduled job once one
 * exists. It runs OFF THE HOT PATH either way: hourly, unref'd, and never during
 * the first minute after boot, when the process has better things to do.
 */

export interface RetentionOptions {
  /** How often to sweep. Hourly is far more often than the window needs. */
  intervalMs?: number;
  /** Read notifications older than this are deleted. */
  notificationDays?: number;
  enabled?: boolean;
}

export default fp<RetentionOptions>(async (app, opts) => {
  const intervalMs = opts.intervalMs ?? 60 * 60_000;
  const notificationDays = opts.notificationDays ?? 30;

  // Off in tests: a background delete racing a suite that counts rows is a
  // flake, and the functions have their own tests.
  const enabled = opts.enabled ?? app.config.NODE_ENV !== 'test';
  if (!enabled) return;

  const sweep = async (): Promise<void> => {
    try {
      const notifications = await purgeOldNotifications(app.db, notificationDays);
      const sessions = await purgeExpiredSessions(app.db);
      if (notifications > 0 || sessions > 0) {
        app.log.info(
          { notifications, sessions },
          'retention sweep',
        );
      }
    } catch (error) {
      // Never fatal. A failed sweep is a table that stays large for an hour.
      app.log.warn({ err: error }, 'retention sweep failed');
    }
  };

  const first = setTimeout(() => { void sweep(); }, 60_000);
  first.unref?.();

  const timer = setInterval(() => { void sweep(); }, intervalMs);
  timer.unref?.();

  app.addHook('onClose', async () => {
    clearTimeout(first);
    clearInterval(timer);
  });
});
