import type { Metadata } from 'next';
import { CircleCheck, CircleSlash, Server, TriangleAlert } from 'lucide-react';
import { Alert, Badge, EmptyState, Panel, PanelHeader, StatTile } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { requireAdminCapabilities } from '../guard';
import { fetchSystemStatus } from '@/lib/admin';

export const metadata: Metadata = { title: 'System configuration' };

/**
 * What this installation is running.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND THAT IS THE POINT
 *
 * Editing a deployment's configuration from inside the application it
 * configures is a bootstrapping problem wearing a feature's clothes: the
 * database URL and the signing keys have to be right before the process can
 * serve the screen that would edit them. And a setting changeable from a
 * browser is a setting an attacker with a session can change.
 *
 * So this reports what is in force, names where each value comes from, and
 * stops. Every component shows the state it HAS — an adapter behind a mock says
 * so in the same words the boot log uses, never a green light it has not earned
 * (engineering rules 35, 45).
 * ────────────────────────────────────────────────────────────────────────────
 */

const STATE: Record<string, {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  icon: React.ReactNode;
}> = {
  live: { label: 'Live', tone: 'success', icon: <CircleCheck /> },
  mock: { label: 'Placeholder', tone: 'warning', icon: <TriangleAlert /> },
  degraded: { label: 'Degraded', tone: 'warning', icon: <TriangleAlert /> },
  absent: { label: 'Not configured', tone: 'neutral', icon: <CircleSlash /> },
};

export default async function AdminSystemPage() {
  await requireAdminCapabilities('canViewSystemConfiguration');
  const status = await fetchSystemStatus();

  if (!status) {
    return (
      <PageContainer>
        <Panel>
          <EmptyState
            title="System configuration is unavailable"
            description="Reading it is reserved to global administrators, or the API could not be reached."
          />
        </Panel>
      </PageContainer>
    );
  }

  const notLive = status.components.filter((c) => c.state !== 'live');

  return (
    <PageContainer>
      <div className="flex max-w-4xl flex-col gap-3">
        {/*
          * A production process running placeholder adapters is a deployment
          * fault, and the boot log already warns about it. Saying so here too
          * means an administrator finds out from the screen they are looking at
          * rather than from a log nobody reads.
          */}
        {status.environment === 'production' && status.mockAdaptersAllowed ? (
          <Alert tone="danger" title="Mock adapters are permitted in production">
            ALLOW_MOCK_ADAPTERS is set. Placeholder integrations are running in a production
            process — anything they would deliver is not being delivered.
          </Alert>
        ) : null}

        {notLive.length > 0 ? (
          <Alert tone="warning" title={`${notLive.length} component(s) are not live`}>
            {notLive.map((c) => c.label).join(', ')}. Each is described below with what it
            means in practice and where the setting lives.
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Environment" value={status.environment} />
          <StatTile label="Accounts" value={String(status.scale.users)}
            hint={`${status.scale.activeUsers} active`} />
          <StatTile label="Organizations" value={String(status.scale.organizations)} />
          <StatTile
            label="Audit entries"
            value={`≈ ${status.scale.auditEntries.toLocaleString('en-US')}`}
            hint="Planner estimate. An exact count over an append-only log is a full scan for a number that is stale on arrival."
          />
        </div>

        <Panel flush>
          <PanelHeader
            title="Components"
            icon={<Server />}
            description="Read-only. Changing any of these is a deployment action."
          />
          <ul>
            {status.components.map((component) => {
              const meta = STATE[component.state] ?? STATE.absent!;
              return (
                <li
                  key={component.key}
                  className="flex items-start gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                >
                  <span className={`mt-0.5 shrink-0 [&_svg]:size-3.5 ${
                    meta.tone === 'success' ? 'text-success'
                      : meta.tone === 'warning' ? 'text-warning' : 'text-text-disabled'
                  }`}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-text-primary">
                        {component.label}
                      </span>
                      <Badge size="sm" variant={meta.tone}>{meta.label}</Badge>
                    </div>
                    <p className="mt-0.5 text-2xs text-text-secondary">{component.detail}</p>
                    {component.source ? (
                      <p className="mt-0.5 font-mono text-2xs text-text-disabled">
                        {component.source}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel flush>
          <PanelHeader title="Why nothing here is editable" />
          <p className="p-3 text-xs text-text-secondary">
            Configuration is read at boot and validated before the process accepts traffic —
            the API refuses to start on a missing secret rather than failing at first use.
            Editing it from here would mean the application could change the values it
            depends on to run, and would put the deployment&rsquo;s secrets one session away from
            a browser. Change them where they live, and restart.
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}
