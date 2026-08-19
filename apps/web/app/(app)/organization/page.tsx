import type { Metadata } from 'next';
import { Building2 } from 'lucide-react';
import { requireActiveOrganization } from '@/lib/session';
import { ORGANIZATION_CATEGORIES } from '@leoos/contracts';
import { Badge, Panel, PanelHeader, StatTile } from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { MOCK_MEMBERS, MOCK_ROLES } from '@/mocks/operations';

export const metadata: Metadata = { title: 'Organization' };

export default async function OrganizationPage() {
  const { session, organization: org } = await requireActiveOrganization();
  const category = ORGANIZATION_CATEGORIES[org.category];

  return (
    <PageContainer>
      <div className="flex max-w-4xl flex-col gap-3">
        <Panel flush>
          <PanelHeader title="Organization profile" icon={<Building2 />} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-3 sm:grid-cols-2">
            <Row label="Name" value={org.name} />
            <Row label="Short name" value={org.shortName} mono />
            <Row label="Key" value={org.key} mono />
            <Row label="Category" value={category.label} />
            <div className="flex flex-col gap-1">
              <dt className="text-2xs uppercase tracking-wide text-text-tertiary">Identity colour</dt>
              <dd className="flex items-center gap-2">
                <span className="size-4 rounded-xs border border-border" style={{ backgroundColor: org.color }} aria-hidden />
                <span className="font-mono text-xs text-text-primary">{org.color}</span>
              </dd>
            </div>
            <Row label="Your role" value={session.roleName} />
          </dl>
        </Panel>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Members" value={MOCK_MEMBERS.length} />
          <StatTile label="Roles" value={MOCK_ROLES.length} />
          <StatTile label="On duty" value={MOCK_MEMBERS.filter((m) => m.status !== 'off_duty').length} />
          <StatTile label="Rank levels" value={`${Math.min(...MOCK_ROLES.map((r) => r.hierarchyLevel))}–${Math.max(...MOCK_ROLES.map((r) => r.hierarchyLevel))}`} />
        </div>

        <Panel>
          <p className="text-xs text-text-secondary">
            Organizations are database rows, not code. Adding a seventh organization is an
            insert plus a role seed — no component, stylesheet or authorization path changes.
            The identity colour above is read from the record, which is why nothing here is
            hardcoded per organization.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Badge variant="outline">data-driven</Badge>
            <Badge variant="outline">no hardcoded keys</Badge>
          </div>
        </Panel>
      </div>
    </PageContainer>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className={`text-xs text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
