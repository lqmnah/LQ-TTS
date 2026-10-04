import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret, parseApiKey } from '../services/api-keys.js';
import { USERS, startHarness } from './helpers.js';

describe('API keys (browser routes)', () => {
  let h;
  let ana;
  let budi;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    budi = h.as(await h.login(USERS.budi));
  });
  afterAll(async () => {
    await h.close();
  });
  const rows = async (userId) => (await h.pool.query('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  const revokeAll = (userId) => h.pool.query(`UPDATE api_keys SET revoked_at = now(), revoked_reason = 'user' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);

  it('refuses a key to a free plan', async () => {
    const res = await ana.post('/api/keys', { name: 'Zapier' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_required');
    expect(await rows('ana')).toEqual([]);
  });

  it('creates a key shown once, stores only its hash and the sealed webhook secret, and logs no secret', async () => {
    const res = await budi.post('/api/keys', { name: '  Zapier  ' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      id: expect.any(String), name: 'Zapier', prefix: expect.stringMatching(/^lqtts_[a-z2-7]{12}_…$/),
      createdAt: expect.any(String), lastUsedAt: null,
      key: expect.stringMatching(/^lqtts_[a-z2-7]{12}_[a-z2-7]{52}$/), webhookSecret: expect.stringMatching(/^whsec_[a-z2-7]{52}$/),
    });
    const { keyId, secret } = parseApiKey(res.body.key);
    expect(res.body.prefix).toBe(`lqtts_${keyId}_…`);
    const [row] = await rows('budi');
    expect(row).toMatchObject({ id: res.body.id, key_id: keyId, secret_hash: hashSecret(secret), tv: 0, revoked_at: null });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.webhook_secret_enc).not.toContain(res.body.webhookSecret.slice(6));
    expect(h.ctx.apiKeys.webhookSecret(row)).toBe(res.body.webhookSecret);
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    expect(JSON.stringify(h.logs)).not.toContain(res.body.webhookSecret);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_created', userId: 'budi', keyId }));
    const list = await budi.get('/api/keys');
    expect(list.body).toEqual({ keys: [{ id: res.body.id, name: 'Zapier', prefix: res.body.prefix, createdAt: res.body.createdAt, lastUsedAt: null }], deliveries: [] });
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it('finds a key only by its exact secret', async () => {
    const { key } = await h.ctx.apiKeys.create('budi', { name: 'find', tv: 0 });
    expect((await h.ctx.apiKeys.find(key)).name).toBe('find');
    const tampered = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    for (const raw of [tampered, key.toUpperCase(), `${key}x`, 'lqtts_short_x', '', null]) {
      expect(await h.ctx.apiKeys.find(raw)).toBeNull();
    }
  });

  it.each([[''], ['   '], ['x'.repeat(61)], [7]])('refuses the name %j', async (name) => {
    const res = await budi.post('/api/keys', { name });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('keeps at most five active keys and frees a slot on revoke', async () => {
    await revokeAll('budi');
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push((await budi.post('/api/keys', { name: `k${i}` })).body);
    const sixth = await budi.post('/api/keys', { name: 'k5' });
    expect(sixth.status).toBe(403);
    expect(sixth.body.error.code).toBe('key_limit_reached');
    expect((await budi.del(`/api/keys/${made[0].id}`)).status).toBe(204);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_revoked', userId: 'budi' }));
    expect((await budi.post('/api/keys', { name: 'k5' })).status).toBe(201);
    expect((await budi.get('/api/keys')).body.keys).toHaveLength(5);
  });

  it('holds the limit when creates race', async () => {
    await revokeAll('budi');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => budi.post('/api/keys', { name: `race${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
  });

  it("revokes only the caller's own live key", async () => {
    const [key] = (await budi.get('/api/keys')).body.keys;
    expect((await ana.del(`/api/keys/${key.id}`)).status).toBe(404);
    expect((await budi.del('/api/keys/not-a-uuid')).status).toBe(404);
    expect((await budi.del(`/api/keys/${key.id}`)).status).toBe(204);
    expect((await budi.del(`/api/keys/${key.id}`)).status).toBe(404);
    const { rows: [row] } = await h.pool.query('SELECT revoked_reason FROM api_keys WHERE id = $1', [key.id]);
    expect(row.revoked_reason).toBe('user');
  });

  it('auto-revokes by reason, optionally only keys older than a tokenVersion', async () => {
    await revokeAll('budi');
    const old = await h.ctx.apiKeys.create('budi', { name: 'old', tv: 0 });
    const fresh = await h.ctx.apiKeys.create('budi', { name: 'fresh', tv: 2 });
    expect(await h.ctx.apiKeys.autoRevoke('budi', 'tv', { belowTv: 2 })).toBe(1);
    expect(await h.ctx.apiKeys.find(old.key)).toBeNull();
    expect(await h.ctx.apiKeys.find(fresh.key)).not.toBeNull();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'budi', reason: 'tv', keyId: old.row.key_id }));
    expect(await h.ctx.apiKeys.autoRevoke('budi', 'plan')).toBe(1);
    expect(await h.ctx.apiKeys.find(fresh.key)).toBeNull();
  });

  it('needs the session cookie and the CSRF header', async () => {
    expect((await request(h.app).get('/api/keys')).status).toBe(401);
    const cookie = await h.login(USERS.budi);
    const noCsrf = await request(h.app).post('/api/keys').set('cookie', cookie).send({ name: 'x' });
    expect(noCsrf.status).toBe(403);
  });
});
