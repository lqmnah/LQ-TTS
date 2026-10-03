export const FORMATS = ['mp3', 'wav', 'srt', 'vtt'];
export const MAX_SCRIPT_CHARS = 20000;
export const DEFAULT_SETTINGS = Object.freeze({ speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: FORMATS });

const keyFor = (userId) => `lqtts_draft:${userId}`;
const clamp = (value, lo, hi, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback);

export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    speed: clamp(s.speed, 0.7, 1.3, 0.9),
    pause_sentence_s: clamp(s.pause_sentence_s, 0, 3, 0.45),
    pause_paragraph_s: clamp(s.pause_paragraph_s, 0, 3, 0.8),
    formats: Array.isArray(s.formats) ? FORMATS.filter((f) => s.formats.includes(f)) : [...FORMATS],
  };
}

export function loadDraft(userId) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(keyFor(userId)) ?? 'null');
    if (raw && typeof raw.text === 'string') {
      return { text: raw.text, voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '', settings: normalizeSettings(raw.settings) };
    }
  } catch {
    // A corrupted draft is discarded.
  }
  return { text: '', voiceId: '', settings: normalizeSettings(DEFAULT_SETTINGS) };
}

export function saveDraft(userId, draft) {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(draft));
  } catch {
    // Storage full or disabled: the draft only lives in memory.
  }
}
