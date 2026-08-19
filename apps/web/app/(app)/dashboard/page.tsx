import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchDashboard } from '@/lib/dashboard';
import { DashboardView } from './dashboard-view';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Operational overview.
 *
 * The first snapshot is fetched server-side so the screen paints with the real
 * situation on it rather than a spinner that turns into it. Everything after
 * that arrives through the client data source.
 */
export default async function DashboardPage() {
  await requireSession();
  const snapshot = await fetchDashboard();

  return <DashboardView initialSnapshot={snapshot} />;
}
