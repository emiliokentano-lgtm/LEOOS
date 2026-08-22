'use client';

import * as React from 'react';
import Link from 'next/link';
import { Crosshair, ExternalLink, PanelRightClose, Trash2, TriangleAlert } from 'lucide-react';
import {
  FRESHNESS_META, MAP_MARKER_TYPES, UNIT_TYPES, formatWorldPosition, freshnessOf,
  headingToCompass,
  type MapIncidentMarker, type MapMarker, type MapUnit,
} from '@leoos/contracts';
import {
  Badge, Button, IconButton, OrgTag, Panel, PanelHeader, PriorityBadge, useToast,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { removeMapMarker } from '@/lib/map-actions';
import { useNow } from '@/lib/map/use-now';
import type { MapUnitStore } from '@/lib/map/unit-store';
import { useUnitPosition } from '@/lib/map/use-unit-store';
import { cn, timeAgo } from '@/lib/utils';

/**
 * Selection detail panels.
 *
 * One file, because all three are the same shape — a titled panel over a
 * definition list — and splitting them would put three near-identical `Row`
 * helpers in three files. They stay small; if any one grows a form it moves out.
 *
 * Actions are gated on the capabilities the API reported. That is a UX decision
 * only: every one of them is re-authorized server-side when invoked
 * (engineering rule 9).
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}

export function UnitDetail({
  unit, following, store, onDispatchBoard, onToggleFollow, onClose,
}: {
  unit: MapUnit;
  following: boolean;
  /**
   * Read for THIS unit's live position only.
   *
   * The detail panel is the one place on the screen showing coordinates, a
   * heading and a speed that have to be current, so it is the one place worth a
   * render per second. The list beside it deliberately subscribes to nothing of
   * the kind — see lib/map/unit-store.ts.
   */
  store: MapUnitStore;
  /**
   * Whether this unit can actually appear on the caller's dispatch board.
   *
   * Cosmetic, not a permission check — the board re-derives what it shows from
   * the caller's own scope server-side. What it decides here is whether
   * offering "View unit" would be honest.
   */
  onDispatchBoard: boolean;
  onToggleFollow: () => void;
  onClose: () => void;
}) {
  const type = UNIT_TYPES[unit.unitType as keyof typeof UNIT_TYPES];
  // Ticks, so "last update" keeps counting up when the feed goes quiet.
  const now = useNow();
  const location = useUnitPosition(store, unit.id) ?? unit.location;
  const freshness = freshnessOf(location, now);

  return (
    <Panel flush>
      <PanelHeader
        title={<span className="font-mono">{unit.callsign}</span>}
        icon={<Icon name={type?.icon ?? 'Car'} />}
        actions={
          <IconButton label="Close" size="xs" onClick={onClose}>
            <PanelRightClose aria-hidden />
          </IconButton>
        }
      />

      {freshness !== 'live' ? (
        <p
          className={cn(
            'border-b border-border-subtle bg-raised px-3 py-1.5 text-2xs',
            freshness === 'offline' ? 'text-danger' : 'text-warning',
          )}
        >
          {FRESHNESS_META[freshness].description}
        </p>
      ) : null}

      <dl className="flex flex-col gap-2 p-3 text-xs">
        <Row label="Organization">
          <OrgTag shortName={unit.organization.shortName} color={unit.organization.color} />
        </Row>
        <Row label="Status">
          <span
            className="rounded-xs border px-1 text-[10px]"
            style={{
              borderColor: `var(${unit.status.colorToken})`,
              color: `var(${unit.status.colorToken})`,
            }}
          >
            {unit.status.label}
          </span>
        </Row>
        <Row label="Type">{type?.label ?? unit.unitType}</Row>
        {unit.name ? <Row label="Name">{unit.name}</Row> : null}

        <Row label="Crew">
          {unit.crew.length === 0 ? (
            <span className="text-text-tertiary">Uncrewed</span>
          ) : (
            <span className="flex flex-col items-end gap-0.5">
              {unit.crew.map((member) => (
                <span key={member.memberId} className="flex items-center gap-1.5">
                  {member.callsign ? (
                    <span className="font-mono text-2xs text-text-tertiary">{member.callsign}</span>
                  ) : null}
                  <span>{member.name}</span>
                  {member.isLeader ? (
                    <Badge variant="neutral" className="text-[9px]">lead</Badge>
                  ) : null}
                </span>
              ))}
            </span>
          )}
        </Row>

        {unit.vehicle ? (
          <>
            <Row label="Vehicle">{unit.vehicle.displayName ?? unit.vehicle.model}</Row>
            <Row label="Plate"><span className="font-mono">{unit.vehicle.plate}</span></Row>
            {unit.vehicle.vehicleClass ? (
              <Row label="Class">{unit.vehicle.vehicleClass}</Row>
            ) : null}
          </>
        ) : (
          <Row label="Vehicle"><span className="text-text-tertiary">None assigned</span></Row>
        )}

        {location ? (
          <>
            <Row label="Position">
              <span className="font-mono">{formatWorldPosition(location)}</span>
            </Row>
            <Row label="Heading">
              <span className="font-mono">
                {location.heading === null
                  ? '—'
                  : `${location.heading.toFixed(0)}° ${headingToCompass(location.heading)}`}
              </span>
            </Row>
            {location.speed !== null ? (
              <Row label="Speed">
                <span className="font-mono">{Math.round(location.speed * 3.6)} km/h</span>
              </Row>
            ) : null}
            <Row label="Tracking">
              <span
                className={cn(
                  'font-mono',
                  freshness === 'stale' && 'text-warning',
                  freshness === 'offline' && 'text-danger',
                )}
              >
                {FRESHNESS_META[freshness].label}
              </span>
            </Row>
            <Row label="Last update">
              <span className={cn('font-mono', freshness !== 'live' && 'text-warning')}>
                {now === 0 ? '—' : timeAgo(new Date(location.updatedAt), new Date(now))}
              </span>
            </Row>
          </>
        ) : null}

        {unit.incident ? (
          <Row label="Assignment">
            <span className="flex items-center gap-1.5">
              <PriorityBadge priority={unit.incident.priority} />
              <span className="font-mono">{unit.incident.number}</span>
            </span>
          </Row>
        ) : null}

        {unit.isCovert ? (
          <Row label="Visibility">
            <span className="text-text-tertiary">
              Covert — not shown to other organizations
            </span>
          </Row>
        ) : null}
      </dl>

      <div className="flex gap-1.5 border-t border-border-subtle p-2">
        <Button
          variant={following ? 'primary' : 'secondary'}
          size="sm"
          className="flex-1"
          onClick={onToggleFollow}
          disabled={location === null}
        >
          <Crosshair aria-hidden /> {following ? 'Following' : 'Follow'}
        </Button>

        {/*
          * The route into dispatch, replacing a disabled "Assign" button that
          * said assignment "lands with the dispatch module".
          *
          * Dispatch has since shipped, so that button had become a lie about
          * what the product can do — the exact failure engineering rule 45
          * exists to prevent. Assignment belongs to the board, where the call
          * queue and the rest of the fleet are visible, so this hands the
          * operator over to it with the unit already selected rather than
          * duplicating the board's controls into a map popover.
          */}
        {onDispatchBoard ? (
          <Button asChild variant="secondary" size="sm" className="flex-1">
            <Link href={`/dispatch?unit=${encodeURIComponent(unit.id)}`}>
              <ExternalLink aria-hidden /> View unit
            </Link>
          </Button>
        ) : (
          /*
           * Another agency's unit.
           *
           * The map deliberately shows units from organizations that share on
           * it; the dispatch board deliberately does not — it is your own fleet
           * and your own queue. Offering the action anyway would hand the
           * operator a link to a board the unit is not on, so the reason is
           * stated instead of a dead end being presented as a control.
           */
          <p className="flex-1 text-2xs text-text-tertiary">
            {unit.organization.shortName} unit — the dispatch board shows your own
            organization.
          </p>
        )}
      </div>
    </Panel>
  );
}

