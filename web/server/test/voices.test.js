import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function upload(client, { fields = { name: 'Suara Saya', consent: 'true' }, file = Buffer.alloc(4096, 1), filename = 'me.wav', headers = {} } = {}) {
  let req = client.upload('/api/voices').set(headers);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req.attach('audio', file, filename);
}

describe('voices', () => {
  let h;
  let ana;
  let budi;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    budi = h.as(await h.login(USERS.budi));
  });
  afterAll(async () => {
    await h.close();
  });
  const engineUploads = () => h.engine.state.callsTo('POST', '/v1/voices').length;

  it('lists only my voices in the browser shape', async () => {
    const mine = h.engine.addVoice({ owner_ref: 'ana', name: 'A' });
    h.engine.addVoice({ owner_ref: 'budi', name: 'B' });
    const res = await ana.get('/api/voices');
    expect(res.body).toEqual([{
      id: mine.id, name: 'A', language: 'id', status: 'ready', errorCode: null, refSeconds: 12.5,
      createdAt: mine.created_at, previewUrl: `/api/voices/${mine.id}/preview`,
    }]);
  });

  it('streams the recording to the engine and records consent with IP and version', async () => {
    const audio = crypto.randomBytes(2 * 1024 * 1024 + 3);
    const res = await upload(budi, {
      fields: { name: 'Narator', language: 'en', transcript: 'Hello there.', consent: 'true' },
      file: audio, filename: 'take.flac', headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'processing' });
    const stored = h.engine.state.voices.get(res.body.id);
    expect(stored).toMatchObject({ owner_ref: 'budi', name: 'Narator', language: 'en', bytes: audio.length, sha256: sha(audio) });
    expect(stored.fields.transcript).toBe('Hello there.');
    const { rows: [consent] } = await h.pool.query('SELECT * FROM voice_consents WHERE voice_id = $1', [res.body.id]);
    expect(consent).toMatchObject({ user_id: 'budi', ip: '198.51.100.9', consent_version: 'v1' });
    expect(consent.accepted_at).toBeInstanceOf(Date);
  });

  it('requires consent before the file and forwards nothing without it', async () => {
    const before = engineUploads();
    expect((await upload(budi, { fields: { name: 'X' } })).body.error.code).toBe('consent_required');
    expect((await upload(budi, { fields: { name: 'X', consent: 'false' } })).body.error.code).toBe('consent_required');
    const late = await budi.upload('/api/voices').field('name', 'X').attach('audio', Buffer.alloc(10), 'a.wav').field('consent', 'true');
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('consent_required');
    expect(engineUploads()).toBe(before);
  });

  it('rejects unsupported files and missing names before the engine', async () => {
    const before = engineUploads();
    const txt = await upload(budi, { filename: 'notes.txt' });
    expect(txt.status).toBe(415);
    expect(txt.body.error.code).toBe('unsupported_audio');
    expect((await upload(budi, { fields: { consent: 'true' } })).body.error.code).toBe('invalid_request');
    expect(engineUploads()).toBe(before);
  });

  it('stops a Free account at 3 processing/ready voices (failed ones do not count)', async () => {
    const poor = h.as(await h.login(USERS.poor));
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'failed', error_code: 'no_clean_speech' });
    const before = engineUploads();
    const res = await upload(poor);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('voice_limit_reached');
    expect(engineUploads()).toBe(before);
  });

  it('lets a paid account keep 25 voices', async () => {
    const have = (await budi.get('/api/me')).body.voiceCount;
    for (let i = have; i < 24; i += 1) h.engine.addVoice({ owner_ref: 'budi', status: 'ready' });
    expect((await upload(budi)).status).toBe(202);
    const over = await upload(budi);
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('voice_limit_reached');
  });

  it("streams the preview of my voice and hides other users' voices", async () => {
    const mine = h.engine.addVoice({ owner_ref: 'ana', name: 'Preview' });
    const res = await ana.get(`/api/voices/${mine.id}/preview`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Buffer.compare(res.body, WAV_BYTES)).toBe(0);
    expect((await budi.get(`/api/voices/${mine.id}/preview`)).status).toBe(404);
    expect((await budi.del(`/api/voices/${mine.id}`)).status).toBe(404);
    expect(h.engine.state.voices.has(mine.id)).toBe(true);
  });

  it('deleting a voice removes its jobs and refunds their held charges', async () => {
    const doomed = h.engine.addVoice({ owner_ref: 'ana', name: 'Doomed' });
    const { body: { id: jobId } } = await ana.post('/api/jobs', { voiceId: doomed.id, text: 'Halo.' });
    const balance = h.lq.state.users.get('ana').balance;
    expect((await ana.del(`/api/voices/${doomed.id}`)).status).toBe(204);
    expect(h.engine.state.voices.has(doomed.id)).toBe(false);
    expect((await ana.get(`/api/jobs/${jobId}`)).status).toBe(404);
    const { rows: [charge] } = await h.pool.query('SELECT state FROM charges WHERE job_id = $1', [jobId]);
    expect(charge.state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(balance + 1);
  });
});

