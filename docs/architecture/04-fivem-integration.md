# 04 — FiveM Integration

> **Status: implemented.** This described a design; it now describes what runs.
> Five things changed between the two, and each is recorded here rather than
> quietly edited away — a document that hides where reality diverged teaches the
> next person nothing.
>
> | Was | Is | Why |
> | --- | --- | --- |
> | Secret stored as an Argon2id hash | Secret stored **encrypted** (AES-256-GCM) | HMAC is symmetric — a one-way hash cannot verify a signature. [Migration 0007](../../packages/db/migrations/0007_fivem.sql) |
> | Nonces in Redis | Nonce cache in-process | Redis is not provisioned. The persisted **sequence** is what holds under scale, and it is checked too. |
> | Live positions in Redis, TTL 45 s | In-process store, swept on a 5 s tick | Same reason. Same TTL, same semantics. |
> | `/events` covers in-game panic and duty toggle | Also `player.connected` / `player.dropped` | Prompt departure beats waiting out a 45 s TTL. |
> | Position history downsampled to `position_history` | **Not built** | No playback UI exists yet; writing history nothing reads is rule 22 in reverse. |
>
> Implementation: [`apps/api/src/modules/fivem/`](../../apps/api/src/modules/fivem/),
> [`resources/leoos_bridge/`](../../resources/leoos_bridge/) — whose
> [README](../../resources/leoos_bridge/README.md) is the operator-facing
> installation, configuration and troubleshooting guide.

## 1. Trust model

The single most important statement in this document:

> The FiveM server is authenticated as a **machine**, and it is trusted to report
> **where players are**. It is never trusted to report **who they are** in
> organizational terms.

Concretely:

| Data | Source of truth |
| --- | --- |
| Player position, heading, vehicle, online state | FiveM server (server-side natives) |
| Player FiveM identifier (`license:…`) | FiveM server |
| **Organization membership** | LEOOS database only |
| **Rank / role / hierarchy level** | LEOOS database only |
| **Permissions** | LEOOS database only |
| **Callsign, unit assignment** | LEOOS database only |
| Duty status | LEOOS database (game may *request* a change; API authorizes it) |

If the bridge payload contains an `organization` field, the API discards it. The
API resolves organization membership by looking up the FiveM identifier in
`game_identity` and joining to `organization_member`. A compromised game server
can therefore lie about coordinates — a bounded, detectable problem — but cannot
manufacture a Chief of Police.

Equally: all coordinates come from **server-side** natives (`GetEntityCoords`,
`GetEntityHeading`, `GetVehiclePedIsIn` on the server) and never from client NUI
messages or client-side events. A modded game client cannot inject a position.

---

## 2. Topology

```
  ┌──────────────────────────────────────────┐
  │  FiveM server                            │
  │  ┌────────────────────────────────────┐  │
  │  │ resources/leoos_bridge (server)    │  │
  │  │  · collects state every 1000 ms    │  │
  │  │  · batches all players             │  │
  │  │  · signs with HMAC-SHA256          │  │
  │  │  · PerformHttpRequest (outbound)   │  │
  │  │  · retry queue + backoff           │  │
  │  └────────────────────────────────────┘  │
  └──────────────────┬───────────────────────┘
                     │  HTTPS, outbound only
                     ▼
  ┌──────────────────────────────────────────┐
  │  apps/api  /api/v1/fivem/*               │
  │   verify → validate → resolve → store    │
  └──────────────────────────────────────────┘
```

Outbound-only means no inbound firewall rule on the game host and no listening
port to attack. The web application never initiates a connection to the game
server; commands flow the other way by being included in the ingest response body
(§6).

---

## 3. Authentication: signed requests

Per game server, a credential pair:

- `key_id` — public, sent in a header, identifies which secret to use.
- `secret` — 256-bit, shown **once** at creation, stored **encrypted at rest**.

> **Corrected from the original design, which said "stored as an Argon2id
> hash".** That is not achievable alongside HMAC: HMAC is symmetric, so verifying
> a signature means holding the same key the resource used, and a one-way hash
> cannot provide it. The alternative — the resource sending its secret on every
> request — loses the body binding that makes tampering with one coordinate a
> signature failure, and puts a long-lived credential in every proxy log between
> the game host and the API.
>
> So the secret is sealed with AES-256-GCM under `LEOOS_FIVEM_SECRET_KEY`, held
> in the environment and never in the database, following the `*_enc` convention
> this schema already uses for `user_account.totp_secret_enc`. Someone with a
> database dump alone has ciphertext. `secret_hash` is still written and still
> never leaves the API; it is no longer the verification path. See
> [migration 0007](../../packages/db/migrations/0007_fivem.sql).

Every request carries:

