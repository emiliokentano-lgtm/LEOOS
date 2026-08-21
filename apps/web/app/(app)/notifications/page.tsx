import type { Metadata } from 'next';
import { NotificationCentre } from './notification-centre';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * The notification centre.
 *
 * A CLIENT screen with no server-rendered data, which is unusual here and
 * deliberate: the shell already holds the operator's feed and badge for the bell
 * on every page, and rendering the first page again on the server would produce
 * two sources for the same list — the exact parallel-state problem the duty
 * status had before dispatch shipped (engineering rule 3).
 *
 * There is nothing to authorize at this level. Every route the screen calls
 * resolves its subject from the session, so a signed-in account sees its own
 * notifications and there is no version of this page that could show anybody
 * else's.
 */
export default function NotificationsPage() {
  return <NotificationCentre />;
}
