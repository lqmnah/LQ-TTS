import crypto from 'node:crypto';
import { Agent } from 'undici';
import { parseResponse, requestJson, UpstreamUnavailable } from './http.js';

// An SSE stream may stay silent for minutes between events; undici's default 300 s bodyTimeout would cut it.
const sseDispatcher = new Agent({ bodyTimeout: 0 });

export function createEngine({ baseUrl, token, timeoutMs = 15000 }) {
  const call = (method, path, body, headers) =>
    requestJson('engine', `${baseUrl}${path}`, { method, token, body, headers, timeoutMs });
  return {
    async health() {
      try {
        const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(3000) });
        await res.body?.cancel();
        return res.ok ? 'ok' : 'restarting';
      } catch {
        return 'restarting';
      }
    },
    listVoices: (ownerRef) => call('GET', `/v1/voices?owner_ref=${encodeURIComponent(ownerRef)}`),
    getVoice: (id) => call('GET', `/v1/voices/${id}`),
    deleteVoice: (id) => call('DELETE', `/v1/voices/${id}`),
    createJob: ({ voiceId, text, settings, callbackUrl, idempotencyKey }) =>
      call('POST', '/v1/jobs', { voice_id: voiceId, text, settings, callback_url: callbackUrl }, { 'idempotency-key': idempotencyKey }),
    getJob: (id) => call('GET', `/v1/jobs/${id}`),
    sentences: (id) => call('GET', `/v1/jobs/${id}/sentences`),
    regenerate: (id, idx, { text, style }) => call('POST', `/v1/jobs/${id}/sentences/${idx}/regenerate`, { text, style }),
    cancel: (id) => call('POST', `/v1/jobs/${id}/cancel`),
    deleteJob: (id) => call('DELETE', `/v1/jobs/${id}`),

    // Long-lived or binary responses: the caller pipes res.body. Non-2xx answers throw like requestJson.
    // `sse: true` lifts the body idle timeout for event streams; binary relays keep the default.
    async stream(path, { headers = {}, signal, sse = false } = {}) {
      let res;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${token}`, ...headers },
          signal,
          ...(sse ? { dispatcher: sseDispatcher } : {}),
        });
      } catch (err) {
        throw new UpstreamUnavailable('engine', err);
      }
      if (!res.ok) await parseResponse('engine', res);
      return res;
    },

    // Re-encodes one file plus text fields as multipart and streams it; memory use stays at one chunk.
    async uploadVoice({ fields, filename, mimeType, file, signal }) {
      const boundary = `lqtts-${crypto.randomBytes(16).toString('hex')}`;
      const safeName = String(filename || 'audio').replace(/["\r\n\\]/g, '_');
      async function* parts() {
        for (const [name, value] of Object.entries(fields)) {
          if (value === undefined || value === null || value === '') continue;
          yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
        }
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${safeName}"\r\n`
          + `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
        );
        for await (const chunk of file) yield chunk;
        if (file.truncated) throw new Error('upload exceeded the size limit');
        yield Buffer.from(`\r\n--${boundary}--\r\n`);
      }
      let res;
      try {
        res = await fetch(`${baseUrl}/v1/voices`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: ReadableStream.from(parts()),
          duplex: 'half',
          signal,
        });
      } catch (err) {
        throw new UpstreamUnavailable('engine', err);
      }
      return parseResponse('engine', res);
    },
  };
}
