'use client';

import * as React from 'react';
import { Globe, ShieldAlert, Users } from 'lucide-react';
import type { PermissionOverview, PermissionOverviewEntry } from '@leoos/contracts';
import {
  Badge, EmptyState, FilterBar, FilterChip, Panel, PanelHeader, SearchInput, Select, Tooltip,
} from '@/components/ui';
import { readableOn } from '@/lib/readable-colour';

/**
 * The permission overview.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INTERESTING ROWS ARE THE EMPTY ONES
 *
 * Built from the CATALOGUE rather than from the grants that exist, so a
 * high-risk permission no role grants shows up as a row with nothing in it. A
 * screen assembled from what is assigned would render that as an absence
 * nobody can see — and "who can permanently erase records?" answered by
 * silence is not an answer.
 *
 * Filtering is client-side here, unlike every other register in the product,
 * and deliberately: the whole surface is eighty rows of static catalogue plus
 * their grants, it arrives in one payload, and it is the same for every
 * administrator. There is no per-row authorization to enforce and nothing to
 * withhold, so a round trip per keystroke would buy nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */

const RISK_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

export function PermissionOverviewView({ overview }: { overview: PermissionOverview | null }) {
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [onlyUngranted, setOnlyUngranted] = React.useState(false);
  const [onlyHighRisk, setOnlyHighRisk] = React.useState(false);
  const [organizationId, setOrganizationId] = React.useState('all');

  const categories = React.useMemo(() => {
    if (!overview) return [];
    return [...new Set(overview.entries.map((e) => e.category))].sort();
  }, [overview]);

  const rows = React.useMemo(() => {
    if (!overview) return [];
    const needle = query.trim().toLowerCase();

    return overview.entries
      .map((entry) => ({
        ...entry,
        // The organization filter narrows the GRANTS, not the permissions: the
        // question it answers is "what does PD grant", and a permission PD does
        // not grant is still a row worth seeing as empty.
        grants: organizationId === 'all'
          ? entry.grants
          : entry.grants.filter((g) => g.organization?.id === organizationId),
      }))
      .filter((entry) => {
        if (category !== 'all' && entry.category !== category) return false;
        if (onlyHighRisk && entry.risk !== 'high') return false;
        if (onlyUngranted && entry.grants.length > 0) return false;
        if (needle && !`${entry.key} ${entry.label}`.toLowerCase().includes(needle)) return false;
        return true;
      });
  }, [overview, query, category, onlyUngranted, onlyHighRisk, organizationId]);

  if (!overview) {
    return (
      <div className="p-3">
        <Panel>
          <EmptyState
            title="The permission overview is unavailable"
            description="Reading it requires a global capability, or the API could not be reached."
          />
        </Panel>
      </div>
    );
  }

  const activeFilters = (query ? 1 : 0) + (category !== 'all' ? 1 : 0)
    + (onlyUngranted ? 1 : 0) + (onlyHighRisk ? 1 : 0) + (organizationId !== 'all' ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={activeFilters > 0 ? () => {
          setQuery(''); setCategory('all'); setOnlyUngranted(false);
          setOnlyHighRisk(false); setOrganizationId('all');
        } : undefined}
        trailing={
          <SearchInput
            value={query}
            onValueChange={setQuery}
            inputSize="sm"
            placeholder="Permission key or label…"
            className="w-[240px]"
          />
        }
      >
        <Select
          value={category}
          onValueChange={setCategory}
          options={[
            { value: 'all', label: 'Every category' },
            ...categories.map((c) => ({ value: c, label: c })),
          ]}
          size="sm"
          className="w-[170px]"
          aria-label="Category"
        />
        <Select
          value={organizationId}
          onValueChange={setOrganizationId}
          options={[
            { value: 'all', label: 'Every organization' },
            ...overview.organizations.map((o) => ({ value: o.id, label: o.shortName })),
          ]}
          size="sm"
          className="w-[180px]"
          aria-label="Organization"
        />
        <FilterChip label="High risk" active={onlyHighRisk} onToggle={() => setOnlyHighRisk((v) => !v)} />
        <FilterChip
          label="Granted by nothing"
          active={onlyUngranted}
          onToggle={() => setOnlyUngranted((v) => !v)}
        />
      </FilterBar>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <Panel flush>
          <PanelHeader
            title="Permissions"
            icon={<ShieldAlert />}
            description="Every permission in the catalogue, and the roles that grant it"
            actions={<Badge variant="neutral" mono>{rows.length}</Badge>}
          />
          {rows.length === 0 ? (
            <EmptyState variant="filtered" title="No permissions match" description="Adjust the filters above." />
          ) : (
            <ul>
              {rows.map((entry) => <PermissionRow key={entry.key} entry={entry} />)}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function PermissionRow({ entry }: { entry: PermissionOverviewEntry }) {
  const holders = entry.grants.reduce((sum, g) => sum + g.memberCount, 0);
  const isGlobal = entry.scope === 'global';

  return (
    <li className="border-b border-border-subtle px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-text-primary">{entry.key}</span>
        <Badge size="sm" variant={RISK_TONE[entry.risk] ?? 'neutral'}>{entry.risk}</Badge>
        {isGlobal ? (
          <Tooltip content="Global scope: can never be attached to an organization role. The kernel refuses it and a database trigger refuses it again.">
            <Badge size="sm" variant="outline"><Globe aria-hidden /> global</Badge>
          </Tooltip>
        ) : null}
        <span className="text-xs text-text-secondary">{entry.label}</span>

        <span className="ml-auto flex items-center gap-2 text-2xs text-text-tertiary">
          {entry.overrideGrantCount > 0 ? (
            <Tooltip content="Held through a per-member override rather than a role">
              <Badge size="sm" variant="outline">+{entry.overrideGrantCount} override</Badge>
            </Tooltip>
          ) : null}
          {entry.overrideDenyCount > 0 ? (
            <Tooltip content="Denied for specific members, overriding their role. Deny always wins.">
              <Badge size="sm" variant="warning">−{entry.overrideDenyCount} denied</Badge>
            </Tooltip>
          ) : null}
          <span className="flex items-center gap-1 font-mono">
            <Users className="size-3" aria-hidden /> {holders}
          </span>
        </span>
      </div>

      {entry.grants.length === 0 ? (
        <p className="mt-1 text-2xs text-text-tertiary">
          {isGlobal
            ? 'No role grants it. Global capabilities are granted per account, not through roles.'
            : 'No active role grants this permission — nobody holds it.'}
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {entry.grants.map((grant) => (
            <span
              key={grant.roleId}
              className="flex items-center gap-1 rounded-xs border border-border px-1.5 py-0.5 text-2xs"
            >
              {grant.organization ? (
                <span style={{ color: readableOn(grant.organization.color) }}>
                  {grant.organization.shortName}
                </span>
              ) : (
                <Tooltip content="A global role — it belongs to no organization">
                  <span className="text-text-tertiary">global</span>
                </Tooltip>
              )}
              <span className="text-text-secondary">{grant.roleName}</span>
              <span className="font-mono text-text-tertiary">L{grant.hierarchyLevel}</span>
              <span className="font-mono text-text-tertiary">· {grant.memberCount}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
