'use client';

import * as React from 'react';
import { Crosshair, PanelRightClose, Trash2, TriangleAlert } from 'lucide-react';
import {
  MAP_MARKER_TYPES, UNIT_TYPES, formatWorldPosition, freshnessOf, headingToCompass,
  type MapIncidentMarker, type MapMarker, type MapUnit,
} from '@leoos/contracts';
import {
  Badge, Button, IconButton, Panel, PanelHeader, PriorityBadge, Tooltip, useToast,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { removeMapMarker } from '@/lib/map-actions';
import { useNow } from '@/lib/map/use-now';
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

function OrgTag({ shortName, color }: { shortName: string; color: string }) {
  return (
    <span
      className="rounded-[2px] border px-1 text-[10px] font-medium"
      style={{ borderColor: color, color }}
    >
      {shortName}
    </span>
  );
}

export function UnitDetail({
  unit, following, canAssign, onToggleFollow, onClose,
}: {
  unit: MapUnit;
  following: boolean;
  canAssign: boolean;
  onToggleFollow: () => void;
  onClose: () => void;
}) {
  const type = UNIT_TYPES[unit.unitType as keyof typeof UNIT_TYPES];
  // Ticks, so "last update" keeps counting up when the feed goes quiet.
  const now = useNow();
  const freshness = freshnessOf(unit.location, now);

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
        <p className="border-b border-border-subtle bg-raised px-3 py-1.5 text-2xs text-warning">
          {freshness === 'unknown'
            ? 'This unit has never reported a position.'
            : 'Position is stale — this is where the unit was last seen, not where it is.'}
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

        {unit.location ? (
          <>
            <Row label="Position">
              <span className="font-mono">{formatWorldPosition(unit.location)}</span>
            </Row>
            <Row label="Heading">
              <span className="font-mono">
                {unit.location.heading === null
                  ? '—'
                  : `${unit.location.heading.toFixed(0)}° ${headingToCompass(unit.location.heading)}`}
              </span>
            </Row>
            {unit.location.speed !== null ? (
              <Row label="Speed">
                <span className="font-mono">{Math.round(unit.location.speed * 3.6)} km/h</span>
              </Row>
            ) : null}
            <Row label="Last update">
              <span className={cn('font-mono', freshness === 'stale' && 'text-warning')}>
                {now === 0 ? '—' : timeAgo(new Date(unit.location.updatedAt), new Date(now))}
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
          disabled={unit.location === null}
        >
          <Crosshair aria-hidden /> {following ? 'Following' : 'Follow'}
        </Button>
        <Tooltip
          content={canAssign
            ? 'Assignment lands with the dispatch module'
            : 'You do not hold dispatch.assign'}
        >
          {/* Disabled either way today: the dispatch module is a later phase, and
              claiming otherwise would be the map lying about what it can do. */}
          <Button variant="secondary" size="sm" className="flex-1" disabled>Assign</Button>
        </Tooltip>
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
