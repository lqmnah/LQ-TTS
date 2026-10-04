import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ME_CACHE_MS } from '../services/accounts.js';
import { parseApiKey } from '../services/api-keys.js';
import { createRateLimiter } from '../services/rate-limit.js';
import { USERS, startHarness } from './helpers.js';

const meta = (slug, name) => ({
  slug, name, gender: 'male', language: 'id',
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }],
  bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: name, attestedBy: 'lqmnah', scope: 'Public library voice' },
  sort: 100,
});

describe('createRateLimiter', () => {
  it('allows `limit` hits per window per id and says when the window ends', () => {
    const clock = { now: 0 };
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock.now });
    expect([limiter.hit('a'), limiter.hit('a')]).toEqual([{ ok: true }, { ok: true }]);
    clock.now = 400;
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterS: 1 });
    expect(limiter.hit('b')).toEqual({ ok: true });
    clock.now = 1000;
    expect(limiter.hit('a')).toEqual({ ok: true });
    limiter.hit('a');
    limiter.reset();
    expect(limiter.hit('a')).toEqual({ ok: true });
  });
});

describe('/v1 authentication and account checks', () => {
  let h;
  let key;
  beforeAll(async () => {
    h = await startHarness();
    key = await h.apiKey('budi');
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.ctx.apiLimiter.reset();
    h.ctx.apiAccounts.cache.clear();
    Object.assign(h.lq.state.users.get('cici'), { plan: 'ultra', paid: true, suspended: false, verified: true });
  });
  const usedAt = async (raw) => (await h.pool.query('SELECT last_used_at FROM api_keys WHERE key_id = $1', [parseApiKey(raw).keyId])).rows[0].last_used_at;

  it('answers 401 without a valid Bearer key, whatever cookie comes along', async () => {
    const cookie = await h.login(USERS.budi);
    const tampered = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    for (const req of [
      request(h.app).get('/v1/voices'),
      request(h.app).get('/v1/voices').set('cookie', cookie),
      request(h.app).get('/v1/voices').set('authorization', `Bearer ${tampered}`),
      request(h.app).get('/v1/voices').set('authorization', `Basic ${key}`),
      request(h.app).get('/v1/nope').set('cookie', cookie),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('serves a valid key without cookies or CORS, and a key never opens a cookie route', async () => {
    const res = await h.api(key).get('/v1/voices');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await request(h.app).get('/api/jobs').set('authorization', `Bearer ${key}`)).status).toBe(401);
    const unknown = await h.api(key).get('/v1/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
  });

  it('lists ready own voices and API-allowed active profiles only', async () => {
    const mine = h.engine.addVoice({ owner_ref: 'budi', name: 'Suara Budi' });
    h.engine.addVoice({ owner_ref: 'budi', name: 'Masih proses', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'ana', name: 'Punya Ana' });
    const allowed = h.engine.addVoice({ owner_ref: 'library', name: 'Pandji' });
    const webOnly = h.engine.addVoice({ owner_ref: 'library', name: 'Rina' });
    await h.ctx.profiles.upsert(meta('api-ok', 'Pandji'), allowed.id);
    await h.ctx.profiles.upsert(meta('web-only', 'Rina'), webOnly.id);
    expect(await h.ctx.profiles.setApiAllowed('api-ok', true)).toBe(true);
    expect(await h.ctx.profiles.setApiAllowed('nobody', true)).toBe(false);
    const res = await h.api(key).get('/v1/voices');
    expect(res.body).toEqual({
      voices: [
        { id: mine.id, name: 'Suara Budi', language: 'id', kind: 'own' },
        { id: allowed.id, name: 'Pandji', language: 'id', kind: 'profile', description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' } },
      ],
    });
    await h.ctx.profiles.deactivate('api-ok');
    expect((await h.api(key).get('/v1/voices')).body.voices.map((v) => v.id)).toEqual([mine.id]);
  });

  it('records the last use at most once a minute', async () => {
    await h.pool.query('UPDATE api_keys SET last_used_at = NULL WHERE key_id = $1', [parseApiKey(key).keyId]);
    await h.api(key).get('/v1/voices');
    const first = await usedAt(key);
    expect(first).not.toBeNull();
    await h.api(key).get('/v1/voices');
    expect((await usedAt(key)).getTime()).toBe(first.getTime());
    await h.pool.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE key_id = $1`, [parseApiKey(key).keyId]);
    await h.api(key).get('/v1/voices');
    expect((await usedAt(key)).getTime()).toBeGreaterThan(Date.now() - 30_000);
  });

  it('limits an account to 60 requests a minute across all its keys', async () => {
    const other = await h.apiKey('budi');
    for (let i = 0; i < 60; i += 1) expect((await h.api(i % 2 ? key : other).get('/v1/voices')).status).toBe(200);
    const res = await h.api(key).get('/v1/voices');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await h.api(await h.apiKey('cici')).get('/v1/voices')).status).toBe(200);
  });

  it('rechecks the account at most every five minutes and rides out an LQ-Studio outage on the cached copy', async () => {
    const k = await h.apiKey('cici');
    const reads = () => h.lq.state.calls.filter((c) => c.path === '/users/cici').length;
    expect((await h.api(k).get('/v1/voices')).status).toBe(200);
    const before = reads();
    h.lq.state.users.get('cici').suspended = true;
    expect((await h.api(k).get('/v1/voices')).status).toBe(200); // still inside the 5-minute cache
    expect(reads()).toBe(before);
    h.lq.state.users.get('cici').suspended = false;
    h.ctx.apiAccounts.cache.get('cici').at -= ME_CACHE_MS;
    h.lq.state.down = true;
    try {
      expect((await h.api(k).get('/v1/voices')).status).toBe(200);
      expect((await h.api(k).get('/v1/voices')).status).toBe(200);
      expect(reads()).toBe(before + 1); // asked once, then waits OUTAGE_RETRY_MS
      h.ctx.apiAccounts.cache.clear();
      const cold = await h.api(k).get('/v1/voices');
      expect(cold.status).toBe(503);
      expect(cold.body.error.code).toBe('lqstudio_unavailable');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('revokes the keys of a suspended account', async () => {
    const k = await h.apiKey('cici');
    h.lq.state.users.get('cici').suspended = true;
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('suspended');
    h.lq.state.users.get('cici').suspended = false;
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'suspended' }));
  });

  it('refuses an unverified account without revoking its key', async () => {
    const k = await h.apiKey('cici');
    h.lq.state.users.get('cici').verified = false;
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('needs_verification');
    h.lq.state.users.get('cici').verified = true;
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(200);
  });

  it('revokes the keys of an account that drops below Pro', async () => {
    const k = await h.apiKey('cici');
    Object.assign(h.lq.state.users.get('cici'), { plan: 'free', paid: false });
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_required');
    Object.assign(h.lq.state.users.get('cici'), { plan: 'ultra', paid: true });
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'plan' }));
  });

  it('revokes keys made before a password change or log-out-everywhere, keeps newer ones', async () => {
    const before = await h.apiKey('cici', { tv: 0 });
    h.lq.bumpTv('cici');
    const res = await h.api(before).get('/v1/voices');
    expect(res.status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'tv' }));
    const after = await h.apiKey('cici', { tv: 1 });
    expect((await h.api(after).get('/v1/voices')).status).toBe(200);
  });

  it('revokes the keys of an account LQ-Studio no longer knows', async () => {
    const k = await h.apiKey('cici');
    const saved = h.lq.state.users.get('cici');
    h.lq.state.users.delete('cici');
    try {
      expect((await h.api(k).get('/v1/voices')).status).toBe(401);
      expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'account_gone' }));
    } finally {
      h.lq.state.users.set('cici', saved);
    }
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
  });

  it('sends the spec addresses of the API page and its docs to the app routes', async () => {
    const page = await request(h.app).get('/api');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/api-keys');
    const docs = await request(h.app).get('/api/docs');
    expect(docs.status).toBe(302);
    expect(docs.headers.location).toBe('/developers');
  });
});
