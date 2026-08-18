import type { Metadata } from 'next';
import { Server, ShieldAlert, Users } from 'lucide-react';
import { Alert, Badge, Panel, PanelHeader } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { INTEGRATION_STATUS } from '@/lib/mock-flag';

export const metadata: Metadata = { title: 'Administration' };

/**
 * Administration.
 *
 * Integration state is reported honestly — every panel here shows "not
 * connected", never a success indicator, because nothing is connected yet
 * (engineering rules 35, 45).
 */
export default function AdminPage() {
  return (
    <PageContainer>
      <div className="flex max-w-4xl flex-col gap-3">
        <Alert tone="warning" title="Administration is not implemented">
          This screen shows the layout and the honest state of each integration. User,
          organization and game-server management land in Phase 8.
        </Alert>

        <Panel flush>
          <PanelHeader title="Integrations" icon={<Server />} />
          <ul>
            {Object.entries(INTEGRATION_STATUS).map(([key, info]) => (
              <li key={key} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0">
                <span className="size-2 shrink-0 rounded-full bg-text-disabled" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text-primary">{info.label}</p>
                  <p className="truncate text-2xs text-text-tertiary">{info.detail}</p>
                </div>
                <Badge variant="neutral">Not connected</Badge>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Panel flush>
            <PanelHeader title="User accounts" icon={<Users />} />
            <p className="p-3 text-xs text-text-secondary">
              Account administration, suspension and global capability grants. Requires the
              auth module (Phase 1) and the authorization kernel (Phase 2).
            </p>
          </Panel>
          <Panel flush>
            <PanelHeader title="Organization leads" icon={<ShieldAlert />} />
            <p className="p-3 text-xs text-text-secondary">
              Granting the Organization Lead capability is reserved to global
              administrators, and is deliberately separate from organization roles so it can
              never be self-granted by editing a role.
            </p>
          </Panel>
        </div>
      </div>
    </PageContainer>
  );
}
