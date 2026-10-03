import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpeculativePrefetch, isTargetOrigin } from './guard-rules.mjs';

test('only Sec-Purpose prefetch marks a speculative load', () => {
  assert.equal(isSpeculativePrefetch({ 'sec-purpose': 'prefetch' }), true);
  assert.equal(isSpeculativePrefetch({ 'sec-purpose': 'prefetch;prerender' }), true);
  assert.equal(isSpeculativePrefetch({ 'sec-purpose': 'Prefetch; anonymous-client-ip' }), true);
  assert.equal(isSpeculativePrefetch({}), false);
  assert.equal(isSpeculativePrefetch({ 'sec-purpose': '' }), false);
  assert.equal(isSpeculativePrefetch({ 'sec-purpose': 'prefetching' }), false);
  // Other headers that merely mention prefetch do not count.
  assert.equal(isSpeculativePrefetch({ purpose: 'prefetch', 'x-moz': 'prefetch' }), false);
});

test('the Access token goes to the exact target origin only', () => {
  const origin = 'https://tts-stg.lq-studio.com';
  assert.equal(isTargetOrigin('https://tts-stg.lq-studio.com/api/jobs/1/events', origin), true);
  assert.equal(isTargetOrigin('https://static.cloudflareinsights.com/beacon.min.js', origin), false);
  assert.equal(isTargetOrigin('https://tts-stg.lq-studio.com.evil.example/x', origin), false);
  assert.equal(isTargetOrigin('http://tts-stg.lq-studio.com/x', origin), false);
  assert.equal(isTargetOrigin('data:text/plain,x', origin), false);
});
