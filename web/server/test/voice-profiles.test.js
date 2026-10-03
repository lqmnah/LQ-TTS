import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UpstreamUnavailable } from '../clients/http.js';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

const meta = (slug, { name = 'Pandji', sort = 100 } = {}) => ({
  slug,
  name,
  gender: 'male',
  language: 'id',
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }],
  bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: 'Pandji', attestedBy: 'lqmnah', scope: 'Public library voice' },
  sort,
});

describe('VO Profiles', () => {
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

  async function addProfile(slug, { status = 'ready', name = 'Pandji', sort = 100, ownerRef = 'library' } = {}) {
    const voice = h.engine.addVoice({ owner_ref: ownerRef, name, status });
    await h.ctx.profiles.upsert(meta(slug, { name, sort }), voice.id);
    return voice;
  }

  it('lists a profile in the browser shape, uncached', async () => {
    const voice = await addProfile('shape');
    const res = await ana.get('/api/voice-profiles');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.find((p) => p.id === voice.id)).toEqual({
      id: voice.id, slug: 'shape', name: 'Pandji', gender: 'male', language: 'id', status: 'ready', errorCode: null,
      description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
      tags: [{ id: 'Pria', en: 'Male' }],
      bestFor: { id: 'Narasi.', en: 'Narration.' },
      previewUrl: `/api/voices/${voice.id}/preview`,
    });
  });

  it('needs a session', async () => {
    const res = await request(h.app).get('/api/voice-profiles');
    expect(res.status).toBe(401);
  });

  it('orders by sort then name and leaves out inactive, missing and non-library voices', async () => {
    const bima = await addProfile('ord-b', { name: 'Bima', sort: 20 });
    const zara = await addProfile('ord-z', { name: 'Zara', sort: 10 });
    const ayu = await addProfile('ord-a', { name: 'Ayu', sort: 20 });
    const busy = await addProfile('ord-p', { name: 'Proses', sort: 30, status: 'processing' });
    const off = await addProfile('ord-off', { name: 'Mati', sort: 1 });
    await h.ctx.profiles.deactivate('ord-off');
    const gone = await addProfile('ord-gone', { name: 'Hilang', sort: 1 });
    h.engine.state.voices.delete(gone.id);
    const foreign = await addProfile('ord-foreign', { name: 'Asing', sort: 1, ownerRef: 'ana' });
    const ids = new Set([bima, zara, ayu, busy, off, gone, foreign].map((v) => v.id));
    const res = await ana.get('/api/voice-profiles');
    expect(res.body.filter((p) => ids.has(p.id)).map((p) => [p.name, p.status])).toEqual([
      ['Zara', 'ready'], ['Ayu', 'ready'], ['Bima', 'ready'], ['Proses', 'processing'],
    ]);
  });

  it('still lists profiles, without a status, when the engine is unreachable', async () => {
    const voice = await addProfile('offline');
    const { engine } = h.ctx;
    const original = engine.getVoice;
    engine.getVoice = async () => {
      throw new UpstreamUnavailable('engine', new Error('connect ECONNREFUSED'));
    };
    try {
      const res = await ana.get('/api/voice-profiles');
      expect(res.status).toBe(200);
      expect(res.body.find((p) => p.id === voice.id)).toMatchObject({ status: null, errorCode: null, previewUrl: `/api/voices/${voice.id}/preview` });
    } finally {
      engine.getVoice = original;
    }
  });

  it('lets two different users preview a profile and voice over with it at the normal price', async () => {
    const voice = await addProfile('shared');
    for (const client of [ana, budi]) {
      const preview = await client.get(`/api/voices/${voice.id}/preview`).buffer(true).parse(binary);
      expect(preview.status).toBe(200);
      expect(Buffer.compare(preview.body, WAV_BYTES)).toBe(0);
      const job = await client.post('/api/jobs', { voiceId: voice.id, text: 'Halo dunia.' });
      expect(job.status).toBe(202);
      expect(job.body.credits).toBe(1);
      expect(h.engine.state.jobs.get(job.body.id).voice_id).toBe(voice.id);
      const list = await client.get('/api/jobs');
      expect(list.body.items[0]).toMatchObject({ id: job.body.id, voiceId: voice.id, voiceName: 'Pandji' });
    }
  });

  it('never lets a user delete a profile', async () => {
    const voice = await addProfile('undeletable');
    const res = await ana.del(`/api/voices/${voice.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(h.engine.state.voices.has(voice.id)).toBe(true);
    expect((await ana.get('/api/voice-profiles')).body.some((p) => p.id === voice.id)).toBe(true);
  });

  it('does not count profiles toward the voice limit', async () => {
    const poor = h.as(await h.login(USERS.poor));
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    await addProfile('free-of-limit');
    expect((await poor.get('/api/me')).body.voiceCount).toBe(2);
    const res = await poor.upload('/api/voices').field('name', 'Ketiga').field('consent', 'true')
      .attach('audio', Buffer.alloc(4096, 1), 'take.wav');
    expect(res.status).toBe(202);
  });

  it('turns an inactive profile away everywhere and keeps its engine voice', async () => {
    const voice = await addProfile('retired');
    await h.ctx.profiles.deactivate('retired');
    expect((await ana.get(`/api/voices/${voice.id}/preview`)).status).toBe(404);
    const job = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo dunia.' });
    expect(job.status).toBe(404);
    expect(job.body.error.code).toBe('not_found');
    expect((await ana.get('/api/voice-profiles')).body.some((p) => p.id === voice.id)).toBe(false);
    expect(h.engine.state.voices.has(voice.id)).toBe(true);
  });

  it('refuses a library voice that has no profile row', async () => {
    const stray = h.engine.addVoice({ owner_ref: 'library', name: 'Stray' });
    expect((await ana.get(`/api/voices/${stray.id}/preview`)).status).toBe(404);
    expect((await ana.post('/api/jobs', { voiceId: stray.id, text: 'Halo dunia.' })).status).toBe(404);
  });

  it("still refuses another user's own voice", async () => {
    const theirs = h.engine.addVoice({ owner_ref: 'budi', name: 'Milik Budi' });
    expect((await ana.get(`/api/voices/${theirs.id}/preview`)).status).toBe(404);
    expect((await ana.post('/api/jobs', { voiceId: theirs.id, text: 'Halo dunia.' })).status).toBe(404);
  });
});
