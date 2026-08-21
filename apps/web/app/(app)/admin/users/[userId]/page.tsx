import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAdminCapabilities } from '../../guard';
import { fetchAdminUser, fetchAccountStatuses, fetchCapabilityCatalogue } from '@/lib/admin';
import { AdminUserDetailView } from './admin-user-detail-view';

export const metadata: Metadata = { title: 'Account' };

/**
 * One account, in full.
 *
 * The detail read is a separate request from the register on purpose: a search
 * across every account has no business shipping everyone's memberships, sign-in
 * address and capability grants to a browser.
 */
export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireAdminCapabilities('canAdministerUsers');
  const { userId } = await params;

  const [user, statuses, catalogue] = await Promise.all([
    fetchAdminUser(userId),
    fetchAccountStatuses(),
    fetchCapabilityCatalogue(),
  ]);

  // The API returns 404 for an id that does not exist AND for one the caller
  // may not read, so this page cannot be used to discover which accounts exist.
  if (!user) notFound();

  return <AdminUserDetailView user={user} statuses={statuses} catalogue={catalogue} />;
}
