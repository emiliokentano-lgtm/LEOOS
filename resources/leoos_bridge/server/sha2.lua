--[[===========================================================================
  SHA-256, in pure Lua.

  WHY THIS FILE EXISTS. FiveM ships no crypto primitives, and the alternatives
  were both worse:

    · depend on ox_lib or a similar library — a hard dependency on somebody
      else's resource, for one function, on a server we do not control;
    · shell out to an external binary — a process spawn per request, at 1 Hz.

  So: about 90 lines of arithmetic, tested against the published SHA-256 test
  vectors in `server/main.lua`'s self-check. It runs once per request over a
  payload of a few kilobytes, which is nothing next to the HTTP round trip it
  is part of.

  Lua 5.4 is required (`lua54 'yes'` in the manifest) for two reasons: native
  bitwise operators, and `string.pack`. On 5.3 semantics this would need a
  bit library and manual byte assembly; on 5.1 it would need a rewrite.

  Integers here are 64-bit, so every operation that should wrap at 32 bits is
  masked explicitly. A missing mask does not error — it silently produces a
  different hash, which is the worst possible failure mode for a signing
  primitive, so the masks are written even where they look redundant.
===========================================================================]]

local MASK = 0xFFFFFFFF

--- The first 32 bits of the fractional parts of the cube roots of the first 64 primes.
local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

--- The first 32 bits of the fractional parts of the square roots of the first 8 primes.
local H0 = {
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
}

local function rrotate(x, n)
  x = x & MASK
  return ((x >> n) | (x << (32 - n))) & MASK
end

--[[
  Returns the digest as 32 RAW BYTES, not hex.

  Raw, because HMAC needs to feed one digest into another and hex would double
  the block length and produce a different — wrong — result. `hex()` below is
  for the wire.
]]
local function digest(message)
  local h = { table.unpack(H0) }

  -- Padding: a 1 bit, then zeros, then the 64-bit big-endian bit length.
  local bitLength = #message * 8
  local padded = message .. '\128'
  while (#padded % 64) ~= 56 do
    padded = padded .. '\0'
  end
  padded = padded .. string.pack('>I8', bitLength)

  local w = {}
  for chunk = 1, #padded, 64 do
    -- 16 big-endian words from the block, then 48 derived from them.
    for i = 0, 15 do
      w[i + 1] = string.unpack('>I4', padded, chunk + i * 4)
    end
    for i = 17, 64 do
      local a, b = w[i - 15], w[i - 2]
      local s0 = rrotate(a, 7) ~ rrotate(a, 18) ~ (a >> 3)
      local s1 = rrotate(b, 17) ~ rrotate(b, 19) ~ (b >> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK
    end

    local a, b, c, d = h[1], h[2], h[3], h[4]
    local e, f, g, hh = h[5], h[6], h[7], h[8]

    for i = 1, 64 do
      local s1 = rrotate(e, 6) ~ rrotate(e, 11) ~ rrotate(e, 25)
      local ch = (e & f) ~ ((~e & MASK) & g)
      local temp1 = (hh + s1 + ch + K[i] + w[i]) & MASK
      local s0 = rrotate(a, 2) ~ rrotate(a, 13) ~ rrotate(a, 22)
      local maj = (a & b) ~ (a & c) ~ (b & c)
      local temp2 = (s0 + maj) & MASK

      hh = g
      g = f
      f = e
      e = (d + temp1) & MASK
      d = c
      c = b
      b = a
      a = (temp1 + temp2) & MASK
    end

    h[1] = (h[1] + a) & MASK
    h[2] = (h[2] + b) & MASK
    h[3] = (h[3] + c) & MASK
    h[4] = (h[4] + d) & MASK
    h[5] = (h[5] + e) & MASK
    h[6] = (h[6] + f) & MASK
    h[7] = (h[7] + g) & MASK
    h[8] = (h[8] + hh) & MASK
  end

  local out = {}
  for i = 1, 8 do
    out[i] = string.pack('>I4', h[i])
  end
  return table.concat(out)
end

local function hex(bytes)
  return (bytes:gsub('.', function(char)
    return string.format('%02x', string.byte(char))
  end))
end

Sha2 = {
  digest = digest,
  hex = hex,
  --- The common case: hex of the digest, which is what the wire format wants.
  hexDigest = function(message) return hex(digest(message)) end,
}
