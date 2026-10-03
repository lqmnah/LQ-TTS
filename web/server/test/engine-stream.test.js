import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../clients/engine.js';
import { startFakeEngine } from './fakes/fake-engine.js';

// The global dispatcher's bodyTimeout (undici default 300 s) stands in for any idle-body limit;
// shortening it to 1 s (undici does not enforce sub-second body timeouts) makes a quiet SSE stream trip it quickly.
describe('engine.stream body timeout', () => {
  let eng;
  let engine;
  let previous;
  let shortAgent;
  beforeAll(async () => {
    previous = getGlobalDispatcher();
    shortAgent = new Agent({ bodyTimeout: 1000 });
    setGlobalDispatcher(shortAgent);
    eng = await startFakeEngine({ token: 'engine-token' });
    engine = createEngine({ baseUrl: eng.url, token: 'engine-token' });
  });
  afterAll(async () => {
    setGlobalDispatcher(previous);
    await shortAgent.close();
    await eng.close();
  });

  it('keeps an SSE stream open while the engine is silent past the global bodyTimeout', { timeout: 10000 }, async () => {
    const voice = eng.addVoice({ owner_ref: 'u1' });
    const job = await engine.createJob({ voiceId: voice.id, text: 'Satu.', idempotencyKey: 'k-stream-1' });
    eng.state.events.set(job.id, [['__sleep', 2500], ['job_done', { revision: 1 }]]);
    const res = await engine.stream(`/v1/jobs/${job.id}/events`, { sse: true });
    expect(await res.text()).toBe('event: job_done\ndata: {"revision":1}\n\n');
  });
});
