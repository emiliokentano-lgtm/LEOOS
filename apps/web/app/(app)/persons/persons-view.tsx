'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleUser, Plus, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  Alert, Badge, Button, DataTable, EmptyState, FilterBar, FilterChip, Pagination,
  Panel, SearchInput, Select, Tooltip,
  type AsyncResource, type Column,
} from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type { PersonFilters, PersonList, PersonListItem } from '@/lib/persons';
import { PersonDrawer } from './person-drawer';
import { CreatePersonDialog } from './person-dialogs';

/**
 * Person register.
 *
 * Every filter lives in the URL and is applied by the API. Nothing is filtered
 * in the browser: the register is the largest table in the system, and shipping
 * it to be hidden client-side would both leak and crawl.
 *
 * The search box is DEBOUNCED so a lookup does not fire a request per keystroke.
 */

const STATUS_OPTIONS = [
  { value: 'all', label: 'Any status' },
  { value: 'alive', label: 'Alive' },
  { value: 'deceased', label: 'Deceased' },
  { value: 'missing', label: 'Missing' },
  { value: 'incarcerated', label: 'Incarcerated' },
];

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  caution: 'warning',
  info: 'info',
};

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  alive: 'success',
  missing: 'warning',
  incarcerated: 'neutral',
  deceased: 'danger',
};

