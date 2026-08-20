import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets the API must be able to READ BACK.
 *
 * Almost every secret in this system is hashed, and that is the right default: a
 * password, a session token, a claim code are all things the API only ever needs
 * to *compare*. This module is for the narrow set that are different — a value
 * the API has to use as a key, not merely recognise.
 *
 * There is exactly one such value today: the FiveM ingest secret. HMAC is
 * symmetric, so verifying a signed request means holding the same key the game
 * server used. A one-way hash cannot provide it. See migration 0007 for the full
 * write-up of that conflict; the short version is that the alternative — the
 * resource sending its secret on every request — puts a long-lived credential in
 * every proxy log and loses the body binding that makes tampering with a single
 * coordinate a signature failure.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding garbage that then fails a signature check for reasons nobody can
 * diagnose.
 *
 * THE KEY LIVES IN THE ENVIRONMENT, never in the database. Someone with a
 * database dump alone has ciphertext; they need the process environment too.
 * That is a real and worthwhile boundary, and it is the whole of the protection
 * this offers — it is not a substitute for protecting the database.
 *
 * Format: `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`. Versioned from the
 * first line so a future key rotation or algorithm change has somewhere to go.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard.
const KEY_BYTES = 32;

export class SecretBoxUnavailable extends Error {
  constructor() {
    super(
      'LEOOS_FIVEM_SECRET_KEY is not configured, so ingest credentials cannot be ' +
        'issued or verified. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
    this.name = 'SecretBoxUnavailable';
  }
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /**
   * Builds a box from a base64 key, or returns null when none is configured.
   *
   * NULL RATHER THAN THROWING, deliberately. The API must start without this:
   * an installation with no game server has no use for it, and refusing to boot
   * would make an optional integration a hard dependency. What must not happen
   * is a silent downgrade, so every call site that needs a box and has none
   * fails loudly, at the point of use, with the message above.
   */
  static fromBase64(raw: string | undefined | null): SecretBox | null {
    if (!raw) return null;

    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      throw new Error('LEOOS_FIVEM_SECRET_KEY is not valid base64.');
    }
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `LEOOS_FIVEM_SECRET_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}.`,
      );
    }
    return new SecretBox(key);
  }

  seal(plaintext: string): string {
    // A fresh IV per encryption. Reusing one under GCM is catastrophic — it
    // leaks the XOR of the plaintexts and forges the authentication tag — so it
    // is generated here rather than passed in by a caller who might cache it.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypts, returning null for anything that does not authenticate.
   *
   * Null rather than throwing: the caller is a request handler that has to
   * answer "this credential cannot be verified" in a controlled way, and a
   * decryption failure is a possible operational state (a rotated key, a
   * restored database) rather than a programming error.
   */
  open(sealed: string): string | null {
    const parts = sealed.split('.');
    if (parts.length !== 4) return null;

    const [version, ivRaw, tagRaw, ciphertextRaw] = parts;
    if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) return null;

    try {
      const iv = Buffer.from(ivRaw, 'base64url');
      const tag = Buffer.from(tagRaw, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16) return null;

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, tampered ciphertext, or truncated input. All three mean the
      // same thing to the caller: this value cannot be trusted.
      return null;
    }
  }
}
