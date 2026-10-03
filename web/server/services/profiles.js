/** Engine owner_ref of every VO Profile voice. User owner refs are LQ-Studio UUIDs, so they never collide. */
export const LIBRARY_OWNER = 'library';

const UPSERT = `
  INSERT INTO voice_profiles (voice_id, slug, name, gender, language, description_id, description_en, tags,
    best_for_id, best_for_en, consent_subject, consent_attested_by, consent_scope, consent_granted_at, active, sort)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, now(), true, $14)
  ON CONFLICT (slug) DO UPDATE SET
    voice_id = EXCLUDED.voice_id, name = EXCLUDED.name, gender = EXCLUDED.gender, language = EXCLUDED.language,
    description_id = EXCLUDED.description_id, description_en = EXCLUDED.description_en, tags = EXCLUDED.tags,
    best_for_id = EXCLUDED.best_for_id, best_for_en = EXCLUDED.best_for_en,
    consent_subject = EXCLUDED.consent_subject, consent_attested_by = EXCLUDED.consent_attested_by,
    consent_scope = EXCLUDED.consent_scope, consent_granted_at = EXCLUDED.consent_granted_at,
    active = true, sort = EXCLUDED.sort`;

export function createProfiles(pool) {
  return {
    async list() {
      const { rows } = await pool.query('SELECT * FROM voice_profiles WHERE active ORDER BY sort, name, voice_id');
      return rows;
    },
    async get(voiceId) {
      const { rows: [row] } = await pool.query('SELECT * FROM voice_profiles WHERE voice_id = $1 AND active', [voiceId]);
      return row ?? null;
    },
    async bySlug(slug) {
      const { rows: [row] } = await pool.query('SELECT * FROM voice_profiles WHERE slug = $1', [slug]);
      return row ?? null;
    },
    // Insert or replace by slug in one transaction; the consent time is the moment this record is written.
    async upsert(meta, voiceId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [prev] } = await client.query('SELECT voice_id FROM voice_profiles WHERE slug = $1 FOR UPDATE', [meta.slug]);
        await client.query(UPSERT, [
          voiceId, meta.slug, meta.name, meta.gender, meta.language, meta.description.id, meta.description.en,
          JSON.stringify(meta.tags), meta.bestFor.id, meta.bestFor.en,
          meta.consent.subject, meta.consent.attestedBy, meta.consent.scope, meta.sort,
        ]);
        await client.query('COMMIT');
        return prev?.voice_id ?? null;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async deactivate(slug) {
      const { rowCount } = await pool.query('UPDATE voice_profiles SET active = false WHERE slug = $1', [slug]);
      return rowCount > 0;
    },
  };
}
