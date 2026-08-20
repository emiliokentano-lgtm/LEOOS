--[[===========================================================================
  Adapter selection.

  THE INTERFACE, in full:

      ---@class LeoosAdapter
      ---@field name              string
      ---@field detect            fun(): boolean
      ---@field getIdentity       fun(src: number): table<string, string>
      ---@field getCharacterName  fun(src: number): string|nil

  Four fields, two of which do real work. That is the entire framework surface
  of this resource, and it is small on purpose: the smaller the seam, the less
  a framework can influence.

  NOTHING OUTSIDE THIS DIRECTORY MAY REFERENCE A FRAMEWORK GLOBAL. No `ESX`, no
  `QBCore`, no `exports['whatever']`. If a future adapter needs one, it goes in
  its own file here and the rest of the resource never learns about it.

  SELECTION IS EXPLICIT BY DEFAULT. `leoos_adapter` names the adapter; `auto`
  detects one and LOGS WHICH IT CHOSE. Autodetection that picks silently is how
  a server ends up running the wrong adapter for six months without anyone
  noticing, so it announces itself either way.
===========================================================================]]

LeoosAdapters = LeoosAdapters or {}

Adapter = nil

local function pick()
  local requested = Config.adapter

  if requested ~= 'auto' then
    local chosen = LeoosAdapters[requested]
    if chosen == nil then
      --[[
        A named adapter that does not exist is a CONFIGURATION ERROR, and it is
        reported as one. Falling back to standalone silently would work — and
        would mean a server operator who typed `leoos_adapter "esx"` believes
        they are running an ESX adapter that is not installed.
      ]]
      print(('[leoos] adapter "%s" is not installed; falling back to standalone.')
        :format(requested))
      print('[leoos] Installed adapters: ' .. table.concat(Leoos.adapterNames(), ', '))
      return LeoosAdapters.standalone
    end
    return chosen
  end

  -- Autodetection. `standalone` always detects, so it is tried last.
  for name, candidate in pairs(LeoosAdapters) do
    if name ~= 'standalone' and candidate.detect and candidate.detect() then
      print(('[leoos] autodetected the "%s" adapter.'):format(name))
      return candidate
    end
  end

  print('[leoos] no framework detected; using the standalone adapter.')
  return LeoosAdapters.standalone
end

Leoos = Leoos or {}

function Leoos.adapterNames()
  local names = {}
  for name in pairs(LeoosAdapters) do names[#names + 1] = name end
  table.sort(names)
  return names
end

function Leoos.initAdapter()
  Adapter = pick()
  return Adapter
end