```
X-LEOOS-Key-Id:    srv_7f3a…
X-LEOOS-Timestamp: 1755523200          (unix seconds)
X-LEOOS-Nonce:     b64url(16 bytes)
X-LEOOS-Seq:       184213              (monotonic per server)
X-LEOOS-Signature: hex(HMAC-SHA256(secret, canonical))

canonical = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" SEQ "\n" SHA256(body)
```

Verification, in order, failing closed:

1. `key_id` resolves to a credential that is not revoked and not expired.
2. `|now − timestamp| ≤ 60 s` (clock skew window).
3. Nonce unseen — in-process, 120 s TTL. **Not Redis**, which is not
   provisioned; the consequence is stated rather than hidden, in
   `nonce-store.ts`: across two API processes one instance's nonce cache is
   unknown to the other, so step 4 is what actually holds under horizontal
   scale. That is why both checks exist and why they are in this order.
4. `seq > game_server_state.last_ingest_seq` — monotonic replay protection that
   survives the nonce TTL window. **The handshake is exempt**, and the exemption
   is load-bearing: see *The restart problem* below.
5. HMAC recomputed and compared in constant time.
6. Body validated against the Zod schema — `.strict()`, so an unknown field is
   a rejection rather than a silent ignore. That is how a resource sending
   `organization` finds out immediately instead of shipping for months believing
   the API reads it.

### The restart problem

The resource counts sequence numbers per process; the API remembers the last
accepted one per credential, in the database. Those two facts do not compose. A
game server that restarts comes back counting from near zero while the API is
holding a high-water mark in the thousands, so if the handshake were checked
against it, every request the restarted server sent would be refused — including
the handshake that every other failure message tells it to run. The credential
would be bricked until an administrator issued a new secret, and rebooting a
FiveM server would be an administrative event.

Two changes, together:

- **The handshake establishes the sequence rather than continuing it.** Check 4
  is skipped for `POST /handshake`, and the handler writes that request's
  sequence as the new baseline — a reset, not an advance. Nothing is given up:
  a captured handshake is still refused by the nonce inside the 60 s skew window
  and by the timestamp outside it, so there is no window in which replaying one
  works. The exemption is derived from the route rather than passed as a
  parameter, so no other endpoint can ask for it.
- **The resource seeds its counter from `os.time()`**, so an ordinary restart is
  already ahead of where the previous run finished and never needs the reset.
  The reset is the recovery path for a clock that went backwards, not the normal
  one.

Regression tests cover the restarted server, the replayed handshake and the
timestamp backstop (`apps/api/test/fivem.test.ts`).

The **signature check is last** on purpose: it is the only step that costs real
CPU, and everything above it discards a malformed or replayed request without
reaching it. An unknown `key_id` and a bad signature return an identical
response, so the endpoint cannot be used to enumerate key ids.

Signing the body hash rather than the body keeps verification cheap and makes
tampering with a single coordinate a signature failure.

**Rotation:** two credentials may be live per server simultaneously. The operator
adds the new key, updates the resource config, confirms traffic on the new
`key_id`, then revokes the old one. No downtime, no shared-secret ceremony.

**Secret handling in the resource:** the secret lives in the FiveM server's
`server.cfg` as a convar (`set leoos_secret "…"`), read via `GetConvar` at resource
start, never written to a resource file that could end up in version control, and
never sent to game clients. Server-side resource files are not distributed to
players, but convars keep it out of the repository too.

---

## 4. Endpoints

All under `/api/v1/fivem`, all requiring a valid signature.

