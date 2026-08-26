--[[===========================================================================
  Lifecycle.

  Three loops, each with its own interval and its own failure behaviour:

    HANDSHAKE   once at start, and again whenever the session is lost. Everything
                else waits for it, because the session id it returns is required
                by every other endpoint.
    TELEMETRY   positions, at the interval the API asks for. Never retried.
    HEARTBEAT   proof of life. This is the ONLY thing keeping units on the map:
                stop it and every unit this server reports goes offline in 30 s.

  THE RESOURCE MUST NEVER AFFECT GAMEPLAY. Every loop is wrapped so a failure
  logs and continues; there is no path from a LEOOS outage to a game-server
  error. That is the single most important property of this file.
===========================================================================]]

local started = false
local sessionReady = false
local telemetryIntervalMs = Config.telemetryIntervalMs
local heartbeatIntervalMs = Config.heartbeatIntervalMs
local startedAt = os.time()

local function log(message)
  print('[leoos] ' .. message)
end

local function debug(message)
  if Config.debug then print('[leoos:debug] ' .. message) end
end

--[[===========================================================================
  SELF-CHECK

  SHA-256 and HMAC are hand-written here (see server/sha2.lua for why), and a
  subtly wrong hash does not error — it produces a signature the API rejects,
  which presents as "authentication is broken" and sends an operator hunting
  through their credentials rather than their Lua.

  So the published test vectors run at start-up. It costs a millisecond once, and
  it turns a class of silent, misattributed failure into one clear line.
===========================================================================]]
local function selfCheck()
  local checks = {
    {
      name = 'sha256("abc")',
      got = Sha2.hexDigest('abc'),
      want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
    {
      name = 'sha256("")',
      got = Sha2.hexDigest(''),
      want = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    {
      -- Crosses the 64-byte block boundary, which is where padding bugs live.
      name = 'sha256(long)',
      got = Sha2.hexDigest(
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'
      ),
      want = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    },
    {
      -- RFC 4231 test case 2.
      name = 'hmac-sha256(Jefe)',
      got = Hmac.sha256Hex('Jefe', 'what do ya want for nothing?'),
      want = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    },
  }

  for _, check in ipairs(checks) do
    if check.got ~= check.want then
      log('FATAL: crypto self-check failed for ' .. check.name)
      log('  expected ' .. check.want)
      log('  got      ' .. check.got)
      log('  This build cannot sign requests correctly. Refusing to start.')
      return false
    end
  end

  debug('crypto self-check passed')
  return true
end

--[[===========================================================================
  Handshake
===========================================================================]]
local function handshake()
  Transport.send('/api/v1/fivem/handshake', {
    resourceVersion = Config.resourceVersion,
    serverName = GetConvar('sv_hostname', 'unnamed'),
    maxPlayers = GetConvarInt('sv_maxclients', 32),
    adapter = Adapter.name,
  }, function(ok, status, _body, decoded)
    if not ok then
      -- No special handling: the transport already recorded the failure and set
      -- the backoff, and the loop below will try again when it expires.
      debug(('handshake failed (%s)'):format(tostring(status)))
      return
    end

    if decoded == nil or decoded.sessionId == nil then
      log('handshake returned no session id — is leoos_url pointing at a LEOOS API?')
      return
    end

    Transport.setSession(decoded.sessionId)
    sessionReady = true

    -- A new session means the API's picture starts empty, so the throttle's
    -- memory is cleared and the next batch is a complete one.
    Collector.reset()

    if decoded.telemetryIntervalMs then telemetryIntervalMs = decoded.telemetryIntervalMs end
    if decoded.heartbeatIntervalMs then heartbeatIntervalMs = decoded.heartbeatIntervalMs end

    log(('linked to LEOOS as "%s" (telemetry %dms, heartbeat %dms)')
      :format(tostring(decoded.serverKey), telemetryIntervalMs, heartbeatIntervalMs))

    -- Printed prominently, not buried in debug. A server operator running an
    -- old resource against a newer API should be told, once, every start-up.
    if decoded.upgradeNotice then log('NOTICE: ' .. decoded.upgradeNotice) end
  end)
end

--- Called by the transport when the API stops recognising our session.
Transport.onSessionLost = function()
  if not sessionReady then return end
  sessionReady = false
  Transport.setSession(nil)
  log('session lost — re-running the handshake.')
end

Transport.onIntervalChanged = function(intervalMs)
  if intervalMs ~= telemetryIntervalMs and intervalMs >= 250 then
    log(('the API asked for a %dms telemetry interval.'):format(intervalMs))
    telemetryIntervalMs = intervalMs
  end
end

--[[
  The API had more commands waiting than fitted in one batch.

  Drained on a short timer rather than in-line, because the response we are
  handling has not finished being processed yet and the transport allows one
  telemetry request in flight. A heartbeat is the cheap way to ask again: it
  carries almost nothing and every response drains the queue.

  Bounded by the transport's own backoff, so a queue that somehow never empties
  cannot become a request loop.
]]
Transport.onCommandsPending = function()
  if not sessionReady then return end
  SetTimeout(250, function()
    if not sessionReady then return end
    Transport.send('/api/v1/fivem/heartbeat', {
      sessionId = Transport.sessionId(),
      playerCount = #GetPlayers(),
      uptimeSeconds = os.time() - startedAt,
      resourceVersion = Config.resourceVersion,
    }, function(ok, _, _, decoded)
      if ok and decoded then Transport.applyResponse(decoded) end
    end)
  end)
end

--[[===========================================================================
  Loops
===========================================================================]]
local function telemetryLoop()
  Citizen.CreateThread(function()
    while true do
      Citizen.Wait(telemetryIntervalMs)

      -- `pcall` around the whole tick. A bug in collection must not stop the
      -- thread, because a stopped thread means every unit silently goes stale.
      local ok, err = pcall(function()
        if not Config.features.telemetry then return end
        if not sessionReady then return end

        local now = GetGameTimer()
        local players, departed, reasons = Collector.collect(now)

        -- Nothing changed and nobody left: send nothing at all. A parked server
        -- at 3am costs zero requests rather than one a second.
        if #players == 0 and #departed == 0 then
          debug('nothing to send')
          return
        end

        if Config.debug then
          local parts = {}
          for identifier, reason in pairs(reasons) do
            parts[#parts + 1] = ('%s=%s'):format(identifier:sub(1, 16), reason)
          end
          debug(('telemetry: %d player(s), %d departed [%s]')
            :format(#players, #departed, table.concat(parts, ' ')))
        end

        Transport.sendTelemetry({
          sessionId = Transport.sessionId(),
          sentAt = math.floor(os.time() * 1000),
          players = players,
          departed = departed,
        }, now)
      end)

      if not ok then log('telemetry tick failed: ' .. tostring(err)) end
    end
  end)
end

local function heartbeatLoop()
  Citizen.CreateThread(function()
    while true do
      Citizen.Wait(heartbeatIntervalMs)

      local ok, err = pcall(function()
        local now = GetGameTimer()

        -- No session yet, or lost: this loop is what re-establishes it, so the
        -- resource recovers from a backend outage on its own with no operator
        -- action and no resource restart.
        if not sessionReady then
          if Transport.mayAttempt(now) then handshake() end
          return
        end

        Transport.send('/api/v1/fivem/heartbeat', {
          sessionId = Transport.sessionId(),
          playerCount = #GetPlayers(),
          uptimeSeconds = os.time() - startedAt,
          resourceVersion = Config.resourceVersion,
        }, function(ok, status, _, decoded)
          if status == 409 or status == 400 then Transport.onSessionLost() end
          -- The heartbeat is the ONLY guaranteed periodic request. With
          -- telemetry disabled it is the entire command channel, which is why
          -- it applies the response rather than only checking the status.
          if ok and decoded then Transport.applyResponse(decoded) end
        end)

        Transport.flushEvents(now)
      end)

      if not ok then log('heartbeat tick failed: ' .. tostring(err)) end
    end
  end)
end

--[[===========================================================================
  Player lifecycle events
===========================================================================]]
AddEventHandler('playerDropped', function()
  local src = source
  local identifiers = Adapter.getIdentity(src)
  if identifiers == nil then return end

  local identifier = identifiers.license or identifiers.license2 or identifiers.steam
  if identifier == nil then return end

  Collector.forget(identifier)
  Transport.queueEvent({
    kind = 'player.dropped',
    at = math.floor(os.time() * 1000),
    identifiers = identifiers,
    src = tonumber(src),
  })
end)

--[[===========================================================================
  In-game commands

  Every one of these REQUESTS something. None of them decides anything: the API
  authorizes each against the player's real permissions, exactly as it would the
  same request from a browser, and can refuse. `/leoos-panic` in particular does
  not make a panic happen — it asks, and the answer comes from the database.
===========================================================================]]
--[[
  Is this player dead or dying, as THIS SERVER sees it?

  ────────────────────────────────────────────────────────────────────────────
  THE SECOND OF THREE LAYERS

  `client/keybinds.lua` refuses locally so the player gets an instant answer.
  That check is a courtesy and nothing more — a modded client is precisely what
  it cannot stop, and a resource that trusted it would be trusting the client to
  decide whether it may raise an alarm.

  So the server asks again, with a server-side native against its own entity
  state, and LEOOS asks a third time against what this server last reported.
  Each layer catches what the one before it cannot.

  Base natives only, so this works standalone. A framework that holds a downed
  player at positive health knows better than `GetEntityHealth` does, and an
  adapter can say so — see `Adapter.isDown`.
]]
local function playerIsDown(src)
  if Adapter.isDown ~= nil then
    local ok, result = pcall(Adapter.isDown, src)
    if ok and result ~= nil then return result == true end
  end

  local ped = GetPlayerPed(src)
  if ped == 0 then
    -- No ped is not the same as dead. A player mid-spawn has none, and
    -- refusing them would mean a panic button that silently fails on join.
    return false
  end
  return GetEntityHealth(ped) <= 0
end

--[[
  One panic path, reached by a keybind and by the slash command alike.

  Written once so the two entry points cannot drift — the liveness check, the
  coordinates, the immediate flush and the confirmation all live here.
]]
local function raisePanic(src)
  local identifiers = Adapter.getIdentity(src)
  if identifiers == nil or next(identifiers) == nil then return end

  if playerIsDown(src) then
    --[[
      Told, not ignored.

      Silence is the wrong answer to a pressed panic button under any
      circumstance: a player who hears nothing back has every reason to believe
      help is coming. This is also the layer that catches a client which skipped
      its own check, so the message has to exist here and not only there.
    ]]
    TriggerClientEvent('leoos:notify', src, {
      title = 'Panic not sent',
      body = 'You are down. Dispatch was not alerted.',
      tone = 'danger',
    })
    return
  end

  local ped = GetPlayerPed(src)
  local coords = ped ~= 0 and GetEntityCoords(ped) or nil

  Transport.queueEvent({
    kind = 'player.panic',
    at = math.floor(os.time() * 1000),
    identifiers = identifiers,
    src = tonumber(src),
    x = coords and math.floor(coords.x * 10 + 0.5) / 10 or nil,
    y = coords and math.floor(coords.y * 10 + 0.5) / 10 or nil,
    -- Liveness AT THE MOMENT OF THE PRESS. Telemetry is throttled, so its last
    -- sample can be seconds old, and seconds are exactly the window in which
    -- somebody dies. LEOOS prefers this value over its own stored one.
    down = false,
  })

  -- Flushed IMMEDIATELY rather than on the next heartbeat. Ten seconds is a
  -- long time when somebody has pressed a panic button.
  Transport.flushEvents(GetGameTimer())

  --[[
    "Sent to dispatch" would be a claim this resource cannot make.

    The event has been queued and a flush attempted; whether LEOOS accepts it
    depends on the player's membership and permissions, and the answer arrives
    later or not at all. The alert the OTHER units see is the real confirmation,
    and it does not come from here.
  ]]
  TriggerClientEvent('leoos:notify', src, {
    title = 'Panic',
    body = 'Alert sent. Dispatch decides what happens next.',
    tone = 'danger',
  })
end

if Config.features.panic then
  RegisterCommand('leoos-panic', function(src)
    if src == 0 then
      print('[leoos] /leoos-panic must be run by a player, not from the console.')
      return
    end
    raisePanic(src)
  end, false)

  --[[
    The keybind's server half.

    The event carries NOTHING. `source` is set by the FiveM runtime and cannot be
    forged by the client, and everything else — identity, position, liveness —
    is read here from natives the client has no way to influence. An event that
    accepted a position, or a liveness flag, would be a client deciding both.
  ]]
  RegisterNetEvent('leoos:keybind:panic', function()
    local src = source
    if src == nil or src == 0 then return end
    raisePanic(src)
  end)
end

--[[===========================================================================
  Field requests: asking for backup, and sharing where you are.

  Same shape as panic, and for the same reasons: the event carries nothing the
  client chose, the position comes from a server native, and LEOOS decides
  whether anything happens.
===========================================================================]]
if Config.features.fieldRequests then
  local function raiseFieldRequest(src, kind, requiresAlive)
    local identifiers = Adapter.getIdentity(src)
    if identifiers == nil or next(identifiers) == nil then return end

    if requiresAlive and playerIsDown(src) then
      TriggerClientEvent('leoos:notify', src, {
        title = 'Not sent',
        body = 'You are down. Try sharing your location instead.',
        tone = 'danger',
      })
      return
    end

    local ped = GetPlayerPed(src)
    local coords = ped ~= 0 and GetEntityCoords(ped) or nil

    Transport.queueEvent({
      kind = kind,
      at = math.floor(os.time() * 1000),
      identifiers = identifiers,
      src = tonumber(src),
      x = coords and math.floor(coords.x * 10 + 0.5) / 10 or nil,
      y = coords and math.floor(coords.y * 10 + 0.5) / 10 or nil,
      down = requiresAlive and false or nil,
    })
    Transport.flushEvents(GetGameTimer())
  end

  RegisterNetEvent('leoos:keybind:backup', function()
    local src = source
    if src == nil or src == 0 then return end
    raiseFieldRequest(src, 'player.backup_requested', true)
    TriggerClientEvent('leoos:notify', src, {
      title = 'Backup',
      body = 'Request sent. Dispatch decides who responds.',
      tone = 'warning',
    })
  end)

  RegisterNetEvent('leoos:keybind:share_location', function()
    local src = source
    if src == nil or src == 0 then return end
    -- NOT gated on being alive: sharing where you are while down is exactly
    -- when it matters most, because it is how somebody finds you.
    raiseFieldRequest(src, 'player.location_shared', false)
    TriggerClientEvent('leoos:notify', src, {
      title = 'Location',
      body = 'Shared with your organization.',
      tone = 'info',
    })
  end)

  --[[
    Answering a prompt.

    The id came from the API, travelled to the client in a prompt, and comes
    back here. It is NOT trusted: LEOOS looks it up and checks it against the
    responder's own live membership, so a client that invents one, or replays
    somebody else's, is refused by the same check a browser would hit.

    Bounded before it is queued, because an unbounded string from a client is an
    allocation somebody else chooses the size of.
  ]]
  RegisterNetEvent('leoos:keybind:respond', function(fieldRequestId, action)
    local src = source
    if src == nil or src == 0 then return end
    if type(fieldRequestId) ~= 'string' or #fieldRequestId ~= 36 then return end
    if action ~= 'accept' and action ~= 'decline' then return end

    local identifiers = Adapter.getIdentity(src)
    if identifiers == nil or next(identifiers) == nil then return end

    Transport.queueEvent({
      kind = action == 'accept' and 'player.request_accepted' or 'player.request_declined',
      at = math.floor(os.time() * 1000),
      identifiers = identifiers,
      src = tonumber(src),
      fieldRequestId = fieldRequestId,
    })
    Transport.flushEvents(GetGameTimer())
  end)
end

if Config.features.statusCommands then
  RegisterCommand('leoos-status', function(src, args)
    if src == 0 or args[1] == nil then return end

    local identifiers = Adapter.getIdentity(src)
    if identifiers == nil or next(identifiers) == nil then return end

    Transport.queueEvent({
      kind = 'player.status_requested',
      at = math.floor(os.time() * 1000),
      identifiers = identifiers,
      src = tonumber(src),
      -- Sent as typed and validated server-side. A status this player may not
      -- set, or one that does not exist, is refused by the API.
      statusKey = tostring(args[1]):lower():sub(1, 60),
    })
    Transport.flushEvents(GetGameTimer())
  end, false)
end

if Config.features.identityClaim then
  --[[
    Identity linking, PROVEN FROM BOTH SIDES.

    The player generates a code in the web app while signed in, then types it
    here. Neither half alone is enough, which is what stops a player claiming
    somebody else's identifier and an administrator silently attaching one to an
    account.

    Sent directly rather than queued: the player is standing there waiting for an
    answer, and the answer comes back in the response.
  ]]
  RegisterCommand('leoos-link', function(src, args)
    if src == 0 then return end

    local code = args[1]
    if code == nil or #tostring(code) ~= 6 then
      TriggerClientEvent('leoos:notify', src, {
        title = 'LEOOS',
        body = 'Usage: /leoos-link <6-character code from the web app>',
        tone = 'warning',
      })
      return
    end

    Transport.send('/api/v1/fivem/identity/claim', {
      identifiers = Adapter.getIdentity(src),
      code = tostring(code):upper(),
      src = tonumber(src),
    }, function(ok, _, _, decoded)
      TriggerClientEvent('leoos:notify', src, {
        title = 'LEOOS',
        body = (ok and decoded and decoded.message)
          or 'Could not reach LEOOS. Try again shortly.',
        tone = (ok and decoded and decoded.ok) and 'success' or 'warning',
      })
    end)
  end, false)
end

--- Diagnostics, for the server console. Never exposes the secret.
RegisterCommand('leoos-status-report', function(src)
  if src ~= 0 then return end
  print('[leoos] ─── bridge status ───────────────────────────────')
  print(('  url          %s'):format(Config.url))
  print(('  key id       %s'):format(Config.keyId ~= '' and Config.keyId or '(not set)'))
  print(('  secret       %s'):format(Config.keyId ~= '' and '(configured)' or '(NOT SET)'))
  print(('  adapter      %s'):format(Adapter and Adapter.name or '(none)'))
  print(('  session      %s'):format(Transport.sessionId() or '(none — not handshaken)'))
  print(('  backend      %s'):format(Transport.isHealthy() and 'reachable' or 'UNREACHABLE'))
  print(('  telemetry    every %dms (%s)')
    :format(telemetryIntervalMs, Config.features.telemetry and 'enabled' or 'disabled'))
  print(('  heartbeat    every %dms'):format(heartbeatIntervalMs))
  print(('  tracked      %d player(s)'):format(Collector.trackedCount()))
  print(('  queued       %d event(s)'):format(Transport.queueDepth()))
  print('[leoos] ──────────────────────────────────────────────────')
end, true)

--[[===========================================================================
  Start-up
===========================================================================]]
AddEventHandler('onResourceStart', function(resourceName)
  if GetCurrentResourceName() ~= resourceName then return end
  if started then return end
  started = true

  if not selfCheck() then return end

  Leoos.initAdapter()

  --[[
    The secret is read from a CONVAR, never from a resource file.

    Server-side files are not sent to clients, but they do end up in version
    control and in the zip somebody emails a colleague. `GetConvar` keeps the
    secret in server.cfg, which operators already treat as sensitive.
  ]]
  local secret = GetConvar('leoos_secret', '')
  if secret == '' or Config.keyId == '' then
    log('NOT CONFIGURED. Add to server.cfg:')
    log('    set leoos_url    "https://leoos.example.com"')
    log('    set leoos_key_id "srv_..."')
    log('    set leoos_secret "..."')
    log('Issue a credential in LEOOS under Administration → Game servers.')
    return
  end

  Transport.configure(secret)
  log(('starting — %s, adapter "%s", protocol %d')
    :format(Config.url, Adapter.name, Config.protocolVersion))

  handshake()
  telemetryLoop()
  heartbeatLoop()
end)

AddEventHandler('onResourceStop', function(resourceName)
  if GetCurrentResourceName() ~= resourceName then return end
  -- Nothing to clean up remotely: the API notices the missing heartbeat within
  -- 30 seconds and takes this server's units offline on its own. Self-healing
  -- beats a shutdown message that a crashed process could never send.
  log('stopping — LEOOS will mark this server offline within 30s.')
end)
