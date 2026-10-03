import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USERS, startHarness, text } from './helpers.js';

describe('job events', () => {
  let h;
  let ana;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('relays engine events and renames error_code to errorCode', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.events.set(id, [
      ['sentence_done', { idx: 0, status: 'done', score: 0.97, revision: 1 }],
      ['job_failed', { status: 'failed', error_code: 'synthesis_failed' }],
    ]);
    const res = await ana.get(`/api/jobs/${id}/events`).buffer(true).parse(text);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.body).toBe(
      'event: sentence_done\ndata: {"idx":0,"status":"done","score":0.97,"revision":1}\n\n'
      + 'event: job_failed\ndata: {"status":"failed","errorCode":"synthesis_failed"}\n\n',
    );
  });

  it("hides another user's event stream", async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    const budi = h.as(await h.login(USERS.budi));
    expect((await budi.get(`/api/jobs/${id}/events`)).status).toBe(404);
  });

  it('reports an engine outage before the stream starts', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.failNext.set('GET /v1/jobs/:id/events', { status: 503, code: 'disk_full' });
    const res = await ana.get(`/api/jobs/${id}/events`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('engine_unavailable');
  });
});

describe('job events keepalive', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness({ app: { sseKeepaliveMs: 20 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('writes keepalive comments while the engine is quiet', async () => {
    const ana = h.as(await h.login(USERS.ana));
    const voice = h.engine.addVoice({ owner_ref: 'ana' });
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.events.set(id, [['__sleep', 150], ['job_done', { revision: 1 }]]);
    const res = await ana.get(`/api/jobs/${id}/events`).buffer(true).parse(text);
    expect(res.body).toMatch(/^(: keepalive\n\n)+event: job_done\ndata: \{"revision":1\}\n\n$/);
  });
});
