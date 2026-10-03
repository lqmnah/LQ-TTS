import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../clients/http.js';
import { createPool, migrate } from '../db/pool.js';
import { createCharges, decide } from '../services/charges.js';
import { testDatabaseUrl } from './db-url.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const charge = (extra = {}) => ({ job_id: 'j1', revision: 1, created_at: new Date(NOW - 3 * 60000), ...extra });
const young = { created_at: new Date(NOW - 30000) };

describe('decide', () => {
  it.each([
    ['done at the same revision', charge(), { status: 'done', revision: 1 }, 'settle'],
    ['failed', charge(), { status: 'failed', revision: 1 }, 'refund'],
    ['canceled', charge(), { status: 'canceled', revision: 1 }, 'refund'],
    ['still running', charge(), { status: 'running', revision: 1 }, 'wait'],
    ['still queued', charge(), { status: 'queued', revision: 1 }, 'wait'],
    ['a later revision exists, so this one finished', charge(), { status: 'queued', revision: 2 }, 'settle'],
    ['the engine never got this revision', charge({ revision: 3 }), { status: 'done', revision: 2 }, 'refund'],
    ['the engine may still be receiving this revision', charge({ revision: 3, ...young }), { status: 'done', revision: 2 }, 'wait'],
    ['the job is gone from the engine', charge(), null, 'refund'],
    ['create crashed before the job row existed', charge({ job_id: null }), null, 'refund'],
    ['create may still be in flight', charge({ job_id: null, ...young }), null, 'wait'],
  ])('%s', (_, c, view, expected) => {
    expect(decide(c, view, NOW)).toBe(expected);
  });
});

describe('charge claims', () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const jobId = crypto.randomUUID();
  let pool;
  beforeAll(async () => {
    pool = createPool(testDatabaseUrl(), schema, { max: 3 });
    await migrate(pool, schema);
    await pool.query(
      `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status) VALUES ($1, 'ana', $2, 'v', 't', 5, 'done')`,
      [jobId, crypto.randomUUID()],
    );
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  const log = { info() {}, warn() {}, error() {} };
  const make = (lqstudio) => createCharges({ pool, lqstudio, sessions: { setBalance: vi.fn(), revokeUser: vi.fn() }, log });
  const heldRow = async () => (await pool.query(
    `INSERT INTO charges (user_id, job_id, revision, kind, chars, credits, hold_id, created_at)
     VALUES ('ana', $1, 1, 'job', 5, 1, $2, now() - interval '10 minutes') RETURNING *`,
    [jobId, `h-${crypto.randomUUID()}`],
  )).rows[0];
  const row = async (id) => (await pool.query('SELECT * FROM charges WHERE id = $1', [id])).rows[0];
  const done = { status: 'done', revision: 1 };

  it('a refund racing an in-flight settle leaves LQ-Studio alone, so the local row matches what it applied', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const lqstudio = {
      settle: vi.fn(async () => { await gate; return { balance: 99 }; }),
      refund: vi.fn(async () => ({ balance: 99, refunded: 0 })),
    };
    const charges = make(lqstudio);
    const c = await heldRow();
    const p = charges.resolveOne(c, done);
    await vi.waitFor(() => expect(lqstudio.settle).toHaveBeenCalled());
    expect(await charges.resolveOne(c, null)).toBe(true);
    release();
    expect(await p).toBe(true);
    expect(lqstudio.refund).not.toHaveBeenCalled();
    expect(await row(c.id)).toMatchObject({ state: 'settled', resolving_until: null });
  });

  it('refundNow skips a charge another resolver has claimed', async () => {
    const lqstudio = { settle: vi.fn(), refund: vi.fn(async () => ({ balance: 100 })) };
    const charges = make(lqstudio);
    const c = await heldRow();
    await pool.query(`UPDATE charges SET resolving_until = now() + interval '30 seconds' WHERE id = $1`, [c.id]);
    await charges.refundNow(c);
    expect(lqstudio.refund).not.toHaveBeenCalled();
    expect((await row(c.id)).state).toBe('held');
  });

  it('takes over an expired claim', async () => {
    const lqstudio = { settle: vi.fn(async () => ({ balance: 99 })), refund: vi.fn() };
    const charges = make(lqstudio);
    const c = await heldRow();
    await pool.query(`UPDATE charges SET resolving_until = now() - interval '1 second' WHERE id = $1`, [c.id]);
    expect(await charges.resolveOne(c, done)).toBe(true);
    expect(lqstudio.settle).toHaveBeenCalledTimes(1);
    expect(await row(c.id)).toMatchObject({ state: 'settled', resolving_until: null });
  });

  it('decides on the freshly claimed row, not the stale copy', async () => {
    const lqstudio = { settle: vi.fn(async () => ({ balance: 99 })), refund: vi.fn(async () => ({ balance: 100 })) };
    const charges = make(lqstudio);
    const c = await heldRow();
    await pool.query('UPDATE charges SET revision = 2 WHERE id = $1', [c.id]);
    expect(await charges.resolveOne(c, done)).toBe(true);
    expect(lqstudio.settle).not.toHaveBeenCalled();
    expect(lqstudio.refund).toHaveBeenCalledTimes(1);
    expect((await row(c.id)).state).toBe('refunded');
  });

  it('clears the claim after a failed attempt so a retry can resolve it', async () => {
    const lqstudio = { settle: vi.fn(async () => { throw new Error('down'); }), refund: vi.fn() };
    const charges = make(lqstudio);
    const c = await heldRow();
    expect(await charges.resolveOne(c, done)).toBe(false);
    expect(await row(c.id)).toMatchObject({ state: 'held', attempts: 1, resolving_until: null });
    lqstudio.settle.mockResolvedValueOnce({ balance: 99 });
    expect(await charges.resolveOne(c, done)).toBe(true);
    expect((await row(c.id)).state).toBe('settled');
  });

  it('an unclaimed recordFailure counts the attempt but leaves an active claim alone', async () => {
    const charges = make({});
    const c = await heldRow();
    const { rows: [claimed] } = await pool.query(
      `UPDATE charges SET resolving_until = now() + interval '30 seconds' WHERE id = $1 RETURNING resolving_until`, [c.id],
    );
    await charges.recordFailure(c, new Error('engine down'));
    const after = await row(c.id);
    expect(after.attempts).toBe(1);
    expect(after.resolving_until).toEqual(claimed.resolving_until);
  });

  it('a hold LQ-Studio does not know stays held and unclaimed, so reconciliation can take it', async () => {
    const lqstudio = {
      hold: vi.fn(async () => { throw new Error('timeout'); }),
      refund: vi.fn(async () => { throw new UpstreamError('lqstudio', 404, 'not_found', 'no hold'); }),
    };
    const charges = make(lqstudio);
    const c = await heldRow();
    await expect(charges.hold(c)).rejects.toThrow();
    expect(lqstudio.refund).toHaveBeenCalledTimes(1);
    expect(await row(c.id)).toMatchObject({ state: 'held', resolving_until: null });
  });
});
