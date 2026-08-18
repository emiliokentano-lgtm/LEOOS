import type { Metadata } from 'next';
import { getSession, getActiveOrganization } from '@/lib/session';
import { DashboardView } from './dashboard-view';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const [session, organization] = await Promise.all([getSession(), getActiveOrganization()]);
  return <DashboardView session={session} organization={organization} />;
}
