import { randomUUID } from 'node:crypto';
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { countChars, creditsFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { ownJob, parseIdx } from '../services/ownership.js';

export function jobActionsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo, pool, log } = ctx;
  const router = express.Router();

  const busy = () => new ApiError('not_regeneratable', 'a previous change on this job is still being settled; try again shortly');

  // One regenerate or cancel per job at a time, as a lease row rather than a lock, so nothing pins a pooled
  // connection. The lease expires, so a crashed request cannot block the job for good.
  async function withLease(jobId, work) {
    const token = randomUUID();
    const { rowCount } = await pool.query(
      `UPDATE jobs SET regen_lease = $2, regen_until = now() + interval '60 seconds'
       WHERE id = $1 AND (regen_until IS NULL OR regen_until < now()) RETURNING id`,
      [jobId, token],
    );
    if (rowCount === 0) throw busy();
    try {
      return await work();
    } finally {
      // Matching the token: a request whose lease expired never clears its successor's.
      await pool.query('UPDATE jobs SET regen_lease = NULL, regen_until = NULL WHERE id = $1 AND regen_lease = $2', [jobId, token])
        .catch((err) => log.warn({ event: 'regen_lease_release_failed', jobId, err: err.message }, 'could not release regenerate lease'));
    }
  }

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
    // Serialized per job from the guard until the charge carries the engine's revision: two sentences passing the
    // guard together would leave the engine-rejected one held at the accepted one's revision.
    await withLease(job.id, async () => {
      // Job-wide: decide() ignores sentence_idx, so a held charge for any sentence at a newer revision would be
      // judged by this regeneration's outcome.
      const { rowCount: held } = await pool.query(
        `SELECT 1 FROM charges WHERE job_id = $1 AND state = 'held' AND revision > $2 LIMIT 1`,
        [job.id, view.revision],
      );
      if (held > 0) throw busy();
      // Retries count up from the highest earlier attempt (the bare ref is attempt 1); rows can be deleted.
      const { rows: [prior] } = await pool.query(
        `SELECT max(CASE WHEN hold_id = $1 THEN 1 ELSE substring(hold_id FROM ':a([0-9]+)$')::int END) AS n
         FROM charges WHERE hold_id = $1 OR hold_id LIKE $2`,
        [base, `${base}:a%`],
      );
      const holdId = prior.n === null ? base : `${base}:a${prior.n + 1}`;
      const charge = await charges.insertHeld({ userId, jobId: job.id, revision, kind: 'regenerate', sentenceIdx: idx, chars, credits, holdId });
      if (!charge) throw busy();
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
    });
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    // Shares the regenerate lease, so cancel never resolves charges before a regeneration records its revision.
    await withLease(job.id, async () => {
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
    });
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
