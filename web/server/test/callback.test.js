import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifySignature } from '../routes/callback.js';
import { USERS, signCallback, startHarness } from './helpers.js';

describe('verifySignature', () => {
  // Vector produced by the engine itself: lq_tts_engine.callbacks.sign("callback-test-secret", "1700000000", body)
  const body = Buffer.from('{"job_id":"00000000-0000-4000-8000-000000000000","status":"done","revision":1}');
  const sig = 'sha256=30055abf79cae25a7690d14507b83a13da137680b9d70ba0de7b6422160ef12c';

  it("accepts the engine's own signature and rejects stale or altered ones", () => {
    expect(verifySignature('callback-test-secret', '1700000000', body, sig, 1700000000)).toBe(true);
    expect(verifySignature('callback-test-secret', '1700000000', body, sig, 1700000301)).toBe(false);
    expect(verifySignature('other-secret', '1700000000', body, sig, 1700000000)).toBe(false);
    expect(verifySignature('callback-test-secret', '1700000000', Buffer.from(`${body} `), sig, 1700000000)).toBe(false);
    expect(verifySignature('callback-test-secret', 'abc', body, sig, 1700000000)).toBe(false);
  });
});

describe('engine callback', () => {
  let h;
  let ana;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const heldJob = async (text = 'Halo dunia.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const charges = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;
  const callback = (payload, opts) => {
    const { body, headers } = signCallback(payload, opts);
    return request(h.app).post('/api/internal/engine-callback').set(headers).send(body);
  };
  const settlesFor = (holdId) => h.lq.state.callsTo('/credits/settle').filter((c) => c.body.holdId === holdId);

  it('settles a finished job exactly once, even when the callback repeats', async () => {
    const id = await heldJob();
    h.engine.setJob(id, { status: 'done', audio_seconds: 2.5 });
    const res = await callback({ job_id: id, status: 'done', revision: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [c] = await charges(id);
    expect(c.state).toBe('settled');
    expect(c.resolved_at).not.toBeNull();
    expect(settlesFor(c.hold_id).map((x) => x.body)).toEqual([{ userId: 'ana', holdId: c.hold_id, amount: 1 }]);
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    expect(settlesFor(c.hold_id)).toHaveLength(1);
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'done', audioSeconds: 2.5 });
    expect(job.finishedAt).not.toBeNull();
  });

  it.each(['failed', 'canceled'])('refunds a %s job in full', async (status) => {
    const id = await heldJob();
    h.engine.setJob(id, { status });
    expect((await callback({ job_id: id, status, revision: 1 })).status).toBe(200);
    const [c] = await charges(id);
    expect(c.state).toBe('refunded');
    expect(h.lq.state.net(c.hold_id)).toBe(0);
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('rejects wrong, stale and tampered signatures without moving money', async () => {
    const id = await heldJob();
    const lqCalls = h.lq.state.calls.length;
    expect((await callback({ job_id: id, status: 'failed', revision: 1 }, { secret: 'wrong-secret' })).status).toBe(401);
    expect((await callback({ job_id: id, status: 'failed', revision: 1 }, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await callback({ job_id: id, status: 'failed', revision: 1 }, { ts: Math.floor(Date.now() / 1000) + 301 })).status).toBe(401);
    const { body, headers } = signCallback({ job_id: id, status: 'done', revision: 1 });
    const tampered = await request(h.app).post('/api/internal/engine-callback').set(headers).send(body.replace('done', 'failed'));
    expect(tampered.status).toBe(401);
    expect((await request(h.app).post('/api/internal/engine-callback').send('{}')).status).toBe(401);
    expect(h.lq.state.calls.length).toBe(lqCalls);
    expect((await charges(id))[0].state).toBe('held');
  });

  it('acknowledges callbacks for jobs it does not know', async () => {
    const res = await callback({ job_id: '00000000-0000-4000-8000-000000000000', status: 'done', revision: 1 });
    expect(res.status).toBe(200);
  });

  it('answers 503 so the engine retries when LQ-Studio is down, and counts the attempt', async () => {
    const id = await heldJob();
    h.lq.state.failNext.set('POST /credits/settle', 1);
    const res = await callback({ job_id: id, status: 'done', revision: 1 });
    expect(res.status).toBe(503);
    expect((await charges(id))[0]).toMatchObject({ state: 'held', attempts: 1 });
    expect((await charges(id))[0].last_error).not.toBeNull();
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    expect((await charges(id))[0].state).toBe('settled');
  });

  it('answers 503 when the webhook cannot be recorded, so the engine retries', async () => {
    const id = await heldJob();
    h.engine.setJob(id, { status: 'done' });
    const { onTerminal } = h.ctx.webhooks;
    h.ctx.webhooks.onTerminal = async () => {
      throw new Error('db down');
    };
    try {
      expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(503);
    } finally {
      h.ctx.webhooks.onTerminal = onTerminal;
    }
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'webhook_enqueue_failed', jobId: id }));
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    expect((await charges(id))[0].state).toBe('settled');
  });

  it('a late retry for an older revision leaves the newer regeneration alone', async () => {
    const id = await heldJob('Satu. Dua.');
    h.engine.setJob(id, { status: 'done' });
    await callback({ job_id: id, status: 'done', revision: 1 });
    expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
    await h.pool.query(`UPDATE charges SET created_at = now() - interval '10 minutes' WHERE job_id = $1`, [id]);
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    const all = await charges(id);
    expect(all.map((c) => [c.revision, c.state])).toEqual([[1, 'settled'], [2, 'held']]);
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'queued', revision: 2 });
  });

  it('rejects a signed body that is not a terminal job event', async () => {
    const res = await callback({ job_id: 'nope', status: 'running', revision: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
