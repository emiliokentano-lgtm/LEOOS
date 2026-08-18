# 04 — FiveM Integration

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
- `secret` — 256-bit, shown **once** at creation, stored as an Argon2id hash.

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
3. Nonce unseen — stored in Redis with a 120 s TTL, `SET NX`.
4. `seq > game_server_state.last_ingest_seq` — monotonic replay protection that
   survives the nonce TTL window.
5. HMAC recomputed and compared in constant time.
6. Body validated against the Zod schema.

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
schema validation (Zod)
      ▼
sanity filters  ──── reject/flag ────▶ anomaly counter + audit
      ▼
identity resolution (game_identity → member → org, from DB)
      ▼
enrichment (callsign, unit, duty status, org colour — all from DB)
      ▼
Redis write (unit:live:*, TTL 45 s)
      ▼
downsampler (1 sample / 10 s) ─────▶ position_history
      ▼
delta computation ────────────────▶ realtime hub → map:units
```

**Sanity filters** — cheap, and they catch both bugs and spoofing:

| Check | Action on failure |
| --- | --- |
| Coordinates within GTA V world bounds (x −4000…4500, y −4500…8500, z −500…1500) | drop sample, increment anomaly counter |
| Implied speed between consecutive samples ≤ 200 m/s | flag as `teleport`, keep last good position, raise counter |
| Timestamp within skew window | drop batch |
| Player count ≤ configured slots | drop batch, alert |
| Same identifier appearing twice in one batch | drop batch as malformed |
| Unknown identifier | accept position, mark unit `unlinked`, do not attribute to any org |

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
| Player left | present in `departed[]`, or absent from telemetry for 2 consecutive ticks | unit removed from live map immediately |
| Player stale | Redis key TTL (45 s) expires | unit disappears even if the removal event was lost |
| Server offline | no heartbeat for 30 s | **all** units for that server marked offline, `admin:events` broadcast, dashboard banner |

The Redis TTL is the safety net that makes the whole thing self-healing: if the
API restarts, or a delete is missed, or the game server dies mid-tick, stale units
still expire on their own. Nothing has to remember to clean up.

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
├── config.lua              # non-secret defaults
├── server/
│   ├── main.lua            # tick loop, lifecycle
│   ├── collector.lua       # server-side natives → player snapshots
│   ├── transport.lua       # signing, PerformHttpRequest, retry queue
│   ├── hmac.lua            # HMAC-SHA256 (pure Lua or ox_lib crypto)
│   └── commands.lua        # applies commands from responses
└── client/
    └── claim.lua           # /leoos-link command only
```

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
- Framework adapters (`ESX`, `QBCore`, standalone) are isolated in
  `collector.lua` behind a single `getPlayerIdentity(src)` function. Only the
  identifier extraction differs between frameworks. **[CONFIRM] which framework.**
- The resource must degrade silently: if LEOOS is unreachable, the game server
  logs and continues. A dispatch outage must never affect gameplay.

---

## 9. Versioning

The resource sends `X-LEOOS-Protocol: 1`. The API supports the current and one
previous protocol version. On mismatch the handshake returns a structured upgrade
notice which the resource prints to the server console. Server operators do not
update resources promptly; the protocol must tolerate that.
