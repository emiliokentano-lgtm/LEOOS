import type { Metadata } from 'next';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Building2, ScrollText, Server, ShieldAlert, ShieldCheck, Users,
} from 'lucide-react';
import { Alert, Badge, Panel, PanelHeader, StatTile } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { requireAdminCapabilities } from './guard';
import { fetchAdminUsers, fetchLeadOverview, fetchSystemStatus } from '@/lib/admin';

export const metadata: Metadata = { title: 'Administration' };

/**
 * The administration hub.
 *
 * Every tile is gated on the capability the screen behind it actually needs,
 * read from the API rather than from the session — so the menu and the
 * endpoints cannot drift apart. A screen never appears for somebody whose
 * requests it would refuse, and never hides from somebody whose requests would
 * succeed.
 *
 * The counts are real reads. An empty hub with four boxes saying "manage users"
 * tells an administrator nothing; "3 accounts awaiting an organization" and "2
 * organizations with no lead" tell them what to do next.
 */
export default async function AdminPage() {
  const capabilities = await requireAdminCapabilities();

  const [unaffiliated, leads, system] = await Promise.all([
    capabilities.canAdministerUsers
      ? fetchAdminUsers({ unaffiliated: true, status: 'active', limit: 1 })
      : Promise.resolve(null),
    capabilities.canManageOrganizationLeads ? fetchLeadOverview() : Promise.resolve(null),
    capabilities.canViewSystemConfiguration ? fetchSystemStatus() : Promise.resolve(null),
  ]);

  const mocked = system?.components.filter((c) => c.state === 'mock') ?? [];
  const absent = system?.components.filter((c) => c.state === 'absent') ?? [];

  const cards: {
    href: Route;
    label: string;
    icon: React.ReactNode;
    description: string;
    visible: boolean;
    badge?: { text: string; tone: 'warning' | 'neutral' };
  }[] = [
    {
      href: '/admin/users' as Route,
      label: 'User accounts',
      icon: <Users />,
      description: 'Search the register, read account detail, enable and disable accounts, '
        + 'and grant global capabilities.',
      visible: capabilities.canAdministerUsers,
      badge: unaffiliated && unaffiliated.total > 0
        ? { text: `${unaffiliated.total} without an organization`, tone: 'warning' }
        : undefined,
    },
    {
      href: '/admin/organizations' as Route,
      label: 'Organizations',
      icon: <Building2 />,
      description: 'Create, edit and archive organizations.',
      visible: capabilities.canAdministerOrganizations,
    },
    {
      href: '/admin/leads' as Route,
      label: 'Organization Leads',
      icon: <ShieldCheck />,
      description: 'Who leads each organization, and which organizations have nobody.',
      visible: capabilities.canManageOrganizationLeads,
      badge: leads && leads.organizationsWithoutLead.length > 0
        ? { text: `${leads.organizationsWithoutLead.length} without a lead`, tone: 'warning' }
        : undefined,
    },
    {
      href: '/admin/permissions' as Route,
      label: 'Permissions',
      icon: <ShieldAlert />,
      description: 'Every permission, the roles that grant it and how many people hold it.',
      visible: capabilities.canViewPermissionOverview,
    },
    {
      href: '/audit' as Route,
      label: 'Audit log',
      icon: <ScrollText />,
      description: 'Searchable, append-only record of every security-sensitive action.',
      visible: capabilities.canViewAuditLog,
    },
    {
      href: '/admin/system' as Route,
      label: 'System configuration',
      icon: <Server />,
      description: 'What this installation is running, and which integrations are live.',
      visible: capabilities.canViewSystemConfiguration,
      badge: mocked.length + absent.length > 0
        ? { text: `${mocked.length + absent.length} not live`, tone: 'warning' }
        : undefined,
    },
  ];

  const visible = cards.filter((c) => c.visible);

  return (
    <PageContainer>
      <div className="flex max-w-5xl flex-col gap-3">
        {/*
          * The honest state of the installation, before anything else.
          *
          * An administrator arriving here needs to know that password resets are
          * going to a log file BEFORE they suspend somebody and tell them to
          * reset their password (engineering rules 35, 45).
          */}
        {mocked.length > 0 ? (
          <Alert tone="warning" title={`${mocked.length} integration(s) are not connected`}>
            {mocked.map((c) => c.label).join(', ')} — running on placeholder adapters.
            Nothing they would deliver is being delivered.{' '}
            <Link href={'/admin/system' as Route} className="text-accent hover:underline">
              See system configuration
            </Link>
            .
          </Alert>
        ) : null}

        {system ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Accounts" value={String(system.scale.users)} />
            <StatTile label="Active accounts" value={String(system.scale.activeUsers)} />
            <StatTile label="Organizations" value={String(system.scale.organizations)} />
            <StatTile
              label="Audit entries"
              value={`≈ ${system.scale.auditEntries.toLocaleString('en-US')}`}
              hint="Estimated — an exact count over an append-only log is a scan for a figure that is stale on arrival."
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="rounded-md border border-border-subtle bg-surface p-4 transition-colors hover:border-border-strong"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-text-tertiary [&_svg]:size-4">{card.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">{card.label}</span>
                    {card.badge ? (
                      <Badge variant={card.badge.tone === 'warning' ? 'warning' : 'neutral'} size="sm">
                        {card.badge.text}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">{card.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <Panel flush>
          <PanelHeader title="What you hold" icon={<ShieldCheck />} />
          <p className="p-3 text-xs text-text-secondary">
            This panel shows only what your global capabilities permit. Capabilities live in
            their own table and cannot be granted by editing an organization role — which is
            what stops leading an organization from becoming administering the system. An
            Organization Lead reaches none of these screens, however senior they are inside
            their own agency.
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}
