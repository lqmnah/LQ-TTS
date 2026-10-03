import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../db/pool.js';
import { testDatabaseUrl } from './db-url.js';

describe('migrate', () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  beforeAll(() => {
    pool = createPool(testDatabaseUrl(), schema, { max: 3 });
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('applies each migration once, even when run concurrently and repeatedly', async () => {
    await Promise.all([migrate(pool, schema), migrate(pool, schema)]);
    await migrate(pool, schema);
    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql']);
  });

  it('never stores two charges with the same hold id', async () => {
    const insert = () => pool.query(
      `INSERT INTO charges (user_id, revision, kind, chars, credits, hold_id) VALUES ('u1', 1, 'job', 10, 1, 'tts:k:r1')`,
    );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });
});
