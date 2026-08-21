import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, signIn, type TestHarness,
} from './harness.js';
import { LIMITS } from '../src/lib/rate-limit.js';

/**
 * The authenticated request budget.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Rate limiting existed only where a request is a GUESS — login, registration,
 * password reset, the FiveM claim code. This covers the surfaces where a request
 * is a COST instead, and the two properties that make the budget correct rather
 * than merely present:
 *
 *   • the scanning endpoints have their own, tighter budget, so a page that
 *     legitimately makes many cheap reads is not thereby entitled to as many
 *     trigram scans;
 *   • the budget is keyed on the USER, so one operator exhausting theirs does
 *     not lock out the next person on the same network.
 *
 * The second is the one worth a test. A limiter keyed on the IP passes every
 * "does it refuse at the limit" test and is wrong in exactly the deployment this
 * system ships into — a game community behind one address.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
});

beforeEach(() => {
  h.app.limiter.resetAll();
});

afterAll(async () => {
  await h.close();
});

async function operator(prefix: string) {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'lieutenant' });
  return signIn(h, creds);
}

async function hammer(headers: Record<string, string>, url: string, times: number) {
  const codes: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const res = await h.app.inject({ method: 'GET', url, headers });
    codes.push(res.statusCode);
  }
  return codes;
}

describe('the search budget', () => {
  it('refuses past the limit and says how long to wait', async () => {
    const session = await operator('rlsearch');

    const codes = await hammer(session.headers, '/api/v1/search?q=smith', LIMITS.search.limit + 2);

    expect(codes.slice(0, LIMITS.search.limit).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);

    const refused = await h.app.inject({
      method: 'GET', url: '/api/v1/search?q=smith', headers: session.headers,
    });
    expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  /**
   * The whole reason the search budget is separate. If searching came out of the
   * general budget alone, this request would still succeed — and a screen that
   * polls would be paying for somebody else's scans.
   */
  it('does not spend the general budget it is meant to protect', async () => {
    const session = await operator('rlseparate');
    await hammer(session.headers, '/api/v1/search?q=smith', LIMITS.search.limit + 1);

    const other = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: session.headers,
    });
    expect(other.statusCode).toBe(200);
  });

  it('is spent by the person register too, which scans the same way', async () => {
    const session = await operator('rlregister');
    const codes = await hammer(
      session.headers, '/api/v1/persons?search=smith', LIMITS.search.limit + 2,
    );
    expect(codes.at(-1)).toBe(429);
  });
});

describe('the budget is keyed on the operator, not the address', () => {
  /**
   * Both sessions arrive from the same address — `app.inject` has one. If the
   * key were the IP, the second operator would be refused for the first one's
   * traffic, which is the failure mode this system would actually meet: a
   * roleplay community's dispatchers are frequently behind one NAT.
   */
  it('leaves a second operator on the same address unaffected', async () => {
    const first = await operator('rlkeya');
    const second = await operator('rlkeyb');

    const exhausted = await hammer(
      first.headers, '/api/v1/search?q=smith', LIMITS.search.limit + 1,
    );
    expect(exhausted.at(-1)).toBe(429);

    const other = await h.app.inject({
      method: 'GET', url: '/api/v1/search?q=smith', headers: second.headers,
    });
    expect(other.statusCode).toBe(200);
  });
});
