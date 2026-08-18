'use client';

import * as React from 'react';
import { Bell, Download, Plus, Trash2 } from 'lucide-react';
import { DUTY_STATUS_LIST, INCIDENT_STATUSES, PRIORITY_LIST, type IncidentStatusKey } from '@leoos/contracts';
import {
  Alert, Avatar, Badge, Button, Checkbox, ConfirmationDialog, DataTable, Drawer,
  DutyStatusBadge, EmptyState, ErrorState, Field, IconButton, IncidentStatusBadge,
  Input, LoadingState, Modal, OrgBadge, Pagination, Panel, PanelHeader, PriorityBadge,
  SearchInput, Select, Skeleton, Tabs, TabsList, TabsTrigger, Textarea, Toggle,
  Tooltip, useToast, type AsyncResource, type Column,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { MOCK_ORGANIZATIONS } from '@/mocks/organizations';

/**
 * Living reference for the design system.
 *
 * Its job is to make reuse cheaper than reinvention: a future module author can
 * see every available pattern in one place. It also doubles as the visual
 * regression surface — every token and component renders here, so an
 * inconsistency shows up immediately.
 */
export function DesignView() {
  const { push } = useToast();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);

  return (
    <PageContainer>
      <div className="flex max-w-5xl flex-col gap-3">
        <Alert tone="info" title="Design system reference">
          Every visual pattern in LEOOS. Modules extend this set rather than styling their
          own — if a pattern is missing here, it gets added here first.
        </Alert>

        <Section title="Surfaces">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['base', 'bg-base'], ['surface', 'bg-surface'], ['raised', 'bg-raised'],
              ['overlay', 'bg-overlay'], ['hover', 'bg-hover'], ['active', 'bg-active'],
            ].map(([name, cls]) => (
              <div key={name} className="flex flex-col gap-1">
                <div className={`h-12 rounded-xs border border-border ${cls}`} />
                <span className="font-mono text-2xs text-text-tertiary">{name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Text">
          <div className="flex flex-col gap-1">
            <p className="text-text-primary">Primary — operational content</p>
            <p className="text-text-secondary">Secondary — supporting detail</p>
            <p className="text-text-tertiary">Tertiary — labels and metadata</p>
            <p className="text-text-disabled">Disabled — unavailable</p>
            <p className="font-mono text-text-primary">Mono — 3-ADAM-12 · 44XKM921 · 2026-08-000431</p>
          </div>
        </Section>

        <Section title="Duty status" description="Colour, icon and label — never colour alone.">
          <div className="flex flex-wrap gap-2">
            {DUTY_STATUS_LIST.map((s) => <DutyStatusBadge key={s.key} status={s.key} />)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {DUTY_STATUS_LIST.map((s) => <DutyStatusBadge key={s.key} status={s.key} display="short" />)}
          </div>
        </Section>

        <Section title="Incident priority & status">
          <div className="flex flex-wrap items-center gap-2">
            {PRIORITY_LIST.map((p) => <PriorityBadge key={p.value} priority={p.value} />)}
            {PRIORITY_LIST.map((p) => <PriorityBadge key={`o${p.value}`} priority={p.value} variant="outline" />)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(INCIDENT_STATUSES) as IncidentStatusKey[]).map((k) => (
              <IncidentStatusBadge key={k} status={k} />
            ))}
          </div>
        </Section>

        <Section title="Organization identity" description="Colours come from the database row, never a stylesheet.">
          <div className="flex flex-wrap gap-2">
            {MOCK_ORGANIZATIONS.map((o) => <OrgBadge key={o.id} shortName={o.shortName} color={o.color} />)}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger-outline">Danger outline</Button>
            <Button variant="link">Link</Button>
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs">Extra small</Button>
            <Button size="sm"><Plus aria-hidden /> Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <IconButton label="Notifications"><Bell aria-hidden /></IconButton>
            <IconButton label="Download" variant="secondary"><Download aria-hidden /></IconButton>
            <IconButton label="Delete" variant="danger"><Trash2 aria-hidden /></IconButton>
          </div>
        </Section>

        <Section title="Inputs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Text" htmlFor="d1" hint="A helpful hint.">
              <Input id="d1" placeholder="Placeholder" />
            </Field>
            <Field label="Invalid" htmlFor="d2" error="This field is required.">
              <Input id="d2" invalid defaultValue="Bad value" />
            </Field>
            <Field label="Select" htmlFor="d3">
              <Select
                id="d3"
                options={DUTY_STATUS_LIST.map((s) => ({ value: s.key, label: s.label }))}
                placeholder="Choose a status"
              />
            </Field>
            <Field label="Search" htmlFor="d4">
              <SearchInput value={search} onValueChange={setSearch} shortcut="/" />
            </Field>
            <Field label="Textarea" htmlFor="d5" className="sm:col-span-2">
              <Textarea id="d5" placeholder="Incident notes…" />
            </Field>
          </div>
          <div className="mt-3 flex flex-col gap-2.5">
            <Checkbox label="Checkbox" description="With a description line." />
            <Checkbox label="Disabled" disabled />
            <Toggle label="Toggle" description="Switches a setting." />
          </div>
        </Section>

        <Section title="Badges & avatars">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Neutral</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="danger">Danger</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="accent">Accent</Badge>
            <Badge mono>MONO-01</Badge>
            <Avatar name="Jordan Mercer" size="sm" />
            <Avatar name="Jordan Mercer" size="md" ringColor="#3b82d9" />
            <Avatar name="Dana Whitfield" size="lg" />
          </div>
        </Section>

        <Section title="Alerts">
          <div className="flex flex-col gap-2">
            <Alert tone="info" title="Informational">Something worth knowing.</Alert>
            <Alert tone="success" title="Completed">The operation finished.</Alert>
            <Alert tone="warning" title="Attention required">Three calls await assignment.</Alert>
            <Alert tone="danger" title="Failed">The request could not be completed.</Alert>
            <Alert tone="critical" title="Panic activated">3-ADAM-12 at Legion Square.</Alert>
          </div>
        </Section>

        <Section title="Async states" description="Every data region renders all four.">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel flush><PanelHeader title="Loading" /><LoadingState rows={4} /></Panel>
            <Panel flush>
              <PanelHeader title="Empty" />
              <EmptyState title="No records" description="Nothing exists yet." action={<Button size="sm">Create one</Button>} />
            </Panel>
            <Panel flush>
              <PanelHeader title="Filtered empty" />
              <EmptyState variant="filtered" title="No matches" description="Try widening the filters." />
            </Panel>
            <Panel flush>
              <PanelHeader title="Error" />
              <ErrorState message="The API did not respond." requestId="req_8f21ac" onRetry={() => {}} />
            </Panel>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setModalOpen(true)}>Open modal</Button>
            <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
            <Button variant="danger-outline" onClick={() => setConfirmOpen(true)}>Destructive confirm</Button>
            <Button onClick={() => push({ tone: 'success', title: 'Saved', description: 'Changes stored.' })}>
              Toast: success
            </Button>
            <Button onClick={() => push({ tone: 'danger', title: 'Request failed', description: 'Does not auto-dismiss.' })}>
              Toast: danger
            </Button>
            <Tooltip content="Tooltips explain, they never hide anything essential" shortcut="?">
              <Button variant="ghost">Hover me</Button>
            </Tooltip>
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="a">
            <TabsList>
              <TabsTrigger value="a" count={12}>Open</TabsTrigger>
              <TabsTrigger value="b" count={3}>Unassigned</TabsTrigger>
              <TabsTrigger value="c">Closed</TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section title="DataTable" description="One table implementation for every list in the product.">
          <Panel flush>
            <DemoTable />
            <div className="border-t border-border-subtle">
              <Pagination page={page} pageSize={25} totalItems={128} onPageChange={setPage} onPageSizeChange={() => {}} />
            </div>
          </Panel>
        </Section>
      </div>

      <Modal
        open={modalOpen} onOpenChange={setModalOpen}
        title="Modal title" description="Supporting description."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={() => setModalOpen(false)}>Confirm</Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          Modals are for focused decisions. Anything longer belongs on a page.
        </p>
      </Modal>

      <Drawer
        open={drawerOpen} onOpenChange={setDrawerOpen}
        title="Drawer title" description="Detail panel for a selected record."
      >
        <div className="p-4 text-sm text-text-secondary">
          Drawers hold detail for a record selected from a list, keeping the list in place.
        </div>
      </Drawer>

      <ConfirmationDialog
        open={confirmOpen} onOpenChange={setConfirmOpen}
        title="Terminate membership?" tone="danger" confirmLabel="Terminate"
        description="This ends the member's access to this organization immediately."
        consequences={
          <ul className="list-inside list-disc space-y-0.5">
            <li>Revoke all organization permissions</li>
            <li>Release their callsign for reuse</li>
            <li>Preserve the personnel record — nothing is deleted</li>
          </ul>
        }
        confirmationPhrase="TERMINATE"
        onConfirm={() => { push({ tone: 'success', title: 'Demo only', description: 'No action was taken.' }); }}
      />
    </PageContainer>
  );
}

interface DemoRow { id: string; callsign: string; officer: string; status: string }

function DemoTable() {
  const data: DemoRow[] = [
    { id: '1', callsign: '3-ADAM-12', officer: 'Jordan Mercer', status: 'On Scene' },
    { id: '2', callsign: '2-LINCOLN-4', officer: 'Dana Whitfield', status: 'Available' },
    { id: '3', callsign: 'AIR-1', officer: 'Priya Raman', status: 'In Operation' },
  ];
  const resource: AsyncResource<DemoRow[]> = { status: 'success', data };
  const columns: Column<DemoRow>[] = [
    { id: 'callsign', header: 'Callsign', mono: true, width: '140px', sortable: true, cell: (r) => r.callsign },
    { id: 'officer', header: 'Officer', cell: (r) => r.officer },
    { id: 'status', header: 'Status', align: 'right', width: '140px', cell: (r) => r.status },
  ];
  return <DataTable caption="Demonstration table" columns={columns} resource={resource} rowKey={(r) => r.id} />;
}

function Section({ title, description, children }: {
  title: string; description?: string; children: React.ReactNode;
}) {
  return (
    <Panel flush>
      <PanelHeader title={title} description={description} />
      <div className="p-3">{children}</div>
    </Panel>
  );
}
