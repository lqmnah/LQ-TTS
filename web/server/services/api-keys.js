import crypto from 'node:crypto';
import { base32, open, seal } from '../lib/crypto-box.js';
import { ApiError } from '../lib/errors.js';

export const KEY_PREFIX = 'lqtts_';
export const MAX_ACTIVE_KEYS = 5;
export const TOUCH_EVERY_MS = 60 * 1000;
const KEY_PATTERN = /^lqtts_([a-z2-7]{12})_([a-z2-7]{52})$/;

export const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
export const keyPrefix = (keyId) => `${KEY_PREFIX}${keyId}_…`;
export const toApiKey = (r) => ({ id: r.id, name: r.name, prefix: keyPrefix(r.key_id), createdAt: r.created_at, lastUsedAt: r.last_used_at });

/** Splits `lqtts_<key_id>_<secret>`; null for anything else. */
export function parseApiKey(raw) {
  const match = KEY_PATTERN.exec(typeof raw === 'string' ? raw : '');
  return match ? { keyId: match[1], secret: match[2] } : null;
}

const aadFor = (id) => `api_key:${id}`;

export function createApiKeys({ pool, config, log }) {
  return {
    // The full key and the webhook secret exist only in this answer; the table keeps a hash and a sealed copy.
    async create(userId, { name, tv }) {
      const id = crypto.randomUUID();
      const keyId = base32(crypto.randomBytes(8)).slice(0, 12);
      const secret = base32(crypto.randomBytes(32));
      const webhookSecret = `whsec_${base32(crypto.randomBytes(32))}`;
      const client = await pool.connect();
      let row;
      try {
        await client.query('BEGIN');
        // Serializes creates per account so two at once cannot both pass the limit.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lqtts_api_keys:${userId}`]);
        const { rows: [{ n }] } = await client.query(
          'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [userId],
        );
        if (n >= MAX_ACTIVE_KEYS) throw new ApiError('key_limit_reached', `at most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`);
        ({ rows: [row] } = await client.query(
          `INSERT INTO api_keys (id, user_id, name, key_id, secret_hash, webhook_secret_enc, tv)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [id, userId, name, keyId, hashSecret(secret), seal(config.apiEncKey, webhookSecret, aadFor(id)), tv],
        ));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      log.info({ event: 'api_key_created', userId, keyId }, 'API key created');
      return { row, key: `${KEY_PREFIX}${keyId}_${secret}`, webhookSecret };
    },

    async list(userId) {
      const { rows } = await pool.query(
        'SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id', [userId],
      );
      return rows;
    },

    async revoke(userId, id) {
      const { rows: [row] } = await pool.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_reason = 'user'
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING key_id`,
        [id, userId],
      );
      if (!row) return false;
      log.info({ event: 'api_key_revoked', userId, keyId: row.key_id }, 'API key revoked');
      return true;
    },

    // Revokes every live key of the account; with belowTv only the keys made before that tokenVersion.
    async autoRevoke(userId, reason, { belowTv = null } = {}) {
      const { rows } = await pool.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_reason = $2
         WHERE user_id = $1 AND revoked_at IS NULL AND ($3::int IS NULL OR tv < $3::int) RETURNING key_id`,
        [userId, reason, belowTv],
      );
      for (const { key_id: keyId } of rows) {
        log.warn({ event: 'api_key_auto_revoked', userId, keyId, reason }, 'API key revoked automatically');
      }
      return rows.length;
    },

    // Looked up by the public key id, then the secret's hash is compared in constant time.
    async find(raw) {
      const parsed = parseApiKey(raw);
      if (!parsed) return null;
      const { rows: [row] } = await pool.query('SELECT * FROM api_keys WHERE key_id = $1 AND revoked_at IS NULL', [parsed.keyId]);
      if (!row) return null;
      const given = Buffer.from(hashSecret(parsed.secret), 'hex');
      const stored = Buffer.from(row.secret_hash, 'hex');
      return given.length === stored.length && crypto.timingSafeEqual(given, stored) ? row : null;
    },

    // last_used_at moves at most once a minute per key.
    async touch(row) {
      if (row.last_used_at && Date.now() - new Date(row.last_used_at).getTime() < TOUCH_EVERY_MS) return;
      await pool.query(
        `UPDATE api_keys SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [row.id],
      );
    },

    webhookSecret(row) {
      return open(config.apiEncKey, row.webhook_secret_enc, aadFor(row.id));
    },
  };
}
