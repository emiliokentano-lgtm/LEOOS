# LEOOS — Operations

Running, configuring, deploying and debugging LEOOS.

**This document contains no secrets and no real values.** Every credential below
is a placeholder or a command that generates one locally. Nothing in this file
should ever be copied into a production environment unchanged.

For the FiveM side — installing the resource, its convars, its endpoints and its
own troubleshooting — see
[`resources/leoos_bridge/README.md`](../resources/leoos_bridge/README.md). This
document covers the API, the web tier and the database.

---

## 1. Local development

### Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node | ≥ 22 | `engines` in the root `package.json`; the code uses Node 22 built-ins |
| pnpm | 10.33 | workspace protocol; the version is pinned in `packageManager` |
| Postgres | 16 | `pg_trgm`, generated columns, and the trigger set in the migrations |
| Docker (optional) | any | only to run Postgres; nothing else is containerised for development |

### First run

```bash
docker compose up -d                # Postgres 16 on :5432 (and Redis, unused today)
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Now generate the shared internal token and put the **same value** in both files —
`INTERNAL_API_TOKEN` in `apps/api/.env` and `LEOOS_INTERNAL_API_TOKEN` in
`apps/web/.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then create the schema and the reference data:

```bash
pnpm db:migrate                     # forward-only migrations
pnpm db:seed                        # permissions, statuses, incident types, organizations
```

And start the two processes, in separate terminals:

```bash
pnpm dev:api                        # Fastify on http://localhost:3001
pnpm dev:web                        # Next.js  on http://localhost:3000
```

`GET http://localhost:3001/health` returns `{"status":"ok"}` and is the only
route that skips authentication.

### Getting a first account

Register at `/register`. Mail is not delivered — the console transport prints the
verification link to the **API log**. Copy it from there.

A verified account has **no organization membership**: registration grants
nothing at all, and you land on a holding screen until somebody assigns you. To
make yourself a global administrator on a fresh database:

```bash
psql "$DATABASE_URL" -c "
  INSERT INTO user_global_role (user_id, capability)
  SELECT id, 'global_admin' FROM user_account WHERE username = 'your.username';
  UPDATE user_account SET permission_version = permission_version + 1
   WHERE username = 'your.username';"
```

The `permission_version` bump is not optional bookkeeping. Identity resolution is
cached on that column (`apps/api/src/modules/auth/context.service.ts`); without
the bump the grant is invisible for up to five seconds instead of applying on the
next request.

### Optional demo data

```bash
pnpm db:seed:demo                   # baseline + fixtures
```

The demo seed refuses to run against `NODE_ENV=production` unless
`ALLOW_DEMO_SEED=true` is set explicitly. It writes fixture persons, vehicles,
personnel and incidents. Do not load it into an installation that holds real
records — there is no un-seed.

---

## 2. Environment variables

Both `.env.example` files are the authoritative list; this table explains the
consequences. **No default here is a secret**, and the two token variables have
no usable default at all.

### `apps/api/.env`

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` activates every guard in §5 |
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | bind address |
| `DATABASE_URL` | — | **required**; a Postgres URL. Do not point this at a database you are not willing to migrate |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | comma-separated. A state-changing request from an origin not on this list is refused |
| `INTERNAL_API_TOKEN` | — | **required, ≥16 chars.** The web tier presents it on server-to-server calls. It is a **complete CSRF bypass** — see §5 |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `720` (12 h) | inactivity before a session dies |
| `SESSION_ABSOLUTE_TIMEOUT_MINUTES` | `10080` (7 d) | hard ceiling regardless of activity |
| `ARGON2_MEMORY_KIB` | `19456` | OWASP 2024 baseline. Production refuses to boot below it |
| `ARGON2_TIME_COST` | `2` | |
| `ARGON2_PARALLELISM` | `1` | |
| `LOGIN_MAX_ATTEMPTS` | `10` | before account lockout |
| `LOGIN_LOCKOUT_MINUTES` | `15` | |
| `POSITION_SOURCE` | `mock` | `mock` or `fivem`. Explicit, never inferred from whether a game server happens to be registered |
| `LEOOS_FIVEM_SECRET_KEY` | unset | base64 32 bytes; encrypts game-server ingest secrets at rest. Required when `POSITION_SOURCE=fivem` or when issuing a credential |
| `LOG_LEVEL` | `info` | pino levels |
| `ALLOW_MOCK_ADAPTERS` | unset | `true` lets a production process start with the console mail transport and/or a simulated map. See §5 |
| `ALLOW_DEMO_SEED` | unset | `true` permits `db:seed:demo` against a production `NODE_ENV` |

Generate the two key-shaped values locally:

```bash
# INTERNAL_API_TOKEN  (also goes in apps/web/.env as LEOOS_INTERNAL_API_TOKEN)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# LEOOS_FIVEM_SECRET_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### `apps/web/.env`