export function IncidentDetail({
  incident, onClose,
}: {
  incident: MapIncidentMarker;
  onClose: () => void;
}) {
  const now = useNow();
  return (
    <Panel flush>
      <PanelHeader
        title={<span className="font-mono">{incident.number}</span>}
        icon={<TriangleAlert />}
        actions={
          <IconButton label="Close" size="xs" onClick={onClose}>
            <PanelRightClose aria-hidden />
          </IconButton>
        }
      />
      <dl className="flex flex-col gap-2 p-3 text-xs">
        <Row label="Priority"><PriorityBadge priority={incident.priority} /></Row>
        <Row label="Type">{incident.typeLabel ?? incident.typeKey ?? '—'}</Row>
        <Row label="Status">{incident.status.replace('_', ' ')}</Row>
        <Row label="Organization">
          {incident.organization ? (
            <OrgTag
              shortName={incident.organization.shortName}
              color={incident.organization.color}
            />
          ) : (
            <span className="text-text-tertiary">Multi-agency</span>
          )}
        </Row>
        {incident.locationText ? (
          <Row label="Location"><span className="text-right">{incident.locationText}</span></Row>
        ) : null}
        <Row label="Position">
          <span className="font-mono">{formatWorldPosition(incident)}</span>
        </Row>
        <Row label="Units assigned">{incident.assignedUnitCount || 'None'}</Row>
        <Row label="Opened">
          <span className="font-mono">
            {now === 0 ? '—' : timeAgo(new Date(incident.openedAt), new Date(now))}
          </span>
        </Row>
      </dl>
      <p className="border-t border-border-subtle px-3 py-2 text-xs text-text-secondary">
        {incident.title}
      </p>
    </Panel>
  );
}

