'use client';

import * as React from 'react';
import { ChevronDown, Lock, UserPlus } from 'lucide-react';
import {
  Alert, Badge, Button, DataTable, DutyStatusBadge, FilterBar, Panel, SearchInput,
  Tooltip, Dropdown, DropdownTrigger, DropdownContent, DropdownItem,
  type AsyncResource, type Column, type SortState,
} from '@/components/ui';
import { timeAgo } from '@/lib/utils';
import { MOCK_MEMBERS, MOCK_NOW, type MockMember } from '@/mocks/operations';

/**
 * Personnel roster.
 *
 * The row actions demonstrate the hierarchy rule visually: a member at or above
 * the viewer's own rank shows a lock rather than a menu. The real decision is
 * made SERVER-SIDE inside the mutating transaction — this is presentation only,
 * so an operator is not offered an action that would be refused (engineering
 * rules 9, 13, 14).
 */
export function PersonnelView({ actorLevel, actorName }: { actorLevel: number; actorName: string }) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortState>({ columnId: 'rank', direction: 'desc' });

  const rows = React.useMemo(() => {
    const filtered = MOCK_MEMBERS.filter((m) =>
      !query || `${m.name} ${m.callsign} ${m.roleName} ${m.badgeNumber}`.toLowerCase().includes(query.toLowerCase()));
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.columnId === 'name'
        ? dir * a.name.localeCompare(b.name)
        : dir * (a.hierarchyLevel - b.hierarchyLevel));
  }, [query, sort]);

  const resource: AsyncResource<MockMember[]> = { status: 'success', data: rows };

  const columns: Column<MockMember>[] = [
    { id: 'name', header: 'Member', sortable: true, cell: (m) => (
      <span className="flex flex-col">
        <span className="truncate font-medium">{m.name}</span>
        <span className="truncate font-mono text-2xs text-text-tertiary">Badge {m.badgeNumber}</span>
      </span>
    ) },
    { id: 'rank', header: 'Rank', sortable: true, width: '150px', cell: (m) => (
      <span className="flex items-center gap-1.5">
        <span>{m.roleName}</span>
        <Badge size="sm" variant="outline" mono>L{m.hierarchyLevel}</Badge>
      </span>
    ) },
    { id: 'callsign', header: 'Callsign', mono: true, width: '120px', hideBelow: 'md', cell: (m) => m.callsign },
    { id: 'status', header: 'Status', width: '130px', cell: (m) => <DutyStatusBadge status={m.status} size="sm" /> },
    { id: 'lastSeen', header: 'Last seen', mono: true, align: 'right', width: '90px', hideBelow: 'lg',
      cell: (m) => <span className="text-text-tertiary">{timeAgo(m.lastSeen, MOCK_NOW)}</span> },
    {
      id: 'actions', header: '', width: '110px', align: 'right',
      cell: (m) => {
        const isSelf = m.name === actorName;
        // H1: strictly greater. Peers are mutually immune — two lieutenants
        // cannot manage each other.
        const canManage = !isSelf && actorLevel > m.hierarchyLevel;
        if (!canManage) {
          return (
            <Tooltip content={isSelf ? 'You cannot manage your own membership' : `Requires a rank above ${m.roleName} (L${m.hierarchyLevel})`}>
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
              <DropdownItem disabled>Promote</DropdownItem>
              <DropdownItem disabled>Demote</DropdownItem>
              <DropdownItem disabled>Change callsign</DropdownItem>
              <DropdownItem disabled destructive>Terminate</DropdownItem>
            </DropdownContent>
          </Dropdown>
        );
      },
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        trailing={
          <>
            <SearchInput value={query} onValueChange={setQuery} inputSize="sm" placeholder="Name, callsign, badge…" className="w-[220px]" />
            <Tooltip content="Hiring lands with the personnel module (Phase 2)">
              <Button variant="primary" size="sm" disabled><UserPlus aria-hidden /> Hire</Button>
            </Tooltip>
          </>
        }
      >
        <span className="text-2xs text-text-tertiary">
          Your rank: <span className="font-mono text-text-secondary">L{actorLevel}</span>
        </span>
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Alert tone="info" title="Row actions reflect the hierarchy rule">
          Members at or above your own rank show as locked. This is a usability
          affordance only — every personnel operation is authorized again on the
          server, inside the transaction that performs it.
        </Alert>

        <Panel flush className="min-h-0 flex-1">
          <DataTable
            caption="Organization personnel roster"
            columns={columns}
            resource={resource}
            rowKey={(m) => m.id}
            sort={sort}
            onSortChange={setSort}
          />
        </Panel>
      </div>
    </div>
  );
}
