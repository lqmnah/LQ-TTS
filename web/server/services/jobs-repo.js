const WITH_CREDITS = `j.*, coalesce((SELECT sum(c.credits) FROM charges c WHERE c.job_id = j.id AND c.state <> 'refunded'), 0)::int AS credits`;

export const toSummary = (r) => ({
  id: r.id, title: r.title, voiceId: r.voice_id, voiceName: r.voice_name, status: r.status, chars: r.chars,
  credits: r.credits, audioSeconds: r.audio_seconds, revision: r.revision, createdAt: r.created_at, finishedAt: r.finished_at,
  source: r.source,
});

export function createJobsRepo(pool) {
  return {
    async insertWithCharge({ id, userId, voiceId, voiceName, title, chars, chargeId, source = 'web', apiKeyId = null, webhookUrl = null }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status, revision, source, api_key_id, webhook_url)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', 1, $7, $8, $9)`,
          [id, userId, voiceId, voiceName, title, chars, source, apiKeyId, webhookUrl],
        );
        await client.query('UPDATE charges SET job_id = $1 WHERE id = $2', [id, chargeId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async own(userId, id) {
      const { rows: [row] } = await pool.query(
        `SELECT ${WITH_CREDITS} FROM jobs j WHERE j.id = $1 AND j.user_id = $2 AND j.deleted_at IS NULL`, [id, userId],
      );
      return row ?? null;
    },
    async get(id) {
      const { rows: [row] } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      return row ?? null;
    },
    // Deleting an engine voice deletes every engine job made with it: a voice that live jobs use must stay.
    async usesVoice(voiceId) {
      const { rows: [row] } = await pool.query(
        'SELECT EXISTS (SELECT 1 FROM jobs WHERE voice_id = $1 AND deleted_at IS NULL) AS used', [voiceId],
      );
      return row.used;
    },
    // Newest first, ties broken by id. `cursor` (created_at to the microsecond, UTC, plus id) resumes after a row;
    // `before` is that cursor parsed as {createdAt, id}.
    async list(userId, { limit, before }) {
      const { rows } = await pool.query(
        `SELECT ${WITH_CREDITS},
           to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || j.id AS cursor
         FROM jobs j
         WHERE j.user_id = $1 AND j.deleted_at IS NULL
           AND ($2::timestamptz IS NULL OR (j.created_at, j.id) < ($2::timestamptz, $3::uuid))
         ORDER BY j.created_at DESC, j.id DESC LIMIT $4`,
        [userId, before?.createdAt ?? null, before?.id ?? null, limit],
      );
      return rows;
    },
    // Engine state wins unless it is older than what we already know (late callbacks).
    async applyEngineState(id, { status, revision, audioSeconds = null, finishedAt = null }) {
      await pool.query(
        `UPDATE jobs SET status = $2::text, revision = $3, audio_seconds = coalesce($4, audio_seconds),
           finished_at = CASE WHEN $2::text IN ('done', 'failed', 'canceled') THEN coalesce($5::timestamptz, finished_at, now()) ELSE NULL END
         WHERE id = $1 AND revision <= $3`,
        [id, status, revision, audioSeconds, finishedAt],
      );
    },
    async markDeleted(id) {
      await pool.query('UPDATE jobs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    },
    async markVoiceDeleted(userId, voiceId) {
      const { rows } = await pool.query(
        'UPDATE jobs SET deleted_at = now() WHERE user_id = $1 AND voice_id = $2 AND deleted_at IS NULL RETURNING id', [userId, voiceId],
      );
      return rows.map((r) => r.id);
    },
  };
}
