import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS, binary, startHarness } from './helpers.js';

const meta = (slug, name) => ({
  slug, name, gender: 'male', language: 'id',
  description: { id: 'Pria.', en: 'Male.' }, tags: [{ id: 'Pria', en: 'Male' }], bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: name, attestedBy: 'lqmnah', scope: 'Public library voice' }, sort: 100,
});

describe('/v1 voiceovers', () => {
  let h;
  let key;
  let budi;
  let voice;
  beforeAll(async () => {
    h = await startHarness({ env: { WEBHOOK_ALLOW_LOOPBACK: 'true' } });
    key = await h.apiKey('budi');
    budi = h.api(key);
    voice = h.engine.addVoice({ owner_ref: 'budi', name: 'Suara Budi' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    h.ctx.apiLimiter.reset();
    h.lq.state.users.get('budi').balance = 1000;
    // Earlier tests' jobs must not count toward the 2-job cap.
    for (const j of h.engine.state.jobs.values()) if (j.status === 'queued' || j.status === 'running') h.engine.setJob(j.id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')`);
  });
  const create = (body = {}, headers = {}) => {
    let r = budi.post('/v1/tts', { voiceId: voice.id, text: 'Halo dunia.', ...body });
    for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
    return r;
  };
  const holds = () => h.lq.state.callsTo('/credits/hold').length;
  const chargesOf = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;

  it('estimates like the web app', async () => {
    const res = await budi.post('/v1/estimate', { text: '  Halo dunia. Apa kabar?  ' });
    expect(res.body).toEqual({ chars: 22, credits: 1, sentences: 2 });
    expect((await budi.post('/v1/estimate', { text: '' })).body).toEqual({ chars: 0, credits: 0, sentences: 0 });
    expect((await budi.post('/v1/estimate', { text: 'a'.repeat(20001) })).status).toBe(413);
  });

  it('queues a voiceover at API priority, billed like the web, and lists it in the web history as API', async () => {
    const text = 'Halo dunia. '.repeat(20).trim(); // 239 chars → 3 credits
    const res = await create({ text, settings: { speed: 1.1 }, formats: ['mp3', 'srt'] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: expect.any(String), credits: 3, status: 'queued' });
    const call = h.engine.state.callsTo('POST', '/v1/jobs').at(-1);
    expect(call.body).toMatchObject({ voice_id: voice.id, text, priority: 1, settings: { speed: 1.1, formats: ['mp3', 'srt'] } });
    expect(h.lq.state.users.get('budi').balance).toBe(997);
    const { rows: [job] } = await h.pool.query('SELECT source, api_key_id, webhook_url FROM jobs WHERE id = $1', [res.body.jobId]);
    expect(job).toEqual({ source: 'api', api_key_id: (await h.ctx.apiKeys.find(key)).id, webhook_url: null });
    expect(await chargesOf(res.body.jobId)).toMatchObject([{ source: 'api', state: 'held', credits: 3, kind: 'job' }]);
    const web = h.as(await h.login(USERS.budi));
    expect((await web.get('/api/jobs')).body.items.find((j) => j.id === res.body.jobId)).toMatchObject({ source: 'api', credits: 3 });
  });

  it('validates text, voice, settings, formats and webhookUrl exactly like POST /api/jobs, holding nothing', async () => {
    const before = holds();
    const cases = [
      [{ text: '   ' }, 400, 'invalid_request'],
      [{ text: 'a'.repeat(20001) }, 413, 'too_large'],
      [{ voiceId: undefined }, 400, 'invalid_request'],
      [{ settings: [] }, 400, 'invalid_request'],
      [{ formats: 'mp3' }, 400, 'invalid_request'],
      [{ webhookUrl: 7 }, 400, 'invalid_request'],
      [{ webhookUrl: 'https://10.0.0.1/hook' }, 400, 'invalid_webhook_url'],
      [{ webhookUrl: 'http://10.0.0.2:8080/hook' }, 400, 'invalid_webhook_url'],
    ];
    for (const [body, status, code] of cases) {
      const res = await create(body);
      expect([res.status, res.body.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(holds()).toBe(before);
    h.engine.state.failNext.set('POST /v1/jobs', { status: 400, code: 'invalid_settings', message: 'settings.speed: too fast' });
    const refused = await create({ settings: { speed: 9 } });
    expect(refused.body.error).toEqual({ code: 'invalid_request', message: 'settings.speed: too fast' });
    expect(h.lq.state.net(h.lq.state.callsTo('/credits/hold').at(-1).body.ref)).toBe(0);
  });

  it('stores the normalised webhook href and measures the 500-character limit on it', async () => {
    const res = await create({ webhookUrl: 'HTTP://127.0.0.1:9/Hook path' });
    expect(res.status).toBe(202);
    const { rows: [job] } = await h.pool.query('SELECT webhook_url FROM jobs WHERE id = $1', [res.body.jobId]);
    expect(job.webhook_url).toBe('http://127.0.0.1:9/Hook%20path');
    const before = holds();
    const grown = await create({ webhookUrl: `http://127.0.0.1/${'é'.repeat(100)}` }); // 117 typed, 617 once encoded
    expect([grown.status, grown.body.error.code]).toEqual([400, 'invalid_webhook_url']);
    expect(holds()).toBe(before);
  });

  it("accepts the caller's own ready voices and API-allowed profiles only", async () => {
    const before = holds();
    const anas = h.engine.addVoice({ owner_ref: 'ana' });
    const processing = h.engine.addVoice({ owner_ref: 'budi', status: 'processing' });
    const webOnly = h.engine.addVoice({ owner_ref: 'library', name: 'Rina' });
    await h.ctx.profiles.upsert(meta('web-only', 'Rina'), webOnly.id);
    for (const id of [anas.id, webOnly.id, 'not-a-uuid']) {
      const res = await create({ voiceId: id });
      expect([res.status, res.body.error.code]).toEqual([404, 'not_found']);
    }
    const notReady = await create({ voiceId: processing.id });
    expect([notReady.status, notReady.body.error.code]).toEqual([409, 'voice_not_ready']);
    expect(holds()).toBe(before);
    const allowed = h.engine.addVoice({ owner_ref: 'library', name: 'Pandji' });
    await h.ctx.profiles.upsert(meta('api-ok', 'Pandji'), allowed.id);
    await h.ctx.profiles.setApiAllowed('api-ok', true);
    expect((await create({ voiceId: allowed.id })).status).toBe(202);
  });

  it('answers 402 with the balance and the top-up link, keeping no job and no charge', async () => {
    h.lq.state.users.get('budi').balance = 0;
    const jobsBefore = h.engine.state.jobs.size;
    const res = await create({});
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'insufficient_credits', balance: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan' });
    expect(h.engine.state.jobs.size).toBe(jobsBefore);
    const ref = h.lq.state.callsTo('/credits/hold').at(-1).body.ref;
    expect((await h.pool.query('SELECT 1 FROM charges WHERE hold_id = $1', [ref])).rowCount).toBe(0);
  });

  it('keeps at most two API jobs queued or running per account', async () => {
    const first = await create({});
    expect((await create({})).status).toBe(202);
    const before = holds();
    const third = await create({});
    expect([third.status, third.body.error.code]).toEqual([429, 'too_many_jobs']);
    expect(holds()).toBe(before);
    h.engine.setJob(first.body.jobId, { status: 'done' });
    expect((await budi.get(`/v1/tts/${first.body.jobId}`)).body.status).toBe('done'); // reading records it
    expect((await create({})).status).toBe(202);
  });

  it('holds the cap when creates race', async () => {
    const results = await Promise.all([0, 1, 2, 3].map(() => create({})));
    expect(results.map((r) => r.status).sort()).toEqual([202, 202, 429, 429]);
  });

  it('replays an Idempotency-Key for 24 hours without a second hold', async () => {
    const first = await create({}, { 'idempotency-key': 'order-1' });
    const before = holds();
    const again = await create({ text: 'Teks lain.' }, { 'idempotency-key': 'order-1' });
    expect(again.status).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual({ jobId: first.body.jobId, credits: 1, status: 'queued' });
    expect(holds()).toBe(before);
    const otherAccount = await h.api(await h.apiKey('cici')).post('/v1/tts', { voiceId: h.engine.addVoice({ owner_ref: 'cici' }).id, text: 'Halo.' }).set('idempotency-key', 'order-1');
    expect(otherAccount.status).toBe(202);
    expect(otherAccount.body.jobId).not.toBe(first.body.jobId);
    await h.pool.query(`UPDATE api_idempotency SET created_at = now() - interval '25 hours' WHERE user_id = 'budi' AND idem_key = 'order-1'`);
    h.engine.setJob(first.body.jobId, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [first.body.jobId]);
    const later = await create({}, { 'idempotency-key': 'order-1' });
    expect(later.status).toBe(202);
    expect(later.body.jobId).not.toBe(first.body.jobId);
  });

  it('frees a key whose create failed, refuses a key still in flight, and checks the key format', async () => {
    const bad = await create({ voiceId: h.engine.addVoice({ owner_ref: 'ana' }).id }, { 'idempotency-key': 'retry-me' });
    expect(bad.status).toBe(404);
    expect((await create({}, { 'idempotency-key': 'retry-me' })).status).toBe(202);
    await h.pool.query(`INSERT INTO api_idempotency (user_id, idem_key) VALUES ('budi', 'in-flight')`);
    const busy = await create({}, { 'idempotency-key': 'in-flight' });
    expect([busy.status, busy.body.error.code]).toEqual([409, 'idempotency_conflict']);
    await h.pool.query(`UPDATE api_idempotency SET created_at = now() - interval '3 minutes' WHERE idem_key = 'in-flight'`);
    h.engine.setJob((await h.pool.query(`SELECT job_id FROM api_idempotency WHERE idem_key = 'retry-me'`)).rows[0].job_id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE source = 'api'`);
    expect((await create({}, { 'idempotency-key': 'in-flight' })).status).toBe(202); // abandoned claim taken over
    for (const value of ['x'.repeat(101), 'has space']) {
      const res = await create({}, { 'idempotency-key': value });
      expect([res.status, res.body.error.code]).toEqual([400, 'invalid_request']);
    }
  });

  it('reports status, progress and download paths, and streams the files under their public names', async () => {
    const { body: { jobId } } = await create({});
    const queued = await budi.get(`/v1/tts/${jobId}`);
    expect(queued.body).toEqual({ jobId, status: 'queued', progress: { done: 0, total: 1 }, credits: 1, errorCode: null, createdAt: expect.any(String) });
    h.engine.setJob(jobId, { status: 'done', audio_seconds: 1.5 });
    const done = await budi.get(`/v1/tts/${jobId}`);
    expect(done.body).toMatchObject({
      status: 'done', progress: { done: 1, total: 1 },
      files: {
        mp3: `/v1/tts/${jobId}/files/final.mp3`, wav: `/v1/tts/${jobId}/files/final.wav`,
        srt: `/v1/tts/${jobId}/files/subtitles.srt`, vtt: `/v1/tts/${jobId}/files/subtitles.vtt`,
      },
    });
    const srt = await budi.get(`/v1/tts/${jobId}/files/subtitles.srt`).buffer(true).parse(binary);
    expect(srt.status).toBe(200);
    expect(srt.headers['content-type']).toBe('application/x-subrip');
    expect(srt.body.equals(h.engine.state.fileBytes)).toBe(true);
    expect(h.engine.state.calls.at(-1).path).toBe(`/v1/jobs/${jobId}/files/subs.srt`);
    expect((await budi.get(`/v1/tts/${jobId}/files/subs.srt`)).status).toBe(404);
  });

  it("reports a failure's engine code", async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'failed', error_code: 'synthesis_failed' });
    expect((await budi.get(`/v1/tts/${jobId}`)).body).toMatchObject({ status: 'failed', errorCode: 'synthesis_failed' });
  });

  it("never shows or touches another account's job", async () => {
    const { body: { jobId } } = await create({});
    const cici = h.api(await h.apiKey('cici'));
    for (const res of [await cici.get(`/v1/tts/${jobId}`), await cici.get(`/v1/tts/${jobId}/files/final.mp3`), await cici.del(`/v1/tts/${jobId}`)]) {
      expect([res.status, res.body.error.code]).toEqual([404, 'not_found']);
    }
    expect(h.engine.state.jobs.get(jobId).status).toBe('queued');
  });

  it('cancels a queued job with a refund, then deletes it on the second DELETE', async () => {
    const { body: { jobId } } = await create({});
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await chargesOf(jobId))[0].state).toBe('refunded');
    expect((await budi.get(`/v1/tts/${jobId}`)).body).toMatchObject({ status: 'canceled', credits: 0 });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await budi.get(`/v1/tts/${jobId}`)).status).toBe(404);
  });

  it('asks the engine to stop a running job and leaves its hold for the callback', async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'running' });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect(h.engine.state.jobs.get(jobId).cancel_requested).toBe(true);
    expect((await chargesOf(jobId))[0].state).toBe('held');
  });

  it('settles a finished job when it is deleted', async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'done' });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await chargesOf(jobId))[0].state).toBe('settled');
    expect((await budi.get(`/v1/tts/${jobId}`)).status).toBe(404);
  });
});
