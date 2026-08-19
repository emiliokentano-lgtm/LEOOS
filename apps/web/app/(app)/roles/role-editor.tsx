'use client';

import * as React from 'react';
import { Lock, Save, ShieldAlert, Users } from 'lucide-react';
import {
  Alert, Badge, Button, Checkbox, Field, Input, Panel, PanelHeader, Textarea, Tooltip,
} from '@/components/ui';
import { IDLE } from '@/lib/auth-action-types';
import { setRolePermissionsAction, updateRoleAction } from '@/lib/role-actions';
import type { PermissionCatalogue, PermissionOption, RoleDto, RoleList } from '@/lib/roles';

/**
 * The role editor.
 *
 * Two independent forms, because they are two different rights: renaming or
 * re-levelling a role needs `roles.edit`, while changing WHAT IT CAN DO needs
 * `roles.permissions`. An organization that delegates the rank list to a
 * personnel officer without delegating the ability to widen it gets exactly that
 * here — and the API enforces the split whether or not this screen honours it.
 *
 * Permissions the caller cannot grant are shown DISABLED rather than hidden. A
 * role's real permission set must be legible even to someone who could not have
 * created it; hiding those rows would make the role look weaker than it is.
 */

const CATEGORY_LABELS: Record<string, string> = {
  personnel: 'Personnel',
  roles: 'Roles & permissions',
  persons: 'Person records',
  vehicles: 'Vehicles',
  dispatch: 'Dispatch',
  map: 'Map',
  organization: 'Organization',
  admin: 'Administration (global)',
};

const RISK_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

