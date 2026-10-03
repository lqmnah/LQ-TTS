import { describe, expect, it } from 'vitest';
import { CREDITS_PER_1K_CHARS, RUPIAH_PER_CREDIT, charCount, creditsFor, formatNumber, formatRupiah, rupiahFor } from './pricing.js';

describe('creditsFor (spec §4: max(1, ceil(chars/1000*10)))', () => {
  it('charges nothing for an empty script', () => {
    expect(creditsFor(0)).toBe(0);
  });
  it('charges the 1-credit minimum for tiny scripts', () => {
    expect(creditsFor(1)).toBe(1);
    expect(creditsFor(100)).toBe(1);
  });
  it('rounds up at every 100 characters', () => {
    expect(creditsFor(101)).toBe(2);
    expect(creditsFor(1000)).toBe(10);
    expect(creditsFor(1001)).toBe(11);
    expect(creditsFor(20000)).toBe(200);
  });
  it('uses the configured constants', () => {
    expect(CREDITS_PER_1K_CHARS).toBe(10);
    expect(RUPIAH_PER_CREDIT).toBe(100);
    expect(rupiahFor(11)).toBe(1100);
  });
});

describe('charCount', () => {
  it('counts code points, not UTF-16 units (matches the Python engine)', () => {
    expect(charCount('abc')).toBe(3);
    expect(charCount('é')).toBe(1);
    expect(charCount('𝄞')).toBe(1);
  });
});

describe('number formatting', () => {
  it('groups thousands per language', () => {
    expect(formatNumber(20000, 'id')).toBe('20.000');
    expect(formatNumber(20000, 'en')).toBe('20,000');
  });
  it('writes rupiah without a space, as in the spec', () => {
    expect(formatRupiah(1100, 'id')).toBe('Rp1.100');
    expect(formatRupiah(1100, 'en')).toBe('Rp1,100');
  });
});
