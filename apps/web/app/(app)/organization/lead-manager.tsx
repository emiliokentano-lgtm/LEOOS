'use client';

import * as React from 'react';
import { ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import {
  Alert, Badge, Button, EmptyState, Field, Input, Modal,
  Panel, PanelHeader, Select,
} from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import { IDLE } from '@/lib/auth-action-types';
import { grantLeadAction, revokeLeadAction } from '@/lib/organization-actions';
import type { LeadCandidate, OrganizationLeadDto } from '@/lib/organizations';

/**
 * Organization Lead management.
 *
 * Rendered read-only unless the caller is a global administrator. That is a
 * usability affordance: the API reserves both grant and revoke to global
 * administrators outright, so an organization lead who reached these controls
 * anyway would be refused — and the refusal is audited.
 */
export function LeadManager({
  organizationId, organizationName, leads, candidates, canManage,
}: {
  organizationId: string;
  organizationName: string;
  leads: OrganizationLeadDto[];
  candidates: LeadCandidate[];
  canManage: boolean;
}) {
  const [granting, setGranting] = React.useState(false);
  const [revoking, setRevoking] = React.useState<OrganizationLeadDto | null>(null);

  return (
    <>
      <Panel flush className="min-h-[280px]">
        <PanelHeader
          title="Organization leads"
          icon={<ShieldCheck />}
          description={`Authority over ${organizationName} only`}
          actions={
            canManage ? (
              <Button variant="primary" size="xs" onClick={() => setGranting(true)}>
                <UserPlus aria-hidden /> Appoint lead
              </Button>
            ) : (
              <Badge variant="neutral">Global administrators only</Badge>
            )
          }
        />

        <div className="p-3">
          <Alert tone="info" title="What an Organization Lead can do">
            Full authority inside {organizationName} — manage every member, every role, and the
            organization&apos;s settings. <strong>Nothing outside it.</strong> Leading one
            organization confers no authority in any other, and no global administrator rights.
          </Alert>
        </div>

        {leads.length === 0 ? (
          <EmptyState
            title="No organization lead appointed"
            description={canManage
              ? 'Appoint an active member to lead this organization.'
              : 'Only a global administrator can appoint one.'}
            action={canManage
              ? <Button size="sm" onClick={() => setGranting(true)}>Appoint lead</Button>
              : undefined}
          />
        ) : (
          <ul className="max-h-[520px] overflow-auto">
            {leads.map((lead) => (
              <li key={lead.userId}
                className="flex items-center gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0">
                <ShieldCheck className="size-4 shrink-0 text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{lead.displayName}</p>
                  <p className="truncate font-mono text-2xs text-text-tertiary">
                    {lead.username} · {lead.email}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-2xs text-text-tertiary">
                    Since {formatDateTime(lead.grantedAt)}
                  </p>
                  {lead.grantedBy ? (
                    <p className="text-2xs text-text-disabled">by {lead.grantedBy}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <Button variant="danger-outline" size="xs" onClick={() => setRevoking(lead)}>
                    <ShieldOff aria-hidden /> Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <GrantDialog
        open={granting} onOpenChange={setGranting}
        organizationId={organizationId} organizationName={organizationName}
        candidates={candidates}
      />

      {revoking ? (
        <RevokeDialog
          lead={revoking} organizationId={organizationId} organizationName={organizationName}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </>
  );
}

function GrantDialog({
  open, onOpenChange, organizationId, organizationName, candidates,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  organizationId: string;
  organizationName: string;
  candidates: LeadCandidate[];
}) {
  const action = grantLeadAction.bind(null, organizationId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [userId, setUserId] = React.useState('');

  React.useEffect(() => {
    if (state.status === 'success') onOpenChange(false);
  }, [state.status, onOpenChange]);

  return (
    <Modal
      open={open} onOpenChange={onOpenChange}
      title="Appoint an Organization Lead"
      description={`Full authority inside ${organizationName}, and nowhere else.`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not appoint">{state.message}</Alert>
        ) : null}

        {candidates.length === 0 ? (
          <Alert tone="warning" title="No eligible members">
            A lead must already be an active member of this organization. Hire them first.
          </Alert>
        ) : (
          <>
            <Field label="Member" htmlFor="lead-user" required
              hint="Only active members appear here.">
              <Select
                id="lead-user"
                value={userId}
                onValueChange={setUserId}
                placeholder="Choose a member…"
                options={candidates.map((c) => ({
                  value: c.userId,
                  label: c.roleName ? `${c.displayName} — ${c.roleName}` : c.displayName,
                }))}
              />
            </Field>
            <input type="hidden" name="userId" value={userId} />

            <Field label="Reason" htmlFor="lead-reason"
              hint="Recorded in the audit log alongside who appointed them and when.">
              <Input id="lead-reason" name="reason" maxLength={280}
                placeholder="e.g. appointed Chief of Police" disabled={pending} />
            </Field>

            <Alert tone="warning" title="This is a highly privileged action">
              The appointee will be able to manage every member and role in {organizationName},
              including promoting members above their previous rank.
            </Alert>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!userId}>
                Appoint lead
              </Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}

function RevokeDialog({
  lead, organizationId, organizationName, onClose,
}: {
  lead: OrganizationLeadDto;
  organizationId: string;
  organizationName: string;
  onClose: () => void;
}) {
  const action = revokeLeadAction.bind(null, organizationId, lead.userId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  return (
    <Modal
      open onOpenChange={(v) => { if (!v) onClose(); }}
      title={`Revoke ${lead.displayName}'s lead capability?`}
      size="sm"
    >
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not revoke">{state.message}</Alert>
        ) : null}

        <Alert tone="danger" title="This will:">
          <ul className="list-inside list-disc space-y-0.5">
            <li>End their authority over {organizationName} immediately</li>
            <li>Sign them out of every device</li>
            <li>Leave their membership and rank untouched</li>
          </ul>
        </Alert>

        <Field label="Reason" htmlFor="revoke-reason"
          hint="Recorded in the audit log.">
          <Input id="revoke-reason" name="reason" maxLength={280} disabled={pending}
            placeholder="e.g. stepped down" />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" size="sm" loading={pending}>
            Revoke capability
          </Button>
        </div>
      </form>
    </Modal>
  );
}

