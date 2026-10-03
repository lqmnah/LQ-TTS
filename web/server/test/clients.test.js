import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../clients/engine.js';
import { UpstreamUnavailable } from '../clients/http.js';
import { createLqStudio } from '../clients/lqstudio.js';
import { startFakeEngine } from './fakes/fake-engine.js';
import { startFakeLqStudio } from './fakes/fake-lqstudio.js';

const LQ_TOKEN = 'l'.repeat(40);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('upstream clients', () => {
  let lq;
  let eng;
  let lqClient;
  let engine;
  beforeAll(async () => {
    lq = await startFakeLqStudio({
      token: LQ_TOKEN,
      users: [{ id: 'u1', name: 'Ana', email: 'ana@example.com', username: 'ana', password: 'pw', totp: null, verified: true, suspended: false, plan: 'free', paid: false, balance: 100 }],
    });
    eng = await startFakeEngine({ token: 'engine-token' });
    lqClient = createLqStudio({ baseUrl: lq.url, token: LQ_TOKEN });
    engine = createEngine({ baseUrl: eng.url, token: 'engine-token' });
  });
  afterAll(async () => {
    await lq.close();
    await eng.close();
  });

  it('reads the error code from LQ-Studio bodies, including guard rejections', async () => {
    await expect(lqClient.verify({ identifier: 'ana', password: 'bad', ip: '1.2.3.4' }))
      .rejects.toMatchObject({ name: 'UpstreamError', status: 401, code: 'invalid_credentials' });
    await expect(createLqStudio({ baseUrl: lq.url, token: 'w'.repeat(40) }).getUser('u1'))
      .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('reads the error code from engine bodies', async () => {
    await expect(engine.getVoice(crypto.randomUUID())).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('treats 5xx and connection failures as unavailable', async () => {
    lq.state.down = true;
    try {
      await expect(lqClient.getUser('u1')).rejects.toBeInstanceOf(UpstreamUnavailable);
      expect(await lqClient.ping()).toBe(false);
    } finally {
      lq.state.down = false;
    }
    expect(await lqClient.ping()).toBe(true);
    await expect(createEngine({ baseUrl: 'http://127.0.0.1:9', token: 'x' }).getJob(crypto.randomUUID()))
      .rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it('streams an upload to the engine byte-for-byte with its fields', async () => {
    const audio = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const out = await engine.uploadVoice({
      fields: { name: 'Suara "Ana"', owner_ref: 'u1', language: 'id', transcript: undefined },
      filename: 'ana.wav',
      mimeType: 'audio/wav',
      file: Readable.from([audio.subarray(0, 1000), audio.subarray(1000)]),
    });
    expect(out.status).toBe('processing');
    const stored = eng.state.voices.get(out.id);
    expect(stored).toMatchObject({ owner_ref: 'u1', name: 'Suara "Ana"', bytes: audio.length, sha256: sha(audio) });
    expect(stored.fields).not.toHaveProperty('transcript');
  });

  it('aborts a truncated upload so the engine stores nothing', async () => {
    const before = eng.state.voices.size;
    const file = Readable.from([crypto.randomBytes(64 * 1024)]);
    file.truncated = true; // what busboy sets when the size limit was hit
    await expect(engine.uploadVoice({ fields: { name: 'x', owner_ref: 'u1' }, filename: 'x.wav', mimeType: 'audio/wav', file }))
      .rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(eng.state.voices.size).toBe(before);
  });
});
