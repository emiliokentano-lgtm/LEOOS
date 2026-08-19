'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Lock, ShieldCheck, UserPlus } from 'lucide-react';
import type { DutyStatusKey } from '@leoos/contracts';
import {
  Alert, Badge, Button, DataTable, DutyStatusBadge, EmptyState, FilterBar, Panel,
  Pagination, SearchInput, Select, Tooltip, Dropdown, DropdownTrigger,
  DropdownContent, DropdownItem, DropdownSeparator,
  type AsyncResource, type Column, type SortState,
} from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type {
  AssignableRole, HireCandidate, PersonnelListItem, PersonnelRoster,
} from '@/lib/personnel';
import { MemberDrawer } from './member-drawer';
import {
  AssignRoleDialog, ChangeRankDialog, EditMemberDialog, HireDialog, TerminateDialog,
} from './personnel-dialogs';

/**
 * Personnel roster.
 *
 * Two things about this screen are cosmetic and nothing more:
 *
 *   - `capabilities` decides which BUTTONS exist
 *   - `row.manageable` decides whether a row shows a menu or a lock
 *
 * Both come from the API, and both are re-decided server-side inside the
 * transaction that performs the change. A member who reaches an action anyway —
 * by keeping a stale page open across their own demotion, say — is refused, and
 * the refusal is audited (engineering rules 9, 13, 14).
 */

export type PersonnelDialog =
  | { kind: 'hire' }
  | { kind: 'rank'; member: PersonnelListItem }
  | { kind: 'role'; member: PersonnelListItem }
  | { kind: 'edit'; member: PersonnelListItem }
  | { kind: 'terminate'; member: PersonnelListItem };

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'all', label: 'All, including terminated' },
];

/**
 * `ANY` rather than `''`: Radix treats the empty string as "nothing selected",
 * so an option with that value shows the placeholder instead of its own label.
 * It maps back to an absent query parameter.
 */
const ANY = 'any';

const DUTY_OPTIONS = [
  { value: ANY, label: 'Any duty status' },
  { value: 'available', label: 'Available' },
  { value: 'busy', label: 'Busy' },
  { value: 'on_scene', label: 'On scene' },
  { value: 'in_operation', label: 'In operation' },
  { value: 'at_hq', label: 'At HQ' },
  { value: 'transporting', label: 'Transporting' },
  { value: 'off_duty', label: 'Off duty' },
];

const MEMBER_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  on_leave: 'warning',
  suspended: 'danger',
  terminated: 'neutral',
};

const MEMBER_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  on_leave: 'On leave',
  suspended: 'Suspended',
  terminated: 'Terminated',
};

