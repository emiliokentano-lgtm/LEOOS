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

  /**
   * A membership is NOT enough — `dispatch.view` is what the dashboard needs.
   *
   * An active member whose `dispatch.view` is denied has a membership and no
   * dashboard, and rendering the live view for them started a poll that could
   * only ever be refused. It reported "lost contact with the server" every few
   * seconds, on a screen that was working exactly as designed. So the first
   * snapshot is fetched here and its REFUSAL is treated as the answer it is.
   */
  const access = hasOrganization ? await fetchDashboard() : { kind: 'not-permitted' as const };

  if (!hasOrganization || access.kind === 'not-permitted') {
    return (
      <PageContainer>
        <Panel>
          <EmptyState
            icon={<ShieldCheck />}
            title="You have no operational dashboard"
            description={
              hasOrganization
                ? 'The dashboard shows one organization\'s incidents, units and '
                  + 'personnel, and this account does not hold the permission to view '
                  + 'dispatch. Ask your organization\'s command staff if you need it.'
                : 'The dashboard shows one organization\'s incidents, units and '
                  + 'personnel, and this account is not a member of one. That is normal '
                  + 'for an administrator: administration is not organization-scoped.'
            }
            action={
              hasOrganization ? null : (
                <Link
                  href={'/admin' as Route}
                  className="text-xs text-accent hover:underline"
                >
                  Go to administration
                </Link>
              )
            }
          />
        </Panel>
      </PageContainer>
    );
  }

  return (
    <DashboardView initialSnapshot={access.kind === 'ok' ? access.snapshot : null} />
  );
}
