# leoos_bridge

Reports live unit positions and operational events from a FiveM server to a LEOOS
dispatch backend.

**No framework required.** The resource uses base FiveM natives and works on a
standalone server. ESX, QBCore and anything else are supported through an adapter
seam ([Adapters](#adapters)) — none is assumed, and none is needed.

---

## What it does, and what it deliberately does not

| Does | Does not |
| --- | --- |
| Reports where players are, from **server-side** natives | Accept a position from a game client |
| Sends one batched request for all players | Send one request per player |
| Reports a player's identifiers | Report their organization, rank, callsign or unit |
| Asks for a duty status change | Decide whether one is allowed |
| Raises a panic **request** | Decide whether a panic happens |

The second column is the trust model, and it is not a limitation to be worked
around. LEOOS treats the game server as a machine that is trusted to report
**where players are** and never trusted to report **who they are** in
organizational terms. Organization, rank, callsign and unit always resolve from
the LEOOS database by looking up the FiveM identifier. A compromised game server
can lie about coordinates — bounded and detectable — and cannot manufacture a
Chief of Police.

There is no field in the wire format for an organization. Not "ignored if
present": absent from the schema, so a payload carrying one is **rejected** and
the server operator finds out immediately rather than believing it works.

---

## Installation

**1. Copy the resource.**

```
cp -r leoos_bridge /path/to/your/server-data/resources/
```

**2. Register the game server in LEOOS.**

In the web app, as a user holding `admin.game_servers`:

- **Administration → Game servers → Register**, give it a key (`ls-main`) and a
  name.
- **Issue credential.** You are shown a `key_id` and a `secret`.

> **The secret is shown once.** There is no screen and no endpoint that can show
> it again — being unable to retrieve it is the property, not an oversight. If
> you lose it, revoke the credential and issue another; it takes seconds and
> leaves an audit trail.

**3. Configure `server.cfg`.**

```cfg
set leoos_url    "https://leoos.example.com"
set leoos_key_id "srv_0123456789abcdef"
set leoos_secret "the-secret-you-were-just-shown"

ensure leoos_bridge
```

**4. Restart and check the console.**

```
[leoos] starting — https://leoos.example.com, adapter "standalone", protocol 1
[leoos] linked to LEOOS as "ls-main" (telemetry 1000ms, heartbeat 10000ms)
[leoos] connected to LEOOS.
```

**5. Link a player.** Positions only appear for players linked to a LEOOS account
who are on duty in a unit. In the web app the user generates a six-character
code; in game they run:

```
/leoos-link ABC123
```

Both halves are required, which is what stops a player claiming somebody else's
identifier and an administrator silently attaching one to an account.

### Requirements

- FiveM server build 5848 or newer
- **Lua 5.4** (`lua54 'yes'`, already set in the manifest) — required for native
  bitwise operators and `string.pack`, both used by the SHA-256 implementation
- OneSync — needed for `GetEntityCoords` to be meaningful server-side
- Outbound HTTPS from the game host to the LEOOS API

**No inbound firewall rule is needed.** Every request is outbound; anything the
API wants to say comes back in a response body.

---

## Configuration

Everything is a convar, so nothing needs editing in a file a resource update
would replace. `config.lua` holds the defaults and their reasoning.

### Connection

| Convar | Default | Meaning |
| --- | --- | --- |
| `leoos_url` | `http://localhost:3001` | API base URL, no trailing slash |
| `leoos_key_id` | *(none)* | Public credential id. Safe to log |
| `leoos_secret` | *(none)* | **Never put this in a resource file** |
| `leoos_adapter` | `standalone` | `standalone`, a framework name, or `auto` |
| `leoos_debug` | `false` | Verbose per-request logging |

### Intervals

| Convar | Default | Meaning |
| --- | --- | --- |
| `leoos_telemetry_ms` | `1000` | Position interval. The API may override this at handshake |
| `leoos_heartbeat_ms` | `10000` | Heartbeat interval |

> Stop the heartbeat and **every unit this server reports goes offline within 30
> seconds**. That is the intended behaviour: a map showing units that are not
> really there is worse than a map showing none.

### Throttling

Positions are not sent every tick for every player. A player is included when
**any** of these is true:

- they have not been sent for `leoos_max_interval_ms` (the keep-alive)
- they moved more than `leoos_min_distance` metres
- their heading changed by more than `leoos_min_heading` degrees
- they got into or out of a vehicle

| Convar | Default | Meaning |
| --- | --- | --- |
| `leoos_throttle` | `smart` | `smart`, or `interval` to send everyone every tick |
| `leoos_min_distance` | `3` | Metres |
| `leoos_min_heading` | `10` | Degrees |
| `leoos_max_interval_ms` | `10000` | Keep-alive ceiling |

**`leoos_max_interval_ms` must stay well below 45 000.** That is the API's
position TTL; a stationary unit that is not re-sent inside it expires off the map
while still on duty. The default leaves four missed sends of headroom.

On a typical server most players are standing still, so a batch is a handful of
entries rather than everyone — and a parked server at 3am sends **nothing at
all** rather than one request a second.

### Features

Each can be disabled independently.

| Convar | Default | Disables |
| --- | --- | --- |
| `leoos_feature_telemetry` | `true` | Position reporting entirely |
| `leoos_feature_vehicles` | `true` | Vehicle model and plate |
| `leoos_feature_panic` | `true` | `/leoos-panic` |
| `leoos_feature_status` | `true` | `/leoos-status` |
| `leoos_feature_claim` | `true` | `/leoos-link` |
| `leoos_feature_commands` | `true` | Applying commands from API responses |

---

## Authentication

Every request is signed with **HMAC-SHA256**. The secret never travels on the
wire.

```
X-LEOOS-Key-Id:    srv_0123456789abcdef
X-LEOOS-Timestamp: 1755523200            (unix seconds)
X-LEOOS-Nonce:     <random, 22+ chars>
X-LEOOS-Seq:       184213                (strictly increasing per process)
X-LEOOS-Signature: hex(HMAC-SHA256(secret, canonical))
X-LEOOS-Protocol:  1

canonical = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" SEQ "\n" hex(sha256(body))
```

The **body hash** is signed rather than the body, so verification stays cheap on
a large batch while altering a single coordinate still breaks the signature.

The API verifies in this order, failing closed at each step, cheapest first so a
flood of forged requests is rejected before it reaches any real work:

1. all headers present and well-formed
2. protocol version supported
3. timestamp within ±60 s
4. `key_id` resolves to a live, unrevoked, unexpired credential
5. nonce unseen (replay inside the window)
6. `seq` strictly greater than the last accepted one (replay outside it)
7. HMAC recomputed and compared in constant time

> **An unknown key id and a bad signature give the identical answer.**
> Distinguishing them would make the endpoint an oracle for which key ids exist.

### Rotating a credential

Two credentials may be live at once, so rotation needs no downtime:

1. Issue the new credential in LEOOS.
2. Update `leoos_key_id` and `leoos_secret` in `server.cfg`, restart the resource.
3. Confirm traffic on the new `key_id` (its **last used** timestamp moves).
4. Revoke the old one.

A third live credential is refused — otherwise an abandoned key sits live forever
because nobody remembers which is in use.

---

## Endpoints

All under `/api/v1/fivem`, all signed. All are `POST`.

### `POST /handshake`

Called at resource start and again whenever the session is lost. Returns the
`sessionId` every other endpoint requires, plus the intervals the API wants —
which lets LEOOS reconfigure a resource it does not control.

```jsonc
// →
{ "resourceVersion": "1.0.0", "serverName": "…", "maxPlayers": 64, "adapter": "standalone" }
// ←
{ "ok": true, "sessionId": "…", "serverKey": "ls-main", "protocolVersion": 1,
  "telemetryIntervalMs": 1000, "heartbeatIntervalMs": 10000 }
```

### `POST /heartbeat`

Every 10 s. The only thing keeping this server's units on the map.

```jsonc
{ "sessionId": "…", "playerCount": 42, "uptimeSeconds": 3600, "resourceVersion": "1.0.0" }
```

### `POST /telemetry`

**One request for all players.** Per-player requests would mean 150 HTTP round
trips a second out of a Lua runtime that handles HTTP asynchronously and badly
under load.

```jsonc
{
  "sessionId": "…",
  "sentAt": 1755523200123,
  "players": [
    { "src": 12,
      "identifiers": { "license": "license:110000112345678" },
      "x": 421.7, "y": -981.2, "z": 30.7, "heading": 187.4, "speed": 22.4,
      "vehicle": { "model": "police3", "plate": "12ABC345" } }
  ],
  "departed": ["license:110000187654321"]
}
```

Note what is **not** in a player entry: organization, rank, callsign, unit,
permissions. Sending any of them is a `400`.

### `POST /events`

Discrete occurrences — `player.connected`, `player.dropped`, `player.panic`,
`player.status_requested`. Separate from telemetry so a panic is never lost to
coalescing, and the only payloads the resource retries.

### `POST /identity/claim`

Links a FiveM identifier to a LEOOS account, using a code generated in the web
app. Single use, five-minute TTL, rate limited.

### Command channel

Ingest responses may carry commands, so the API can act without the game host
exposing an inbound endpoint:

```jsonc
{ "ok": true, "nextIntervalMs": 1000,
  "commands": [ { "id": "c_01", "type": "notify", "target": "license:ab…",
                  "payload": { "title": "Dispatch", "body": "Assigned to 2026-08-000431" } } ] }
```

**At most once.** A command that fails to apply is not retried: a duplicated
in-game popup is worse than a missed one, and anything that must not be lost
belongs in the web UI where it can be acknowledged. The command set is
deliberately tiny and cannot move, kick or charge a player — a dispatch backend
should not become a way to grief a game server.

---

## In-game commands

| Command | Who | What it does |
| --- | --- | --- |
| `/leoos-link <code>` | player | Links their FiveM identity to a LEOOS account |
| `/leoos-panic` | player | **Requests** a panic alert |
| `/leoos-status <key>` | player | **Requests** a duty status change |
| `leoos-status-report` | console | Prints bridge diagnostics. Never prints the secret |

`/leoos-panic` and `/leoos-status` **request**; they do not decide. LEOOS
authorizes each against the player's real permissions, exactly as it would the
same request from a browser, and can refuse.

---

## Required FiveM permissions

The resource needs no ACE permissions of its own. What it does need:

| Requirement | Why |
| --- | --- |
| **Server-side execution** | Positions come from server natives; a client script could be modded |
| **OneSync enabled** | Without it, server-side `GetEntityCoords` is not meaningful |
| **Outbound HTTPS** | `PerformHttpRequest` to your LEOOS host |
| **`sv_maxclients` readable** | Reported at handshake. Advisory only |

Player-facing commands are registered with `RegisterCommand(..., false)` — **not
restricted**, deliberately: `/leoos-panic` must work for anyone, and the moment
somebody needs it is the worst possible moment to discover they lack an ACE. The
console-only `leoos-status-report` is registered restricted.

If you want to gate the commands anyway, add ACEs in `server.cfg` and change the
final argument to `true`.

---

## Troubleshooting

Turn on `set leoos_debug "true"` and run `leoos-status-report` in the console
first — between them they answer most of these.

### `NOT CONFIGURED` at start-up

`leoos_key_id` or `leoos_secret` is empty. Both go in `server.cfg`, not in
`config.lua`.

### `FATAL: crypto self-check failed`

The SHA-256/HMAC implementation produced the wrong answer for a published test
vector. Almost always Lua 5.3 or older — check `lua54 'yes'` in the manifest and
that your server build honours it. The resource refuses to start rather than
sending signatures that will be rejected for reasons nobody can diagnose.

### `Request could not be authenticated` (401)

One of: wrong `leoos_key_id`, wrong `leoos_secret`, or a revoked credential. The
API deliberately does not say which. Check the credential's **last used**
timestamp in LEOOS — if it never moves, the request is not reaching a valid key.

### `Request timestamp is outside the 60s window` (401)

The game host's clock is wrong. Fix NTP on the host; do not widen the window.

### `Request sequence is not ahead of the last accepted one` (409)

Two requests overtook each other, or the host's clock went backwards far enough
that the counter — seeded from `os.time()` — restarted behind where the previous
run finished. The resource re-handshakes on its own within one heartbeat and
recovers: the handshake is the one request allowed to establish the sequence
rather than continue it, which is exactly so that a restart is survivable.

If it repeats continuously, two resources are sharing one credential and are
overwriting each other's high-water mark. Issue each its own.

### `This credential cannot be verified by the API` (503)

The API has no encryption key configured (`LEOOS_FIVEM_SECRET_KEY`), or the
credential predates it. Issue a new credential.

### `426` with an upgrade notice

The API no longer speaks this resource's protocol version. Update the resource.

### Positions are accepted but nothing appears on the map

Check, in order:

1. **Is the player linked?** The response's `accepted` count is 0 for unlinked
   players. Run `/leoos-link`.
2. **Are they on duty in a unit?** LEOOS maps **units**, not people. A linked
   officer standing in the lobby is a person the system knows about and is not a
   unit.
3. **Is their membership active?** A terminated member stops appearing
   immediately — that is deliberate.

### Units vanish after ~45 seconds

Telemetry stopped, or `leoos_max_interval_ms` is set above the API's position
TTL. Lower it.

### All units vanish at once

The heartbeat stopped. LEOOS marked this server offline and took its units — and
only its units — with it. Check outbound connectivity from the game host.

### The console fills with failure messages

It should not: a failure is logged **once** per outage, not once per request.
If you are seeing a stream, `leoos_debug` is on.

---

## Design notes

Things that look like they could be simpler, and the reason they are not.

**One telemetry request in flight at a time.** `PerformHttpRequest` is
asynchronous with no timeout guarantee. If the previous request has not returned
when the next tick fires, the tick is **skipped** rather than queued —
overlapping requests reorder positions and amplify load during exactly the
moments the network is already struggling.

**Telemetry is never retried.** A one-second-old position is worthless, and
retrying it turns a blip into a thundering herd while delivering stale data.
Events *are* retried, in a queue bounded at 30 entries, because a panic must not
be lost. Past 30 the oldest is dropped: an unbounded queue during a long outage
is a memory leak that ends with the game server rather than with the dispatch
system.

**Backoff is jittered.** 1 s → 30 s, with ±30% noise. Without the jitter every
client reconnects on the same schedule after an outage, which is a self-inflicted
thundering herd at the moment the backend is least able to absorb one.

**Every loop is wrapped in `pcall`.** A LEOOS outage must never affect gameplay,
and a thread that dies takes every unit silently stale with it.

**SHA-256 is hand-written.** FiveM ships no crypto primitives. The alternatives
were a hard dependency on somebody else's resource for one function, or a process
spawn per request. Roughly 90 lines, verified at start-up against the published
FIPS 180-4 and RFC 4231 vectors.

---

## Adapters

An adapter answers two questions and no others:

```lua
---@class LeoosAdapter
---@field name              string
---@field detect            fun(): boolean
---@field getIdentity       fun(src: number): table<string, string>
---@field getCharacterName  fun(src: number): string|nil
```

That is the entire framework surface of this resource. **No adapter may supply an
organization, rank, callsign, unit or permission** — those always resolve from
the LEOOS database, so the choice of framework cannot affect authorization.

To add one, create `server/adapters/<name>.lua`, register it, and add it to the
manifest:

```lua
LeoosAdapters = LeoosAdapters or {}
LeoosAdapters.myframework = {
  name = 'myframework',
  detect = function() return GetResourceState('myframework') == 'started' end,
  getIdentity = function(src) return { license = GetPlayerIdentifierByType(src, 'license') } end,
  getCharacterName = function(src) return exports.myframework:getCharacterName(src) end,
}
```

Then `set leoos_adapter "myframework"`. Nothing outside `server/adapters/` may
reference a framework global, and nothing else in the resource needs to change.

---

## Reference

- Trust model, ingest pipeline, offline detection —
  [`docs/architecture/04-fivem-integration.md`](../../docs/architecture/04-fivem-integration.md)
- Wire types — [`packages/contracts/src/fivem.ts`](../../packages/contracts/src/fivem.ts)
- Server implementation — [`apps/api/src/modules/fivem/`](../../apps/api/src/modules/fivem/)
- Tests — [`apps/api/test/fivem.test.ts`](../../apps/api/test/fivem.test.ts)
