import { ApiError } from '../lib/errors.js';

export const MAX_ACTIVE_API_JOBS = 2;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,100}$/;

/** Public file name → engine file name (the engine calls the subtitles subs.*). */
export const API_FILES = Object.freeze({
  'final.mp3': 'final.mp3', 'final.wav': 'final.wav', 'subtitles.srt': 'subs.srt', 'subtitles.vtt': 'subs.vtt',
});
const BY_ENGINE_NAME = Object.freeze({
  'final.mp3': ['mp3', 'final.mp3'], 'final.wav': ['wav', 'final.wav'], 'subs.srt': ['srt', 'subtitles.srt'], 'subs.vtt': ['vtt', 'subtitles.vtt'],
});

/** {mp3, wav, srt, vtt} download paths for the engine files that exist (newest revision); null while there are none. */
export function apiFiles(jobId, engineFiles) {
  const out = {};
  for (const name of Object.keys(engineFiles ?? {})) {
    const known = BY_ENGINE_NAME[name];
    if (known) out[known[0]] = `/v1/tts/${jobId}/files/${known[1]}`;
  }
  return Object.keys(out).length ? out : null;
}

export function toApiJob(row, view) {
  const files = apiFiles(row.id, view?.files);
  return {
    jobId: row.id,
    status: row.status,
    progress: view?.progress ?? null,
    credits: row.credits,
    errorCode: view?.error_code ?? null,
    ...(files ? { files } : {}),
    createdAt: row.created_at,
  };
}

export function readIdempotencyKey(raw) {
  if (raw === undefined) return null;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new ApiError('invalid_request', 'Idempotency-Key must be 1 to 100 visible ASCII characters');
  return raw;
}

export function createApiJobs(pool) {
  return {
    /**
     * Inserts the held charge of a new API job unless the account already has MAX_ACTIVE_API_JOBS queued or running.
     * Creates still waiting for the engine (held API charges without a job, under 2 minutes old) count too.
     * Serialized per account by a transaction-scoped lock, so racing creates cannot both pass.
     */
    async reserve(charges, charge) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lqtts_api_jobs:${charge.userId}`]);
        const { rows: [{ n }] } = await client.query(
          `SELECT (SELECT count(*) FROM jobs WHERE user_id = $1 AND source = 'api' AND deleted_at IS NULL AND status IN ('queued', 'running'))
                + (SELECT count(*) FROM charges WHERE user_id = $1 AND source = 'api' AND kind = 'job' AND job_id IS NULL
                     AND state = 'held' AND created_at > now() - interval '2 minutes') AS n`,
          [charge.userId],
        );
        if (Number(n) >= MAX_ACTIVE_API_JOBS) {
          throw new ApiError('too_many_jobs', `at most ${MAX_ACTIVE_API_JOBS} API voiceovers can be queued or running at once`);
        }
        const row = await charges.insertHeld({ ...charge, source: 'api' }, client);
        await client.query('COMMIT');
        return row;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // True when this request owns the key: new, older than 24 h, or a claim abandoned without a job for 2 minutes.
    async claimKey(userId, key) {
      const { rowCount } = await pool.query(
        `INSERT INTO api_idempotency (user_id, idem_key) VALUES ($1, $2)
         ON CONFLICT (user_id, idem_key) DO UPDATE SET job_id = NULL, created_at = now()
         WHERE api_idempotency.created_at < now() - interval '24 hours'
            OR (api_idempotency.job_id IS NULL AND api_idempotency.created_at < now() - interval '2 minutes')`,
        [userId, key],
      );
      return rowCount > 0;
    },
    async keyJob(userId, key) {
      const { rows: [row] } = await pool.query('SELECT job_id FROM api_idempotency WHERE user_id = $1 AND idem_key = $2', [userId, key]);
      return row?.job_id ?? null;
    },
    async bindKey(userId, key, jobId) {
      await pool.query('UPDATE api_idempotency SET job_id = $3 WHERE user_id = $1 AND idem_key = $2', [userId, key, jobId]);
    },
    async releaseKey(userId, key) {
      await pool.query('DELETE FROM api_idempotency WHERE user_id = $1 AND idem_key = $2 AND job_id IS NULL', [userId, key]);
    },
  };
}
