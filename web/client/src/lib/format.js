const LOCALES = { id: 'id-ID', en: 'en-US' };
const DASH = '–';

export function formatDateTime(iso, lang) {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.id, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes, lang) {
  const locale = LOCALES[lang] ?? LOCALES.id;
  if (bytes < 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`;
  }
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
}
