import type { Metadata } from 'next';
import { requireActiveOrganization } from '@/lib/session';
import { DashboardView } from './dashboard-view';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const { session, organization } = await requireActiveOrganization();
  return <DashboardView session={session} organization={organization} />;
}
