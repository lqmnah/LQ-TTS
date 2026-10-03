import crypto from 'node:crypto';
import express from 'express';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { countChars, countSentences, creditsFor, makeTitle, rupiahFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { toSummary } from '../services/jobs-repo.js';
import { ownJob, ownVoice, parseIdx } from '../services/ownership.js';

const FILE_NAMES = new Set(['final.mp3', 'final.wav', 'subs.srt', 'subs.vtt']);

function readText(value, max) {
  if (typeof value !== 'string') throw new ApiError('invalid_request', 'text is required');
  const text = value.trim();
  const chars = countChars(text);
  if (chars > max) throw new ApiError('too_large', 'text exceeds 20,000 characters');
  return { text, chars };
}

export function filesFor(jobId, engineFiles) {
  const out = {};
  for (const [name, url] of Object.entries(engineFiles ?? {})) {
    const rev = new URL(url, 'http://engine').searchParams.get('revision');
    out[name] = `/api/jobs/${jobId}/files/${name}${rev ? `?revision=${rev}` : ''}`;
  }
  return out;
}

export const toSentence = (jobId, s) => ({
  idx: s.idx, paragraphIdx: s.paragraph_idx, text: s.text, style: s.style, status: s.status, score: s.score,
  durationS: s.duration_s, startS: s.start_s, endS: s.end_s,
  audioUrl: s.audio_url ? `/api/jobs/${jobId}/sentences/${s.idx}/audio` : null,
});

export function jobsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo } = ctx;
  const router = express.Router();

  router.post('/jobs/estimate', async (req, res) => {
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    const credits = chars === 0 ? 0 : creditsFor(chars);
    const session = await accounts.fresh(req.session);
    res.json({ chars, credits, rupiah: rupiahFor(credits), balance: session.balance, sentences: countSentences(text) });
  });

  router.post('/jobs', async (req, res) => {
    const { voiceId, settings = {} } = req.body ?? {};
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    if (chars === 0) throw new ApiError('invalid_request', 'text is empty');
    if (typeof voiceId !== 'string') throw new ApiError('invalid_request', 'voiceId is required');
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new ApiError('invalid_request', 'settings must be an object');
    }
    const userId = req.session.user_id;
    await accounts.fresh(req.session);
    const voice = await ownVoice(ctx, userId, voiceId);
    if (voice.status !== 'ready') throw new ApiError('voice_not_ready', `voice is ${voice.status}`);
    const credits = creditsFor(chars);
    const key = crypto.randomUUID();
    const charge = await charges.insertHeld({ userId, revision: 1, kind: 'job', chars, credits, holdId: `tts:${key}:r1` });
    await charges.hold(charge);
    let created;
    try {
      created = await engine.createJob({ voiceId: voice.id, text, settings, callbackUrl: config.engineCallbackUrl, idempotencyKey: key });
    } catch (err) {
      await charges.refundNow(charge);
      throw engineError(err);
    }
    await jobsRepo.insertWithCharge({
      id: created.id, userId, voiceId: voice.id, voiceName: voice.name, title: makeTitle(text), chars, chargeId: charge.id,
    });
    res.status(202).json({ id: created.id, credits, estimatedSeconds: created.estimated_seconds });
  });

  router.get('/jobs', async (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_request', 'limit must be 1-100');
    let before = null;
    if (req.query.before !== undefined) {
      before = new Date(String(req.query.before));
      if (Number.isNaN(before.getTime())) throw new ApiError('invalid_request', 'before must be an ISO date');
    }
    const rows = await jobsRepo.list(req.session.user_id, { limit, before });
    res.json({ items: rows.map(toSummary), nextBefore: rows.length === limit ? rows.at(-1).created_at.toISOString() : null });
  });

  router.get('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    let view;
    try {
      view = await engine.getJob(job.id);
    } catch (err) {
      if (isEngineNotFound(err)) {
        await jobsRepo.markDeleted(job.id);
        throw new ApiError('not_found', 'job not found');
      }
      throw engineError(err);
    }
    await jobsRepo.applyEngineState(job.id, {
      status: view.status, revision: view.revision, audioSeconds: view.audio_seconds, finishedAt: view.finished_at,
    });
    const row = await jobsRepo.own(req.session.user_id, job.id);
    res.json({
      ...toSummary(row),
      progress: view.progress,
      needsReview: view.needs_review,
      settings: view.settings,
      files: filesFor(job.id, view.files),
      revisions: Array.from({ length: view.revision }, (_, i) => i + 1),
    });
  });

  router.get('/jobs/:id/sentences', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    let list;
    try {
      list = await engine.sentences(job.id);
    } catch (err) {
      throw engineError(err);
    }
    res.json(list.map((s) => toSentence(job.id, s)));
  });

  router.get('/jobs/:id/sentences/:idx/audio', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    const idx = parseIdx(req.params.idx);
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/sentences/${idx}/audio.wav`);
  });

  router.get('/jobs/:id/files/:name', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    if (!FILE_NAMES.has(req.params.name)) throw new ApiError('not_found', 'unknown file');
    const rev = req.query.revision;
    if (rev !== undefined && !/^[1-9]\d{0,5}$/.test(String(rev))) throw new ApiError('invalid_request', 'revision must be a positive integer');
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/files/${req.params.name}${rev ? `?revision=${rev}` : ''}`);
  });

  return router;
}
