import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAP_FILTER, countActiveMapFilters, freshnessOf, matchesIncidentFilter,
  matchesMarkerFilter, matchesUnitFilter,
  type MapFilterState, type MapIncidentMarker, type MapMarker, type MapUnit,
} from '../src/map';

const ORG_PD = { id: 'org-pd', key: 'pd', shortName: 'PD', color: '#3b82f6' };
const ORG_MD = { id: 'org-md', key: 'md', shortName: 'MD', color: '#ef4444' };

function unit(over: Partial<MapUnit> = {}): MapUnit {
  return {
    id: 'u1',
    callsign: '2-ADAM-12',
    name: null,
    unitType: 'patrol',
    organization: ORG_PD,
    status: {
      key: 'available', label: 'Available', shortLabel: 'AVL',
      colorToken: '--status-available', icon: 'CircleCheck',
      isAvailable: true, isOnDuty: true,
    },
    crew: [{ memberId: 'm1', name: 'J. Smith', callsign: '12', isLeader: true }],
    vehicle: { id: 'v1', plate: 'PD-100', model: 'police', displayName: 'Cruiser', vehicleClass: 'sedan' },
    incident: null,
    location: { unitId: 'u1', organizationId: ORG_PD.id, x: 0, y: 0, z: null, heading: 90, speed: 12, updatedAt: '2026-08-19T10:00:00.000Z' },
    isCovert: false,
    ...over,
  };
}

function filter(over: Partial<MapFilterState> = {}): MapFilterState {
  return { ...EMPTY_MAP_FILTER, ...over };
}

describe('unit filtering', () => {
  it('passes everything through an empty filter', () => {
    expect(matchesUnitFilter(unit(), EMPTY_MAP_FILTER)).toBe(true);
  });

  it('hides off-duty units unless asked for', () => {
    const offDuty = unit({
      status: { ...unit().status, key: 'off_duty', isOnDuty: false, isAvailable: false },
    });
    expect(matchesUnitFilter(offDuty, EMPTY_MAP_FILTER)).toBe(false);
    expect(matchesUnitFilter(offDuty, filter({ includeOffDuty: true }))).toBe(true);
  });

  it('filters by organization', () => {
    expect(matchesUnitFilter(unit(), filter({ organizationIds: [ORG_MD.id] }))).toBe(false);
    expect(matchesUnitFilter(unit(), filter({ organizationIds: [ORG_PD.id] }))).toBe(true);
  });

  it('filters by status, unit type and vehicle class', () => {
    expect(matchesUnitFilter(unit(), filter({ statusKeys: ['busy'] }))).toBe(false);
    expect(matchesUnitFilter(unit(), filter({ unitTypes: ['air'] }))).toBe(false);
    expect(matchesUnitFilter(unit(), filter({ vehicleClasses: ['helicopter'] }))).toBe(false);
    expect(matchesUnitFilter(unit(), filter({ vehicleClasses: ['sedan'] }))).toBe(true);
  });

  it('excludes a unit with no vehicle when a vehicle class is selected', () => {
    expect(matchesUnitFilter(unit({ vehicle: null }), filter({ vehicleClasses: ['sedan'] })))
      .toBe(false);
  });

  it('filters to assigned units', () => {
    expect(matchesUnitFilter(unit(), filter({ onlyAssigned: true }))).toBe(false);
    const assigned = unit({
      incident: { id: 'i1', number: 'INC-1024', title: 'Burglary', priority: 2, status: 'dispatched' },
    });
    expect(matchesUnitFilter(assigned, filter({ onlyAssigned: true }))).toBe(true);
  });

  it('searches callsign, crew name and plate', () => {
    expect(matchesUnitFilter(unit(), filter({ query: 'adam' }))).toBe(true);
    expect(matchesUnitFilter(unit(), filter({ query: 'smith' }))).toBe(true);
    expect(matchesUnitFilter(unit(), filter({ query: 'pd-100' }))).toBe(true);
    expect(matchesUnitFilter(unit(), filter({ query: 'nothing' }))).toBe(false);
  });

  it('ignores a whitespace-only query', () => {
    expect(matchesUnitFilter(unit(), filter({ query: '   ' }))).toBe(true);
  });

  it('honours the layer toggle', () => {
    expect(matchesUnitFilter(unit(), filter({ showUnits: false }))).toBe(false);
  });
});

