import { describe, expect, it } from 'vitest';
import { countChars, countSentences, creditsFor, makeTitle, rupiahFor } from '../lib/pricing.js';

describe('pricing', () => {
  it.each([[1, 1], [100, 1], [101, 2], [999, 10], [1000, 10], [1001, 11], [20000, 200]])(
    '%i chars cost %i credits', (chars, credits) => {
      expect(creditsFor(chars)).toBe(credits);
    },
  );

  it('prices one credit at Rp100', () => {
    expect(rupiahFor(11)).toBe(1100);
  });

  it('counts code points like the engine (an emoji is one character)', () => {
    expect(countChars('halo 👋')).toBe(6);
  });

  it('makes a one-line title of at most 60 characters', () => {
    expect(makeTitle('  Halo\n\n dunia  ')).toBe('Halo dunia');
    expect([...makeTitle(`${'a'.repeat(59)}👋👋`)]).toHaveLength(60);
  });

  it('approximates the sentence count', () => {
    expect(countSentences('Halo. Apa kabar? Baik!\n\nParagraf dua')).toBe(4);
    expect(countSentences('   ')).toBe(0);
  });
});
