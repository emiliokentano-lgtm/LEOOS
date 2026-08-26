'use client';

import * as React from 'react';
import { LogOut, MapPin, Siren, TriangleAlert } from 'lucide-react';
import type {
  DispatchCapabilities, DispatchSelfState, DispatchUnit, OperationalStatusMeta, SoundCue,
} from '@leoos/contracts';
import { Button, Panel, PanelHeader, Select, useToast } from '@/components/ui';
import { Icon } from '@/components/icon';
import { joinUnit, leaveUnit, raiseFieldRequest } from '@/lib/dispatch-actions';
import { useDutyStatus } from '@/components/shell/duty-status-context';
import { useNotifications } from '@/components/shell/notification-context';
import { cn } from '@/lib/utils';

/**
 * The operator's own controls: status, unit, panic.
 *
 * This is the panel an officer actually touches during a shift, so it is first
 * in the column and its controls are large. Everything here acts on the caller
 * and therefore needs no dispatch permission — see the `/self` grouping in the
 * API routes.
 */
export function StatusControl({
  self, statuses, units, capabilities, onChanged,
}: {
  self: DispatchSelfState;
  statuses: OperationalStatusMeta[];
  units: DispatchUnit[];
  /**
   * Null on the shell's compact rendering, where the board has not been
   * loaded. A missing capability set hides the controls rather than guessing —
   * the server refuses either way, and a button that is always refused is worse
   * than no button.
   */
  capabilities: DispatchCapabilities | null;
  onChanged: () => void;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [confirmPanic, setConfirmPanic] = React.useState(false);
  const toast = useToast();

  /**
   * Status and panic go through the SHELL's context, not straight to the action.
   *
   * The top bar, the sidebar user card and this panel all show the operator's
   * status, and they are on screen together. Routing every change through one
   * context means they cannot disagree — the alternative is this panel updating
   * the board while the top bar keeps yesterday's value until its own poll.
   */
  const duty = useDutyStatus();
  const { playCue } = useNotifications();

  // Panic is not offered as an ordinary status: it is a separate, deliberate
  // action with its own confirmation and its own server-side lifecycle.
  const pickable = statuses.filter((s) => !s.isPanic);
  const current = statuses.find((s) => s.key === self.statusKey) ?? null;
  const myUnit = units.find((u) => u.id === self.unitId) ?? null;

  /**
   * Every self-action goes through here, which is why the cue does too.
   *
   * Fired AFTER the server said yes and next to the refresh that updates the
   * screen — never before the request, never on the click. A confirmation tone
   * for something that was then refused is worse than no tone at all: it tells
   * an operator their status changed when it did not.
   *
   * `cue` is null for the actions whose confirmation is already unmistakable on
   * screen — joining and leaving a unit rewrite the whole panel — because a cue
   * for everything is a cue for nothing.
   */
  async function run(
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    cue: SoundCue | null = null,
  ) {
    setPending(label);
    const result = await fn();
    setPending(null);
    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Refused', description: result.error });
      return;
    }
    if (cue !== null) playCue(cue);
    onChanged();
  }

  if (!self.canOperate) {
    return (
      <Panel flush>
        <PanelHeader title="Your status" />
        <p className="p-3 text-xs text-text-tertiary">
          {self.organizationId === null
            ? 'You are not acting in an organization, so you cannot go on duty.'
            : 'Your membership is not active, so you cannot go on duty.'}
        </p>
      </Panel>
    );
  }

  return (
    <Panel flush>
      <PanelHeader
        title="Your status"
        actions={current ? (
          <span
            className="rounded-xs border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: `var(${current.colorToken})`,
              color: `var(${current.colorToken})`,
            }}
          >
            {current.label}
          </span>
        ) : null}
      />

      <div className="flex flex-col gap-2.5 p-3">
        {/* Status buttons rather than a dropdown: this is pressed constantly and
            under time pressure, and a two-step control costs a second every time. */}
        <div className="grid grid-cols-2 gap-1.5">
          {pickable.map((status) => {
            const active = status.key === self.statusKey;
            return (
              <button
                key={status.key}
                type="button"
                disabled={pending !== null}
                onClick={() => { void run(status.key, () => duty.setStatus(status.key), 'status'); }}
                aria-pressed={active}
                className={cn(
                  'flex items-center gap-1.5 rounded-xs border px-2 py-1.5 text-xs',
                  'transition-colors duration-(--duration-fast) disabled:opacity-50',
                  active
                    ? 'border-border-strong bg-active text-text-primary'
                    : 'border-border bg-raised text-text-secondary hover:border-border-strong',
                )}
                style={active ? { borderColor: `var(${status.colorToken})` } : undefined}
              >
                <span className="shrink-0" style={{ color: `var(${status.colorToken})` }}>
                  <Icon name={status.icon} className="size-3.5" />
                </span>
                <span className="truncate">{status.label}</span>
              </button>
            );
          })}
        </div>

        {/* Unit */}
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-2.5">
          <p className="text-2xs uppercase tracking-wide text-text-tertiary">Unit</p>
          {myUnit ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-text-primary">
                {myUnit.callsign}
              </span>
              {self.isUnitLeader ? (
                <span className="text-[10px] uppercase tracking-wide text-text-tertiary">lead</span>
              ) : null}
              <Button
                variant="secondary" size="sm" className="ml-auto"
                disabled={pending !== null}
                onClick={() => { void run('leave', () => leaveUnit()); }}
              >
                <LogOut aria-hidden /> Leave
              </Button>
            </div>
          ) : (
            <UnitPicker
              units={units}
              disabled={pending !== null}
              onJoin={(unitId) => { void run('join', () => joinUnit(unitId)); }}
            />
          )}
        </div>

        {/*
          Asking for help, one press each.

          NO CONFIRMATION STEP, unlike panic, and the asymmetry is the point. A
          false panic pulls units off real calls; a false backup request costs
          somebody a glance at a strip that expires in three minutes. Making
          these two-step would put a dialog between an officer and the moment
          they need a hand.
        */}
        <div className="flex gap-1.5 border-t border-border-subtle pt-2.5">
          {capabilities?.canRequestBackup ? (
            <Button
              variant="secondary" size="sm" className="flex-1"
              disabled={pending !== null}
              onClick={() => { void run('backup', () => raiseFieldRequest({ kind: 'backup' }), 'backup'); }}
            >
              <Siren aria-hidden /> Backup
            </Button>
          ) : null}
          {capabilities?.canShareLocation ? (
            <Button
              variant="secondary" size="sm" className="flex-1"
              disabled={pending !== null}
              onClick={() => {
                void run('share', () => raiseFieldRequest({ kind: 'location_share' }));
              }}
            >
              <MapPin aria-hidden /> Share
            </Button>
          ) : null}
        </div>

        {/* Panic */}
        <div className="border-t border-border-subtle pt-2.5">
          {confirmPanic ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-text-secondary">
                This alerts every dispatcher on duty. Confirm?
              </p>
              <div className="flex gap-1.5">
                <Button
                  variant="danger" size="sm" className="flex-1"
                  disabled={pending !== null}
                  onClick={() => {
                    setConfirmPanic(false);
                    void run('panic', () => duty.triggerPanic(), 'panic');
                  }}
                >
                  Confirm panic
                </Button>
                <Button
                  variant="secondary" size="sm"
                  onClick={() => setConfirmPanic(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* Two-step, deliberately. An accidental panic pulls units off real
               calls; a two-step control costs one extra press in the moment and
               prevents a false alarm that costs a shift far more. */
            <Button
              variant="danger" size="sm" className="w-full"
              onClick={() => setConfirmPanic(true)}
              disabled={pending !== null || self.statusKey === 'panic'}
            >
              <TriangleAlert aria-hidden />
              {self.statusKey === 'panic' ? 'Panic active' : 'Panic'}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function UnitPicker({
  units, disabled, onJoin,
}: {
  units: DispatchUnit[];
  disabled: boolean;
  onJoin: (unitId: string) => void;
}) {
  const [selected, setSelected] = React.useState('');

  const options = units.map((u) => ({
    value: u.id,
    label: `${u.callsign}${u.crew.length > 0 ? ` · ${u.crew.length} crew` : ' · empty'}`,
  }));

  if (options.length === 0) {
    return <p className="text-xs text-text-tertiary">No units are available to join.</p>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={selected}
        onValueChange={setSelected}
        options={options}
        placeholder="Select a unit…"
        className="flex-1"
        // Distinguished from the incident detail's assign control, which reads
        // identically without a label of its own.
        aria-label="Join a unit"
      />
      <Button
        size="sm"
        disabled={disabled || selected === ''}
        onClick={() => { if (selected !== '') onJoin(selected); }}
      >
        Join
      </Button>
    </div>
  );
}
