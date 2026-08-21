'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ArrowLeft, Ban, CircleCheck, Clock, Mail, ShieldCheck, ShieldOff, TriangleAlert,
} from 'lucide-react';
import {
  ACCOUNT_STATUSES, SETTABLE_ACCOUNT_STATUSES,
  type AccountStatusMeta, type AdminUserDetail, type GlobalCapabilityKey,
  type GlobalCapabilityMeta,
} from '@leoos/contracts';
import {
  Alert, Badge, Button, Field, Input, Modal, Panel, PanelHeader, Select, Tooltip,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { IDLE } from '@/lib/auth-action-types';
import {
  changeAccountStatusAction, grantCapabilityAction, revokeCapabilityAction,
} from '@/lib/admin-actions';
import { formatDate, formatDateTime } from '@/lib/utils';

/**
 * One account.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THE CONTROLS PROMISE
 *
 * Every dialog here lists what the action ACTUALLY does — sessions ended,
 * memberships preserved, the holder signed out — because an administrator
 * suspending somebody mid-shift needs to know whether that person is about to
 * be dropped from a pursuit.
 *
 * Where an action is unavailable the reason is stated rather than the button
 * being silently greyed out. The reasons come from the API's `restrictions`
 * list, which is computed from the same decisions that would refuse the
 * request — so the explanation and the refusal cannot disagree.
 *
 * None of this is a permission check. The API re-decides every one of these
 * inside the transaction that performs it (engineering rule 9).
 * ────────────────────────────────────────────────────────────────────────────
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'warning',
  disabled: 'danger',
  pending_verification: 'neutral',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}

export function AdminUserDetailView({
  user, statuses, catalogue,
}: {
  user: AdminUserDetail;
  statuses: AccountStatusMeta[];
  catalogue: GlobalCapabilityMeta[];
}) {
  const [statusDialog, setStatusDialog] = React.useState(false);
  const [grantDialog, setGrantDialog] = React.useState(false);
  const [revoking, setRevoking] = React.useState<GlobalCapabilityKey | null>(null);

  const settable = statuses.filter((s) => SETTABLE_ACCOUNT_STATUSES.includes(s.key));
  const held = new Set(user.globalCapabilities.map((c) => c.key));
  const grantable = catalogue.filter((c) => !held.has(c.key));

  return (
    <PageContainer>
      <div className="flex max-w-4xl flex-col gap-3">
        <Link
          href={'/admin/users' as Route}
          className="flex w-fit items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Back to the register
        </Link>

        {/* Restrictions first: the answer to "why is that button not there". */}
        {user.capabilities.restrictions.length > 0 ? (
          <Alert tone="info" title="Some actions are unavailable on this account">
            <ul className="list-inside list-disc space-y-0.5">
              {user.capabilities.restrictions.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </Alert>
        ) : null}

        {user.lockedUntil ? (
          <Alert tone="warning" title="This account is locked out by failed sign-ins">
            The lock lifts automatically at {formatDateTime(user.lockedUntil)}. It is a
            temporary rate limit, not an administrative decision — no action is needed.
          </Alert>
        ) : null}

        <Panel flush>
          <PanelHeader
            title={user.displayName}
            description={<span className="font-mono">{user.username}</span>}
            actions={
              <div className="flex items-center gap-1.5">
                <Badge variant={STATUS_TONE[user.status] ?? 'neutral'}>
                  {ACCOUNT_STATUSES[user.status].label}
                </Badge>
                {user.capabilities.canChangeStatus ? (
                  <Button variant="secondary" size="xs" onClick={() => setStatusDialog(true)}>
                    Change status
                  </Button>
                ) : null}
              </div>
            }
          />

          <dl className="flex flex-col gap-2 p-3">
            <Row label="Email">
              <span className="flex items-center justify-end gap-1.5">
                <span className="font-mono">{user.email}</span>
                {user.emailVerified ? (
                  <Tooltip content={`Verified ${formatDate(user.emailVerifiedAt ?? '')}`}>
                    <CircleCheck className="size-3.5 text-success" aria-label="Verified" />
                  </Tooltip>
                ) : (
                  <Tooltip content="Never verified. This account cannot be activated until it is.">
                    <TriangleAlert className="size-3.5 text-warning" aria-label="Not verified" />
                  </Tooltip>
                )}
              </span>
            </Row>
            <Row label="Account state">
              <span className="text-text-secondary">{ACCOUNT_STATUSES[user.status].description}</span>
            </Row>
            <Row label="Created"><span className="font-mono">{formatDateTime(user.createdAt)}</span></Row>
            <Row label="Last login">
              {user.lastLoginAt
                ? <span className="font-mono">{formatDateTime(user.lastLoginAt)}</span>
                : <span className="text-text-disabled">never signed in</span>}
            </Row>
            {user.lastLoginIp ? (
              <Row label="Last login from"><span className="font-mono">{user.lastLoginIp}</span></Row>
            ) : null}
            <Row label="Active sessions">
              <span className="font-mono">{user.activeSessionCount}</span>
            </Row>
          </dl>
        </Panel>

        {/* ── Global capabilities ──────────────────────────────────────── */}
        <Panel flush>
          <PanelHeader
            title="Global capabilities"
            icon={<ShieldCheck />}
            description="Grant nothing inside an organization — they operate across the whole system"
            actions={
              user.capabilities.canGrantCapabilities && grantable.length > 0 ? (
                <Button variant="secondary" size="xs" onClick={() => setGrantDialog(true)}>
                  Grant capability
                </Button>
              ) : null
            }
          />
          {user.globalCapabilities.length === 0 ? (
            <p className="p-3 text-xs text-text-tertiary">
              None. This account holds no authority outside its organization memberships.
            </p>
          ) : (
            <ul>
              {user.globalCapabilities.map((grant) => {
                const meta = catalogue.find((c) => c.key === grant.key);
                return (
                  <li
                    key={grant.key}
                    className="flex items-start gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge size="sm" variant={grant.key === 'global_admin' ? 'danger' : 'outline'}>
                          {meta?.label ?? grant.key}
                        </Badge>
                        <span className="text-2xs text-text-tertiary">
                          granted {formatDate(grant.grantedAt)}
                          {grant.grantedByName ? ` by ${grant.grantedByName}` : ''}
                        </span>
                      </div>
                      {meta ? (
                        <p className="mt-1 text-2xs text-text-secondary">{meta.description}</p>
                      ) : null}
                    </div>
                    {user.capabilities.canGrantCapabilities ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-danger"
                        onClick={() => setRevoking(grant.key)}
                      >
                        <ShieldOff aria-hidden /> Revoke
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* ── Memberships ─────────────────────────────────────────────── */}
        <Panel flush>
          <PanelHeader
            title="Memberships"
            description="Including former ones — employment history is kept, not erased"
          />
          {user.memberships.length === 0 ? (
            <p className="p-3 text-xs text-text-tertiary">
              No membership in any organization. This account can sign in but cannot reach
              any operational screen.
            </p>
          ) : (
            <ul>
              {user.memberships.map((m) => (
                <li
                  key={m.memberId}
                  className="flex items-start gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                >
                  <span
                    className="mt-0.5 rounded-[2px] border px-1 text-[10px] font-medium"
                    style={{ borderColor: m.organization.color, color: m.organization.color }}
                  >
                    {m.organization.shortName}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-text-primary">
                        {m.organization.name}
                      </span>
                      {m.isOrgLead ? (
                        <Tooltip content="Unbounded authority inside this organization — and nothing outside it">
                          <Badge size="sm" variant="warning">
                            <ShieldCheck aria-hidden /> Lead
                          </Badge>
                        </Tooltip>
                      ) : null}
                      {m.status !== 'active' ? (
                        <Badge size="sm" variant="neutral">{m.status}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-2xs text-text-tertiary">
                      {m.roles.length > 0
                        ? m.roles.map((r) => `${r.name} (${r.hierarchyLevel})`).join(', ')
                        : 'no role assigned'}
                      {m.callsign ? ` · ${m.callsign}` : ''}
                      {m.employeeNumber ? ` · #${m.employeeNumber}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-right font-mono text-2xs text-text-tertiary">
                    <Clock className="mr-1 inline size-3" aria-hidden />
                    {formatDate(m.joinedAt)}
                    {m.leftAt ? ` → ${formatDate(m.leftAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <p className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <Mail className="size-3" aria-hidden />
          Password and two-factor material is never readable from this screen — it never
          leaves the API process.
        </p>
      </div>

      {statusDialog ? (
        <StatusDialog
          user={user}
          statuses={settable}
          onClose={() => setStatusDialog(false)}
        />
      ) : null}

      {grantDialog ? (
        <GrantDialog
          userId={user.id}
          displayName={user.displayName}
          options={grantable}
          onClose={() => setGrantDialog(false)}
        />
      ) : null}

      {revoking ? (
        <RevokeDialog
          userId={user.id}
          displayName={user.displayName}
          capability={revoking}
          meta={catalogue.find((c) => c.key === revoking)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </PageContainer>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function StatusDialog({
  user, statuses, onClose,
}: {
  user: AdminUserDetail;
  statuses: AccountStatusMeta[];
  onClose: () => void;
}) {
  const action = changeAccountStatusAction.bind(null, user.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [status, setStatus] = React.useState(
    statuses.find((s) => s.key !== user.status)?.key ?? 'suspended',
  );

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  const chosen = statuses.find((s) => s.key === status);
  const isDeactivation = status !== 'active';

  return (
    <Modal open onOpenChange={(v) => { if (!v) onClose(); }} title={`Change ${user.displayName}'s account status`} size="sm">
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not change the status">{state.message}</Alert>
        ) : null}

        <Field label="New status" htmlFor="status">
          <Select
            id="status"
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
            options={statuses.map((s) => ({
              value: s.key,
              label: s.label,
              disabled: s.key === user.status,
            }))}
            disabled={pending}
          />
        </Field>
        {/* Select is a Radix listbox, not a native <select>, so the value
            reaches the action through a hidden input. */}
        <input type="hidden" name="status" value={status} />

        {chosen ? (
          <p className="text-xs text-text-secondary">{chosen.description}</p>
        ) : null}

        {/*
          * What the action actually does, stated before it is taken.
          *
          * Suspending somebody mid-shift drops them out of dispatch; the
          * administrator taking the decision should know that from the dialog
          * rather than from the complaint afterwards.
          */}
        <Alert tone={isDeactivation ? 'danger' : 'info'} title="This will:">
          <ul className="list-inside list-disc space-y-0.5">
            {isDeactivation ? (
              <>
                <li>Stop them signing in</li>
                <li>End all {user.activeSessionCount} of their active sessions immediately</li>
                <li>Leave their memberships, ranks and history untouched</li>
              </>
            ) : (
              <>
                <li>Let them sign in again</li>
                <li>Restore the permissions their memberships already grant</li>
                <li>Require them to sign in — existing sessions are not restored</li>
              </>
            )}
          </ul>
        </Alert>

        {status === 'active' && !user.emailVerified ? (
          <Alert tone="warning" title="This account has never verified its email">
            Activation will be refused. The account holder must complete verification first.
          </Alert>
        ) : null}

        <Field label="Reason" htmlFor="status-reason" hint="Recorded in the audit log.">
          <Input id="status-reason" name="reason" maxLength={280} disabled={pending}
            placeholder="e.g. left the community" />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={isDeactivation ? 'danger' : 'primary'} size="sm" loading={pending}>
            {isDeactivation ? <Ban aria-hidden /> : <CircleCheck aria-hidden />}
            {chosen ? `Set ${chosen.label.toLowerCase()}` : 'Apply'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function GrantDialog({
  userId, displayName, options, onClose,
}: {
  userId: string;
  displayName: string;
  options: GlobalCapabilityMeta[];
  onClose: () => void;
}) {
  const action = grantCapabilityAction.bind(null, userId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [capability, setCapability] = React.useState(options[0]?.key ?? '');

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  const chosen = options.find((c) => c.key === capability);

  return (
    <Modal open onOpenChange={(v) => { if (!v) onClose(); }} title={`Grant a global capability to ${displayName}`} size="sm">
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not grant">{state.message}</Alert>
        ) : null}

        <Field label="Capability" htmlFor="capability">
          <Select
            id="capability"
            value={capability}
            onValueChange={setCapability}
            options={options.map((c) => ({ value: c.key, label: c.label }))}
            disabled={pending}
          />
        </Field>
        <input type="hidden" name="capability" value={capability} />

        {chosen ? (
          <p className="text-xs text-text-secondary">{chosen.description}</p>
        ) : null}

        {chosen?.key === 'global_admin' ? (
          <Alert tone="danger" title="This is unrestricted authority">
            A global administrator can administer every account, organization and capability
            in the system, including yours. Only they can grant this capability, and only
            another global administrator can take it back.
          </Alert>
        ) : null}

        <Alert tone="info" title="This will:">
          <ul className="list-inside list-disc space-y-0.5">
            <li>Take effect from their next sign-in</li>
            <li>Sign them out of every device now, so the change cannot be missed</li>
            <li>Be recorded in the audit log against your account</li>
          </ul>
        </Alert>

        <Field label="Reason" htmlFor="grant-reason" hint="Recorded in the audit log.">
          <Input id="grant-reason" name="reason" maxLength={280} disabled={pending}
            placeholder="e.g. appointed as reviewer" />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}>
            <ShieldCheck aria-hidden /> Grant capability
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeDialog({
  userId, displayName, capability, meta, onClose,
}: {
  userId: string;
  displayName: string;
  capability: GlobalCapabilityKey;
  meta: GlobalCapabilityMeta | undefined;
  onClose: () => void;
}) {
  const action = revokeCapabilityAction.bind(null, userId, capability);
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);

  return (
    <Modal
      open
      onOpenChange={(v) => { if (!v) onClose(); }}
      title={`Revoke ${meta?.label ?? capability} from ${displayName}?`}
      size="sm"
    >
      <form action={formAction} className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert tone="danger" title="Could not revoke">{state.message}</Alert>
        ) : null}

        <Alert tone="danger" title="This will:">
          <ul className="list-inside list-disc space-y-0.5">
            <li>End that authority immediately</li>
            <li>Sign them out of every device</li>
            <li>Leave their organization memberships and ranks untouched</li>
          </ul>
        </Alert>

        {capability === 'global_admin' ? (
          <Alert tone="warning" title="Nothing inside the application can restore this">
            Only a global administrator can grant `global_admin`. If this is the last one,
            the request will be refused — grant it to somebody else first.
          </Alert>
        ) : null}

        <Field label="Reason" htmlFor="revoke-reason" hint="Recorded in the audit log.">
          <Input id="revoke-reason" name="reason" maxLength={280} disabled={pending}
            placeholder="e.g. no longer required" />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" size="sm" loading={pending}>
            <ShieldOff aria-hidden /> Revoke
          </Button>
        </div>
      </form>
    </Modal>
  );
}
