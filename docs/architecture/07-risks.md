# 07 — Security & Technical Risks

Rated by impact × likelihood in this specific system. "Mitigation" describes what
the architecture already does; "Phase" is when it must exist.

---

## Part A — Security risks

### A1 · Privilege escalation through role editing — **Critical**
A member with `roles.edit` edits a role they already hold, adds `admin.users` or
raises its `hierarchy_level`, and becomes an administrator.

*Mitigations:* H3 (cannot edit a role at level ≥ your own), H4 (cannot add a
permission you do not hold), and `scope: 'global'` permissions being structurally
unattachable to organization roles. All three are independent — defeating one is
not enough. **Phase 2.**

### A2 · Privilege escalation through self-assignment — **Critical**
Assigning yourself a superior role, or assigning it to an alt account you control.

*Mitigations:* H6 (no self-management outside the allowlist), H2 (cannot assign a
role at level ≥ your own) — which covers the alt-account route, since the alt is
just another target subject to H1/H2. **Phase 2.**

### A3 · TOCTOU race on concurrent rank changes — **High**
Permission evaluated on stale state while a concurrent demotion commits. Reliably
exploitable by firing parallel requests.

*Mitigation:* all authorization for mutations happens inside the transaction after
`SELECT … FOR UPDATE` on both actor and target membership rows, locks acquired in
ascending id order. Concurrency tests against real Postgres are a release gate.
**Phase 2.**

### A4 · Organization scope escape (IDOR) — **High**
An ICE lead sends a request naming a PD member or a PD role id.

*Mitigations:* organization is never read from the request body; it is derived
from the resource being acted on. Every org-scoped query goes through a helper
that requires an org id resolved from the actor's membership. A database trigger
prevents cross-organization role assignment even if a code path is missed. Objects
outside the actor's scope return `404`, not `403`. **Phase 2.**

### A5 · Mass PII exposure and lookup abuse — **High**
Persons, medical records, warrants, and criminal history are exactly the data real
LE systems are audited for. The realistic threat is not an outside attacker; it is
an authorised user looking up people they have no business looking up.

*Mitigations:* field-level visibility (medical data requires
`persons.medical.view`, held by MD roles only), **read auditing** on every person,
medical, and warrant view, rate-limited search, and a per-user lookup volume
report in the admin UI. **Phases 4 and 8.**

### A6 · Game-server credential compromise — **High**
Whoever administers the FiveM host holds the ingest secret. That is unavoidable;
the question is blast radius.

*Mitigations:* the credential can only submit telemetry for its own server, can
never assert organization or rank, is scoped, rotatable, revocable, rate-limited,
and monitored via anomaly counters. Worst case is falsified positions on one
server — visible, bounded, and recoverable by revoking one key. **Phase 7.**

### A7 · Telemetry spoofing and replay — **Medium**
Replaying or forging position batches.

*Mitigations:* HMAC over method, path, timestamp, nonce, sequence, and body hash;
60 s skew window; Redis nonce cache; monotonic per-server sequence; world-bounds
and speed sanity filters; unknown identifiers tracked as unattributed rather than
attributed to an org. **Phase 7.**

### A8 · Covert unit position leakage — **Medium**
Undercover FIB/ICE positions reaching every officer's browser.

*Mitigation:* visibility computed server-side per subscriber before serialisation;
covert units are simply absent from the payload. Never a client-side filter.
**Phase 6.**

### A9 · Session hijacking and stale privilege — **Medium**
A revoked user keeps an open tab streaming live data.

*Mitigations:* opaque revocable sessions; rotation on login, password change, and
privilege change; 30 s session cache with explicit invalidation; and — the part
that is easy to forget — the WebSocket hub re-evaluates every subscribed topic on
`permissionVersion` change and force-closes sockets whose session was revoked.
**Phases 1 and 5.**

### A10 · Credential stuffing and brute force — **Medium**
*Mitigations:* Argon2id, per-account and per-IP rate limits, progressive lockout,
generic error messages and constant-ish timing, compromised-password screening,
2FA required for high-risk permission holders. **Phases 1 and 8.**

### A11 · Account enumeration — **Low/Medium**
*Mitigations:* identical responses and comparable timing on register, login, and
password reset. A dummy Argon2id verification runs on unknown emails.
**Phase 1.**

### A12 · Audit log tampering — **Medium**
An attacker with application-level access covering their tracks.

*Mitigations:* append-only by database privilege (the application role has
`INSERT`/`SELECT` only), audit written in the same transaction as the change,
monthly partitions, and no delete path in the API. **Phase 1.**

### A13 · WebSocket resource exhaustion — **Medium**
*Mitigations, as actually built* (`apps/api/src/realtime/`):

