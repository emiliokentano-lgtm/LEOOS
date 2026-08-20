--[[===========================================================================
  Signing and sending.

  ────────────────────────────────────────────────────────────────────────────
  THE CONSTRAINT THAT SHAPES THIS FILE

  `PerformHttpRequest` is asynchronous with a callback and offers no timeout
  guarantee. A request that never comes back never comes back, and the callback
  simply does not fire.

  So the transport keeps AT MOST ONE TELEMETRY REQUEST IN FLIGHT. If the previous
  one has not returned when the next tick fires, the tick is SKIPPED rather than
  queued. Overlapping requests would reorder positions and amplify load during
  exactly the moments the network is already struggling — the failure mode where
  a brief blip becomes a self-sustaining pile-up.

  For the same reason TELEMETRY IS NEVER RETRIED. A one-second-old position is
  worthless; retrying it turns a blip into a thundering herd and delivers stale
  data on top. Events are different — a panic must not be lost to a dropped
  connection — so they get a bounded retry queue and telemetry does not.
  ────────────────────────────────────────────────────────────────────────────

  THE RESOURCE MUST DEGRADE SILENTLY. If LEOOS is unreachable the game server
  logs it and carries on. A dispatch outage must never affect gameplay, so there
  is no path in this file that errors out of a game thread.
]]

Transport = {}

local state = {
  secret = nil,
  sessionId = nil,
  --- Monotonic, per process. Strictly increasing, including across retries.
  seq = 0,
  telemetryInFlight = false,
  --- Consecutive failures, for backoff.
  failures = 0,
  --- Earliest time at which another request may be attempted.
  nextAttemptAt = 0,
  --- Bounded queue of events awaiting delivery.
  queue = {},
  healthy = false,
}

local function log(message)
  print('[leoos] ' .. message)
end

local function debug(message)
  if Config.debug then print('[leoos:debug] ' .. message) end
end

--[[
  Backoff with jitter, capped.

  The jitter matters more than it looks: without it, a game server and every
  other client reconnect on exactly the same schedule after an outage, which is
  a self-inflicted thundering herd at the moment the backend is least able to
  absorb one.
]]
local function backoffMs(failures)
  local exponential = math.min(
    Config.backoff.maxMs,
    Config.backoff.baseMs * (2 ^ math.min(failures, 5))
  )
  return math.floor(exponential * (0.7 + math.random() * 0.6))
end

