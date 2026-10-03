import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamUnavailable } from '../clients/http.js';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

describe('voiceover jobs', () => {
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
  const lastHold = () => h.lq.state.callsTo('/credits/hold').at(-1).body;
  const chargeByRef = async (ref) => (await h.pool.query('SELECT * FROM charges WHERE hold_id = $1', [ref])).rows[0];

  it('estimates characters, credits, rupiah, balance and sentences', async () => {
    const res = await ana.post('/api/jobs/estimate', { text: '  Halo dunia. Apa kabar?  ' });
    expect(res.body).toEqual({ chars: 22, credits: 1, rupiah: 100, balance: 100, sentences: 2 });
    expect((await ana.post('/api/jobs/estimate', { text: '' })).body).toMatchObject({ chars: 0, credits: 0, rupiah: 0 });
    expect((await ana.post('/api/jobs/estimate', { text: 'a'.repeat(20001) })).status).toBe(413);
  });

  it('holds credits, queues the engine job and records both', async () => {
    const text = 'Halo dunia. '.repeat(20).trim(); // 239 chars → 3 credits
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text, settings: { speed: 1.1 } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), credits: 3, estimatedSeconds: 12 });
    const hold = lastHold();
    expect(hold).toEqual({ userId: 'ana', amount: 3, ref: expect.stringMatching(/^tts:[0-9a-f-]{36}:r1$/) });
    const engineJob = h.engine.state.jobs.get(res.body.id);
    expect(engineJob).toMatchObject({ text, callback_url: 'http://127.0.0.1:8750/api/internal/engine-callback', idem: hold.ref.split(':')[1] });
    expect(engineJob.settings.speed).toBe(1.1);
    expect(h.lq.state.users.get('ana').balance).toBe(97);
    expect(await chargeByRef(hold.ref)).toMatchObject({
      user_id: 'ana', job_id: res.body.id, kind: 'job', revision: 1, chars: 239, credits: 3, state: 'held',
    });
    const list = await ana.get('/api/jobs');
    expect(list.body.items[0]).toMatchObject({
      id: res.body.id, title: text.slice(0, 60), voiceId: voice.id, voiceName: 'Suara Ana', status: 'queued',
      chars: 239, credits: 3, revision: 1, audioSeconds: null, finishedAt: null,
    });
  });

  it('queues nothing and keeps no charge when the balance is too low', async () => {
    h.lq.state.users.get('ana').balance = 2;
    const jobsBefore = h.engine.state.jobs.size;
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'x'.repeat(300) });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('insufficient_credits');
    expect(h.engine.state.jobs.size).toBe(jobsBefore);
    expect(await chargeByRef(lastHold().ref)).toBeUndefined();
  });

  it('refunds the hold when the engine rejects the job and shows the engine reason', async () => {
    h.engine.state.failNext.set('POST /v1/jobs', { status: 400, code: 'invalid_settings', message: 'settings.speed: too fast' });
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.', settings: { speed: 9 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'invalid_request', message: 'settings.speed: too fast' });
    const { ref } = lastHold();
    expect(h.lq.state.net(ref)).toBe(0);
    expect(h.lq.state.users.get('ana').balance).toBe(100);
    expect((await chargeByRef(ref)).state).toBe('refunded');
  });

  it('refunds the hold when the engine is down', async () => {
    h.engine.state.failNext.set('POST /v1/jobs', { status: 503, code: 'disk_full' });
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('engine_unavailable');
    expect(h.lq.state.net(lastHold().ref)).toBe(0);
    expect((await chargeByRef(lastHold().ref)).state).toBe('refunded');
  });

  it('holds nothing for a voice that is not ready or not owned', async () => {
    const processing = h.engine.addVoice({ owner_ref: 'ana', status: 'processing' });
    const holds = h.lq.state.callsTo('/credits/hold').length;
    const notReady = await ana.post('/api/jobs', { voiceId: processing.id, text: 'Halo.' });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('voice_not_ready');
    const foreign = await budi.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(foreign.status).toBe(404);
    expect(h.lq.state.callsTo('/credits/hold').length).toBe(holds);
  });

  it('queues nothing when the hold outcome is unknown, and still gives back a hold that lands late', async () => {
    h.lq.state.failNext.set('POST /credits/hold', 1); // the hold has not reached LQ-Studio's ledger
    const jobs = h.engine.state.jobs.size;
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('lqstudio_unavailable');
    expect(h.engine.state.jobs.size).toBe(jobs);
    const late = lastHold();
    expect(h.lq.state.callsTo('/credits/refund').at(-1).body).toEqual({ userId: 'ana', holdId: late.ref });
    // The immediate refund found nothing, which is not final yet: the charge waits for reconciliation.
    expect(await chargeByRef(late.ref)).toMatchObject({ state: 'held', job_id: null, attempts: 0, last_error: null });
    await h.ctx.lqstudio.hold(late); // the aborted request reaches LQ-Studio after all
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    await h.pool.query(`UPDATE charges SET created_at = now() - interval '3 minutes' WHERE hold_id = $1`, [late.ref]);
    expect(await h.ctx.charges.resolveOne(await chargeByRef(late.ref), null)).toBe(true);
    expect((await chargeByRef(late.ref)).state).toBe('refunded');
    expect(h.lq.state.net(late.ref)).toBe(0);
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('gives the credits back at once when LQ-Studio took them but its answer was lost', async () => {
    const { hold } = h.ctx.lqstudio;
    h.ctx.lqstudio.hold = async (args) => {
      await hold(args);
      throw new UpstreamUnavailable('lqstudio', new Error('socket hang up'));
    };
    try {
      const jobs = h.engine.state.jobs.size;
      const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('lqstudio_unavailable');
      expect(h.engine.state.jobs.size).toBe(jobs);
      const { ref } = lastHold();
      expect(h.lq.state.net(ref)).toBe(0);
      expect(h.lq.state.users.get('ana').balance).toBe(100);
      expect((await chargeByRef(ref)).state).toBe('refunded');
    } finally {
      h.ctx.lqstudio.hold = hold;
    }
  });

  it('pages history newest first with limit and before', async () => {
    const own = h.engine.addVoice({ owner_ref: 'budi', name: 'Budi' });
    const ids = [];
    for (const n of [1, 2, 3]) ids.push((await budi.post('/api/jobs', { voiceId: own.id, text: `Kalimat ${n}.` })).body.id);
    const first = await budi.get('/api/jobs?limit=2');
    expect(first.body.items.map((j) => j.id)).toEqual([ids[2], ids[1]]);
    const second = await budi.get(`/api/jobs?limit=2&before=${encodeURIComponent(first.body.nextBefore)}`);
    expect(second.body.items.map((j) => j.id)).toEqual([ids[0]]);
    expect(second.body.nextBefore).toBeNull();
    expect((await budi.get('/api/jobs?limit=0')).status).toBe(400);
    for (const bad of [
      first.body.items[1].createdAt, `2026-02-30T10:00:00.000000Z|${ids[0]}`, `0000-01-01T00:00:00.000000Z|${ids[0]}`,
      '2026-10-03T10:00:00.000000Z|not-a-uuid', 'x',
    ]) {
      const res = await budi.get(`/api/jobs?before=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('pages through jobs created at the same instant without skipping or repeating any', async () => {
    const poor = h.as(await h.login(USERS.poor));
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await h.pool.query(
        `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status, created_at)
         VALUES ($1, 'poor', $2, 'Suara', 'Sama', 4, 'done', '2026-10-03T10:00:00.123456Z')`,
        [id, crypto.randomUUID()],
      );
    }
    const seen = [];
    let before = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await poor.get(`/api/jobs?limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((j) => j.id));
      before = res.body.nextBefore;
      if (!before) break;
    }
    expect(seen).toEqual(ids.toSorted().reverse());
  });

  it('shows engine progress, files and revisions of a finished job', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu. Dua.' });
    h.engine.setJob(id, { status: 'done', audio_seconds: 3.5 });
    const res = await ana.get(`/api/jobs/${id}`);
    expect(res.body).toMatchObject({
      id, status: 'done', audioSeconds: 3.5, revision: 1, credits: 1, progress: { done: 2, total: 2 }, needsReview: 0,
      revisions: [1], settings: { speed: 0.9 },
      files: {
        'final.mp3': `/api/jobs/${id}/files/final.mp3?revision=1`,
        'final.wav': `/api/jobs/${id}/files/final.wav?revision=1`,
        'subs.srt': `/api/jobs/${id}/files/subs.srt?revision=1`,
        'subs.vtt': `/api/jobs/${id}/files/subs.vtt?revision=1`,
      },
    });
    expect(res.body.finishedAt).not.toBeNull();
    const sentences = await ana.get(`/api/jobs/${id}/sentences`);
    expect(sentences.body[1]).toEqual({
      idx: 1, paragraphIdx: 0, text: 'Dua.', style: null, status: 'done', score: null,
      durationS: null, startS: null, endS: null, audioUrl: `/api/jobs/${id}/sentences/1/audio`,
    });
  });

  it('treats a job the engine no longer has as gone', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Hilang.' });
    h.engine.state.jobs.delete(id);
    expect((await ana.get(`/api/jobs/${id}`)).status).toBe(404);
    expect((await ana.get('/api/jobs')).body.items.find((j) => j.id === id)).toBeUndefined();
  });

  it('streams sentence audio and output files, passing Range through', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu. Dua.' });
    h.engine.setJob(id, { status: 'done' });
    const audio = await ana.get(`/api/jobs/${id}/sentences/0/audio?v=1`).buffer(true).parse(binary); // client cache-buster is ignored
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(audio.body, WAV_BYTES)).toBe(0);
    const part = await ana.get(`/api/jobs/${id}/files/final.mp3?revision=1`).set('range', 'bytes=2-5').buffer(true).parse(binary);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/20');
    expect(part.headers['content-disposition']).toContain(`${id}-r1-final.mp3`);
    expect(part.body.toString()).toBe('2345');
    expect((await ana.get(`/api/jobs/${id}/files/secret.txt`)).status).toBe(404);
    expect((await ana.get(`/api/jobs/${id}/files/final.mp3?revision=abc`)).status).toBe(400);
  });

  it("hides other users' jobs with 404 and never asks the engine", async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Rahasia.' });
    const engineCalls = h.engine.state.calls.length;
    for (const path of [`/api/jobs/${id}`, `/api/jobs/${id}/sentences`, `/api/jobs/${id}/sentences/0/audio`, `/api/jobs/${id}/files/final.mp3`]) {
      const res = await budi.get(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(h.engine.state.calls.length).toBe(engineCalls);
    expect((await budi.get('/api/jobs')).body.items.find((j) => j.id === id)).toBeUndefined();
    expect((await budi.get('/api/jobs/not-a-uuid')).status).toBe(404);
  });

  it('lists only my TTS usage with states and titles on the credits page', async () => {
    const res = await ana.get('/api/credits');
    expect(res.status).toBe(200);
    expect(res.body.topupUrl).toBe('https://demo.lq-studio.com/upgrade-plan');
    expect(typeof res.body.balance).toBe('number');
    const { rows: [{ n }] } = await h.pool.query(`SELECT count(*)::int AS n FROM charges WHERE user_id = 'ana'`);
    expect(res.body.usage).toHaveLength(n);
    expect(res.body.usage[0]).toEqual({
      id: expect.any(String), jobId: expect.any(String), title: expect.any(String), kind: 'job',
      chars: expect.any(Number), credits: expect.any(Number), state: 'held', createdAt: expect.any(String),
    });
    expect(res.body.usage.some((u) => u.state === 'refunded')).toBe(true);
    const budiJobs = new Set((await budi.get('/api/credits')).body.usage.map((u) => u.jobId));
    expect(res.body.usage.some((u) => u.jobId && budiJobs.has(u.jobId))).toBe(false);
  });
});
