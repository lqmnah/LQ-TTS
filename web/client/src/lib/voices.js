export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac'];
// 95 MB: Cloudflare Free rejects bodies over 100 MB at the edge (controller ruling 2026-10-03); the server enforces the same limit.
export const MAX_AUDIO_BYTES = 95 * 1024 * 1024;

/** Browser-side upload check (spec §8.7); returns an i18n key or null. */
export function audioFileProblem(file) {
  if (!file) return 'voices.form.audio_required';
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!AUDIO_EXTENSIONS.includes(ext)) return 'voices.form.audio_type';
  if (file.size === 0) return 'voices.form.audio_empty';
  if (file.size > MAX_AUDIO_BYTES) return 'voices.form.audio_size';
  return null;
}

/** Spec §4: the plan limit counts voices in status processing or ready. */
export function countsTowardLimit(voice) {
  return voice.status === 'processing' || voice.status === 'ready';
}