describe('voice upload size limit', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness({ env: { MAX_UPLOAD_BYTES: String(1024 * 1024) } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers 413 when the stream passes the limit and the engine keeps nothing', async () => {
    const budi = h.as(await h.login(USERS.budi));
    const res = await upload(budi, { file: crypto.randomBytes(1.5 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({ code: 'too_large', message: 'upload exceeds 1 MB' });
    expect(h.engine.state.voices.size).toBe(0);
  });
});

describe('voice upload concurrency and client aborts', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const leases = async () => (await h.pool.query('SELECT user_id FROM upload_leases')).rows;
  async function until(check, ms = 1000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return check();
  }

  it('lets only one upload per user run, so two at once cannot pass the plan limit', async () => {
    const ana = h.as(await h.login(USERS.ana));
    h.engine.addVoice({ owner_ref: 'ana' });
    h.engine.addVoice({ owner_ref: 'ana' });
    let open;
    h.engine.state.voiceGate = new Promise((resolve) => {
      open = resolve;
    });
    const settled = [];
    const both = [upload(ana), upload(ana)].map((r) => new Promise((resolve, reject) => {
      r.then((res) => {
        settled.push(res);
        resolve(res);
      }, reject);
    }));
    await until(() => h.engine.state.heldUploads === 2 || settled.length > 0, 3000);
    h.engine.state.voiceGate = null;
    open();
    const statuses = (await Promise.all(both)).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409]);
    const busy = (await Promise.all(both)).find((r) => r.status === 409);
    expect(busy.body.error).toEqual({ code: 'voice_not_ready', message: 'another voice upload is still in progress' });
    expect([...h.engine.state.voices.values()].filter((v) => v.owner_ref === 'ana')).toHaveLength(3);
    expect(await leases()).toEqual([]);
  });

  it('releases the lease after an engine error', async () => {
    const budi = h.as(await h.login(USERS.budi));
    h.engine.state.failNext.set('POST /v1/voices', { status: 503, code: 'model_loading' });
    expect((await upload(budi)).status).toBe(503);
    expect(await leases()).toEqual([]);
    expect((await upload(budi)).status).toBe(202);
  });

  it('ignores an expired lease left by another request', async () => {
    const budi = h.as(await h.login(USERS.budi));
    await h.pool.query(
      "INSERT INTO upload_leases (user_id, token, until) VALUES ('budi', $1, now() - interval '1 minute')",
      [crypto.randomUUID()],
    );
    expect((await upload(budi)).status).toBe(202);
    expect(await leases()).toEqual([]);
  });

  it('aborts the engine upload and releases the lease when the browser goes away', async () => {
    const cookie = await h.login(USERS.budi);
    const server = h.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const voicesBefore = h.engine.state.voices.size;
    const boundary = 'abort-test-boundary';
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/voices', method: 'POST',
      headers: { cookie, 'x-requested-with': 'lq-tts', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    req.on('error', () => {});
    const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    req.write(field('name', 'Abort') + field('consent', 'true')
      + `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
    req.write(crypto.randomBytes(2 * 1024 * 1024));
    expect(await until(() => h.engine.state.openUploads === 1, 3000)).toBe(true);
    req.destroy();
    try {
      expect(await until(() => h.engine.state.openUploads === 0)).toBe(true);
      expect(await until(async () => (await leases()).length === 0)).toBe(true);
      expect(h.engine.state.voices.size).toBe(voicesBefore);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