### `POST /handshake`
Called once at resource start. Sends resource version, server name, player slots.
Returns the ingest interval the API wants, the current protocol version, and a
server-assigned `session_id`. Lets the API push configuration changes (e.g. "slow
down to 2 s") without a resource update.

### `POST /heartbeat`
Every 10 s. Body: player count, uptime, resource version. Updates
`game_server_state.last_heartbeat_at`.

### `POST /telemetry`
Every 1 s (configurable). **One request for all online players**, not one per
player. This is the core of the ingest design: per-player requests would mean 150
HTTP round trips per second from a Lua runtime that handles HTTP asynchronously
and poorly under load.

```jsonc
{
  "sessionId": "…",
  "sentAt": 1755523200123,
  "players": [
    {
      "src": 12,                                 // server id, transient
      "identifiers": { "license": "license:ab…" },
      "x": 421.7, "y": -981.2, "z": 30.7,
      "heading": 187.4,
      "speed": 22.4,                             // m/s
      "health": 187, "armor": 0,
      "vehicle": { "model": "police3", "plate": "12ABC345",
                   "seat": -1, "sirens": true, "lights": true },
      "weapon": null,
      "requestedStatus": null                    // advisory only
    }
  ],
  "departed": ["license:cd…"]                    // players who left this tick
}
```

### `POST /events`
Discrete, low-frequency occurrences: player connected, player dropped, in-game
panic button pressed, in-game duty toggle. Delivered separately from telemetry so
an event is never lost to telemetry coalescing.

### `POST /identity/claim`
Supports linking a FiveM identifier to a LEOOS account. The user generates a
six-character claim code in the web UI; in-game they run a command; the resource
posts `{ identifier, code }`; the API verifies the code (5-minute TTL, single use,
rate-limited) and sets `game_identity.verified_at`. The link is proven from both
sides, so a player cannot claim someone else's identifier and an admin cannot
silently attach an identifier to an account.

---

## 5. Ingest pipeline

```
signature verified
      ▼
schema validation (Zod, .strict())
      ▼
identifier extraction ──── no identifier ─────▶ reject, counted
      ▼
duplicate detection   ──── same id twice ─────▶ reject BOTH, counted
      ▼
identity resolution (game_identity → member → unit, from DB only)
      ▼                └─ unlinked / not crewed ──▶ tracked, attributed to nobody
sanity filters  ──── out of bounds / teleport ──▶ reject, counted
      ▼
live position store (TTL 45 s)
      ▼
Postgres `unit.pos_*` cache, at 1/30th the tick rate
      ▼
location broadcaster ─────────────────────────▶ realtime hub → map:units
```

`position_history` downsampling is **not built**. The table exists and the
`map.history` permission exists, but no playback UI does — and writing history
nothing reads is engineering rule 22 in reverse. It lands with the playback
screen or not at all.

**Sanity filters** — cheap, and they catch both bugs and spoofing:

| Check | Action on failure |
| --- | --- |
| Coordinates within GTA V world bounds | reject at the schema; the batch is a `400` |
| Implied speed between consecutive samples ≤ 200 m/s | reject the sample as `teleport`, **keep the last good position**, count the anomaly |
| Timestamp within skew window | reject the request, `401` |
| Batch size ≤ 512 players | reject at the schema |
| Same identifier appearing twice in one batch | reject **both** samples, count twice |
| Unknown identifier | tracked as seen, attributed to nobody — no organization, no callsign, no unit |
| Linked but not crewed in a unit | no position: the map shows units, and a person is not one |
| Member terminated or suspended | no position, immediately |

A rejected coordinate is **never clamped**. That is a deliberate difference from
the live position store, which does clamp: there, losing track of a unit entirely
is worse than a slightly wrong pin. At the trust boundary an out-of-world
coordinate is *evidence*, and it is counted so an operator can see it happened.

The teleport rule keeps the previous position rather than replacing it. A
dispatcher acting on a slightly stale position is far better off than one acting
on a position in the ocean.

An unlinked player is tracked but never appears as an organizational unit. This
matters: it means the map cannot be made to show a fake ICE unit by an unknown
identifier.

Anomaly counters per game server are exposed in the admin UI and alert when a
threshold is crossed. Sustained anomalies are the signal that a game server is
compromised or misconfigured.

**Rate limiting** is per `game_server`, on a token bucket sized to roughly 2× the
configured interval, so a runaway loop is throttled rather than absorbed.

---

## 6. Offline detection

Three independent levels, because they fail differently:

| Level | Detection | Effect |
| --- | --- | --- |
| Player left | present in `departed[]`, or a `player.dropped` event | unit removed from the live map immediately |
| Position stale | no sample for 45 s | unit disappears even if the removal was lost |
| Server offline | no heartbeat for 30 s | every unit **that server** was reporting goes offline |

The TTL is the safety net that makes the whole thing self-healing: if the API
restarts, or a removal is missed, or the game server dies mid-tick, stale
positions expire on their own and nothing has to remember to clean up. It is
swept on a 5 s tick by `FiveMPositionSource`.

**Server-offline detection is scoped by `unit.pos_game_server_id`**, added in
migration 0007 for exactly this reason. A deployment with two game servers must
not have one going quiet blank the other's units — which is precisely the bug a
global clear would be.

`FiveMPositionSource.status()` is what the map screen renders, and it reports the
connection it actually has: with the bridge enabled and nothing reporting it says
"FiveM bridge — not reporting", never a green light it has not earned
(engineering rule 45).

---

## 7. Command channel (server ← API)

The `/telemetry` and `/heartbeat` responses carry a small command list, letting
the API push actions without the game server exposing an inbound endpoint:

```jsonc
{
  "ok": true,
  "nextIntervalMs": 1000,
  "commands": [
    { "id": "c_01", "type": "notify", "target": "license:ab…",
      "payload": { "title": "Dispatch", "body": "Assigned to #2026-08-000431" } },
    { "id": "c_02", "type": "setBlip", "target": "license:cd…",
      "payload": { "color": 38 } },
    { "id": "c_03", "type": "kickUnit", "target": "license:ef…" }
  ]
}
```

Commands are queued in Redis per server, delivered at-most-once per poll, and
acknowledged on the next request by id. At-most-once is deliberate: a duplicated
in-game notification is worse than a missed one, and anything that must not be
lost belongs in the web UI, not in a game popup.

---

## 8. The Lua resource

`resources/leoos_bridge/` — **server scripts only**, no client scripts beyond a
thin command handler for identity claiming.

```
leoos_bridge/
├── fxmanifest.lua
├── config.lua                    # non-secret defaults, all convar-overridable
├── README.md                     # installation, configuration, troubleshooting
├── server/
│   ├── sha2.lua                  # SHA-256, pure Lua
│   ├── hmac.lua                  # HMAC-SHA256 (RFC 2104)
│   ├── adapters/
│   │   ├── standalone.lua        # base natives only — the default
│   │   └── init.lua              # selection; the whole framework seam
│   ├── collector.lua             # server-side natives → snapshots, throttling
│   ├── transport.lua             # signing, PerformHttpRequest, retry, backoff
│   ├── commands.lua              # applies commands from responses
│   └── main.lua                  # lifecycle, loops, in-game commands
└── client/
    └── claim.lua                 # renders notifications. Nothing else.
```

**Crypto is pure Lua, not `ox_lib`.** FiveM ships no primitives, and the
alternatives were a hard dependency on somebody else's resource for one function,
or a process spawn per request. About 90 lines, verified at start-up against the
published FIPS 180-4 and RFC 4231 vectors — a subtly wrong hash does not error,
it produces a signature the API rejects, which presents as "authentication is
broken" and sends an operator hunting through their credentials rather than their
Lua. The resource refuses to start if the self-check fails.

**Throttling lives in the collector**, not the transport: the decision is per
player and the transport deals in batches. A player is sent when they moved more
than 3 m, turned more than 10°, changed vehicle, or have not been sent for 10 s.
On a server where most players are standing still a batch is a handful of entries
rather than everyone, and a parked server sends nothing at all.

Implementation constraints that shape this design:

- `PerformHttpRequest` is **asynchronous with a callback** and has no built-in
  timeout guarantee. The transport keeps at most one telemetry request in flight;
  if the previous request has not returned when the next tick fires, the tick is
  skipped rather than queued. Overlapping requests would reorder and amplify load
  during exactly the moments the network is struggling.
- A bounded retry queue (max 30 entries) holds `/events` payloads only. Telemetry
  is never retried — a one-second-old position is worthless, and retrying it turns
  a blip into a thundering herd.
- Backoff on failure: 1s → 2s → 4s → 8s → 15s cap, with jitter.
- **No framework is assumed** (rule 37). The default and only shipped
  implementation is `standalone`, which uses only base FiveM natives
  (`GetPlayerIdentifiers`, `GetEntityCoords`, `GetEntityHeading`,
  `GetVehiclePedIsIn`) and depends on nothing else. It works on any FiveM server.

  Adapters **register themselves** into a global table rather than returning a
  value — FiveM loads each `server_script` as its own chunk and discards what it
  returns, so a `return` would simply vanish. Adding a framework adapter is one
  file plus one manifest line, with nothing in `init.lua` to edit.

  Framework-specific access is confined to one adapter interface in
  `server/adapters/`, and nothing outside that directory may reference a framework
  global such as `ESX` or `QBCore`:

  ```lua
  -- server/adapters/init.lua
  ---@class LeoosAdapter
  ---@field name string
  ---@field detect fun(): boolean          -- is this framework present?
  ---@field getIdentity fun(src: number): { license: string?, steam: string?, discord: string? }
  ---@field getCharacterName fun(src: number): string|nil   -- optional, advisory only
  ```

  Adapters are selected by explicit config (`leoos_adapter` convar), with
  autodetection only as a fallback that logs which adapter it chose. `standalone`
  ships in Phase 7; `esx` and `qbcore` adapters are added only if the server
  actually runs them.

  Note that even a framework adapter supplies **only identifiers**, plus an
  advisory character name. It never supplies organization, rank, or callsign —
  those always resolve from the LEOOS database (§1), so the choice of framework
  cannot affect authorization.
- The resource must degrade silently: if LEOOS is unreachable, the game server
  logs and continues. A dispatch outage must never affect gameplay.

---

## 9. Versioning

The resource sends `X-LEOOS-Protocol: 1`. The API supports the current and one
previous protocol version. On mismatch the handshake returns a structured upgrade
notice which the resource prints to the server console. Server operators do not
update resources promptly; the protocol must tolerate that.
