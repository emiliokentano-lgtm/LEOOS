'use client';

import * as React from 'react';
import { Car, FileText, Search as SearchIcon, TriangleAlert, Users } from 'lucide-react';
import {
  Alert, Badge, EmptyState, OrgBadge, Panel, PanelHeader, SearchInput,
  Tabs, TabsList, TabsTrigger,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { MOCK_INCIDENTS, MOCK_PERSONS, MOCK_VEHICLES } from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';

/**
 * Cross-entity search.
 *
 * One field, results grouped by entity. In the real system every result set is
 * filtered by the viewer's permissions server-side, and every search that returns
 * a person or vehicle is written to the audit log — "who looked up whom" is a
 * question this system must be able to answer.
 */
export function SearchView() {
  const [query, setQuery] = React.useState('');
  const [scope, setScope] = React.useState('all');

  const q = query.trim().toLowerCase();

  const persons = q ? MOCK_PERSONS.filter((p) =>
    `${p.firstName} ${p.lastName} ${p.phone}`.toLowerCase().includes(q)) : [];
  const vehicles = q ? MOCK_VEHICLES.filter((v) =>
    `${v.plate} ${v.displayName} ${v.ownerName ?? ''}`.toLowerCase().includes(q)) : [];
  const incidents = q ? MOCK_INCIDENTS.filter((i) =>
    `${i.number} ${i.title} ${i.type} ${i.locationText}`.toLowerCase().includes(q)) : [];

  const total = persons.length + vehicles.length + incidents.length;
  const show = (kind: string) => scope === 'all' || scope === kind;

  return (
    <PageContainer>
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <Panel>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search persons, vehicles, incidents…"
            aria-label="Global search"
          />
          <p className="mt-2 text-2xs text-text-tertiary">
            Try a name, a plate, an incident number, or a phone number.
          </p>
        </Panel>

        <Alert tone="info" title="Every lookup is audited">
          Searches that return a person or vehicle record are permanently logged with your
          identity, the query, and the records returned.
        </Alert>

        {q ? (
          <>
            <Tabs value={scope} onValueChange={setScope}>
              <TabsList>
                <TabsTrigger value="all" count={total}>All</TabsTrigger>
                <TabsTrigger value="persons" count={persons.length}>Persons</TabsTrigger>
                <TabsTrigger value="vehicles" count={vehicles.length}>Vehicles</TabsTrigger>
                <TabsTrigger value="incidents" count={incidents.length}>Incidents</TabsTrigger>
              </TabsList>
            </Tabs>

            {total === 0 ? (
              <Panel flush>
                <EmptyState
                  variant="filtered"
                  title={`No results for "${query}"`}
                  description="Check the spelling, or try a partial plate or surname."
                />
              </Panel>
            ) : null}

            {show('persons') && persons.length > 0 ? (
              <Panel flush>
                <PanelHeader title="Persons" icon={<Users />} actions={<Badge mono>{persons.length}</Badge>} />
                <ul>
                  {persons.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-hover">
                      {p.hasWarrant ? <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-label="Active warrant" /> : null}
                      <span className="truncate text-xs font-medium text-text-primary">{p.lastName}, {p.firstName}</span>
                      <span className="truncate font-mono text-2xs text-text-tertiary">{p.dateOfBirth}</span>
                      <span className="ml-auto flex shrink-0 gap-1">
                        {p.flags.map((f) => (
                          <Badge key={f.type} size="sm" variant={f.severity === 'critical' ? 'danger' : 'warning'}>{f.type}</Badge>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {show('vehicles') && vehicles.length > 0 ? (
              <Panel flush>
                <PanelHeader title="Vehicles" icon={<Car />} actions={<Badge mono>{vehicles.length}</Badge>} />
                <ul>
                  {vehicles.map((v) => (
                    <li key={v.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-hover">
                      <span className="font-mono text-xs font-semibold text-text-primary">{v.plate}</span>
                      <span className="truncate text-xs text-text-secondary">{v.displayName}</span>
                      <span className="ml-auto flex shrink-0 gap-1">
                        {v.flags.map((f) => <Badge key={f} size="sm" variant="danger">{f}</Badge>)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {show('incidents') && incidents.length > 0 ? (
              <Panel flush>
                <PanelHeader title="Incidents" icon={<FileText />} actions={<Badge mono>{incidents.length}</Badge>} />
                <ul>
                  {incidents.map((i) => {
                    const org = mockOrg(i.organizationId);
                    return (
                      <li key={i.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-hover">
                        <span className="font-mono text-xs text-text-primary">{i.number}</span>
                        <OrgBadge shortName={org.shortName} color={org.color} size="sm" />
                        <span className="truncate text-xs text-text-secondary">{i.title}</span>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ) : null}
          </>
        ) : (
          <Panel flush>
            <EmptyState
              icon={<SearchIcon aria-hidden />}
              title="Search the register"
              description="Persons, vehicles and incidents you have permission to see."
            />
          </Panel>
        )}
      </div>
    </PageContainer>
  );
}
