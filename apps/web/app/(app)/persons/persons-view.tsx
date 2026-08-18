'use client';

import * as React from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import {
  Badge, Button, DataTable, FilterBar, FilterChip, Pagination, Panel,
  SearchInput, Tooltip, type AsyncResource, type Column, type SortState,
} from '@/components/ui';
import { MOCK_PERSONS, type MockPerson } from '@/mocks/operations';

/** Persons register. Demonstrates the shared DataTable with flag indicators. */
export function PersonsView() {
  const [query, setQuery] = React.useState('');
  const [onlyFlagged, setOnlyFlagged] = React.useState(false);
  const [onlyWanted, setOnlyWanted] = React.useState(false);
  const [sort, setSort] = React.useState<SortState>({ columnId: 'name', direction: 'asc' });
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(25);

  const rows = React.useMemo(() => {
    const filtered = MOCK_PERSONS.filter((p) => {
      if (onlyFlagged && p.flags.length === 0) return false;
      if (onlyWanted && !p.hasWarrant) return false;
      if (query) {
        const hay = `${p.firstName} ${p.lastName} ${p.phone} ${p.address}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.columnId === 'dob') return dir * a.dateOfBirth.localeCompare(b.dateOfBirth);
      return dir * `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`);
    });
  }, [query, onlyFlagged, onlyWanted, sort]);

  const resource: AsyncResource<MockPerson[]> = { status: 'success', data: rows };

  const columns: Column<MockPerson>[] = [
    {
      id: 'name', header: 'Name', sortable: true, width: '24%',
      cell: (p) => (
        <span className="flex items-center gap-1.5">
          {p.hasWarrant ? (
            <Tooltip content="Active warrant">
              <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-label="Active warrant" />
            </Tooltip>
          ) : null}
          <span className="truncate font-medium">{p.lastName}, {p.firstName}</span>
        </span>
      ),
    },
    { id: 'dob', header: 'Date of birth', sortable: true, mono: true, width: '120px', cell: (p) => p.dateOfBirth },
    { id: 'phone', header: 'Phone', mono: true, width: '110px', hideBelow: 'md', cell: (p) => p.phone },
    { id: 'address', header: 'Address', hideBelow: 'lg', cell: (p) => <span className="truncate text-text-secondary">{p.address}</span> },
    {
      id: 'licenses', header: 'Licenses', width: '160px', hideBelow: 'xl',
      cell: (p) => p.licenses.length === 0 ? <span className="text-text-tertiary">—</span> : (
        <span className="flex flex-wrap gap-1">
          {p.licenses.map((l) => (
            <Badge
              key={l.type}
              size="sm"
              variant={l.status === 'valid' ? 'success' : l.status === 'suspended' ? 'warning' : 'danger'}
            >
              {l.type}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'flags', header: 'Flags', width: '180px',
      cell: (p) => p.flags.length === 0 ? <span className="text-text-tertiary">—</span> : (
        <span className="flex flex-wrap gap-1">
          {p.flags.map((f) => (
            <Badge
              key={f.type}
              size="sm"
              variant={f.severity === 'critical' ? 'danger' : f.severity === 'caution' ? 'warning' : 'info'}
            >
              {f.type}
            </Badge>
          ))}
        </span>
      ),
    },
  ];

  const activeFilters = (onlyFlagged ? 1 : 0) + (onlyWanted ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={() => { setOnlyFlagged(false); setOnlyWanted(false); }}
        trailing={
          <>
            <SearchInput
              value={query} onValueChange={setQuery} inputSize="sm"
              placeholder="Name, phone, address…" className="w-[220px]"
            />
            <Tooltip content="Record creation lands in Phase 4">
              <Button variant="primary" size="sm" disabled><Plus aria-hidden /> New person</Button>
            </Tooltip>
          </>
        }
      >
        <FilterChip label="Flagged" active={onlyFlagged} onToggle={() => setOnlyFlagged((v) => !v)} />
        <FilterChip label="Active warrant" active={onlyWanted} onToggle={() => setOnlyWanted((v) => !v)} />
      </FilterBar>

      <Panel flush className="m-3 min-h-0 flex-1">
        <DataTable
          caption="Person records"
          columns={columns}
          resource={resource}
          rowKey={(p) => p.id}
          sort={sort}
          onSortChange={setSort}
          rowTone={(p) => (p.hasWarrant ? 'danger' : p.flags.length > 0 ? 'warning' : 'default')}
          onRowClick={() => { /* detail view lands in Phase 4 */ }}
        />
        <div className="shrink-0 border-t border-border-subtle">
          <Pagination
            page={page} pageSize={pageSize} totalItems={rows.length}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </div>
      </Panel>
    </div>
  );
}
