--[[===========================================================================
  The standalone adapter — THE DEFAULT, and the only one that ships.

  It uses base FiveM natives and nothing else, so it works on any server, with
  or without a framework. That is deliberate: engineering rule 37 says no
  framework is assumed unless the project specifies one, and this project does
  not specify one.

  WHAT AN ADAPTER MAY SUPPLY, and this is the whole of it:

    · identifiers — which Rockstar licence, Steam id, Discord id this player has
    · a character name, ADVISORY ONLY, for display when no LEOOS account is linked
    · whether the player is DOWN — optional, and only because a framework knows
      something base natives do not: a downed player can sit at positive health,
      so `GetEntityHealth` answers the wrong question on those servers

  WHAT NO ADAPTER MAY EVER SUPPLY: organization, rank, callsign, unit,
  permissions. Those resolve from the LEOOS database by looking the identifier
  up, so the choice of framework cannot affect authorization. An ESX adapter and
  a QBCore adapter would differ in how they answer the two questions above and in
  nothing else.
===========================================================================]]

--[[
  Adapters REGISTER THEMSELVES into a global table rather than returning a value.

  FiveM loads each `server_script` as its own chunk and discards whatever it
  returns — there is no `require` between them — so a `return` here would simply
  vanish. Registration is the mechanism that actually works, and it means adding
  a framework adapter is one new file plus one line in the manifest, with nothing
  in `init.lua` to edit.
]]
LeoosAdapters = LeoosAdapters or {}

local StandaloneAdapter = {}

StandaloneAdapter.name = 'standalone'

--- Always available. Base natives exist on every FiveM server by definition.
function StandaloneAdapter.detect()
  return true
end

--[[
  Reads a player's identifiers from the SERVER.

  `GetPlayerIdentifiers` is a server native reporting what the platform
  authenticated, not what the client claims. A client cannot forge these, which
  is the entire reason identity resolution keys on them.
]]
function StandaloneAdapter.getIdentity(src)
  local identifiers = {}
  local count = GetNumPlayerIdentifiers(src)

  for i = 0, count - 1 do
    local raw = GetPlayerIdentifier(src, i)
    if raw then
      local prefix, value = raw:match('^([%a%d]+):(.+)$')
      if prefix and value then
        -- Stored under the bare provider name with the full string as the
        -- value; the API normalises either form, and sending what the platform
        -- gave us keeps this adapter from having an opinion.
        identifiers[prefix] = raw
      end
    end
  end

  return identifiers
end

--[[
  The player's display name, as the SERVER knows it.

  Advisory. LEOOS shows it only for a player with no linked account, and
  replaces it with the real display name the moment one exists. A framework
  adapter would return the character's roleplay name here instead.
]]
function StandaloneAdapter.getCharacterName(src)
  local name = GetPlayerName(src)
  if name == nil or name == '' then return nil end
  return name
end

--[[
  Whether the player is dead or dying.

  OPTIONAL, and the base implementation is deliberately blunt: health at or
  below zero. A framework with a downed/incapacitated state should override this
  — on those servers a player can be bleeding out at 150 health, and a panic
  button that works while you are unconscious is not a panic button.

  This is the one place the resource asks a game-world question whose answer a
  framework can improve. Everything organizational still resolves from the LEOOS
  database, and no adapter may touch that.
]]
function StandaloneAdapter.isDown(src)
  local ped = GetPlayerPed(src)
  if ped == 0 then return false end
  return GetEntityHealth(ped) <= 0
end

LeoosAdapters.standalone = StandaloneAdapter
