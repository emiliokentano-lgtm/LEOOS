import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AUDIT_ACTIONS } from '@leoos/db';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_TYPES, canMuteCategory, shouldPlaySound,
} from '@leoos/contracts';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, setPermissionOverride,
  signIn, type TestHarness,
} from './harness.js';

/**
 * Notifications.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS FOR
 *
 * A notification is a PUSH of information, so the only property that really
 * matters is that its audience is exactly the set of people who could already
 * have seen the thing by looking. Four properties are release gates:
 *
 *   1. RECIPIENTS ARE DERIVED, NEVER SUPPLIED. There is no request shape that
 *      names a recipient, and the audience for an organization's panic contains
 *      nobody from another organization and nobody without `dispatch.view`.
 *   2. A FEED IS PRIVATE TO ITS OWNER. No route takes a user id; another
 *      person's notification is a 404 to read and a no-op to mark read — not a
 *      403, which would confirm it exists.
 *   3. PANIC CANNOT BE MUTED OR SILENCED BY CONFIGURATION. Not by preference,
 *      not by a crafted request, not by a hand-edited row.
 *   4. SOUND IS OFF UNTIL ASKED FOR. The default configuration makes no noise,
 *      including for a panic.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
});

beforeEach(() => {
  // See admin.test.ts: production allows three registrations an hour per IP,
  // which would throttle this file rather than anything it tests.
  h.app.limiter.resetAll();
});

afterAll(async () => {
  await h.close();
});

async function freshUser(prefix: string) {
  h.app.limiter.resetAll();
  return createActiveUser(h, prefix);
}

/** An account with a membership and a live session, ready to make requests. */
async function operator(prefix: string, orgKey = 'PD', roleKey = 'lieutenant') {
  const creds = await freshUser(prefix);
  const membership = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const session = await signIn(h, creds);
  return { creds, ...membership, ...session };
}

async function userIdOf(username: string): Promise<string> {
  const [row] = await h.db.execute<{ id: string }>(
    sql`SELECT id FROM user_account WHERE username = ${username}`,
  );
  if (!row) throw new Error(`no such user: ${username}`);
  return row.id;
}

interface FeedNotification {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  metadata: Record<string, unknown>;
}