export function PersonsView({
  list, filters, page, pageSize,
}: {
  list: PersonList | null;
  filters: PersonFilters;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(filters.search ?? '');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const setParam = React.useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Narrowing the filters while on page 4 would land on a page that no longer
    // exists, and the register would read as empty.
    if (key !== 'page') next.delete('page');
    router.replace(next.size > 0 ? `/persons?${next.toString()}` : '/persons');
  }, [router, searchParams]);

  // Debounced: one request per pause, not one per keystroke.
  React.useEffect(() => {
    const current = searchParams.get('search') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => setParam('search', search), 300);
    return () => clearTimeout(timer);
  }, [search, searchParams, setParam]);

  if (!list) {
    return (
      <div className="p-3">
        <Panel>
          <EmptyState
            title="The person register is not available to you"
            description="Looking up people requires the “View persons” permission in your organization."
          />
        </Panel>
      </div>
    );
  }

  const caps = list.capabilities;
  const activeFilters =
    (filters.search ? 1 : 0) + (filters.status && filters.status !== 'all' ? 1 : 0) +
    (filters.onlyFlagged === 'true' ? 1 : 0) + (filters.onlyWanted === 'true' ? 1 : 0) +
    (filters.includeArchived === 'true' ? 1 : 0);

  const resource: AsyncResource<PersonListItem[]> = { status: 'success', data: list.persons };

  const columns: Column<PersonListItem>[] = [
    {
      id: 'name', header: 'Name', width: '26%',
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            {p.activeWarrants > 0 ? (
              <Tooltip content={`${p.activeWarrants} active warrant(s)`}>
                <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-label="Wanted" />
              </Tooltip>
            ) : null}
            <span className="truncate font-medium">{p.lastName}, {p.firstName}</span>
            {p.isArchived ? <Badge size="sm" variant="neutral">Archived</Badge> : null}
          </span>
          {p.aliases.length > 0 ? (
            <span className="truncate text-2xs text-text-tertiary">
              aka {p.aliases.slice(0, 2).join(', ')}
              {p.aliases.length > 2 ? ` +${p.aliases.length - 2}` : ''}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'dob', header: 'Date of birth', mono: true, width: '130px', hideBelow: 'md',
      cell: (p) => (p.dateOfBirth
        ? formatDate(p.dateOfBirth)
        : <span className="text-text-disabled">—</span>),
    },
    {
      id: 'phone', header: 'Phone', mono: true, width: '130px', hideBelow: 'lg',
      cell: (p) => p.phoneNumber ?? <span className="text-text-disabled">—</span>,
    },
    {
      id: 'address', header: 'Address', hideBelow: 'xl',
      cell: (p) => (
        <span className="truncate text-text-secondary">
          {p.address ?? <span className="text-text-disabled">—</span>}
        </span>
      ),
    },
    {
      id: 'status', header: 'Status', width: '120px',
      cell: (p) => (
        <Badge size="sm" variant={STATUS_TONE[p.status] ?? 'neutral'}>
          {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
        </Badge>
      ),
    },
    {
      id: 'markers', header: 'Markers', width: '130px', align: 'right',
      cell: (p) => (
        <span className="flex items-center justify-end gap-1">
          {p.flagCount > 0 ? (
            <Tooltip content={`${p.flagCount} active flag(s)`}>
              <Badge size="sm" variant={SEVERITY_TONE[p.highestFlagSeverity ?? 'info'] ?? 'info'}>
                <ShieldAlert aria-hidden /> {p.flagCount}
              </Badge>
            </Tooltip>
          ) : null}
          {p.vehicleCount > 0 ? (
            <Tooltip content={`${p.vehicleCount} registered vehicle(s)`}>
              <Badge size="sm" variant="outline" mono>{p.vehicleCount}v</Badge>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={activeFilters > 0
          ? () => { setSearch(''); router.replace('/persons'); }
          : undefined}
        trailing={
          <>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              inputSize="sm"
              placeholder="Name, alias, phone, address, ID…"
              className="w-[260px]"
            />
            {caps.canCreate ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> New record
              </Button>
            ) : (
              <Tooltip content="Creating records requires the “Create person records” permission">
                <span>
                  <Button variant="primary" size="sm" disabled>
                    <Plus aria-hidden /> New record
                  </Button>
                </span>
              </Tooltip>
            )}
          </>
        }
      >
        <Select
          value={filters.status ?? 'all'}
          onValueChange={(v) => setParam('status', v === 'all' ? '' : v)}
          options={STATUS_OPTIONS}
          size="sm"
          className="w-[160px]"
          aria-label="Person status"
        />
        <FilterChip
          label="Wanted"
          active={filters.onlyWanted === 'true'}
          onToggle={() => setParam('wanted', filters.onlyWanted === 'true' ? '' : 'true')}
        />
        <FilterChip
          label="Flagged"
          active={filters.onlyFlagged === 'true'}
          onToggle={() => setParam('flagged', filters.onlyFlagged === 'true' ? '' : 'true')}
        />
        {caps.canViewArchived ? (
          <FilterChip
            label="Include archived"
            active={filters.includeArchived === 'true'}
            onToggle={() => setParam('archived', filters.includeArchived === 'true' ? '' : 'true')}
          />
        ) : null}
        <span className="ml-1 text-2xs text-text-tertiary">
          <span className="text-text-secondary">{list.total}</span>
          {list.total === 1 ? ' record' : ' records'}
        </span>
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {!caps.canViewCriminal || !caps.canViewMedical ? (
          <Alert tone="info" title="Your access to these records is limited">
            {[
              !caps.canViewCriminal ? 'criminal history' : null,
              !caps.canViewMedical ? 'medical records' : null,
            ].filter(Boolean).join(' and ')} {' '}
            {(!caps.canViewCriminal && !caps.canViewMedical) ? 'are' : 'is'} withheld from your
            organization. The data is not sent to your browser at all — it is not hidden, it is
            not loaded.
          </Alert>
        ) : null}

        <Panel flush className="min-h-0 flex-1 overflow-hidden">
          <DataTable
            caption="Person register"
            columns={columns}
            resource={resource}
            rowKey={(p) => p.id}
            onRowClick={(p) => setOpenId(p.id)}
            selectedKey={openId}
            rowTone={(p) => (p.activeWarrants > 0
              ? 'danger'
              : p.highestFlagSeverity === 'critical' ? 'warning' : 'default')}
            empty={
              <EmptyState
                icon={<CircleUser />}
                variant={activeFilters > 0 ? 'filtered' : 'empty'}
                title={activeFilters > 0 ? 'Nobody matches that' : 'The register is empty'}
                description={activeFilters > 0
                  ? 'Try a shorter search, or widen the filters.'
                  : 'No person records have been created yet.'}
                action={activeFilters > 0
                  ? (
                    <Button size="sm" variant="ghost"
                      onClick={() => { setSearch(''); router.replace('/persons'); }}>
                      Clear filters
                    </Button>
                  )
                  : caps.canCreate
                    ? <Button size="sm" onClick={() => setCreating(true)}>Create the first record</Button>
                    : undefined}
              />
            }
          />
        </Panel>

        {list.total > pageSize ? (
          <Pagination
            className="shrink-0"
            page={page}
            pageSize={pageSize}
            totalItems={list.total}
            onPageChange={(next) => setParam('page', next === 1 ? '' : String(next))}
          />
        ) : null}
      </div>

      <PersonDrawer
        personId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => router.refresh()}
      />

      <CreatePersonDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
