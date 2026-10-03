import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamUnavailable } from '../clients/http.js';
import { createReconciler } from '../services/reconcile.js';
import { USERS, startHarness } from './helpers.js';

describe('reconciliation', () => {
  let h;
  let ana;
  let voice;
  let reconciler;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
    reconciler = createReconciler(h.ctx);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  afterEach(async () => {
    // no held charge leaks into the next test's pass
    await h.pool.query(`UPDATE charges SET state = 'refunded', resolved_at = now() WHERE state = 'held'`);
  });
  const job = async (text = 'Halo.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const lastCharge = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [jobId])).rows[0];
  const age = (jobId, minutes = 3) =>
    h.pool.query('UPDATE charges SET created_at = now() - make_interval(mins => $2) WHERE job_id = $1', [jobId, minutes]);
  const orphanCharge = async (ref, extra = '') => {
    await h.ctx.lqstudio.hold({ userId: 'ana', amount: 1, ref });
    await h.pool.query(
      `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id, created_at) VALUES ${extra}`,
    );
  };

  it('settles finished jobs and refunds failed, canceled and vanished ones', async () => {
    const done = await job();
    const failed = await job();
    const canceled = await job();
    const gone = await job();
    h.engine.setJob(done, { status: 'done' });
    h.engine.setJob(failed, { status: 'failed', error_code: 'synthesis_failed' });
    h.engine.setJob(canceled, { status: 'canceled' });
    h.engine.state.jobs.delete(gone);
    for (const id of [done, failed, canceled, gone]) await age(id);
    await reconciler.runOnce();
    expect((await lastCharge(done)).state).toBe('settled');
    for (const id of [failed, canceled, gone]) {
      const c = await lastCharge(id);
      expect(c.state).toBe('refunded');
      expect(h.lq.state.net(c.hold_id)).toBe(0);
    }
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    const { rows } = await h.pool.query('SELECT id, deleted_at FROM jobs WHERE id = ANY($1)', [[done, gone]]);
    const deleted = Object.fromEntries(rows.map((r) => [r.id, r.deleted_at !== null]));
    expect(deleted).toEqual({ [done]: false, [gone]: true });
  });

  it('leaves running jobs and young charges alone without counting attempts', async () => {
    const running = await job();
    const young = await job();
    h.engine.setJob(running, { status: 'running' });
    h.engine.setJob(young, { status: 'done' });
    await age(running);
    await reconciler.runOnce();
    expect(await lastCharge(running)).toMatchObject({ state: 'held', attempts: 0 });
    expect((await lastCharge(young)).state).toBe('held');
    h.engine.setJob(running, { status: 'canceled' }); // leave no stray held charge for the next tests
    await reconciler.runOnce();
    expect((await lastCharge(running)).state).toBe('refunded');
  });

  it('refunds a create that crashed between the hold and the job row', async () => {
    const ref = 'tts:11111111-1111-4111-8111-111111111111:r1';
    await orphanCharge(ref, `('ana', NULL, 1, 'job', NULL, 5, 1, '${ref}', now() - interval '3 minutes')`);
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    await reconciler.runOnce();
    const { rows: [c] } = await h.pool.query('SELECT state FROM charges WHERE hold_id = $1', [ref]);
    expect(c.state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('refunds a regeneration the engine never received and settles the revision it did finish', async () => {
    const id = await job('Satu. Dua.');
    h.engine.setJob(id, { status: 'done' });
    const ref = `tts:${id}:r2:s0`;
    await orphanCharge(ref, `('ana', '${id}', 2, 'regenerate', 0, 5, 1, '${ref}', now() - interval '3 minutes')`);
    await age(id);
    await reconciler.runOnce();
    const { rows } = await h.pool.query('SELECT revision, state FROM charges WHERE job_id = $1 ORDER BY revision', [id]);
    expect(rows).toEqual([{ revision: 1, state: 'settled' }, { revision: 2, state: 'refunded' }]);
  });

  it('counts failed attempts, flags once at 10 and keeps trying until it succeeds', async () => {
    const id = await job();
    h.engine.setJob(id, { status: 'done' });
    await age(id);
    await h.pool.query('UPDATE charges SET attempts = 8 WHERE job_id = $1', [id]);
    h.lq.state.down = true;
    try {
      await reconciler.runOnce();
      expect(await lastCharge(id)).toMatchObject({ state: 'held', attempts: 9, flagged_at: null });
      await reconciler.runOnce();
      const flagged = await lastCharge(id);
      expect(flagged.attempts).toBe(10);
      expect(flagged.flagged_at).not.toBeNull();
      await reconciler.runOnce();
      expect(h.logs.filter((l) => l.event === 'charge_flagged' && l.chargeId === flagged.id)).toHaveLength(1);
    } finally {
      h.lq.state.down = false;
    }
    await reconciler.runOnce();
    expect((await lastCharge(id)).state).toBe('settled');
  });

  it('counts an attempt when the engine cannot be asked', async () => {
    const id = await job();
    await age(id);
    h.engine.state.failNext.set('GET /v1/jobs/:id', { status: 503, code: 'disk_full' });
    await reconciler.runOnce();
    expect(await lastCharge(id)).toMatchObject({ state: 'held', attempts: 1 });
  });

  it('runs once at start and then on its interval', async () => {
    const id = await job();
    await age(id);
    const looping = createReconciler(h.ctx, { intervalMs: 50 });
    looping.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      h.engine.setJob(id, { status: 'done' });
      const deadline = Date.now() + 3000;
      while ((await lastCharge(id)).state === 'held' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await lastCharge(id)).state).toBe('settled');
    } finally {
      await looping.stop();
    }
  });
  const engineDown = (calls = []) => ({
    calls,
    getJob: (jobId) => {
      calls.push(jobId);
      return Promise.reject(new UpstreamUnavailable('engine'));
    },
  });

  it('puts charges that keep failing behind fresh ones', async () => {
    const stuck = [await job(), await job(), await job()];
    const fresh = await job();
    h.engine.setJob(fresh, { status: 'done' });
    for (const id of [...stuck, fresh]) await age(id);
    await h.pool.query('UPDATE charges SET attempts = 5 WHERE job_id = ANY($1)', [stuck]);
    const down = engineDown();
    const engine = { getJob: (id) => (stuck.includes(id) ? down.getJob(id) : h.ctx.engine.getJob(id)) };
    await createReconciler({ ...h.ctx, engine }, { batchSize: 2 }).runOnce();
    expect((await lastCharge(fresh)).state).toBe('settled');
  });

  it('asks the engine once per job per pass and records a failure on every charge of it', async () => {
    const id = await job('Satu. Dua.');
    for (const s of [0, 1]) {
      const ref = `tts:${id}:r2:s${s}`;
      await orphanCharge(ref, `('ana', '${id}', 2, 'regenerate', ${s}, 5, 1, '${ref}', now() - interval '3 minutes')`);
    }
    await age(id);
    const down = engineDown();
    await createReconciler({ ...h.ctx, engine: down }).runOnce();
    expect(down.calls.filter((c) => c === id)).toHaveLength(1);
    const { rows } = await h.pool.query('SELECT state, attempts FROM charges WHERE job_id = $1', [id]);
    expect(rows).toEqual([1, 2, 3].map(() => ({ state: 'held', attempts: 1 })));
  });

  it('records no failure on a charge that was resolved in the meantime', async () => {
    const id = await job();
    h.engine.setJob(id, { status: 'done' });
    await age(id);
    await h.pool.query('UPDATE charges SET attempts = 9 WHERE job_id = $1', [id]);
    const stale = await lastCharge(id);
    await reconciler.runOnce();
    expect((await lastCharge(id)).state).toBe('settled');
    await h.ctx.charges.recordFailure(stale, new Error('late engine error'));
    expect(await lastCharge(id)).toMatchObject({ state: 'settled', attempts: 9, last_error: null, flagged_at: null });
    expect(h.logs.filter((l) => l.event === 'charge_flagged' && l.chargeId === stale.id)).toHaveLength(0);
  });

  it('shares one pass between concurrent runOnce calls', async () => {
    const a = reconciler.runOnce();
    const b = reconciler.runOnce();
    expect(b).toBe(a);
    await a;
    const c = reconciler.runOnce();
    expect(c).not.toBe(a);
    await c;
  });

  it('stops between charges instead of finishing the pass', async () => {
    for (const id of [await job(), await job()]) await age(id);
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inside = new Promise((resolve) => { entered = resolve; });
    const engine = {
      getJob: async (jobId) => {
        calls.push(jobId);
        entered();
        await gate;
        throw new UpstreamUnavailable('engine');
      },
    };
    const r = createReconciler({ ...h.ctx, engine });
    const pass = r.runOnce();
    await inside;
    const stopped = r.stop();
    release();
    await stopped;
    await pass;
    expect(calls).toHaveLength(1);
  });
});
