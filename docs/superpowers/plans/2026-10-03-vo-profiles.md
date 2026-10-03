# VO Profile (library voices) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in LQ-TTS user can preview and generate voiceovers with curated VO Profiles (first: Pandji) that never count toward their voice limit, cannot be deleted by users, carry a consent record, and vanish everywhere at once when deactivated.

**Architecture:** A profile voice is an ordinary engine voice owned by the reserved `owner_ref = "library"` (engine unchanged). The web DB gets a `voice_profiles` table (migration 006) holding the card copy and consent; `usableVoice` lets a user use a voice that is their own OR an active library profile, and `GET /api/voice-profiles` joins the rows with engine status. Profiles are created by an admin CLI (`server/cli/profile-add.js`) run inside the container with `docker exec -i`; the client shows a "VO Profile" section on the Voices page and groups the composer picker.

**Tech Stack:** Node 26 (ESM, `node:util` `parseArgs`, `import.meta.main`), Express 5, pg 8, undici fetch, Vitest 5 + supertest (server), React 19.3 + react-router 7.18 + Tailwind 4.3 + Testing Library (client), Playwright 1.63 (e2e), Docker compose on mac-studio.

**Spec:** `docs/superpowers/specs/2026-10-03-vo-profiles-design.md` (branch `feat/vo-profiles`, `~/Developer/LQ-TTS` on mac-studio). Read it before Task 1; this plan argues from it.

## Global Constraints

- Every command runs on **mac-studio** in `~/Developer/LQ-TTS/web` unless a step says otherwise. Non-interactive ssh needs `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH"` first (node, npm, npx, docker, psql live there).
- Branch: `feat/vo-profiles` (from `main` 4cf75f6, which is live in PROD). Never switch the checkout to another branch: pm2 runs the live engine from this same checkout.
- Commits: author `lqmnah <lqmnah@users.noreply.github.com>` via `git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "..."`; stage explicit paths only; no `Co-Authored-By`, no Claude/Anthropic/AI wording anywhere (SOP G8).
- Secrets are never printed: never `cat`/`echo`/display `web/.env*`, `~/.config/lq-tts/*` or a token. The CLI prints ids and statuses only and redacts every configured secret from error text.
- Engine untouched: no file under `engine/` changes. A profile voice is a normal engine voice with `owner_ref = "library"`; user owner refs are LQ-Studio UUIDs and never equal `library`.
- Deleting an engine voice also deletes every engine job made with it (engine `repo.delete_voice_cascade`). Nothing in this plan may delete a library voice that a web `jobs` row still uses, and nothing may list or purge library voices by `owner_ref` (staging, PROD and the local e2e run share the engine caller pattern; delete by recorded id only).
- UI copy: Indonesian and English, complete dictionaries (`web/client/src/i18n/id.js` and `en.js` keep identical keys), zero em dashes (`—`), no emoji. `i18n.test.js` enforces this. Copy fixed by the spec: section "VO Profile", own section "Suara saya", "Cocok untuk / Good for", "Pakai suara ini / Use this voice".
- Operate mode with the existing tokens and primitives only (`bg-surface`, `bg-surface-2`, `border-line`, `text-ink`, `text-muted`, `text-dim`, `rounded-panel`, `rounded-control`, `buttonClass`, `Button`, `StatusChip`, `Notice`, `Skeleton`, `PlayButton`); no new colors, fonts or shadows.
- SOP G4 skills load together before any UI edit (Tasks 4 and 5): `~/.claude/skills/ui-pro-max/SKILL.md`, `~/.claude/skills/impeccable/SKILL.md` (Operate mode; run `node ~/.claude/skills/impeccable/scripts/context.mjs --target web/client/src` once per session from `~/Developer/LQ-TTS`; read `~/.claude/skills/impeccable/reference/operate.md`; read `~/.claude/skills/impeccable/reference/craft-floor.md` **right before** the first UI file edit of each session), `~/.claude/skills/design-taste-frontend/SKILL.md`, `~/.claude/skills/gpt-taste/SKILL.md`.
- SOP G5 proof is Playwright on mac-studio (Task 6): screenshots, clean console, clean network, real clicks, `exact: true` text matching.
- The image contains only `server/` and `client/dist` (`web/.dockerignore` drops `server/test`, `e2e`, `ops`). The CLI and its metadata file live under `server/cli/` so they ship; their tests live under `server/test/` so they do not.
- Pricing, voice limits (Free 3 / paid 25) and `GET /api/voices` are unchanged; profiles cost the normal per-character price.
- Server tests: `npx vitest run <files>` from `web/` (reads `TEST_DATABASE_URL` from `web/.env`, never print it). Client tests: `npx vitest run <files>` from `web/client/`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `web/server/db/migrations/006_voice_profiles.sql` | create | `voice_profiles` table with spec constraints |
| `web/server/services/profiles.js` | create | `LIBRARY_OWNER`, `createProfiles(pool)` (list/get/bySlug/upsert/deactivate), `profilesWithVoices(ctx)` |
| `web/server/context.js` | modify | `ctx.profiles` |
| `web/server/services/ownership.js` | modify | `usableVoice(ctx, userId, voiceId)` |
| `web/server/routes/voice-profiles.js` | create | `GET /api/voice-profiles`, `toProfile` |
| `web/server/app.js` | modify | mount the router behind `requireAuth` |
| `web/server/routes/jobs.js` | modify | `POST /api/jobs` uses `usableVoice` |
| `web/server/routes/voices.js` | modify | `GET /api/voices/:id/preview` uses `usableVoice` (DELETE keeps `ownVoice`) |
| `web/server/services/jobs-repo.js` | modify | `usesVoice(voiceId)` |
| `web/server/cli/profile-meta.js` | create | `validateProfileMeta(raw)` |
| `web/server/cli/profile-add.js` | create | admin CLI: add/replace, `--deactivate`, `--list` |
| `web/server/cli/profiles/pandji.json` | create | Pandji metadata (spec §2) |
| `web/server/test/db.test.js` | modify | migration list includes 006 |
| `web/server/test/profiles.test.js` | create | store tests |
| `web/server/test/voice-profiles.test.js` | create | API and usage tests |
| `web/server/test/profile-add.test.js` | create | CLI tests |
| `web/client/src/lib/api.js`, `web/client/src/lib/types.js` | modify | `api.voiceProfiles()`, `VoiceProfile` typedef |
| `web/client/src/components/VoiceProfiles.jsx` | create | `ProfileSection` + card |
| `web/client/src/pages/VoicesPage.jsx` (+ test) | modify | profile section above "Suara saya" |
| `web/client/src/lib/voices.js` (+ test) | modify | `pickVoice(...)` |
| `web/client/src/pages/TtsPage.jsx` (+ test) | modify | grouped picker, default order, `?voice=`, stale-profile 404 |
| `web/client/src/i18n/id.js`, `en.js` | modify | new keys |
| `web/e2e/harness/run-server.mjs`, `web/e2e/target.mjs` | modify | seed Pandji locally through the CLI, cleanup by id, longer start timeout |
| `web/e2e/tests/journey.spec.js`, `screens.spec.js` | modify | one Pandji voiceover; Voices screen shows the card |

---

### Task 1: `voice_profiles` table and profile store

**Files:**
- Create: `web/server/db/migrations/006_voice_profiles.sql`
- Create: `web/server/services/profiles.js`
- Modify: `web/server/context.js`
- Modify: `web/server/test/db.test.js:38`
- Test: `web/server/test/profiles.test.js`

**Interfaces:**
- Consumes: `createPool(url, schema, {max})`, `migrate(pool, schema)` from `server/db/pool.js`; `testDatabaseUrl()` from `server/test/db-url.js`.
- Produces (later tasks rely on these exact names):
  - `LIBRARY_OWNER = 'library'` (export of `server/services/profiles.js`)
  - `type ProfileMeta = { slug: string, name: string, gender: 'male'|'female'|'neutral', language: 'id'|'en', description: {id: string, en: string}, tags: Array<{id: string, en: string}>, bestFor: {id: string, en: string}, consent: {subject: string, attestedBy: string, scope: string}, sort: number }`
  - `createProfiles(pool)` returns:
    - `list(): Promise<Row[]>` active rows ordered by `sort, name, voice_id`
    - `get(voiceId: string): Promise<Row|null>` the ACTIVE row of that voice id or null
    - `bySlug(slug: string): Promise<Row|null>` the row (active or not)
    - `upsert(meta: ProfileMeta, voiceId: string): Promise<string|null>` inserts or replaces by slug, sets `active = true`, stamps `consent_granted_at = now()`, returns the previous `voice_id` of that slug (or null)
    - `deactivate(slug: string): Promise<boolean>` true when a row was updated
  - `Row` = the table row as pg returns it: `voice_id` (string), `slug`, `name`, `gender`, `language`, `description_id`, `description_en`, `tags` (parsed array), `best_for_id`, `best_for_en`, `consent_subject`, `consent_attested_by`, `consent_scope`, `consent_granted_at` (Date), `active` (boolean), `sort` (number), `created_at` (Date).
  - `ctx.profiles` = `createProfiles(pool)` (set in `createContext`).

- [ ] **Step 1: Write the failing tests**

Edit `web/server/test/db.test.js` line 38, replace

```js
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_regen_lease.sql', '003_upload_leases.sql', '004_charge_claims.sql', '005_session_tv.sql']);
```

with

```js
    expect(rows.map((r) => r.name)).toEqual([
      '001_init.sql', '002_regen_lease.sql', '003_upload_leases.sql', '004_charge_claims.sql', '005_session_tv.sql', '006_voice_profiles.sql',
    ]);
```

Create `web/server/test/profiles.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/test/profiles.test.js server/test/db.test.js`
Expected: FAIL. `profiles.test.js` cannot import `../services/profiles.js`; `db.test.js` "applies each migration once" fails because `006_voice_profiles.sql` is missing from the applied list.

- [ ] **Step 3: Write the migration**

Create `web/server/db/migrations/006_voice_profiles.sql`:

```sql
CREATE TABLE voice_profiles (
  voice_id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  gender text NOT NULL CHECK (gender IN ('male', 'female', 'neutral')),
  language text NOT NULL CHECK (language IN ('id', 'en')),
  description_id text NOT NULL,
  description_en text NOT NULL,
  tags jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(tags) = 'array' THEN jsonb_array_length(tags) BETWEEN 1 AND 12 ELSE false END),
  best_for_id text NOT NULL,
  best_for_en text NOT NULL,
  consent_subject text NOT NULL,
  consent_attested_by text NOT NULL,
  consent_scope text NOT NULL,
  consent_granted_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_profiles_active ON voice_profiles (sort, name) WHERE active;
```

- [ ] **Step 4: Write the store**

Create `web/server/services/profiles.js`:

```js
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
```

Edit `web/server/context.js`: add the import after the `createJobsRepo` import and the ctx line after `ctx.jobsRepo = ...`:

```js
import { createJobsRepo } from './services/jobs-repo.js';
import { createProfiles } from './services/profiles.js';
import { createSessionStore } from './services/sessions.js';
```

