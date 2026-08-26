--[[===========================================================================
  Collecting player state.

  EVERY COORDINATE HERE COMES FROM A SERVER-SIDE NATIVE. `GetEntityCoords` and
  `GetEntityHeading` called on the server read the server's own entity state, not
  something a client reported. A modded client can do many things; it cannot make
  the server believe a ped is somewhere it is not.

  That is not a detail — it is the reason a browser is never allowed to submit a
  unit position either. There is exactly one authority for where a unit is, and
  it is the game server's entity state.

  ────────────────────────────────────────────────────────────────────────────
  THROTTLING lives here rather than in the transport, because the decision is
  per player and the transport deals in batches. A player is included when
  something about them actually changed, or when their keep-alive is due. On a
  server where most players are standing still, a typical batch is a handful of
  entries rather than everyone.
  ────────────────────────────────────────────────────────────────────────────
]]

Collector = {}

--- Last state sent per player, keyed by identifier. The throttle's whole memory.
local lastSent = {}

--- Identifiers seen in the previous sweep, so departures can be reported.
local previousOnline = {}

local function distance2d(x1, y1, x2, y2)
  local dx, dy = x1 - x2, y1 - y2
  return math.sqrt(dx * dx + dy * dy)
end

--- Shortest angular difference, so 350° → 10° reads as 20 rather than 340.
local function headingDelta(a, b)
  local diff = math.abs((a - b) % 360)
  if diff > 180 then diff = 360 - diff end
  return diff
end

--[[
  Should this player be in the batch?

  Returns true plus a reason, so debug mode can say WHY a player was included —
  which is the difference between tuning the throttle and guessing at it.
]]
local function shouldSend(identifier, snapshot, now)
  if Config.throttle.strategy ~= 'smart' then return true, 'interval' end

  local last = lastSent[identifier]
  if last == nil then return true, 'first' end

  -- The keep-alive. MUST fire well inside the API's 45 s position TTL, or a
  -- stationary unit expires off the map while still on duty.
  if (now - last.at) >= Config.throttle.maxIntervalMs then return true, 'keepalive' end

  if distance2d(snapshot.x, snapshot.y, last.x, last.y) >= Config.throttle.minDistance then
    return true, 'moved'
  end

  if headingDelta(snapshot.heading, last.heading) >= Config.throttle.minHeadingDelta then
    return true, 'turned'
  end

  -- Getting into or out of a car changes what the map draws, even standing
  -- still — so it is a change worth a message.
  local lastPlate = last.vehicle and last.vehicle.plate or nil
  local nowPlate = snapshot.vehicle and snapshot.vehicle.plate or nil
  if lastPlate ~= nowPlate then return true, 'vehicle' end

  --[[
    GOING DOWN, OR GETTING BACK UP, IS ALWAYS WORTH A MESSAGE.

    Without this the throttle would swallow it: a player who is shot while
    standing still moves less than the distance threshold and turns less than
    the heading one, so the change would wait for the ten-second keep-alive.

    That cuts both ways and the second direction is the one that matters. LEOOS
    refuses a panic from somebody it believes is down, so a REVIVED player who
    stands still would be unable to raise an alarm until the keep-alive caught
    up — up to ten seconds of a working panic button that does nothing. A
    transition is a change, and this is a change detector.
  ]]
  if last.down ~= snapshot.down then return true, 'liveness' end

  return false, nil
end

