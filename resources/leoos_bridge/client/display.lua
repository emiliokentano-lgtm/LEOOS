--[[===========================================================================
  Everything LEOOS draws on a player's screen.

  Notifications and waypoints, and nothing else. This file reads no coordinates,
  sends no positions, and has no path to the LEOOS API — every request in this
  resource is made from the server, signed with a secret the client never sees.

  It only ever ACTS ON what the server sends. The other client script,
  `keybinds.lua`, only ever asks the server to look at something. Neither
  decides anything, which is the whole point of keeping both thin: a client
  script that could report a position is a client that decides where it is, and
  on a roleplay server somebody will make that decision for themselves.

  (Named `claim.lua` until it grew a second handler and the name stopped being
  true. The identity-claim command it was named for lives on the server.)
===========================================================================]]

RegisterNetEvent('leoos:notify', function(payload)
  if type(payload) ~= 'table' then return end

  --[[
    A payload carrying a `fieldRequestId` is a PROMPT, not a toast.

    Distinguished by the field rather than by a new command type, so the API's
    command set stays at four and an older resource that predates prompts shows
    a harmless notification instead of failing on a type it does not know.
  ]]
  if payload.fieldRequestId ~= nil then
    Prompt.show(payload)
    return
  end

  local title = tostring(payload.title or 'LEOOS')
  local body = tostring(payload.body or '')

  --[[
    Base natives only.

    A server running ox_lib, mythic_notify or its own notification resource can
    replace this function with one line, and nothing else in the resource needs
    to know. Depending on one of them here would make an optional nicety a hard
    dependency for every server.
  ]]
  SetNotificationTextEntry('STRING')
  AddTextComponentSubstringPlayerName(('~b~%s~s~\n%s'):format(title, body))
  DrawNotification(false, true)
end)

--[[
  A waypoint LEOOS asked for.

  Bounded here as well as on the server: the client is the last place this
  payload passes through, and `SetNewWaypoint` with a NaN silently does nothing
  useful while leaving the player believing a route was set.

  It REPLACES the player's current waypoint, which is a real cost — somebody
  navigating somewhere else loses their route. That is the right trade for a
  waypoint the player asked for by accepting a prompt, and it is why nothing in
  this resource sets one unprompted.
]]
RegisterNetEvent('leoos:setWaypoint', function(payload)
  if type(payload) ~= 'table' then return end

  local x = tonumber(payload.x)
  local y = tonumber(payload.y)
  if x == nil or y == nil then return end
  -- NaN is the one value that is not equal to itself.
  if x ~= x or y ~= y then return end
  if math.abs(x) > 10000 or math.abs(y) > 10000 then return end

  SetNewWaypoint(x, y)

  SetNotificationTextEntry('STRING')
  AddTextComponentSubstringPlayerName(
    ('~b~%s~s~\nWaypoint set.'):format(tostring(payload.label or 'LEOOS')))
  DrawNotification(false, true)
end)
