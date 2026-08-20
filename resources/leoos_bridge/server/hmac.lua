--[[===========================================================================
  HMAC-SHA256 (RFC 2104).

      HMAC(K, m) = H( (K' ⊕ opad) ‖ H( (K' ⊕ ipad) ‖ m ) )

  where K' is the key padded to the 64-byte block size, or the hash of the key
  when the key is longer than a block.

  The nested hash is not decoration. A single `H(key ‖ message)` is vulnerable to
  a length-extension attack — an attacker who has one valid signature can append
  to the message and produce a valid signature for the extension without knowing
  the key. SHA-256 is a Merkle–Damgård construction, so it has that property, and
  HMAC is the standard construction that removes it.
===========================================================================]]

local BLOCK_SIZE = 64
local IPAD = 0x36
local OPAD = 0x5c

--- XORs every byte of `bytes` with a single constant.
local function xorWith(bytes, pad)
  local out = {}
  for i = 1, #bytes do
    out[i] = string.char(string.byte(bytes, i) ~ pad)
  end
  return table.concat(out)
end

local function normaliseKey(key)
  -- A key longer than the block is hashed down to 32 bytes; a shorter one is
  -- zero-padded up. Both are in the RFC, and both matter here: the 32-byte
  -- secrets LEOOS issues take the padding path.
  if #key > BLOCK_SIZE then
    key = Sha2.digest(key)
  end
  return key .. string.rep('\0', BLOCK_SIZE - #key)
end

local function hmacSha256(key, message)
  local k = normaliseKey(key)
  local inner = Sha2.digest(xorWith(k, IPAD) .. message)
  return Sha2.digest(xorWith(k, OPAD) .. inner)
end

Hmac = {
  sha256 = hmacSha256,
  sha256Hex = function(key, message) return Sha2.hex(hmacSha256(key, message)) end,
}
