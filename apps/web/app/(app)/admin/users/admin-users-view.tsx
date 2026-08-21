'use client';

import * as React from 'react';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, UserX } from 'lucide-react';
import {
  ACCOUNT_STATUSES, GLOBAL_CAPABILITIES,
  type AccountStatusMeta, type AdminUserList, type AdminUserSummary,
} from '@leoos/contracts';
import type { OrganizationDto } from '@/lib/organizations';
import {
  Badge, DataTable, EmptyState, FilterBar, FilterChip, Pagination, Panel, SearchInput, Select,
  Tooltip, type AsyncResource, type Column,
} from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/utils';

/**
 * The account register.
 *
 * A table, not a card grid: an administrator scanning for one account is
 * comparing rows on the same axes — status, capabilities, last login — and a
 * grid makes that comparison impossible.
 *
 * Every filter is a URL parameter and every query runs on the server, so a
 * search is shareable, survives a reload, and never means "filter the fifty
 * rows that happened to load".
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'warning',
  disabled: 'danger',
  pending_verification: 'neutral',
};

export function AdminUsersView({
  list, statuses, organizations, filters, page, pageSize,
}: {
  list: AdminUserList | null;
  statuses: AccountStatusMeta[];
  organizations: OrganizationDto[];
  filters: {
    search: string;
    status: string;
    capability: string;
    org: string;
    unaffiliated: boolean;
  };
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = React.useState(filters.search);

  const setParam = React.useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Narrowing while on page 3 would land on a page that no longer exists,
    // and the register would read as empty.
    if (key !== 'page') next.delete('page');
    router.replace((next.size > 0 ? `/admin/users?${next.toString()}` : '/admin/users') as Route);
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
            title="The account register is unavailable"
            description="Reading accounts requires a global capability. If you hold one, the API could not be reached."
          />
        </Panel>
      </div>
    );
  }

  const activeFilters = (filters.search ? 1 : 0) + (filters.status ? 1 : 0)
    + (filters.capability ? 1 : 0) + (filters.org ? 1 : 0) + (filters.unaffiliated ? 1 : 0);

  const resource: AsyncResource<AdminUserSummary[]> = { status: 'success', data: list.users };

  const columns: Column<AdminUserSummary>[] = [
    {
      id: 'name', header: 'Account', width: '28%',
      cell: (u) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-text-primary">{u.displayName}</span>
          <span className="truncate font-mono text-2xs text-text-tertiary">
            {u.username} · {u.email}
          </span>
        </span>
      ),
    },
    {
      id: 'status', header: 'Status', width: '150px',
      cell: (u) => (
        <span className="flex items-center gap-1.5">
          <Badge size="sm" variant={STATUS_TONE[u.status] ?? 'neutral'}>
            {ACCOUNT_STATUSES[u.status].label}
          </Badge>
          {/*
            * An unverified address is called out separately from the status.
            * "Pending verification" and "active but the address was never
            * confirmed" are different problems, and only the first is visible
            * from the status alone.
            */}
          {!u.emailVerified && u.status !== 'pending_verification' ? (
            <Tooltip content="This address has never been verified">
              <Badge size="sm" variant="outline">unverified</Badge>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      id: 'capabilities', header: 'Global', width: '170px',
      cell: (u) => (u.globalCapabilities.length === 0
        ? <span className="text-text-disabled">—</span>
        : (
          <span className="flex flex-wrap gap-1">
            {u.globalCapabilities.map((key) => (
              <Tooltip key={key} content={GLOBAL_CAPABILITIES[key].description}>
                <Badge size="sm" variant={key === 'global_admin' ? 'danger' : 'outline'}>
                  <ShieldCheck aria-hidden /> {key === 'global_admin' ? 'admin' : key.replace('_', ' ')}
                </Badge>
              </Tooltip>
            ))}
          </span>
        )),
    },
    {
      id: 'orgs', header: 'Organizations', hideBelow: 'md',
      cell: (u) => (u.organizationShortNames.length === 0
        ? (
          <Tooltip content="No active membership — this account cannot reach any operational screen">
            <span className="flex items-center gap-1 text-2xs text-warning">
              <UserX aria-hidden className="size-3" /> none
            </span>
          </Tooltip>
        )
        : (
          <span className="flex flex-wrap gap-1">
            {u.organizationShortNames.map((name) => (
              <Badge key={name} size="sm" variant="neutral">{name}</Badge>
            ))}
          </span>
        )),
    },
    {
      id: 'lastLogin', header: 'Last login', mono: true, width: '150px', hideBelow: 'lg',
      cell: (u) => (u.lastLoginAt
        ? formatDateTime(u.lastLoginAt)
        : <span className="text-text-disabled">never</span>),
    },
    {
      id: 'created', header: 'Created', mono: true, width: '110px', align: 'right', hideBelow: 'xl',
      cell: (u) => <span className="text-text-tertiary">{formatDate(u.createdAt)}</span>,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={activeFilters > 0
          ? () => { setSearch(''); router.replace('/admin/users' as Route); }
          : undefined}
        trailing={
          <SearchInput
            value={search}
            onValueChange={setSearch}
            inputSize="sm"
            placeholder="Username, email or name…"
            className="w-[260px]"
          />
        }
      >
        <Select
          value={filters.status || 'all'}
          onValueChange={(v) => setParam('status', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any status' },
            ...statuses.map((s) => ({ value: s.key, label: s.label })),
          ]}
          size="sm"
          className="w-[170px]"
          aria-label="Account status"
        />
        <Select
          value={filters.capability || 'all'}
          onValueChange={(v) => setParam('capability', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any capability' },
            ...Object.values(GLOBAL_CAPABILITIES).map((c) => ({ value: c.key, label: c.label })),
          ]}
          size="sm"
          className="w-[190px]"
          aria-label="Global capability"
        />
        <Select
          value={filters.org || 'all'}
          onValueChange={(v) => setParam('org', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any organization' },
            ...organizations.map((o) => ({ value: o.id, label: o.shortName })),
          ]}
          size="sm"
          className="w-[180px]"
          aria-label="Organization"
        />
        <FilterChip
          label="No organization"
          active={filters.unaffiliated}
          onToggle={() => setParam('unaffiliated', filters.unaffiliated ? '' : '1')}
        />
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Panel flush className="min-h-0 flex-1">
          <DataTable
            caption="User accounts, with status, global capabilities and last sign-in"
            resource={resource}
            columns={columns}
            rowKey={(u) => u.id}
            onRowClick={(u) => router.push(`/admin/users/${u.id}` as Route)}
            rowTone={(u) => (u.status === 'disabled' ? 'danger'
              : u.status === 'suspended' ? 'warning' : 'default')}
            empty={
              <EmptyState
                variant={activeFilters > 0 ? 'filtered' : 'empty'}
                title={activeFilters > 0 ? 'No accounts match' : 'No accounts'}
                description={activeFilters > 0
                  ? 'Adjust the filters above.'
                  : 'This installation has no user accounts yet.'}
              />
            }
          />
        </Panel>

        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={list.total}
          onPageChange={(next) => setParam('page', String(next))}
        />
      </div>
    </div>
  );
}
