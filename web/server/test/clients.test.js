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
      users: [
        { id: 'u1', name: 'Ana', email: 'ana@example.com', username: 'ana', password: 'pw', totp: null, verified: true, suspended: false, plan: 'free', paid: false, balance: 100 },
        { id: 'u2', name: 'Budi', email: 'budi@example.com', username: 'budi', password: 'pw', totp: '123456', verified: true, suspended: false, plan: 'free', paid: false, balance: 10 },
      ],
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

  it('verify-2fa rejects a suspended account and reports an unverified one', async () => {
    const twoFa = async () => {
      const { challenge } = await lqClient.verify({ identifier: 'budi', password: 'pw', ip: '1.2.3.4' });
      return lqClient.verify2fa({ challenge, code: '123456', ip: '1.2.3.4' });
    };
    const budi = lq.state.users.get('u2');
    expect(await twoFa()).toMatchObject({ status: 'ok', user: { id: 'u2' } });
    budi.suspended = true;
    await expect(twoFa()).rejects.toMatchObject({ name: 'UpstreamError', status: 403, code: 'suspended' });
    budi.suspended = false;
    budi.verified = false;
    // verify() itself stops unverified users, so mint the challenge the way a pre-verification login would have
    lq.state.challenges.set('ch:manual', 'u2');
    expect(await lqClient.verify2fa({ challenge: 'ch:manual', code: '123456', ip: '1.2.3.4' })).toEqual({ status: 'needs_verification' });
    budi.verified = true;
  });

  it('holds are idempotent per ref and refuse a ref owned by another user', async () => {
    const ref = `tts:${crypto.randomUUID()}:r1`;
    const first = await lqClient.hold({ userId: 'u1', amount: 10, ref });
    expect(first).toEqual({ holdId: ref, charged: 10, balance: 90 });
    expect(await lqClient.hold({ userId: 'u1', amount: 25, ref })).toEqual(first);
    expect(lq.state.net(ref)).toBe(10);
    await expect(lqClient.hold({ userId: 'u2', amount: 1, ref }))
      .rejects.toMatchObject({ name: 'UpstreamError', status: 409, code: 'ref_conflict' });
    await lqClient.refund({ userId: 'u1', holdId: ref });
  });

  it('a short balance answers 402 with the balance', async () => {
    const err = await lqClient.hold({ userId: 'u2', amount: 11, ref: `tts:${crypto.randomUUID()}:r1` }).catch((e) => e);
    expect(err).toMatchObject({ name: 'UpstreamError', status: 402, code: 'insufficient_credits', body: { balance: 10 } });
  });

  it('settle rejects overspend and unknown holds; refund rejects unknown holds', async () => {
    const ref = `tts:${crypto.randomUUID()}:r1`;
    await lqClient.hold({ userId: 'u1', amount: 10, ref });
    await expect(lqClient.settle({ userId: 'u1', holdId: ref, amount: 11 }))
      .rejects.toMatchObject({ name: 'UpstreamError', status: 400, code: 'invalid_request' });
    expect(await lqClient.settle({ userId: 'u1', holdId: ref, amount: 4 })).toEqual({ balance: 96 });
    await expect(lqClient.settle({ userId: 'u1', holdId: 'tts:nope:r1', amount: 1 }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(lqClient.refund({ userId: 'u1', holdId: 'tts:nope:r1' }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(lqClient.settle({ userId: 'u2', holdId: ref, amount: 1 }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('settle and refund are terminal both ways, and settle is checked against the gross charge', async () => {
    const a = `tts:${crypto.randomUUID()}:r1`;
    await lqClient.hold({ userId: 'u1', amount: 10, ref: a });
    await expect(lqClient.settle({ userId: 'u1', holdId: a, amount: 11 }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    const { balance: afterRefund } = await lqClient.refund({ userId: 'u1', holdId: a });
    expect(await lqClient.settle({ userId: 'u1', holdId: a, amount: 10 })).toEqual({ balance: afterRefund });
    expect(lq.state.net(a)).toBe(0);
    const b = `tts:${crypto.randomUUID()}:r1`;
    await lqClient.hold({ userId: 'u1', amount: 10, ref: b });
    const { balance: afterSettle } = await lqClient.settle({ userId: 'u1', holdId: b, amount: 6 });
    expect(await lqClient.refund({ userId: 'u1', holdId: b })).toEqual({ balance: afterSettle, refunded: 0 });
    expect(lq.state.net(b)).toBe(6);
  });

  it('verify-2fa reports suspension before checking the code and keeps the challenge', async () => {
    const { challenge } = await lqClient.verify({ identifier: 'budi', password: 'pw', ip: '1.2.3.4' });
    lq.state.users.get('u2').suspended = true;
    try {
      await expect(lqClient.verify2fa({ challenge, code: '000000', ip: '1.2.3.4' }))
        .rejects.toMatchObject({ name: 'UpstreamError', status: 403, code: 'suspended' });
    } finally {
      lq.state.users.get('u2').suspended = false;
    }
    await expect(lqClient.verify2fa({ challenge, code: '000000', ip: '1.2.3.4' })).rejects.toMatchObject({ status: 401, code: 'invalid_code' });
    expect(await lqClient.verify2fa({ challenge, code: '123456', ip: '1.2.3.4' })).toMatchObject({ status: 'ok' });
  });

  it('ledger outages surface as unavailable', async () => {
    lq.state.failNext.set('POST /credits/hold', 1);
    await expect(lqClient.hold({ userId: 'u1', amount: 1, ref: `tts:${crypto.randomUUID()}:r1` })).rejects.toMatchObject({ name: 'UpstreamUnavailable', status: 503 });
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
