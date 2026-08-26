--[[===========================================================================
  LEOOS bridge — configuration

  NOTHING SECRET LIVES IN THIS FILE, and that is enforced rather than requested:
  the secret is read from a convar at start-up and this file is never consulted
  for it. Server-side resource files are not sent to game clients, but they DO
  end up in version control, in backups, and in the zip somebody emails to a
  colleague — which is how shared secrets leak in practice.

  Put this in your server.cfg instead:

      set leoos_url    "https://leoos.example.com"
      set leoos_key_id "srv_0123456789abcdef"
      set leoos_secret "the-secret-shown-once-when-you-issued-the-credential"

  Every value below can also be overridden by a convar, so a server operator can
  tune the resource without editing a file that a resource update would replace.
===========================================================================]]

Config = {}

--- Where the LEOOS API lives. No trailing slash.
Config.url = GetConvar('leoos_url', 'http://localhost:3001')

--- Public credential identifier. Safe to log; identifies which secret to verify.
Config.keyId = GetConvar('leoos_key_id', '')

--[[
  How often a full player snapshot is sent, in milliseconds.

  The API tells us what it wants at handshake and that answer wins — this is the
  value used before the first handshake completes, and the fallback if the API
  never answers. One second is the map's nominal rate.
]]
Config.telemetryIntervalMs = GetConvarInt('leoos_telemetry_ms', 1000)

--- How often a heartbeat is sent. Stop these and every unit goes offline in 30s.
Config.heartbeatIntervalMs = GetConvarInt('leoos_heartbeat_ms', 10000)

--[[===========================================================================
  THROTTLING — the reason this resource is not a `while true do` loop.

  A naive bridge sends every player's position on every tick. At 1 Hz with 150
  players that is 150 positions a second whether or not anybody moved, and on a
  server where most players are standing in a menu it is almost entirely noise.

  So a player is included in a batch when ANY of these is true:

    · they have not been sent for `maxIntervalMs`   — the keep-alive, so a
      stationary unit still proves it is there and does not go stale
    · they have moved more than `minDistance` metres
    · their heading has changed by more than `minHeadingDelta` degrees
    · their vehicle or their in-vehicle state changed

  Set `strategy` to 'interval' to disable the movement tests and send everyone
  every tick — useful when debugging, wasteful otherwise.
===========================================================================]]
Config.throttle = {
  --- 'smart' (default) or 'interval'.
  strategy = GetConvar('leoos_throttle', 'smart'),

  --- Metres. Below GTA's own network cull distance, so movement worth drawing.
  minDistance = GetConvarInt('leoos_min_distance', 3),

  --- Degrees. A car changing lanes turns more than this; idling does not.
  minHeadingDelta = GetConvarInt('leoos_min_heading', 10),

  --[[
    The keep-alive ceiling, in milliseconds.

    MUST stay below the API's position TTL (45 s) with room to spare, or a
    stationary unit expires and vanishes from the map while still on duty. 10 s
    leaves four missed sends of headroom.
  ]]
  maxIntervalMs = GetConvarInt('leoos_max_interval_ms', 10000),
}

--[[===========================================================================
  FEATURES

  Each can be turned off independently. A server that wants positions but not
  in-game panic, or vice versa, should not have to fork the resource.
===========================================================================]]
Config.features = {
  --- Send position telemetry at all. Off makes this a heartbeat-only resource.
  telemetry = GetConvar('leoos_feature_telemetry', 'true') == 'true',

  --- Report vehicle model and plate alongside position.
  vehicles = GetConvar('leoos_feature_vehicles', 'true') == 'true',

  --[[
    The panic button: the `/leoos-panic` command, the keybind, and the event.

    Turning it off removes the keybind entirely rather than leaving a bound key
    that does nothing — an unresponsive panic button is worse than an absent
    one, because a player will press it and believe help is coming.
  ]]
  panic = GetConvar('leoos_feature_panic', 'true') == 'true',

  --- The /leoos-status command, which REQUESTS a duty status change.
  statusCommands = GetConvar('leoos_feature_status', 'true') == 'true',

  --[[
    Backup requests and location sharing, and the prompts that answer them.

    Off removes the keybinds entirely rather than leaving bound keys that do
    nothing — a player who presses an unresponsive backup key believes help is
    coming.
  ]]
  fieldRequests = GetConvar('leoos_feature_field_requests', 'true') == 'true',

  --- The /leoos-link command that binds a FiveM identity to a LEOOS account.
  identityClaim = GetConvar('leoos_feature_claim', 'true') == 'true',

  --[[
    Apply commands the API returns — notifications and waypoints.

    This is the ONLY path from LEOOS into the game. Turned off, the resource
    still reports everything it always did and the game simply stops hearing
    back: no dispatch popups, no waypoints. See
    docs/architecture/04-fivem-integration.md §7 for why the direction works
    this way at all.
  ]]
  commands = GetConvar('leoos_feature_commands', 'true') == 'true',
}

--[[===========================================================================
  KEYBINDS

  Defaults only. Every binding is registered through FiveM's own
  `RegisterKeyMapping`, so a player rebinds it in Settings → Key Bindings →
  FiveM and their choice persists — it is stored by the game client, survives a
  resource restart, and is not overridden by the values here.

  There is deliberately NO in-game rebinding menu of our own. One would be a
  second store of bindings, a second place for them to disagree, and a screen
  the player has to discover, in order to reimplement one they already know.
===========================================================================]]
Config.keys = {
  --- Raise a panic alert. Refused while the player is down.
  panic = GetConvar('leoos_key_panic', 'F7'),

  --- Ask nearby colleagues for backup.
  backup = GetConvar('leoos_key_backup', 'F8'),

  --- Broadcast your position to your organization.
  shareLocation = GetConvar('leoos_key_share', 'F9'),

  --[[
    Answering a prompt.

    E and G because they are the keys a FiveM player already has muscle memory
    for accepting and refusing. They do NOTHING when no prompt is on screen —
    binding a common interaction key to a no-op would otherwise make it feel
    broken everywhere else.
  ]]
  accept = GetConvar('leoos_key_accept', 'E'),
  dismiss = GetConvar('leoos_key_dismiss', 'G'),
}

--[[
  Debug mode.

  Logs every request and its outcome to the server console. Deliberately verbose
  and deliberately OFF by default — a 1 Hz request log fills a console fast, and
  a full console is a console nobody reads.

  It NEVER logs the secret, the signature, or a claim code. Debug mode that leaks
  a credential is worse than no debug mode.
]]
Config.debug = GetConvar('leoos_debug', 'false') == 'true'

--[[
  Which adapter supplies character identity.

  'standalone' uses base FiveM natives only and works on any server. Set to a
  framework name once an adapter for it exists; 'auto' detects and logs its
  choice. NO FRAMEWORK IS ASSUMED — see server/adapters/init.lua.
]]
Config.adapter = GetConvar('leoos_adapter', 'standalone')

--- Reconnect backoff, milliseconds. Jitter is applied on top.
Config.backoff = {
  baseMs = 1000,
  maxMs = 30000,
}

--- Bounded so a long outage cannot grow the queue without limit.
Config.maxQueuedEvents = 30

Config.protocolVersion = 1
Config.resourceVersion = '1.0.0'
