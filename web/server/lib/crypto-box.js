import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** API_ENC_KEY: 32 random bytes in base64 (`openssl rand -base64 32`). The error names the setting, never the value. */
export function parseEncKey(raw) {
  const key = /^[A-Za-z0-9+/]{43}=$/.test(String(raw)) ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length !== 32) throw new Error('API_ENC_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  return key;
}

/** AES-256-GCM. `aad` binds the value to its row, so a sealed value copied to another row does not open. */
export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function open(key, sealed, aad) {
  const [version, iv, tag, data] = String(sealed).split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('sealed value has an unknown format');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** RFC 4648 base32, lowercase, without padding. */
export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