export function MarkerDetail({
  marker, canManage, onClose,
}: {
  marker: MapMarker;
  canManage: boolean;
  onClose: () => void;
}) {
  const [removing, setRemoving] = React.useState(false);
  const toast = useToast();
  const now = useNow();
  const meta = MAP_MARKER_TYPES[marker.type];

  async function remove() {
    setRemoving(true);
    const result = await removeMapMarker(marker.id);
    setRemoving(false);

    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Could not remove the marker', description: result.error });
      return;
    }
    toast.push({ tone: 'success', title: 'Marker removed' });
    onClose();
  }

  return (
    <Panel flush>
      <PanelHeader
        title={marker.label}
        icon={<Icon name={meta?.icon ?? 'MapPin'} />}
        actions={
          <IconButton label="Close" size="xs" onClick={onClose}>
            <PanelRightClose aria-hidden />
          </IconButton>
        }
      />
      <dl className="flex flex-col gap-2 p-3 text-xs">
        <Row label="Type">{meta?.label ?? marker.type}</Row>
        <Row label="Scope">
          {marker.organization ? (
            <OrgTag
              shortName={marker.organization.shortName}
              color={marker.organization.color}
            />
          ) : (
            <span className="text-text-tertiary">All organizations</span>
          )}
        </Row>
        <Row label="Position">
          <span className="font-mono">{formatWorldPosition(marker)}</span>
        </Row>
        {marker.createdByName ? <Row label="Placed by">{marker.createdByName}</Row> : null}
        <Row label="Placed">
          <span className="font-mono">
            {now === 0 ? '—' : timeAgo(new Date(marker.createdAt), new Date(now))}
          </span>
        </Row>
        {marker.expiresAt ? (
          <Row label="Expires">
            <span className="font-mono">{new Date(marker.expiresAt).toLocaleString()}</span>
          </Row>
        ) : null}
      </dl>

      {marker.description ? (
        <p className="border-t border-border-subtle px-3 py-2 text-xs text-text-secondary">
          {marker.description}
        </p>
      ) : null}

      {canManage ? (
        <div className="border-t border-border-subtle p-2">
          <Button
            variant="danger"
            size="sm"
            className="w-full"
            onClick={() => { void remove(); }}
            disabled={removing}
          >
            <Trash2 aria-hidden /> {removing ? 'Removing…' : 'Remove marker'}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