export function PersonnelView({
  organizationId, organizationName, roster, roles, candidates, filters, page, pageSize,
}: {
  organizationId: string;
  organizationName: string;
  roster: PersonnelRoster | null;
  roles: AssignableRole[];
  candidates: HireCandidate[];
  filters: { search?: string; status?: string; roleId?: string; dutyStatus?: string };
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(filters.search ?? '');
  const [sort, setSort] = React.useState<SortState>({ columnId: 'rank', direction: 'desc' });
  const [openMemberId, setOpenMemberId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<PersonnelDialog | null>(null);

  /**
   * Filters live in the URL and are applied by the API.
   *
   * Filtering in the browser would mean shipping every row and then hiding
   * some — the hidden ones would still be in the payload.
   */
  const setParam = React.useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Narrowing the filters while on page 4 would otherwise land on a page that
    // no longer exists, and the roster would read as empty.
    if (key !== 'page') next.delete('page');
    router.replace(next.size > 0 ? `/personnel?${next.toString()}` : '/personnel');
  }, [router, searchParams]);

  // Debounced so a search does not fire a request per keystroke.
  React.useEffect(() => {
    const current = searchParams.get('search') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => setParam('search', search), 300);
    return () => clearTimeout(timer);
  }, [search, searchParams, setParam]);

  const activeStatus = filters.status ?? 'active';
  const activeFilterCount =
    (filters.search ? 1 : 0) + (filters.roleId ? 1 : 0) +
    (filters.dutyStatus ? 1 : 0) + (activeStatus !== 'active' ? 1 : 0);

  const rows = React.useMemo(() => {
    const data = roster?.personnel ?? [];
    const dir = sort.direction === 'asc' ? 1 : -1;
    // Sorting is presentational, so it stays client-side: it reorders rows the
    // caller already holds rather than asking for a different set.
    return [...data].sort((a, b) => {
      switch (sort.columnId) {
        case 'name': return dir * a.displayName.localeCompare(b.displayName);
        case 'callsign': return dir * (a.callsign ?? '').localeCompare(b.callsign ?? '');
        case 'joined': return dir * (a.joinedAt < b.joinedAt ? -1 : 1);
        default:
          return dir * (a.hierarchyLevel - b.hierarchyLevel)
            || a.displayName.localeCompare(b.displayName);
      }
    });
  }, [roster, sort]);

  if (!roster) {
    return (
      <div className="p-3">
        <Panel>
          <EmptyState
            title="Personnel are not available to you"
            description={`Viewing the ${organizationName} roster requires the "View personnel" permission in this organization.`}
          />
        </Panel>
      </div>
    );
  }

  const caps = roster.capabilities;
  const canActOnSomeone = caps.canFire || caps.canPromote || caps.canDemote
    || caps.canAssignRoles || caps.canEdit || caps.canSetCallsign;

  const resource: AsyncResource<PersonnelListItem[]> = { status: 'success', data: rows };

  const columns: Column<PersonnelListItem>[] = [
    {
      id: 'name', header: 'Member', sortable: true, cell: (m) => (
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{m.displayName}</span>
            {m.isOrgLead ? (
              <Tooltip content="Organization Lead — full authority inside this organization">
                <span className="inline-flex text-accent"><ShieldCheck className="size-3.5" aria-hidden /></span>
              </Tooltip>
            ) : null}
          </span>
          <span className="truncate font-mono text-2xs text-text-tertiary">
            {m.employeeNumber ? `No. ${m.employeeNumber}` : m.username}
          </span>
        </span>
      ),
    },
    {
      id: 'rank', header: 'Rank', sortable: true, width: '190px', cell: (m) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{m.rankName ?? '—'}</span>
          <Badge size="sm" variant="outline" mono>L{m.hierarchyLevel}</Badge>
          {m.roles.length > 1 ? (
            <Tooltip content={m.roles.map((r) => `${r.name} (L${r.hierarchyLevel})`).join(', ')}>
              <Badge size="sm" variant="neutral">+{m.roles.length - 1}</Badge>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      id: 'callsign', header: 'Callsign', mono: true, width: '110px', hideBelow: 'md',
      cell: (m) => m.callsign ?? <span className="text-text-disabled">—</span>,
    },
    {
      id: 'membership', header: 'Membership', width: '120px', hideBelow: 'lg',
      cell: (m) => (
        <Badge size="sm" variant={MEMBER_STATUS_TONE[m.status] ?? 'neutral'}>
          {MEMBER_STATUS_LABEL[m.status] ?? m.status}
        </Badge>
      ),
    },
    {
      id: 'duty', header: 'Duty', width: '130px', cell: (m) => (
        m.status === 'terminated'
          ? <span className="text-2xs text-text-disabled">—</span>
          : <DutyStatusBadge status={(m.dutyStatus ?? 'off_duty') as DutyStatusKey} size="sm" />
      ),
    },
    {
      id: 'unit', header: 'Unit', mono: true, width: '90px', hideBelow: 'xl',
      cell: (m) => m.unitCallsign ?? <span className="text-text-disabled">—</span>,
    },
    {
      id: 'joined', header: 'Joined', sortable: true, align: 'right', width: '120px', hideBelow: 'xl',
      cell: (m) => (
        <span className="whitespace-nowrap text-2xs text-text-tertiary">{formatDate(m.joinedAt)}</span>
      ),
    },
    {
      id: 'actions', header: '', width: '110px', align: 'right',
      cell: (m) => <RowActions member={m} capabilities={caps} onSelect={setDialog} />,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilterCount}
        onClearAll={activeFilterCount > 0 ? () => { setSearch(''); router.replace('/personnel'); } : undefined}
        trailing={
          <>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              inputSize="sm"
              placeholder="Name, callsign, number…"
              className="w-[220px]"
            />
            {caps.canHire ? (
              <Button variant="primary" size="sm" onClick={() => setDialog({ kind: 'hire' })}>
                <UserPlus aria-hidden /> Hire
              </Button>
            ) : (
              <Tooltip content="Hiring requires the “Hire members” permission">
                <span><Button variant="primary" size="sm" disabled><UserPlus aria-hidden /> Hire</Button></span>
              </Tooltip>
            )}
          </>
        }
      >
        <Select
          value={activeStatus}
          onValueChange={(v) => setParam('status', v === 'active' ? '' : v)}
          options={STATUS_OPTIONS}
          size="sm"
          className="w-[190px]"
          aria-label="Membership status"
        />
        <Select
          value={filters.roleId ?? ANY}
          onValueChange={(v) => setParam('roleId', v === ANY ? '' : v)}
          options={[
            { value: ANY, label: 'Any rank' },
            ...roles.map((r) => ({ value: r.id, label: `${r.name} (L${r.hierarchyLevel})` })),
          ]}
          size="sm"
          className="w-[200px]"
          aria-label="Rank"
        />
        <Select
          value={filters.dutyStatus ?? ANY}
          onValueChange={(v) => setParam('dutyStatus', v === ANY ? '' : v)}
          options={DUTY_OPTIONS}
          size="sm"
          className="w-[170px]"
          aria-label="Duty status"
        />
        <span className="ml-1 text-2xs text-text-tertiary">
          <span className="text-text-secondary">{roster.total}</span>
          {roster.total === 1 ? ' member' : ' members'}
        </span>
        <span className="text-2xs text-text-tertiary">
          Your rank:{' '}
          <span className="font-mono text-text-secondary">
            {caps.actorLevel === 'unbounded' ? 'unbounded' : `L${caps.actorLevel}`}
          </span>
        </span>
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {canActOnSomeone ? (
          <Alert tone="info" title="Row actions reflect the hierarchy rule">
            Members at or above your own rank show as locked, and so do you. This is a
            usability affordance only — every personnel operation is authorized again on
            the server, inside the transaction that performs it, and refusals are audited.
          </Alert>
        ) : null}

        <Panel flush className="min-h-0 flex-1">
          <DataTable
            caption={`${organizationName} personnel roster`}
            columns={columns}
            resource={resource}
            rowKey={(m) => m.memberId}
            onRowClick={(m) => setOpenMemberId(m.memberId)}
            selectedKey={openMemberId}
            sort={sort}
            onSortChange={setSort}
            rowTone={(m) => (m.status === 'suspended' ? 'warning' : 'default')}
            empty={
              <EmptyState
                title={activeFilterCount > 0 ? 'No one matches those filters' : 'No personnel yet'}
                description={activeFilterCount > 0
                  ? 'Try widening the rank or status filter.'
                  : `Nobody has been hired into ${organizationName}.`}
                action={activeFilterCount > 0
                  ? <Button size="sm" variant="ghost" onClick={() => { setSearch(''); router.replace('/personnel'); }}>Clear filters</Button>
                  : caps.canHire
                    ? <Button size="sm" onClick={() => setDialog({ kind: 'hire' })}>Hire the first member</Button>
                    : undefined}
              />
            }
          />
        </Panel>

        {roster.total > pageSize ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={roster.total}
            onPageChange={(next) => setParam('page', next === 1 ? '' : String(next))}
          />
        ) : null}
      </div>

      <MemberDrawer
        organizationId={organizationId}
        memberId={openMemberId}
        onClose={() => setOpenMemberId(null)}
        capabilities={caps}
        onAction={(next) => { setOpenMemberId(null); setDialog(next); }}
      />

      <HireDialog
        open={dialog?.kind === 'hire'}
        onClose={() => setDialog(null)}
        organizationId={organizationId}
        organizationName={organizationName}
        candidates={candidates}
        roles={roles}
        actorLevel={caps.actorLevel}
      />

      {dialog?.kind === 'rank' ? (
        <ChangeRankDialog
          member={dialog.member} organizationId={organizationId}
          roles={roles} actorLevel={caps.actorLevel} onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'role' ? (
        <AssignRoleDialog
          member={dialog.member} organizationId={organizationId}
          roles={roles} actorLevel={caps.actorLevel} onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'edit' ? (
        <EditMemberDialog
          member={dialog.member} organizationId={organizationId}
          capabilities={caps} onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'terminate' ? (
        <TerminateDialog
          member={dialog.member} organizationId={organizationId}
          organizationName={organizationName} onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The lock is the honest affordance.
 *
 * Rendering a menu whose every item would be refused teaches an operator that
 * the system is unreliable. Rendering a lock with the reason teaches them the
 * rank rule.
 */
function RowActions({
  member, capabilities, onSelect,
}: {
  member: PersonnelListItem;
  capabilities: PersonnelRoster['capabilities'];
  onSelect: (dialog: PersonnelDialog) => void;
}) {
  const isSelf = member.userId === capabilities.actorUserId;

  const lockReason = isSelf
    ? 'You cannot manage your own membership'
    : member.isOrgLead
      ? 'Organization Leads are managed by a global administrator'
      : `Requires a rank above ${member.rankName ?? 'this member'} (L${member.hierarchyLevel})`;

  if (!member.manageable) {
    return (
      <Tooltip content={lockReason}>
        <span className="inline-flex items-center gap-1 text-2xs text-text-disabled">
          <Lock className="size-3" aria-hidden />
          Locked
        </span>
      </Tooltip>
    );
  }

  const terminated = member.status === 'terminated';
  const canRank = capabilities.canPromote || capabilities.canDemote;
  const items = [
    canRank && !terminated,
    capabilities.canAssignRoles && !terminated,
    capabilities.canEdit || capabilities.canSetCallsign,
    capabilities.canFire && !terminated,
  ].some(Boolean);

  if (!items) {
    return (
      <Tooltip content="You hold no personnel permissions in this organization">
        <span className="inline-flex items-center gap-1 text-2xs text-text-disabled">
          <Lock className="size-3" aria-hidden />
          Locked
        </span>
      </Tooltip>
    );
  }

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button variant="ghost" size="xs" onClick={(e) => e.stopPropagation()}>
          Manage <ChevronDown aria-hidden />
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        {canRank && !terminated ? (
          <DropdownItem onSelect={() => onSelect({ kind: 'rank', member })}>
            Change rank
          </DropdownItem>
        ) : null}
        {capabilities.canAssignRoles && !terminated ? (
          <DropdownItem onSelect={() => onSelect({ kind: 'role', member })}>
            Assign a role
          </DropdownItem>
        ) : null}
        {capabilities.canEdit || capabilities.canSetCallsign ? (
          <DropdownItem onSelect={() => onSelect({ kind: 'edit', member })}>
            Edit details
          </DropdownItem>
        ) : null}
        {capabilities.canFire && !terminated ? (
          <>
            <DropdownSeparator />
            <DropdownItem destructive onSelect={() => onSelect({ kind: 'terminate', member })}>
              Terminate
            </DropdownItem>
          </>
        ) : null}
      </DropdownContent>
    </Dropdown>
  );
}