| Mitigation | State |
| --- | --- |
| Authentication before anything else | **Done** — single-use ticket as the first message, 10 s grace, then closed ([ADR-0013](../adr/0013-websocket-ticket-handshake.md)) |
| Subscription cap per connection | **Done** — 32 topics per `subscribe` message |
| Message size limits | **Done** — 8 KB per message, 16 KB socket payload cap |
| Slow-client disconnect | **Partial** — a socket that throws on send is dropped; there is no send-queue depth check |
| Heartbeat timeouts | **Done** — closed after 60 s of silence |
| Connection cap per user and per IP | **Not done.** An authenticated account can still open many sockets. Each is cheap and each is fully authorized, so this is a resource concern rather than a security one — but it is a real gap and is stated as one. |

**Phase 5, carrying one open item into Phase 8.**

### A14 · XSS through user-supplied content — **Medium**
Incident notes, person notes, and callsigns are all free text rendered to other
users.

*Mitigations:* React's default escaping, a blanket ban on `dangerouslySetInnerHTML`
enforced by lint, strict CSP (`default-src 'self'`, no inline scripts, nonce-based),
and `Trusted Types` where supported. **Phase 3.**

### A15 · Insider abuse by a global administrator — **Medium**
The role exists and cannot be constrained away.

*Mitigations:* every global-admin action is audited with elevated metadata;
high-risk actions can raise alerts; global admin count kept small; 2FA required;
impersonation (if implemented) is a separate permission, time-boxed, banner-visible
to the impersonated user's audit trail. Detection, not prevention — which is the
honest answer for this role. **Phase 8.**

### A16 · Panic-alert flooding — **Low**
*Mitigations:* per-member panic rate limit, deduplication window, and
acknowledgement workflow so a stuck panic can be cleared. **Phase 5.**

---

## Part B — Technical risks

### B1 · Map tile licensing — **High, blocking**
We need a GTA V map raster set. The technical work is trivial; the licensing
question is not, and it blocks Phase 6 entirely. *Action: resolve before Phase 6
begins. Fallback is rendering our own tiles from in-game captures.*

### B2 · Coordinate calibration drift — **Medium**
A wrong affine transform puts every unit and incident in the wrong place, and the
error is subtle enough to ship.

*Mitigation:* one shared pure transform in `packages/contracts`, calibrated against
two named landmarks, with those landmarks as unit-test fixtures. World coordinates
only in the database, so re-calibration never invalidates stored data.

### B3 · Marker rendering performance — **Medium**
300 DOM markers at 1 Hz will not hold frame rate.

*Mitigation:* canvas overlay for units from the start, not as an optimisation
later; interpolation between ticks; render skipped on hidden tabs. Load-test with
300 synthetic units in Phase 6.

### B4 · Lua HTTP reliability — **Medium**
`PerformHttpRequest` is asynchronous, callback-based, and behaves poorly under
load; naive implementations queue overlapping requests and amplify an outage.

*Mitigation:* at most one telemetry request in flight, ticks skipped rather than
queued, no telemetry retries, bounded retry queue for events only, jittered
backoff, and silent degradation so a LEOOS outage never affects gameplay.

### B5 · Position write amplification — **Medium**
Naively persisting every sample is ~13 M rows/day of worthless data.

*Mitigation:* Redis is the live store; Postgres receives only a 1-sample-per-10s
downsample into monthly partitions with a 7-day retention job.

### B6 · Permission cache staleness — **Medium**
A cached permission set outliving a demotion.

*Mitigation:* version-keyed cache (invalidation by key change, not deletion), 60 s
TTL, and an absolute rule that write transactions never consult the cache —
enforced by giving the cached and locked loaders different names.

### B7 · Migration and seed drift — **Medium**
The permission catalogue lives in TypeScript and in the database.

*Mitigation:* a CI check that diffs `PERMISSIONS` against the seeded table and
fails the build on divergence. Migrations are forward-only, reviewed, and run in
CI against a production-shaped snapshot.

### B8 · Deployment topology assumption — **Medium**
The design requires a host that supports long-lived connections. A serverless
target would invalidate the real-time architecture.

*Mitigation:* **[CONFIRM]** self-hosted VPS/container host early. Docker Compose in
Phase 0 makes the assumption concrete and testable from day one.

### B9 · Scope creep in Phase 5 — **Medium**
Dispatch is where every stakeholder has an opinion. It is the phase most likely to
double in size.

*Mitigation:* explicit exit criteria per phase (see the roadmap), and a rule that
new dispatch features land after Phase 8 unless they block another phase.

### B10 · Single-developer bus factor / documentation decay — **Low/Medium**
*Mitigation:* ADRs for every non-obvious decision, this architecture set kept
current as implementation diverges, and code review on the authz kernel by a second
pair of eyes as a hard requirement.

### B11 · Test infrastructure cost — **Low**
Testcontainers-based Postgres tests are slower than mocks.

*Mitigation:* accepted deliberately. The authz guarantees depend on real
transactional behaviour, and mocked tests would assert nothing about the property
that matters. Unit tests for the pure kernel stay fast; only integration tests pay
the cost.
