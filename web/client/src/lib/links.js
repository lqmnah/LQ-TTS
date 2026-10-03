/** Fallback LQ-Studio origin for the sign-up link until `/api/health` answers with `signupUrl`. */
export function lqstudioOrigin(hostname = window.location.hostname) {
  return hostname === 'tts.lq-studio.com' ? 'https://lq-studio.com' : 'https://demo.lq-studio.com';
}

/** Only same-origin app paths are accepted as a post-login destination. */
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/login')) return '/';
  return raw;
}
