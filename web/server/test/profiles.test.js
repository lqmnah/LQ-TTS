import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../db/pool.js';
import { createProfiles } from '../services/profiles.js';
import { testDatabaseUrl } from './db-url.js';

const meta = (over = {}) => ({
  slug: 'pandji',
  name: 'Pandji',
  gender: 'male',
  language: 'id',
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }, { id: 'Tegas', en: 'Firm' }],
  bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: 'Pandji', attestedBy: 'lqmnah', scope: 'Public library voice' },
  sort: 100,
  ...over,
});
const uuid = () => crypto.randomUUID();

describe('voice profile store', () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  let profiles;
  beforeAll(async () => {
    pool = createPool(testDatabaseUrl(), schema, { max: 2 });
    await migrate(pool, schema);
    profiles = createProfiles(pool);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('stores a profile with its consent record and stamps the consent time', async () => {
    const id = uuid();
    expect(await profiles.upsert(meta({ slug: 'store' }), id)).toBeNull();
    const row = await profiles.get(id);
    expect(row).toMatchObject({
      voice_id: id, slug: 'store', name: 'Pandji', gender: 'male', language: 'id',
      description_id: 'Pria, bariton hangat.', description_en: 'Male, warm baritone.',
      tags: [{ id: 'Pria', en: 'Male' }, { id: 'Tegas', en: 'Firm' }],
      best_for_id: 'Narasi.', best_for_en: 'Narration.',
      consent_subject: 'Pandji', consent_attested_by: 'lqmnah', consent_scope: 'Public library voice',
      active: true, sort: 100,
    });
    expect(Date.now() - row.consent_granted_at.getTime()).toBeLessThan(60_000);
  });

  it('replaces the voice of an existing slug, reactivates it and returns the previous voice', async () => {
    const first = uuid();
    const second = uuid();
    await profiles.upsert(meta({ slug: 'swap' }), first);
    expect(await profiles.deactivate('swap')).toBe(true);
    expect(await profiles.upsert(meta({ slug: 'swap', name: 'Pandji Baru', sort: 5 }), second)).toBe(first);
    expect(await profiles.get(first)).toBeNull();
    expect(await profiles.get(second)).toMatchObject({ slug: 'swap', name: 'Pandji Baru', sort: 5, active: true });
  });

  it('lists active profiles by sort then name and leaves inactive ones out', async () => {
    await profiles.upsert(meta({ slug: 'order-b', name: 'Bima', sort: 20 }), uuid());
    await profiles.upsert(meta({ slug: 'order-z', name: 'Zara', sort: 10 }), uuid());
    await profiles.upsert(meta({ slug: 'order-a', name: 'Ayu', sort: 20 }), uuid());
    await profiles.upsert(meta({ slug: 'order-off', name: 'Mati', sort: 1 }), uuid());
    await profiles.deactivate('order-off');
    const slugs = (await profiles.list()).map((r) => r.slug).filter((s) => s.startsWith('order-'));
    expect(slugs).toEqual(['order-z', 'order-a', 'order-b']);
  });

  it('deactivates by slug, keeps the row, and reports unknown slugs', async () => {
    const id = uuid();
    await profiles.upsert(meta({ slug: 'retire' }), id);
    expect(await profiles.deactivate('retire')).toBe(true);
    expect(await profiles.get(id)).toBeNull();
    expect(await profiles.bySlug('retire')).toMatchObject({ voice_id: id, active: false });
    expect(await profiles.deactivate('nobody')).toBe(false);
    expect(await profiles.bySlug('nobody')).toBeNull();
  });

  it('refuses rows the spec forbids', async () => {
    const insert = (slug, tags) => pool.query(
      `INSERT INTO voice_profiles (voice_id, slug, name, gender, language, description_id, description_en, tags,
         best_for_id, best_for_en, consent_subject, consent_attested_by, consent_scope, consent_granted_at)
       VALUES ($1, $2, 'X', 'male', 'id', 'd', 'd', $3::jsonb, 'b', 'b', 's', 'a', 'sc', now())`,
      [uuid(), slug, JSON.stringify(tags)],
    );
    await expect(insert('Bad Slug', [{ id: 'a', en: 'a' }])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('no-tags', [])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('object-tags', { id: 'a', en: 'a' })).rejects.toMatchObject({ code: '23514' });
    await insert('dupe', [{ id: 'a', en: 'a' }]);
    await expect(insert('dupe', [{ id: 'a', en: 'a' }])).rejects.toMatchObject({ code: '23505' });
  });
});
