import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin,
  organizationIdByKey, resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';
import { assertMockSourceAllowed } from '../src/modules/map/sources/position-source.js';
import { InMemoryPositionStore } from '../src/modules/map/sources/live-positions.js';

/**
 * Map subsystem authorization.
 *
 * A live position feed is a surveillance capability. It reports where a named
 * officer physically is, once a second, and the failure that matters is not "an
 * operator saw a row they should not have" — it is a covert federal unit being
 * tracked in real time by the organization it is investigating.
 *
 * So this file asks one question repeatedly, in the form that actually matters:
 * IS THE UNIT ABSENT FROM THE PAYLOAD? Not hidden by a flag, not filtered by the
 * client — absent. Anything a browser receives is readable by whoever is sitting
 * at it, whatever the UI chooses to draw, so several tests assert against the
 * serialised body rather than against a parsed field.
 *
 * The visibility rule under test (docs/architecture/05-map.md §5):
 *
 *   visible(viewer, unit) =
 *        unit.organizationId ∈ viewer.organizations
 *     or viewer holds map.track_all_orgs
 *     or ( unit.organization shares on the public map
 *          and viewer holds map.track_units
 *          and the unit is not covert )
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}${Date.now().toString(36).slice(-4)}`;
}

interface Person {
  username: string;
  userId: string;
  memberId: string;
  organizationId: string;
  headers: Record<string, string>;
}

async function member(prefix: string, orgKey: string, roleKey: string): Promise<Person> {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  const m = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const auth = await signIn(h, creds);
  return {
    username: creds.username,
    userId: await userIdByUsername(h.db, creds.username),
    memberId: m.memberId,
    organizationId: m.organizationId,
    headers: auth.headers,
  };
}

interface MapUnitBody {
  id: string;
  callsign: string;
  organization: { id: string; key: string };
  isCovert: boolean;
  location: { x: number; y: number; heading: number | null; updatedAt: string } | null;
  crew: { name: string }[];
  vehicle: { plate: string } | null;
  incident: { id: string; number: string } | null;
}

interface SnapshotBody {
  serverTime: string;
  units: MapUnitBody[];
  incidents: { id: string; number: string; x: number; y: number }[];
  markers: { id: string; label: string; organization: { key: string } | null }[];
  organizations: { id: string; key: string }[];
  capabilities: Record<string, boolean>;
  source: { kind: string; connected: boolean; placeholderBaseLayer: boolean };
}

async function snapshot(who: Person): Promise<{ status: number; body: SnapshotBody; raw: string }> {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/map/snapshot', headers: who.headers,
  });
  return { status: res.statusCode, body: res.json() as SnapshotBody, raw: res.body };
}

/**
 * Creates a unit directly in the database.
 *
 * Deliberately not through an API: there is no unit-creation endpoint yet
 * (dispatch is a later phase), and more importantly a visibility test should not
 * depend on a creation endpoint's own authorization being correct. The rows are
 * what the map reads, so the rows are what the tests write.
 */
async function makeUnit(opts: {
  orgKey: string;
  covert?: boolean;
  statusKey?: string;
  withPosition?: boolean;
}): Promise<{ id: string; callsign: string }> {
  const callsign = unique('MAPU').toUpperCase();
  const orgId = await organizationIdByKey(h.db, opts.orgKey);

  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO unit (organization_id, callsign, unit_type, status_key, is_covert,
                      pos_x, pos_y, heading, speed, position_updated_at)
    VALUES (${orgId}, ${callsign}, 'patrol', ${opts.statusKey ?? 'available'},
            ${opts.covert ?? false},
            ${opts.withPosition === false ? null : 120.5},
            ${opts.withPosition === false ? null : -430.25},
            ${opts.withPosition === false ? null : 90},
            ${opts.withPosition === false ? null : 12},
            ${opts.withPosition === false ? null : new Date().toISOString()})
    RETURNING id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error('unit insert failed');
  return { id, callsign };
}

async function setSharing(orgKey: string, share: boolean): Promise<void> {
  await h.db.execute(sql`
    UPDATE organization
       SET settings = settings || ${JSON.stringify({ shareOnPublicMap: share })}::jsonb
     WHERE key = ${orgKey}
  `);
}

/** The whole serialised payload, for "is it absent" assertions. */
function payloadOf(result: { raw: string }): string {
  return result.raw;
}

