import express from 'express';
import { ApiError } from '../lib/errors.js';
import { countChars, creditsFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { ownJob, parseIdx } from '../services/ownership.js';

export function jobActionsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo, pool } = ctx;
  const router = express.Router();

  async function engineView(jobId) {
    try {
      return await engine.getJob(jobId);
    } catch (err) {
      if (isEngineNotFound(err)) return null;
      throw engineError(err);
    }
  }

  router.post('/jobs/:id/sentences/:idx/regenerate', async (req, res) => {
    const userId = req.session.user_id;
    const job = await ownJob(ctx, userId, req.params.id);
    const idx = parseIdx(req.params.idx);
    const { text, style } = req.body ?? {};
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || countChars(text.trim()) > config.maxTextChars)) {
      throw new ApiError('invalid_request', 'text must be one non-empty sentence');
    }
    if (style !== undefined && (typeof style !== 'string' || style.length > 200)) {
      throw new ApiError('invalid_request', 'style must be a string of at most 200 characters');
    }
    await accounts.fresh(req.session);
    const view = await engineView(job.id);
    if (!view) throw new ApiError('not_found', 'job not found');
    if (view.status !== 'done') throw new ApiError('not_regeneratable', `job is ${view.status}; only finished jobs can be regenerated`);
    let sentences;
    try {
      sentences = await engine.sentences(job.id);
    } catch (err) {
      throw engineError(err);
    }
    const sentence = sentences.find((s) => s.idx === idx);
    if (!sentence) throw new ApiError('not_found', 'sentence not found');

    const newText = text?.trim();
    const chars = countChars(newText ?? sentence.text);
    const credits = creditsFor(chars);
    const revision = view.revision + 1;
    const base = `tts:${job.id}:r${revision}:s${idx}`;
    const busy = new ApiError('not_regeneratable', 'a previous change on this job is still being settled; try again shortly');
    // One regeneration per job at a time, from the guard until the charge carries the engine's revision: two
    // sentences passing the guard together would leave the engine-rejected one held at the accepted one's revision.
    // A try-lock answers 409 at once, so concurrent requests never pin pooled connections waiting for each other.
    const lock = await pool.connect();
    let locked = false;
    try {
      ({ rows: [{ locked }] } = await lock.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`regen:${job.id}`],
      ));
      if (!locked) throw busy;
      // Job-wide: decide() ignores sentence_idx, so a held charge for any sentence at a newer revision would be
      // judged by this regeneration's outcome.
      const { rowCount: held } = await pool.query(
        `SELECT 1 FROM charges WHERE job_id = $1 AND state = 'held' AND revision > $2 LIMIT 1`,
        [job.id, view.revision],
      );
      if (held > 0) throw busy;
      // Retries count up from the highest earlier attempt (the bare ref is attempt 1); rows can be deleted.
      const { rows: [prior] } = await pool.query(
        `SELECT max(CASE WHEN hold_id = $1 THEN 1 ELSE substring(hold_id FROM ':a([0-9]+)$')::int END) AS n
         FROM charges WHERE hold_id = $1 OR hold_id LIKE $2`,
        [base, `${base}:a%`],
      );
      const holdId = prior.n === null ? base : `${base}:a${prior.n + 1}`;
      const charge = await charges.insertHeld({ userId, jobId: job.id, revision, kind: 'regenerate', sentenceIdx: idx, chars, credits, holdId });
      if (!charge) throw busy;
      await charges.hold(charge);
      let out;
      try {
        out = await engine.regenerate(job.id, idx, { text: newText, style });
      } catch (err) {
        await charges.refundNow(charge);
        throw engineError(err);
      }
      if (out.revision !== revision) {
        // decide() must judge the revision that actually does the work.
        await pool.query(`UPDATE charges SET revision = $2 WHERE id = $1 AND state = 'held'`, [charge.id, out.revision]);
      }
      await jobsRepo.applyEngineState(job.id, { status: 'queued', revision: out.revision });
      res.status(202).json({ revision: out.revision, credits });
    } finally {
      let lost = null;
      if (locked) {
        await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`regen:${job.id}`]).catch((err) => { lost = err; });
      }
      lock.release(lost ?? undefined);
    }
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    try {
      await engine.cancel(job.id);
    } catch (err) {
      throw engineError(err);
    }
    // A queued job is canceled on the spot and the engine sends no callback for it.
    const view = await engineView(job.id).catch(() => null);
    if (view && ['done', 'failed', 'canceled'].includes(view.status)) {
      await jobsRepo.applyEngineState(job.id, { status: view.status, revision: view.revision, finishedAt: view.finished_at });
      await charges.resolveJob(job.id, { status: view.status, revision: view.revision });
    }
    res.status(202).json({ status: 'cancel_requested' });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    const view = await engineView(job.id);
    if (view) {
      try {
        await engine.deleteJob(job.id);
      } catch (err) {
        if (!isEngineNotFound(err)) throw engineError(err);
      }
    }
    await jobsRepo.markDeleted(job.id);
    // Deleting stops queued/running work without a callback: settle what finished, refund the rest.
    let finalView = null;
    if (view) {
      const stopped = view.status === 'queued' || view.status === 'running';
      finalView = { status: stopped ? 'canceled' : view.status, revision: view.revision };
    }
    await charges.resolveJob(job.id, finalView);
    res.status(204).end();
  });

  return router;
}
