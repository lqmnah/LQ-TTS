import { isEngineNotFound } from '../lib/upstream-errors.js';
import { HELD_MIN_AGE_MS } from './charges.js';

// Resolves held charges the callback path left behind. Rows with job_id NULL are holds whose create never wrote a
// job row (or whose outcome was unknown); decide() refunds them once they are old enough.
export function createReconciler({ pool, engine, charges, jobsRepo, log }, { intervalMs = 60000, batchSize = 500 } = {}) {
  let stopped = false;

  // What the engine said about a job in this pass: {view} (null view = job gone) or {error}.
  async function lookup(jobId) {
    try {
      const v = await engine.getJob(jobId);
      const view = { status: v.status, revision: v.revision };
      await jobsRepo.applyEngineState(jobId, { ...view, audioSeconds: v.audio_seconds, finishedAt: v.finished_at });
      return { view };
    } catch (err) {
      if (!isEngineNotFound(err)) return { error: err };
      await jobsRepo.markDeleted(jobId); // the engine no longer has the job, as GET /api/jobs/:id records it
      return { view: null };
    }
  }

  async function pass() {
    // Rows that keep failing go last, so they cannot starve newer charges out of the batch.
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE state = 'held' AND created_at < now() - make_interval(secs => $2::double precision / 1000)
       ORDER BY (flagged_at IS NOT NULL), attempts, id LIMIT $1`,
      [batchSize, HELD_MIN_AGE_MS],
    );
    const seen = new Map();
    let checked = 0;
    for (const charge of rows) {
      if (stopped) break;
      checked += 1;
      let view = null;
      if (charge.job_id !== null) {
        if (!seen.has(charge.job_id)) seen.set(charge.job_id, await lookup(charge.job_id));
        const out = seen.get(charge.job_id);
        if (out.error) {
          await charges.recordFailure(charge, out.error); // unclaimed: never touches another resolver's claim
          continue;
        }
        view = out.view;
      }
      await charges.resolveOne(charge, view);
    }
    if (checked) log.info({ event: 'reconcile_pass', checked }, 'reconciliation pass');
    return { checked };
  }

  let running = null;
  let timer = null;
  const runOnce = () => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };
  const safeRun = () =>
    runOnce().catch((err) =>
      log.error({ event: 'reconcile_failed', error: String(err?.stack ?? err) }, 'reconciliation pass failed'));

  return {
    runOnce,
    start() {
      stopped = false;
      safeRun();
      timer = setInterval(safeRun, intervalMs);
      timer.unref();
    },
    // Ends the loop between charges; a charge already being resolved finishes first.
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
