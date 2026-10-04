import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../db/pool.js';
import { testDatabaseUrl } from './db-url.js';

const UNSAFE = 'x"; DROP SCHEMA public; --';

describe('createPool', () => {
  it('survives an idle client error instead of crashing the process', async () => {
    const pool = createPool(testDatabaseUrl(), `t_${crypto.randomBytes(6).toString('hex')}`);
    try {
      expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('rejects unsafe schema names', () => {
    expect(() => createPool(testDatabaseUrl(), UNSAFE)).toThrow(/unsafe schema/);
  });
});

describe('migrate', () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  beforeAll(async () => {
    pool = createPool(testDatabaseUrl(), schema, { max: 3 });
    await Promise.all([migrate(pool, schema), migrate(pool, schema)]);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('applies each migration once, even when run concurrently and repeatedly', async () => {
    await migrate(pool, schema);
    const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual([
      '001_init.sql', '002_regen_lease.sql', '003_upload_leases.sql', '004_charge_claims.sql', '005_session_tv.sql', '006_voice_profiles.sql',
      '007_public_api.sql',
    ]);
  });

  it('rejects unsafe schema names', async () => {
    await expect(migrate(pool, UNSAFE)).rejects.toThrow(/unsafe schema/);
  });

  it('never stores two charges with the same hold id', async () => {
    const insert = () => pool.query(
      `INSERT INTO charges (user_id, revision, kind, chars, credits, hold_id) VALUES ('u1', 1, 'job', 10, 1, 'tts:k:r1')`,
    );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('labels existing rows web and keeps profiles off the API by default', async () => {
    await pool.query(`INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status) VALUES (gen_random_uuid(), 'u1', gen_random_uuid(), 'v', 't', 1, 'queued')`);
    const { rows: [job] } = await pool.query('SELECT source, api_key_id, webhook_url FROM jobs LIMIT 1');
    expect(job).toEqual({ source: 'web', api_key_id: null, webhook_url: null });
    const { rows: [charge] } = await pool.query(`SELECT source FROM charges WHERE hold_id = 'tts:k:r1'`);
    expect(charge.source).toBe('web');
    await expect(pool.query(`INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status, source) VALUES (gen_random_uuid(), 'u1', gen_random_uuid(), 'v', 't', 1, 'queued', 'cli')`))
      .rejects.toMatchObject({ code: '23514' });
    const { rows: [column] } = await pool.query(
      `SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'voice_profiles' AND column_name = 'api_allowed'`, [schema],
    );
    expect(column.column_default).toBe('false');
  });
});
