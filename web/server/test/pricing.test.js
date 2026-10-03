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

  describe('makeTitle', () => {
    const len = (s) => [...s].length;
    const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

    it('keeps short text unchanged', () => {
      expect(makeTitle('Halo. Apa kabar?')).toBe('Halo. Apa kabar?');
      expect(makeTitle('x'.repeat(60))).toBe('x'.repeat(60));
    });

    it('collapses spaces and newlines into single spaces', () => {
      expect(makeTitle('  Halo\n\n dunia \t lagi  ')).toBe('Halo dunia lagi');
    });

    it('takes the first sentence when the whole text is too long', () => {
      expect(makeTitle(`Halo dunia. ${'Kalimat kedua yang panjang sekali. '.repeat(3)}`)).toBe('Halo dunia.');
    });

    it('cuts a long sentence at the last word boundary and appends one ellipsis', () => {
      const title = makeTitle('Halo, ini uji suara dari LQ TTS untuk memastikan semuanya berjalan dengan baik dan lancar');
      expect(title).toBe('Halo, ini uji suara dari LQ TTS untuk memastikan semuanya…');
    });

    it('cuts multi-space, multi-line input on a word boundary', () => {
      const title = makeTitle(`satu  dua\n\ntiga ${'kata '.repeat(20)}`);
      expect(title).toBe(`satu dua tiga ${Array(9).fill('kata').join(' ')}…`);
      expect(len(title)).toBeLessThanOrEqual(60);
    });

    it('hard-cuts a single word longer than the limit', () => {
      expect(makeTitle('a'.repeat(100))).toBe(`${'a'.repeat(59)}…`);
      expect(makeTitle(`${'a'.repeat(100)} dua`)).toBe(`${'a'.repeat(59)}…`);
    });

    it('never splits an emoji, a surrogate pair or a joined emoji sequence', () => {
      const title = makeTitle('👋'.repeat(100));
      expect(title).toBe(`${'👋'.repeat(59)}…`);
      expect(hasLoneSurrogate(title)).toBe(false);
      expect(makeTitle(`${'a'.repeat(58)}👨‍👩‍👧`)).toBe(`${'a'.repeat(58)}…`);
    });
  });

  it('approximates the sentence count', () => {
    expect(countSentences('Halo. Apa kabar? Baik!\n\nParagraf dua')).toBe(4);
    expect(countSentences('   ')).toBe(0);
  });
});
