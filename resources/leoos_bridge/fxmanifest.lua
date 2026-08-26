fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'leoos_bridge'
author 'LEOOS'
description 'Reports live unit positions and operational events to a LEOOS dispatch backend.'
version '1.0.0'

--[[
  SERVER SCRIPTS DO THE WORK. The client scripts display things and read the
  keyboard. Neither reads a coordinate, decides an outcome, or has any path to
  the LEOOS API.

  That split is the security model, not a packaging choice. Every coordinate this
  resource reports comes from a SERVER-SIDE native — GetEntityCoords on the
  server, against the server's own entity state — so a modded game client cannot
  inject a position. A client that sends its own coordinates is a client that
  decides where it is, and on a roleplay server somebody will.

  A keybind is the same argument in miniature. `client/keybinds.lua` raises a
  server event carrying NOTHING — not a position, not an identity, not a
  liveness flag. The server reads all three itself, from natives the client
  cannot reach. The only thing the client decides is whether to bother the
  server at all, which is a courtesy to the player, not a check.
]]

shared_script 'config.lua'

server_scripts {
  'server/sha2.lua',
  'server/hmac.lua',
  'server/adapters/standalone.lua',
  'server/adapters/init.lua',
  'server/collector.lua',
  'server/transport.lua',
  'server/commands.lua',
  'server/main.lua',
}

client_scripts {
  'client/display.lua',
  'client/keybinds.lua',
}

dependencies {
  '/server:5848',
  '/onesync',
}
