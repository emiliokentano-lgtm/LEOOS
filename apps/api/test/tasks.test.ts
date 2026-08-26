import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { compareTasks, taskState, type TaskDto } from '@leoos/contracts';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts,
  signIn, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * Tasks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE DIFFERENT AUTHORITY QUESTIONS, AND THEY HAVE DIFFERENT ANSWERS
 *
 *   ASSIGNING  is permission-gated and NOT rank-gated. That is a deliberate
 *              departure from everything else in this system that acts on
 *              another person, so it is tested explicitly — including the
 *              consequence, that a sergeant with the permission can assign to
 *              a chief.
 *   COMPLETING is the assignee's alone. Not the creator's, not a supervisor's.
 *   CANCELLING is the creator's alone. The assignee cannot make work vanish.
 *
 * Plus the thing every feature here has to prove: another organization cannot
 * see it, touch it, or learn it exists.
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
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function assign(from: Person, to: Person, extra: Record<string, unknown> = {}) {
  return post(from, '/api/v1/tasks', {
    assigneeMemberId: to.memberId,
    title: 'Audit the evidence locker',
    priorityKey: 'normal',
    ...extra,
  });
}

// ── Assigning ───────────────────────────────────────────────────────────────

describe('assigning', () => {
  it('lets somebody with the permission put work on a colleague', async () => {
    const supervisor = await member('tk1a', 'PD', 'sergeant');
    const officer = await member('tk1b', 'PD', 'officer');

    const res = await assign(supervisor, officer);
    expect(res.status).toBe(201);

    const rows = await h.db.execute<{ assignee_member_id: string; created_by_member_id: string }>(
      sql`SELECT assignee_member_id, created_by_member_id FROM task
           WHERE id = ${res.body.id as string}`,
    );
    expect(rows[0]!.assignee_member_id).toBe(officer.memberId);
    expect(rows[0]!.created_by_member_id).toBe(supervisor.memberId);
  });

  it('REFUSES somebody without the permission', async () => {
    const officer = await member('tk2a', 'PD', 'officer');
    const other = await member('tk2b', 'PD', 'officer');

    // An ordinary officer does not hold `tasks.assign`: a dashboard anybody can
    // write to is a dashboard nobody reads.
    const res = await assign(officer, other);
    expect(res.status).toBe(403);
  });

  it('LETS A SERGEANT ASSIGN TO A CHIEF, and that is deliberate', async () => {
    /**
     * The consequence of choosing a permission over a rank ceiling.
     *
     * The hierarchy rules exist because rank is AUTHORITY. A task is a request
     * with a deadline — the chief can complete it, or cancel nothing and ignore
     * it. Importing H1–H8 here would answer a question tasks do not raise.
     *
     * An organization that considers this insubordinate withholds
     * `tasks.assign` from sergeants, which is a policy decision the data model
     * expresses and the code has no opinion about.
     * See docs/architecture/10-dashboard.md §4b.
     */
    const sergeant = await member('tk3a', 'PD', 'sergeant');
    const chief = await member('tk3b', 'PD', 'chief');

    const res = await assign(sergeant, chief);
    expect(res.status).toBe(201);
  });

  it('REFUSES an assignee in ANOTHER organization, as NOT FOUND', async () => {
    const pd = await member('tk4pd', 'PD', 'sergeant');
    const md = await member('tk4md', 'MD', 'paramedic');

    const res = await assign(pd, md);
    // Not forbidden: a 403 would confirm that member exists somewhere.
    expect(res.status).toBe(404);
  });

  it('REFUSES an assignee whose membership is not active', async () => {
    const supervisor = await member('tk5a', 'PD', 'sergeant');
    const leaver = await member('tk5b', 'PD', 'officer');

    await h.db.execute(sql`
      UPDATE organization_member SET status = 'terminated', left_at = now()
       WHERE id = ${leaver.memberId}
    `);

    // A task assigned to somebody who has left would sit open forever and make
    // every count wrong.
    const res = await assign(supervisor, leaver);
    expect(res.status).toBe(409);
  });

  it('REFUSES a priority that does not exist', async () => {
    const supervisor = await member('tk6a', 'PD', 'sergeant');
    const officer = await member('tk6b', 'PD', 'officer');

    const res = await assign(supervisor, officer, { priorityKey: 'extremely_urgent' });
    expect(res.status).toBe(400);
  });

  it('REFUSES a deadline in the past', async () => {
    const supervisor = await member('tk7a', 'PD', 'sergeant');
    const officer = await member('tk7b', 'PD', 'officer');

    const res = await assign(supervisor, officer, {
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    // A task created already overdue is either a typo or a way of making the
    // panel look alarming, and both are better answered at the keyboard.
    expect(res.status).toBe(400);
  });

  it('ACCEPTS no deadline at all', async () => {
    // Plenty of work has none. Inventing one would make every such task either
    // permanently overdue or permanently ignorable.
    const supervisor = await member('tk8a', 'PD', 'sergeant');
    const officer = await member('tk8b', 'PD', 'officer');

    const res = await assign(supervisor, officer, { dueAt: null });
    expect(res.status).toBe(201);
  });

  it('notifies the assignee, and nobody else', async () => {
    const supervisor = await member('tk9a', 'PD', 'sergeant');
    const officer = await member('tk9b', 'PD', 'officer');
    const bystander = await member('tk9c', 'PD', 'officer');

    const res = await assign(supervisor, officer);

    const rows = await h.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM notification
       WHERE type = 'task.assigned' AND entity_id = ${res.body.id as string}
    `);
    expect(rows.map((r) => r.user_id)).toEqual([officer.userId]);
    expect(rows.map((r) => r.user_id)).not.toContain(bystander.userId);
  });

  it('audits the assignment', async () => {
    const supervisor = await member('tk10a', 'PD', 'sergeant');
    const officer = await member('tk10b', 'PD', 'officer');

    const res = await assign(supervisor, officer);
    const audit = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'dispatch.task_assigned' AND entity_id = ${res.body.id as string}
    `);
    expect(audit[0]!.n).toBe(1);
  });

  it('REFUSES an organization smuggled into the body', async () => {
    const supervisor = await member('tk11a', 'PD', 'sergeant');
    const officer = await member('tk11b', 'PD', 'officer');

    const res = await post(supervisor, '/api/v1/tasks', {
      assigneeMemberId: officer.memberId,
      title: 'x',
      priorityKey: 'normal',
      organizationId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(400);
  });
});

// ── Completing ──────────────────────────────────────────────────────────────

describe('completing', () => {
  it('lets the ASSIGNEE tick it off', async () => {
    const supervisor = await member('tk12a', 'PD', 'sergeant');
    const officer = await member('tk12b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    const res = await post(
      officer, `/api/v1/tasks/${created.body.id}/complete`, { completed: true },
    );
    expect(res.status).toBe(200);

    const rows = await h.db.execute<{ completed_by_member_id: string }>(sql`
      SELECT completed_by_member_id FROM task WHERE id = ${created.body.id as string}
    `);
    expect(rows[0]!.completed_by_member_id).toBe(officer.memberId);
  });

  it('REFUSES THE CREATOR completing it', async () => {
    /**
     * The one that matters most.
     *
     * Somebody else marking your work done would make the record say you did
     * something you did not — and the record is the whole reason this is a row
     * rather than a message in a chat.
     */
    const supervisor = await member('tk13a', 'PD', 'sergeant');
    const officer = await member('tk13b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    const res = await post(
      supervisor, `/api/v1/tasks/${created.body.id}/complete`, { completed: true },
    );
    expect(res.status).toBe(403);
  });

  it('REFUSES a chief completing somebody else\'s task', async () => {
    const supervisor = await member('tk14a', 'PD', 'sergeant');
    const officer = await member('tk14b', 'PD', 'officer');
    const chief = await member('tk14c', 'PD', 'chief');

    const created = await assign(supervisor, officer);
    // Rank does not help here. Nobody ticks off somebody else's work.
    const res = await post(
      chief, `/api/v1/tasks/${created.body.id}/complete`, { completed: true },
    );
    expect(res.status).toBe(403);
  });

  it('lets the assignee RE-OPEN a task they ticked by mistake', async () => {
    const supervisor = await member('tk15a', 'PD', 'sergeant');
    const officer = await member('tk15b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    const url = `/api/v1/tasks/${created.body.id}/complete`;
    await post(officer, url, { completed: true });

    // Making completion one-way would mean the only fix is a new task, losing
    // the deadline and the history.
    const reopened = await post(officer, url, { completed: false });
    expect(reopened.status).toBe(200);

    const rows = await h.db.execute<{ completed_at: string | null }>(sql`
      SELECT completed_at FROM task WHERE id = ${created.body.id as string}
    `);
    expect(rows[0]!.completed_at).toBeNull();
  });

  it('REFUSES another organization, as NOT FOUND', async () => {
    const pd = await member('tk16pd', 'PD', 'sergeant');
    const target = await member('tk16t', 'PD', 'officer');
    const md = await member('tk16md', 'MD', 'paramedic');

    const created = await assign(pd, target);
    const res = await post(
      md, `/api/v1/tasks/${created.body.id}/complete`, { completed: true },
    );
    expect(res.status).toBe(404);
  });
});

// ── Cancelling ──────────────────────────────────────────────────────────────

describe('cancelling', () => {
  it('lets the CREATOR withdraw it', async () => {
    const supervisor = await member('tk17a', 'PD', 'sergeant');
    const officer = await member('tk17b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    const res = await post(
      supervisor, `/api/v1/tasks/${created.body.id}/cancel`, { reason: 'No longer needed' },
    );
    expect(res.status).toBe(200);

    const rows = await h.db.execute<{ cancelled_at: string | null; cancelled_reason: string }>(sql`
      SELECT cancelled_at, cancelled_reason FROM task WHERE id = ${created.body.id as string}
    `);
    expect(rows[0]!.cancelled_at).not.toBeNull();
    expect(rows[0]!.cancelled_reason).toBe('No longer needed');
  });

  it('REFUSES THE ASSIGNEE cancelling it', async () => {
    /**
     * Making work disappear by deciding it does not matter is the one thing
     * this feature must not enable.
     */
    const supervisor = await member('tk18a', 'PD', 'sergeant');
    const officer = await member('tk18b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    const res = await post(officer, `/api/v1/tasks/${created.body.id}/cancel`);
    expect(res.status).toBe(403);
  });
});

// ── Reading ─────────────────────────────────────────────────────────────────

describe('reading', () => {
  it('shows the caller their OWN tasks and nobody else\'s', async () => {
    const supervisor = await member('tk19a', 'PD', 'sergeant');
    const mine = await member('tk19b', 'PD', 'officer');
    const theirs = await member('tk19c', 'PD', 'officer');

    const forMe = await assign(supervisor, mine);
    const forThem = await assign(supervisor, theirs);

    const list = await get(mine, '/api/v1/tasks');
    const ids = (list.body.tasks as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(forMe.body.id);
    expect(ids).not.toContain(forThem.body.id);
  });

  it('counts overdue and due-soon separately from open', async () => {
    const supervisor = await member('tk20a', 'PD', 'sergeant');
    const officer = await member('tk20b', 'PD', 'officer');

    const soon = await assign(supervisor, officer, {
      dueAt: new Date(Date.now() + 3_600_000).toISOString(), title: 'Due soon',
    });
    const later = await assign(supervisor, officer, {
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), title: 'Due later',
    });
    const overdue = await assign(supervisor, officer, { title: 'Will be overdue' });

    // Backdated directly: the API refuses to CREATE one in the past, which is
    // right, and the counting still has to handle one that has since passed.
    await h.db.execute(sql`
      UPDATE task SET due_at = now() - interval '1 hour'
       WHERE id = ${overdue.body.id as string}
    `);

    expect(soon.status).toBe(201);
    expect(later.status).toBe(201);
    expect(overdue.status).toBe(201);

    const list = await get(officer, '/api/v1/tasks');
    const counts = list.body.counts as { overdue: number; dueSoon: number; open: number };
    expect(counts.overdue).toBe(1);
    expect(counts.dueSoon).toBe(1);
    // `open` is EVERY outstanding task, not the ones that are neither overdue
    // nor due soon — the three bands overlap on purpose, so a panel can show
    // "2 overdue of 7" rather than making the reader add them up.
    expect(counts.open).toBe(3);
  });

  it('hides completed tasks unless asked for', async () => {
    const supervisor = await member('tk21a', 'PD', 'sergeant');
    const officer = await member('tk21b', 'PD', 'officer');

    const created = await assign(supervisor, officer);
    await post(officer, `/api/v1/tasks/${created.body.id}/complete`, { completed: true });

    const plain = await get(officer, '/api/v1/tasks');
    expect((plain.body.tasks as { id: string }[]).map((t) => t.id))
      .not.toContain(created.body.id);

    const withDone = await get(officer, '/api/v1/tasks?includeCompleted=true');
    expect((withDone.body.tasks as { id: string }[]).map((t) => t.id))
      .toContain(created.body.id);
  });

  it('gives the ORGANIZATION view only to somebody who may assign', async () => {
    const supervisor = await member('tk22a', 'PD', 'sergeant');
    const officer = await member('tk22b', 'PD', 'officer');
    await assign(supervisor, officer);

    const supervisorView = await get(supervisor, '/api/v1/tasks/organization');
    expect((supervisorView.body.tasks as unknown[]).length).toBeGreaterThan(0);

    /**
     * An empty list rather than a 403.
     *
     * A member who cannot assign has no reason to read everybody's workload —
     * letting them would make this a surveillance surface. Reporting it as an
     * error would make an ordinary lack of permission look like a fault.
     */
    const officerView = await get(officer, '/api/v1/tasks/organization');
    expect(officerView.status).toBe(200);
    expect(officerView.body.tasks).toEqual([]);
  });
});

// ── Leaving ─────────────────────────────────────────────────────────────────

describe('when somebody leaves', () => {
  it('cancels their open tasks and KEEPS the ones they created', async () => {
    const supervisor = await member('tk23a', 'PD', 'sergeant');
    const leaver = await member('tk23b', 'PD', 'sergeant');
    const stayer = await member('tk23c', 'PD', 'officer');

    const assignedToLeaver = await assign(supervisor, leaver);
    const createdByLeaver = await assign(leaver, stayer);

    const chief = await member('tk23d', 'PD', 'chief');
    const fired = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${leaver.organizationId}/personnel/${leaver.memberId}/termination`,
      headers: chief.headers,
      payload: { reason: 'Left the department' },
    });
    expect(fired.statusCode).toBe(200);

    // Cannot do it, and leaving it open makes every count wrong.
    const theirs = await h.db.execute<{ cancelled_at: string | null }>(sql`
      SELECT cancelled_at FROM task WHERE id = ${assignedToLeaver.body.id as string}
    `);
    expect(theirs[0]!.cancelled_at).not.toBeNull();

    // The work still needs doing, and who asked for it is part of the record.
    const asked = await h.db.execute<{ cancelled_at: string | null }>(sql`
      SELECT cancelled_at FROM task WHERE id = ${createdByLeaver.body.id as string}
    `);
    expect(asked[0]!.cancelled_at).toBeNull();
  });
});

// ── The pure functions ──────────────────────────────────────────────────────

describe('taskState and ordering', () => {
  const base: TaskDto = {
    id: 'a', title: 't', detail: null,
    priority: { key: 'normal', label: 'Normal', shortLabel: 'N', colorToken: '--x', sortOrder: 30 },
    assignee: { memberId: 'm', displayName: 'A', callsign: null },
    createdBy: null, createdAt: new Date(0).toISOString(),
    dueAt: null, completedAt: null, completedBy: null,
    cancelledAt: null, cancelledReason: null,
    viewerIsAssignee: true, viewerCreated: false,
  };
  const now = Date.parse('2026-01-01T12:00:00Z');

  it('derives overdue, due-soon and open from the deadline', () => {
    expect(taskState({ ...base, dueAt: '2026-01-01T11:00:00Z' }, now)).toBe('overdue');
    expect(taskState({ ...base, dueAt: '2026-01-01T18:00:00Z' }, now)).toBe('due_soon');
    expect(taskState({ ...base, dueAt: '2026-01-05T12:00:00Z' }, now)).toBe('open');
    expect(taskState({ ...base, dueAt: null }, now)).toBe('open');
  });

  it('lets completed and cancelled outrank a deadline', () => {
    const overdueAndDone = { ...base, dueAt: '2026-01-01T11:00:00Z', completedAt: 'x' };
    expect(taskState(overdueAndDone, now)).toBe('completed');
  });

  it('puts the overdue thing at the top without a sort or a filter', () => {
    const open = { ...base, id: 'open', dueAt: '2026-01-05T12:00:00Z' };
    const overdue = { ...base, id: 'overdue', dueAt: '2026-01-01T11:00:00Z' };
    const soon = { ...base, id: 'soon', dueAt: '2026-01-01T18:00:00Z' };

    const sorted = [open, soon, overdue].sort((a, b) => compareTasks(a, b, now));
    expect(sorted.map((t) => t.id)).toEqual(['overdue', 'soon', 'open']);
  });

  it('breaks a tie by priority, then by deadline', () => {
    const low = {
      ...base, id: 'low', dueAt: '2026-01-05T12:00:00Z',
      priority: { ...base.priority, key: 'low', sortOrder: 40 },
    };
    const high = {
      ...base, id: 'high', dueAt: '2026-01-06T12:00:00Z',
      priority: { ...base.priority, key: 'high', sortOrder: 20 },
    };
    expect([low, high].sort((a, b) => compareTasks(a, b, now)).map((t) => t.id))
      .toEqual(['high', 'low']);
  });
});
