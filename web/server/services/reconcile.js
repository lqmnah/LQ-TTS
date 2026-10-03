import { isEngineNotFound } from '../lib/upstream-errors.js';

// Resolves held charges the callback path left behind. Rows with job_id NULL are holds whose create never wrote a
// job row (or whose outcome was unknown); decide() refunds them once they are old enough.
export function createReconciler({ pool, engine, charges, jobsRepo, log }, { intervalMs = 60000 } = {}) {
  async function pass() {
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE state = 'held' AND created_at < now() - interval '2 minutes' ORDER BY id LIMIT 500`,
    );
    const views = new Map();
    for (const charge of rows) {
      let view = null;
      if (charge.job_id !== null) {
        if (views.has(charge.job_id)) {
          view = views.get(charge.job_id);
        } else {
          try {
            const v = await engine.getJob(charge.job_id);
            view = { status: v.status, revision: v.revision };
            await jobsRepo.applyEngineState(charge.job_id, {
              ...view, audioSeconds: v.audio_seconds, finishedAt: v.finished_at,
            });
          } catch (err) {
            if (!isEngineNotFound(err)) {
              await charges.recordFailure(charge, err); // unclaimed: never touches another resolver's claim
              continue;
            }
            view = null; // the engine no longer has the job
          }
          views.set(charge.job_id, view);
        }
      }
      await charges.resolveOne(charge, view);
    }
    if (rows.length) log.info({ event: 'reconcile_pass', checked: rows.length }, 'reconciliation pass');
    return { checked: rows.length };
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
      safeRun();
      timer = setInterval(safeRun, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
