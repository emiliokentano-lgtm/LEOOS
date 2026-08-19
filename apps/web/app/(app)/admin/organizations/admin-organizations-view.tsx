'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Building2, Plus, Power, PowerOff, ShieldCheck, SquareArrowOutUpRight,
} from 'lucide-react';
import { ORGANIZATION_CATEGORIES, type OrganizationCategory } from '@leoos/contracts';
import {
  Alert, Badge, Button, ConfirmationDialog, Field, Input, Modal, OrgBadge,
  Panel, PanelHeader, Select, Textarea, Tooltip, useToast,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { IDLE } from '@/lib/auth-action-types';
import {
  createOrganizationAction, setOrganizationActiveAction,
} from '@/lib/organization-actions';
import type { OrganizationDto, OrganizationLeadDto } from '@/lib/organizations';

/**
 * Global organization administration.
 *
 * Everything here is a global-administrator action. The screen shows current
 * leads per organization so the "who leads what" question is answerable in one
 * place, which is the question this capability exists to make auditable.
 */
export function AdminOrganizationsView({
  organizations, leadsByOrganization,
}: {
  organizations: OrganizationDto[];
  leadsByOrganization: Record<string, OrganizationLeadDto[]>;
}) {
  const [creating, setCreating] = React.useState(false);
  const [toggling, setToggling] = React.useState<OrganizationDto | null>(null);
  const { push } = useToast();
  const [pending, startTransition] = React.useTransition();

  function toggleActive(org: OrganizationDto) {
    startTransition(async () => {
      const result = await setOrganizationActiveAction(org.id, !org.isActive);
      push({
        tone: result.status === 'success' ? 'success' : 'danger',
        title: result.status === 'success' ? 'Updated' : 'Could not update',
        description: result.message,
      });
      setToggling(null);
    });
  }

  const active = organizations.filter((o) => !o.isArchived);

  return (
    <PageContainer>
      <div className="flex flex-col gap-3">
        <Alert tone="info" title="Organizations are database records">
          Adding one is a row insert plus a role seed — no code change, no deployment.
          Nothing in the application branches on an organization key.
        </Alert>

        <Panel flush>
          <PanelHeader
            title="Organizations"
            icon={<Building2 />}
            actions={
              <>
                <Badge variant="neutral" mono>{active.length}</Badge>
                <Button variant="primary" size="xs" onClick={() => setCreating(true)}>
                  <Plus aria-hidden /> New organization
                </Button>
              </>
            }
          />

          <ul>
            {organizations.map((org) => {
              const leads = leadsByOrganization[org.id] ?? [];
              const category = ORGANIZATION_CATEGORIES[org.category];
              return (
                <li key={org.id}
                  className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0 hover:bg-hover">
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-xs font-mono text-2xs font-bold"
                    style={{ backgroundColor: org.color, color: '#0b0e14' }}
                    aria-hidden
                  >
                    {org.shortName.slice(0, 3)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-text-primary">{org.name}</span>
                      <OrgBadge shortName={org.key} color={org.color} size="sm" />
                      <Badge size="sm" variant="outline">{category.label}</Badge>
                      {org.isArchived ? <Badge size="sm" variant="danger">Archived</Badge>
                        : org.isActive ? null : <Badge size="sm" variant="warning">Disabled</Badge>}
                    </div>
                    <p className="truncate text-2xs text-text-tertiary">
                      {org.description ?? 'No description'}
                    </p>
                  </div>

                  <div className="flex min-w-[180px] shrink-0 items-center gap-1.5">
                    {leads.length === 0 ? (
                      <Badge size="sm" variant="warning">No lead</Badge>
                    ) : (
                      <Tooltip content={leads.map((l) => `${l.displayName} (${l.username})`).join(', ')}>
                        <Badge size="sm" variant="accent" className="gap-1">
                          <ShieldCheck aria-hidden />
                          {leads.length === 1 ? leads[0]!.displayName : `${leads.length} leads`}
                        </Badge>
                      </Tooltip>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {!org.isArchived ? (
                      <Tooltip content={org.isActive ? 'Disable organization' : 'Enable organization'}>
                        <Button
                          variant={org.isActive ? 'ghost' : 'secondary'}
                          size="xs"
                          disabled={pending}
                          onClick={() => setToggling(org)}
                        >
                          {org.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                          {org.isActive ? 'Disable' : 'Enable'}
                        </Button>
                      </Tooltip>
                    ) : null}
                    <Button asChild variant="ghost" size="xs">
                      <Link href="/organization">
                        Manage <SquareArrowOutUpRight aria-hidden />
                      </Link>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />

      {toggling ? (
        <ConfirmationDialog
          open
          onOpenChange={(v) => { if (!v) setToggling(null); }}
          title={toggling.isActive
            ? `Disable ${toggling.name}?`
            : `Enable ${toggling.name}?`}
          tone={toggling.isActive ? 'danger' : 'default'}
          confirmLabel={toggling.isActive ? 'Disable' : 'Enable'}
          description={toggling.isActive
            ? 'Members keep their records and history. The organization is excluded from operational views until it is re-enabled.'
            : 'The organization returns to operational views immediately.'}
          onConfirm={() => toggleActive(toggling)}
        />
      ) : null}
    </PageContainer>
  );
}

const CATEGORY_OPTIONS = (Object.keys(ORGANIZATION_CATEGORIES) as OrganizationCategory[])
  .map((key) => ({ value: key, label: ORGANIZATION_CATEGORIES[key].label }));

function CreateOrganizationDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [state, formAction, pending] = React.useActionState(createOrganizationAction, IDLE);
  const [category, setCategory] = React.useState<string>('other');

  React.useEffect(() => {
    if (state.status === 'success') onOpenChange(false);
  }, [state.status, onOpenChange]);

  return (
    <Modal
      open={open} onOpenChange={onOpenChange}
      title="New organization"
      description="It becomes available immediately. Roles are created separately."
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not create">{state.message}</Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Key" htmlFor="org-key" required
            hint="Stable machine name, e.g. FIRE. Uppercase.">
            <Input id="org-key" name="key" required minLength={2} maxLength={24}
              pattern="[A-Za-z0-9_-]+" disabled={pending}
              className="font-mono uppercase" placeholder="FIRE" />
          </Field>
          <Field label="Short name" htmlFor="org-short" required hint="Shown on badges.">
            <Input id="org-short" name="shortName" required maxLength={24}
              disabled={pending} placeholder="LSFD" />
          </Field>
        </div>

        <Field label="Name" htmlFor="org-name" required>
          <Input id="org-name" name="name" required minLength={2} maxLength={120}
            disabled={pending} placeholder="Los Santos Fire Department" />
        </Field>

        <Field label="Category" htmlFor="org-cat" required
          hint="Drives cross-organization behaviour, such as who may read medical records.">
          <Select id="org-cat" value={category} onValueChange={setCategory}
            options={CATEGORY_OPTIONS} />
        </Field>
        <input type="hidden" name="category" value={category} />

        <Field label="Description" htmlFor="org-desc">
          <Textarea id="org-desc" name="description" maxLength={500} disabled={pending} />
        </Field>

        <Field label="Identity colour" htmlFor="org-color">
          <input type="color" id="org-color" name="color" defaultValue="#6b7686"
            disabled={pending}
            className="h-8 w-16 cursor-pointer rounded-xs border border-border bg-raised" />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}>
            Create organization
          </Button>
        </div>
      </form>
    </Modal>
  );
}