async function feed(
  headers: Record<string, string>,
  query = '',
): Promise<{ notifications: FeedNotification[]; unreadCount: number; nextCursor: string | null }> {
  const res = await h.app.inject({
    method: 'GET', url: `/api/v1/notifications${query}`, headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function typesIn(headers: Record<string, string>): Promise<string[]> {
  return (await feed(headers)).notifications.map((n) => n.type);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · The audience is derived, and it is the right one
// ═══════════════════════════════════════════════════════════════════════════

describe('a panic reaches exactly the people who could have seen it', () => {
  it('notifies dispatchers in the same organization, and nobody else', async () => {
    const caller = await operator('panicaller', 'PD', 'officer');
    const dispatcher = await operator('paniclistener', 'PD', 'lieutenant');
    const otherOrg = await operator('panicoutsider', 'MD', 'doctor');

    // Somebody in the right organization who cannot see dispatch at all. The
    // whole point of the derivation is that this person is not on the list.
    const blind = await operator('panicblind', 'PD', 'officer');
    await setPermissionOverride(h.db, blind.memberId, 'dispatch.view', 'deny');

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);

    expect(await typesIn(dispatcher.headers)).toContain('panic.triggered');
    expect(await typesIn(otherOrg.headers)).not.toContain('panic.triggered');
    expect(await typesIn(blind.headers)).not.toContain('panic.triggered');
    // The person in trouble does not get a copy of their own alert; it would sit
    // at the top of the list of the one person who cannot act on it.
    expect(await typesIn(caller.headers)).not.toContain('panic.triggered');
  });

  it('carries the alert at critical severity, with a link to dispatch', async () => {
    const caller = await operator('panicsev', 'PD', 'officer');
    const dispatcher = await operator('panicsevwatch', 'PD', 'lieutenant');

    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });

    const entry = (await feed(dispatcher.headers)).notifications
      .find((n) => n.type === 'panic.triggered');
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe('critical');
    expect(entry!.href).toBe('/dispatch');
    expect(entry!.entityType).toBe('panic_event');
    expect(entry!.entityId).toBeTruthy();
  });

  it('does not duplicate an alert when the button is pressed again', async () => {
    const caller = await operator('panicrepeat', 'PD', 'officer');
    const dispatcher = await operator('panicrepeatwatch', 'PD', 'lieutenant');

    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/self/panic',
        headers: caller.headers, payload: {},
      });
    }

    const alerts = (await feed(dispatcher.headers)).notifications
      .filter((n) => n.type === 'panic.triggered');
    expect(alerts).toHaveLength(1);
  });

  it('tells the same audience when the alert is stood down', async () => {
    const caller = await operator('panicdown', 'PD', 'officer');
    const dispatcher = await operator('panicdownwatch', 'PD', 'lieutenant');

    const raised = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });
    const { id } = raised.json() as { id: string };

    const stood = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/panics/${id}/resolve`,
      headers: caller.headers, payload: {},
    });
    expect(stood.statusCode, stood.body).toBe(200);

    const types = await typesIn(dispatcher.headers);
    expect(types).toContain('panic.resolved');

    // Info, not critical: it is the ABSENCE of an emergency. A stand-down that
    // arrives as loudly as the alert trains people to ignore both.
    const resolved = (await feed(dispatcher.headers)).notifications
      .find((n) => n.type === 'panic.resolved');
    expect(resolved!.severity).toBe('info');
  });
});

describe('incidents notify the smallest audience that would otherwise miss something', () => {
  async function createIncident(
    headers: Record<string, string>,
    priority: number,
    title = 'Test call',
  ): Promise<{ id: string; number: string }> {
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents',
      headers, payload: { title, priority, locationText: 'Vespucci Beach' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  it('notifies dispatchers for a P1 and stays quiet for a P3', async () => {
    const creator = await operator('p1creator', 'PD', 'lieutenant');
    const watcher = await operator('p1watcher', 'PD', 'lieutenant');

    await createIncident(creator.headers, 3, 'Routine call');
    expect(await typesIn(watcher.headers)).not.toContain('incident.critical');

    await createIncident(creator.headers, 1, 'Shots fired');
    expect(await typesIn(watcher.headers)).toContain('incident.critical');
  });

  it('treats an escalation to P1 as a new critical call', async () => {
    const creator = await operator('esccreator', 'PD', 'lieutenant');
    const watcher = await operator('escwatcher', 'PD', 'lieutenant');

    const call = await createIncident(creator.headers, 4, 'Noise complaint');
    expect(await typesIn(watcher.headers)).not.toContain('incident.critical');

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/priority`,
      headers: creator.headers, payload: { priority: 1, reason: 'Weapon reported' },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(await typesIn(watcher.headers)).toContain('incident.critical');
  });

  it('does not notify anybody about a de-escalation', async () => {
    const creator = await operator('decreator', 'PD', 'lieutenant');
    const watcher = await operator('dewatcher', 'PD', 'lieutenant');

    const call = await createIncident(creator.headers, 1, 'Reported robbery');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/priority`,
      headers: creator.headers, payload: { priority: 4, reason: 'Unfounded' },
    });

    // The P1 landed; the drop back to P4 added nothing on top of it.
    const critical = (await feed(watcher.headers)).notifications
      .filter((n) => n.type === 'incident.critical');
    expect(critical).toHaveLength(1);
  });

  it('notifies the crew of a unit when it is assigned to a call', async () => {
    const dispatcher = await operator('asgdispatch', 'PD', 'lieutenant');
    const officer = await operator('asgofficer', 'PD', 'officer');

    const unit = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units',
      headers: dispatcher.headers,
      payload: { callsign: `A-${Date.now().toString(36)}`, unitType: 'patrol', joinSelf: false },
    });
    expect(unit.statusCode, unit.body).toBe(201);
    const { id: unitId } = unit.json() as { id: string };

    const joined = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/self/unit/${unitId}`,
      headers: officer.headers, payload: {},
    });
    expect(joined.statusCode, joined.body).toBe(200);

    const call = await createIncident(dispatcher.headers, 2, 'Traffic collision');
    const assigned = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: dispatcher.headers, payload: { unitId },
    });
    expect(assigned.statusCode, assigned.body).toBe(201);

    const entry = (await feed(officer.headers)).notifications
      .find((n) => n.type === 'incident.assigned');
    expect(entry).toBeDefined();
    expect(entry!.entityId).toBe(call.id);
    // Severity follows the CALL: a P2 assignment is a warning, not an interrupt.
    expect(entry!.severity).toBe('warning');
  });

  it('raises an assignment to a P1 call to critical', async () => {
    const dispatcher = await operator('p1asgdispatch', 'PD', 'lieutenant');
    const officer = await operator('p1asgofficer', 'PD', 'officer');

    const unit = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units',
      headers: dispatcher.headers,
      payload: { callsign: `B-${Date.now().toString(36)}`, unitType: 'patrol', joinSelf: false },
    });
    const { id: unitId } = unit.json() as { id: string };
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/self/unit/${unitId}`,
      headers: officer.headers, payload: {},
    });

    const call = await createIncident(dispatcher.headers, 1, 'Officer down');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: dispatcher.headers, payload: { unitId },
    });

    const entry = (await feed(officer.headers)).notifications
      .find((n) => n.type === 'incident.assigned');
    expect(entry!.severity).toBe('critical');
  });

  it('notifies nobody when a note is added', async () => {
    const dispatcher = await operator('notedispatch', 'PD', 'lieutenant');
    const officer = await operator('noteofficer', 'PD', 'officer');

    const unit = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units',
      headers: dispatcher.headers,
      payload: { callsign: `C-${Date.now().toString(36)}`, unitType: 'patrol', joinSelf: false },
    });
    const { id: unitId } = unit.json() as { id: string };
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/self/unit/${unitId}`,
      headers: officer.headers, payload: {},
    });

    const call = await createIncident(dispatcher.headers, 3, 'Suspicious vehicle');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: dispatcher.headers, payload: { unitId },
    });

    const before = (await feed(officer.headers)).notifications.length;

    for (let i = 0; i < 5; i += 1) {
      const note = await h.app.inject({
        method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/notes`,
        headers: dispatcher.headers, payload: { body: `Update ${i}` },
      });
      expect(note.statusCode, note.body).toBe(201);
    }

    expect((await feed(officer.headers)).notifications.length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · A feed is private to its owner
// ═══════════════════════════════════════════════════════════════════════════

describe('a notification feed belongs to exactly one person', () => {
  async function raisePanicSeenBy(prefix: string) {
    const caller = await operator(`${prefix}caller`, 'PD', 'officer');
    const watcher = await operator(`${prefix}watcher`, 'PD', 'lieutenant');
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });
    const entry = (await feed(watcher.headers)).notifications
      .find((n) => n.type === 'panic.triggered');
    if (!entry) throw new Error('fixture did not produce a notification');
    return { watcher, entry };
  }

  it('answers 404 for somebody else’s notification', async () => {
    const { entry } = await raisePanicSeenBy('priv1');
    const stranger = await operator('priv1stranger', 'MD', 'doctor');

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/notifications/${entry.id}`, headers: stranger.headers,
    });
    // 404, not 403: a 403 would confirm the id names something real.
    expect(res.statusCode).toBe(404);
  });

  it('silently marks nothing when given somebody else’s id', async () => {
    const { watcher, entry } = await raisePanicSeenBy('priv2');
    const stranger = await operator('priv2stranger', 'MD', 'doctor');

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/notifications/read',
      headers: stranger.headers, payload: { notificationIds: [entry.id] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { updated: number }).updated).toBe(0);

    // The owner's badge is untouched — which is the point. Marking somebody
    // else's alert read removes the badge that would have made them look.
    const owner = await h.app.inject({
      method: 'GET', url: `/api/v1/notifications/${entry.id}`, headers: watcher.headers,
    });
    expect((owner.json() as { readAt: string | null }).readAt).toBeNull();
  });

  it('offers no route that names a user', async () => {
    const { watcher, entry } = await raisePanicSeenBy('priv3');
    const stranger = await operator('priv3stranger', 'MD', 'doctor');
    const victimId = await userIdOf(watcher.creds.username);

    // Every shape somebody might reach for to read another person's feed.
    const attempts = [
      `/api/v1/notifications?userId=${victimId}`,
      `/api/v1/notifications/user/${victimId}`,
      `/api/v1/notifications?user_id=${victimId}`,
    ];

    for (const url of attempts) {
      const res = await h.app.inject({ method: 'GET', url, headers: stranger.headers });
      // Either the query is refused as unknown (strict schema) or the route does
      // not exist. What must never happen is a 200 carrying the victim's feed.
      expect([400, 404], `${url} returned ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body).not.toContain(entry.id);
    }
  });

  it('requires a session', async () => {
    for (const url of ['/api/v1/notifications', '/api/v1/notifications/unread',
      '/api/v1/notifications/preferences']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · The centre: counting, reading, filtering, paging
// ═══════════════════════════════════════════════════════════════════════════

describe('the notification centre', () => {
  /** Produces `count` notifications addressed to one watcher. */
  async function fill(prefix: string, count: number) {
    const creator = await operator(`${prefix}creator`, 'PD', 'lieutenant');
    const watcher = await operator(`${prefix}watcher`, 'PD', 'lieutenant');
    for (let i = 0; i < count; i += 1) {
      const res = await h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/incidents',
        headers: creator.headers, payload: { title: `Critical ${i}`, priority: 1 },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    return { creator, watcher };
  }

  it('counts unread across everything, not just the page', async () => {
    const { watcher } = await fill('count', 5);

    const page = await feed(watcher.headers, '?limit=2');
    expect(page.notifications).toHaveLength(2);
    expect(page.unreadCount).toBe(5);

    const unread = await h.app.inject({
      method: 'GET', url: '/api/v1/notifications/unread', headers: watcher.headers,
    });
    expect(unread.json()).toEqual({ total: 5, critical: 5 });
  });

  it('marks a set read and reports the new badge', async () => {
    const { watcher } = await fill('markset', 4);
    const page = await feed(watcher.headers);
    const ids = page.notifications.slice(0, 2).map((n) => n.id);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/notifications/read',
      headers: watcher.headers, payload: { notificationIds: ids },
    });
    expect(res.json()).toEqual({ updated: 2, unread: { total: 2, critical: 2 } });

    // Marking the same ones again is a no-op rather than an error: two tabs
    // clicking the same entry is ordinary.
    const again = await h.app.inject({
      method: 'POST', url: '/api/v1/notifications/read',
      headers: watcher.headers, payload: { notificationIds: ids },
    });
    expect((again.json() as { updated: number }).updated).toBe(0);
  });

  it('marks everything read', async () => {
    const { watcher } = await fill('markall', 3);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/notifications/read-all', headers: watcher.headers,
    });
    expect(res.json()).toEqual({ updated: 3, unread: { total: 0, critical: 0 } });

    // The entries are still THERE — read, not deleted. A centre that empties
    // itself when you look at it cannot answer "what did I miss this shift".
    const page = await feed(watcher.headers);
    expect(page.notifications).toHaveLength(3);
    expect(page.notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it('filters to unread only', async () => {
    const { watcher } = await fill('unreadonly', 3);
    const page = await feed(watcher.headers);
    await h.app.inject({
      method: 'POST', url: '/api/v1/notifications/read',
      headers: watcher.headers, payload: { notificationIds: [page.notifications[0]!.id] },
    });

    const remaining = await feed(watcher.headers, '?unreadOnly=true');
    expect(remaining.notifications).toHaveLength(2);
  });

  it('filters by category over the whole feed, not over one page', async () => {
    const creator = await operator('catcreator', 'PD', 'lieutenant');
    const watcher = await operator('catwatcher', 'PD', 'lieutenant');
    const caller = await operator('catcaller', 'PD', 'officer');

    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/incidents',
        headers: creator.headers, payload: { title: `Critical ${i}`, priority: 1 },
      });
    }
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });

    const panics = await feed(watcher.headers, '?category=panic');
    expect(panics.notifications.map((n) => n.type)).toEqual(['panic.triggered']);

    const incidents = await feed(watcher.headers, '?category=incidents');
    expect(incidents.notifications).toHaveLength(3);
    expect(incidents.notifications.every((n) => n.type === 'incident.critical')).toBe(true);
  });

  it('pages with a cursor that neither repeats nor skips', async () => {
    const { watcher } = await fill('paging', 7);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string = cursor === null
        ? '?limit=3'
        : `?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const result = await feed(watcher.headers, query);
      seen.push(...result.notifications.map((n) => n.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(cursor).toBeNull();
  });

  it('treats an unreadable cursor as the head of the list rather than an error', async () => {
    const { watcher } = await fill('badcursor', 2);
    const page = await feed(watcher.headers, '?cursor=not-a-real-cursor');
    expect(page.notifications).toHaveLength(2);
  });

  it('opens a notification with everything its detail view needs', async () => {
    const { watcher } = await fill('detail', 1);
    const [entry] = (await feed(watcher.headers)).notifications;

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/notifications/${entry!.id}`, headers: watcher.headers,
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as FeedNotification & { organization: { key: string } | null };

    expect(detail.title).toContain('P1');
    // The link to the related object, composed by the API rather than by the
    // client — the API is what knows whether the subject still exists.
    expect(detail.href).toContain('/dispatch?incident=');
    expect(detail.entityType).toBe('incident');
    expect(detail.organization?.key).toBe('PD');
    expect(detail.metadata).toMatchObject({ priority: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Preferences, and what they cannot do
// ═══════════════════════════════════════════════════════════════════════════

describe('notification preferences', () => {
  it('answers the contract defaults when nothing has been configured', async () => {
    const user = await operator('prefdefault', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/notifications/preferences', headers: user.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it('starts with sound OFF, so a fresh install makes no noise at all', async () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES.soundEnabled).toBe(false);
    // Including for a panic — the loudest thing in the system is silent until
    // somebody asks for it. An app that makes noise on first use gets muted at
    // the operating-system level, and then the panic tone is muted too.
    expect(shouldPlaySound('panic.triggered', 'critical', DEFAULT_NOTIFICATION_PREFERENCES))
      .toBe(false);
  });

  it('persists a change and answers with what was stored', async () => {
    const user = await operator('prefwrite', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'PUT', url: '/api/v1/notifications/preferences',
      headers: user.headers,
      payload: { soundEnabled: true, soundCriticalOnly: false, soundVolume: 35 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      soundEnabled: true, soundCriticalOnly: false, soundVolume: 35,
    });

    const read = await h.app.inject({
      method: 'GET', url: '/api/v1/notifications/preferences', headers: user.headers,
    });
    expect(read.json()).toMatchObject({ soundEnabled: true, soundVolume: 35 });
  });

  it('refuses to mute panic, and answers with the state that actually resulted', async () => {
    const user = await operator('prefpanic', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'PUT', url: '/api/v1/notifications/preferences',
      headers: user.headers,
      payload: { mutedCategories: ['panic', 'incidents'] },
    });

    // Not a 400 the client has to special-case: what can be stored is stored,
    // and the response is the truth, so the switch snaps back in the UI.
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { mutedCategories: string[] }).mutedCategories).toEqual(['incidents']);
    expect(canMuteCategory('panic')).toBe(false);
  });

  it('cannot be made to mute panic by writing the row directly either', async () => {
    const user = await operator('prefdb', 'PD', 'officer');
    const userId = await userIdOf(user.creds.username);

    // The database refuses it too, so a support script editing the row by hand
    // cannot produce an operator who will not be told somebody is in trouble.
    await expect(h.db.execute(sql`
      INSERT INTO notification_preference (user_id, muted_categories)
      VALUES (${userId}, ARRAY['panic']::text[])
    `)).rejects.toThrow();
  });

  it('rejects a volume outside the slider', async () => {
    const user = await operator('prefvolume', 'PD', 'officer');
    for (const soundVolume of [-1, 101, 5000]) {
      const res = await h.app.inject({
        method: 'PUT', url: '/api/v1/notifications/preferences',
        headers: user.headers, payload: { soundVolume },
      });
      expect(res.statusCode, `volume ${soundVolume}`).toBe(400);
    }
  });

  it('refuses an unknown preference rather than ignoring it', async () => {
    const user = await operator('prefstrict', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'PUT', url: '/api/v1/notifications/preferences',
      headers: user.headers, payload: { soundEnabled: true, muteEverything: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is per person, not per organization', async () => {
    const a = await operator('prefminea', 'PD', 'officer');
    const b = await operator('prefmineb', 'PD', 'officer');

    await h.app.inject({
      method: 'PUT', url: '/api/v1/notifications/preferences',
      headers: a.headers, payload: { soundEnabled: true },
    });

    const other = await h.app.inject({
      method: 'GET', url: '/api/v1/notifications/preferences', headers: b.headers,
    });
    expect((other.json() as { soundEnabled: boolean }).soundEnabled).toBe(false);
  });
});

describe('the sound policy', () => {
  it('needs the type to be audible AND sound to be on', () => {
    const on = { ...DEFAULT_NOTIFICATION_PREFERENCES, soundEnabled: true };
    expect(shouldPlaySound('panic.triggered', 'critical', on)).toBe(true);
    // Silent by catalogue, whatever the operator asked for.
    expect(shouldPlaySound('incident.updated', 'critical', on)).toBe(false);
    expect(NOTIFICATION_TYPES['incident.updated'].audible).toBe(false);
  });

  it('honours critical-only, which is the default once sound is on', () => {
    const on = { ...DEFAULT_NOTIFICATION_PREFERENCES, soundEnabled: true };
    expect(on.soundCriticalOnly).toBe(true);
    expect(shouldPlaySound('incident.assigned', 'warning', on)).toBe(false);
    expect(shouldPlaySound('incident.assigned', 'critical', on)).toBe(true);

    const everything = { ...on, soundCriticalOnly: false };
    expect(shouldPlaySound('incident.assigned', 'warning', everything)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Announcements — the one notification a human composes
// ═══════════════════════════════════════════════════════════════════════════

describe('organization announcements', () => {
  async function announce(
    headers: Record<string, string>,
    organizationId: string,
    payload: Record<string, unknown>,
  ) {
    return h.app.inject({
      method: 'POST', url: `/api/v1/notifications/announcements/${organizationId}`,
      headers, payload,
    });
  }

  it('reaches every active member of the organization', async () => {
    const chief = await operator('annchief', 'PD', 'chief');
    const officer = await operator('annofficer', 'PD', 'officer');
    const outsider = await operator('annoutsider', 'MD', 'doctor');

    const res = await announce(chief.headers, chief.organizationId, {
      title: 'Shift briefing moved', body: 'Briefing is at 19:00 tonight.',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { recipients: number }).recipients).toBeGreaterThan(0);

    expect(await typesIn(officer.headers)).toContain('organization.announcement');
    expect(await typesIn(outsider.headers)).not.toContain('organization.announcement');
    // Not to the sender: they wrote it.
    expect(await typesIn(chief.headers)).not.toContain('organization.announcement');
  });

  it('is refused without the permission', async () => {
    const officer = await operator('annnoperm', 'PD', 'officer');
    const res = await announce(officer.headers, officer.organizationId, {
      title: 'Unauthorized notice', body: 'This should not be sent.',
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot be aimed at another organization', async () => {
    const chief = await operator('anncrossorg', 'PD', 'chief');
    const target = await operator('anncrosstarget', 'MD', 'doctor');

    const res = await announce(chief.headers, target.organizationId, {
      title: 'Cross-agency notice', body: 'Should not arrive.',
    });
    // 404, not 403: the organization scope comes from the actor's own
    // membership, so a foreign id names nothing they can see.
    expect(res.statusCode).toBe(404);
    expect(await typesIn(target.headers)).not.toContain('organization.announcement');
  });

  it('cannot be sent at critical severity', async () => {
    const chief = await operator('anncritical', 'PD', 'chief');
    const res = await announce(chief.headers, chief.organizationId, {
      title: 'Fake emergency', body: 'Pretending to be a panic.', severity: 'critical',
    });
    // Refused by the schema; the service caps it as well, so posting around the
    // schema still cannot produce a critical announcement.
    expect(res.statusCode).toBe(400);
  });

  it('is audited, with who sent it and how far it reached', async () => {
    const chief = await operator('annaudit', 'PD', 'chief');
    await operator('annauditreader', 'PD', 'officer');

    await announce(chief.headers, chief.organizationId, {
      title: 'Audited notice', body: 'Recorded in the log.', severity: 'warning',
    });

    const [row] = await h.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
      SELECT action, metadata FROM audit_log
       WHERE action = ${AUDIT_ACTIONS.ANNOUNCEMENT_SENT}
         AND actor_user_id = (SELECT id FROM user_account WHERE username = ${chief.creds.username})
       ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(row).toBeDefined();
    expect(row!.metadata).toMatchObject({ title: 'Audited notice', severity: 'warning' });
    expect(Number(row!.metadata.recipients)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · The serialization boundary
// ═══════════════════════════════════════════════════════════════════════════

describe('no notification response carries a credential', () => {
  it('is clean across the whole surface', async () => {
    const caller = await operator('leakcaller', 'PD', 'officer');
    const watcher = await operator('leakwatcher', 'PD', 'lieutenant');
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: caller.headers, payload: {},
    });

    const page = await feed(watcher.headers);
    const detail = await h.app.inject({
      method: 'GET', url: `/api/v1/notifications/${page.notifications[0]!.id}`,
      headers: watcher.headers,
    });
    const preferences = await h.app.inject({
      method: 'GET', url: '/api/v1/notifications/preferences', headers: watcher.headers,
    });

    const serialised = [JSON.stringify(page), detail.body, preferences.body].join('\n');
    for (const forbidden of [
      'password_hash', 'passwordHash', 'token_hash', 'tokenHash',
      'totp_secret', 'totpSecret', 'secret_enc', 'secretEnc', '$argon2',
    ]) {
      expect(serialised, `leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('does not put a caller’s phone number or an incident note into a notification', async () => {
    const dispatcher = await operator('leakphone', 'PD', 'lieutenant');
    const watcher = await operator('leakphonewatch', 'PD', 'lieutenant');

    const call = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents',
      headers: dispatcher.headers,
      payload: {
        title: 'Domestic disturbance',
        priority: 1,
        description: 'CONFIDENTIAL-DESCRIPTION',
        callerPhone: '555-0199',
      },
    });
    expect(call.statusCode, call.body).toBe(201);

    const serialised = JSON.stringify(await feed(watcher.headers));
    expect(serialised).not.toContain('555-0199');
    expect(serialised).not.toContain('CONFIDENTIAL-DESCRIPTION');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a fan-out larger than one statement can carry', () => {
  /**
   * ONE INSERT HAS A PARAMETER CEILING, AND PANIC IS THE LARGEST FAN-OUT.
   *
   * Postgres accepts at most 65 535 bind parameters per statement. The
   * notification insert binds twelve per row, so a single statement tops out
   * around 5 400 recipients — and past that the driver fails the whole
   * statement rather than delivering fewer. The notification that matters most
   * is therefore the first one to stop working.
   *
   * This writes recipients directly rather than through the service, because
   * what is under test is the WRITE, not the audience rule — which has its own
   * tests above. Six thousand rows is deliberately just over the ceiling.
   */
  it('writes every recipient past the single-statement limit', async () => {
    const { createNotifications } = await import(
      '../src/modules/notifications/notification.service.js'
    );

    const chief = await operator('fanout', 'PD', 'chief');

    /**
     * Six thousand real accounts, written in one statement.
     *
     * Real ones because `notification.user_id` is a foreign key — the first
     * draft of this test used random UUIDs and failed on that rather than on
     * the thing it was meant to measure. They are inert rows: no memberships,
     * no sessions, nothing that could sign in.
     */
    const distinct = await h.db.execute<{ id: string }>(sql`
      INSERT INTO user_account (email, username, password_hash, display_name, status)
      SELECT 'fanout' || n || '@example.invalid', 'fanout' || n, 'x', 'Fan Out ' || n, 'disabled'
        FROM generate_series(1, 6000) AS n
      RETURNING id
    `);
    expect(distinct).toHaveLength(6_000);

    const delivered = await createNotifications(
      h.db,
      distinct.map((row) => ({ userId: row.id, memberId: chief.memberId })),
      {
        type: 'panic.triggered',
        organizationId: chief.organizationId,
        title: 'Officer needs assistance',
        body: null,
        href: '/dispatch',
        entityType: 'panic_event',
        entityId: null,
      },
    );

    // Every one, not "as many as fitted".
    expect(delivered).toHaveLength(6_000);

    const written = await h.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM notification
       WHERE type = 'panic.triggered' AND organization_id = ${chief.organizationId}
    `);
    expect(Number(written[0]?.count ?? 0)).toBeGreaterThanOrEqual(6_000);
  }, 60_000);
});
