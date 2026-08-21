import type { Metadata } from 'next';
import Link from 'next/link';
import type { Route } from 'next';
import { ShieldCheck } from 'lucide-react';
import { EmptyState, Panel } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
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
  const session = await requireSession();

  /**
   * An administrator with no membership has no dashboard, and that is not an
   * error.
   *
   * The dashboard is organization-scoped: its incidents, units and personnel all
   * belong to the operator's own agency. A global administrator legitimately has
   * none. Rendering the live view for them would start a poll that can only fail
   * and report "lost contact with the server" — which is untrue, and sends
   * somebody looking for an outage that is not there.
   */
  const hasOrganization = session.memberships.some(
    (m) => m.organization.id === session.organizationId && m.status === 'active',
  );

  if (!hasOrganization) {
    return (
      <PageContainer>
        <Panel>
          <EmptyState
            icon={<ShieldCheck />}
            title="You have no operational dashboard"
            description={
              'The dashboard shows one organization\'s incidents, units and personnel, '
              + 'and this account is not a member of one. That is normal for an '
              + 'administrator: administration is not organization-scoped.'
            }
            action={
              <Link
                href={'/admin' as Route}
                className="text-xs text-accent hover:underline"
              >
                Go to administration
              </Link>
            }
          />
        </Panel>
      </PageContainer>
    );
  }

  const snapshot = await fetchDashboard();

  return <DashboardView initialSnapshot={snapshot} />;
}