--[[
  One player's state, read entirely from server natives.

  Returns nil for a player we cannot identify — without an identifier there is
  nothing LEOOS could attribute the position to, so collecting the rest is
  wasted work.
]]
local function snapshotPlayer(src)
  local identifiers = Adapter.getIdentity(src)
  if identifiers == nil or next(identifiers) == nil then return nil end

  local ped = GetPlayerPed(src)
  if ped == 0 then return nil end

  local coords = GetEntityCoords(ped)
  if coords == nil then return nil end

  local snapshot = {
    src = tonumber(src),
    identifiers = identifiers,
    characterName = Adapter.getCharacterName(src),
    -- Rounded to a decimetre. The map draws at metre scale, and full float
    -- precision is bytes on the wire that no screen can render.
    x = math.floor(coords.x * 10 + 0.5) / 10,
    y = math.floor(coords.y * 10 + 0.5) / 10,
    z = math.floor(coords.z * 10 + 0.5) / 10,
    heading = math.floor(GetEntityHeading(ped) * 10 + 0.5) / 10,
    --[[
      Dead or dying, from the SERVER's view of the entity.

      Reported alongside position because it is the same kind of fact and comes
      from the same place. LEOOS uses it to refuse a panic from somebody who is
      down, and can only ever treat it as this server's assertion — it has no
      way to check, exactly as it has no way to check a coordinate.

      A boolean rather than the health number: a roleplay framework can hold a
      downed player at positive health, so the number does not answer the
      question a panic button asks.
    ]]
    down = Collector.isDown(src, ped),
  }

  if Config.features.vehicles then
    local vehicle = GetVehiclePedIsIn(ped, false)
    if vehicle ~= nil and vehicle ~= 0 then
      snapshot.vehicle = {
        model = GetEntityModel(vehicle) and tostring(GetEntityModel(vehicle)) or 'unknown',
        plate = GetVehicleNumberPlateText(vehicle),
      }
      -- Speed comes from the vehicle, in metres per second, which is what the
      -- API expects. A ped on foot reports nothing rather than a guess.
      local speed = GetEntitySpeed(vehicle)
      if speed then snapshot.speed = math.floor(speed * 10 + 0.5) / 10 end
    end
  end

  return snapshot
end

--[[
  Whether a player counts as down.

  Base natives by default. A framework that tracks incapacitation separately
  from health knows better, and says so through the adapter — which is the only
  place in this resource allowed to know a framework exists.
]]
function Collector.isDown(src, ped)
  if Adapter.isDown ~= nil then
    local ok, result = pcall(Adapter.isDown, src)
    if ok and result ~= nil then return result == true end
  end
  if ped == nil or ped == 0 then return false end
  return GetEntityHealth(ped) <= 0
end

--[[
  Builds a telemetry batch.

  ONE REQUEST FOR ALL PLAYERS. Per-player requests would mean 150 HTTP round
  trips a second out of a Lua runtime that handles HTTP asynchronously and badly
  under load — and would multiply the signing work by 150 as well.
]]
function Collector.collect(now)
  local players = {}
  local online = {}
  local reasons = {}

  for _, src in ipairs(GetPlayers()) do
    local snapshot = snapshotPlayer(src)
    if snapshot ~= nil then
      local identifier = snapshot.identifiers.license
        or snapshot.identifiers.license2
        or snapshot.identifiers.steam
        or next(snapshot.identifiers)

      if identifier ~= nil then
        online[identifier] = true

        local send, reason = shouldSend(identifier, snapshot, now)
        if send then
          players[#players + 1] = snapshot
          reasons[identifier] = reason
          lastSent[identifier] = {
            at = now,
            x = snapshot.x,
            y = snapshot.y,
            heading = snapshot.heading,
            vehicle = snapshot.vehicle,
            down = snapshot.down,
          }
        end
      end
    end
  end

  --[[
    Departures, computed by diffing against the previous sweep.

    Reporting them PROMPTLY matters: the API's position TTL would expire a unit
    eventually, but "eventually" is up to 45 seconds of a dispatcher looking at
    somebody who logged off. When the game server knows, it says so.
  ]]
  local departed = {}
  for identifier in pairs(previousOnline) do
    if not online[identifier] then
      departed[#departed + 1] = identifier
      lastSent[identifier] = nil
    end
  end
  previousOnline = online

  return players, departed, reasons
end

--- Forgets a player immediately, on drop. Their departure is sent as an event.
function Collector.forget(identifier)
  lastSent[identifier] = nil
  previousOnline[identifier] = nil
end

--- Clears the throttle memory. Called after a re-handshake, so the next batch
--- is a full one and the API starts from a complete picture.
function Collector.reset()
  lastSent = {}
  previousOnline = {}
end

function Collector.trackedCount()
  local n = 0
  for _ in pairs(lastSent) do n = n + 1 end
  return n
end
