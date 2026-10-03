import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USERS, startHarness } from './helpers.js';

const hash = (cookie) => crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');

// C1 amendment C: tokenVersion (`tv`) revocation, suspended holds, guard rate limits without retryAfter.
describe('C1 amendment C', () => {
  let h;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    voice = h.engine.addVoice({ owner_ref: 'ana', name: 'Suara Ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  const row = async (cookie) => (await h.pool.query('SELECT * FROM sessions WHERE id = $1', [hash(cookie)])).rows[0];
  const expire = (cookie) =>
    h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '301 seconds' WHERE id = $1`, [hash(cookie)]);

  it('revokes sessions from before a tokenVersion bump and keeps the ones opened after it', async () => {
    const old = await h.login(USERS.budi);
    const older = await h.login(USERS.budi);
    expect((await row(old)).user_tv).toBe(0);
    h.lq.bumpTv('budi');
    const fresh = await h.login(USERS.budi);
    expect((await row(fresh)).user_tv).toBe(1);
    await expire(old);
    const res = await h.as(old).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect((await row(old)).revoked_at).not.toBeNull();
    expect((await row(older)).revoked_at).not.toBeNull();
    expect((await h.as(older).get('/api/me')).status).toBe(401);
    expect((await row(fresh)).revoked_at).toBeNull();
    await expire(fresh);
    const again = await h.as(fresh).get('/api/me');
    expect(again.status).toBe(200);
    expect((await row(fresh)).revoked_at).toBeNull();
  });

  it('refuses a job for a user suspended after login, ends their sessions and keeps their credits', async () => {
    const a = await h.login(USERS.ana);
    const b = await h.login(USERS.ana);
    const ana = h.lq.state.users.get('ana');
    const jobs = h.engine.state.jobs.size;
    ana.suspended = true;
    try {
      const res = await h.as(a).post('/api/jobs', { voiceId: voice.id, text: 'Halo dunia.' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('suspended');
      expect(h.engine.state.jobs.size).toBe(jobs);
      expect(ana.balance).toBe(100);
      const { ref } = h.lq.state.callsTo('/credits/hold').at(-1).body;
      expect(h.lq.state.net(ref)).toBe(0);
      // The outcome of a replayed hold is unknown, so the charge waits for reconciliation, which finds nothing held.
      const { rows: [charge] } = await h.pool.query('SELECT * FROM charges WHERE hold_id = $1', [ref]);
      expect(charge).toMatchObject({ state: 'held', job_id: null });
      await h.pool.query(`UPDATE charges SET created_at = now() - interval '3 minutes' WHERE id = $1`, [charge.id]);
      expect(await h.ctx.charges.resolveOne(charge, null)).toBe(true);
      const { rows: held } = await h.pool.query(`SELECT * FROM charges WHERE user_id = 'ana' AND state = 'held'`);
      expect(held).toEqual([]);
      expect(ana.balance).toBe(100);
      for (const cookie of [a, b]) {
        expect((await row(cookie)).revoked_at).not.toBeNull();
        expect((await h.as(cookie).get('/api/me')).status).toBe(401);
      }
    } finally {
      ana.suspended = false;
    }
  });

  it('passes a guard rate limit without retryAfter to the browser as 429 and keeps serving', async () => {
    const cookie = await h.login(USERS.ana);
    h.lq.state.guardRateLimited = true;
    try {
      const login = await request(h.app).post('/api/auth/login').set('x-requested-with', 'lq-tts')
        .send({ identifier: 'ana', password: 'secret-pass' });
      expect(login.status).toBe(429);
      expect(login.body.error.code).toBe('rate_limited');
      const job = await h.as(cookie).post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
      expect(job.status).toBe(429);
      expect(job.body.error.code).toBe('rate_limited');
    } finally {
      h.lq.state.guardRateLimited = false;
    }
    expect((await h.as(cookie).get('/api/me')).status).toBe(200);
  });

  it('a post-bump session refreshing first still ends the pre-bump ones', async () => {
    const old = await h.login(USERS.poor);
    h.lq.bumpTv('poor');
    const fresh = await h.login(USERS.poor);
    await expire(old);
    await expire(fresh);
    expect((await h.as(fresh).get('/api/me')).status).toBe(200);
    expect((await row(old)).revoked_at).not.toBeNull();
    expect((await h.as(old).get('/api/me')).status).toBe(401);
  });

  it('binds the session to the tv of the verified login, not of the later user read', async () => {
    h.lq.state.beforeGetUser = (u) => {
      h.lq.state.beforeGetUser = null;
      u.tv += 1; // password changed between verify and users/:id
    };
    const cookie = await h.login(USERS.ana);
    expect(h.lq.state.beforeGetUser).toBeNull();
    expect((await row(cookie)).user_tv).toBe(h.lq.state.users.get('ana').tv - 1);
    await expire(cookie);
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
    expect((await row(cookie)).revoked_at).not.toBeNull();
  });
});
