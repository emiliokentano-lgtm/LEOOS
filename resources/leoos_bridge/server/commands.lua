--[[===========================================================================
  Commands the API sends back.

  THE GAME SERVER EXPOSES NO INBOUND ENDPOINT. Every request goes outbound, and
  anything the API wants to say comes back in a RESPONSE BODY. That means no
  firewall rule on the game host, no listening port to attack, and no way for
  anything that has not first been authenticated by us to reach this code.

  AT MOST ONCE, deliberately. A command that fails to apply is not retried: a
  duplicated in-game notification is worse than a missed one, and anything that
  genuinely must not be lost belongs in the web UI where it can be acknowledged,
  not in a popup that disappears in four seconds.

  The command set is deliberately tiny and deliberately harmless. Nothing here
  can move a player, take their money, or kick them. The API is a dispatch
  system, not a server administration tool, and a compromised backend should not
  become a way to grief a game server.
]]

Commands = {}

local handlers = {}

--- A toast in the player's game. The only thing the API can currently do.
handlers.notify = function(src, payload)
  TriggerClientEvent('leoos:notify', src, {
    title = tostring(payload and payload.title or 'LEOOS'),
    body = tostring(payload and payload.body or ''),
    tone = tostring(payload and payload.tone or 'info'),
  })
end

--- Reserved for map blips once the client-side blip layer exists.
handlers.setBlip = function() end
handlers.clearBlip = function() end

--[[
  Puts a marker on the player's map and GPS.

  The most a command in this set will ever do to a player's game: draw a line on
  their minimap. It cannot move them, and a player who ignores it loses nothing.
  Coordinates are bounded on the client before use, because a malformed or
  hostile payload should place no waypoint rather than an undefined one.
]]
handlers.setWaypoint = function(src, payload)
  local x = tonumber(payload and payload.x)
  local y = tonumber(payload and payload.y)
  if x == nil or y == nil then return end

  TriggerClientEvent('leoos:setWaypoint', src, {
    x = x,
    y = y,
    label = tostring(payload.label or 'LEOOS'),
  })
end

--- Resolves an identifier to a currently-connected server id, or nil.
local function findPlayer(identifier)
  for _, src in ipairs(GetPlayers()) do
    local identifiers = Adapter.getIdentity(src)
    for _, value in pairs(identifiers) do
      if value == identifier then return src end
    end
  end
  return nil
end

function Commands.apply(commands)
  if not Config.features.commands then return end
  if type(commands) ~= 'table' then return end

  for _, command in ipairs(commands) do
    local handler = handlers[command.type]

    if handler == nil then
      -- An unknown command is IGNORED, not an error. A newer API may send a
      -- command type this resource predates, and a server operator who has not
      -- updated should keep working rather than see an error every second.
      if Config.debug then
        print(('[leoos:debug] ignoring unknown command type "%s"'):format(tostring(command.type)))
      end
    else
      local src = findPlayer(command.target)
      if src ~= nil then
        -- `pcall`, because a bad command must never take down the tick loop
        -- that keeps every unit on the map alive.
        local ok, err = pcall(handler, src, command.payload)
        if not ok and Config.debug then
          print(('[leoos:debug] command %s failed: %s'):format(tostring(command.id), tostring(err)))
        end
      end
    end
  end
end
