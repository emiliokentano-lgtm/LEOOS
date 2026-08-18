'use client';

import * as React from 'react';
import {
  Alert, Badge, DataTable, FilterBar, FilterChip, Panel, SearchInput,
  type AsyncResource, type Column,
} from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import { MOCK_AUDIT, type MockAuditEntry } from '@/mocks/operations';

/** Audit log viewer. Denied attempts are first-class — a user repeatedly trying
 *  to promote above their rank is exactly the signal an operations lead needs. */
export function AuditView() {
  const [query, setQuery] = React.useState('');
  const [onlyDenied, setOnlyDenied] = React.useState(false);

  const rows = React.useMemo(() => MOCK_AUDIT.filter((e) => {
    if (onlyDenied && e.outcome !== 'denied') return false;
    if (query && !`${e.actor} ${e.action} ${e.entity}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [query, onlyDenied]);

  const resource: AsyncResource<MockAuditEntry[]> = { status: 'success', data: rows };

  const columns: Column<MockAuditEntry>[] = [
    { id: 'at', header: 'Time', mono: true, width: '170px', cell: (e) => formatDateTime(e.at) },
    { id: 'actor', header: 'Actor', width: '160px', cell: (e) => e.actor },
    { id: 'action', header: 'Action', mono: true, cell: (e) => e.action },
    { id: 'entity', header: 'Entity', mono: true, hideBelow: 'md', cell: (e) => <span className="text-text-secondary">{e.entity}</span> },
    { id: 'outcome', header: 'Outcome', width: '100px', cell: (e) => (
      <Badge size="sm" variant={e.outcome === 'success' ? 'success' : e.outcome === 'denied' ? 'danger' : 'warning'}>
        {e.outcome}
      </Badge>
    ) },
    { id: 'ip', header: 'IP', mono: true, align: 'right', width: '110px', hideBelow: 'lg',
      cell: (e) => <span className="text-text-tertiary">{e.ip}</span> },
  ];

  const deniedCount = MOCK_AUDIT.filter((e) => e.outcome === 'denied').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={onlyDenied ? 1 : 0}
        onClearAll={() => setOnlyDenied(false)}
        trailing={
          <SearchInput value={query} onValueChange={setQuery} inputSize="sm"
            placeholder="Actor, action, entity…" className="w-[220px]" />
        }
      >
        <FilterChip label="Denied only" count={deniedCount} active={onlyDenied} onToggle={() => setOnlyDenied((v) => !v)} />
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Alert tone="info" title="The audit log is append-only">
          Entries cannot be edited or deleted through the application. The database role has
          insert and select privileges only, so tampering requires superuser access rather
          than an application bug.
        </Alert>
        <Panel flush className="min-h-0 flex-1">
          <DataTable caption="Audit log entries" columns={columns} resource={resource} rowKey={(e) => e.id} />
        </Panel>
      </div>
    </div>
  );
}
