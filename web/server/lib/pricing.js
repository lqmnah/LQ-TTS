import { PRICING } from '../config.js';

export const countChars = (text) => [...text].length;

export const creditsFor = (chars) => Math.max(1, Math.ceil((chars * PRICING.creditsPer1kChars) / 1000));

export const rupiahFor = (credits) => credits * PRICING.rupiahPerCredit;

// Display-only approximation; the engine's splitter decides the real sentences.
export function countSentences(text) {
  return text.split(/(?<=[.!?…])\s+|\n+/u).map((s) => s.trim()).filter(Boolean).length;
}

export function makeTitle(text) {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
}
