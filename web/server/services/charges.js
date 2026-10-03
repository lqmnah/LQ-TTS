import { UpstreamError } from '../clients/http.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';

export const HELD_MIN_AGE_MS = 2 * 60 * 1000;
export const FLAG_AFTER_ATTEMPTS = 10;

// One rule for callbacks, reconciliation, cancel and delete. view = {status, revision} or null (job gone).
export function decide(charge, view, now = Date.now()) {
  const old = now - new Date(charge.created_at).getTime() >= HELD_MIN_AGE_MS;
  if (charge.job_id === null) return old ? 'refund' : 'wait';
  if (view === null) return 'refund';
  if (charge.revision < view.revision) return 'settle';
  if (charge.revision > view.revision) return old ? 'refund' : 'wait';
  if (view.status === 'done') return 'settle';
  if (view.status === 'failed' || view.status === 'canceled') return 'refund';
  return 'wait';
}

export function createCharges({ pool, lqstudio, sessions, log }) {
  async function insertHeld({ userId, jobId = null, revision, kind, sentenceIdx = null, chars, credits, holdId }) {
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [userId, jobId, revision, kind, sentenceIdx, chars, credits, holdId],
      );
      return row;
    } catch (err) {
      if (err.code === '23505') return null;
      throw err;
    }
  }

  async function finish(charge, state, balance) {
    await pool.query(
      `UPDATE charges SET state = $2, resolved_at = now(), last_error = NULL WHERE id = $1 AND state = 'held'`,
      [charge.id, state],
    );
    if (typeof balance === 'number') await sessions.setBalance(charge.user_id, balance);
    log.info({ event: `charge_${state}`, chargeId: charge.id, holdId: charge.hold_id, credits: charge.credits }, `charge ${state}`);
  }

  async function settle(charge) {
    const out = await lqstudio.settle({ userId: charge.user_id, holdId: charge.hold_id, amount: charge.credits });
    await finish(charge, 'settled', out?.balance);
  }

  async function refund(charge) {
    let out;
    try {
      out = await lqstudio.refund({ userId: charge.user_id, holdId: charge.hold_id });
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        await finish(charge, 'refunded', null); // LQ-Studio holds nothing for this ref: nothing to give back
        return;
      }
      throw err;
    }
    await finish(charge, 'refunded', out?.balance);
  }

  async function recordFailure(charge, err) {
    const { rows: [row] } = await pool.query(
      'UPDATE charges SET attempts = attempts + 1, last_error = $2 WHERE id = $1 RETURNING attempts, flagged_at',
      [charge.id, String(err?.message ?? err).slice(0, 500)],
    );
    log.warn({ event: 'charge_attempt_failed', chargeId: charge.id, holdId: charge.hold_id, attempts: row?.attempts, error: String(err?.message ?? err) }, 'charge resolution failed');
    if (row && row.attempts >= FLAG_AFTER_ATTEMPTS && row.flagged_at === null) {
      await pool.query('UPDATE charges SET flagged_at = now() WHERE id = $1', [charge.id]);
      log.error(
        { event: 'charge_flagged', chargeId: charge.id, holdId: charge.hold_id, userId: charge.user_id, credits: charge.credits, attempts: row.attempts },
        'charge needs manual review',
      );
    }
  }

  async function refundNow(charge) {
    try {
      await refund(charge);
    } catch (err) {
      await recordFailure(charge, err);
    }
  }

  // Releases a hold whose outcome we never learned. "Nothing held" (404) is not final here: the request we gave up on
  // may still reach LQ-Studio and deduct. The charge then stays held without a job, and reconciliation refunds it once
  // it is older than HELD_MIN_AGE_MS, when a 404 is final.
  async function releaseUnknownHold(charge) {
    let out;
    try {
      out = await lqstudio.refund({ userId: charge.user_id, holdId: charge.hold_id });
    } catch (err) {
      if (!(err instanceof UpstreamError && err.code === 'not_found')) await recordFailure(charge, err);
      return;
    }
    await finish(charge, 'refunded', out?.balance);
  }

  async function hold(charge) {
    let out;
    try {
      out = await lqstudio.hold({ userId: charge.user_id, amount: charge.credits, ref: charge.hold_id });
    } catch (err) {
      if (err instanceof UpstreamError && (err.code === 'insufficient_credits' || err.code === 'not_found')) {
        await pool.query(`DELETE FROM charges WHERE id = $1 AND state = 'held'`, [charge.id]);
        if (err.code === 'not_found') {
          await sessions.revokeUser(charge.user_id);
          throw new ApiError('unauthorized', 'account not found');
        }
        throw lqError(err);
      }
      await releaseUnknownHold(charge);
      throw lqError(err);
    }
    if (typeof out?.balance === 'number') await sessions.setBalance(charge.user_id, out.balance);
    return out;
  }

  async function resolveOne(charge, view) {
    const action = decide(charge, view);
    if (action === 'wait') return true;
    try {
      if (action === 'settle') await settle(charge);
      else await refund(charge);
      return true;
    } catch (err) {
      await recordFailure(charge, err);
      return false;
    }
  }

  async function resolveJob(jobId, view, { maxRevision = 2147483647 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE job_id = $1 AND state = 'held' AND revision <= $2 ORDER BY id`, [jobId, maxRevision],
    );
    let ok = true;
    for (const charge of rows) ok = (await resolveOne(charge, view)) && ok;
    return ok;
  }

  return { insertHeld, hold, settle, refund, refundNow, recordFailure, resolveOne, resolveJob };
}