describe('incident filtering', () => {
  function incident(over: Partial<MapIncidentMarker> = {}): MapIncidentMarker {
    return {
      id: 'i1', number: 'INC-1024', title: 'Burglary in progress',
      typeKey: 'burglary', typeLabel: 'Burglary', priority: 2, status: 'dispatched',
      organization: ORG_PD, locationText: 'Legion Square', x: 100, y: 200,
      assignedUnitCount: 2, openedAt: '2026-08-19T09:00:00.000Z', ...over,
    };
  }

  it('filters by priority', () => {
    expect(matchesIncidentFilter(incident(), filter({ incidentPriorities: [1] }))).toBe(false);
    expect(matchesIncidentFilter(incident(), filter({ incidentPriorities: [2] }))).toBe(true);
  });

  it('keeps a multi-agency call visible under any organization filter', () => {
    // A call with no owning organization is precisely the one everybody needs to
    // see; dropping it whenever a filter chip is on would be the worst possible
    // failure mode for this filter.
    const multiAgency = incident({ organization: null });
    expect(matchesIncidentFilter(multiAgency, filter({ organizationIds: [ORG_MD.id] }))).toBe(true);
  });

  it('hides another organization owned call when filtered', () => {
    expect(matchesIncidentFilter(incident(), filter({ organizationIds: [ORG_MD.id] }))).toBe(false);
  });

  it('searches number, title and location', () => {
    expect(matchesIncidentFilter(incident(), filter({ query: 'inc-1024' }))).toBe(true);
    expect(matchesIncidentFilter(incident(), filter({ query: 'legion' }))).toBe(true);
    expect(matchesIncidentFilter(incident(), filter({ query: 'arson' }))).toBe(false);
  });
});

describe('marker filtering', () => {
  const marker: MapMarker = {
    id: 'mk1', type: 'roadblock', label: 'Route 68 closure', description: null,
    x: 0, y: 0, z: null, color: null, organization: ORG_PD,
    createdByName: 'Sgt Doe', createdAt: '2026-08-19T09:00:00.000Z', expiresAt: null,
  };

  it('keeps a global marker under any organization filter', () => {
    expect(matchesMarkerFilter({ ...marker, organization: null },
      filter({ organizationIds: [ORG_MD.id] }))).toBe(true);
  });

  it('honours the layer toggle and the query', () => {
    expect(matchesMarkerFilter(marker, filter({ showMarkers: false }))).toBe(false);
    expect(matchesMarkerFilter(marker, filter({ query: 'route 68' }))).toBe(true);
  });
});

describe('active filter count', () => {
  it('counts nothing for the default filter', () => {
    expect(countActiveMapFilters(EMPTY_MAP_FILTER)).toBe(0);
  });

  it('counts a hidden layer as an active filter', () => {
    // Otherwise "clear all" leaves a layer switched off with nothing indicating
    // why the map is empty.
    expect(countActiveMapFilters(filter({ showIncidents: false }))).toBe(1);
  });

  it('sums selections across categories', () => {
    expect(countActiveMapFilters(filter({
      organizationIds: [ORG_PD.id, ORG_MD.id],
      statusKeys: ['available'],
      onlyAssigned: true,
    }))).toBe(4);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-08-19T10:00:00.000Z');

  it('reports a recent sample as live', () => {
    expect(freshnessOf(unit().location, now + 2_000)).toBe('live');
  });

  it('reports an old sample as stale', () => {
    expect(freshnessOf(unit().location, now + 60_000)).toBe('stale');
  });

  it('reports a unit that has never reported as unknown', () => {
    expect(freshnessOf(null, now)).toBe('unknown');
  });

  it('treats an unparseable timestamp as stale rather than live', () => {
    // Failing open here would draw a confident marker on garbage.
    const broken = { ...unit().location!, updatedAt: 'not a date' };
    expect(freshnessOf(broken, now)).toBe('stale');
  });
});
