import { requestJson } from './http.js';

export function createLqStudio({ baseUrl, token, timeoutMs = 10000 }) {
  const call = (method, path, body) =>
    requestJson('lqstudio', `${baseUrl}/api/internal/tts${path}`, { method, token, body, timeoutMs });
  return {
    verify: ({ identifier, password, ip }) => call('POST', '/auth/verify', { identifier, password, ip }),
    verify2fa: ({ challenge, code, ip }) => call('POST', '/auth/verify-2fa', { challenge, code, ip }),
    getUser: (id) => call('GET', `/users/${encodeURIComponent(id)}`),
    hold: ({ userId, amount, ref }) => call('POST', '/credits/hold', { userId, amount, ref }),
    settle: ({ userId, holdId, amount }) => call('POST', '/credits/settle', { userId, holdId, amount }),
    refund: ({ userId, holdId }) => call('POST', '/credits/refund', { userId, holdId }),
    async ping() {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
        await res.body?.cancel();
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
