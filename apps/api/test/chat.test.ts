import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, setPermissionOverride,
  signIn, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * Chat.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TEST THAT MATTERS IS THE LEAK TEST
 *
 * Everything else here is ordinary authorization. The thing that makes chat
 * genuinely dangerous is that a message can LINK a record, and a link that
 * resolved the same way for everybody would turn a conversation into a side
 * door into every register in the system.
 *
 * So the central case is: a doctor and an officer read THE SAME MESSAGE linking
 * the same person, and each is told what they are entitled to know. And the
 * unresolved half is ABSENT from the response body — not hidden by CSS, not
 * present with a flag, absent.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

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

async function post(who: Person, url: string, payload: Record<string, unknown> = {}) {
  const res = await h.app.inject({ method: 'POST', url, headers: who.headers, payload });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function get(who: Person, url: string) {
  const res = await h.app.inject({ method: 'GET', url, headers: who.headers });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

async function del(who: Person, url: string) {
  const res = await h.app.inject({ method: 'DELETE', url, headers: who.headers });
  return { status: res.statusCode };
}

async function openDirect(from: Person, to: Person) {
  return post(from, '/api/v1/chat/conversations/direct', { memberId: to.memberId });
}

async function send(who: Person, conversationId: string, payload: Record<string, unknown>) {
  return post(who, `/api/v1/chat/conversations/${conversationId}/messages`, payload);
}

// ── Conversations ───────────────────────────────────────────────────────────

describe('opening a conversation', () => {
  it('opens a direct thread between two colleagues', async () => {
    const a = await member('ch1a', 'PD', 'officer');
    const b = await member('ch1b', 'PD', 'officer');

    const res = await openDirect(a, b);
    expect(res.status).toBe(201);
  });

  it('is IDEMPOTENT: A→B and B→A are the same thread', async () => {
    /**
     * Enforced by a unique index over the ordered pair, not by a read-then-
     * write. Two people opening a DM at the same moment would otherwise create
     * two threads and each see half the conversation.
     */
    const a = await member('ch2a', 'PD', 'officer');
    const b = await member('ch2b', 'PD', 'officer');

    const first = await openDirect(a, b);
    const second = await openDirect(b, a);

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('REFUSES messaging yourself', async () => {
    const a = await member('ch3', 'PD', 'officer');
    const res = await openDirect(a, a);
    expect(res.status).toBe(409);
  });

  it('REFUSES somebody in ANOTHER organization, as NOT FOUND', async () => {
    const pd = await member('ch4pd', 'PD', 'officer');
    const md = await member('ch4md', 'MD', 'paramedic');

    // Cross-agency chat is deliberately absent, and a 403 would confirm the
    // other member exists — which is information about another organization.
    const res = await openDirect(pd, md);
    expect(res.status).toBe(404);
  });

  it('creates a group with the creator always in it', async () => {
    const a = await member('ch5a', 'PD', 'sergeant');
    const b = await member('ch5b', 'PD', 'officer');

    const res = await post(a, '/api/v1/chat/conversations/group', {
      title: 'Night shift', memberIds: [b.memberId],
    });
    expect(res.status).toBe(201);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM conversation_member
       WHERE conversation_id = ${res.body.id as string}
    `);
    expect(rows[0]!.n).toBe(2);
  });

  it('REFUSES a group containing somebody from another organization', async () => {
    const pd = await member('ch6pd', 'PD', 'sergeant');
    const md = await member('ch6md', 'MD', 'paramedic');

    const res = await post(pd, '/api/v1/chat/conversations/group', {
      title: 'Mixed', memberIds: [md.memberId],
    });
    expect(res.status).toBe(404);
  });

  it('needs NO permission — talking to a colleague is not a privilege', async () => {
    /**
     * Deliberate. Gating conversation would produce members who can read a
     * dispatch board and cannot ask a question about it. What is gated is
     * everything a message can REACH — see the link tests below.
     */
    const cadet = await member('ch7a', 'PD', 'cadet');
    const other = await member('ch7b', 'PD', 'cadet');

    expect((await openDirect(cadet, other)).status).toBe(201);
  });
});

// ── Reading and posting ─────────────────────────────────────────────────────

describe('membership is the filter', () => {
  it('lets a participant post and read', async () => {
    const a = await member('ch8a', 'PD', 'officer');
    const b = await member('ch8b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    expect((await send(a, conv.body.id as string, { body: 'On my way' })).status).toBe(201);

    const page = await get(b, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    expect(page.status).toBe(200);
    expect((page.body.messages as { body: string }[])[0]!.body).toBe('On my way');
  });

  it('REFUSES a non-participant reading, as NOT FOUND', async () => {
    const a = await member('ch9a', 'PD', 'officer');
    const b = await member('ch9b', 'PD', 'officer');
    const outsider = await member('ch9c', 'PD', 'officer');
    const conv = await openDirect(a, b);
    await send(a, conv.body.id as string, { body: 'PRIVATE-BETWEEN-US' });

    // The existence of a conversation is itself information about who is
    // talking to whom.
    const page = await get(outsider, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    expect(page.status).toBe(404);
    expect(page.raw).not.toContain('PRIVATE-BETWEEN-US');
  });

  it('REFUSES a non-participant posting', async () => {
    const a = await member('ch10a', 'PD', 'officer');
    const b = await member('ch10b', 'PD', 'officer');
    const outsider = await member('ch10c', 'PD', 'officer');
    const conv = await openDirect(a, b);

    expect((await send(outsider, conv.body.id as string, { body: 'hello' })).status).toBe(404);
  });

  it('stops somebody who was REMOVED from reading, on their next request', async () => {
    /**
     * Membership is checked on every read, never cached — the same rule the map
     * and dispatch topics follow. There is no revocation machinery because
     * there is nothing cached to revoke.
     */
    const owner = await member('ch11a', 'PD', 'sergeant');
    const guest = await member('ch11b', 'PD', 'officer');

    const conv = await post(owner, '/api/v1/chat/conversations/group', {
      title: 'Briefing', memberIds: [guest.memberId],
    });
    await send(owner, conv.body.id as string, { body: 'before' });

    const before = await get(guest, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    expect(before.status).toBe(200);

    await del(
      owner,
      `/api/v1/chat/conversations/${conv.body.id}/participants/${guest.memberId}`,
    );

    const after = await get(guest, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    expect(after.status).toBe(404);
  });

  it('lets only the CREATOR remove somebody else', async () => {
    const owner = await member('ch12a', 'PD', 'sergeant');
    const one = await member('ch12b', 'PD', 'officer');
    const two = await member('ch12c', 'PD', 'officer');

    const conv = await post(owner, '/api/v1/chat/conversations/group', {
      title: 'Squad', memberIds: [one.memberId, two.memberId],
    });

    // Otherwise any participant could clear a group of everybody who disagreed
    // with them, which is the one social failure mode worth designing against.
    const res = await del(
      one, `/api/v1/chat/conversations/${conv.body.id}/participants/${two.memberId}`,
    );
    expect(res.status).toBe(403);
  });

  it('lets anybody LEAVE', async () => {
    const owner = await member('ch13a', 'PD', 'sergeant');
    const guest = await member('ch13b', 'PD', 'officer');

    const conv = await post(owner, '/api/v1/chat/conversations/group', {
      title: 'Squad', memberIds: [guest.memberId],
    });
    const res = await del(
      guest, `/api/v1/chat/conversations/${conv.body.id}/participants/${guest.memberId}`,
    );
    expect(res.status).toBe(200);
  });

  it('REFUSES adding somebody to a DIRECT thread', async () => {
    const a = await member('ch14a', 'PD', 'officer');
    const b = await member('ch14b', 'PD', 'officer');
    const c = await member('ch14c', 'PD', 'officer');
    const conv = await openDirect(a, b);

    // A direct thread is between exactly two people by definition; adding a
    // third would silently turn it into something else.
    const res = await post(
      a, `/api/v1/chat/conversations/${conv.body.id}/participants`, { memberId: c.memberId },
    );
    expect(res.status).toBe(409);
  });
});

// ── Links: the security core ────────────────────────────────────────────────

describe('links resolve PER VIEWER', () => {
  /** A person nobody in this file created, so the ids are stable per test. */
  async function makePerson(name: string): Promise<string> {
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO person (first_name, last_name) VALUES (${name}, 'Linktest')
      RETURNING id
    `);
    return rows[0]!.id;
  }

  it('shows the label to somebody entitled, and REDACTS it for somebody not', async () => {
    /**
     * THE CENTRAL TEST OF THIS FILE.
     *
     * Two people read the same message. One may read the person register and
     * one may not, and the difference must be a redacted chip rather than a
     * name — with the name ABSENT from the response body, not hidden.
     */
    const a = await member('ch15a', 'PD', 'officer');
    const b = await member('ch15b', 'PD', 'officer');
    const personId = await makePerson('Marlow');

    const conv = await openDirect(a, b);
    await send(a, conv.body.id as string, {
      body: 'Check this one',
      links: [{ entityType: 'person', entityId: personId, position: 0 }],
    });

    // A holds `persons.view` and sees the name.
    const entitled = await get(a, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    const link = (entitled.body.messages as {
      links: { resolved: boolean; label?: string }[];
    }[])[0]!.links[0]!;
    expect(link.resolved).toBe(true);
    expect(link.label).toContain('Marlow');

    // B loses it, and reads the SAME message.
    await setPermissionOverride(h.db, b.memberId, 'persons.view', 'deny');
    const blocked = await get(b, `/api/v1/chat/conversations/${conv.body.id}/messages`);

    const blockedLink = (blocked.body.messages as {
      links: { resolved: boolean; reason?: string }[];
    }[])[0]!.links[0]!;
    expect(blockedLink.resolved).toBe(false);
    expect(blockedLink.reason).toBe('not-permitted');

    /**
     * ABSENT, not hidden.
     *
     * The name must not appear anywhere in the serialised response — the whole
     * body is searched, not the fields anyone remembered to check.
     */
    expect(blocked.raw).not.toContain('Marlow');
  });

  it('carries NO identifier on an unresolved link', async () => {
    /**
     * A redacted chip must not be a way to learn an id and then try it
     * elsewhere. The DTO is a discriminated union so there is nowhere in the
     * unresolved shape to put one.
     */
    const a = await member('ch16a', 'PD', 'officer');
    const b = await member('ch16b', 'PD', 'officer');
    const personId = await makePerson('Sandoval');

    const conv = await openDirect(a, b);
    await send(a, conv.body.id as string, {
      body: 'Look',
      links: [{ entityType: 'person', entityId: personId }],
    });

    await setPermissionOverride(h.db, b.memberId, 'persons.view', 'deny');
    const blocked = await get(b, `/api/v1/chat/conversations/${conv.body.id}/messages`);

    expect(blocked.raw).not.toContain(personId);
  });

  it('distinguishes NOT PERMITTED from NOT FOUND', async () => {
    /**
     * Collapsing them would be tidier, and would tell a reader that a record
     * they may not see does not exist — a lie they might act on.
     */
    const a = await member('ch17a', 'PD', 'officer');
    const b = await member('ch17b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    await send(a, conv.body.id as string, {
      body: 'A person who is gone',
      links: [{
        entityType: 'person',
        entityId: '00000000-0000-4000-8000-000000000000',
      }],
    });

    // A MAY read persons; this one simply does not exist.
    const page = await get(a, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    const link = (page.body.messages as {
      links: { resolved: boolean; reason?: string }[];
    }[])[0]!.links[0]!;
    expect(link.resolved).toBe(false);
    expect(link.reason).toBe('not-found');
  });

  it('scopes an incident link to the reader\'s ORGANIZATION', async () => {
    /**
     * `dispatch.view` alone is not enough: another agency's call is not this
     * reader's to see, even inside a conversation they are in.
     */
    const pdOne = await member('ch18a', 'PD', 'sergeant');
    const pdTwo = await member('ch18b', 'PD', 'sergeant');

    const mdCall = await h.db.execute<{ id: string }>(sql`
      INSERT INTO incident (organization_id, priority, status, title)
      SELECT id, 3, 'pending', 'MD-ONLY-CALL' FROM organization WHERE key = 'MD'
      RETURNING id
    `);

    const conv = await openDirect(pdOne, pdTwo);
    await send(pdOne, conv.body.id as string, {
      body: 'Cross-agency link',
      links: [{ entityType: 'incident', entityId: mdCall[0]!.id }],
    });

    const page = await get(pdTwo, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    const link = (page.body.messages as {
      links: { resolved: boolean }[];
    }[])[0]!.links[0]!;
    expect(link.resolved).toBe(false);
    expect(page.raw).not.toContain('MD-ONLY-CALL');
  });

  it('stores NO label at write time', async () => {
    /**
     * `label_hint` is deliberately left null on the way in.
     *
     * Whatever the author saw is THEIR view of the record; storing it would put
     * a name into a row a later reader might not be entitled to, and the whole
     * design rests on the label being resolved per reader.
     */
    const a = await member('ch19a', 'PD', 'officer');
    const b = await member('ch19b', 'PD', 'officer');
    const personId = await makePerson('Okonkwo');

    const conv = await openDirect(a, b);
    await send(a, conv.body.id as string, {
      body: 'x', links: [{ entityType: 'person', entityId: personId }],
    });

    const rows = await h.db.execute<{ label_hint: string | null }>(sql`
      SELECT ml.label_hint FROM message_link ml
        JOIN message m ON m.id = ml.message_id
       WHERE m.conversation_id = ${conv.body.id as string}
    `);
    expect(rows[0]!.label_hint).toBeNull();
  });
});

// ── Deleting ────────────────────────────────────────────────────────────────

describe('deleting', () => {
  it('lets an author delete their own, softly, leaving a tombstone', async () => {
    const a = await member('ch20a', 'PD', 'officer');
    const b = await member('ch20b', 'PD', 'officer');
    const conv = await openDirect(a, b);
    const msg = await send(a, conv.body.id as string, { body: 'REGRETTED-MESSAGE' });

    expect((await del(a, `/api/v1/chat/messages/${msg.body.id}`)).status).toBe(200);

    const page = await get(b, `/api/v1/chat/conversations/${conv.body.id}/messages`);
    const first = (page.body.messages as { deleted: boolean; body: string | null }[])[0]!;
    // A tombstone, not a gap: a thread whose shape changes depending on who is
    // reading is worse than one with a visible hole.
    expect(first.deleted).toBe(true);
    expect(first.body).toBeNull();
    expect(page.raw).not.toContain('REGRETTED-MESSAGE');

    // The row survives, because an operational conversation is a record.
    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM message WHERE id = ${msg.body.id as string}
    `);
    expect(rows[0]!.n).toBe(1);
  });

  it('REFUSES deleting somebody else\'s message', async () => {
    const a = await member('ch21a', 'PD', 'officer');
    const b = await member('ch21b', 'PD', 'officer');
    const conv = await openDirect(a, b);
    const msg = await send(a, conv.body.id as string, { body: 'mine' });

    expect((await del(b, `/api/v1/chat/messages/${msg.body.id}`)).status).toBe(403);
  });

  it('audits the deletion, and NOT the sending', async () => {
    /**
     * An audit row per message would double the write volume of the busiest
     * table here and bury the administrative events the log exists to surface,
     * to record something the message already is. Deleting is the only action
     * that destroys information, which makes it the only one worth a row.
     */
    const a = await member('ch22a', 'PD', 'officer');
    const b = await member('ch22b', 'PD', 'officer');
    const conv = await openDirect(a, b);
    const msg = await send(a, conv.body.id as string, { body: 'x' });
    await del(a, `/api/v1/chat/messages/${msg.body.id}`);

    const deleted = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'chat.message_deleted' AND entity_id = ${msg.body.id as string}
    `);
    expect(deleted[0]!.n).toBe(1);

    const sent = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'chat.message_sent%'
    `);
    expect(sent[0]!.n).toBe(0);
  });
});

// ── The list ────────────────────────────────────────────────────────────────

describe('the conversation list', () => {
  it('counts unread against last_read_at, and clears on read', async () => {
    const a = await member('ch23a', 'PD', 'officer');
    const b = await member('ch23b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    await send(a, conv.body.id as string, { body: 'one' });
    await send(a, conv.body.id as string, { body: 'two' });

    const before = await get(b, '/api/v1/chat/conversations');
    expect(before.body.totalUnread).toBe(2);

    // 204, so it is injected directly — the `post` helper parses a body.
    const read = await h.app.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conv.body.id}/read`,
      headers: b.headers,
      payload: {},
    });
    expect(read.statusCode).toBe(204);

    const after = await get(b, '/api/v1/chat/conversations');
    expect(after.body.totalUnread).toBe(0);
  });

  it('does not count YOUR OWN messages as unread', async () => {
    const a = await member('ch24a', 'PD', 'officer');
    const b = await member('ch24b', 'PD', 'officer');
    const conv = await openDirect(a, b);
    await send(a, conv.body.id as string, { body: 'mine' });

    const list = await get(a, '/api/v1/chat/conversations');
    expect(list.body.totalUnread).toBe(0);
  });

  it('shows nothing to an account with no membership', async () => {
    // A global administrator is in this state. Having no agency is ordinary,
    // and an empty list is the truthful answer rather than an error.
    const creds = await createActiveUser(h, 'ch25');
    const auth = await signIn(h, creds);
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/chat/conversations', headers: auth.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { conversations: unknown[] }).conversations).toEqual([]);
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────────

describe('bounds', () => {
  it('REFUSES an empty message and an enormous one', async () => {
    const a = await member('ch26a', 'PD', 'officer');
    const b = await member('ch26b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    expect((await send(a, conv.body.id as string, { body: '' })).status).toBe(400);
    expect((await send(a, conv.body.id as string, { body: 'x'.repeat(5000) })).status).toBe(400);
  });

  it('REFUSES more links than a message could sensibly carry', async () => {
    const a = await member('ch27a', 'PD', 'officer');
    const b = await member('ch27b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    const links = Array.from({ length: 25 }, () => ({
      entityType: 'person' as const,
      entityId: '00000000-0000-4000-8000-000000000000',
    }));
    expect((await send(a, conv.body.id as string, { body: 'x', links })).status).toBe(400);
  });

  it('REFUSES an unknown link type', async () => {
    const a = await member('ch28a', 'PD', 'officer');
    const b = await member('ch28b', 'PD', 'officer');
    const conv = await openDirect(a, b);

    const res = await send(a, conv.body.id as string, {
      body: 'x',
      links: [{ entityType: 'bank_account', entityId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(res.status).toBe(400);
  });
});
