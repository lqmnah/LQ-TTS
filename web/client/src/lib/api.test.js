// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildVoiceForm, onUnauthorized, urls } from './api.js';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const html = (status) => new Response('<html>Cloudflare</html>', { status, headers: { 'Content-Type': 'text/html' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('error mapping', () => {
  it('turns {error:{code,message}} into an ApiError with that code', async () => {
    fetch.mockResolvedValue(json(402, { error: { code: 'insufficient_credits', message: 'need 12, have 3' } }));
    await expect(api.createJob('v1', 'Halo.', {})).rejects.toMatchObject({
      name: 'ApiError', status: 402, code: 'insufficient_credits', message: 'need 12, have 3',
    });
  });

  it('keeps the server code for 409 and 500 answers', async () => {
    fetch.mockResolvedValueOnce(json(409, { error: { code: 'voice_not_ready', message: 'upload in progress' } }));
    await expect(api.createJob('v1', 'Halo.', {})).rejects.toMatchObject({ status: 409, code: 'voice_not_ready' });
    fetch.mockResolvedValueOnce(json(409, { error: { code: 'not_regeneratable', message: 'busy' } }));
    await expect(api.cancelJob('j1')).rejects.toMatchObject({ status: 409, code: 'not_regeneratable' });
    fetch.mockResolvedValueOnce(json(500, { error: { code: 'internal_error', message: 'internal error' } }));
    await expect(api.voices()).rejects.toMatchObject({ status: 500, code: 'internal_error' });
  });

  it('falls back by status when the body is not JSON', async () => {
    fetch.mockResolvedValueOnce(html(413));
    await expect(api.voices()).rejects.toMatchObject({ code: 'too_large' });
    fetch.mockResolvedValueOnce(html(502));
    await expect(api.voices()).rejects.toMatchObject({ code: 'network' });
    fetch.mockResolvedValueOnce(html(500));
    await expect(api.voices()).rejects.toMatchObject({ code: 'generic' });
  });

  it('reads retryAfter from the body first, then from Retry-After', async () => {
    fetch.mockResolvedValueOnce(json(429, { error: { code: 'rate_limited', retryAfter: 30 } }));
    await expect(api.login('ana', 'x')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30 });
    fetch.mockResolvedValueOnce(json(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '45' }));
    await expect(api.login('ana', 'x')).rejects.toMatchObject({ retryAfter: 45 });
  });

  it('wraps a rejected fetch as a network error', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api.me().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
  });

  it('notifies the session only for an expired session, not for a wrong password', async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    fetch.mockResolvedValueOnce(json(401, { error: { code: 'invalid_credentials' } }));
    await api.login('ana', 'bad').catch(() => {});
    expect(seen).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json(401, { error: { code: 'unauthorized' } }));
    await api.me().catch(() => {});
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('ends the session for a suspended or unverified account outside /auth', async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    fetch.mockResolvedValueOnce(json(403, { error: { code: 'suspended' } }));
    await api.voices().catch(() => {});
    fetch.mockResolvedValueOnce(json(403, { error: { code: 'needs_verification' } }));
    await api.regenerate('j1', 0, { text: 'Baru.' }).catch(() => {});
    expect(seen.mock.calls.map(([e]) => e.code)).toEqual(['suspended', 'needs_verification']);
    fetch.mockResolvedValueOnce(json(403, { error: { code: 'voice_limit_reached' } }));
    await api.voices().catch(() => {});
    fetch.mockResolvedValueOnce(json(403, { error: { code: 'suspended' } }));
    await api.login('ana', 'x').catch(() => {});
    fetch.mockResolvedValueOnce(json(401, { error: { code: 'unauthorized' } }));
    await api.logout().catch(() => {});
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('requests', () => {
  it('sends the CSRF header on mutating requests only', async () => {
    fetch.mockImplementation(async () => json(200, { ok: true }));
    await api.voices();
    expect(fetch.mock.calls[0][1].headers['X-Requested-With']).toBeUndefined();
    await api.setLang('en');
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('/api/me');
    expect(init.method).toBe('PATCH');
    expect(init.headers['X-Requested-With']).toBe('lq-tts');
    expect(JSON.parse(init.body)).toEqual({ lang: 'en' });
    expect(init.credentials).toBe('same-origin');
  });

  it('returns null for 204', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteJob('j1')).resolves.toBeNull();
  });

  it('passes the opaque history cursor back unchanged', async () => {
    const cursor = '2026-10-03T10:00:00.123456Z|0b6c5d2e-8f1a-4c3b-9d7e-2a1f0e9c8b7a';
    fetch.mockResolvedValue(json(200, { items: [], nextBefore: null }));
    await api.jobs({ limit: 20, before: cursor });
    const url = new URL(fetch.mock.calls[0][0], 'http://x');
    expect(url.pathname).toBe('/api/jobs');
    expect(url.search).toBe('?limit=20&before=2026-10-03T10%3A00%3A00.123456Z%7C0b6c5d2e-8f1a-4c3b-9d7e-2a1f0e9c8b7a');
    expect(url.searchParams.get('before')).toBe(cursor);
  });

  it('omits unchanged fields from a regenerate body', async () => {
    fetch.mockResolvedValue(json(202, { revision: 2, credits: 1 }));
    await api.regenerate('j1', 3, { text: 'Kalimat baru.' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/jobs/j1/sentences/3/regenerate');
    expect(JSON.parse(init.body)).toEqual({ text: 'Kalimat baru.' });
  });
});

describe('buildVoiceForm', () => {
  it('appends text fields first and the audio file last', () => {
    const file = new File(['RIFF'], 'pandji.wav', { type: 'audio/wav' });
    const form = buildVoiceForm({ file, name: 'Pandji', language: 'id', transcript: 'Halo semua.', consent: true });
    expect([...form.keys()]).toEqual(['name', 'language', 'transcript', 'consent', 'audio']);
    expect(form.get('consent')).toBe('true');
  });
  it('skips an empty transcript', () => {
    const file = new File(['RIFF'], 'a.wav', { type: 'audio/wav' });
    const form = buildVoiceForm({ file, name: 'A', language: 'auto', transcript: '', consent: true });
    expect([...form.keys()]).toEqual(['name', 'language', 'consent', 'audio']);
  });
});

describe('urls', () => {
  it('encodes ids and carries revision or cache version', () => {
    expect(urls.file('j/1', 'final.mp3', 2)).toBe('/api/jobs/j%2F1/files/final.mp3?revision=2');
    expect(urls.file('j1', 'subs.srt')).toBe('/api/jobs/j1/files/subs.srt');
    expect(urls.sentenceAudio('j1', 4, 3)).toBe('/api/jobs/j1/sentences/4/audio?v=3');
    expect(urls.voicePreview('v1')).toBe('/api/voices/v1/preview');
    expect(urls.events('j1')).toBe('/api/jobs/j1/events');
  });
});
