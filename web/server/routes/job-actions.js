import express from 'express';
import { ApiError } from '../lib/errors.js';
import { countChars, creditsFor } from '../lib/pricing.js';
import { engineError } from '../lib/upstream-errors.js';
import { busy } from '../services/job-control.js';
import { ownJob, parseIdx } from '../services/ownership.js';

export function jobActionsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo, pool, jobControl } = ctx;
  const { withLease, engineView } = jobControl;
  const router = express.Router();

  router.post('/jobs/:id/sentences/:idx/regenerate', async (req, res) => {
    const userId = req.session.user_id;
    const job = await ownJob(ctx, userId, req.params.id);
    const idx = parseIdx(req.params.idx);
    const { text, style } = req.body ?? {};
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || countChars(text.trim()) > config.maxSentenceChars)) {
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
    const accepted = await withLease(job.id, async () => {
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
      return { revision: out.revision, credits };
    });
    // Answered after withLease's finally cleared the lease, so a cancel sent right after this 202 is not busy.
    res.status(202).json(accepted);
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    await jobControl.cancel(job);
    res.status(202).json({ status: 'cancel_requested' });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    await jobControl.remove(job, await engineView(job.id));
    res.status(204).end();
  });

  return router;
}
