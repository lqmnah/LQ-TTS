import { PRICING } from '../config.js';

export const countChars = (text) => [...text].length;

export const creditsFor = (chars) => Math.max(1, Math.ceil((chars * PRICING.creditsPer1kChars) / 1000));

export const rupiahFor = (credits) => credits * PRICING.rupiahPerCredit;

// Display-only approximation; the engine's splitter decides the real sentences.
export function countSentences(text) {
  return text.split(/(?<=[.!?…])\s+|\n+/u).map((s) => s.trim()).filter(Boolean).length;
}

const TITLE_MAX = 60; // code points, ellipsis included
const ELLIPSIS = '…';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Longest prefix of whole graphemes (emoji sequences stay intact) within `budget` code points.
function hardCut(text, budget) {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = countChars(segment);
    if (used + size > budget) break;
    out += segment;
    used += size;
  }
  return out;
}

// One-line title: the whole text if it fits, else its first sentence if that fits,
// else whole words up to the limit followed by a single ellipsis.
export function makeTitle(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (countChars(flat) <= TITLE_MAX) return flat;
  const sentence = flat.match(/^.*?[.!?…](?= |$)/u)?.[0];
  if (sentence && countChars(sentence) <= TITLE_MAX) return sentence;
  const head = hardCut(flat, TITLE_MAX - 1);
  const lastSpace = head.lastIndexOf(' ');
  const words = flat[head.length] === ' ' || lastSpace <= 0 ? head : head.slice(0, lastSpace);
  return `${words.replace(/[\s,;:–—-]+$/u, '')}${ELLIPSIS}`;
}
