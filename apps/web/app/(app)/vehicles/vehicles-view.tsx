'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  Badge, Button, DataTable, FilterBar, FilterChip, OrgBadge, Panel,
  SearchInput, Tooltip, type AsyncResource, type Column, type SortState,
} from '@/components/ui';
import { MOCK_VEHICLES, type MockVehicle } from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';

export function VehiclesView() {
  const [query, setQuery] = React.useState('');
  const [onlyFlagged, setOnlyFlagged] = React.useState(false);
  const [onlyFleet, setOnlyFleet] = React.useState(false);
  const [sort, setSort] = React.useState<SortState>({ columnId: 'plate', direction: 'asc' });

  const rows = React.useMemo(() => {
    const filtered = MOCK_VEHICLES.filter((v) => {
      if (onlyFlagged && v.flags.length === 0) return false;
      if (onlyFleet && !v.ownerOrganizationId) return false;
      if (query) {
        const hay = `${v.plate} ${v.displayName} ${v.ownerName ?? ''}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) =>
      dir * (sort.columnId === 'model'
        ? a.displayName.localeCompare(b.displayName)
        : a.plate.localeCompare(b.plate)));
  }, [query, onlyFlagged, onlyFleet, sort]);

  const resource: AsyncResource<MockVehicle[]> = { status: 'success', data: rows };

  const columns: Column<MockVehicle>[] = [
    { id: 'plate', header: 'Plate', sortable: true, mono: true, width: '110px', cell: (v) => <span className="font-semibold">{v.plate}</span> },
    { id: 'model', header: 'Vehicle', sortable: true, cell: (v) => (
      <span className="flex flex-col">
        <span className="truncate">{v.displayName}</span>
        <span className="truncate text-2xs text-text-tertiary">{v.color}</span>
      </span>
    ) },
    { id: 'owner', header: 'Registered owner', hideBelow: 'md', cell: (v) =>
      v.ownerOrganizationId ? (
        <OrgBadge {...(() => { const o = mockOrg(v.ownerOrganizationId!); return { shortName: o.shortName, color: o.color }; })()} />
      ) : (
        <span className="truncate text-text-secondary">{v.ownerName ?? '—'}</span>
      ) },
    { id: 'registration', header: 'Registration', width: '120px', hideBelow: 'lg', cell: (v) => (
      <Badge size="sm" variant={v.registration === 'registered' ? 'success' : v.registration === 'expired' ? 'warning' : 'danger'}>
        {v.registration}
      </Badge>
    ) },
    { id: 'insurance', header: 'Insurance', width: '110px', hideBelow: 'xl', cell: (v) => (
      <Badge size="sm" variant={v.insurance === 'insured' ? 'success' : v.insurance === 'expired' ? 'warning' : 'danger'}>
        {v.insurance}
      </Badge>
    ) },
    { id: 'flags', header: 'Flags', width: '160px', cell: (v) => v.flags.length === 0
      ? <span className="text-text-tertiary">—</span>
      : <span className="flex flex-wrap gap-1">{v.flags.map((f) => <Badge key={f} size="sm" variant="danger">{f}</Badge>)}</span> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={(onlyFlagged ? 1 : 0) + (onlyFleet ? 1 : 0)}
        onClearAll={() => { setOnlyFlagged(false); setOnlyFleet(false); }}
        trailing={
          <>
            <SearchInput value={query} onValueChange={setQuery} inputSize="sm" placeholder="Plate, model, owner…" className="w-[220px]" />
            <Tooltip content="Vehicle registration lands in Phase 4">
              <Button variant="primary" size="sm" disabled><Plus aria-hidden /> Register</Button>
            </Tooltip>
          </>
        }
      >
        <FilterChip label="Flagged" active={onlyFlagged} onToggle={() => setOnlyFlagged((v) => !v)} />
        <FilterChip label="Fleet only" active={onlyFleet} onToggle={() => setOnlyFleet((v) => !v)} />
      </FilterBar>

      <Panel flush className="m-3 min-h-0 flex-1">
        <DataTable
          caption="Vehicle registrations"
          columns={columns}
          resource={resource}
          rowKey={(v) => v.id}
          sort={sort}
          onSortChange={setSort}
          rowTone={(v) => (v.flags.length > 0 ? 'danger' : 'default')}
          onRowClick={() => {}}
        />
      </Panel>
    </div>
  );
}
