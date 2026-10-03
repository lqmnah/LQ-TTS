import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, msUntilNextStep, totp } from './totp.mjs';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890"), RFC 6238 SHA-1 vectors

test('decodes base32', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
});

test('matches RFC 6238 SHA-1 vectors (last 6 digits)', () => {
  assert.equal(totp(RFC_SECRET, 59_000), '287082');
  assert.equal(totp(RFC_SECRET, 1_111_111_109_000), '081804');
  assert.equal(totp(RFC_SECRET, 1_234_567_890_000), '005924');
});

test('reports the wait until the next 30 s window', () => {
  assert.equal(msUntilNextStep(59_000), 1_000);
  assert.equal(msUntilNextStep(60_000), 30_000);
});
