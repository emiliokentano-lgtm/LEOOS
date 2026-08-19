# @leoos/api

The LEOOS API. Fastify 5 on Node 22. **The only process that talks to Postgres**
([ADR-0001](../../docs/adr/0001-split-web-and-api.md)) and the only place
authorization is decided.

`apps/web` holds the session cookie and forwards it. It never validates
credentials and never makes an authorization decision — if it appears to, that
is a bug.

## Running

```bash
cp .env.example .env          # set INTERNAL_API_TOKEN to a real random value
pnpm --filter @leoos/db migrate
pnpm --filter @leoos/db seed
pnpm dev                      # http://localhost:3001
```

`GET /health/ready` reports the mail transport's real state, so a deployment
running on the console transport says `"delivering": false` rather than
pretending to send mail.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | 202 always — the response cannot be used to test whether an address is taken |
| POST | `/api/v1/auth/verify` | consumes a single-use token |
| POST | `/api/v1/auth/login` | issues a session; sets `leoos_session` + `leoos_csrf` |
| POST | `/api/v1/auth/logout` | idempotent |
| GET | `/api/v1/auth/me` | current session, memberships, roles, permissions |
| POST | `/api/v1/auth/password/forgot` | identical response whether or not the account exists |
| POST | `/api/v1/auth/password/reset` | revokes every session on success |
| POST | `/api/v1/auth/password/change` | revokes every *other* session |
| GET | `/api/v1/auth/sessions` | the caller's own live sessions |
| DELETE | `/api/v1/auth/sessions/:id` | own sessions only; others 404, never 403 |
| POST | `/api/v1/auth/sessions/revoke-others` | keeps the current session |

## Security decisions

**Passwords** — Argon2id at the OWASP 2024 baseline, parameters encoded in the
hash so they can be raised and existing hashes rehash on next login. Policy is
length (≥12) plus a bundled breach list, not composition rules: enforced
character classes push people toward `Password1!`.

**Sessions** — opaque 256-bit tokens, only `SHA-256(token)` stored, so a database
leak yields nothing usable. Rotated on every login (session fixation), sliding
12 h expiry capped at 7 days absolute. A password change invalidates every
session issued before it, even one a missed revoke left behind.

**Enumeration** — registration and password reset return identical responses for
known and unknown addresses. An unknown login identifier still performs a full
Argon2 verification against a dummy hash, so response time is not an oracle.
Account *state* (suspended/disabled) is reported distinctly, but only after
correct credentials, so it discloses nothing to someone who lacks the password.

**Brute force** — per-identifier and per-IP rate limits plus progressive account
lockout in the database. The two are independent: the limiter is in-process (see
its file comment on the multi-instance limitation), the lockout is durable.

**CSRF** — three independent layers: `SameSite=Lax`, an allow-listed `Origin`,
and a double-submit token. None is load-bearing alone.

**Logging** — redaction is configured on the logger itself, not left to call
sites, so a password cannot reach a log line even if a future handler logs a
whole request body.

**Authorization** — coarse `requirePermission` route guards exist, but they are
never sufficient for a rank-sensitive operation: a guard cannot know the
target's rank. Those decisions belong in the domain service, inside the mutating
transaction, using `loadActorContextLocked`.

## Tests

```bash
DATABASE_URL=… pnpm test    # 42 tests against a real database
```

`auth.test.ts` covers registration, login, logout, account status, protected
endpoints, CSRF, reset and auditing. `membership.test.ts` covers permission
resolution for accounts that actually belong to an organization — a path that is
unreachable for the bare accounts the first suite creates.