| Variable | Default | Notes |
| --- | --- | --- |
| `LEOOS_API_URL` | `http://localhost:3001` | server-side only; the browser never sees it |
| `LEOOS_INTERNAL_API_TOKEN` | — | **required**; must equal the API's `INTERNAL_API_TOKEN` |
| `LEOOS_PUBLIC_WS_URL` | derived | where the **browser** opens the WebSocket. Left unset it is `LEOOS_API_URL` with the scheme swapped, which is right locally. Behind a proxy or a split hostname, set it explicitly (`wss://api.example.com/ws`) |
| `NEXT_PUBLIC_LEOOS_DEMO` | unset | shows a persistent "Demo data" badge. Commented out in the example on purpose — every screen reads real API data either way |

The web tier holds **no database credentials**. It has no database access at all
([ADR-0001](adr/0001-split-web-and-api.md)); if you find yourself wanting a
`DATABASE_URL` in `apps/web`, the change belongs in the API.

### Where secrets live

- `.env`, `.env.*` are gitignored; `!.env.example` is the single exception.
- The FiveM resource reads its secret from a **convar**, never a resource file —
  server files reach version control and backups even though they never reach
  clients.
- `user_account.password_hash`, `session.token_hash`, `auth_token.token_hash`,
  `game_server_credential.secret_hash` and `user_account.totp_secret_enc` must
  never leave the API process. Every response is built from a DTO in
  `packages/contracts`; returning a raw row from a handler is a lint error.
- An ingest secret is shown **once**, at creation. No endpoint can return it
  again, and the admin DTO does not select the columns. If it is lost, revoke the
  credential and issue a new one.

---

## 3. Database

### Setup

Any Postgres 16 will do. The migrations create their own extensions
(`pg_trgm` for search) and expect to own the database.

```bash
createdb leoos                              # or use docker compose
DATABASE_URL=postgres://user@host/leoos pnpm db:migrate
DATABASE_URL=postgres://user@host/leoos pnpm db:seed
```

### Migrations

Migrations are **forward-only** and reviewed. There is no down path, by design:
reversing a schema change in production is a new migration written deliberately,
not an automated rollback that silently drops columns holding operational
history.

```bash
pnpm db:migrate            # apply everything pending
pnpm db:generate           # drizzle-kit: emit SQL from the schema after editing it
```

Eleven migrations ship today, `0000_init.sql` through `0010_performance.sql`.
`drizzle-kit generate` writes a new file plus a `meta/` journal entry; **read the
generated SQL before committing it** — drizzle will happily emit a destructive
statement for a rename it could not infer.

A migration that adds an index to a large live table should use
`CREATE INDEX CONCURRENTLY`, which cannot run inside the migrator's transaction.
Put it in its own migration file and apply it out of band.

### Seeds

| Command | Contents | Production |
| --- | --- | --- |
| `pnpm db:seed` | permission catalogue, operational statuses, incident types, the six organizations and their rank structures | **Safe.** Idempotent, and required — the application cannot function without it |
| `pnpm db:seed:demo` | fixture persons, vehicles, personnel, incidents | Refused unless `ALLOW_DEMO_SEED=true` |

The baseline seed also runs a **catalogue drift check** and fails loudly if the
permission table and the contracts package disagree. A drifted catalogue is an
authorization hole, so it is not a warning.

### What is enforced in the database

Do not treat these as belt-and-braces; several rules are held **only** here:

- `audit_log`, `incident_log` and `member_status_history` are append-only by
  privilege, with triggers refusing `UPDATE`, `DELETE` and `TRUNCATE`.
- A trigger blocks cross-organization role assignment.
- A trigger refuses attaching a global-scope capability to an organization role.
- A `CHECK` constraint prevents a panic notification being marked muted, so a
  hand-edited row cannot silence an operator.

168 indexes, 96 foreign keys, 279 check constraints and 25 triggers as of
migration 0010.

### Backups

Nothing in this repository configures backups; that is deployment-specific. What
matters operationally: `audit_log` and `incident_log` are the two tables whose
loss cannot be reconstructed from anywhere else, and both grow monotonically —
neither the retention sweep (§6) nor any application path deletes from them.

---

## 4. Deployment

There is no shipped Dockerfile, Helm chart or Terraform. LEOOS is two Node
processes and a Postgres database; the shape below is what the code assumes.

### Topology

```
browser ──► apps/web (Next.js, :3000)  ──► apps/api (Fastify, :3001) ──► Postgres
   └──────── WebSocket ─────────────────────────┘
```

The browser talks to the web tier for pages and to the **API** for the
WebSocket. That second arrow is why `LEOOS_PUBLIC_WS_URL` exists: if the API is
not reachable from the browser at `LEOOS_API_URL`, the socket cannot connect and
every screen silently falls back to revision polling. The status bar will say
`Feed: polling` — that is the symptom to look for.