```js
  ctx.jobsRepo = createJobsRepo(pool);
  ctx.profiles = createProfiles(pool);
  ctx.charges = createCharges(ctx);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/test/profiles.test.js server/test/db.test.js`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  10 passed (10)`.

- [ ] **Step 6: Commit**

```bash
git add web/server/db/migrations/006_voice_profiles.sql web/server/services/profiles.js web/server/context.js web/server/test/db.test.js web/server/test/profiles.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: voice_profiles table and profile store"
```

---

### Task 2: usable voices and `GET /api/voice-profiles`

**Files:**
- Modify: `web/server/services/profiles.js` (append `profilesWithVoices`)
- Modify: `web/server/services/ownership.js`
- Create: `web/server/routes/voice-profiles.js`
- Modify: `web/server/app.js`
- Modify: `web/server/routes/jobs.js:8,70`
- Modify: `web/server/routes/voices.js:9,162`
- Test: `web/server/test/voice-profiles.test.js`

**Interfaces:**
- Consumes: `LIBRARY_OWNER`, `ctx.profiles.get/list/upsert/deactivate` (Task 1); `engine.getVoice(id)`; `isEngineNotFound(err)`, `engineError(err)` from `server/lib/upstream-errors.js`; harness `startHarness()`, `h.engine.addVoice({owner_ref, name, status})`, `h.as(cookie).get/post/del/upload`.
- Produces:
  - `profilesWithVoices({ engine, profiles }): Promise<Array<{ row: Row, voice: EngineVoice|null }>>` (in `services/profiles.js`): active rows in list order; rows whose engine voice answers 404 or is not owned by `library` are left out; when the engine is unreachable (any other error) `voice` is `null`.
  - `usableVoice(ctx, userId, voiceId): Promise<EngineVoice>` (in `services/ownership.js`): 404 `not_found` for a bad uuid, an engine 404, or a voice that is neither the user's own nor an active library profile.
  - `GET /api/voice-profiles` (auth required, `Cache-Control: no-store`) answers `VoiceProfile[]`: `{ id, slug, name, gender, language, status: 'processing'|'ready'|'failed'|null, errorCode: string|null, description: {id, en}, tags: [{id, en}], bestFor: {id, en}, previewUrl: '/api/voices/<id>/preview' }`.

- [ ] **Step 1: Write the failing tests**

Create `web/server/test/voice-profiles.test.js`:

```js
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UpstreamUnavailable } from '../clients/http.js';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

const meta = (slug, { name = 'Pandji', sort = 100 } = {}) => ({
  slug,
  name,
  gender: 'male',
  language: 'id',
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }],
  bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: 'Pandji', attestedBy: 'lqmnah', scope: 'Public library voice' },
  sort,
});

