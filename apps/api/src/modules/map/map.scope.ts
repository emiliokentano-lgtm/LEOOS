import { can, type ActorContext } from '@leoos/authz-core';

/**
 * What one caller is allowed to see on the map.
 *
 * THIS IS THE SECURITY BOUNDARY OF THE MAP SUBSYSTEM, and it is a sharper one
 * than most screens have. A live position feed is a surveillance capability: it
 * says where a named officer physically is, updating every second. The failure
 * mode is not "an operator sees a row they should not have" — it is a covert
 * federal unit being tracked in real time by the organization it is
 * investigating.
 *
 * So the rules from docs/architecture/05-map.md §5 are computed ONCE here and
 * applied in SQL, before serialisation:
 *
 *   visible(viewer, unit) =
 *        unit.organizationId ∈ viewer.organizations
 *     or viewer holds map.track_all_orgs
 *     or ( unit.organization shares on the public map
 *          and viewer holds map.track_units
 *          and the unit is not covert )
 *
 * A unit the caller may not see is ABSENT from the payload — not flagged, not
 * blanked, not filtered by the client. Anything a browser receives is readable
 * by whoever is sitting at it, whatever the UI chooses to draw.
 */

export interface MapScope {
  /** Without this the map screen itself is not reachable. */
  canViewMap: boolean;
  /** Live unit positions. Separate from viewing the map at all. */
  canTrackUnits: boolean;
  /** Sees every organization, including covert units. */
  canTrackAllOrganizations: boolean;
  canViewMarkers: boolean;
  canManageMarkers: boolean;
  /** Position playback — a higher-risk capability, separately audited. */
  canViewHistory: boolean;
  canViewIncidents: boolean;
  canCreateIncident: boolean;
  canAssignUnits: boolean;

  /**
   * Organizations whose units are visible unconditionally.
   *
   * Empty means the caller belongs to nothing — they may still see shared
   * non-covert units if they hold `map.track_units`, and nothing otherwise.
   */
  organizationIds: string[];

  actorUserId: string;
  actorOrganizationId: string | null;
}

export function resolveMapScope(actor: ActorContext, actorUserId: string): MapScope {
  const canTrackAllOrganizations = can(actor, 'map.track_all_orgs');

  /**
   * Reach is the ACTIVE organization, not every organization the user has ever
   * belonged to — the same rule global search uses. The active organization
   * header is already validated against the caller's memberships, and acting as
   * PD should not put MD's units on the screen.
   */
  const organizationIds = actor.organizationId === null ? [] : [actor.organizationId];

  return {
    canViewMap: can(actor, 'map.view'),
    canTrackUnits: can(actor, 'map.track_units'),
    canTrackAllOrganizations,
    canViewMarkers: can(actor, 'map.view'),
    canManageMarkers: can(actor, 'map.markers.manage'),
    canViewHistory: can(actor, 'map.history'),
    canViewIncidents: can(actor, 'dispatch.view'),
    canCreateIncident: can(actor, 'dispatch.create'),
    canAssignUnits: can(actor, 'dispatch.assign'),
    organizationIds,
    actorUserId,
    actorOrganizationId: actor.organizationId,
  };
}

/**
 * Whether the scope can see any unit at all.
 *
 * A caller with `map.view` but not `map.track_units` gets the map, the markers
 * and the incidents — and no unit positions. That combination is deliberate:
 * an administrator planning a road closure needs the map; they do not need to
 * know where every officer is standing.
 */
export function canSeeAnyUnit(scope: MapScope): boolean {
  if (scope.canTrackAllOrganizations) return true;
  if (scope.canTrackUnits) return true;
  // Without `map.track_units`, own-organization units are still visible to a
  // member: the rule's first clause has no permission attached to it, because
  // knowing where your own patrol is is the baseline the map exists to provide.
  return scope.organizationIds.length > 0;
}
