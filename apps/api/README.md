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

### Organizations

Every route takes `:organizationId` in the PATH. No request body carries an
organization id, so there is nothing for a client to rewrite — and the actor's
authority over the organization named in the path is re-derived from the database
on every call.

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/v1/organizations` | anyone; a non-admin sees only their own memberships |
| POST | `/api/v1/organizations` | global admin |
| GET | `/api/v1/organizations/:id` | members of that organization, or global admin |
| PATCH | `/api/v1/organizations/:id` | that organization's lead, `organization.edit`, or global admin |
| DELETE | `/api/v1/organizations/:id` | global admin; refused while active members remain |
| GET | `/api/v1/organizations/:id/leads` | scoped to that organization |
| POST | `/api/v1/organizations/:id/leads` | **global admin only** |
| DELETE | `/api/v1/organizations/:id/leads/:userId` | **global admin only** |
| GET | `/api/v1/organizations/:id/{members,roles,units,vehicles}` | each authorized independently |

**Organization Lead is not delegable.** A lead cannot appoint another lead. If
they could, the capability would be self-propagating and "the global
administrator decides who leads an organization" would stop being true after the
first grant. That is why it lives in its own table rather than as a role or a
permission: no amount of role editing inside an organization can reach it.

**Category and activation are global-administrator decisions**, even for a lead
of that organization: category drives cross-organization visibility (medical
records), and disabling a department is a decision above one of its own members.

**Out of scope reads as 404, not 403.** A 403 would confirm the organization
exists.

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