### Build and run

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm build                 # builds apps/web
pnpm --filter @leoos/api start
pnpm --filter @leoos/web start
```

The API runs under `tsx` rather than a compiled bundle. That is a deliberate
simplification for a single-server deployment and a real cost at scale — it is
listed in the known limitations, not hidden here.

### Reverse proxy

- Terminate TLS at the proxy. Session cookies carry `Secure` whenever
  `NODE_ENV` is neither `development` nor `test`, so **the application will set
  cookies the browser refuses to store if you serve production over plain
  HTTP.** A login that appears to succeed and immediately bounces back to
  `/login` is almost always this.
- Fastify runs with `trustProxy: true`; the proxy must set
  `X-Forwarded-For` correctly, or per-IP rate limits and audit rows will all
  record the proxy's address.
- The WebSocket path is `/ws` on the API. The proxy must pass `Upgrade` and
  `Connection` headers through, and its idle timeout must exceed the client's
  ping interval or connections will be culled mid-session.
- Put every browser-facing origin in `ALLOWED_ORIGINS`. A missing origin
  presents as "every write fails, reads are fine".

### Scaling

**Single-node today.** The nonce store, the WebSocket ticket store, the live
position store, the actor cache and the identity cache are all in-process. On two
instances behind a load balancer:

- a replayed FiveM request can be accepted by the instance that did not see the
  original nonce;
- a WebSocket ticket issued by one instance is unknown to the other;
- each instance holds a different view of live unit positions.

Redis is declared in `docker-compose.yml` for exactly this reason and is **not
wired up**. Run one API instance until it is. The web tier is stateless and can
be replicated freely.

---

## 5. Production configuration guards

The API refuses to start rather than degrade silently. Each of these is a boot
failure, not a warning:

| Guard | Condition | Message |
| --- | --- | --- |
| Argon2 floor | `ARGON2_MEMORY_KIB < 19456` in production | below the OWASP baseline |
| Internal token length | `< 32` chars in production | it is a full CSRF bypass |
| Internal token placeholder | matches `change-me`/`example`/`placeholder`/`secret`/`password` | the `.env.example` value is publicly documented |
| FiveM key | `POSITION_SOURCE=fivem` with no `LEOOS_FIVEM_SECRET_KEY` | no credential could be verified |
| Mail transport | production with the console transport | password reset would silently never arrive |
| Position source | production with the mock source | a map of units that are not there looks exactly like a working one |

The last two can be accepted deliberately with `ALLOW_MOCK_ADAPTERS=true`. The
process then logs a warning at boot and the admin system screen reports the real
state — "Mail: console transport — not delivering" — rather than a configured
tick. The first three cannot be overridden.

Why the internal token is treated this way: `plugins/auth.ts` exempts any request
carrying `x-leoos-internal` from the origin check and from the double-submit CSRF
check. That is correct — the web tier is not a browser and carries no ambient
cookie — but it means whoever knows the string can make state-changing requests
from anywhere.

### Logging

pino, with redaction configured **at the logger** rather than at call sites:
`req.headers.cookie`, `req.headers.authorization`, `x-leoos-internal`,
`password`, `newPassword`, `currentPassword`, `passwordHash`, `token`,
`tokenHash`. The request serializer logs method, path and remote address only —
query strings can carry tokens.

Errors are handled centrally (`plugins/errors.ts`). The client receives a stable
code and a message chosen for it; the internal message — which may name the exact
reason a login failed — is logged and never serialized. Every response carries a
`requestId` that appears in the log line, which is the fastest way to connect a
user's report to a log entry.

---

## 6. API authentication

Four distinct mechanisms. They are not interchangeable.

### Browser sessions

Login returns two cookies:

| Cookie | Flags | Purpose |
| --- | --- | --- |
| `leoos_session` | `HttpOnly`, `SameSite=Lax`, `Secure` outside development | the session token |
| `leoos_csrf` | readable by script, same lifetime | echoed back in `x-leoos-csrf` for the double-submit check |

The CSRF cookie is script-readable **on purpose** — it authorises nothing by
itself. A state-changing request must present both the session cookie and a
matching `x-leoos-csrf` header, and must arrive from an origin in
`ALLOWED_ORIGINS`.

`x-leoos-organization` selects which membership a request acts under when a user
belongs to more than one. It is a *selector*, never an authorization input:
organization scope is derived from the resource or the actor's membership,
never read from the request body.

### The internal token

`x-leoos-internal` identifies the web tier on server-to-server calls and exempts
the request from the origin and CSRF checks. It never reaches the browser. See
§5 for why it is guarded so aggressively.

### WebSocket tickets

A cookie could not cross the origin boundary the socket needs
([ADR-0013](adr/0013-websocket-ticket-handshake.md)). The browser instead asks
the web tier for a **single-use ticket**, presents it on the socket's `auth`
frame, and the ticket is consumed. Topic authorization is then re-evaluated from
the subscriber's own live context **on every delivery**, not cached at subscribe
time — a demoted operator stops receiving on the next event, with no revocation
machinery, because there is nothing cached to revoke.

### FiveM ingest (HMAC)

Game servers sign every request. Headers: `x-leoos-key-id`,
`x-leoos-timestamp`, `x-leoos-nonce`, `x-leoos-seq`, `x-leoos-signature`,
`x-leoos-protocol`. The signature covers a body **hash**, not the body, so
verification stays cheap; a re-serialised body will not match. Replay, clock
skew and sequence regression are all checked, with the handshake exempt from the
sequence rule because it *establishes* the counter. Full protocol in
[`docs/architecture/04-fivem-integration.md`](architecture/04-fivem-integration.md).

### Rate limits

| Budget | Limit | Window | Keyed on |
| --- | --- | --- | --- |
| `general` | 300 | 60 s | user |
| `search` | 60 | 60 s | user (on top of `general`) |
| `login` | 5 | 15 min | account |
| `loginPerIp` | 30 | 15 min | IP |
| `register` | 3 | 60 min | IP |
| `passwordResetRequest` | 3 | 60 min | account |
| `fivemTelemetry` | 180 | 60 s | credential |
| `fivemHandshake` | 30 | 60 min | credential |

Authenticated budgets are keyed on the **user**, not the IP: a shared NAT would
otherwise let one busy operator throttle a whole station.

### Retention sweep

An hourly in-process sweep purges expired sessions and read notifications past
the retention window. Unread notifications are never purged. It is a `setInterval`
inside the API process, so it runs once per instance — one more reason not to run
two.

---

## 7. Troubleshooting

**Login succeeds, then immediately redirects back to `/login`.**
Almost always `Secure` cookies over plain HTTP (§4), or `ALLOWED_ORIGINS`
missing the origin the browser actually used. A cookie that outlives its session
is now cleared with a message rather than bouncing, so a repeating bounce means
the cookie is not being stored at all.

**Every write fails with a CSRF or origin error; reads work.**
The origin is not in `ALLOWED_ORIGINS`, or a proxy is stripping the
`x-leoos-csrf` header.

**The web tier returns 401 for everything, including pages that should be public.**
`LEOOS_INTERNAL_API_TOKEN` does not match the API's `INTERNAL_API_TOKEN`.

**The API will not start.**
Read the message — the boot guards in §5 all name the variable and the reason.
`Invalid environment configuration:` with a path is the Zod schema; anything else
is one of the production guards.

**Status bar says `Feed: polling` and never goes live.**
The browser cannot reach the WebSocket. Check `LEOOS_PUBLIC_WS_URL`, then that
the proxy forwards `Upgrade`/`Connection` on `/ws`. Screens keep working on the
revision poll, which is why this is easy to miss.

**A permission or role change does not take effect.**
Identity is cached on `user_account.permission_version` with a five-second TTL.
Every application path bumps the version; a change made **directly in SQL** must
bump it too, or it applies up to five seconds late.

**The map shows no units.**
Three different states, and they are distinguishable: `POSITION_SOURCE=mock`
gives simulated units; `fivem` with no game server reporting shows
"FiveM bridge — not reporting"; units past `FIVEM_POSITION_TTL_MS` go **offline**
but stay in the roster with their last known position, they are not deleted.

**A game server's requests are all refused.**
In order of likelihood: the convar secret does not match the issued credential;
the server clock is outside the skew window; the credential was revoked; or the
resource was restarted and is replaying a sequence number — the handshake is
exempt from the sequence check precisely so a restart can recover, so if the
handshake itself is refused, look at the clock and the secret first.

**Verification or reset mail never arrives.**
It never does. The console transport prints the link to the API log and does not
send. The admin system screen says so too.

**Tests fail with a cascade of 401s.**
Two API suites were run concurrently. The harness's `resetAccounts` deletes every
test session, so a parallel run loses its own. The API suite must run
sequentially against one database — `pnpm test` already does this
(`--workspace-concurrency=1`).

---

## 8. Verification battery

```bash
pnpm test                    # 928 tests across four packages
pnpm typecheck               # all five packages
pnpm lint
```

The API suite runs sequentially against one database and must not be run
concurrently with another suite — the harness's `resetAccounts` deletes every
test session, so a parallel run loses its own and fails with a cascade of 401s.
`pnpm test` already serialises this (`--workspace-concurrency=1`).

### Browser walkthroughs

These drive a real Chromium against running servers. They are release gates, not
smoke tests — the live-map and notification walkthroughs have each caught a
defect no unit test could have.

They need accounts, and **the accounts are provisioned by scripts in this
repository** rather than assumed to exist:

```bash
# once, against a development database, with the API running
DATABASE_URL=… LEOOS_API=http://localhost:3011 LEOOS_INTERNAL=…   node packages/db/scripts/setup-ui-cast.mjs        # ui.admin … ui.medic
  node packages/db/scripts/setup-admin.mjs > admin.env      # administration cast
  node packages/db/scripts/setup-notifications.mjs > notify.env
  node packages/db/scripts/setup-live-map.mjs > map.env
```

`setup-ui-cast.mjs` creates seven fixed-name accounts the UI walkthroughs look
up directly. The other three print `export …` lines because their casts are
tagged per run; source the output before running the matching walkthrough.

```bash
cd apps/web
node scripts/a11y-check.mjs          # contrast, focus, labels, structure
node scripts/visual-check.mjs        # 4 viewports, overflow, console errors
node scripts/dispatch-check.mjs      # and the others in scripts/
```

Two things to know before you run the whole battery:

- **The login limiter applies to walkthroughs too.** Thirty logins per IP per
  fifteen minutes. Running every script back to back exhausts it, and the
  symptom is a `waitForURL` timeout at the login form — not an application
  fault. Space the runs out; do not raise the limit to make a gate pass.
- **`next dev` compiles a route on first hit**, which can exceed a walkthrough's
  navigation timeout on a cold server. Load the app once in a browser first, or
  run the walkthroughs against `next build && next start`.
