import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS, startHarness } from './helpers.js';

describe('regenerate, cancel and delete', () => {
  let h;
  let ana;
  let budi;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    budi = h.as(await h.login(USERS.budi));
    voice = h.engine.addVoice({ owner_ref: 'ana', name: 'Suara Ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const newJob = async (text = 'Satu. Dua.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const doneJob = async (text) => {
    const id = await newJob(text);
    h.engine.setJob(id, { status: 'done' });
    return id;
  };
  const charges = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;
  const holdsFor = (prefix) => h.lq.state.callsTo('/credits/hold').filter((c) => c.body.ref.startsWith(prefix));

  it('holds credits for one sentence and queues a new revision', async () => {
    const id = await doneJob();
    const res = await ana.post(`/api/jobs/${id}/sentences/1/regenerate`, { text: ' Dua lagi. ', style: 'calm' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ revision: 2, credits: 1 });
    expect(holdsFor(`tts:${id}:`).at(-1).body).toEqual({ userId: 'ana', amount: 1, ref: `tts:${id}:r2:s1` });
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').at(-1).body).toEqual({ text: 'Dua lagi.', style: 'calm' });
    expect((await charges(id)).at(-1)).toMatchObject({ kind: 'regenerate', revision: 2, sentence_idx: 1, chars: 9, credits: 1, state: 'held' });
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'queued', revision: 2, credits: 2 });
  });

  it('refuses unfinished jobs before holding anything', async () => {
    const id = await newJob();
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(0);
    expect((await ana.post(`/api/jobs/${await doneJob()}/sentences/9/regenerate`, {})).status).toBe(404);
  });

  it('refunds when the engine rejects the regeneration and uses a fresh ref for the retry', async () => {
    const id = await doneJob();
    h.engine.state.failNext.set('POST /v1/jobs/:id/sentences/:idx/regenerate', { status: 400, code: 'invalid_text', message: 'text must be exactly one sentence' });
    const bad = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, { text: 'Satu. Dua.' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: 'invalid_request', message: 'text must be exactly one sentence' });
    expect(h.lq.state.net(`tts:${id}:r2:s0`)).toBe(0);
    expect((await charges(id)).at(-1).state).toBe('refunded');
    const retry = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(retry.status).toBe(202);
    expect(holdsFor(`tts:${id}:`).at(-1).body.ref).toBe(`tts:${id}:r2:s0:a2`);
    expect(h.lq.state.net(`tts:${id}:r2:s0:a2`)).toBe(1);
  });

  it('answers 402 and queues nothing when the balance is too low', async () => {
    const id = await doneJob();
    h.lq.state.users.get('ana').balance = 0;
    const regenCalls = h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length;
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('insufficient_credits');
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length).toBe(regenCalls);
    expect((await charges(id)).filter((c) => c.kind === 'regenerate')).toHaveLength(0);
  });

  it('refuses a second regeneration of a sentence while one is held', async () => {
    const id = await doneJob();
    await h.pool.query(
      `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id)
       VALUES ('ana', $1, 2, 'regenerate', 0, 4, 1, $2)`,
      [id, `tts:${id}:r2:s0`],
    );
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(0);
  });

  it('refuses to regenerate any sentence while another change on the job is still held', async () => {
    const id = await doneJob();
    // A sentence-0 charge for the next revision left held, as when an unknown hold's refund answered 404.
    await h.pool.query(
      `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id)
       VALUES ('ana', $1, 2, 'regenerate', 0, 4, 1, $2)`,
      [id, `tts:${id}:r2:s0`],
    );
    const regenCalls = h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length;
    const balance = h.lq.state.users.get('ana').balance;
    const res = await ana.post(`/api/jobs/${id}/sentences/1/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'not_regeneratable', message: 'a previous change on this job is still being settled; try again shortly' });
    expect(holdsFor(`tts:${id}:`)).toHaveLength(0);
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length).toBe(regenCalls);
    expect(h.lq.state.users.get('ana').balance).toBe(balance);
  });

  it('records the revision the engine assigned on the charge', async () => {
    const id = await doneJob();
    const regenerate = h.ctx.engine.regenerate;
    h.ctx.engine.regenerate = async (...args) => {
      const out = await regenerate(...args);
      return { ...out, revision: out.revision + 1 };
    };
    let res;
    try {
      res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    } finally {
      h.ctx.engine.regenerate = regenerate;
    }
    expect(res.status).toBe(202);
    expect(res.body.revision).toBe(3);
    const charge = (await charges(id)).at(-1);
    expect(charge).toMatchObject({ kind: 'regenerate', revision: 3, state: 'held', hold_id: `tts:${id}:r2:s0` });
  });

  it('holds exactly once when two regenerations of a sentence race', async () => {
    const id = await doneJob();
    // Hold both requests after their "already held?" check so each passes it before either inserts:
    // only the unique hold ref can then stop the second hold.
    const query = h.pool.query;
    let release;
    const bothChecked = new Promise((r) => { release = r; });
    let checks = 0;
    h.pool.query = async function (...args) {
      const out = await query.apply(this, args);
      if (String(args[0]).includes('hold_id LIKE')) {
        if (++checks === 2) release();
        await bothChecked;
      }
      return out;
    };
    let results;
    try {
      results = await Promise.all([0, 1].map(() => ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})));
    } finally {
      h.pool.query = query;
    }
    expect(checks).toBe(2);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(1);
    expect((await charges(id)).filter((c) => c.kind === 'regenerate')).toHaveLength(1);
  });

  it('cancelling a queued job refunds it at once', async () => {
    const id = await newJob();
    const res = await ana.post(`/api/jobs/${id}/cancel`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'cancel_requested' });
    expect(h.engine.state.jobs.get(id).status).toBe('canceled');
    expect((await charges(id))[0].state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('cancelling a running job leaves the hold for the callback', async () => {
    const id = await newJob();
    h.engine.setJob(id, { status: 'running' });
    expect((await ana.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    expect((await charges(id))[0].state).toBe('held');
  });

  it('deleting a queued job refunds it and hides it', async () => {
    const id = await newJob();
    expect((await ana.del(`/api/jobs/${id}`)).status).toBe(204);
    expect(h.engine.state.jobs.has(id)).toBe(false);
    expect((await charges(id))[0].state).toBe('refunded');
    expect((await ana.get(`/api/jobs/${id}`)).status).toBe(404);
  });

  it('deleting a finished job whose callback was lost settles it', async () => {
    const id = await doneJob();
    expect((await ana.del(`/api/jobs/${id}`)).status).toBe(204);
    const [c] = await charges(id);
    expect(c.state).toBe('settled');
    expect(h.lq.state.callsTo('/credits/settle').at(-1).body).toEqual({ userId: 'ana', holdId: c.hold_id, amount: 1 });
  });

  it("refuses to touch another user's job", async () => {
    const id = await doneJob();
    for (const res of [
      await budi.post(`/api/jobs/${id}/sentences/0/regenerate`, {}),
      await budi.post(`/api/jobs/${id}/cancel`),
      await budi.del(`/api/jobs/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(h.engine.state.jobs.get(id).status).toBe('done');
    expect((await charges(id))[0].state).toBe('held');
  });
});
