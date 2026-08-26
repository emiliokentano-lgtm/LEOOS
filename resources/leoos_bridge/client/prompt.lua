--[[===========================================================================
  The on-screen prompt.

  ────────────────────────────────────────────────────────────────────────────
  ONE PROMPT AT A TIME, AND IT EXPIRES ON ITS OWN

  A queue of prompts stacking up on somebody's screen during a busy shift is
  worse than missing one: they clear them by mashing a key, which is the same as
  not reading them. The newest replaces the older, because the newest is the one
  still describing a situation that exists.

  It also expires locally after `PROMPT_TTL_MS`, whether or not the player
  touches it. The API expires the request too and would refuse a late accept —
  this exists so the screen agrees with the server rather than offering a button
  that will be refused.

  ────────────────────────────────────────────────────────────────────────────
  DRAWN, NOT NOTIFIED

  A `DrawNotification` toast cannot say "press E" and then react to E. This
  draws text every frame while a prompt is live, which is what an interaction
  prompt has to be — and it costs nothing when nothing is live, because the
  thread sleeps until one arrives.
===========================================================================]]

Prompt = {}

local active = nil
local PROMPT_TTL_MS = 20000

--[[
  Accept and dismiss are read with `IsControlJustPressed` rather than bound
  through `RegisterKeyMapping`.

  Deliberate, and the one place in this resource that does it. E and G are keys
  the player is already using for everything else in the game; claiming them
  globally through a key mapping would take them away from every other resource.
  Read only while a prompt is on screen, they are borrowed rather than taken.

  The config values name CONTROL IDS for that reason, and the defaults are the
  standard E (38) and G (47).
]]
local CONTROL_ACCEPT = 38
local CONTROL_DISMISS = 47

function Prompt.show(payload)
  if type(payload) ~= 'table' then return end
  if payload.fieldRequestId == nil then return end

  active = {
    id = tostring(payload.fieldRequestId),
    title = tostring(payload.title or 'LEOOS'),
    body = tostring(payload.body or ''),
    shownAt = GetGameTimer(),
  }
end

function Prompt.clear()
  active = nil
end

--- What is on screen, if anything. Exposed for the status report.
function Prompt.current()
  return active
end

local function draw(text)
  SetTextFont(4)
  SetTextScale(0.42, 0.42)
  SetTextColour(255, 255, 255, 255)
  SetTextOutline()
  SetTextCentre(true)
  SetTextEntry('STRING')
  AddTextComponentSubstringPlayerName(text)
  DrawText(0.5, 0.86)
end

Citizen.CreateThread(function()
  while true do
    if active == nil then
      -- Nothing on screen: sleep long. A prompt thread that spins at 0ms all
      -- shift is a frame budget spent on nothing.
      Citizen.Wait(250)
    else
      Citizen.Wait(0)

      if GetGameTimer() - active.shownAt > PROMPT_TTL_MS then
        active = nil
      else
        draw(('~y~%s~s~  %s'):format(active.title, active.body))
        draw('')
        SetTextFont(4)
        SetTextScale(0.36, 0.36)
        SetTextColour(200, 200, 200, 255)
        SetTextOutline()
        SetTextCentre(true)
        SetTextEntry('STRING')
        AddTextComponentSubstringPlayerName('~g~[E]~s~ Respond    ~r~[G]~s~ Dismiss')
        DrawText(0.5, 0.90)

        if IsControlJustPressed(0, CONTROL_ACCEPT) then
          local id = active.id
          active = nil
          TriggerServerEvent('leoos:keybind:respond', id, 'accept')
        elseif IsControlJustPressed(0, CONTROL_DISMISS) then
          local id = active.id
          active = nil
          TriggerServerEvent('leoos:keybind:respond', id, 'decline')
        end
      end
    end
  end
end)

--[[
  A prompt the API asked for.

  Distinguished from an ordinary notification by carrying a `fieldRequestId`:
  the API sends the same `notify` command type either way, and a payload without
  an id is just a toast. That keeps the command set small rather than adding a
  `prompt` type the resource would have to be updated to understand.
]]
RegisterNetEvent('leoos:prompt', function(payload)
  Prompt.show(payload)
end)
