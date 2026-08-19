'use client';

import * as React from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Lock } from 'lucide-react';
import {
  Alert, Badge, Button, Checkbox, Field, Input, Modal, Textarea,
} from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/auth-action-types';
import { archiveRoleAction, createRoleAction, reorderRolesAction } from '@/lib/role-actions';
import type { PermissionCatalogue, RoleDto } from '@/lib/roles';

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

/**
 * The actor's ceiling as a plain number.
 *
 * A lead or a global administrator has none, which is represented as 101 — one
 * above the top of the 1–100 scale — so the same comparison works everywhere
 * without a special case at each call site.
 */
function ceilingOf(actorLevel: number | 'unbounded'): number {
  return actorLevel === 'unbounded' ? 101 : actorLevel;
}

// ── Create ─────────────────────────────────────────────────────────────────

export function CreateRoleDialog({
  open, onClose, organizationId, catalogue, actorLevel, takenLevels,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  catalogue: PermissionCatalogue;
  actorLevel: number | 'unbounded';
  takenLevels: number[];
}) {
  const action = createRoleAction.bind(null, organizationId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  // Controlled so a refusal does not discard the whole form.
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [level, setLevel] = React.useState('10');
  const [checked, setChecked] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  const ceiling = ceilingOf(actorLevel);
  const numericLevel = Number(level);
  const tooHigh = Number.isFinite(numericLevel) && numericLevel >= ceiling;
  const duplicate = takenLevels.includes(numericLevel);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Create a role"
      description="A rank in this organization's hierarchy, with the permissions it carries."
      size="lg"
    >
      <form action={formAction} className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not create the role">{state.message}</Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Name" htmlFor="new-role-name" required
            hint="The key is derived from this — “Field Training Officer” becomes field_training_officer.">
            <Input id="new-role-name" name="name" maxLength={80}
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Field Training Officer" disabled={pending} />
          </Field>

          <Field label="Hierarchy level" htmlFor="new-role-level" required
            hint="1–100. Higher is more senior.">
            <Input id="new-role-level" name="hierarchyLevel" type="number" min={1} max={100}
              value={level} onChange={(e) => setLevel(e.target.value)}
              invalid={tooHigh} disabled={pending} />
          </Field>
        </div>

        {tooHigh ? (
          <p className="flex items-center gap-1 text-2xs text-danger">
            <Lock className="size-3" aria-hidden />
            The server will refuse this: you cannot create a role at or above your own rank
            {actorLevel === 'unbounded' ? '' : ` (L${actorLevel})`}.
          </p>
        ) : null}

        {!tooHigh && duplicate ? (
          <p className="text-2xs text-text-tertiary">
            Another role already sits at L{numericLevel}. That is allowed — two roles at the
            same level rank equally, and neither can manage the other.
          </p>
        ) : null}

        <Field label="Description" htmlFor="new-role-desc">
          <Textarea id="new-role-desc" name="description" rows={2} maxLength={500}
            value={description} onChange={(e) => setDescription(e.target.value)}
            disabled={pending} />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
            Permissions ({checked.size} selected)
          </span>
          <p className="text-2xs text-text-tertiary">
            Only permissions you hold yourself are offered — a role can never be created
            carrying authority its creator does not have.
          </p>

          {[...checked].map((key) => (
            <input key={key} type="hidden" name="permissions" value={key} />
          ))}

          <div className="flex flex-col gap-2">
            {catalogue.categories.map(({ category, permissions }) => {
              const grantable = permissions.filter((p) => p.grantable);
              if (grantable.length === 0) return null;

              return (
                <fieldset key={category} className="rounded-md border border-border-subtle">
                  <legend className="sr-only">{CATEGORY_LABELS[category] ?? category}</legend>
                  <div className="border-b border-border-subtle px-2.5 py-1 text-xs font-medium text-text-primary">
                    {CATEGORY_LABELS[category] ?? category}
                  </div>
                  <ul className="grid gap-x-4 px-2.5 py-1.5 sm:grid-cols-2">
                    {grantable.map((option) => (
                      <li key={option.key}>
                        <label className="flex items-start gap-2 py-1 text-xs text-text-secondary">
                          <Checkbox
                            checked={checked.has(option.key)}
                            onCheckedChange={(next) => setChecked((prev) => {
                              const copy = new Set(prev);
                              if (next === true) copy.add(option.key); else copy.delete(option.key);
                              return copy;
                            })}
                            disabled={pending}
                            aria-label={option.label}
                          />
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {option.risk === 'high' ? (
                            <Badge size="sm" variant="danger">High</Badge>
                          ) : null}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}
            disabled={name.trim().length < 2}>
            Create role
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Archive ────────────────────────────────────────────────────────────────

export function ArchiveRoleDialog({
  organizationId, role, onClose,
}: {
  organizationId: string;
  role: RoleDto;
  onClose: () => void;
}) {
  const action = archiveRoleAction.bind(null, organizationId, role.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Archive ${role.name}`}
      description={`Level ${role.hierarchyLevel} · ${role.permissionCount} permission(s)`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not archive">{state.message}</Alert>
        ) : null}

        <Alert tone="warning" title="What archiving does">
          <ul className="ml-4 list-disc space-y-0.5">
            <li>The role is retained in full — <strong>nothing is deleted</strong>.</li>
            <li>Its permissions, history and audit trail are kept.</li>
            <li>It disappears from the rank list and can no longer be assigned.</li>
            <li>It can be restored, if you still hold everything it carries.</li>
          </ul>
        </Alert>

        {role.memberCount > 0 ? (
          <Alert tone="danger" title="This role is still held">
            {role.memberCount} member(s) hold it. Archiving would leave them without a rank, so
            the server will refuse — reassign them first.
          </Alert>
        ) : null}

        <Field label="Reason" htmlFor="archive-reason" required
          hint="Written to the audit log and kept on the archived record.">
          <Input id="archive-reason" name="reason" maxLength={280} minLength={3} required
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. merged into Senior Officer" disabled={pending} />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" size="sm" loading={pending}
            disabled={reason.trim().length < 3 || role.memberCount > 0}>
            <AlertTriangle aria-hidden /> Archive role
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Reorder ────────────────────────────────────────────────────────────────

/**
 * Reordering as a level editor rather than drag-and-drop.
 *
 * The hierarchy is a numeric scale with deliberate gaps, and dragging hides the
 * numbers that actually decide who can manage whom. Editing the levels directly
 * keeps the thing being changed visible — and the batch is applied
 * all-or-nothing by the server, so a refusal leaves the whole hierarchy as it
 * was rather than half-moved.
 */
export function ReorderDialog({
  organizationId, roles, actorLevel, onClose, onResult,
}: {
  organizationId: string;
  roles: RoleDto[];
  actorLevel: number | 'unbounded';
  onClose: () => void;
  onResult: (state: ActionState) => void;
}) {
  const [levels, setLevels] = React.useState<Record<string, string>>(
    () => Object.fromEntries(roles.map((r) => [r.id, String(r.hierarchyLevel)])),
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const ceiling = ceilingOf(actorLevel);

  const rows = React.useMemo(
    () => [...roles].sort((a, b) =>
      Number(levels[b.id] ?? b.hierarchyLevel) - Number(levels[a.id] ?? a.hierarchyLevel)),
    [roles, levels],
  );

  const changed = roles.filter(
    (r) => Number(levels[r.id]) !== r.hierarchyLevel && Number.isInteger(Number(levels[r.id])),
  );

  const refusable = changed.filter(
    (r) => Number(levels[r.id]) >= ceiling || r.hierarchyLevel >= ceiling || r.isSystem,
  );

  async function submit() {
    setPending(true);
    setError(null);
    const result = await reorderRolesAction(
      organizationId,
      changed.map((r) => ({ roleId: r.id, hierarchyLevel: Number(levels[r.id]) })),
    );
    setPending(false);
    if (result.status === 'error') setError(result.message ?? 'Refused.');
    else { onResult(result); onClose(); }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Reorder the hierarchy"
      description="Higher numbers are more senior. Applied all at once, or not at all."
      size="lg"
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        {error ? <Alert tone="danger" title="Refused">{error}</Alert> : null}

        {refusable.length > 0 ? (
          <Alert tone="warning" title="Some of these will be refused">
            You cannot move a role to, or away from, a position at or above your own rank
            {actorLevel === 'unbounded' ? '' : ` (L${actorLevel})`}. The whole batch is refused
            together, so nothing changes until these are corrected:{' '}
            {refusable.map((r) => r.name).join(', ')}.
          </Alert>
        ) : null}

        <ul className="flex flex-col">
          {rows.map((role) => {
            const value = levels[role.id] ?? String(role.hierarchyLevel);
            const moved = Number(value) !== role.hierarchyLevel;
            const blocked = Number(value) >= ceiling || role.hierarchyLevel >= ceiling;

            return (
              <li
                key={role.id}
                className="flex items-center gap-3 border-b border-border-subtle py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-text-primary">{role.name}</span>
                    {role.isDefault ? <Badge size="sm" variant="info">Default</Badge> : null}
                    {blocked ? (
                      <Badge size="sm" variant="neutral" className="gap-1">
                        <Lock className="size-3" aria-hidden /> Out of reach
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block font-mono text-2xs text-text-tertiary">
                    {role.memberCount} member(s)
                  </span>
                </span>

                {moved ? (
                  <span className="flex shrink-0 items-center gap-1 font-mono text-2xs text-warning">
                    {Number(value) > role.hierarchyLevel
                      ? <ArrowUp className="size-3" aria-hidden />
                      : <ArrowDown className="size-3" aria-hidden />}
                    {role.hierarchyLevel} → {value}
                  </span>
                ) : null}

                <Input
                  type="number" min={1} max={100} inputSize="sm" className="w-[84px] shrink-0"
                  value={value}
                  invalid={blocked}
                  disabled={pending || role.isSystem}
                  aria-label={`Hierarchy level for ${role.name}`}
                  onChange={(e) => setLevels((prev) => ({ ...prev, [role.id]: e.target.value }))}
                />
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-2xs text-text-tertiary">
            {changed.length === 0 ? 'No changes yet.' : `${changed.length} role(s) will move.`}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              type="button" variant="primary" size="sm" loading={pending}
              disabled={changed.length === 0}
              onClick={submit}
            >
              Apply new order
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
