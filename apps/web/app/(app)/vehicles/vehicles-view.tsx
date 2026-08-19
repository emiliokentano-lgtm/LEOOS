'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Car, Lock, Plus, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  Alert, Badge, Button, DataTable, EmptyState, FilterBar, FilterChip, Pagination,
  Panel, SearchInput, Select, Tooltip,
  type AsyncResource, type Column,
} from '@/components/ui';
import type { OrganizationOption, VehicleFilters, VehicleList, VehicleListItem } from '@/lib/vehicles';
import { VehicleDrawer } from './vehicle-drawer';
import { VehicleFormDialog } from './vehicle-dialogs';

/**
 * Vehicle register.
 *
 * Filters live in the URL and are applied by the API; the search box is
 * debounced. A row belonging to another organization's fleet shows a lock with
 * the reason rather than silently doing nothing when clicked — the flag is
 * cosmetic and the API re-decides, but an honest affordance teaches the rule.
 */

const REGISTRATION_OPTIONS = [
  { value: 'all', label: 'Any registration' },
  { value: 'registered', label: 'Registered' },
  { value: 'expired', label: 'Expired' },
  { value: 'unregistered', label: 'Unregistered' },
];

const INSURANCE_OPTIONS = [
  { value: 'all', label: 'Any insurance' },
  { value: 'insured', label: 'Insured' },
  { value: 'uninsured', label: 'Uninsured' },
  { value: 'expired', label: 'Expired' },
];

const REG_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  registered: 'success', expired: 'warning', unregistered: 'danger',
};

