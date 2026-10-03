import crypto from 'node:crypto';

export const SESSION_DAYS = 30;
const SLIDE_AFTER_MS = 3600 * 1000;

// LQ-Studio's tokenVersion; anything that is not a safe integer counts as 0, its "unset" value.
export const userTv = (user) => (Number.isSafeInteger(user?.tv) ? user.tv : 0);

export const hashSessionId = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export function createSessionStore(pool) {
  return {
    async create(user, balance) {
      const raw = crypto.randomBytes(32).toString('base64url');
      const userId = String(user.id);
      const { rows: [prev] } = await pool.query(
        'SELECT lang FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId],
      );
      const { rows: [session] } = await pool.query(
        `INSERT INTO sessions (id, user_id, name, email, plan, paid, lang, balance, user_tv, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(days => $10)) RETURNING *`,
        [hashSessionId(raw), userId, user.name ?? '', user.email ?? '', user.plan ?? 'free', Boolean(user.paid),
          prev?.lang ?? 'id', balance ?? null, userTv(user), SESSION_DAYS],
      );
      return { raw, session };
    },
    async find(raw) {
      if (!raw) return null;
      const { rows: [row] } = await pool.query(
        'SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', [hashSessionId(raw)],
      );
      return row ?? null;
    },
    // Sliding expiry, written at most once an hour per session.
    async slide(session) {
      const left = new Date(session.expires_at).getTime() - Date.now();
      if (left > SESSION_DAYS * 86400000 - SLIDE_AFTER_MS) return false;
      await pool.query('UPDATE sessions SET expires_at = now() + make_interval(days => $2) WHERE id = $1', [session.id, SESSION_DAYS]);
      return true;
    },
    async revoke(id) {
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    },
    async revokeUser(userId) {
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [String(userId)]);
    },
    // Ends the sessions opened before LQ-Studio's tokenVersion reached tv; sessions opened at or after tv keep working.
    async revokeBeforeTv(userId, tv) {
      await pool.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND user_tv < $2 AND revoked_at IS NULL', [String(userId), tv],
      );
    },
    // Renews only sessions opened at or before the read's tv, so a stale read never renews a newer session's cache.
    async refresh(sessionId, user, tv) {
      const { rows } = await pool.query(
        `UPDATE sessions SET name = $2, email = $3, plan = $4, paid = $5, balance = $6, refreshed_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND user_tv <= $7 RETURNING *`,
        [String(user.id), user.name ?? '', user.email ?? '', user.plan ?? 'free', Boolean(user.paid), user.balance ?? null, tv],
      );
      return rows.find((r) => r.id === sessionId) ?? null;
    },
    // LQ-Studio unreachable: mark the user's live sessions so the next refresh is due in retryMs, not on every request.
    async deferRefresh(sessionId, userId, cacheMs, retryMs) {
      const { rows } = await pool.query(
        `UPDATE sessions SET refreshed_at = now() - make_interval(secs => $2::double precision / 1000)
         WHERE user_id = $1 AND revoked_at IS NULL AND refreshed_at < now() - make_interval(secs => $2::double precision / 1000)
         RETURNING *`,
        [String(userId), cacheMs - retryMs],
      );
      return rows.find((r) => r.id === sessionId) ?? null;
    },
    async setBalance(userId, balance) {
      await pool.query('UPDATE sessions SET balance = $2 WHERE user_id = $1 AND revoked_at IS NULL', [String(userId), balance]);
    },
    async setLang(userId, lang) {
      await pool.query('UPDATE sessions SET lang = $2 WHERE user_id = $1 AND revoked_at IS NULL', [String(userId), lang]);
    },
  };
}
