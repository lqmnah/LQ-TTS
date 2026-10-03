/**
 * Speculative loads are not the app's traffic: Cloudflare Speed Brain (zone-wide Speculation-Rules) makes Chromium
 * prefetch links, and Cloudflare answers an uncached prefetch with an empty 503. Such requests carry
 * `Sec-Purpose: prefetch` (or `prefetch;prerender`); nothing else does.
 * @param {Record<string, string>} headers request headers with lower-case names (Playwright's form)
 */
export function isSpeculativePrefetch(headers) {
  return (headers['sec-purpose'] ?? '').split(/[;,]/).some((token) => token.trim().toLowerCase() === 'prefetch');
}

/**
 * Whether a request goes to the target origin, the only one that may receive the Cloudflare Access service token.
 * @param {string} url
 * @param {string} targetOrigin e.g. `https://tts-stg.lq-studio.com`
 */
export function isTargetOrigin(url, targetOrigin) {
  try {
    return new URL(url).origin === targetOrigin;
  } catch {
    return false;
  }
}