--- 16 random bytes, base64url-ish. Uniqueness is what matters, not secrecy.
local function makeNonce()
  local chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
  local out = {}
  for i = 1, 22 do
    local n = math.random(1, #chars)
    out[i] = chars:sub(n, n)
  end
  -- The process start time is mixed in so two resources started in the same
  -- second with the same RNG seed cannot collide.
  return table.concat(out) .. tostring(os.time() % 100000)
end

function Transport.configure(secret)
  state.secret = secret
  -- Seeded once, from the clock. Lua's default sequence is identical on every
  -- start otherwise, which would make every server's nonces identical too.
  math.randomseed(os.time() + GetGameTimer())
end

function Transport.setSession(sessionId)
  state.sessionId = sessionId
end

function Transport.sessionId()
  return state.sessionId
end

function Transport.isHealthy()
  return state.healthy
end

--[[
  Signs and sends one request.

  `canonical` must match the API byte for byte:

      METHOD \n PATH \n TIMESTAMP \n NONCE \n SEQ \n hex(sha256(body))

  The body hash is signed rather than the body, so verification stays cheap on a
  large batch while altering one coordinate still breaks the signature.
]]
local function send(path, payload, onDone)
  if state.secret == nil or state.secret == '' then
    log('no secret configured — set leoos_secret in server.cfg. Nothing will be sent.')
    if onDone then onDone(false, 0, 'no-secret') end
    return
  end

  local body = json.encode(payload)
  local timestamp = tostring(os.time())
  local nonce = makeNonce()

  -- Incremented for EVERY attempt, including retries. The API requires strictly
  -- increasing sequence numbers, so a retry that reused one would be rejected as
  -- a replay — which is correct, and is why retries get fresh numbers.
  state.seq = state.seq + 1
  local seq = tostring(state.seq)

  local bodyHash = Sha2.hexDigest(body)
  local canonical = table.concat({
    'POST', path, timestamp, nonce, seq, bodyHash,
  }, '\n')

  local headers = {
    ['Content-Type'] = 'application/json',
    ['X-LEOOS-Key-Id'] = Config.keyId,
    ['X-LEOOS-Timestamp'] = timestamp,
    ['X-LEOOS-Nonce'] = nonce,
    ['X-LEOOS-Seq'] = seq,
    ['X-LEOOS-Signature'] = Hmac.sha256Hex(state.secret, canonical),
    ['X-LEOOS-Protocol'] = tostring(Config.protocolVersion),
  }

  debug(('POST %s seq=%s bytes=%d'):format(path, seq, #body))

  PerformHttpRequest(Config.url .. path, function(status, responseBody)
    local ok = status >= 200 and status < 300

    if ok then
      state.failures = 0
      state.nextAttemptAt = 0
      if not state.healthy then
        state.healthy = true
        log('connected to LEOOS.')
      end
    else
      state.failures = state.failures + 1
      state.nextAttemptAt = GetGameTimer() + backoffMs(state.failures)

      -- Logged ONCE per outage rather than once per failure. A 1 Hz failure log
      -- fills a console in minutes and buries the message that mattered.
      if state.healthy or state.failures == 1 then
        state.healthy = false
        log(('LEOOS request failed (%s): %s')
          :format(tostring(status), tostring(responseBody):sub(1, 200)))
        log('the game server is unaffected; retrying with backoff.')
      else
        debug(('failure %d, next attempt in %dms'):format(state.failures, backoffMs(state.failures)))
      end
    end

    local decoded = nil
    if ok and responseBody and responseBody ~= '' then
      local success, parsed = pcall(json.decode, responseBody)
      if success then decoded = parsed end
    end

    if onDone then onDone(ok, status, responseBody, decoded) end
  end, 'POST', body, headers)
end

Transport.send = send

--- True when a request may be attempted — respects the backoff window.
function Transport.mayAttempt(now)
  return now >= state.nextAttemptAt
end

--[[
  Telemetry: at most one in flight, never retried.

  Returns false when the tick was skipped, so `main.lua` can say so in debug
  mode instead of leaving a silent gap.
]]
function Transport.sendTelemetry(payload, now)
  if state.telemetryInFlight then
    debug('telemetry tick skipped — previous request still in flight')
    return false
  end
  if not Transport.mayAttempt(now) then
    debug('telemetry tick skipped — backing off')
    return false
  end

  state.telemetryInFlight = true
  send('/api/v1/fivem/telemetry', payload, function(ok, status, _, decoded)
    state.telemetryInFlight = false

    -- A 409 means the API does not recognise our session — we restarted, or it
    -- did. Re-handshaking is the correct and self-healing response.
    if status == 409 or status == 400 then
      Transport.onSessionLost()
    end

    if ok and decoded and decoded.nextIntervalMs then
      Transport.onIntervalChanged(decoded.nextIntervalMs)
    end
    if ok and decoded and decoded.commands then
      Commands.apply(decoded.commands)
    end
  end)
  return true
end

--[[
  Events: queued, retried, and BOUNDED.

  Thirty entries. Past that the oldest is dropped, because an unbounded queue
  during a long outage is a memory leak that ends with the game server rather
  than with the dispatch system — and the whole point is that a LEOOS outage must
  not affect gameplay.
]]
function Transport.queueEvent(event)
  if #state.queue >= Config.maxQueuedEvents then
    table.remove(state.queue, 1)
    debug('event queue full — dropped the oldest entry')
  end
  state.queue[#state.queue + 1] = event
end

function Transport.flushEvents(now)
  if #state.queue == 0 then return end
  if state.sessionId == nil then return end
  if not Transport.mayAttempt(now) then return end

  -- The whole queue in one request, then cleared optimistically. A failure
  -- re-queues, so nothing is lost and a success costs one round trip.
  local batch = state.queue
  state.queue = {}

  send('/api/v1/fivem/events', {
    sessionId = state.sessionId,
    events = batch,
  }, function(ok, status)
    if not ok then
      -- Put them back at the FRONT, so ordering survives a failure.
      for i = #batch, 1, -1 do
        table.insert(state.queue, 1, batch[i])
      end
      if #state.queue > Config.maxQueuedEvents then
        for _ = 1, #state.queue - Config.maxQueuedEvents do table.remove(state.queue, 1) end
      end
      if status == 409 or status == 400 then Transport.onSessionLost() end
    end
  end)
end

function Transport.queueDepth()
  return #state.queue
end

--- Replaced by main.lua. Declared here so the transport has no upward dependency.
function Transport.onSessionLost() end
function Transport.onIntervalChanged(_) end
