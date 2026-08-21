import type { Metadata } from 'next';
import Link from 'next/link';
import type { Route } from 'next';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Alert, Badge, EmptyState, Panel, PanelHeader, Tooltip } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { requireAdminCapabilities } from '../guard';
import { fetchLeadOverview } from '@/lib/admin';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Organization Leads' };

/**
 * Who leads what, across every organization.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HALF THAT MATTERS IS THE EMPTY ONE
 *
 * A list of current leads is a report. The organizations with NOBODY leading
 * them is the thing an administrator has to act on, and it is invisible in a
 * list of grants — so it is shown first, as a warning, rather than being left
 * for somebody to notice by counting.
 *
 * Appointing and revoking happen on the organization's own screen, where the
 * eligible members are: a lead must already be an active member, so the choice
 * only makes sense with that organization's roster in view. This screen links
 * there rather than duplicating the control.
 * ────────────────────────────────────────────────────────────────────────────
 */
export default async function AdminLeadsPage() {
  await requireAdminCapabilities('canManageOrganizationLeads');
  const overview = await fetchLeadOverview();

  if (!overview) {
    return (
      <PageContainer>
        <Panel>
          <EmptyState
            title="Lead administration is unavailable"
            description="The API could not be reached, or your capabilities changed since this page loaded."
          />
        </Panel>
      </PageContainer>
    );
  }

  const byOrg = new Map<string, typeof overview.leads>();
  for (const lead of overview.leads) {
    const list = byOrg.get(lead.organization.id) ?? [];
    list.push(lead);
    byOrg.set(lead.organization.id, list);
  }

  return (
    <PageContainer>
      <div className="flex max-w-4xl flex-col gap-3">
        {overview.organizationsWithoutLead.length > 0 ? (
          <Alert
            tone="warning"
            title={`${overview.organizationsWithoutLead.length} organization(s) have no lead`}
          >
            <p className="mb-1.5">
              Nobody holds unbounded authority in these organizations. Ordinary permissions
              still apply, so they are not paralysed — but no one can act above their own
              rank, and promotions to the top of the hierarchy are impossible.
            </p>
            <ul className="flex flex-wrap gap-2">
              {overview.organizationsWithoutLead.map((org) => (
                <li key={org.id}>
                  <Link
                    href={`/admin/organizations?org=${org.id}` as Route}
                    className="text-accent hover:underline"
                  >
                    {org.shortName}
                  </Link>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Panel flush>
          <PanelHeader
            title="Organization Leads"
            icon={<ShieldCheck />}
            description="Unbounded inside their own organization, and holding nothing anywhere else"
            actions={<Badge variant="neutral" mono>{overview.leads.length}</Badge>}
          />

          {overview.leads.length === 0 ? (
            <EmptyState
              title="No leads appointed"
              description="Appoint one from an organization's own screen, where its members are listed."
            />
          ) : (
            <ul>
              {[...byOrg.entries()].map(([orgId, leads]) => (
                <li key={orgId}>
                  <p className="sticky top-0 z-1 flex items-center gap-2 bg-raised px-3 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                    <span
                      className="rounded-[2px] border px-1 text-[10px]"
                      style={{
                        borderColor: leads[0]!.organization.color,
                        color: leads[0]!.organization.color,
                      }}
                    >
                      {leads[0]!.organization.shortName}
                    </span>
                    {leads[0]!.organization.name}
                    <Link
                      href={`/admin/organizations?org=${orgId}` as Route}
                      className="ml-auto text-accent hover:underline"
                    >
                      Manage
                    </Link>
                  </p>
                  {leads.map((lead) => (
                    <div
                      key={`${lead.organization.id}-${lead.userId}`}
                      className="flex items-center gap-3 border-b border-border-subtle px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/admin/users/${lead.userId}` as Route}
                          className="truncate text-sm font-medium text-text-primary hover:text-accent"
                        >
                          {lead.displayName}
                        </Link>
                        <p className="truncate font-mono text-2xs text-text-tertiary">
                          {lead.username}
                          {lead.callsign ? ` · ${lead.callsign}` : ''}
                        </p>
                      </div>

                      {/*
                        * A lead on a suspended account is worth flagging.
                        *
                        * The grant is still live, so the organization looks led
                        * — but the person cannot sign in, which means in
                        * practice nobody is leading it.
                        */}
                      {lead.accountStatus !== 'active' ? (
                        <Tooltip content="This account cannot sign in, so nobody is exercising this authority">
                          <Badge size="sm" variant="danger">
                            <TriangleAlert aria-hidden /> account {lead.accountStatus}
                          </Badge>
                        </Tooltip>
                      ) : null}
                      {lead.membershipStatus !== 'active' ? (
                        <Badge size="sm" variant="warning">membership {lead.membershipStatus}</Badge>
                      ) : null}

                      <span className="shrink-0 text-right text-2xs text-text-tertiary">
                        since {formatDate(lead.grantedAt)}
                        {lead.grantedByName ? (
                          <span className="block">by {lead.grantedByName}</span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel flush>
          <PanelHeader title="Why this is not delegable" />
          <p className="p-3 text-xs text-text-secondary">
            Only a global administrator can appoint or revoke an Organization Lead. If leads
            could appoint leads the capability would be self-propagating, and “the global
            administrator decides who leads an organization” would stop being true after the
            first grant. That is why the grant is a row in its own table rather than a role
            or a permission — no amount of role editing inside an organization can reach it.
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}