export function RoleEditor({
  organizationId, role, catalogue, screen,
}: {
  organizationId: string;
  role: RoleDto;
  catalogue: PermissionCatalogue;
  screen: RoleList['capabilities'];
}) {
  return (
    <Panel flush className="flex min-h-0 flex-col">
      <PanelHeader
        title={role.name}
        icon={<ShieldAlert />}
        description={`Level ${role.hierarchyLevel} · ${role.memberCount} member(s) · ${role.permissionCount} permission(s)`}
        actions={
          role.capabilities.lockedReason ? (
            <Tooltip content={role.capabilities.lockedReason}>
              <Badge variant="neutral" className="gap-1">
                <Lock className="size-3" aria-hidden /> Read only
              </Badge>
            </Tooltip>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="flex flex-col gap-4">
          {role.isArchived ? (
            <Alert tone="warning" title="This role is archived">
              It is retained in full — its permissions, its history and its audit trail. Restore
              it to use it again.
              {role.archivedReason ? ` Reason: ${role.archivedReason}` : null}
            </Alert>
          ) : null}

          <DetailsForm
            organizationId={organizationId}
            role={role}
            actorLevel={screen.actorLevel}
          />

          <PermissionsForm
            organizationId={organizationId}
            role={role}
            catalogue={catalogue}
          />
        </div>
      </div>
    </Panel>
  );
}

// ── Name, description, level ───────────────────────────────────────────────

function DetailsForm({
  organizationId, role, actorLevel,
}: {
  organizationId: string;
  role: RoleDto;
  actorLevel: number | 'unbounded';
}) {
  const action = updateRoleAction.bind(null, organizationId, role.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  // Controlled so a refused save does not discard what was typed.
  const [name, setName] = React.useState(role.name);
  const [description, setDescription] = React.useState(role.description ?? '');
  const [level, setLevel] = React.useState(String(role.hierarchyLevel));

  const editable = role.capabilities.canEdit && !role.isArchived;
  const ceiling = actorLevel === 'unbounded' ? 101 : actorLevel;
  const wouldBeRefused = Number(level) >= ceiling;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
        Details
      </h3>

      {state.status === 'error' ? (
        <Alert tone="danger" title="Could not save">{state.message}</Alert>
      ) : null}
      {state.status === 'success' ? (
        <Alert tone="success" title="Saved">{state.message}</Alert>
      ) : null}

      {!editable ? (
        <Alert tone="info" title="Read only">
          {role.capabilities.lockedReason
            ?? 'Editing this role requires the “Edit roles” permission.'}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Name" htmlFor={`name-${role.id}`} required>
          <Input
            id={`name-${role.id}`} name="name" maxLength={80}
            value={name} onChange={(e) => setName(e.target.value)}
            disabled={!editable || pending}
          />
        </Field>

        <Field
          label="Hierarchy level"
          htmlFor={`level-${role.id}`}
          required
          hint="1–100. Higher is more senior."
        >
          <Input
            id={`level-${role.id}`} name="hierarchyLevel" type="number" min={1} max={100}
            value={level} onChange={(e) => setLevel(e.target.value)}
            invalid={wouldBeRefused}
            disabled={!editable || pending}
          />
        </Field>
      </div>

      {editable && wouldBeRefused ? (
        <p className="flex items-center gap-1 text-2xs text-danger">
          <Lock className="size-3" aria-hidden />
          The server will refuse this: you cannot place a role at or above your own rank
          {actorLevel === 'unbounded' ? '' : ` (L${actorLevel})`}.
        </p>
      ) : null}

      <Field label="Description" htmlFor={`desc-${role.id}`}>
        <Textarea
          id={`desc-${role.id}`} name="description" rows={2} maxLength={500}
          value={description} onChange={(e) => setDescription(e.target.value)}
          disabled={!editable || pending}
        />
      </Field>

      {editable ? (
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size="sm" loading={pending}>
            <Save aria-hidden /> Save details
          </Button>
        </div>
      ) : null}
    </form>
  );
}

// ── Permission grid ────────────────────────────────────────────────────────

function PermissionsForm({
  organizationId, role, catalogue,
}: {
  organizationId: string;
  role: RoleDto;
  catalogue: PermissionCatalogue;
}) {
  const action = setRolePermissionsAction.bind(null, organizationId, role.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  const [checked, setChecked] = React.useState<Set<string>>(() => new Set(role.permissions));
  const editable = role.capabilities.canEditPermissions && !role.isArchived;

  const held = React.useMemo(() => new Set<string>(role.permissions), [role.permissions]);
  const dirty =
    checked.size !== held.size || [...checked].some((key) => !held.has(key));

  function toggle(option: PermissionOption, next: boolean) {
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(option.key); else copy.delete(option.key);
      return copy;
    });
  }

  /** A category is togglable only where every row in it is actually grantable. */
  function toggleCategory(permissions: PermissionOption[], next: boolean) {
    setChecked((prev) => {
      const copy = new Set(prev);
      for (const option of permissions) {
        if (!option.grantable && !held.has(option.key)) continue;
        if (!option.grantable && next) continue;
        if (next) copy.add(option.key); else copy.delete(option.key);
      }
      return copy;
    });
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
          Permissions
        </h3>
        <span className="text-2xs text-text-tertiary">
          {checked.size} selected
          {dirty ? <span className="ml-1 text-warning">· unsaved</span> : null}
        </span>
      </div>

      {state.status === 'error' ? (
        <Alert tone="danger" title="Could not save permissions">
          {state.message}
          {state.requestId ? (
            <span className="mt-1 block font-mono text-2xs text-text-tertiary">
              Reference {state.requestId}
            </span>
          ) : null}
        </Alert>
      ) : null}
      {state.status === 'success' ? (
        <Alert tone="success" title="Saved">{state.message}</Alert>
      ) : null}

      {!editable ? (
        <Alert tone="info" title="Read only">
          {role.capabilities.lockedReason
            ?? 'Changing what a role can do requires the “Edit a role’s permissions” permission.'}
        </Alert>
      ) : null}

      {/* Every checked key is submitted, including ones this caller could not
          grant — otherwise saving an unrelated change would silently strip a
          role of permissions the editor merely cannot see their way to adding.
          The server diffs against the stored set, so an unchanged key it would
          refuse is not treated as an addition. */}
      {[...checked].map((key) => (
        <input key={key} type="hidden" name="permissions" value={key} />
      ))}

      <div className="flex flex-col gap-3">
        {catalogue.categories.map(({ category, permissions }) => {
          const selectable = permissions.filter((p) => p.grantable);
          const allOn = selectable.length > 0 && selectable.every((p) => checked.has(p.key));
          const globalOnly = permissions.every((p) => !p.organizationScoped);

          return (
            <fieldset
              key={category}
              className="rounded-md border border-border-subtle bg-surface-raised"
            >
              <legend className="sr-only">{CATEGORY_LABELS[category] ?? category}</legend>

              <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2.5 py-1.5">
                <span className="text-xs font-medium text-text-primary">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                {editable && selectable.length > 0 ? (
                  <Button
                    type="button" variant="ghost" size="xs"
                    onClick={() => toggleCategory(permissions, !allOn)}
                  >
                    {allOn ? 'Clear all' : 'Select all'}
                  </Button>
                ) : null}
              </div>

              {globalOnly ? (
                <p className="px-2.5 py-2 text-2xs text-text-tertiary">
                  Global permissions belong to system administrators and can never be attached
                  to an organization role — the database refuses it as well as the API.
                </p>
              ) : null}

              <ul className="grid gap-x-4 px-2.5 py-2 sm:grid-cols-2">
                {permissions.map((option) => {
                  const isChecked = checked.has(option.key);
                  // Ungrantable keys stay visible and stay checked if the role
                  // already carries them — just not editable by this caller.
                  const disabled = !editable || (!option.grantable && !isChecked);

                  const reason = !option.organizationScoped
                    ? 'Global scope — never allowed on an organization role'
                    : !option.grantable
                      ? 'You do not hold this permission yourself'
                      : null;

                  const row = (
                    <label
                      className={`flex items-start gap-2 py-1 text-xs ${
                        disabled ? 'text-text-disabled' : 'text-text-secondary'
                      }`}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(next) => toggle(option, next === true)}
                        disabled={disabled}
                        aria-label={option.label}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        <span className="block truncate font-mono text-2xs text-text-tertiary">
                          {option.key}
                        </span>
                      </span>
                      {option.risk === 'high' ? (
                        <Badge size="sm" variant={RISK_TONE[option.risk] ?? 'neutral'}>
                          High
                        </Badge>
                      ) : null}
                    </label>
                  );

                  return (
                    <li key={option.key}>
                      {reason ? <Tooltip content={reason}>{row}</Tooltip> : row}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
      </div>

      {editable ? (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1 text-2xs text-text-tertiary">
            <Users className="size-3" aria-hidden />
            {role.memberCount === 0
              ? 'No one holds this role yet.'
              : `Saving changes what ${role.memberCount} member(s) can do, immediately.`}
          </p>
          <div className="flex gap-2">
            <Button
              type="button" variant="ghost" size="sm"
              disabled={!dirty || pending}
              onClick={() => setChecked(new Set(role.permissions))}
            >
              Reset
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!dirty}>
              <Save aria-hidden /> Save permissions
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
