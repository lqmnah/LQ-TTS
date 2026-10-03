export const CREDITS_PER_1K_CHARS = 10;
export const RUPIAH_PER_CREDIT = 100;

const LOCALES = { id: 'id-ID', en: 'en-US' };

/** Number of Unicode code points (the engine counts characters the same way). */
export function charCount(text) {
  return [...text].length;
}

/** Spec §4: credits = max(1, ceil(chars / 1000 × 10)); an empty script costs nothing. */
export function creditsFor(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil((chars * CREDITS_PER_1K_CHARS) / 1000));
}

export function rupiahFor(credits) {
  return credits * RUPIAH_PER_CREDIT;
}

export function formatNumber(n, lang) {
  return new Intl.NumberFormat(LOCALES[lang] ?? LOCALES.id).format(n);
}

export function formatRupiah(n, lang) {
  return `Rp${formatNumber(n, lang)}`;
}
