'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArchiveRestore, ChevronDown, Lock, Plus, Shield, Star, Trash2,
} from 'lucide-react';
import {
  Alert, Badge, Button, DataTable, EmptyState, Panel, PanelHeader, Toggle, Tooltip,
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownSeparator,
  type AsyncResource, type Column,
} from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/auth-action-types';
import { restoreRoleAction, setDefaultRoleAction } from '@/lib/role-actions';
import type { PermissionCatalogue, RoleDto, RoleList } from '@/lib/roles';
import { RoleEditor } from './role-editor';
import { ArchiveRoleDialog, CreateRoleDialog, ReorderDialog } from './role-dialogs';

/**
 * Role and permission management.
 *
 * Two things here are cosmetic and nothing more: `capabilities` on the screen
 * decides which buttons exist, and `capabilities` on each role decides whether
 * it shows a menu or a lock. Both come from the API and both are decided again
 * server-side inside the transaction that performs the change.
 *
 * The lock is shown WITH ITS REASON rather than hidden. A rank structure whose
 * upper half silently vanishes teaches an operator nothing; one that shows
 * "requires a rank above L80" teaches them the rule they are working under.
 */
export function RolesView({
  organizationId, organizationName, list, catalogue, showArchived,
}: {
  organizationId: string;
  organizationName: string;
  list: RoleList | null;
  catalogue: PermissionCatalogue | null;
  showArchived: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [reordering, setReordering] = React.useState(false);
  const [archiving, setArchiving] = React.useState<RoleDto | null>(null);
  const [notice, setNotice] = React.useState<ActionState>(IDLE);

  const roles = list?.roles ?? [];
  const selected = roles.find((r) => r.id === selectedId)
    ?? roles.find((r) => !r.isArchived)
    ?? null;

  if (!list || !catalogue) {
    return (
      <div className="p-3">
        <Panel>
          <EmptyState
            title="Roles are not available to you"
            description={`Viewing the ${organizationName} rank structure requires the "View roles" permission in this organization.`}
          />
        </Panel>
      </div>
    );
  }

  const caps = list.capabilities;
  const ceiling = caps.actorLevel;

  async function run(action: () => Promise<ActionState>) {
    const result = await action();
    setNotice(result);
    if (result.status === 'success') router.refresh();
  }

  const columns: Column<RoleDto>[] = [
    {
      id: 'level', header: 'Level', mono: true, width: '64px', align: 'right',
      cell: (r) => <span className="font-semibold">{r.hierarchyLevel}</span>,
    },
    {
      id: 'name', header: 'Role', cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{r.name}</span>
            {r.isDefault ? (
              <Tooltip content="New hires receive this role">
                <Badge size="sm" variant="info">Default</Badge>
              </Tooltip>
            ) : null}
            {r.isSystem ? <Badge size="sm" variant="neutral">System</Badge> : null}
            {r.isArchived ? <Badge size="sm" variant="warning">Archived</Badge> : null}
          </span>
          <span className="truncate font-mono text-2xs text-text-tertiary">{r.key}</span>
        </span>
      ),
    },
    {
      id: 'members', header: 'Members', mono: true, align: 'right', width: '84px',
      cell: (r) => r.memberCount,
    },
    {
      id: 'perms', header: 'Permissions', mono: true, align: 'right', width: '104px',
      hideBelow: 'md', cell: (r) => r.permissionCount,
    },
    {
      id: 'actions', header: '', width: '96px', align: 'right',
      cell: (r) => <RoleActions
        role={r}
        screen={caps}
        onArchive={() => setArchiving(r)}
        onRestore={() => run(() => restoreRoleAction(organizationId, r.id))}
        onSetDefault={() => run(() => setDefaultRoleAction(organizationId, r.id))}
      />,
    },
  ];

  const resource: AsyncResource<RoleDto[]> = { status: 'success', data: roles };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {notice.status !== 'idle' ? (
        <Alert
          tone={notice.status === 'error' ? 'danger' : 'success'}
          title={notice.status === 'error' ? 'That was refused' : 'Saved'}
        >
          {notice.message}
          {notice.requestId ? (
            <span className="mt-1 block font-mono text-2xs text-text-tertiary">
              Reference {notice.requestId}
            </span>
          ) : null}
        </Alert>
      ) : null}

      <Alert tone="info" title="Roles are data, not code">
        {organizationName} defines its own rank structure — higher numbers are more senior.
        A role can only be created, edited, moved or archived by someone of{' '}
        <strong>strictly higher</strong> rank, and can never be given a permission the editor
        does not hold themselves. Your ceiling is{' '}
        <span className="font-mono text-text-secondary">
          {ceiling === 'unbounded' ? 'unbounded' : `L${ceiling}`}
        </span>
        . All of it is enforced on the server.
      </Alert>

      {/*
        The grid row is bounded at `lg` (`grid-rows-[minmax(0,1fr)]`), otherwise
        an `auto` row sizes to its content: the rank list grew the page instead
        of scrolling inside its own panel, and scrolling down to reach a role
        carried the editor off the top of the screen. Below `lg` the panels stack
        and the page scrolls as one, which is the right behaviour there.
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto lg:grid-cols-[minmax(340px,1fr)_minmax(0,1.5fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <Panel flush className="min-h-0 overflow-hidden">
          <PanelHeader
            title="Rank structure"
            icon={<Shield />}
            description={`${roles.filter((r) => !r.isArchived).length} live role(s)`}
            actions={
              <div className="flex items-center gap-1.5">
                {caps.canReorder ? (
                  <Button variant="ghost" size="xs" onClick={() => setReordering(true)}>
                    Reorder
                  </Button>
                ) : null}
                {caps.canCreate ? (
                  <Button variant="primary" size="xs" onClick={() => setCreating(true)}>
                    <Plus aria-hidden /> New role
                  </Button>
                ) : (
                  <Tooltip content="Creating roles requires the “Create roles” permission">
                    <span>
                      <Button variant="primary" size="xs" disabled>
                        <Plus aria-hidden /> New role
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </div>
            }
          />

          <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5">
            <label className="flex items-center gap-2 text-2xs text-text-tertiary">
              <Toggle
                checked={showArchived}
                onCheckedChange={(next) =>
                  router.replace(next ? '/roles?archived=true' : '/roles')}
                aria-label="Show archived roles"
              />
              Show archived
            </label>
            {list.archivedCount > 0 ? (
              <span className="text-2xs text-text-tertiary">
                {list.archivedCount} archived
              </span>
            ) : null}
          </div>

          <DataTable
            caption={`${organizationName} roles by hierarchy level`}
            columns={columns}
            resource={resource}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelectedId(r.id)}
            selectedKey={selected?.id ?? null}
            rowTone={(r) => (r.isArchived ? 'warning' : 'default')}
            empty={
              <EmptyState
                title="No roles yet"
                description={`${organizationName} has no rank structure defined.`}
                action={caps.canCreate
                  ? <Button size="sm" onClick={() => setCreating(true)}>Create the first role</Button>
                  : undefined}
              />
            }
          />
        </Panel>

        {selected ? (
          <RoleEditor
            key={selected.id}
            organizationId={organizationId}
            role={selected}
            catalogue={catalogue}
            screen={caps}
          />
        ) : (
          <Panel className="min-h-0">
            <EmptyState
              title="Select a role"
              description="Choose a role on the left to see and edit what it can do."
            />
          </Panel>
        )}
      </div>

      <CreateRoleDialog
        open={creating}
        onClose={() => setCreating(false)}
        organizationId={organizationId}
        catalogue={catalogue}
        actorLevel={ceiling}
        takenLevels={roles.map((r) => r.hierarchyLevel)}
      />

      {reordering ? (
        <ReorderDialog
          organizationId={organizationId}
          roles={roles.filter((r) => !r.isArchived)}
          actorLevel={ceiling}
          onClose={() => setReordering(false)}
          onResult={setNotice}
        />
      ) : null}

      {archiving ? (
        <ArchiveRoleDialog
          organizationId={organizationId}
          role={archiving}
          onClose={() => setArchiving(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The lock is the honest affordance.
 *
 * Offering a menu whose every item would be refused teaches an operator that the
 * system is unreliable; a lock with the reason teaches them the rank rule.
 */
function RoleActions({
  role, screen, onArchive, onRestore, onSetDefault,
}: {
  role: RoleDto;
  screen: RoleList['capabilities'];
  onArchive: () => void;
  onRestore: () => void;
  onSetDefault: () => void;
}) {
  const c = role.capabilities;

  if (role.isArchived) {
    return screen.canRestore ? (
      <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); onRestore(); }}>
        <ArchiveRestore aria-hidden /> Restore
      </Button>
    ) : null;
  }

  /**
   * Reachability first.
   *
   * `screen.canEdit` says the caller may edit roles SOMEWHERE in this
   * organization; it says nothing about THIS role. Reading it on its own put a
   * Manage menu on the Chief role for an L80 Commander — every item inside
   * refused, and with the per-item guards applied, no items at all. A menu that
   * opens empty is worse than a lock: the lock at least says why.
   */
  const canSetDefault = c.canEdit && !role.isDefault && !role.isSystem;

  /**
   * The "reassign them first" hint is only worth showing to someone who would
   * otherwise be able to archive this role. Keying it on the member count alone
   * put a Manage menu back on every populated role — including the ones above
   * the actor, which is the exact case the lock exists for.
   */
  const blockedByHolders = c.lockedReason === null && screen.canDelete
    && !role.isDefault && !role.isSystem && role.memberCount > 0;

  const anything = canSetDefault || c.canDelete || blockedByHolders;

  if (!anything) {
    return (
      <Tooltip content={c.lockedReason ?? 'You hold no role permissions in this organization'}>
        <span className="inline-flex items-center gap-1 text-2xs text-text-tertiary">
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
        {canSetDefault ? (
          <DropdownItem onSelect={onSetDefault}>
            <Star aria-hidden /> Make the default for new hires
          </DropdownItem>
        ) : null}
        {c.canDelete ? (
          <>
            <DropdownSeparator />
            <DropdownItem destructive onSelect={onArchive}>
              <Trash2 aria-hidden /> Archive role
            </DropdownItem>
          </>
        ) : blockedByHolders ? (
          <DropdownItem disabled>
            Held by {role.memberCount} — reassign before archiving
          </DropdownItem>
        ) : null}
      </DropdownContent>
    </Dropdown>
  );
}
