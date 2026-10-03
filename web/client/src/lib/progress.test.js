import { describe, expect, it } from 'vitest';
import { TERMINAL, doneCount, progressReducer } from './progress.js';

const job = (over = {}) => ({ id: 'j1', status: 'running', revision: 1, errorCode: null, progress: { done: 0, total: 3 }, ...over });
const sentence = (idx, status = 'pending', score = null) => ({ idx, status, score });
const snapshot = (j = job(), s = [sentence(0), sentence(1), sentence(2)]) =>
  progressReducer(null, { type: 'snapshot', job: j, sentences: s });

describe('progressReducer', () => {
  it('builds state from a snapshot', () => {
    const state = snapshot(job(), [sentence(0, 'done', 0.97), sentence(1), sentence(2)]);
    expect(state.status).toBe('running');
    expect(state.total).toBe(3);
    expect(doneCount(state)).toBe(1);
  });

  it('marks sentences done one by one and moves a queued job to running', () => {
    let state = snapshot(job({ status: 'queued' }));
    state = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    expect(state.status).toBe('running');
    expect(state.lastArrived).toBe(0);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'needs_review', score: 0.7, revision: 1 });
    expect(doneCount(state)).toBe(2);
  });

  it('ignores an identical replayed event (reconnect) without changing identity', () => {
    let state = snapshot();
    state = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    const again = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    expect(again).toBe(state);
  });

  it('drops events from an older revision', () => {
    const state = snapshot(job({ revision: 2 }));
    expect(progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 1, revision: 1 })).toBe(state);
    expect(progressReducer(state, { type: 'job_done', revision: 1 })).toBe(state);
  });

  it('keeps a finished job finished when old sentences are replayed', () => {
    let state = snapshot(job({ status: 'done' }), [sentence(0, 'done', 0.9), sentence(1, 'done', 0.9), sentence(2, 'done', 0.9)]);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'done', score: 0.91, revision: 1 });
    expect(state.status).toBe('done');
  });

  it('finishes and fails jobs', () => {
    const done = progressReducer(snapshot(), { type: 'job_done', revision: 1 });
    expect(done.status).toBe('done');
    expect(TERMINAL.has(done.status)).toBe(true);
    const failed = progressReducer(snapshot(), { type: 'job_failed', status: 'failed', errorCode: 'synthesis_failed' });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'synthesis_failed' });
    const canceled = progressReducer(snapshot(), { type: 'job_failed', status: 'canceled', errorCode: null });
    expect(canceled.status).toBe('canceled');
  });

  it('restarts one sentence on regenerate under the new revision', () => {
    let state = snapshot(job({ status: 'done' }), [sentence(0, 'done', 0.9), sentence(1, 'done', 0.9), sentence(2, 'done', 0.9)]);
    state = progressReducer(state, { type: 'regenerate_started', idx: 1, revision: 2 });
    expect(state).toMatchObject({ status: 'queued', revision: 2 });
    expect(state.sentences[1]).toEqual({ status: 'pending', score: null });
    expect(doneCount(state)).toBe(2);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'done', score: 0.96, revision: 2 });
    state = progressReducer(state, { type: 'job_done', revision: 2 });
    expect(state.status).toBe('done');
    expect(doneCount(state)).toBe(3);
  });
});
