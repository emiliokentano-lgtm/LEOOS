'use client';

import * as React from 'react';
import { Save, Settings } from 'lucide-react';
import {
  Alert, Button, Field, Input, Panel, PanelHeader, Textarea, Toggle,
} from '@/components/ui';
import { IDLE } from '@/lib/auth-action-types';
import { updateOrganizationAction } from '@/lib/organization-actions';
import type { OrganizationDto } from '@/lib/organizations';

/**
 * Organization profile and settings.
 *
 * `canEdit` decides whether the form is interactive. It is cosmetic — the API
 * refuses the write regardless of what was rendered, and refuses it for a
 * different organization even if the id were tampered with, because the id
 * travels in the path and authority is re-derived there.
 *
 * Category and activation are absent by design: both are global-administrator
 * decisions and live on the administration screen.
 */
export function OrganizationSettingsForm({
  organization, canEdit,
}: {
  organization: OrganizationDto;
  canEdit: boolean;
}) {
  const action = updateOrganizationAction.bind(null, organization.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const settings = organization.settings as Record<string, boolean | undefined>;

  return (
    <form action={formAction}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel flush>
          <PanelHeader title="Profile" icon={<Settings />} />
          <div className="flex flex-col gap-3 p-3">
            {!canEdit ? (
              <Alert tone="info" title="Read only">
                Editing this organization requires the Organization Lead capability or the
                <span className="font-mono"> organization.edit </span> permission.
              </Alert>
            ) : null}
            {state.status === 'error' ? (
              <Alert tone="danger" title="Could not save">{state.message}</Alert>
            ) : null}
            {state.status === 'success' ? (
              <Alert tone="success" title="Saved">{state.message}</Alert>
            ) : null}

            <Field label="Name" htmlFor="org-name" required>
              <Input id="org-name" name="name" defaultValue={organization.name}
                disabled={!canEdit || pending} required minLength={2} />
            </Field>

            <Field label="Short name" htmlFor="org-short" required
              hint="Shown on badges, unit rows and the map.">
              <Input id="org-short" name="shortName" defaultValue={organization.shortName}
                disabled={!canEdit || pending} required maxLength={24} />
            </Field>

            <Field label="Description" htmlFor="org-desc">
              <Textarea id="org-desc" name="description" defaultValue={organization.description ?? ''}
                disabled={!canEdit || pending} maxLength={500} />
            </Field>

            <Field label="Identity colour" htmlFor="org-color"
              hint="Used for badges and map markers. Read from this record, never from a stylesheet.">
              <div className="flex items-center gap-2">
                <input type="color" name="color" id="org-color" defaultValue={organization.color}
                  disabled={!canEdit || pending}
                  className="h-8 w-12 cursor-pointer rounded-xs border border-border bg-raised disabled:cursor-not-allowed" />
                <span className="font-mono text-xs text-text-secondary">{organization.color}</span>
              </div>
            </Field>
          </div>
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel flush>
            <PanelHeader title="Operational settings" />
            <div className="flex flex-col gap-3 p-3">
              <Toggle name="shareOnPublicMap" defaultChecked={settings.shareOnPublicMap ?? false}
                disabled={!canEdit || pending}
                label="Share units on the public map"
                description="Other organizations can see this organization's units. Leave off for covert work." />
              <Toggle name="allowSelfDispatch" defaultChecked={settings.allowSelfDispatch ?? false}
                disabled={!canEdit || pending}
                label="Allow self-dispatch"
                description="Members may assign themselves to a call without a dispatcher." />
              <Toggle name="requireCallsignOnDuty" defaultChecked={settings.requireCallsignOnDuty ?? false}
                disabled={!canEdit || pending}
                label="Require a callsign to go on duty"
                description="Blocks going on duty without an assigned callsign." />
              <Toggle name="panicNotifiesAllOrganizations"
                defaultChecked={settings.panicNotifiesAllOrganizations ?? false}
                disabled={!canEdit || pending}
                label="Panic notifies all organizations"
                description="A panic alert reaches every on-duty unit, not only this organization's." />
            </div>
          </Panel>

          {canEdit ? (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="md" loading={pending}>
                <Save aria-hidden /> Save changes
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}
