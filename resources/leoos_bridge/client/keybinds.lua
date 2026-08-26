--[[===========================================================================
  Keybinds.

  ────────────────────────────────────────────────────────────────────────────
  THE PLAYER OWNS THEIR KEYBOARD

  Every binding here is registered with `RegisterKeyMapping`, which is FiveM's
  own mechanism: the player rebinds it in Settings → Key Bindings → FiveM, the
  choice is stored per player by the game client, and it survives a restart of
  this resource and of the server.

  We deliberately do NOT build a rebinding UI of our own. One would mean a
  second store of bindings, a second place they can disagree, and a menu the
  player has to discover — in order to reimplement a screen they already know.
  The defaults in `config.lua` are only what an unbound key falls back to.

  ────────────────────────────────────────────────────────────────────────────
  WHAT A KEYPRESS IS ALLOWED TO DO

  Nothing, on its own. Every binding raises a server event and stops. The event
  carries NO payload — not a position, not an identity, not a liveness flag.
  `source` is set by the FiveM runtime and cannot be forged; everything else the
  server reads for itself, from natives this script cannot reach.

  The one thing the client DOES decide is when to refuse early: pressing panic
  while down gets an immediate answer here rather than a silent no-op. That is a
  courtesy to the player, not a security check — the server re-checks it, and so
  does LEOOS. See docs/architecture/04-fivem-integration.md §1.
===========================================================================]]

--[[
  One table entry per binding.

  Adding a binding in a later phase is one entry here and one handler on the
  server — not a new code path.
]]
local BINDINGS = {
  {
    command = 'leoos_panic',
    label = 'LEOOS: Panic button',
    defaultKey = (Config.keys and Config.keys.panic) or 'F7',
    event = 'leoos:keybind:panic',
    feature = 'panic',
    requiresAlive = true,
  },
  {
    command = 'leoos_backup',
    label = 'LEOOS: Request backup',
    defaultKey = (Config.keys and Config.keys.backup) or 'F8',
    event = 'leoos:keybind:backup',
    feature = 'fieldRequests',
    --[[
      Also refused while down, and for the same reason as panic: a request for
      backup from somebody who is unconscious is a request nobody can act on
      usefully, and the player needs to be told rather than left waiting.
    ]]
    requiresAlive = true,
  },
  {
    command = 'leoos_share_location',
    label = 'LEOOS: Share my location',
    defaultKey = (Config.keys and Config.keys.shareLocation) or 'F9',
    event = 'leoos:keybind:share_location',
    feature = 'fieldRequests',
    --[[
      NOT gated on being alive.
      
      Sharing where you are while down is exactly when it is most useful — it is
      how somebody finds your body. The asymmetry with backup is deliberate.
    ]]
    requiresAlive = false,
  },
}

Keybinds = {}

--[[
  Whether the local player counts as unable to press a button.

  Base natives only, so this works on a standalone server. The SERVER makes the
  decision that matters — this exists so the player is told immediately instead
  of pressing a key that appears to do nothing.
]]
function Keybinds.isDown()
  local ped = PlayerPedId()
  if ped == 0 then return false end
  return IsPedDeadOrDying(ped, true) or IsPedFatallyInjured(ped)
end

--[[
  A refusal the player can see.

  Silence is the wrong answer to a pressed panic button under any circumstance.
  If the key does nothing, the player must be told it did nothing and why,
  because the alternative is somebody believing help is on the way.
]]
local function refuse(body)
  SetNotificationTextEntry('STRING')
  AddTextComponentSubstringPlayerName(('~r~LEOOS~s~\n%s'):format(body))
  DrawNotification(false, true)
end

--[[
  Debounce.

  A held key repeats, and a panic button is exactly the key somebody holds down.
  The server and LEOOS both tolerate a repeat — a second panic while one is live
  is not a second alert — but sending it is waste on the wire and in the event
  queue, which is bounded and shared with everything else.
]]
local lastPressAt = {}
local DEBOUNCE_MS = 1500

local function debounced(command)
  local now = GetGameTimer()
  local last = lastPressAt[command]
  if last ~= nil and now - last < DEBOUNCE_MS then return true end
  lastPressAt[command] = now
  return false
end

for _, binding in ipairs(BINDINGS) do
  --[[
    A disabled feature registers NO binding at all.

    Registering one that silently does nothing would be worse than leaving the
    key free: the player would find it in their settings, bind it, press it, and
    conclude the panic button is broken rather than switched off.
  ]]
  if Config.features[binding.feature] ~= false then
    RegisterCommand(binding.command, function()
      if debounced(binding.command) then return end

      if binding.requiresAlive and Keybinds.isDown() then
        refuse('You cannot do that while you are down.')
        return
      end

      TriggerServerEvent(binding.event)
    end, false)

    RegisterKeyMapping(binding.command, binding.label, 'keyboard', binding.defaultKey)
  end
end
