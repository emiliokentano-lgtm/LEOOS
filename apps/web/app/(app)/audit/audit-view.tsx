'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, Info, ShieldAlert } from 'lucide-react';
import {
  AUDIT_ACTION_NAMESPACES, AUDIT_SEVERITIES,
  type AuditEntry, type AuditPage, type OrganizationSummary,
} from '@leoos/contracts';
import {
  Alert, Badge, EmptyState, FilterBar, Input, Modal, Panel, PanelHeader, SearchInput, Select,
  Button, Tooltip,
} from '@/components/ui';
import { formatDateTime } from '@/lib/utils';

/**
 * The audit log.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO THINGS THIS SCREEN REFUSES TO DO
 *
 * 1. FILTER IN THE BROWSER. Every filter is a URL parameter and every query
 *    runs against the whole table. Filtering the page that happened to load
 *    would make "show me every refused escalation" mean "show me the refusals
 *    among the last fifty rows" — which looks like a quiet week.
 *
 * 2. SUMMARISE METADATA INTO PROSE. The metadata of a role change and of a
 *    panic have nothing in common, and one formatter over both would end up
 *    describing one of them wrongly. The row shows the keys; the detail dialog
 *    shows them in full.
 *
 * Paging is a KEYSET cursor, not an offset. The log grows at the head while
 * somebody is reading it, so an offset re-counts from a list that has shifted
 * underneath them and quietly repeats or skips rows.
 * ────────────────────────────────────────────────────────────────────────────
 */

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  critical: 'danger',
  high: 'warning',
  notice: 'info',
  info: 'neutral',
};

const OUTCOME_TONE: Record<string, 'success' | 'danger' | 'warning'> = {
  success: 'success',
  denied: 'danger',
  error: 'warning',
};

