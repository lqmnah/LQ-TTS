import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USERS, sessionCookie, startHarness } from './helpers.js';

const hash = (cookie) => crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');

describe('auth, sessions and /api/me', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const login = (body, headers = {}) =>
    request(h.app).post('/api/auth/login').set('x-requested-with', 'lq-tts').set(headers).send(body);
  const twofa = (body) => request(h.app).post('/api/auth/2fa').set('x-requested-with', 'lq-tts').send(body);

  it('logs in by username, forwards the end-user IP in the body only, and sets a hardened cookie', async () => {
    const res = await login({ identifier: 'ANA', password: 'secret-pass' }, { 'cf-connecting-ip': '203.0.113.7' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      user: {
        id: 'ana', name: 'ana', email: 'ana@example.com', plan: 'free', paid: false, lang: 'id', balance: 100,
        voiceLimit: 3, voiceCount: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan',
      },
    });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('lqtts_sid='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const verify = h.lq.state.callsTo('/auth/verify').at(-1);
    expect(verify.body).toEqual({ identifier: 'ANA', password: 'secret-pass', ip: '203.0.113.7' });
    expect(verify.headers['cf-connecting-ip']).toBeUndefined();
  });

  it('stores only a hash of the 256-bit session id', async () => {
    const cookie = await h.login();
    const raw = cookie.split('=')[1];
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    const { rows } = await h.pool.query('SELECT id FROM sessions WHERE user_id = $1', ['ana']);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(hash(cookie));
    expect(ids).not.toContain(raw);
  });

  it('asks for 2FA and opens a session only after a valid code', async () => {
    const first = await login({ identifier: 'tfa@example.com', password: 'secret-pass' });
    expect(first.body).toEqual({ status: 'need_2fa', challenge: expect.any(String) });
    expect(first.headers['set-cookie']).toBeUndefined();
    const bad = await twofa({ challenge: first.body.challenge, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_code');
    expect(bad.headers['set-cookie']).toBeUndefined();
    const ok = await twofa({ challenge: first.body.challenge, code: '123456' });
    expect(ok.body.status).toBe('ok');
    expect(ok.body.user.id).toBe('tfa');
    expect((await h.as(sessionCookie(ok)).get('/api/me')).status).toBe(200);
  });

  it.each([
    ['unverified@example.com', 'secret-pass', 200, { status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/login' }],
    ['ana@example.com', 'wrong', 401, { error: { code: 'invalid_credentials', message: 'wrong email/username or password' } }],
    ['suspended@example.com', 'secret-pass', 403, { error: { code: 'suspended', message: 'this account is suspended' } }],
  ])('maps the LQ-Studio answer for %s', async (identifier, password, status, body) => {
    const res = await login({ identifier, password });
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('passes rate limits through with Retry-After', async () => {
    h.lq.state.rateLimited = true;
    try {
      const res = await login({ identifier: 'ana', password: 'x' });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.body.error.code).toBe('rate_limited');
    } finally {
      h.lq.state.rateLimited = false;
    }
  });

  it('reports an LQ-Studio outage as lqstudio_unavailable', async () => {
    h.lq.state.down = true;
    try {
      const res = await login({ identifier: 'ana', password: 'secret-pass' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('lqstudio_unavailable');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('rejects mutating calls without X-Requested-With before doing anything', async () => {
    const before = h.lq.state.calls.length;
    const res = await request(h.app).post('/api/auth/login').send({ identifier: 'ana', password: 'secret-pass' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_request');
    expect(h.lq.state.calls.length).toBe(before);
  });

  it('rejects requests without a valid session', async () => {
    const res = await request(h.app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect((await request(h.app).get('/api/me').set('cookie', 'lqtts_sid=forged')).status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const cookie = await h.login();
    expect((await h.as(cookie).post('/api/auth/logout')).status).toBe(204);
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [hash(cookie)]);
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('slides the 30-day expiry when the session is used', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET expires_at = now() + interval '2 days' WHERE id = $1`, [hash(cookie)]);
    const res = await h.as(cookie).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^lqtts_sid=/);
    const { rows: [row] } = await h.pool.query(
      `SELECT expires_at > now() + interval '29 days' AS slid FROM sessions WHERE id = $1`, [hash(cookie)],
    );
    expect(row.slid).toBe(true);
  });

  it('switches the language and remembers it on the next login', async () => {
    const cookie = await h.login(USERS.budi);
    expect((await h.as(cookie).patch('/api/me', { lang: 'en' })).body.lang).toBe('en');
    expect((await h.as(cookie).patch('/api/me', { lang: 'fr' })).status).toBe(400);
    const again = await h.login(USERS.budi);
    expect((await h.as(again).get('/api/me')).body).toMatchObject({ lang: 'en', plan: 'pro', paid: true, voiceLimit: 25 });
  });

  it('serves plan and balance from a cache of at most 5 minutes', async () => {
    const cookie = await h.login();
    const before = h.lq.state.callsTo('/users/ana').length;
    h.lq.state.users.get('ana').balance = 42;
    try {
      expect((await h.as(cookie).get('/api/me')).body.balance).toBe(100);
      expect(h.lq.state.callsTo('/users/ana').length).toBe(before);
      await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '301 seconds' WHERE id = $1`, [hash(cookie)]);
      expect((await h.as(cookie).get('/api/me')).body.balance).toBe(42);
      expect(h.lq.state.callsTo('/users/ana').length).toBe(before + 1);
    } finally {
      h.lq.state.users.get('ana').balance = 100;
    }
  });

  it('keeps serving the cached copy while LQ-Studio is down', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '10 minutes' WHERE id = $1`, [hash(cookie)]);
    h.lq.state.down = true;
    try {
      const res = await h.as(cookie).get('/api/me');
      expect(res.status).toBe(200);
      expect(typeof res.body.balance).toBe('number');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('ends every session of an account LQ-Studio now reports suspended', async () => {
    const cookie = await h.login(USERS.poor);
    h.lq.state.users.get('poor').suspended = true;
    try {
      await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '10 minutes' WHERE user_id = 'poor'`);
      const res = await h.as(cookie).get('/api/me');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('suspended');
    } finally {
      h.lq.state.users.get('poor').suspended = false;
    }
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('counts processing and ready voices, not failed ones', async () => {
    const cookie = await h.login(USERS.budi);
    h.engine.addVoice({ owner_ref: 'budi', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'budi', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'budi', status: 'failed', error_code: 'no_clean_speech' });
    expect((await h.as(cookie).get('/api/me')).body.voiceCount).toBe(2);
  });

  it('reports voiceCount null when the engine is unreachable', async () => {
    const cookie = await h.login();
    h.engine.state.failNext.set('GET /v1/voices', { status: 503, code: 'disk_full' });
    const res = await h.as(cookie).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.voiceCount).toBeNull();
  });
});
