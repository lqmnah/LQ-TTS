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
    // Hold every request after its retry-numbering query so, unserialized, both pick the same ref before either
    // inserts. Serialized, only one gets there; the timer, started at the first arrival, stops the barrier from waiting for a second forever.
    const query = h.pool.query;
    let release;
    const bothChecked = new Promise((r) => { release = r; });
    let timer;
    let checks = 0;
    h.pool.query = async function (...args) {
      const out = await query.apply(this, args);
      if (String(args[0]).includes('hold_id LIKE')) {
        if (++checks === 1) timer = setTimeout(() => release(), 300);
        else release();
        await bothChecked;
      }
      return out;
    };
    let results;
    try {
      results = await Promise.all([0, 1].map(() => ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})));
    } finally {
      h.pool.query = query;
      clearTimeout(timer);
    }
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(1);
    expect((await charges(id)).filter((c) => c.kind === 'regenerate')).toHaveLength(1);
  });

  it('lets only one regeneration per job through when different sentences race', async () => {
    const id = await doneJob();
    // Hold every request just after the job-wide guard so, unserialized, both pass it before either holds.
    // Serialized, only one reaches the guard; the timer, started at the first arrival, stops the barrier from waiting for a second forever.
    const query = h.pool.query;
    let release;
    const passed = new Promise((r) => { release = r; });
    let timer;
    let checks = 0;
    h.pool.query = async function (...args) {
      const out = await query.apply(this, args);
      if (String(args[0]).includes('revision > $2')) {
        if (++checks === 1) timer = setTimeout(() => release(), 300);
        else release();
        await passed;
      }
      return out;
    };
    let results;
    try {
      results = await Promise.all([0, 1].map((idx) => ana.post(`/api/jobs/${id}/sentences/${idx}/regenerate`, {})));
    } finally {
      h.pool.query = query;
      clearTimeout(timer);
    }
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(1);
    expect((await charges(id)).filter((c) => c.kind === 'regenerate')).toHaveLength(1);
  });

  it('numbers a retry after the highest earlier attempt, not the count of rows', async () => {
    const id = await doneJob();
    // Attempts a1 (the bare ref) and a3 remain; a2 was deleted after an insufficient_credits hold.
    for (const holdId of [`tts:${id}:r2:s0`, `tts:${id}:r2:s0:a3`]) {
      await h.pool.query(
        `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id, state, resolved_at)
         VALUES ('ana', $1, 2, 'regenerate', 0, 4, 1, $2, 'refunded', now())`,
        [id, holdId],
      );
    }
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(202);
    expect(holdsFor(`tts:${id}:`).at(-1).body.ref).toBe(`tts:${id}:r2:s0:a4`);
  });

  const lease = async (jobId) => (await h.pool.query('SELECT regen_lease, regen_until FROM jobs WHERE id = $1', [jobId])).rows[0];
  const leaseCleared = async (jobId) => {
    // The release runs in finally, after the response is sent.
    for (const until = Date.now() + 1000; Date.now() < until; await new Promise((r) => setTimeout(r, 20))) {
      if ((await lease(jobId)).regen_lease === null) return true;
    }
    return false;
  };

  it('clears the lease after a 202 and after an engine 400', async () => {
    const ok = await doneJob();
    expect((await ana.post(`/api/jobs/${ok}/sentences/0/regenerate`, {})).status).toBe(202);
    expect(await leaseCleared(ok)).toBe(true);
    expect((await lease(ok)).regen_until).toBeNull();
    const bad = await doneJob();
    h.engine.state.failNext.set('POST /v1/jobs/:id/sentences/:idx/regenerate', { status: 400, code: 'invalid_text', message: 'no' });
    expect((await ana.post(`/api/jobs/${bad}/sentences/0/regenerate`, {})).status).toBe(400);
    expect(await leaseCleared(bad)).toBe(true);
  });

  it('takes over an expired lease', async () => {
    const id = await doneJob();
    await h.pool.query(
      `UPDATE jobs SET regen_lease = gen_random_uuid(), regen_until = now() - interval '1 second' WHERE id = $1`, [id],
    );
    expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
    expect(await leaseCleared(id)).toBe(true);
  });

  it('never clears a lease that a successor took after its own expired', async () => {
    const id = await doneJob();
    const regenerate = h.ctx.engine.regenerate;
    let successor;
    h.ctx.engine.regenerate = async (...args) => {
      // Our lease expires mid-request and another request takes the job.
      successor = (await h.pool.query(
        `UPDATE jobs SET regen_lease = gen_random_uuid(), regen_until = now() + interval '60 seconds' WHERE id = $1
         RETURNING regen_lease`, [id],
      )).rows[0].regen_lease;
      return regenerate(...args);
    };
    try {
      expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
    } finally {
      h.ctx.engine.regenerate = regenerate;
    }
    await new Promise((r) => setTimeout(r, 100)); // let the release in finally run
    expect((await lease(id)).regen_lease).toBe(successor);
  });

  it('refuses to cancel while a regeneration holds the lease', async () => {
    const id = await doneJob();
    const token = (await h.pool.query(
      `UPDATE jobs SET regen_lease = gen_random_uuid(), regen_until = now() + interval '60 seconds' WHERE id = $1
       RETURNING regen_lease`, [id],
    )).rows[0].regen_lease;
    const cancels = h.engine.state.callsTo('POST', '/v1/jobs/:id/cancel').length;
    const res = await ana.post(`/api/jobs/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'not_regeneratable', message: 'a previous change on this job is still being settled; try again shortly' });
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/cancel').length).toBe(cancels);
    expect((await lease(id)).regen_lease).toBe(token); // someone else's lease is left alone
  });

  it('never starves the pool when more regenerations run than it has connections', async () => {
    const n = h.pool.options.max + 2;
    const ids = [];
    for (let i = 0; i < n; i += 1) ids.push(await doneJob());
    h.lq.state.users.get('ana').balance = 100;
    const slow = (fn) => async (...args) => {
      await new Promise((r) => setTimeout(r, 100));
      return fn(...args);
    };
    const { engine, lqstudio } = h.ctx;
    const orig = { sentences: engine.sentences, regenerate: engine.regenerate, hold: lqstudio.hold };
    engine.sentences = slow(orig.sentences);
    engine.regenerate = slow(orig.regenerate);
    lqstudio.hold = slow(orig.hold);
    let timer;
    try {
      const all = Promise.all(ids.map((id) => ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})));
      const hung = new Promise((r) => { timer = setTimeout(() => r('hung'), 5000); });
      const results = await Promise.race([all, hung]);
      expect(results).not.toBe('hung');
      expect(results.map((r) => r.status)).toEqual(ids.map(() => 202));
    } finally {
      clearTimeout(timer);
      Object.assign(engine, { sentences: orig.sentences, regenerate: orig.regenerate });
      lqstudio.hold = orig.hold;
    }
  }, 10000);

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
  it('answers a regeneration only after its lease is released, so an immediate cancel goes through', async () => {
    const id = await doneJob();
    const query = h.pool.query;
    // Slow lease release: before the fix the 202 overtook it and the cancel below met a held lease (409).
    h.pool.query = async function slowRelease(sql, ...rest) {
      if (typeof sql === 'string' && sql.startsWith('UPDATE jobs SET regen_lease = NULL')) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return query.call(this, sql, ...rest);
    };
    try {
      expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
      expect((await ana.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    } finally {
      h.pool.query = query;
    }
  });
});