// ── Reaching the map at all ────────────────────────────────────────────────

describe('map access', () => {
  it('serves a snapshot to a member who can view the map', async () => {
    const officer = await member('mapofficer', 'PD', 'officer');
    const result = await snapshot(officer);

    expect(result.status).toBe(200);
    expect(result.body.capabilities.canViewMap).toBe(true);
    expect(Array.isArray(result.body.units)).toBe(true);
  });

  it('returns 404, not 403, when the caller cannot view the map', async () => {
    // 404 everywhere else in this codebase, and for the same reason: a caller
    // who may not use the map should not learn what is on it, including whether
    // it exists.
    const officer = await member('mapdenied', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'map.view', 'deny');

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/map/snapshot', headers: officer.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/map/snapshot' });
    expect(res.statusCode).toBe(401);
  });

  it('reports the position source honestly', async () => {
    // Engineering rules 34, 35, 45. The UI renders this verbatim, so a source
    // that claimed to be connected would put a green light on a simulated map.
    const officer = await member('mapsource', 'PD', 'officer');
    const result = await snapshot(officer);

    expect(result.body.source.kind).toBe('mock');
    expect(result.body.source.connected).toBe(false);
    expect(result.body.source.placeholderBaseLayer).toBe(true);
  });
});

// ── The visibility rule ────────────────────────────────────────────────────

describe('unit visibility', () => {
  it('shows a member their own organization units', async () => {
    const officer = await member('mapown', 'PD', 'officer');
    const own = await makeUnit({ orgKey: 'PD' });

    const result = await snapshot(officer);
    expect(result.body.units.map((u) => u.id)).toContain(own.id);
  });

  it('shows a covert unit to its OWN organization', async () => {
    // A dispatcher who cannot see their own covert units cannot dispatch them.
    // The first clause of the rule carries no covert exclusion, deliberately.
    const agent = await member('mapcovertown', 'FIB', 'agent');
    const covert = await makeUnit({ orgKey: 'FIB', covert: true });

    const result = await snapshot(agent);
    const found = result.body.units.find((u) => u.id === covert.id);
    expect(found).toBeDefined();
    expect(found?.isCovert).toBe(true);
  });

  it('hides another organization units when that organization does not share', async () => {
    await setSharing('FIB', false);
    const foreign = await makeUnit({ orgKey: 'FIB' });
    const officer = await member('mapnoshare', 'PD', 'officer');

    const result = await snapshot(officer);
    expect(result.body.units.map((u) => u.id)).not.toContain(foreign.id);
    expect(payloadOf(result)).not.toContain(foreign.callsign);
  });

  it('shows a shared, non-covert unit from another organization', async () => {
    await setSharing('MD', true);
    const shared = await makeUnit({ orgKey: 'MD' });
    const officer = await member('mapshared', 'PD', 'officer');

    const result = await snapshot(officer);
    expect(result.body.units.map((u) => u.id)).toContain(shared.id);
  });

  /**
   * THE CENTRAL TEST OF THIS FILE.
   *
   * A covert unit belonging to a SHARING organization must still be invisible.
   * Sharing a fleet on the public map is a statement about ordinary patrols; it
   * is not consent to have an undercover car tracked by every officer in the
   * city.
   */
  it('hides a covert unit even when its organization shares on the public map', async () => {
    await setSharing('FIB', true);
    const covert = await makeUnit({ orgKey: 'FIB', covert: true });
    const marked = await makeUnit({ orgKey: 'FIB', covert: false });
    const officer = await member('mapcovert', 'PD', 'officer');

    const result = await snapshot(officer);
    const ids = result.body.units.map((u) => u.id);

    expect(ids).toContain(marked.id);      // the sharing clause works…
    expect(ids).not.toContain(covert.id);  // …and does not extend to covert units
    expect(payloadOf(result)).not.toContain(covert.callsign);
  });

  it('shows every organization to a holder of map.track_all_orgs', async () => {
    await setSharing('FIB', false);
    const covert = await makeUnit({ orgKey: 'FIB', covert: true });
    const commander = await member('maptrackall', 'PD', 'commander');

    const result = await snapshot(commander);
    expect(result.body.capabilities.canTrackAllOrganizations).toBe(true);
    expect(result.body.units.map((u) => u.id)).toContain(covert.id);
  });

  it('gives a caller with map.view but not map.track_units no foreign units', async () => {
    // Viewing the map and tracking people are separate capabilities: planning a
    // road closure needs the map; it does not need everyone's position.
    await setSharing('MD', true);
    const shared = await makeUnit({ orgKey: 'MD' });
    const officer = await member('mapnotrack', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'map.track_units', 'deny');

    const result = await snapshot(officer);
    expect(result.status).toBe(200);
    expect(result.body.capabilities.canViewMap).toBe(true);
    expect(result.body.capabilities.canTrackUnits).toBe(false);
    expect(result.body.units.map((u) => u.id)).not.toContain(shared.id);
  });

  it('still shows own-organization units without map.track_units', async () => {
    const officer = await member('mapowntrack', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'map.track_units', 'deny');
    const own = await makeUnit({ orgKey: 'PD' });

    const result = await snapshot(officer);
    expect(result.body.units.map((u) => u.id)).toContain(own.id);
  });

  it('excludes disbanded units', async () => {
    const officer = await member('mapdisband', 'PD', 'officer');
    const gone = await makeUnit({ orgKey: 'PD' });
    await h.db.execute(sql`
      UPDATE unit SET status = 'disbanded', disbanded_at = now() WHERE id = ${gone.id}
    `);

    const result = await snapshot(officer);
    expect(result.body.units.map((u) => u.id)).not.toContain(gone.id);
  });

  it('includes a unit that has never reported a position, with a null location', async () => {
    // Absent from the map but present in the list: an operator needs to see that
    // the unit exists and is not being tracked, which is different from it not
    // existing at all.
    const officer = await member('mapnofix', 'PD', 'officer');
    const unpositioned = await makeUnit({ orgKey: 'PD', withPosition: false });

    const result = await snapshot(officer);
    const found = result.body.units.find((u) => u.id === unpositioned.id);
    expect(found).toBeDefined();
    expect(found?.location).toBeNull();
  });
});

