--[[===========================================================================
  The only client script in this resource.

  It displays notifications and nothing else. It reads no coordinates, sends no
  positions, and has no path to the LEOOS API — every request in this resource is
  made from the server, signed with a secret the client never sees.

  That is the whole point of keeping this file thin: a client script that could
  report a position is a client that decides where it is, and on a roleplay
  server somebody will make that decision for themselves.
===========================================================================]]

RegisterNetEvent('leoos:notify', function(payload)
  if type(payload) ~= 'table' then return end

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
