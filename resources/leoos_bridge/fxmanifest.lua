fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'leoos_bridge'
author 'LEOOS'
description 'Reports live unit positions and operational events to a LEOOS dispatch backend.'
version '1.0.0'

--[[
  SERVER SCRIPTS DO THE WORK. The single client script is a slash command for
  identity linking and nothing else.

  That split is the security model, not a packaging choice. Every coordinate this
  resource reports comes from a SERVER-SIDE native — GetEntityCoords on the
  server, against the server's own entity state — so a modded game client cannot
  inject a position. A client that sends its own coordinates is a client that
  decides where it is, and on a roleplay server somebody will.
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
  'client/claim.lua',
}

dependencies {
  '/server:5848',
  '/onesync',
}