export function VehiclesView({
  list, organizations, filters, page, pageSize,
}: {
  list: VehicleList | null;
  organizations: OrganizationOption[];
  filters: VehicleFilters;
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
    if (key !== 'page') next.delete('page');
    router.replace(next.size > 0 ? `/vehicles?${next.toString()}` : '/vehicles');
  }, [router, searchParams]);

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
            title="The vehicle register is not available to you"
            description="Running a plate requires the “View vehicles” permission in your organization."
          />
        </Panel>
      </div>
    );
  }

  const caps = list.capabilities;
  const activeFilters =
    (filters.search ? 1 : 0) +
    (filters.registrationStatus && filters.registrationStatus !== 'all' ? 1 : 0) +
    (filters.insuranceStatus && filters.insuranceStatus !== 'all' ? 1 : 0) +
    (filters.onlyFleet === 'true' ? 1 : 0) + (filters.onlyFlagged === 'true' ? 1 : 0) +
    (filters.includeArchived === 'true' ? 1 : 0);

  const resource: AsyncResource<VehicleListItem[]> = { status: 'success', data: list.vehicles };

  const columns: Column<VehicleListItem>[] = [
    {
      id: 'plate', header: 'Plate', mono: true, width: '130px',
      cell: (v) => (
        <span className="flex items-center gap-1.5">
          {v.ownerHasWarrant ? (
            <Tooltip content="The registered owner is wanted">
              <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-label="Owner wanted" />
            </Tooltip>
          ) : null}
          <span className="truncate font-semibold">{v.plate}</span>
        </span>
      ),
    },
    {
      id: 'vehicle', header: 'Vehicle',
      cell: (v) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{v.displayName ?? v.model}</span>
          <span className="truncate text-2xs text-text-tertiary">
            {[v.color, v.vehicleClass].filter(Boolean).join(' · ') || v.model}
          </span>
        </span>
      ),
    },
    {
      id: 'owner', header: 'Registered owner', width: '22%', hideBelow: 'md',
      cell: (v) => {
        if (v.ownerOrganizationKey) {
          return (
            <span className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: v.ownerOrganizationColor ?? undefined }} aria-hidden />
              <span className="truncate">{v.ownerOrganizationKey}</span>
              {v.isFleet ? <Badge size="sm" variant="info">Fleet</Badge> : null}
            </span>
          );
        }
        return v.ownerName
          ? <span className="truncate">{v.ownerName}</span>
          : <span className="text-text-disabled">Unregistered owner</span>;
      },
    },
    {
      id: 'registration', header: 'Registration', width: '130px', hideBelow: 'lg',
      cell: (v) => (
        <Badge size="sm" variant={REG_TONE[v.registrationStatus] ?? 'neutral'}>
          {v.registrationStatus}
        </Badge>
      ),
    },
    {
      id: 'insurance', header: 'Insurance', width: '120px', hideBelow: 'xl',
      cell: (v) => (
        <Badge size="sm" variant={v.insuranceStatus === 'insured' ? 'success' : 'warning'}>
          {v.insuranceStatus}
        </Badge>
      ),
    },
    {
      id: 'markers', header: '', width: '90px', align: 'right',
      cell: (v) => (
        <span className="flex items-center justify-end gap-1">
          {v.flagCount > 0 ? (
            <Tooltip content={`${v.flagCount} active flag(s)`}>
              <Badge size="sm" variant="danger"><ShieldAlert aria-hidden /> {v.flagCount}</Badge>
            </Tooltip>
          ) : null}
          {!v.manageable && v.lockedReason ? (
            <Tooltip content={v.lockedReason}>
              <Lock className="size-3 text-text-disabled" aria-label="Read only" />
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
          ? () => { setSearch(''); router.replace('/vehicles'); }
          : undefined}
        trailing={
          <>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              inputSize="sm"
              placeholder="Plate, model, owner…"
              className="w-[240px]"
            />
            {caps.canCreate ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Register
              </Button>
            ) : (
              <Tooltip content="Registering vehicles requires the “Register vehicles” permission">
                <span>
                  <Button variant="primary" size="sm" disabled>
                    <Plus aria-hidden /> Register
                  </Button>
                </span>
              </Tooltip>
            )}
          </>
        }
      >
        <Select
          value={filters.registrationStatus ?? 'all'}
          onValueChange={(v) => setParam('registration', v === 'all' ? '' : v)}
          options={REGISTRATION_OPTIONS}
          size="sm" className="w-[170px]" aria-label="Registration status"
        />
        <Select
          value={filters.insuranceStatus ?? 'all'}
          onValueChange={(v) => setParam('insurance', v === 'all' ? '' : v)}
          options={INSURANCE_OPTIONS}
          size="sm" className="w-[160px]" aria-label="Insurance status"
        />
        <FilterChip
          label="Fleet only"
          active={filters.onlyFleet === 'true'}
          onToggle={() => setParam('fleet', filters.onlyFleet === 'true' ? '' : 'true')}
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
          {list.total === 1 ? ' vehicle' : ' vehicles'}
        </span>
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Alert tone="info" title="One register, shared across organizations">
          Every organization sees the same plates. A vehicle in another organization&apos;s fleet
          can be looked up and flagged by anyone — reporting one stolen is exactly what a shared
          register is for — but only its own organization can edit or archive it.
        </Alert>

        <Panel flush className="min-h-0 flex-1 overflow-hidden">
          <DataTable
            caption="Vehicle register"
            columns={columns}
            resource={resource}
            rowKey={(v) => v.id}
            onRowClick={(v) => setOpenId(v.id)}
            selectedKey={openId}
            rowTone={(v) => (v.ownerHasWarrant ? 'danger' : v.flagCount > 0 ? 'warning' : 'default')}
            empty={
              <EmptyState
                icon={<Car />}
                variant={activeFilters > 0 ? 'filtered' : 'empty'}
                title={activeFilters > 0 ? 'No vehicle matches that' : 'The register is empty'}
                description={activeFilters > 0
                  ? 'Try a partial plate, or widen the filters.'
                  : 'No vehicles have been registered yet.'}
                action={activeFilters > 0
                  ? (
                    <Button size="sm" variant="ghost"
                      onClick={() => { setSearch(''); router.replace('/vehicles'); }}>
                      Clear filters
                    </Button>
                  )
                  : caps.canCreate
                    ? <Button size="sm" onClick={() => setCreating(true)}>Register the first vehicle</Button>
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

      <VehicleDrawer
        vehicleId={openId}
        organizations={organizations}
        onClose={() => setOpenId(null)}
        onChanged={() => router.refresh()}
      />

      <VehicleFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        organizations={organizations}
        actorOrganizationId={caps.actorOrganizationId}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
