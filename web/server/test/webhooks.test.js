import crypto from 'node:crypto';
import http from 'node:http';
import tls from 'node:tls';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReconciler } from '../services/reconcile.js';
import { createWebhooks } from '../services/webhooks.js';
import { USERS, signCallback, startHarness } from './helpers.js';

// A local HTTP receiver; `answer(req)` returns [status, body, headers] or null to never answer.
async function startReceiver() {
  const hits = [];
  let answer = () => [200, 'ok', {}];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    hits.push({ path: req.url, headers: req.headers, body });
    const out = answer(req);
    if (!out) return; // hang
    res.writeHead(out[0], out[2] ?? {});
    res.end(out[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/hook`,
    base,
    hits,
    answer(fn) {
      answer = fn;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

describe('webhooks', () => {
  let h;
  let made;
  let budi;
  let voice;
  let receiver;
  let hooks;
  beforeAll(async () => {
    h = await startHarness({ env: { WEBHOOK_ALLOW_LOOPBACK: 'true' } });
    await h.ctx.webhooks.stop(); // no background passes: each test runs `hooks` itself
    hooks = createWebhooks(h.ctx, { timeoutMs: 500 });
    made = await h.ctx.apiKeys.create('budi', { name: 'hooks', tv: 0 });
    budi = h.api(made.key);
    voice = h.engine.addVoice({ owner_ref: 'budi' });
    receiver = await startReceiver();
  });
  afterAll(async () => {
    await receiver.close();
    await h.close();
  });
  beforeEach(async () => {
    h.ctx.apiLimiter.reset();
    receiver.answer(() => [200, 'ok', {}]);
    receiver.hits.length = 0;
    for (const j of h.engine.state.jobs.values()) if (j.status === 'queued' || j.status === 'running') h.engine.setJob(j.id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')`);
  });
  const apiJob = async (client = budi, webhookUrl = receiver.url) => {
    const res = await client.post('/v1/tts', { voiceId: voice.id, text: 'Halo dunia.', ...(webhookUrl ? { webhookUrl } : {}) });
    expect(res.status).toBe(202);
    return res.body.jobId;
  };
  const callback = (payload) => {
    const { body, headers } = signCallback(payload);
    return request(h.app).post('/api/internal/engine-callback').set(headers).send(body);
  };
  const delivery = async (jobId) => (await h.pool.query('SELECT * FROM webhook_deliveries WHERE job_id = $1', [jobId])).rows[0];
  const makeDue = (jobId) => h.pool.query('UPDATE webhook_deliveries SET next_attempt_at = now() WHERE job_id = $1', [jobId]);
  const verify = (hit, secret) => {
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['lqtts-signature']);
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(60);
    expect(crypto.createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex')).toBe(v1);
  };

  it('sends one signed job.done to the webhookUrl and lists it on the API page', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200);
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200); // repeated callback
    await hooks.runOnce();
    expect(receiver.hits).toHaveLength(1);
    const [hit] = receiver.hits;
    expect(hit.path).toBe('/hook');
    expect(hit.headers).toMatchObject({ 'content-type': 'application/json', 'lqtts-event': 'job.done', 'user-agent': 'LQ-TTS-Webhooks/1' });
    verify(hit, made.webhookSecret);
    expect(JSON.parse(hit.body)).toEqual({
      event: 'job.done', jobId, status: 'done', credits: 1,
      files: {
        mp3: `/v1/tts/${jobId}/files/final.mp3`, wav: `/v1/tts/${jobId}/files/final.wav`,
        srt: `/v1/tts/${jobId}/files/subtitles.srt`, vtt: `/v1/tts/${jobId}/files/subtitles.vtt`,
      },
      createdAt: expect.any(String),
    });
    expect(await delivery(jobId)).toMatchObject({ state: 'delivered', attempts: 1, last_status: 200, event: 'job.done' });
    expect(hit.headers['lqtts-delivery']).toBe(String((await delivery(jobId)).id));
    const page = await h.as(await h.login(USERS.budi)).get('/api/keys');
    expect(page.body.deliveries).toContainEqual({
      id: expect.any(String), keyId: made.row.id, keyName: 'hooks', jobId, event: 'job.done', state: 'delivered',
      attempts: 1, lastStatus: 200, createdAt: expect.any(String), finishedAt: expect.any(String),
    });
  });

  it('sends job.failed with the engine code and zero credits after the refund', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'failed', error_code: 'synthesis_failed' });
    await callback({ job_id: jobId, status: 'failed', revision: 1 });
    await hooks.runOnce();
    expect(JSON.parse(receiver.hits[0].body)).toEqual({
      event: 'job.failed', jobId, status: 'failed', credits: 0, errorCode: 'synthesis_failed', createdAt: expect.any(String),
    });
  });

  it('waits for the charge: a callback that could not settle records nothing, its retry records the delivery', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    h.lq.state.failNext.set('POST /credits/settle', 1);
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(503);
    expect(await delivery(jobId)).toBeUndefined();
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200);
    expect(JSON.parse((await delivery(jobId)).body)).toMatchObject({ event: 'job.done', credits: 1 });
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'delivered', attempts: 1 });
  });

  it('records nothing for web jobs, API jobs without a webhookUrl, cancellations and later revisions', async () => {
    const web = h.as(await h.login(USERS.budi));
    const webJob = (await web.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' })).body.id;
    const silent = await apiJob(budi, null);
    const canceled = await apiJob();
    for (const [jobId, status] of [[webJob, 'done'], [silent, 'done'], [canceled, 'canceled']]) {
      h.engine.setJob(jobId, { status });
      await callback({ job_id: jobId, status, revision: 1 });
      expect(await delivery(jobId)).toBeUndefined();
    }
    expect(await h.ctx.webhooks.onTerminal(canceled, { status: 'done', revision: 2 })).toBe(false);
    expect(await delivery(canceled)).toBeUndefined();
  });

  it('retries at 1, 5 and 30 minutes, then drops the delivery', async () => {
    receiver.answer(() => [500, 'no', {}]);
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    const first = await delivery(jobId);
    expect(first).toMatchObject({ state: 'pending', attempts: 1, last_status: 500 });
    const gap = (new Date(first.next_attempt_at) - new Date(first.created_at)) / 1000;
    expect(gap).toBeGreaterThanOrEqual(59);
    expect(gap).toBeLessThan(62);
    await hooks.runOnce();
    expect((await delivery(jobId)).attempts).toBe(1); // not due yet
    for (const attempts of [2, 3]) {
      await makeDue(jobId);
      await hooks.runOnce();
      expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts });
    }
    await makeDue(jobId);
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'dropped', attempts: 4, last_status: 500 });
    expect(receiver.hits).toHaveLength(4);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'webhook_dropped', jobId, attempts: 4 }));
  });

  it('never follows a redirect and counts it as a failure', async () => {
    receiver.answer((req) => (req.url === '/hook' ? [302, '', { location: `${receiver.base}/elsewhere` }] : [200, 'ok', {}]));
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    expect(receiver.hits.map((x) => x.path)).toEqual(['/hook']);
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_status: 302 });
  });

  it('gives up on a receiver that does not answer in time', async () => {
    receiver.answer(() => null);
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_status: null, last_error: 'timeout' });
  });

  it('checks the address again at send time and refuses a non-public one', async () => {
    const jobId = crypto.randomUUID();
    await h.pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body) VALUES ($1, 'budi', $2, 'job.done', 'https://10.0.0.1/hook', '{}')`,
      [made.row.id, jobId],
    );
    await hooks.runOnce();
    const row = await delivery(jobId);
    expect(row).toMatchObject({ state: 'pending', attempts: 1, last_status: null });
    expect(row.last_error).toMatch(/^blocked: /);
    expect(receiver.hits).toHaveLength(0);
  });

  it("drops a revoked key's deliveries without sending", async () => {
    const other = await h.ctx.apiKeys.create('budi', { name: 'short-lived', tv: 0 });
    const jobId = await apiJob(h.api(other.key));
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await h.ctx.apiKeys.revoke('budi', other.row.id);
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'dropped', last_error: 'key_revoked' });
    expect(receiver.hits).toHaveLength(0);
  });

  it('is recorded by the reconciler when the engine callback was lost', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await h.pool.query(`UPDATE charges SET created_at = now() - interval '3 minutes' WHERE job_id = $1`, [jobId]);
    await createReconciler(h.ctx).runOnce();
    expect(await delivery(jobId)).toMatchObject({ event: 'job.done', state: 'pending' });
    await hooks.runOnce();
    expect(JSON.parse(receiver.hits[0].body)).toMatchObject({ event: 'job.done', jobId, credits: 1 });
    // the late engine callback finds it recorded: still one delivery, one send
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200);
    await makeDue(jobId);
    await hooks.runOnce();
    expect(receiver.hits).toHaveLength(1);
  });

  // `.invalid` never resolves (RFC 6761): reaching the receiver proves the connection used the checked address.
  const pinnedHooks = (looked) => createWebhooks(h.ctx, {
    timeoutMs: 500,
    lookup: async (host) => {
      looked.push(host);
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  const insertDelivery = async (url, { keyId = made.row.id, userId = 'budi' } = {}) => {
    const jobId = crypto.randomUUID();
    await h.pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body) VALUES ($1, $2, $3, 'job.done', $4, '{"ok":true}')`,
      [keyId, userId, jobId, url],
    );
    return jobId;
  };
  const until = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('connects to the address it checked, with the hostname as the Host header', async () => {
    const looked = [];
    const port = new URL(receiver.base).port;
    const jobId = await insertDelivery(`http://hook.invalid:${port}/pinned`);
    await pinnedHooks(looked).runOnce();
    expect(looked).toEqual(['hook.invalid']);
    expect(receiver.hits.map((x) => [x.path, x.headers.host])).toEqual([['/pinned', `hook.invalid:${port}`]]);
    verify(receiver.hits[0], made.webhookSecret);
    expect(await delivery(jobId)).toMatchObject({ state: 'delivered', attempts: 1, last_status: 200 });
  });

  it('offers the hostname as the TLS server name while connecting to the checked address', async () => {
    const names = [];
    const tlsServer = tls.createServer({
      SNICallback: (servername, cb) => {
        names.push(servername);
        cb(new Error('no certificate here'));
      },
    });
    tlsServer.on('tlsClientError', () => {});
    await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    try {
      const jobId = await insertDelivery(`https://hook.invalid:${tlsServer.address().port}/tls`);
      await pinnedHooks([]).runOnce();
      expect(names).toEqual(['hook.invalid']);
      const row = await delivery(jobId);
      expect(row).toMatchObject({ state: 'pending', attempts: 1, last_status: null });
      expect(row.last_error).not.toBe('timeout');
    } finally {
      await new Promise((resolve) => tlsServer.close(resolve));
    }
  });

  it("does not let one key's hanging receiver hold up another key, and sends one at a time per key", async () => {
    const other = await h.ctx.apiKeys.create('cici', { name: 'fast', tv: 0 });
    receiver.answer((req) => (req.url === '/slow' ? null : [200, 'ok', {}]));
    const slow = [await insertDelivery(`${receiver.base}/slow`), await insertDelivery(`${receiver.base}/slow`)];
    const fast = await insertDelivery(`${receiver.base}/fast`, { keyId: other.row.id, userId: 'cici' });
    const worker = createWebhooks(h.ctx, { timeoutMs: 1000 });
    const started = Date.now();
    const running = worker.runOnce();
    await until(async () => (await delivery(fast)).state === 'delivered');
    expect(Date.now() - started).toBeLessThan(800); // not behind the first 1 s timeout
    expect(receiver.hits.filter((x) => x.path === '/slow')).toHaveLength(1); // the second waits for the first
    await running;
    expect(receiver.hits.filter((x) => x.path === '/slow')).toHaveLength(2);
    for (const jobId of slow) expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_error: 'timeout' });
  });

  it('stop() aborts a send in flight and counts it as a failed attempt', async () => {
    receiver.answer(() => null);
    const jobId = await insertDelivery(`${receiver.base}/slow`);
    const worker = createWebhooks(h.ctx, { timeoutMs: 10_000 });
    const running = worker.runOnce();
    await until(() => receiver.hits.length === 1);
    const stopping = Date.now();
    await worker.stop();
    expect(Date.now() - stopping).toBeLessThan(1000);
    expect(await running).toEqual({ handled: 1 });
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_status: null, last_error: 'shutdown' });
  });

  it('skips a row another worker holds until its lease runs out', async () => {
    const jobId = await insertDelivery(receiver.url);
    await h.pool.query(`UPDATE webhook_deliveries SET sending_until = now() + interval '1 minute' WHERE job_id = $1`, [jobId]);
    expect(await hooks.runOnce()).toEqual({ handled: 0 });
    expect(receiver.hits).toHaveLength(0);
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 0 });
    await h.pool.query(`UPDATE webhook_deliveries SET sending_until = now() - interval '1 second' WHERE job_id = $1`, [jobId]);
    expect(await hooks.runOnce()).toEqual({ handled: 1 });
    expect(receiver.hits).toHaveLength(1);
    expect(await delivery(jobId)).toMatchObject({ state: 'delivered', attempts: 1, sending_until: null });
  });

  it("lists each key's newest 20 deliveries, only to the key's owner", async () => {
    const busy = await h.ctx.apiKeys.create('cici', { name: 'busy', tv: 0 });
    const { rows } = await h.pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body, state, created_at)
       SELECT $1, 'cici', gen_random_uuid(), 'job.done', 'https://example.com/h', '{}', 'delivered', now() - make_interval(secs => i)
       FROM generate_series(1, 22) i RETURNING job_id`,
      [busy.row.id],
    );
    const newest = rows.map((r) => r.job_id).slice(0, 20); // i = 1 is the newest
    const cici = (await h.as(await h.login(USERS.cici)).get('/api/keys')).body.deliveries;
    expect(cici.filter((d) => d.keyId === busy.row.id).map((d) => d.jobId)).toEqual(newest);
    expect(cici.every((d) => d.keyId !== made.row.id)).toBe(true);
    const budiPage = (await h.as(await h.login(USERS.budi)).get('/api/keys')).body.deliveries;
    expect(budiPage.length).toBeGreaterThan(0);
    expect(budiPage.every((d) => d.keyId === made.row.id)).toBe(true);
  });
});