describe('VO Profiles', () => {
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

  async function addProfile(slug, { status = 'ready', name = 'Pandji', sort = 100, ownerRef = 'library' } = {}) {
    const voice = h.engine.addVoice({ owner_ref: ownerRef, name, status });
    await h.ctx.profiles.upsert(meta(slug, { name, sort }), voice.id);
    return voice;
  }

  it('lists a profile in the browser shape, uncached', async () => {
    const voice = await addProfile('shape');
    const res = await ana.get('/api/voice-profiles');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.find((p) => p.id === voice.id)).toEqual({
      id: voice.id, slug: 'shape', name: 'Pandji', gender: 'male', language: 'id', status: 'ready', errorCode: null,
      description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
      tags: [{ id: 'Pria', en: 'Male' }],
      bestFor: { id: 'Narasi.', en: 'Narration.' },
      previewUrl: `/api/voices/${voice.id}/preview`,
    });
  });

  it('needs a session', async () => {
    const res = await request(h.app).get('/api/voice-profiles');
    expect(res.status).toBe(401);
  });

  it('orders by sort then name and leaves out inactive, missing and non-library voices', async () => {
    const bima = await addProfile('ord-b', { name: 'Bima', sort: 20 });
    const zara = await addProfile('ord-z', { name: 'Zara', sort: 10 });
    const ayu = await addProfile('ord-a', { name: 'Ayu', sort: 20 });
    const busy = await addProfile('ord-p', { name: 'Proses', sort: 30, status: 'processing' });
    const off = await addProfile('ord-off', { name: 'Mati', sort: 1 });
    await h.ctx.profiles.deactivate('ord-off');
    const gone = await addProfile('ord-gone', { name: 'Hilang', sort: 1 });
    h.engine.state.voices.delete(gone.id);
    const foreign = await addProfile('ord-foreign', { name: 'Asing', sort: 1, ownerRef: 'ana' });
    const ids = new Set([bima, zara, ayu, busy, off, gone, foreign].map((v) => v.id));
    const res = await ana.get('/api/voice-profiles');
    expect(res.body.filter((p) => ids.has(p.id)).map((p) => [p.name, p.status])).toEqual([
      ['Zara', 'ready'], ['Ayu', 'ready'], ['Bima', 'ready'], ['Proses', 'processing'],
    ]);
  });

  it('still lists profiles, without a status, when the engine is unreachable', async () => {
    const voice = await addProfile('offline');
    const { engine } = h.ctx;
    const original = engine.getVoice;
    engine.getVoice = async () => {
      throw new UpstreamUnavailable('engine', new Error('connect ECONNREFUSED'));
    };
    try {
      const res = await ana.get('/api/voice-profiles');
      expect(res.status).toBe(200);
      expect(res.body.find((p) => p.id === voice.id)).toMatchObject({ status: null, errorCode: null, previewUrl: `/api/voices/${voice.id}/preview` });
    } finally {
      engine.getVoice = original;
    }
  });

  it('lets two different users preview a profile and voice over with it at the normal price', async () => {
    const voice = await addProfile('shared');
    for (const client of [ana, budi]) {
      const preview = await client.get(`/api/voices/${voice.id}/preview`).buffer(true).parse(binary);
      expect(preview.status).toBe(200);
      expect(Buffer.compare(preview.body, WAV_BYTES)).toBe(0);
      const job = await client.post('/api/jobs', { voiceId: voice.id, text: 'Halo dunia.' });
      expect(job.status).toBe(202);
      expect(job.body.credits).toBe(1);
      expect(h.engine.state.jobs.get(job.body.id).voice_id).toBe(voice.id);
      const list = await client.get('/api/jobs');
      expect(list.body.items[0]).toMatchObject({ id: job.body.id, voiceId: voice.id, voiceName: 'Pandji' });
    }
  });

  it('never lets a user delete a profile', async () => {
    const voice = await addProfile('undeletable');
    const res = await ana.del(`/api/voices/${voice.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(h.engine.state.voices.has(voice.id)).toBe(true);
    expect((await ana.get('/api/voice-profiles')).body.some((p) => p.id === voice.id)).toBe(true);
  });

  it('does not count profiles toward the voice limit', async () => {
    const poor = h.as(await h.login(USERS.poor));
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    await addProfile('free-of-limit');
    expect((await poor.get('/api/me')).body.voiceCount).toBe(2);
    const res = await poor.upload('/api/voices').field('name', 'Ketiga').field('consent', 'true')
      .attach('audio', Buffer.alloc(4096, 1), 'take.wav');
    expect(res.status).toBe(202);
  });

  it('turns an inactive profile away everywhere and keeps its engine voice', async () => {
    const voice = await addProfile('retired');
    await h.ctx.profiles.deactivate('retired');
    expect((await ana.get(`/api/voices/${voice.id}/preview`)).status).toBe(404);
    const job = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo dunia.' });
    expect(job.status).toBe(404);
    expect(job.body.error.code).toBe('not_found');
    expect((await ana.get('/api/voice-profiles')).body.some((p) => p.id === voice.id)).toBe(false);
    expect(h.engine.state.voices.has(voice.id)).toBe(true);
  });

  it('refuses a library voice that has no profile row', async () => {
    const stray = h.engine.addVoice({ owner_ref: 'library', name: 'Stray' });
    expect((await ana.get(`/api/voices/${stray.id}/preview`)).status).toBe(404);
    expect((await ana.post('/api/jobs', { voiceId: stray.id, text: 'Halo dunia.' })).status).toBe(404);
  });

  it("still refuses another user's own voice", async () => {
    const theirs = h.engine.addVoice({ owner_ref: 'budi', name: 'Milik Budi' });
    expect((await ana.get(`/api/voices/${theirs.id}/preview`)).status).toBe(404);
    expect((await ana.post('/api/jobs', { voiceId: theirs.id, text: 'Halo dunia.' })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/test/voice-profiles.test.js`
Expected: FAIL in the tests that read `GET /api/voice-profiles` (404 `no such endpoint`: shape, order, unreachable, inactive) and in the shared-profile test (404 on preview, `ownVoice` refuses a library voice). "needs a session", "never lets a user delete", "does not count", "refuses a library voice without a row" and "another user's own voice" already pass: they pin behaviour the change must keep.

- [ ] **Step 3: Add `profilesWithVoices`**

Append to `web/server/services/profiles.js` and add the import at the top of the file:

```js
import { isEngineNotFound } from '../lib/upstream-errors.js';
```

```js
/**
 * Active profiles joined with their engine voice, in list order. A profile whose engine voice is gone (404) or is
 * not a library voice is left out; when the engine cannot be asked, the row stays with `voice: null`.
 */
export async function profilesWithVoices({ engine, profiles }) {
  const rows = await profiles.list();
  const joined = await Promise.all(rows.map(async (row) => {
    try {
      const voice = await engine.getVoice(row.voice_id);
      return voice.owner_ref === LIBRARY_OWNER ? { row, voice } : null;
    } catch (err) {
      return isEngineNotFound(err) ? null : { row, voice: null };
    }
  }));
  return joined.filter(Boolean);
}
```

- [ ] **Step 4: Add `usableVoice`**

In `web/server/services/ownership.js` add the import below the existing imports and the function after `ownVoice`:

```js
import { LIBRARY_OWNER } from './profiles.js';
```

```js
/** A voice the user may preview and voice over with: their own, or an active VO Profile (library voice). */
export async function usableVoice(ctx, userId, voiceId) {
  if (!isUuid(voiceId)) throw new ApiError('not_found', 'voice not found');
  let voice;
  try {
    voice = await ctx.engine.getVoice(voiceId.toLowerCase());
  } catch (err) {
    throw engineError(err);
  }
  if (voice.owner_ref === String(userId)) return voice;
  if (voice.owner_ref === LIBRARY_OWNER && (await ctx.profiles.get(voice.id))) return voice;
  throw new ApiError('not_found', 'voice not found');
}
```

- [ ] **Step 5: Add the route and wire it**

Create `web/server/routes/voice-profiles.js`:

```js
import express from 'express';
import { profilesWithVoices } from '../services/profiles.js';

export const toProfile = (row, voice) => ({
  id: row.voice_id,
  slug: row.slug,
  name: row.name,
  gender: row.gender,
  language: row.language,
  status: voice?.status ?? null,
  errorCode: voice?.error_code ?? null,
  description: { id: row.description_id, en: row.description_en },
  tags: row.tags,
  bestFor: { id: row.best_for_id, en: row.best_for_en },
  previewUrl: `/api/voices/${row.voice_id}/preview`,
});

export function voiceProfilesRouter(ctx) {
  const router = express.Router();
  router.get('/voice-profiles', async (req, res) => {
    const list = await profilesWithVoices(ctx);
    res.set('Cache-Control', 'no-store').json(list.map(({ row, voice }) => toProfile(row, voice)));
  });
  return router;
}
```

In `web/server/app.js` add the import after the `voicesRouter` import and mount it right after `voicesRouter` (behind `requireAuth`):

```js
import { voicesRouter } from './routes/voices.js';
import { voiceProfilesRouter } from './routes/voice-profiles.js';
```

```js
  app.use('/api', voicesRouter(ctx));
  app.use('/api', voiceProfilesRouter(ctx));
  app.use('/api', jobsRouter(ctx));
```

In `web/server/routes/jobs.js` replace the import on line 8 and the voice lookup on line 70:

```js
import { isUuid, ownJob, parseIdx, usableVoice } from '../services/ownership.js';
```

```js
    const voice = await usableVoice(ctx, userId, voiceId);
```

In `web/server/routes/voices.js` replace the import on line 9 and the preview lookup on line 162 (DELETE on line 168 keeps `ownVoice`):

```js
import { ownVoice, usableVoice } from '../services/ownership.js';
```

```js
    const voice = await usableVoice(ctx, req.session.user_id, req.params.id);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/test/voice-profiles.test.js`
Expected: PASS, `Tests  10 passed (10)`.

Run: `npm test 2>&1 | grep -E '^ *(Test Files|Tests) '`
Expected: every file passes (no `failed` in either line).

- [ ] **Step 7: Commit**

```bash
git add web/server/services/profiles.js web/server/services/ownership.js web/server/routes/voice-profiles.js web/server/app.js web/server/routes/jobs.js web/server/routes/voices.js web/server/test/voice-profiles.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: VO Profiles usable by every user, GET /api/voice-profiles"
```

---

### Task 3: admin CLI `profile-add`

**Files:**
- Create: `web/server/cli/profile-meta.js`
- Create: `web/server/cli/profile-add.js`
- Create: `web/server/cli/profiles/pandji.json`
- Modify: `web/server/services/jobs-repo.js` (add `usesVoice` after `get`)
- Test: `web/server/test/profile-add.test.js`

**Interfaces:**
- Consumes: `LIBRARY_OWNER`, `createProfiles(pool)` with `upsert/deactivate/bySlug/get`, `profilesWithVoices({engine, profiles})` (Tasks 1 and 2); `createEngine({baseUrl, token})` with `uploadVoice({fields, filename, mimeType, file})`, `getVoice(id)`, `deleteVoice(id)`; `UpstreamError`, `UpstreamUnavailable` (`server/clients/http.js`); `isEngineNotFound` (`server/lib/upstream-errors.js`); `loadConfig()`; `createPool`, `migrate`; `createJobsRepo(pool)`.
- Produces:
  - `validateProfileMeta(raw: unknown): ProfileMeta` (throws `Error` with a field-specific message) in `server/cli/profile-meta.js`.
  - `jobsRepo.usesVoice(voiceId: string): Promise<boolean>`: a live (not deleted) web job uses this voice.
  - `runProfileAdd({ argv, stdin, out, err, ctx: {engine, profiles, jobsRepo}, secrets = [], pollMs = 5000, timeoutMs = 900000, sleep, now }): Promise<0|1>` and `USAGE`, `POLL_MS`, `TIMEOUT_MS`, `redact(text, secrets)` exported from `server/cli/profile-add.js`.
  - CLI modes (exactly one): `--meta <file.json> --filename <name.mp3|.wav|.m4a|.flac>` with the audio on stdin; `--deactivate <slug>`; `--list`.
  - Output lines (stdout), nothing else: `voice <id> <status>`, `voice <id> ready`, `voice <id> failed <error_code|unknown>`, `voice <id> timeout`, `profile <slug> active voice <id>`, `previous voice <id> deleted|already gone`, `previous voice <id> kept, used by jobs`, `previous voice <id> not deleted: <code>`, `profile <slug> deactivated`, `profiles <n>`, `profile <slug> voice <id> <status|unreachable>`. Errors go to stderr as `error: <message>` with every secret replaced by `***`.
  - Exact container invocation (fixed by this plan; `docker exec -i` forwards stdin only, so the metadata is a file inside the image):
    `docker exec -i <container> node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename VO-Sample-Pandji.mp3 < ~/Developer/LQ-TTS/data/fixtures/pandji/VO-Sample-Pandji.mp3`

- [ ] **Step 1: Write the Pandji metadata (spec §2)**

Create `web/server/cli/profiles/pandji.json` (no `consent.grantedAt`: the CLI stamps the time it records the consent):

```json
{
  "slug": "pandji",
  "name": "Pandji",
  "gender": "male",
  "language": "id",
  "description": {
    "id": "Pria, bariton hangat. Gaya bercerita yang santai dan tenang, intonasi ekspresif, penekanan tegas di kata kunci, jeda yang disengaja. Bahasa Indonesia kasual ala Jakarta.",
    "en": "Male, warm baritone. Relaxed, calm storytelling with expressive intonation, firm emphasis on key words and deliberate pauses. Casual Jakarta-style Indonesian."
  },
  "tags": [
    { "id": "Pria", "en": "Male" },
    { "id": "Bariton hangat", "en": "Warm baritone" },
    { "id": "Tegas", "en": "Firm" },
    { "id": "Tenang", "en": "Calm" },
    { "id": "Pencerita", "en": "Storyteller" },
    { "id": "Ekspresif", "en": "Expressive" },
    { "id": "Santai", "en": "Conversational" },
    { "id": "Bahasa Indonesia", "en": "Indonesian" }
  ],
  "bestFor": {
    "id": "Narasi, ulasan dan komentar film, podcast, video penjelasan, YouTube.",
    "en": "Narration, film reviews and commentary, podcasts, explainers, YouTube."
  },
  "consent": {
    "subject": "Pandji",
    "attestedBy": "lqmnah",
    "scope": "Public library voice for all LQ-TTS users on tts.lq-studio.com"
  },
  "sort": 10
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/server/test/profile-add.test.js`:

```js
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USAGE, runProfileAdd } from '../cli/profile-add.js';
import { validateProfileMeta } from '../cli/profile-meta.js';
import { testDatabaseUrl } from './db-url.js';
import { CALLBACK_SECRET, ENGINE_TOKEN, LQ_TOKEN, startHarness } from './helpers.js';

const PANDJI = fileURLToPath(new URL('../cli/profiles/pandji.json', import.meta.url));
const BASE = JSON.parse(readFileSync(PANDJI, 'utf8'));
const AUDIO = Buffer.alloc(8192, 3);
const dir = mkdtempSync(join(tmpdir(), 'lq-tts-profile-'));

function writeMeta(over) {
  const file = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ ...BASE, ...over }));
  return file;
}

describe('validateProfileMeta', () => {
  it('accepts the shipped Pandji metadata', () => {
    const meta = validateProfileMeta(BASE);
    expect(meta).toMatchObject({
      slug: 'pandji', name: 'Pandji', gender: 'male', language: 'id', sort: 10,
      consent: { subject: 'Pandji', attestedBy: 'lqmnah', scope: 'Public library voice for all LQ-TTS users on tts.lq-studio.com' },
    });
    expect(meta.tags).toHaveLength(8);
    expect(meta.tags[1]).toEqual({ id: 'Bariton hangat', en: 'Warm baritone' });
  });

  it('defaults the sort to 100', () => {
    const { sort, ...rest } = BASE;
    expect(validateProfileMeta(rest).sort).toBe(100);
  });

  it.each([
    [{ slug: 'Pandji!' }, /^slug must match/],
    [{ name: 'x'.repeat(81) }, /^name must be at most 80 characters/],
    [{ gender: 'other' }, /^gender must be/],
    [{ language: 'fr' }, /^language must be id or en/],
    [{ tags: [] }, /^tags must be an array of 1 to 12/],
    [{ tags: Array.from({ length: 13 }, () => ({ id: 'a', en: 'a' })) }, /^tags must be an array of 1 to 12/],
    [{ tags: [{ id: 'Pria' }] }, /^tags\[0\]\.en must be a non-empty string/],
    [{ description: { id: 'Pria \u2014 bariton', en: 'Male' } }, /^description\.id must not contain an em dash/],
    [{ bestFor: 'Narasi' }, /^bestFor must be an object/],
    [{ consent: { subject: 'Pandji', attestedBy: 'lqmnah' } }, /^consent\.scope must be a non-empty string/],
    [{ consentGrantedAt: '2026-01-01' }, /^unknown metadata keys: consentGrantedAt/],
    [{ sort: 1.5 }, /^sort must be a whole number/],
  ])('rejects %j', (over, message) => {
    expect(() => validateProfileMeta({ ...BASE, ...over })).toThrow(message);
  });
});

describe('profile-add CLI', () => {
  let h;
  const printed = [];
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const uploads = () => h.engine.state.callsTo('POST', '/v1/voices').length;
  // Plays the engine finishing: every library voice still processing gets `status` when the CLI first waits.
  const finishAs = (status, errorCode = null) => async () => {
    for (const v of h.engine.state.voices.values()) {
      if (v.owner_ref === 'library' && v.status === 'processing') Object.assign(v, { status, error_code: errorCode });
    }
  };

  async function run(argv, { sleep = finishAs('ready'), now, engine } = {}) {
    const lines = [];
    const errors = [];
    const code = await runProfileAdd({
      argv,
      stdin: Readable.from([AUDIO]),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      ctx: { engine: engine ?? h.ctx.engine, profiles: h.ctx.profiles, jobsRepo: h.ctx.jobsRepo },
      secrets: [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()],
      sleep,
      ...(now ? { now } : {}),
    });
    printed.push(...lines, ...errors);
    return { code, lines, errors, id: lines[0]?.split(' ')[1] };
  }

  it.each([
    [[], /^error: usage: profile-add\.js/],
    [['--meta', PANDJI], /^error: --filename is required with --meta$/],
    [['--meta', PANDJI, '--filename', 'notes.txt'], /^error: --filename must end in \.mp3, \.wav, \.m4a or \.flac$/],
    [['--list', '--deactivate', 'x'], /^error: usage: profile-add\.js/],
    [['--bogus'], /^error: Unknown option '--bogus'/],
    [['--meta', join(dir, 'missing.json'), '--filename', 'a.mp3'], /^error: cannot read metadata file .*missing\.json as JSON$/],
    [['--meta', writeMeta({ gender: 'other' }), '--filename', 'a.mp3'], /^error: gender must be male, female or neutral$/],
  ])('refuses %j before any upload', async (argv, message) => {
    const before = uploads();
    const { code, lines, errors } = await run(argv);
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
    expect(uploads()).toBe(before);
    expect(USAGE).toMatch(/^usage: profile-add\.js/);
  });

  it('uploads the audio as a library voice, waits for ready, then records the profile with its consent', async () => {
    const { code, lines, errors, id } = await run(['--meta', PANDJI, '--filename', 'VO-Sample-Pandji.mp3']);
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(lines).toEqual([`voice ${id} processing`, `voice ${id} ready`, `profile pandji active voice ${id}`]);
    expect(h.engine.state.voices.get(id)).toMatchObject({ owner_ref: 'library', name: 'Pandji', language: 'id', status: 'ready', bytes: AUDIO.length });
    expect(h.engine.state.callsTo('POST', '/v1/voices').at(-1).body.file).toMatchObject({ filename: 'VO-Sample-Pandji.mp3', mimeType: 'audio/mpeg' });
    const row = await h.ctx.profiles.bySlug('pandji');
    expect(row).toMatchObject({
      voice_id: id, active: true, sort: 10, name: 'Pandji',
      consent_subject: 'Pandji', consent_attested_by: 'lqmnah',
      consent_scope: 'Public library voice for all LQ-TTS users on tts.lq-studio.com',
    });
    expect(Date.now() - row.consent_granted_at.getTime()).toBeLessThan(60_000);
  });

  it('replaces a profile only after the new voice is ready, then deletes the old voice', async () => {
    const meta = writeMeta({ slug: 'replace-order' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const seenWhileProcessing = [];
    const second = await run(['--meta', meta, '--filename', 'b.wav'], {
      sleep: async () => {
        seenWhileProcessing.push((await h.ctx.profiles.bySlug('replace-order')).voice_id, h.engine.state.voices.has(oldId));
        await finishAs('ready')();
      },
    });
    const newId = second.id;
    expect(seenWhileProcessing).toEqual([oldId, true]);
    expect(second.code).toBe(0);
    expect(second.lines).toEqual([
      `voice ${newId} processing`, `voice ${newId} ready`, `profile replace-order active voice ${newId}`, `previous voice ${oldId} deleted`,
    ]);
    expect((await h.ctx.profiles.bySlug('replace-order')).voice_id).toBe(newId);
    expect(h.engine.state.voices.has(oldId)).toBe(false);
    const calls = h.engine.state.calls.map((c) => `${c.method} ${c.path}`);
    const readyCheck = calls.lastIndexOf(`GET /v1/voices/${newId}`);
    expect(readyCheck).toBeGreaterThan(-1);
    expect(calls.indexOf(`DELETE /v1/voices/${oldId}`)).toBeGreaterThan(readyCheck);
  });

  it('keeps the previous voice when voiceovers still use it', async () => {
    const meta = writeMeta({ slug: 'still-used' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    await h.pool.query(
      `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status) VALUES ($1, 'ana', $2, 'Pandji', 'Halo', 5, 'done')`,
      [crypto.randomUUID(), oldId],
    );
    const second = await run(['--meta', meta, '--filename', 'b.wav']);
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toBe(`previous voice ${oldId} kept, used by jobs`);
    expect(h.engine.state.voices.has(oldId)).toBe(true);
    expect((await h.ctx.profiles.bySlug('still-used')).voice_id).toBe(second.id);
  });

  it('exits 1 on a failed voice, deletes it, and leaves an existing profile on its old voice', async () => {
    const meta = writeMeta({ slug: 'fail-keep' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const failed = await run(['--meta', meta, '--filename', 'b.wav'], { sleep: finishAs('failed', 'no_clean_speech') });
    expect(failed.code).toBe(1);
    expect(failed.lines).toEqual([`voice ${failed.id} processing`, `voice ${failed.id} failed no_clean_speech`]);
    expect(h.engine.state.voices.has(failed.id)).toBe(false);
    expect(await h.ctx.profiles.bySlug('fail-keep')).toMatchObject({ voice_id: oldId, active: true });
    expect(h.engine.state.voices.has(oldId)).toBe(true);
  });

  it('polls every 5 s for 15 min, then gives up, deletes the voice and records nothing', async () => {
    let t = 0;
    const res = await run(['--meta', writeMeta({ slug: 'too-slow' }), '--filename', 'a.wav'], {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(res.code).toBe(1);
    expect(res.lines).toEqual([`voice ${res.id} processing`, `voice ${res.id} timeout`]);
    expect(h.engine.state.calls.filter((c) => c.method === 'GET' && c.path === `/v1/voices/${res.id}`)).toHaveLength(181);
    expect(h.engine.state.voices.has(res.id)).toBe(false);
    expect(await h.ctx.profiles.bySlug('too-slow')).toBeNull();
  });

  it('exits 1 without a profile when the engine is down', async () => {
    h.engine.state.failNext.set('POST /v1/voices', { status: 503, code: 'model_loading' });
    const res = await run(['--meta', writeMeta({ slug: 'engine-down' }), '--filename', 'a.wav']);
    expect(res.code).toBe(1);
    expect(res.errors).toEqual(['error: the voice engine is unavailable']);
    expect(await h.ctx.profiles.bySlug('engine-down')).toBeNull();
  });

  it('deactivates by slug without touching the engine voice', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'gone' }), '--filename', 'a.wav']);
    const off = await run(['--deactivate', 'gone']);
    expect(off.code).toBe(0);
    expect(off.lines).toEqual(['profile gone deactivated']);
    expect(await h.ctx.profiles.get(id)).toBeNull();
    expect(h.engine.state.voices.has(id)).toBe(true);
    const unknown = await run(['--deactivate', 'nobody']);
    expect(unknown.code).toBe(1);
    expect(unknown.errors).toEqual(['error: profile nobody not found']);
  });

  it('lists active profiles with their engine status', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'listed' }), '--filename', 'a.wav']);
    const res = await run(['--list']);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toMatch(/^profiles \d+$/);
    expect(res.lines).toContain(`profile listed voice ${id} ready`);
  });

  it('redacts secrets from error text', async () => {
    const leaky = { ...h.ctx.engine, uploadVoice: async () => { throw new Error(`connect to ${testDatabaseUrl()} with ${ENGINE_TOKEN} failed`); } };
    const res = await run(['--meta', writeMeta({ slug: 'leaky' }), '--filename', 'a.wav'], { engine: leaky });
    expect(res.code).toBe(1);
    expect(res.errors).toEqual(['error: connect to *** with *** failed']);
  });

  it('never printed a secret in any run above', () => {
    expect(printed.length).toBeGreaterThan(20);
    for (const secret of [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()]) {
      expect(printed.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/test/profile-add.test.js`
Expected: FAIL, the suite cannot import `../cli/profile-add.js` / `../cli/profile-meta.js`.

- [ ] **Step 4: Write the metadata validator**

Create `web/server/cli/profile-meta.js`:

```js
const SLUG = /^[a-z0-9-]{1,40}$/;
const TOP_KEYS = ['slug', 'name', 'gender', 'language', 'description', 'tags', 'bestFor', 'consent', 'sort'];
const GENDERS = ['male', 'female', 'neutral'];
const LANGUAGES = ['id', 'en'];
const EM_DASH = '\u2014';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(value, keys, field) {
  const unknown = Object.keys(value).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`unknown ${field} keys: ${unknown.join(', ')}`);
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  if (trimmed.includes(EM_DASH)) throw new Error(`${field} must not contain an em dash`);
  return trimmed;
}

function bilingual(value, field, max) {
  if (!isObject(value)) throw new Error(`${field} must be an object {id, en}`);
  onlyKeys(value, ['id', 'en'], field);
  return { id: text(value.id, `${field}.id`, max), en: text(value.en, `${field}.en`, max) };
}

/** Checks a profile metadata file (shape of server/cli/profiles/pandji.json) and returns the ProfileMeta the store takes. */
export function validateProfileMeta(raw) {
  if (!isObject(raw)) throw new Error('metadata must be a JSON object');
  onlyKeys(raw, TOP_KEYS, 'metadata');
  if (typeof raw.slug !== 'string' || !SLUG.test(raw.slug)) throw new Error('slug must match ^[a-z0-9-]{1,40}$');
  const name = text(raw.name, 'name', 80);
  if (!GENDERS.includes(raw.gender)) throw new Error('gender must be male, female or neutral');
  if (!LANGUAGES.includes(raw.language)) throw new Error('language must be id or en');
  const description = bilingual(raw.description, 'description', 600);
  if (!Array.isArray(raw.tags) || raw.tags.length < 1 || raw.tags.length > 12) {
    throw new Error('tags must be an array of 1 to 12 {id, en} items');
  }
  const tags = raw.tags.map((tag, i) => bilingual(tag, `tags[${i}]`, 40));
  const bestFor = bilingual(raw.bestFor, 'bestFor', 300);
  if (!isObject(raw.consent)) throw new Error('consent must be an object {subject, attestedBy, scope}');
  onlyKeys(raw.consent, ['subject', 'attestedBy', 'scope'], 'consent');
  const consent = {
    subject: text(raw.consent.subject, 'consent.subject', 200),
    attestedBy: text(raw.consent.attestedBy, 'consent.attestedBy', 200),
    scope: text(raw.consent.scope, 'consent.scope', 200),
  };
  const sort = raw.sort ?? 100;
  if (!Number.isInteger(sort) || sort < 0 || sort > 10000) throw new Error('sort must be a whole number from 0 to 10000');
  return { slug: raw.slug, name, gender: raw.gender, language: raw.language, description, tags, bestFor, consent, sort };
}
```

- [ ] **Step 5: Add `usesVoice` to the jobs repo**

In `web/server/services/jobs-repo.js`, insert after the `get(id)` method (before the `// Newest first` comment):

```js
    // Deleting an engine voice deletes every engine job made with it: a voice that live jobs use must stay.
    async usesVoice(voiceId) {
      const { rows: [row] } = await pool.query(
        'SELECT EXISTS (SELECT 1 FROM jobs WHERE voice_id = $1 AND deleted_at IS NULL) AS used', [voiceId],
      );
      return row.used;
    },
```

- [ ] **Step 6: Write the CLI**

Create `web/server/cli/profile-add.js`:

```js
// Admin CLI for VO Profiles (library voices). Runs inside the web container, which carries every env setting.
//   add or replace: docker exec -i <container> node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename VO-Sample-Pandji.mp3 < VO-Sample-Pandji.mp3
//   deactivate:     docker exec <container> node server/cli/profile-add.js --deactivate pandji
//   list:           docker exec <container> node server/cli/profile-add.js --list
// The audio arrives on stdin (docker exec -i forwards stdin only, so the metadata is a file inside the image).
// Output is ids and statuses only; error text passes through redact() before it is printed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createEngine } from '../clients/engine.js';
import { UpstreamError, UpstreamUnavailable } from '../clients/http.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db/pool.js';
import { isEngineNotFound } from '../lib/upstream-errors.js';
import { createJobsRepo } from '../services/jobs-repo.js';
import { LIBRARY_OWNER, createProfiles, profilesWithVoices } from '../services/profiles.js';
import { validateProfileMeta } from './profile-meta.js';

export const POLL_MS = 5000;
export const TIMEOUT_MS = 15 * 60 * 1000;
export const USAGE = 'usage: profile-add.js --meta <file.json> --filename <name.mp3|.wav|.m4a|.flac> < audio | --deactivate <slug> | --list';
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out;
}

function describeError(err) {
  if (err instanceof UpstreamError) return `the engine refused the request: ${err.code}`;
  if (err instanceof UpstreamUnavailable) return 'the voice engine is unavailable';
  return err?.message ?? String(err);
}

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { meta: { type: 'string' }, filename: { type: 'string' }, deactivate: { type: 'string' }, list: { type: 'boolean' } },
    allowPositionals: true,
  });
  const modes = [values.meta !== undefined, values.deactivate !== undefined, values.list === true].filter(Boolean).length;
  if (positionals.length || modes !== 1) throw new Error(USAGE);
  if (values.meta === undefined) {
    if (values.filename !== undefined) throw new Error(USAGE);
    return values;
  }
  if (!values.filename) throw new Error('--filename is required with --meta');
  if (!AUDIO_TYPES[path.extname(values.filename).toLowerCase()]) throw new Error('--filename must end in .mp3, .wav, .m4a or .flac');
  return values;
}

// 'ready' | 'failed <code>' | 'timeout'. An engine restart (unreachable) is waited out like processing.
async function waitReady(engine, id, { pollMs, timeoutMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let voice = null;
    try {
      voice = await engine.getVoice(id);
    } catch (err) {
      if (!(err instanceof UpstreamUnavailable)) throw err;
    }
    if (voice?.status === 'ready') return 'ready';
    if (voice?.status === 'failed') return `failed ${voice.error_code ?? 'unknown'}`;
    if (now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
}

async function retire(voiceId, { engine, jobsRepo }) {
  if (await jobsRepo.usesVoice(voiceId)) return `previous voice ${voiceId} kept, used by jobs`;
  try {
    await engine.deleteVoice(voiceId);
    return `previous voice ${voiceId} deleted`;
  } catch (err) {
    if (isEngineNotFound(err)) return `previous voice ${voiceId} already gone`;
    return `previous voice ${voiceId} not deleted: ${err instanceof UpstreamError ? err.code : 'engine_unavailable'}`;
  }
}

async function addProfile(ctx, args, { stdin, out, pollMs, timeoutMs, sleep, now }) {
  const { engine, profiles } = ctx;
  let raw;
  try {
    raw = JSON.parse(await readFile(args.meta, 'utf8'));
  } catch {
    throw new Error(`cannot read metadata file ${args.meta} as JSON`);
  }
  const meta = validateProfileMeta(raw);
  if (stdin.isTTY) throw new Error('pipe the audio file on stdin');
  const created = await engine.uploadVoice({
    fields: { name: meta.name, owner_ref: LIBRARY_OWNER, language: meta.language },
    filename: args.filename,
    mimeType: AUDIO_TYPES[path.extname(args.filename).toLowerCase()],
    file: stdin,
  });
  out(`voice ${created.id} ${created.status}`);
  // Until the row is written nothing points at the new voice; on any failure it is removed again.
  const discard = () => engine.deleteVoice(created.id).catch(() => {});
  let outcome;
  try {
    outcome = await waitReady(engine, created.id, { pollMs, timeoutMs, sleep, now });
  } catch (err) {
    await discard();
    throw err;
  }
  if (outcome !== 'ready') {
    await discard();
    out(`voice ${created.id} ${outcome}`);
    return 1;
  }
  out(`voice ${created.id} ready`);
  let previous;
  try {
    previous = await profiles.upsert(meta, created.id);
  } catch (err) {
    await discard();
    throw err;
  }
  out(`profile ${meta.slug} active voice ${created.id}`);
  if (previous && previous !== created.id) out(await retire(previous, ctx));
  return 0;
}

async function deactivate({ profiles }, slug, out) {
  if (!(await profiles.deactivate(slug))) throw new Error(`profile ${slug} not found`);
  out(`profile ${slug} deactivated`);
  return 0;
}

async function listProfiles(ctx, out) {
  const list = await profilesWithVoices(ctx);
  out(`profiles ${list.length}`);
  for (const { row, voice } of list) out(`profile ${row.slug} voice ${row.voice_id} ${voice ? voice.status : 'unreachable'}`);
  return 0;
}

export async function runProfileAdd({
  argv, stdin, out, err, ctx, secrets = [], pollMs = POLL_MS, timeoutMs = TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  try {
    const args = parseCliArgs(argv);
    if (args.list) return await listProfiles(ctx, out);
    if (args.deactivate !== undefined) return await deactivate(ctx, args.deactivate, out);
    return await addProfile(ctx, args, { stdin, out, pollMs, timeoutMs, sleep, now });
  } catch (error) {
    err(`error: ${redact(describeError(error), secrets)}`);
    return 1;
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const secrets = [config.engineToken, config.lqstudioToken, config.engineCallbackSecret, config.databaseUrl];
  const pool = createPool(config.databaseUrl, config.dbSchema, { max: 2 });
  try {
    await migrate(pool, config.dbSchema); // a no-op once the server has started; needed when the CLI runs first (e2e)
    process.exitCode = await runProfileAdd({
      argv: process.argv.slice(2),
      stdin: process.stdin,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      ctx: {
        engine: createEngine({ baseUrl: config.engineUrl, token: config.engineToken }),
        profiles: createProfiles(pool),
        jobsRepo: createJobsRepo(pool),
      },
      secrets,
    });
  } catch (error) {
    process.stderr.write(`error: ${redact(describeError(error), secrets)}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run server/test/profile-add.test.js`
Expected: PASS, `Test Files  1 passed (1)`, `Tests  31 passed (31)` (14 validator cases, 7 refusals, 10 CLI behaviours).

Run: `npm test 2>&1 | grep -E '^ *(Test Files|Tests) '`
Expected: every file passes (no `failed`).

- [ ] **Step 8: Smoke the real entry point (no secrets shown)**

Same env as the e2e harness (`web/.env.stg` is read inside node, never printed), a throwaway schema, `--list` only:

```bash
node --input-type=module -e "
import { spawnSync } from 'node:child_process';
import { readEnvFile, toHostDatabaseUrl } from './ops/env-lib.mjs';
const base = readEnvFile('.env.stg');
const env = { ...process.env, ...base, DATABASE_URL: toHostDatabaseUrl(base.DATABASE_URL), DB_SCHEMA: 'lq_tts_web_cli_smoke',
  ENGINE_URL: 'http://127.0.0.1:8740', ENGINE_CALLBACK_URL: 'http://127.0.0.1:1/x', LQSTUDIO_URL: 'http://127.0.0.1:1',
  LQSTUDIO_TOKEN: 'smoke-token-not-a-secret-000000000000', LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com' };
const r = spawnSync(process.execPath, ['server/cli/profile-add.js', '--list'], { env, stdio: 'inherit' });
console.log('exit', r.status);
"
/opt/homebrew/opt/postgresql@16/bin/psql -d lq_tts -qc 'DROP SCHEMA IF EXISTS lq_tts_web_cli_smoke CASCADE'
```

Expected: `profiles 0` then `exit 0` (the entry point loads the config, migrates the throwaway schema and answers); the schema is dropped afterwards.

- [ ] **Step 9: Commit**

```bash
git add web/server/cli/profile-meta.js web/server/cli/profile-add.js web/server/cli/profiles/pandji.json web/server/services/jobs-repo.js web/server/test/profile-add.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: profile-add admin CLI and Pandji profile metadata"
```

---

### Task 4: Voices page "VO Profile" section

Before the first UI edit: load the SOP G4 skills listed in Global Constraints (impeccable Operate mode, `craft-floor.md` right before editing).

**Files:**
- Modify: `web/client/src/lib/api.js` (inside `export const api = {...}`)
- Modify: `web/client/src/lib/types.js`
- Create: `web/client/src/components/VoiceProfiles.jsx`
- Modify: `web/client/src/pages/VoicesPage.jsx`
- Modify: `web/client/src/i18n/id.js`, `web/client/src/i18n/en.js`
- Test: `web/client/src/pages/VoicesPage.test.jsx`

**Interfaces:**
- Consumes: `GET /api/voice-profiles` answering `VoiceProfile[]` (Task 2); `useResource(fetcher, deps)` → `{data, error, loading, reload, setData}`; `PlayButton({src, label, testId})`; `VoiceStatus({status})`; `StatusChip`, `Notice`, `Button`, `Skeleton`, `buttonClass` from `components/ui.jsx`.
- Produces:
  - `api.voiceProfiles(): Promise<VoiceProfile[]>` in `lib/api.js`.
  - `ProfileSection({ profiles })` (named export of `components/VoiceProfiles.jsx`), `profiles` = a `useResource` result; renders nothing when no profile is shown; cards carry `data-testid="profile-card"` and `data-status="<status|unknown>"`; the use action is a link named "Pakai suara ini" / "Use this voice" to `/?voice=<id>`.
  - i18n keys used by Task 5: `profiles.title` ("VO Profile"), `voices.mine` ("Suara saya" / "My voices").

- [ ] **Step 1: Add the dictionary keys**

In `web/client/src/i18n/id.js`, insert after the line `  'voices.form.success': 'Suara sedang diproses. Biasanya selesai dalam satu menit.',`:

```js
  'voices.mine': 'Suara saya',

  'profiles.title': 'VO Profile',
  'profiles.subtitle': 'Suara siap pakai untuk semua akun. Tidak dihitung dalam batas suara paket kamu.',
  'profiles.tags': 'Ciri suara',
  'profiles.best_for': 'Cocok untuk',
  'profiles.use': 'Pakai suara ini',
  'profiles.status_unknown': 'Status suara belum terbaca karena mesin suara tidak dapat dihubungi. Contoh suara bisa diputar lagi nanti.',
```

In `web/client/src/i18n/en.js`, insert after the line `  'voices.form.success': 'Your voice is processing. It usually takes about a minute.',`:

```js
  'voices.mine': 'My voices',

  'profiles.title': 'VO Profile',
  'profiles.subtitle': 'Ready-made voices for every account. They do not count toward your plan\'s voice limit.',
  'profiles.tags': 'Voice traits',
  'profiles.best_for': 'Good for',
  'profiles.use': 'Use this voice',
  'profiles.status_unknown': 'Voice status unavailable because the voice engine cannot be reached. The preview plays again later.',
```

- [ ] **Step 2: Write the failing tests**

In `web/client/src/pages/VoicesPage.test.jsx`:

Replace the `vi.mock` return line

```js
  return { ...mod, api: { voices: vi.fn(), deleteVoice: vi.fn(), me: vi.fn() }, createVoice: vi.fn() };
```

with

```js
  return { ...mod, api: { voices: vi.fn(), voiceProfiles: vi.fn(), deleteVoice: vi.fn(), me: vi.fn() }, createVoice: vi.fn() };
```

Add after the `const routes = ...` line:

```js
const profile = (over) => ({
  id: 'p1', slug: 'pandji', name: 'Pandji', gender: 'male', language: 'id', status: 'ready', errorCode: null,
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }, { id: 'Tegas', en: 'Firm' }],
  bestFor: { id: 'Narasi, podcast.', en: 'Narration, podcasts.' },
  previewUrl: '/api/voices/p1/preview',
  ...over,
});
```

Replace the `beforeEach` body with:

```js
beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
  api.voiceProfiles.mockResolvedValue([]);
});
```

Append inside `describe('VoicesPage', ...)` (before its closing `});`):

```js
  it('shows VO Profile cards above my voices, without delete and outside the limit', async () => {
    api.voices.mockResolvedValue([voice({ id: 'v1', name: 'Suara Ana' })]);
    api.voiceProfiles.mockResolvedValue([profile(), profile({ id: 'p2', name: 'Gagal', status: 'failed' })]);
    renderRoutes(routes, { path: '/voices' });
    const card = await screen.findByTestId('profile-card');
    expect(screen.getAllByTestId('profile-card')).toHaveLength(1);
    expect(card).toHaveAttribute('data-status', 'ready');
    expect(within(card).getByText('Pandji')).toBeInTheDocument();
    expect(within(card).getByText('Pria, bariton hangat.')).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Ciri suara' })).toHaveTextContent('PriaTegas');
    expect(within(card).getByText('Cocok untuk')).toBeInTheDocument();
    expect(within(card).getByText('Narasi, podcast.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Pakai suara ini' })).toHaveAttribute('href', '/?voice=p1');
    expect(within(card).getByRole('button', { name: 'Dengarkan contoh Pandji' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: /Hapus/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)).toEqual(['VO Profile', 'Suara saya']);
    expect(screen.getByText('1 dari 3 suara terpakai')).toBeInTheDocument();
  });

  it('shows the profile card in English', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile()]);
    renderRoutes(routes, { path: '/voices', lang: 'en', me: { ...ME, lang: 'en' } });
    const card = await screen.findByTestId('profile-card');
    expect(within(card).getByText('Male, warm baritone.')).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Voice traits' })).toHaveTextContent('MaleFirm');
    expect(within(card).getByText('Good for')).toBeInTheDocument();
    expect(within(card).getByText('Narration, podcasts.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Use this voice' })).toHaveAttribute('href', '/?voice=p1');
    expect(screen.getByRole('heading', { level: 2, name: 'My voices' })).toBeInTheDocument();
  });

  it('marks a processing profile and one whose status is unknown, with preview and use disabled', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile({ id: 'p1', name: 'Proses', status: 'processing' }), profile({ id: 'p2', name: 'Luring', status: null })]);
    renderRoutes(routes, { path: '/voices' });
    await screen.findAllByTestId('profile-card');
    const [busy, offline] = screen.getAllByTestId('profile-card');
    expect(within(busy).getByText('Diproses')).toBeInTheDocument();
    expect(within(busy).getByRole('button', { name: 'Dengarkan contoh Proses' })).toBeDisabled();
    expect(within(busy).getByRole('button', { name: 'Pakai suara ini' })).toBeDisabled();
    expect(offline).toHaveAttribute('data-status', 'unknown');
    expect(within(offline).getByText(/^Status suara belum terbaca/)).toBeInTheDocument();
    expect(within(offline).getByRole('button', { name: 'Dengarkan contoh Luring' })).toBeDisabled();
  });

  it('hides the section when there is no profile to show', async () => {
    api.voices.mockResolvedValue([voice({ id: 'v1', name: 'Suara Ana' })]);
    api.voiceProfiles.mockResolvedValue([profile({ status: 'failed' })]);
    renderRoutes(routes, { path: '/voices' });
    await screen.findByText('Suara Ana');
    expect(screen.queryByRole('heading', { name: 'VO Profile' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-card')).not.toBeInTheDocument();
  });

  it('offers a retry when the profiles cannot load', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockRejectedValueOnce(new ApiError(503, 'engine_unavailable', '')).mockResolvedValue([profile()]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    expect(await screen.findByText('Mesin suara sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByTestId('profile-card')).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS/web/client && npx vitest run src/pages/VoicesPage.test.jsx src/i18n`
Expected: the five new VoicesPage tests FAIL (no `profile-card`, no "Suara saya" heading); the existing tests and `src/i18n` PASS.

- [ ] **Step 4: Add the API call and type**

In `web/client/src/lib/api.js`, add the typedef import below the `Voice` one and the method right after `voices: () => request('/voices'),`:

```js
/** @typedef {import('./types.js').VoiceProfile} VoiceProfile */
```

```js
  /** Active VO Profiles; `status` is null while the engine cannot be reached. @returns {Promise<VoiceProfile[]>} */
  voiceProfiles: () => request('/voice-profiles'),
```

In `web/client/src/lib/types.js`, add after the `Voice` typedef line:

```js
/** VO Profile (library voice usable by every account). `status` is null when the engine is unreachable. @typedef {{id:string, slug:string, name:string, gender:'male'|'female'|'neutral', language:'id'|'en', status:'processing'|'ready'|'failed'|null, errorCode:string|null, description:{id:string, en:string}, tags:Array<{id:string, en:string}>, bestFor:{id:string, en:string}, previewUrl:string}} VoiceProfile */
```

- [ ] **Step 5: Write the section component**

Create `web/client/src/components/VoiceProfiles.jsx`:

```jsx
import { Link } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { errorText } from '../lib/errors.js';
import PlayButton from './PlayButton.jsx';
import { VoiceStatus } from './status.jsx';
import { Button, Notice, Skeleton, StatusChip, buttonClass } from './ui.jsx';

const localized = (pair, lang) => pair?.[lang] ?? pair?.id ?? '';

function Heading() {
  const { t } = useI18n();
  return (
    <div>
      <h2 id="profiles-heading" className="text-lg font-semibold text-ink">{t('profiles.title')}</h2>
      <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{t('profiles.subtitle')}</p>
    </div>
  );
}

/** Voices page section (spec §3): one card per profile; failed profiles are hidden, no delete control. */
export function ProfileSection({ profiles }) {
  const { t } = useI18n();
  if (profiles.data === undefined && !profiles.error) {
    return (
      <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
        <Heading />
        <Skeleton className="h-[220px]" />
      </section>
    );
  }
  if (profiles.data === undefined) {
    return (
      <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
        <Heading />
        <Notice tone="danger" action={<Button size="sm" onClick={profiles.reload}>{t('common.retry')}</Button>}>{errorText(t, profiles.error)}</Notice>
      </section>
    );
  }
  const shown = profiles.data.filter((p) => p.status !== 'failed');
  if (!shown.length) return null;
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
      <Heading />
      <ul className="grid gap-3 lg:grid-cols-2">
        {shown.map((p) => <ProfileCard key={p.id} profile={p} />)}
      </ul>
    </section>
  );
}

function ProfileCard({ profile }) {
  const { t, lang } = useI18n();
  const ready = profile.status === 'ready';
  const nameId = `profile-name-${profile.id}`;
  return (
    <li data-testid="profile-card" data-status={profile.status ?? 'unknown'} className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-4 md:p-5">
      <div className="flex items-start gap-3">
        <PlayButton src={ready ? profile.previewUrl : null} label={t('voices.preview', { name: profile.name })} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span id={nameId} className="text-base font-semibold text-ink">{profile.name}</span>
            {profile.status === 'processing' ? <VoiceStatus status="processing" /> : null}
          </p>
          <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{localized(profile.description, lang)}</p>
          {profile.status === null ? <p className="mt-1 text-sm text-dim">{t('profiles.status_unknown')}</p> : null}
        </div>
      </div>
      <ul aria-label={t('profiles.tags')} className="flex flex-wrap gap-1.5">
        {profile.tags.map((tag) => <li key={tag.en}><StatusChip>{localized(tag, lang)}</StatusChip></li>)}
      </ul>
      <div className="text-sm leading-relaxed">
        <p className="font-medium text-ink">{t('profiles.best_for')}</p>
        <p className="text-muted">{localized(profile.bestFor, lang)}</p>
      </div>
      <div>
        {ready
          ? <Link to={`/?voice=${encodeURIComponent(profile.id)}`} aria-describedby={nameId} className={buttonClass('secondary', 'sm')}>{t('profiles.use')}</Link>
          : <Button size="sm" disabled aria-describedby={nameId}>{t('profiles.use')}</Button>}
      </div>
    </li>
  );
}
```

- [ ] **Step 6: Place the section on the Voices page**

In `web/client/src/pages/VoicesPage.jsx`:

Add the import after the `PlayButton` import:

```js
import { ProfileSection } from '../components/VoiceProfiles.jsx';
```

Add the resource right after `const voices = useResource(() => api.voices(), []);`:

```js
  const profiles = useResource(() => api.voiceProfiles(), []);
```

Replace the whole `return (...)` of `VoicesPage` (from `  return (` through the matching `  );` before `}` and `function VoiceList`) with:

```jsx
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('voices.title')}
        subtitle={loaded || voices.error ? t('voices.usage', { count: usedLabel, limit: formatNumber(limit, lang) }) : null}
        actions={formOpen ? null : (
          <Button ref={cloneButtonRef} variant="primary" icon={PlusIcon} disabled={!loaded || atLimit} onClick={() => { followClone.current = false; setFormOpen(true); setCreated(false); }}>
            {t('voices.clone')}
          </Button>
        )}
      />
      <ProfileSection profiles={profiles} />
      <section aria-labelledby="my-voices-heading" className="flex flex-col gap-4">
        <h2 id="my-voices-heading" className="text-lg font-semibold text-ink">{t('voices.mine')}</h2>
        {atLimit ? (
          <div ref={limitRef} tabIndex={-1} className="rounded-control outline-none">
            <Notice
              tone="warning"
              testId="voice-limit"
              action={me?.paid ? null : <a className={buttonClass('secondary', 'sm')} href={me?.topupUrl} target="_blank" rel="noreferrer">{t('voices.upgrade')}</a>}
            >
              {t('voices.limit', { limit: formatNumber(limit, lang) })}
            </Notice>
          </div>
        ) : null}
        {created && processing ? <Notice tone="success">{t('voices.form.success')}</Notice> : null}
        {formOpen ? <CloneVoiceForm onCancel={closeForm} onCreated={onCreated} onLimitReached={refreshAll} onAborted={refreshAll} onAnnounce={setAnnouncement} /> : null}
        <p className="sr-only" aria-live="polite" data-testid="upload-live">{announcement}</p>
        <VoiceList
          voices={voices}
          onDeleted={(id) => {
            setData((items) => items?.filter((v) => v.id !== id));
            reload();
            session.refresh();
          }}
        />
      </section>
    </div>
  );
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/pages/VoicesPage.test.jsx src/i18n`
Expected: PASS, all VoicesPage tests (20 existing + 5 new) and the i18n suite.

Run: `npx vitest run`
Expected: every client test file passes (TtsPage tests still pass: they do not touch `api.voiceProfiles` until Task 5).

- [ ] **Step 8: Commit**

```bash
git add web/client/src/lib/api.js web/client/src/lib/types.js web/client/src/components/VoiceProfiles.jsx web/client/src/pages/VoicesPage.jsx web/client/src/pages/VoicesPage.test.jsx web/client/src/i18n/id.js web/client/src/i18n/en.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: VO Profile section on the Voices page"
```

---

### Task 5: composer picker with profiles

Before the first UI edit: load the SOP G4 skills listed in Global Constraints.

**Files:**
- Modify: `web/client/src/lib/voices.js`, `web/client/src/lib/voices.test.js`
- Modify: `web/client/src/pages/TtsPage.jsx` (everything above `function RangeField`)
- Modify: `web/client/src/pages/TtsPage.test.jsx`
- Modify: `web/client/src/i18n/id.js`, `web/client/src/i18n/en.js`

**Interfaces:**
- Consumes: `api.voiceProfiles()`, i18n keys `profiles.title`, `voices.mine` (Task 4); `loadDraft/saveDraft` (draft key `lqtts_draft:<userId>`).
- Produces:
  - `pickVoice({ requested: string|null, saved: string, mine: Array<{id}>, profiles: Array<{id}> }): string` in `lib/voices.js`: `requested` if usable, else `saved` if usable, else `mine[0].id`, else `profiles[0].id`, else `''`; usable = present in `mine` or `profiles` (both already filtered to `ready`).
  - Composer behaviour: optgroups in this order: "VO Profile" (ready profiles), "Suara saya" (my ready voices); `?voice=<id>` becomes the draft's voice once both lists are known and is then removed from the URL; a 404 `not_found` on create reloads voices and profiles and shows `tts.voice_gone`.

- [ ] **Step 1: Add the dictionary key**

In `web/client/src/i18n/id.js`, insert after `  'tts.voice_create': 'Kloning suara',`:

```js
  'tts.voice_gone': 'Suara ini sudah tidak tersedia. Pilih suara lain.',
```

In `web/client/src/i18n/en.js`, insert after `  'tts.voice_create': 'Clone a voice',`:

```js
  'tts.voice_gone': 'This voice is no longer available. Choose another voice.',
```

- [ ] **Step 2: Write the failing tests**

In `web/client/src/lib/voices.test.js`, change the import line to

```js
import { MAX_AUDIO_BYTES, audioFileProblem, countsTowardLimit, pickVoice } from './voices.js';
```

and append:

```js
describe('pickVoice', () => {
  const mine = [{ id: 'v1' }, { id: 'v2' }];
  const profiles = [{ id: 'p1' }];
  it('follows ?voice=, then the draft voice, then my first voice, then the first profile (spec §3)', () => {
    expect(pickVoice({ requested: 'p1', saved: 'v2', mine, profiles })).toBe('p1');
    expect(pickVoice({ requested: 'gone', saved: 'v2', mine, profiles })).toBe('v2');
    expect(pickVoice({ requested: null, saved: 'gone', mine, profiles })).toBe('v1');
    expect(pickVoice({ requested: null, saved: '', mine: [], profiles })).toBe('p1');
    expect(pickVoice({ requested: null, saved: '', mine: [], profiles: [] })).toBe('');
  });
});
```

In `web/client/src/pages/TtsPage.test.jsx`:

Replace the `vi.mock` return line with

```js
  return { ...mod, api: { voices: vi.fn(), voiceProfiles: vi.fn(), estimate: vi.fn(), createJob: vi.fn(), me: vi.fn() } };
```

Add after the `const SCRIPT_150 = ...` line:

```js
const profile = (over) => ({
  id: 'p1', slug: 'pandji', name: 'Pandji VO', gender: 'male', language: 'id', status: 'ready', errorCode: null,
  description: { id: 'Pria.', en: 'Male.' }, tags: [{ id: 'Pria', en: 'Male' }], bestFor: { id: 'Narasi.', en: 'Narration.' },
  previewUrl: '/api/voices/p1/preview', ...over,
});
const groups = () => [...screen.getByTestId('voice-select').querySelectorAll('optgroup')]
  .map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]);
```

In `beforeEach`, add after `api.voices.mockResolvedValue([ready]);`:

```js
  api.voiceProfiles.mockResolvedValue([]);
```

Append inside `describe('TtsPage', ...)` (before its closing `});`):

```js
  it('groups ready VO Profiles and my ready voices and selects my first voice', async () => {
    api.voices.mockResolvedValue([ready, { ...ready, id: 'v2', name: 'Draf', status: 'processing' }]);
    api.voiceProfiles.mockResolvedValue([profile(), profile({ id: 'p2', name: 'Raka', status: 'processing' }), profile({ id: 'p3', name: 'Luring', status: null })]);
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji VO' });
    expect(groups()).toEqual([['VO Profile', ['Pandji VO']], ['Suara saya', ['Pandji']]]);
    expect(screen.getByTestId('voice-select')).toHaveValue('v1');
  });

  it('offers the first ready profile when I have no ready voice of my own', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile()]);
    api.createJob.mockResolvedValue({ id: 'j1', credits: 1, estimatedSeconds: 5 });
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji VO' });
    expect(screen.queryByText('Kloning suara dulu')).not.toBeInTheDocument();
    expect(groups()).toEqual([['VO Profile', ['Pandji VO']]]);
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(api.createJob).toHaveBeenCalledWith('p1', 'Halo semua.', expect.any(Object));
  });

  it('selects the voice from ?voice=, keeps it in the draft and drops it from the URL', async () => {
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: '', voiceId: 'v1', settings: {} }));
    api.voiceProfiles.mockResolvedValue([profile()]);
    const { router } = renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Pandji VO' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByTestId('voice-select')).toHaveValue('p1');
    expect(JSON.parse(window.localStorage.getItem('lqtts_draft:u1')).voiceId).toBe('p1');
  });

  it('ignores an unusable ?voice= and keeps the draft voice', async () => {
    api.voices.mockResolvedValue([ready, { ...ready, id: 'v2', name: 'Kedua' }]);
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: '', voiceId: 'v2', settings: {} }));
    api.voiceProfiles.mockResolvedValue([profile({ status: 'processing' })]);
    const { router } = renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Kedua' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByTestId('voice-select')).toHaveValue('v2');
  });

  it('reloads voices and profiles and explains when the chosen profile was turned off (404)', async () => {
    api.voiceProfiles.mockResolvedValueOnce([profile()]).mockResolvedValue([]);
    api.createJob.mockRejectedValue(new ApiError(404, 'not_found', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Pandji VO' });
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('p1'));
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Suara ini sudah tidak tersedia. Pilih suara lain.')).toBeInTheDocument();
    expect(api.voiceProfiles).toHaveBeenCalledTimes(2);
    expect(api.voices).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('v1'));
    expect(screen.queryByRole('option', { name: 'Pandji VO' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/voices.test.js src/pages/TtsPage.test.jsx`
Expected: FAIL. `pickVoice` is not exported; the five new TtsPage tests fail (no optgroups, profiles never fetched); the existing TtsPage tests pass.

- [ ] **Step 4: Add `pickVoice`**

Append to `web/client/src/lib/voices.js`:

```js
/**
 * Composer default (spec §3): `?voice=` (if usable), then the draft's voice (if still usable), then my first ready
 * voice, then the first ready profile. `mine` and `profiles` hold ready voices only.
 */
export function pickVoice({ requested, saved, mine, profiles }) {
  const usable = (id) => Boolean(id) && (mine.some((v) => v.id === id) || profiles.some((p) => p.id === id));
  if (usable(requested)) return requested;
  if (usable(saved)) return saved;
  return mine[0]?.id ?? profiles[0]?.id ?? '';
}
```

- [ ] **Step 5: Update the composer**

In `web/client/src/pages/TtsPage.jsx`, replace everything above `function RangeField(` (lines 1 to 183 today) with:

```jsx
import { UserSoundIcon, WaveformIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { Button, EmptyState, Field, Notice, PageHeader, Select, Skeleton, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { DEFAULT_SETTINGS, FORMATS, MAX_SCRIPT_CHARS, loadDraft, normalizeSettings, saveDraft } from '../lib/draft.js';
import { errorText } from '../lib/errors.js';
import { charCount, creditsFor, formatNumber, rupiahFor } from '../lib/pricing.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';
import { pickVoice } from '../lib/voices.js';

const answered = (resource) => resource.data !== undefined || resource.error !== null;

export default function TtsPage() {
  const { t, tn, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const navigate = useNavigate();
  const { health } = useOutletContext() ?? {};
  const voices = useResource(() => api.voices(), []);
  const profiles = useResource(() => api.voiceProfiles(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('voice');
  const [draft, setDraft] = useState(() => loadDraft(me.id));
  const [estimate, setEstimate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [balanceTick, setBalanceTick] = useState(0);

  useEffect(() => {
    saveDraft(me.id, draft);
  }, [me.id, draft]);

  const trimmed = draft.text.trim();
  const chars = charCount(trimmed);
  const tooLong = chars > MAX_SCRIPT_CHARS;

  useEffect(() => {
    if (!trimmed || tooLong) {
      setEstimate(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await api.estimate(trimmed, controller.signal);
        setEstimate({ ...result, forText: trimmed });
      } catch (err) {
        if (err?.name !== 'AbortError') setEstimate(null);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, tooLong, balanceTick]);

  const { refresh } = session;
  const recheckBalance = useCallback(() => {
    refresh();
    setBalanceTick((n) => n + 1);
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheckBalance();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [recheckBalance]);

  const mine = (voices.data ?? []).filter((v) => v.status === 'ready');
  const library = (profiles.data ?? []).filter((p) => p.status === 'ready');
  const settled = answered(voices) && answered(profiles);
  const requestedUsable = requested !== null && (mine.some((v) => v.id === requested) || library.some((p) => p.id === requested));

  // A profile card links here with ?voice=<id>. Once both lists are known it becomes the draft's voice (when usable)
  // and leaves the URL, so a later pick in the select is never overridden by the link.
  useEffect(() => {
    if (requested === null || !settled) return;
    if (requestedUsable) setDraft((d) => ({ ...d, voiceId: requested }));
    setSearchParams((params) => {
      params.delete('voice');
      return params;
    }, { replace: true });
  }, [requested, requestedUsable, settled, setSearchParams]);

  const voiceId = pickVoice({ requested, saved: draft.voiceId, mine, profiles: library });
  const fresh = estimate !== null && estimate.forText === trimmed;
  const credits = fresh ? estimate.credits : creditsFor(chars);
  const balance = fresh && estimate.balance != null ? estimate.balance : (me.balance ?? null);
  const short = chars > 0 && balance !== null && credits > balance;
  const lqsDown = health?.lqstudio === 'down';
  const noFormats = draft.settings.formats.length === 0;
  const canGenerate = chars > 0 && !tooLong && voiceId !== '' && !noFormats && !short && !lqsDown && !submitting;
  const update = (patch) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setSetting = (key, value) => update({ settings: { ...draft.settings, [key]: value } });

  async function generate() {
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob(voiceId, trimmed, normalizeSettings(draft.settings));
      session.refresh();
      navigate(`/jobs/${job.id}`, { state: { estimatedSeconds: job.estimatedSeconds } });
    } catch (err) {
      setError(err);
      setSubmitting(false);
      if (err?.code === 'voice_not_ready') voices.reload();
      // A profile turned off since this page loaded (or a voice deleted elsewhere): re-read both lists.
      if (err?.code === 'not_found') {
        voices.reload();
        profiles.reload();
      }
      if (err?.code === 'insufficient_credits') recheckBalance();
    }
  }

  const topUp = <a className={buttonClass('primary', 'sm')} href={me.topupUrl} target="_blank" rel="noreferrer">{t('common.topup')}</a>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('tts.title')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-8">
        <section className="flex flex-col gap-2">
          <label htmlFor="script" className="text-sm font-medium text-ink">{t('tts.script')}</label>
          <textarea
            id="script"
            data-testid="script"
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            placeholder={t('tts.script_placeholder')}
            spellCheck
            aria-invalid={tooLong || undefined}
            aria-describedby="script-help script-count"
            className="min-h-[22rem] w-full resize-y rounded-panel border border-line bg-surface p-4 text-base leading-relaxed text-ink placeholder:text-dim transition-colors duration-150 hover:border-dim focus-visible:border-accent aria-[invalid=true]:border-danger"
          />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <p id="script-help" className="max-w-[65ch] leading-relaxed text-dim">{t('tts.script_help')}</p>
            <p id="script-count" className={`font-mono tabular ${tooLong ? 'text-danger' : 'text-muted'}`}>
              {t('tts.chars', { count: formatNumber(chars, lang), max: formatNumber(MAX_SCRIPT_CHARS, lang) })}
              {fresh && estimate.sentences > 0 ? ` · ${tn('tts.sentences', estimate.sentences, { count: formatNumber(estimate.sentences, lang) })}` : ''}
            </p>
          </div>
          {tooLong ? <p className="text-sm text-danger" role="alert">{t('tts.text_too_long')}</p> : null}
        </section>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-20">
          <VoicePicker voices={voices} settled={settled} mine={mine} library={library} value={voiceId} onChange={(id) => update({ voiceId: id })} />
          <SettingsPanel settings={draft.settings} onSet={setSetting} onReset={() => update({ settings: normalizeSettings(DEFAULT_SETTINGS) })} noFormats={noFormats} />
          <section className="flex flex-col gap-3">
            <div className="text-sm" aria-live="polite" aria-atomic="true">
              <p data-testid="price" className="font-medium text-ink">
                {chars > 0
                  ? tn('tts.price', credits, { credits: formatNumber(credits, lang), rupiah: formatNumber(rupiahFor(credits), lang) })
                  : t('tts.price_empty')}
              </p>
              <p data-testid="balance" className="mt-0.5 text-muted">
                {balance === null
                  ? <>{tn('tts.balance', 2, { balance: '–' })}<span className="mt-0.5 block text-dim">{t('tts.balance_unknown')}</span></>
                  : tn('tts.balance', balance, { balance: formatNumber(balance, lang) })}
              </p>
            </div>
            {short ? <Notice tone="warning" action={topUp}>{t('tts.topup_needed')}</Notice> : null}
            {error && !short ? (
              error.code === 'insufficient_credits'
                ? <Notice tone="warning" action={topUp}>{errorText(t, error)}</Notice>
                : <Notice tone="danger">{error.code === 'not_found' ? t('tts.voice_gone') : errorText(t, error)}</Notice>
            ) : null}
            {lqsDown ? <Notice tone="warning">{t('tts.lqstudio_down')}</Notice> : null}
            <Button variant="primary" size="lg" icon={WaveformIcon} loading={submitting} disabled={!canGenerate} onClick={generate} data-testid="generate" className="w-full">
              {submitting ? t('tts.generating') : t('tts.generate')}
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VoicePicker({ voices, settled, mine, library, value, onChange }) {
  const { t } = useI18n();
  if (!settled) return <Skeleton className="h-[72px]" />;
  if (voices.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={voices.reload}>{t('common.retry')}</Button>}>{errorText(t, voices.error)}</Notice>;
  }
  if (!mine.length && !library.length) {
    return (
      <EmptyState
        icon={UserSoundIcon}
        title={t('tts.empty_voices_title')}
        body={t('tts.empty_voices_body')}
        action={<Link to="/voices" className={buttonClass('primary')}>{t('tts.voice_create')}</Link>}
      />
    );
  }
  return (
    <Field id="voice" label={t('tts.voice')}>
      <Select id="voice" data-testid="voice-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {library.length ? (
          <optgroup label={t('profiles.title')}>
            {library.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
        ) : null}
        {mine.length ? (
          <optgroup label={t('voices.mine')}>
            {mine.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/voices.test.js src/pages/TtsPage.test.jsx src/i18n`
Expected: PASS (all existing TtsPage tests plus the five new ones, `pickVoice`, and the i18n suite).

Run: `npx vitest run`
Expected: every client test file passes.

Run: `npm run build`
Expected: `vite` prints `built in` and exits 0.

- [ ] **Step 7: Commit**

```bash
git add web/client/src/lib/voices.js web/client/src/lib/voices.test.js web/client/src/pages/TtsPage.jsx web/client/src/pages/TtsPage.test.jsx web/client/src/i18n/id.js web/client/src/i18n/en.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: composer picks VO Profiles, ?voice= and stale-profile reload"
```

---

### Task 6: end-to-end proof with Pandji

**Files:**
- Modify: `web/e2e/target.mjs:47` (local server start timeout)
- Modify: `web/e2e/harness/run-server.mjs` (whole file below)
- Modify: `web/e2e/tests/journey.spec.js`
- Modify: `web/e2e/tests/screens.spec.js`

**Interfaces:**
- Consumes: the CLI invocation `node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename <name>` with audio on stdin (Task 3); `SAMPLE_AUDIO` (`data/fixtures/pandji/ref.wav`, a 14.25 s clip cut from the Pandji recording) from `target.mjs`; profile card `data-testid="profile-card"`, link "Pakai suara ini", preview "Dengarkan contoh Pandji" (Task 4); composer `?voice=` adoption (Task 5).
- Produces: local target seeds the Pandji profile (owner_ref `library`, engine caller `lq-tts-stg`, schema `lq_tts_web_e2e`) before the server starts and removes exactly that engine voice (by recorded id) on exit; the journey makes one short voiceover with Pandji on local AND staging; the screens include the Voices page with the Pandji card. On `staging-public` the profile is the one created at release (see Release section); nothing in the e2e code creates profiles there.

- [ ] **Step 1: Give the local server time to seed**

In `web/e2e/target.mjs` line 47, change `timeout: 90_000` to `timeout: 420_000` in the `run-server.mjs` webServer entry (the profile voice must finish processing before the server starts):

```js
        { command: 'node harness/run-server.mjs', url: `http://127.0.0.1:${LOCAL_PORT}/api/health`, reuseExistingServer: false, timeout: 420_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 } },
```

- [ ] **Step 2: Seed the profile in the local harness**

Replace `web/e2e/harness/run-server.mjs` with:

```js
// Runs the real plan-2B server natively for Playwright: real engine (caller lq-tts-stg) and real Postgres
// (throwaway schema lq_tts_web_e2e, dropped first), fake LQ-Studio. Secrets are read from web/.env.stg and never printed.
// Before the server starts, the VO Profile CLI seeds the Pandji profile from the short fixture clip.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEnvFile, toHostDatabaseUrl } from '../../ops/env-lib.mjs';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_PORT, LOCAL_USERS, SAMPLE_AUDIO } from '../target.mjs';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const base = readEnvFile(fileURLToPath(new URL('../../.env.stg', import.meta.url)));
for (const key of ['DATABASE_URL', 'ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
  if (!base[key]) throw new Error(`web/.env.stg lacks ${key} (plan 2B setup)`);
}

const SCHEMA = 'lq_tts_web_e2e';
const PSQL = '/opt/homebrew/opt/postgresql@16/bin/psql';
const dropSchema = () => execFileSync(PSQL, ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-qc', `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`], { stdio: 'inherit' });

const ENGINE_URL = 'http://127.0.0.1:8740';
const engineHeaders = { Authorization: `Bearer ${base.ENGINE_TOKEN}` };

async function deleteEngineVoice(id, label) {
  const del = await fetch(`${ENGINE_URL}/v1/voices/${id}`, { method: 'DELETE', headers: engineHeaders });
  process.stdout.write(`e2e cleanup: ${label} ${id} -> ${del.status}\n`);
}

// The engine is shared: voices of the fake users (and their jobs, engine cascade) never outlive a run.
async function purgeEngineVoices() {
  for (const user of LOCAL_USERS) {
    const res = await fetch(`${ENGINE_URL}/v1/voices?owner_ref=${encodeURIComponent(user.id)}`, { headers: engineHeaders });
    if (!res.ok) throw new Error(`engine voice list answered ${res.status}`);
    for (const voice of await res.json()) await deleteEngineVoice(voice.id, 'engine voice');
  }
}

// Profile voices are owner_ref "library" under the same engine caller as the staging container, so they are removed
// by the ids this run's schema recorded, never by owner_ref (that would also take staging's Pandji).
function profileVoiceIds() {
  try {
    const out = execFileSync(PSQL, ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-Atqc', `SELECT voice_id FROM ${SCHEMA}.voice_profiles`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return []; // no schema or table yet
  }
}
async function purgeProfileVoices() {
  for (const id of profileVoiceIds()) await deleteEngineVoice(id, 'profile voice');
}

const env = {
  ...process.env,
  ...base,
  HOST: '127.0.0.1',
  PORT: String(LOCAL_PORT),
  DB_SCHEMA: SCHEMA,
  DATABASE_URL: toHostDatabaseUrl(base.DATABASE_URL),
  ENGINE_URL,
  ENGINE_CALLBACK_URL: `http://127.0.0.1:${LOCAL_PORT}/api/internal/engine-callback`,
  LQSTUDIO_URL: `http://127.0.0.1:${FAKE_LQS_PORT}`,
  LQSTUDIO_TOKEN: FAKE_LQS_TOKEN,
  LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
  COOKIE_SECURE: 'false',
  CLIENT_DIST: fileURLToPath(new URL('../../client/dist', import.meta.url)),
};

// The same CLI and metadata the release runs in the container, fed the short fixture clip on stdin.
async function seedProfile() {
  const audio = openSync(SAMPLE_AUDIO, 'r');
  try {
    const cli = spawn(process.execPath, ['server/cli/profile-add.js', '--meta', 'server/cli/profiles/pandji.json', '--filename', 'ref.wav'], {
      cwd: webDir, env, stdio: [audio, 'inherit', 'inherit'],
    });
    const code = await new Promise((resolve) => cli.on('exit', resolve));
    if (code !== 0) throw new Error(`profile-add exited ${code}`);
  } finally {
    closeSync(audio);
  }
}

await purgeProfileVoices(); // leftovers of a run that died before its cleanup
dropSchema();
await purgeEngineVoices();
await seedProfile();

// detached: Playwright signals the whole process group; the server must get exactly one SIGTERM (ours), since a
// second one during shutdown forces exit 1 (shutdown_forced).
const child = spawn(process.execPath, ['server/index.js'], { cwd: webDir, env, stdio: 'inherit', detached: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
// The schema is throwaway: drop it again once the server is gone, after its profile voice left the engine.
child.on('exit', async (code, signal) => {
  process.stderr.write(`e2e server exited code=${code} signal=${signal}\n`);
  try {
    await purgeProfileVoices();
    await purgeEngineVoices();
  } finally {
    dropSchema();
    process.exit(code ?? 0);
  }
});
```

- [ ] **Step 3: Make one voiceover with Pandji in the journey**

In `web/e2e/tests/journey.spec.js`:

Add after the `const NEW_SECOND = ...` line:

```js
const PANDJI_SCRIPT = 'Halo, ini Pandji dari LQ TTS. Suara ini bisa dipakai semua akun.';
```

Rename the test title from `'journey: login with 2FA, clone, generate, live progress, regenerate, download, ID and EN'` to:

```js
test('journey: login with 2FA, VO Profile voiceover, clone, generate, live progress, regenerate, download, ID and EN', async ({ page, guard }) => {
```

Insert right after the leftover cleanup line `  for (const v of before.json.filter((x) => x.name.startsWith('E2E '))) await apiCall(page, 'DELETE', `/voices/${v.id}`);`:

```js

  // 1b. VO Profile: the Pandji card is on the Voices page, previews, and makes one short voiceover at the normal price
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'VO Profile', exact: true })).toBeVisible();
  const pandjiCard = page.getByTestId('profile-card').filter({ hasText: 'Pandji' });
  await expect(pandjiCard).toHaveAttribute('data-status', 'ready');
  await expect(pandjiCard.getByRole('button', { name: /^Hapus/ })).toHaveCount(0);
  const pandjiPreview = pandjiCard.getByRole('button', { name: 'Dengarkan contoh Pandji', exact: true });
  await pandjiPreview.click();
  await expect(pandjiPreview).toHaveAttribute('aria-pressed', 'true');
  await pandjiPreview.click();
  await expect(pandjiPreview).toHaveAttribute('aria-pressed', 'false');
  await pandjiCard.getByRole('link', { name: 'Pakai suara ini', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/); // ?voice= was adopted into the draft and dropped from the URL
  await expect(page.getByLabel('Suara', { exact: true }).locator('option:checked')).toHaveText('Pandji');
  await page.getByLabel('Naskah', { exact: true }).fill(PANDJI_SCRIPT);
  await expect(page.getByTestId('price')).toHaveText('Sekitar 1 kredit (Rp100)');
  await page.getByTestId('generate').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const pandjiJobId = new URL(page.url()).pathname.split('/').pop();
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 300_000 });
  await expect(page.getByText('Pandji', { exact: true }).first()).toBeVisible();
  // Leave the job page before deleting it, so nothing on screen asks for a job that is gone.
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Suara', exact: true })).toBeVisible();
  const pandjiJobDeleted = await apiCall(page, 'DELETE', `/jobs/${pandjiJobId}`);
  expect(pandjiJobDeleted.status).toBe(204);
```

- [ ] **Step 4: Show the card on the Voices screen**

In `web/e2e/tests/screens.spec.js`, inside the `for (const [name, path, heading] of screens)` loop, insert right after the line `      if (name === 'tts') await expect(page.getByTestId('generate')).toBeEnabled();`:

```js
      if (name === 'voices') await expect(page.getByTestId('profile-card').filter({ hasText: 'Pandji' })).toHaveAttribute('data-status', 'ready');
```

- [ ] **Step 5: Run every local suite, then the local Playwright gate**

Run: `npm test 2>&1 | grep -E '^ *(Test Files|Tests) '`
Expected: all server files pass.

Run: `cd client && npx vitest run && npm run build && cd ..`
Expected: all client files pass; build exits 0.

Run: `cd e2e && npx playwright test --project=journey --project=screens --project=smoke 2>&1 | tail -15; cd ..`
Expected: `5 passed`. The run-server output shows `voice <id> processing`, `voice <id> ready`, `profile pandji active voice <id>` before the server listens, and `e2e cleanup: profile voice <id> -> 204` on exit.

Then confirm nothing of the run is left: `/opt/homebrew/opt/postgresql@16/bin/psql -d lq_tts -Atc "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'lq_tts_web_e2e'"`
Expected: `0`.

- [ ] **Step 6: Look at the screenshots (SOP G5)**

Open `web/e2e/artifacts/390/voices.png`, `web/e2e/artifacts/768/voices.png`, `web/e2e/artifacts/1440/voices.png` and `web/e2e/artifacts/1440/tts.png` with the image reader. Expected: the "VO Profile" section sits above "Suara saya", the Pandji card shows name, description, eight tag chips, "Cocok untuk" with its text, the preview button and "Pakai suara ini"; no clipped text or horizontal overflow at 390 px; the composer select shows the grouped list. Fix and re-run Step 5 on any visual defect.

- [ ] **Step 7: Commit**

```bash
git add web/e2e/target.mjs web/e2e/harness/run-server.mjs web/e2e/tests/journey.spec.js web/e2e/tests/screens.spec.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/e2e: seed Pandji locally, voiceover with the VO Profile, card on the Voices screen"
```

---

## Release (controller)

Executed by the controller after Tasks 1 to 6 are merged and reviewed, not by task implementers. Commands run on mac-studio in `~/Developer/LQ-TTS/web` with the PATH export from Global Constraints. The PROD rollback image stays available at every step (`lq-tts-web:prod-prev`); migration 006 only adds a table, so the previous image runs fine on the migrated schema.

1. Build the staging image from the committed tree and recreate staging:
   ```bash
   ops/build-image.sh stg
   docker compose up -d stg
   docker inspect -f '{{.State.Health.Status}}' lq-tts-web-stg   # repeat until: healthy
   ```
2. Create the Pandji profile on staging (full 37 min recording, metadata from the image):
   ```bash
   docker exec -i lq-tts-web-stg node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename VO-Sample-Pandji.mp3 < ~/Developer/LQ-TTS/data/fixtures/pandji/VO-Sample-Pandji.mp3
   docker exec lq-tts-web-stg node server/cli/profile-add.js --list
   ```
   Expected: `voice <id> processing`, `voice <id> ready`, `profile pandji active voice <id>`; then `profiles 1`, `profile pandji voice <id> ready`.
3. Staging gate: open the temporary Cloudflare Access service-token door and run `E2E_TARGET=staging-public npx playwright test --project=journey --project=screens --project=smoke` exactly as plan 2C Task 14 Steps 3 and 4 (`docs/superpowers/plans/2026-10-03-web-2c-client-release.md`), then close the door. Expected: `5 passed`.
4. Promote the same image to PROD:
   ```bash
   docker image inspect lq-tts-web:prod >/dev/null 2>&1 && docker tag lq-tts-web:prod lq-tts-web:prod-prev
   docker tag lq-tts-web:stg lq-tts-web:prod
   docker compose --profile prod up -d prod
   docker image inspect -f '{{.Id}}' lq-tts-web:stg lq-tts-web:prod   # two identical ids
   docker inspect -f '{{.State.Health.Status}}' lq-tts-web-prod      # repeat until: healthy
   ```
5. Create the Pandji profile on PROD:
   ```bash
   docker exec -i lq-tts-web-prod node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename VO-Sample-Pandji.mp3 < ~/Developer/LQ-TTS/data/fixtures/pandji/VO-Sample-Pandji.mp3
   ```
6. Verify on PROD from inside the container (the PROD smoke cannot log in):
   ```bash
   docker exec lq-tts-web-prod node server/cli/profile-add.js --list
   docker exec lq-tts-web-prod node -e "fetch('http://127.0.0.1:8080/api/voice-profiles').then((r) => console.log(r.status))"
   cd e2e && E2E_TARGET=prod npx playwright test --project=smoke; cd ..
   ```
   Expected: `profiles 1` and `profile pandji voice <id> ready` (the same join `GET /api/voice-profiles` serves); `401` (endpoint mounted behind login); smoke `1 passed`.
   Rollback if needed: `docker tag lq-tts-web:prod-prev lq-tts-web:prod && docker compose --profile prod up -d prod`. Hide the profile without a rollback: `docker exec lq-tts-web-prod node server/cli/profile-add.js --deactivate pandji`.
7. Merge `feat/vo-profiles` into `main`, push per SOP G8 (no Claude attribution, verify the remote), and write the brain note with `brain-task.py done ... --bukti` (stg gate 5/5, PROD `--list` ready, smoke 1/1, PROD voice id).
