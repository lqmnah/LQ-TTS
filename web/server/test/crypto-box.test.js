import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32, open, parseEncKey, seal } from '../lib/crypto-box.js';

const KEY = crypto.randomBytes(32);

describe('crypto box', () => {
  it('opens what it sealed, only with the same key and the same row binding', () => {
    const sealed = seal(KEY, 'whsec_abc', 'api_key:1');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('whsec_abc');
    expect(open(KEY, sealed, 'api_key:1')).toBe('whsec_abc');
    expect(() => open(KEY, sealed, 'api_key:2')).toThrow();
    expect(() => open(crypto.randomBytes(32), sealed, 'api_key:1')).toThrow();
    expect(() => open(KEY, 'v2.a.b.c', 'api_key:1')).toThrow('unknown format');
    expect(seal(KEY, 'same', 'a')).not.toBe(seal(KEY, 'same', 'a'));
  });

  it('encodes base32 per RFC 4648, lowercase and unpadded', () => {
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32(Buffer.from('f'))).toBe('my');
    expect(base32(crypto.randomBytes(32))).toMatch(/^[a-z2-7]{52}$/);
  });

  it('parses a 32-byte base64 key', () => {
    expect(parseEncKey(KEY.toString('base64'))).toEqual(KEY);
  });
});
