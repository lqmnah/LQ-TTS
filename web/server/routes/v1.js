import crypto from 'node:crypto';
import express from 'express';
import { requireApiKey } from '../http/api-auth.js';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { countSentences, creditsFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { API_FILES, readIdempotencyKey, toApiJob } from '../services/api-jobs.js';
import { ownJob, usableVoice } from '../services/ownership.js';
import { profilesWithVoices } from '../services/profiles.js';
import { queueVoiceover, readJobInput, readText } from '../services/voiceovers.js';
import { WebhookUrlError, resolveWebhookUrl } from '../services/webhook-security.js';

/** Public API (spec §2.2): Bearer keys only, JSON, errors {error:{code,message}}. Mounted at /v1 before any cookie code. */
export function v1Router(ctx) {
  const { config, engine, charges, jobsRepo, apiJobs, jobControl } = ctx;
  const router = express.Router();
  router.use(requireApiKey(ctx));
  router.use(express.json({ limit: '256kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/voices', async (req, res) => {
    let own;
    try {
      own = await engine.listVoices(req.apiUserId);
    } catch (err) {
      throw engineError(err);
    }
    const profiles = await profilesWithVoices(ctx);
    res.json({
      voices: [
        ...own.filter((v) => v.status === 'ready').map((v) => ({ id: v.id, name: v.name, language: v.language, kind: 'own' })),
        ...profiles.filter(({ row, voice }) => row.api_allowed && voice?.status === 'ready').map(({ row }) => ({
          id: row.voice_id, name: row.name, language: row.language, kind: 'profile',
          description: { id: row.description_id, en: row.description_en },
        })),
      ],
    });
  });

  router.post('/estimate', async (req, res) => {
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    res.json({ chars, credits: chars === 0 ? 0 : creditsFor(chars), sentences: countSentences(text) });
  });

  async function checkedWebhookUrl(raw) {
    if (raw === null) return null;
    try {
      return (await resolveWebhookUrl(raw, { allowLoopback: config.webhookAllowLoopback })).url;
    } catch (err) {
      if (err instanceof WebhookUrlError) throw new ApiError('invalid_webhook_url', err.message);
      throw err;
    }
  }

  router.post('/tts', async (req, res) => {
    const userId = req.apiUserId;
    const input = readJobInput(req.body, config.maxTextChars);
    const { formats, webhookUrl = null } = req.body;
    if (formats !== undefined && !Array.isArray(formats)) throw new ApiError('invalid_request', 'formats must be an array');
    if (webhookUrl !== null && typeof webhookUrl !== 'string') throw new ApiError('invalid_request', 'webhookUrl must be a string');
    const settings = formats === undefined ? input.settings : { ...input.settings, formats };
    const idemKey = readIdempotencyKey(req.get('idempotency-key'));
    if (idemKey && !(await apiJobs.claimKey(userId, idemKey))) {
      const prior = await apiJobs.keyJob(userId, idemKey);
      if (!prior) throw new ApiError('idempotency_conflict', 'a request with this Idempotency-Key is still being processed');
      const job = await ownJob(ctx, userId, prior);
      res.status(202).set('Idempotent-Replayed', 'true').json({ jobId: job.id, credits: job.credits, status: job.status });
      return;
    }
    try {
      const voice = await usableVoice(ctx, userId, input.voiceId, { api: true });
      if (voice.status !== 'ready') throw new ApiError('voice_not_ready', `voice is ${voice.status}`);
      const webhook = await checkedWebhookUrl(webhookUrl);
      const credits = creditsFor(input.chars);
      const key = crypto.randomUUID();
      const charge = await apiJobs.reserve(charges, { userId, revision: 1, kind: 'job', chars: input.chars, credits, holdId: `tts:${key}:r1` });
      let created;
      try {
        created = await queueVoiceover(ctx, {
          charge, key, userId, voice, text: input.text, chars: input.chars, settings,
          source: 'api', apiKeyId: req.apiKey.id, webhookUrl: webhook,
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'insufficient_credits') {
          throw new ApiError(err.code, err.message, { details: { ...err.details, topupUrl: config.topupUrl } });
        }
        throw err;
      }
      if (idemKey) await apiJobs.bindKey(userId, idemKey, created.id);
      res.status(202).json({ jobId: created.id, credits, status: 'queued' });
    } catch (err) {
      if (idemKey) await apiJobs.releaseKey(userId, idemKey).catch(() => {});
      throw err;
    }
  });

  router.get('/tts/:id', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
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
    res.json(toApiJob(await jobsRepo.own(req.apiUserId, job.id), view));
  });

  router.get('/tts/:id/files/:name', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
    const engineName = Object.hasOwn(API_FILES, req.params.name) ? API_FILES[req.params.name] : null;
    if (!engineName) throw new ApiError('not_found', 'unknown file; use final.mp3, final.wav, subtitles.srt or subtitles.vtt');
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/files/${engineName}`);
  });

  // Cancels queued or running work (refund rules of the web cancel); anything else is deleted.
  router.delete('/tts/:id', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
    const view = await jobControl.engineView(job.id);
    if (view && (view.status === 'queued' || view.status === 'running')) await jobControl.cancel(job);
    else await jobControl.remove(job, view);
    res.status(204).end();
  });

  router.use(() => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  return router;
}
