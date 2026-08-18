'use client';

import * as React from 'react';
import { Lock, Plus, Shield } from 'lucide-react';
import { PERMISSION_KEYS, permissionsByCategory, permissionMeta } from '@leoos/contracts';
import {
  Alert, Badge, Button, Checkbox, DataTable, Panel, PanelHeader, Tooltip,
  type AsyncResource, type Column,
} from '@/components/ui';
import { MOCK_ROLES, type MockRole } from '@/mocks/operations';

/** Role management. Shows the hierarchy constraint and the permission catalogue. */
export function RolesView({ actorLevel }: { actorLevel: number }) {
  const [selected, setSelected] = React.useState<MockRole | null>(MOCK_ROLES[3] ?? null);
  const byCategory = React.useMemo(() => permissionsByCategory(), []);

  const resource: AsyncResource<MockRole[]> = { status: 'success', data: MOCK_ROLES };

  const columns: Column<MockRole>[] = [
    { id: 'level', header: 'Level', mono: true, width: '70px', align: 'right',
      cell: (r) => <span className="font-semibold">{r.hierarchyLevel}</span> },
    { id: 'name', header: 'Role', cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="truncate font-medium">{r.name}</span>
        {r.isDefault ? <Badge size="sm" variant="info">Default</Badge> : null}
      </span>
    ) },
    { id: 'members', header: 'Members', mono: true, align: 'right', width: '90px', cell: (r) => r.memberCount },
    { id: 'perms', header: 'Permissions', mono: true, align: 'right', width: '110px', hideBelow: 'md', cell: (r) => r.permissionCount },
    { id: 'lock', header: '', width: '40px', align: 'center', cell: (r) =>
      actorLevel > r.hierarchyLevel ? null : (
        <Tooltip content={`Requires a rank above L${r.hierarchyLevel}`}>
          <Lock className="inline size-3 text-text-disabled" aria-label="Locked" />
        </Tooltip>
      ) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Alert tone="info" title="Roles are data, not code">
        Each organization defines its own rank structure. A role can only be edited or
        assigned by someone of strictly higher rank, and can never carry a permission the
        editor does not hold — enforced server-side.
      </Alert>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.4fr)]">
        <Panel flush className="min-h-0">
          <PanelHeader
            title="Roles"
            icon={<Shield />}
            actions={
              <Tooltip content="Role creation lands in Phase 2">
                <Button variant="primary" size="xs" disabled><Plus aria-hidden /> New role</Button>
              </Tooltip>
            }
          />
          <DataTable
            caption="Organization roles by hierarchy level"
            columns={columns}
            resource={resource}
            rowKey={(r) => r.id}
            selectedKey={selected?.id ?? null}
            onRowClick={setSelected}
          />
        </Panel>

        <Panel flush className="min-h-0">
          <PanelHeader
            title={selected ? `${selected.name} — permissions` : 'Permissions'}
            actions={selected ? <Badge variant="outline" mono>L{selected.hierarchyLevel}</Badge> : null}
          />
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <p className="mb-3 text-xs text-text-tertiary">
              {PERMISSION_KEYS.length} permissions in the catalogue. Read-only in this phase.
            </p>
            <div className="flex flex-col gap-4">
              {Object.entries(byCategory).map(([category, keys]) => (
                <div key={category}>
                  <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
                    {category}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {keys.map((key) => {
                      const meta = permissionMeta(key);
                      return (
                        <div key={key} className="flex items-start gap-2">
                          <Checkbox disabled checked={false} aria-label={meta.label} />
                          <div className="min-w-0">
                            <p className="truncate text-xs text-text-secondary">{meta.label}</p>
                            <p className="flex items-center gap-1.5 truncate font-mono text-2xs text-text-disabled">
                              {key}
                              {meta.risk === 'high' ? (
                                <Badge size="sm" variant="danger">high risk</Badge>
                              ) : null}
                              {meta.scope === 'global' ? (
                                <Badge size="sm" variant="warning">global</Badge>
                              ) : null}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
