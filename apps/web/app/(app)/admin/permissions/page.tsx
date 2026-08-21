import type { Metadata } from 'next';
import { requireAdminCapabilities } from '../guard';
import { fetchPermissionOverview } from '@/lib/admin';
import { PermissionOverviewView } from './permission-overview-view';

export const metadata: Metadata = { title: 'Permissions' };

/**
 * Where every permission is actually in force.
 *
 * The catalogue alone answers "what permissions exist", which nobody asks. The
 * question an administrator has is "who can terminate members right now", and
 * that is a join across roles, organizations and memberships — computed
 * server-side and delivered whole.
 */
export default async function AdminPermissionsPage() {
  await requireAdminCapabilities('canViewPermissionOverview');
  const overview = await fetchPermissionOverview();
  return <PermissionOverviewView overview={overview} />;
}