export function AuditView({
  page, organizations, actions, filters,
}: {
  page: AuditPage | null;
  organizations: OrganizationSummary[];
  actions: string[];
  filters: Record<string, string>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = React.useState(filters.search ?? '');
  const [selected, setSelected] = React.useState<AuditEntry | null>(null);

  const setParam = React.useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Any filter change starts a new keyset walk. Keeping the old cursor would
    // resume paging through a result set that no longer exists.
    if (key !== 'cursor') next.delete('cursor');
    router.replace((next.size > 0 ? `/audit?${next.toString()}` : '/audit') as Route);
  }, [router, searchParams]);

  React.useEffect(() => {
    const current = searchParams.get('search') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => setParam('search', search), 300);
    return () => clearTimeout(timer);
  }, [search, searchParams, setParam]);

  if (!page) {
    return (
      <div className="p-3">
        <Panel>
          <EmptyState
            title="The audit log is unavailable"
            description="Reading it is reserved to global administrators and audit viewers."
          />
        </Panel>
      </div>
    );
  }

  const activeFilters = Object.entries(filters)
    .filter(([key, value]) => key !== 'cursor' && value !== '').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={activeFilters > 0
          ? () => { setSearch(''); router.replace('/audit' as Route); }
          : undefined}
        trailing={
          <SearchInput
            value={search}
            onValueChange={setSearch}
            inputSize="sm"
            placeholder="Action, actor or entity…"
            className="w-[240px]"
          />
        }
      >
        <Select
          value={filters.severity || 'all'}
          onValueChange={(v) => setParam('severity', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any severity' },
            ...Object.entries(AUDIT_SEVERITIES).map(([key, meta]) => ({
              value: key, label: meta.label,
            })),
          ]}
          size="sm"
          className="w-[150px]"
          aria-label="Severity"
        />
        <Select
          value={filters.outcome || 'all'}
          onValueChange={(v) => setParam('outcome', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any outcome' },
            { value: 'success', label: 'Succeeded' },
            { value: 'denied', label: 'Refused' },
            { value: 'error', label: 'Errored' },
          ]}
          size="sm"
          className="w-[150px]"
          aria-label="Outcome"
        />
        <Select
          value={filters.ns || 'all'}
          onValueChange={(v) => setParam('ns', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Every area' },
            ...AUDIT_ACTION_NAMESPACES.map((n) => ({ value: n.prefix, label: n.label })),
          ]}
          size="sm"
          className="w-[170px]"
          aria-label="Action area"
        />
        <Select
          value={filters.action || 'all'}
          onValueChange={(v) => setParam('action', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Any action' },
            ...actions.map((a) => ({ value: a, label: a })),
          ]}
          size="sm"
          className="w-[210px]"
          aria-label="Action"
        />
        <Select
          value={filters.org || 'all'}
          onValueChange={(v) => setParam('org', v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'Every organization' },
            ...organizations.map((o) => ({ value: o.id, label: o.shortName })),
          ]}
          size="sm"
          className="w-[180px]"
          aria-label="Organization"
        />
        <span className="flex items-center gap-1">
          <Input
            type="date"
            inputSize="sm"
            className="w-[140px]"
            aria-label="From date"
            value={filters.from ? filters.from.slice(0, 10) : ''}
            onChange={(e) => setParam(
              'from', e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : '',
            )}
          />
          <span className="text-2xs text-text-tertiary">→</span>
          <Input
            type="date"
            inputSize="sm"
            className="w-[140px]"
            aria-label="To date"
            value={filters.to ? filters.to.slice(0, 10) : ''}
            onChange={(e) => setParam(
              'to', e.target.value ? new Date(`${e.target.value}T23:59:59Z`).toISOString() : '',
            )}
          />
        </span>
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Alert tone="info" title="This log is append-only">
          Entries cannot be edited or deleted through the application — the database role
          holds insert and select privileges only, so tampering requires superuser access
          rather than an application bug. Severity is derived from the action and its
          outcome rather than stored, so it can always be recomputed from the row.
        </Alert>

        <Panel flush className="min-h-0 flex-1">
          <PanelHeader
            title="Audit entries"
            icon={<ShieldAlert />}
            actions={
              <Badge variant="neutral" mono>
                {page.totalIsExact
                  ? `${page.approximateTotal}`
                  : `${page.approximateTotal.toLocaleString('en-US')}+`}
              </Badge>
            }
          />

          <div className="min-h-0 flex-1 overflow-auto">
            {page.entries.length === 0 ? (
              <EmptyState
                variant={activeFilters > 0 ? 'filtered' : 'empty'}
                title={activeFilters > 0 ? 'No entries match' : 'The log is empty'}
                description={activeFilters > 0
                  ? 'Adjust the filters above.'
                  : 'Nothing security-sensitive has happened in this installation yet.'}
              />
            ) : (
              page.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelected(entry)}
                  className="flex w-full items-start gap-3 border-b border-border-subtle px-3 py-2 text-left hover:bg-hover"
                >
                  <span className="w-[150px] shrink-0 font-mono text-2xs text-text-tertiary">
                    {formatDateTime(entry.occurredAt)}
                  </span>

                  <Badge size="sm" variant={SEVERITY_TONE[entry.severity] ?? 'neutral'}>
                    {AUDIT_SEVERITIES[entry.severity].label}
                  </Badge>

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs text-text-primary">{entry.action}</span>
                      {entry.outcome !== 'success' ? (
                        <Badge size="sm" variant={OUTCOME_TONE[entry.outcome] ?? 'warning'}>
                          {entry.outcome}
                        </Badge>
                      ) : null}
                      {entry.organization ? (
                        <span
                          className="rounded-[2px] border px-1 text-[9px]"
                          style={{
                            borderColor: entry.organization.color,
                            color: entry.organization.color,
                          }}
                        >
                          {entry.organization.shortName}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-text-tertiary">
                      {entry.actor.label ?? (entry.actor.type === 'user' ? 'unknown actor' : entry.actor.type)}
                      {entry.entityLabel || entry.entityType ? ' → ' : ''}
                      {entry.entityLabel ?? entry.entityType ?? ''}
                      {entry.entityType && entry.entityLabel ? ` (${entry.entityType})` : ''}
                    </span>
                  </span>

                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                </button>
              ))
            )}
          </div>
        </Panel>

        {page.nextCursor ? (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setParam('cursor', page.nextCursor!)}
            >
              Load older entries
            </Button>
          </div>
        ) : null}
      </div>

      {selected ? (
        <AuditDetail entry={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

function AuditDetail({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const metadata = Object.entries(entry.metadata);

  return (
    <Modal
      open
      onOpenChange={(v) => { if (!v) onClose(); }}
      title={entry.action}
      description={formatDateTime(entry.occurredAt)}
      size="md"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_TONE[entry.severity] ?? 'neutral'}>
            {AUDIT_SEVERITIES[entry.severity].label}
          </Badge>
          <Badge variant={OUTCOME_TONE[entry.outcome] ?? 'warning'}>{entry.outcome}</Badge>
          <Tooltip content={AUDIT_SEVERITIES[entry.severity].description}>
            <span className="flex items-center gap-1 text-2xs text-text-tertiary">
              <Info className="size-3" aria-hidden /> how this severity was derived
            </span>
          </Tooltip>
        </div>

        <dl className="flex flex-col gap-1.5 text-xs">
          <Detail label="Actor">
            {entry.actor.userId ? (
              <Link
                href={`/admin/users/${entry.actor.userId}` as Route}
                className="text-accent hover:underline"
              >
                {entry.actor.label ?? entry.actor.userId}
              </Link>
            ) : (
              <span className="text-text-secondary">
                {entry.actor.label ?? entry.actor.type}
              </span>
            )}
            <span className="ml-1.5 text-2xs text-text-tertiary">({entry.actor.type})</span>
          </Detail>

          <Detail label="Target">
            {entry.entityType ? (
              <span>
                {entry.entityLabel ?? <span className="text-text-tertiary">unnamed</span>}
                <span className="ml-1.5 font-mono text-2xs text-text-tertiary">
                  {entry.entityType}
                  {entry.entityId ? ` · ${entry.entityId}` : ''}
                </span>
              </span>
            ) : (
              <span className="text-text-tertiary">—</span>
            )}
          </Detail>

          <Detail label="Organization">
            {entry.organization
              ? entry.organization.name
              : <span className="text-text-tertiary">none — this action was not organization-scoped</span>}
          </Detail>

          <Detail label="Source address">
            <span className="font-mono">{entry.ip ?? '—'}</span>
          </Detail>

          <Detail label="Request">
            <span className="font-mono text-2xs">{entry.requestId ?? '—'}</span>
          </Detail>
        </dl>

        <div>
          <p className="mb-1 text-2xs uppercase tracking-wide text-text-tertiary">Context</p>
          {metadata.length === 0 ? (
            <p className="text-xs text-text-tertiary">
              This entry carries no additional context.
            </p>
          ) : (
            <dl className="flex flex-col gap-1 rounded-xs border border-border-subtle bg-raised p-2">
              {metadata.map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 text-2xs">
                  <dt className="shrink-0 font-mono text-text-tertiary">{key}</dt>
                  <dd className="min-w-0 break-all text-right font-mono text-text-primary">
                    {value === null ? '—' : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}