// ── The tick ───────────────────────────────────────────────────────────────

describe('position tick', () => {
  async function tick(who: Person, knownUnitIds: string[] = []) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/map/tick',
      headers: who.headers, payload: { knownUnitIds },
    });
    return {
      status: res.statusCode,
      body: res.json() as {
        positions: { unitId: string; x: number; y: number }[];
        removed: string[];
        resyncRequired: boolean;
      },
      raw: res.body,
    };
  }

  it('returns positions for visible units', async () => {
    const officer = await member('maptick', 'PD', 'officer');
    const own = await makeUnit({ orgKey: 'PD' });

    const result = await tick(officer, [own.id]);
    expect(result.status).toBe(200);
    expect(result.body.positions.map((p) => p.unitId)).toContain(own.id);
  });

  /**
   * The tick re-derives visibility rather than trusting the client's list.
   *
   * This is what makes a permission change take effect immediately, with no
   * revocation machinery: a client that has been open across a change simply
   * stops being sent the unit on its next tick.
   */
  it('never returns a unit the caller may not see, even when the client claims it', async () => {
    await setSharing('FIB', false);
    const covert = await makeUnit({ orgKey: 'FIB', covert: true });
    const officer = await member('maptickleak', 'PD', 'officer');

    const result = await tick(officer, [covert.id]);
    expect(result.body.positions.map((p) => p.unitId)).not.toContain(covert.id);
    expect(result.raw).not.toContain(covert.callsign);
  });

  it('reports a claimed-but-invisible unit as removed', async () => {
    await setSharing('FIB', false);
    const covert = await makeUnit({ orgKey: 'FIB', covert: true });
    const officer = await member('maptickremove', 'PD', 'officer');

    const result = await tick(officer, [covert.id]);
    expect(result.body.removed).toContain(covert.id);
  });

  it('asks for a resync when a unit appears the client has no metadata for', async () => {
    const officer = await member('maptickresync', 'PD', 'officer');
    const known = await makeUnit({ orgKey: 'PD' });
    const surprise = await makeUnit({ orgKey: 'PD' });

    const result = await tick(officer, [known.id]);
    expect(result.body.positions.map((p) => p.unitId)).toContain(surprise.id);
    expect(result.body.resyncRequired).toBe(true);
  });

  it('rejects an oversized known-unit list rather than scanning it', async () => {
    const officer = await member('mapticklarge', 'PD', 'officer');
    const ids = Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000');

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/map/tick',
      headers: officer.headers, payload: { knownUnitIds: ids },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Markers ────────────────────────────────────────────────────────────────

describe('map markers', () => {
  async function placeMarker(who: Person, body: Record<string, unknown>) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/map/markers', headers: who.headers, payload: body,
    });
    return { status: res.statusCode, body: res.json() as { id?: string; error?: unknown } };
  }

  it('places a marker for the actor organization', async () => {
    const sergeant = await member('mapmarker', 'PD', 'sergeant');
    const result = await placeMarker(sergeant, {
      type: 'roadblock', label: unique('Closure'), x: 100, y: 200,
    });

    expect(result.status).toBe(201);
    expect(result.body.id).toBeDefined();
  });

  it('refuses a caller without map.markers.manage', async () => {
    const officer = await member('mapmarkerdenied', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'map.markers.manage', 'deny');

    const result = await placeMarker(officer, {
      type: 'hazard', label: unique('Hazard'), x: 0, y: 0,
    });
    expect(result.status).toBe(403);
  });

  /**
   * Organization scope is derived from the ACTOR, never taken from the body.
   *
   * Same shape of bug as every cross-organization write this system defends
   * against (engineering rule 11): cosmetic on a marker, catastrophic on a role
   * assignment, and there is no reason to enforce it differently here.
   */
  it('refuses a marker pinned to another organization', async () => {
    const sergeant = await member('mapmarkercross', 'PD', 'sergeant');
    const otherOrg = await organizationIdByKey(h.db, 'MD');

    const result = await placeMarker(sergeant, {
      type: 'staging', label: unique('Staging'), x: 0, y: 0, organizationId: otherOrg,
    });
    expect(result.status).toBe(403);
  });

  it('scopes a requested global marker down to the actor organization', async () => {
    const sergeant = await member('mapmarkerglobal', 'PD', 'sergeant');

    // A null organization means "everyone sees this", which is the same reach as
    // track_all_orgs and gated by it. It is SCOPED DOWN rather than refused,
    // because a null is indistinguishable from an omitted field, and the
    // ordinary case — placing a marker without naming an organization at all —
    // must land on the actor's own map rather than erroring.
    const result = await placeMarker(sergeant, {
      type: 'hazard', label: unique('Global'), x: 0, y: 0, organizationId: null,
    });
    expect(result.status).toBe(201);

    const rows = await h.db.execute<{ organization_id: string | null }>(sql`
      SELECT organization_id FROM map_marker WHERE id = ${result.body.id}
    `);
    expect(rows[0]?.organization_id).toBe(sergeant.organizationId);
  });

  it('scopes a marker to the actor organization when none is named', async () => {
    const sergeant = await member('mapmarkerdefault', 'PD', 'sergeant');
    const result = await placeMarker(sergeant, {
      type: 'poi', label: unique('Default'), x: 0, y: 0,
    });
    expect(result.status).toBe(201);

    const rows = await h.db.execute<{ organization_id: string | null }>(sql`
      SELECT organization_id FROM map_marker WHERE id = ${result.body.id}
    `);
    expect(rows[0]?.organization_id).toBe(sergeant.organizationId);
  });

  it('lets a track_all_orgs holder place a genuinely global marker', async () => {
    const commander = await member('mapmarkerall', 'PD', 'commander');
    const result = await placeMarker(commander, {
      type: 'hazard', label: unique('Bridge'), x: 0, y: 0, organizationId: null,
    });
    expect(result.status).toBe(201);

    const rows = await h.db.execute<{ organization_id: string | null }>(sql`
      SELECT organization_id FROM map_marker WHERE id = ${result.body.id}
    `);
    expect(rows[0]?.organization_id).toBeNull();
  });

  it('refuses a position outside the world', async () => {
    // Not a rendering nuisance: a marker at (1e9, 1e9) destroys the auto-fit for
    // every other operator, because framing the marker set then has to include a
    // point nobody can see.
    const sergeant = await member('mapmarkerbounds', 'PD', 'sergeant');
    const result = await placeMarker(sergeant, {
      type: 'poi', label: unique('Nowhere'), x: 1_000_000, y: 1_000_000,
    });
    expect(result.status).toBe(400);
  });

  it('audits a placed marker with its world coordinates', async () => {
    const sergeant = await member('mapmarkeraudit', 'PD', 'sergeant');
    const label = unique('Audited');
    const result = await placeMarker(sergeant, {
      type: 'roadblock', label, x: 321, y: -654,
    });
    expect(result.status).toBe(201);

    const rows = await h.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
      SELECT action, metadata FROM audit_log
       WHERE entity_type = 'map_marker' AND entity_id = ${result.body.id}
    `);
    expect(rows[0]?.action).toBe('map.marker_placed');
    // World coordinates, so the entry still means something after the tile set
    // is re-calibrated. A map-space value would not.
    expect(rows[0]?.metadata).toMatchObject({ position: { x: 321, y: -654 } });
  });

  it('hides another organization markers', async () => {
    const mdSergeant = await member('mapmarkermd', 'MD', 'doctor');
    const created = await placeMarker(mdSergeant, {
      type: 'staging', label: unique('MDStage'), x: 10, y: 10,
    });
    expect(created.status).toBe(201);

    const pdOfficer = await member('mapmarkerpd', 'PD', 'officer');
    const result = await snapshot(pdOfficer);
    expect(result.body.markers.map((m) => m.id)).not.toContain(created.body.id);
  });

  it('refuses to remove another organization marker', async () => {
    const mdSergeant = await member('mapmarkermddel', 'MD', 'doctor');
    const created = await placeMarker(mdSergeant, {
      type: 'staging', label: unique('MDDel'), x: 10, y: 10,
    });

    const pdSergeant = await member('mapmarkerpddel', 'PD', 'sergeant');
    const res = await h.app.inject({
      method: 'DELETE', url: `/api/v1/map/markers/${created.body.id}`,
      headers: pdSergeant.headers,
    });
    // 404: a marker outside the caller's scope should not be confirmed to exist.
    expect(res.statusCode).toBe(404);
  });

  it('soft-deletes rather than erasing, and audits the removal', async () => {
    // "Who removed the roadblock, and when" is a question asked after the fact
    // (ADR-0008).
    const sergeant = await member('mapmarkersoft', 'PD', 'sergeant');
    const created = await placeMarker(sergeant, {
      type: 'roadblock', label: unique('Soft'), x: 5, y: 5,
    });

    const res = await h.app.inject({
      method: 'DELETE', url: `/api/v1/map/markers/${created.body.id}`,
      headers: sergeant.headers,
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db.execute<{ deleted_at: Date | null; deleted_by: string | null }>(sql`
      SELECT deleted_at, deleted_by FROM map_marker WHERE id = ${created.body.id}
    `);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.deleted_by).toBe(sergeant.userId);

    const audits = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
       WHERE entity_type = 'map_marker' AND entity_id = ${created.body.id}
         AND action = 'map.marker_removed'
    `);
    expect(audits).toHaveLength(1);
  });

  it('hides an expired marker without needing a cleanup job to have run', async () => {
    const sergeant = await member('mapmarkerexp', 'PD', 'sergeant');
    const label = unique('Expired');
    const created = await placeMarker(sergeant, {
      type: 'roadblock', label, x: 5, y: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(created.status).toBe(201);

    await h.db.execute(sql`
      UPDATE map_marker SET expires_at = now() - interval '1 minute' WHERE id = ${created.body.id}
    `);

    const result = await snapshot(sergeant);
    expect(result.body.markers.map((m) => m.id)).not.toContain(created.body.id);
  });

  it('rejects a partial move', async () => {
    // Accepting one coordinate would place the marker somewhere neither the
    // operator nor the map intended.
    const sergeant = await member('mapmarkerhalf', 'PD', 'sergeant');
    const created = await placeMarker(sergeant, {
      type: 'poi', label: unique('Half'), x: 5, y: 5,
    });

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/map/markers/${created.body.id}`,
      headers: sergeant.headers, payload: { x: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Serialisation boundary ─────────────────────────────────────────────────

describe('serialisation', () => {
  it('never ships a raw unit row', async () => {
    // Engineering rule 16. The unit row carries columns the browser has no
    // business seeing, and a payload built by spreading it would ship whatever
    // column is added to `unit` next.
    const officer = await member('mapserial', 'PD', 'officer');
    await makeUnit({ orgKey: 'PD' });

    const result = await snapshot(officer);
    const unit = result.body.units[0];
    expect(unit).toBeDefined();

    for (const leaked of ['pos_x', 'pos_y', 'position_updated_at', 'is_covert', 'statusKey']) {
      expect(Object.keys(unit!)).not.toContain(leaked);
    }
    // The DTO shape, not the row shape.
    expect(unit).toHaveProperty('organization.key');
    expect(unit).toHaveProperty('status.label');
  });

  it('serialises positions as world coordinates, not map space', async () => {
    // The database stores world coordinates only (05-map.md §2), so
    // re-calibrating the transform never invalidates stored or in-flight data.
    const officer = await member('mapworld', 'PD', 'officer');
    const own = await makeUnit({ orgKey: 'PD' });

    const result = await snapshot(officer);
    const found = result.body.units.find((u) => u.id === own.id);
    expect(found?.location?.x).toBeCloseTo(120.5, 6);
    expect(found?.location?.y).toBeCloseTo(-430.25, 6);
  });
});

// ── Global administrator ───────────────────────────────────────────────────

describe('global administrator', () => {
  it('sees every organization units including covert ones', async () => {
    await setSharing('ICE', false);
    const covert = await makeUnit({ orgKey: 'ICE', covert: true });

    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'mapadmin');
    await makeGlobalAdmin(h.db, creds.username);
    const auth = await signIn(h, creds);
    const admin: Person = {
      username: creds.username,
      userId: await userIdByUsername(h.db, creds.username),
      memberId: '',
      organizationId: '',
      headers: auth.headers,
    };

    const result = await snapshot(admin);
    expect(result.status).toBe(200);
    expect(result.body.units.map((u) => u.id)).toContain(covert.id);
  });
});


// ── The mock adapter's production guard ────────────────────────────────────

describe('simulated positions in production', () => {
  const original = process.env.ALLOW_MOCK_ADAPTERS;
  afterAll(() => {
    if (original === undefined) delete process.env.ALLOW_MOCK_ADAPTERS;
    else process.env.ALLOW_MOCK_ADAPTERS = original;
  });

  /**
   * Engineering rules 34, 35, 45.
   *
   * A dispatcher looking at a map of units that are not really there, with
   * nothing on screen saying so, is the most dangerous failure this system could
   * have: it looks exactly like working software. So the process refuses to
   * start rather than serve one by accident.
   */
  it('refuses to start in production without an explicit override', () => {
    delete process.env.ALLOW_MOCK_ADAPTERS;
    expect(() => assertMockSourceAllowed('production')).toThrow(/refuses to start in production/);
  });

  it('allows it when the override is set deliberately', () => {
    process.env.ALLOW_MOCK_ADAPTERS = 'true';
    expect(() => assertMockSourceAllowed('production')).not.toThrow();
  });

  it('allows it outside production', () => {
    delete process.env.ALLOW_MOCK_ADAPTERS;
    expect(() => assertMockSourceAllowed('development')).not.toThrow();
    expect(() => assertMockSourceAllowed('test')).not.toThrow();
  });
});

// ── The live position store ────────────────────────────────────────────────

describe('live position store', () => {
  const sample = (unitId: string, over: Record<string, unknown> = {}) => ({
    unitId, organizationId: 'org', x: 100, y: 200, z: null,
    heading: 90, speed: 12, sampledAt: new Date(), ...over,
  });

  it('clamps a coordinate outside the world on the way in', () => {
    // A bad sample is a bad sample; it is not a reason to lose the unit
    // entirely, and clamping once here means nothing downstream has to defend.
    const store = new InMemoryPositionStore();
    store.set(sample('u1', { x: 9_999_999, y: -9_999_999 }));

    const stored = store.get('u1');
    expect(stored?.x).toBe(4500);
    expect(stored?.y).toBe(-4500);
  });

  it('prunes samples older than the retention window', () => {
    // Memory has to stay flat across an eight-hour shift (05-map.md §7).
    const store = new InMemoryPositionStore();
    store.set(sample('fresh'));
    store.set(sample('old', { sampledAt: new Date(Date.now() - 60 * 60_000) }));

    expect(store.size).toBe(2);
    expect(store.prune(30 * 60_000)).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get('fresh')).toBeDefined();
    expect(store.get('old')).toBeUndefined();
  });

  it('replaces rather than accumulating per unit', () => {
    const store = new InMemoryPositionStore();
    store.set(sample('u1', { x: 1 }));
    store.set(sample('u1', { x: 2 }));
    expect(store.size).toBe(1);
    expect(store.get('u1')?.x).toBe(2);
  });
});
