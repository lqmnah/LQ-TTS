import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';

export const busy = () => new ApiError('not_regeneratable', 'a previous change on this job is still being settled; try again shortly');

/** Per-job lease, cancel and delete, shared by the web routes (routes/job-actions.js) and DELETE /v1/tts/:id. */
export function createJobControl({ pool, engine, charges, jobsRepo, log }) {
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

  // Shares the regenerate lease, so cancel never resolves charges before a regeneration records its revision.
  async function cancel(job) {
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
  }

  // Deleting stops queued/running work without a callback: settle what finished, refund the rest. `view` is the
  // engine's answer read just before (null: the engine no longer has the job).
  async function remove(job, view) {
    if (view) {
      try {
        await engine.deleteJob(job.id);
      } catch (err) {
        if (!isEngineNotFound(err)) throw engineError(err);
      }
    }
    await jobsRepo.markDeleted(job.id);
    let finalView = null;
    if (view) {
      const stopped = view.status === 'queued' || view.status === 'running';
      finalView = { status: stopped ? 'canceled' : view.status, revision: view.revision };
    }
    await charges.resolveJob(job.id, finalView);
  }

  return { withLease, engineView, cancel, remove };
}
