import crypto from 'node:crypto';
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../services/ownership.js';

const MAX_SKEW_S = 300;
const TERMINAL = new Set(['done', 'failed', 'canceled']);

// Same scheme as engine/lq_tts_engine/callbacks.py: "sha256=" + HMAC-SHA256(secret, "<ts>." + raw body).
export function verifySignature(secret, timestamp, body, signature, nowS = Math.floor(Date.now() / 1000)) {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`);
  const given = Buffer.from(String(signature));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function callbackRouter(ctx) {
  const { config, engine, jobsRepo, charges, log } = ctx;
  const router = express.Router();
  router.post('/internal/engine-callback', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const timestamp = req.get('x-lq-timestamp') ?? '';
    const signature = req.get('x-lq-signature') ?? '';
    if (!verifySignature(config.engineCallbackSecret, timestamp, body, signature)) {
      log.warn({ event: 'callback_rejected' }, 'engine callback with a bad or expired signature');
      throw new ApiError('unauthorized', 'bad signature');
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ApiError('invalid_request', 'body must be JSON');
    }
    const { job_id: jobId, status, revision } = payload ?? {};
    if (!isUuid(jobId) || !TERMINAL.has(status) || !Number.isInteger(revision) || revision < 1) {
      throw new ApiError('invalid_request', 'job_id, a terminal status and revision are required');
    }
    const job = await jobsRepo.get(jobId);
    if (!job) {
      log.warn({ event: 'callback_unknown_job', jobId }, 'callback for a job this web app does not know');
      res.json({ ok: true });
      return;
    }
    let audioSeconds = null;
    try {
      const view = await engine.getJob(jobId);
      if (view.revision === revision) audioSeconds = view.audio_seconds;
    } catch {
      // the payload alone is enough to settle or refund
    }
    await jobsRepo.applyEngineState(jobId, { status, revision, audioSeconds });
    const ok = await charges.resolveJob(jobId, { status, revision }, { maxRevision: revision });
    res.status(ok ? 200 : 503).json({ ok });
  });
  return router;
}
