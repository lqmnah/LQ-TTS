# LQ-TTS Web Server (Express) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/api` server of tts.lq-studio.com: LQ-Studio login (with 2FA), sessions, voices and voiceover jobs proxied to the voice engine, money moved only through LQ-Studio's hold/settle/refund API, a signed engine callback, a reconciliation loop, and static hosting of the built client — runnable as `node server/index.js` for staging and PROD.

**Architecture:** One Express 5 process (ESM, Node 26) in `~/Developer/LQ-TTS/web/server/`. It owns sessions, job history, charges and consent records in Postgres (`lq_tts` database, schema `lq_tts_web_stg` / `lq_tts_web`). The browser only talks to this server; the server talks to the engine (`Authorization: Bearer <caller token>`) and to LQ-Studio's internal TTS API (contract C1) and never exposes either token. Every money move is a `charges` row first, then an LQ-Studio call; a reconciliation loop finishes anything a crash or lost callback left `held`.

**Tech Stack:** Node 26 (ESM), Express 5.2, pg 8.23, busboy 1.6 (streamed multipart), Vitest 5 + supertest 7, Postgres 16 (Homebrew, mac-studio).

**Spec:** `docs/superpowers/specs/2026-10-02-web-app-design.md` (on branch `main`, incl. Amendment A; read with `git show main:docs/superpowers/specs/2026-10-02-web-app-design.md`). Engine contract: `engine/lq_tts_engine/api/app.py`, `engine/lq_tts_engine/callbacks.py`, `engine/lq_tts_engine/schema.sql` on `feat/voice-engine`.

## Global Constraints

- Machine: **mac-studio** only. Every shell step starts with `cd ~/Developer/LQ-TTS/web && export PATH=/opt/homebrew/bin:$PATH` (non-login ssh shells lack `/opt/homebrew/bin`, where `node`, `npm`, `psql`, `pm2`, `ffmpeg` live). Node `v26.0.0`, npm 11.
- Branch: `feat/web-app`, created in Task 1 from `feat/voice-engine` **in place** (`git switch -c`). Never switch the `~/Developer/LQ-TTS` checkout to `main`: pm2 runs the live engine from this checkout and `main` has no `engine/`.
- Commits: author `lqmnah <lqmnah@users.noreply.github.com>` (repo-local config is already set). **No** `Co-Authored-By`, no Claude/Anthropic/AI attribution anywhere. Message prefix `web: `.
- Secrets: never print, `cat`, `grep` or echo any `.env*` file or secret value. Generate secrets with `openssl rand -hex 24` straight into files with mode `600`; load them with `set -a; . ./file; set +a`.
- Do not stop, restart or reconfigure any pm2 app, port or database other than: creating role `lq_tts_web` (Task 1) and restarting only `lq-tts-engine-api` + `lq-tts-engine-worker` (Task 13). No Docker, tunnel or UI work (plan 2C).
- Pricing (verbatim): credits = max(1, ceil(chars / 1000 × 10)) → `CREDITS_PER_1K_CHARS=10`; 1 credit = Rp100 → `RUPIAH_PER_CREDIT=100`; voice limit Free 3 / any paid plan 25 (`VOICE_LIMIT_FREE=3`, `VOICE_LIMIT_PAID=25`); consent version `v1`.
- Limits: text ≤ 20,000 characters per job (verbatim from spec; counted in Unicode code points, like the engine's Python `len`); upload ≤ **95 MB** (`99614720` bytes = 95 × 1024 × 1024; controller ruling 2026-10-03, because Cloudflare caps request bodies at 100 MB — the engine keeps its own 200 MB limit), MP3/WAV/M4A/FLAC.
- Session: random 256-bit id, stored only as SHA-256 hex; cookie `lqtts_sid`, httpOnly, `Secure` (unless `COOKIE_SECURE=false`), SameSite=Lax, 30 days sliding; revocable.
- CSRF: every non-GET/HEAD/OPTIONS `/api` request needs header `X-Requested-With: lq-tts` (except `/api/internal/engine-callback`, which is HMAC-signed).
- Browser error body: `{error:{code, message}}` with codes from contract C2 only, plus `internal_error` (500) for unexpected faults.
- End-user IP = `CF-Connecting-IP`, else the socket address. Never forward any `cf-*` header to LQ-Studio (its guard answers 403).
- Hold refs (opaque strings, agreed with plan 2A): create `tts:<web-generated uuid>:r1` (the same uuid is the engine `Idempotency-Key`); regenerate `tts:<engineJobId>:r<revision>:s<idx>`, and `…:s<idx>:a<n>` for the n-th attempt after a refunded one. A ref is never reused once refunded.
- Tests: `npx vitest run <file>` from `web/`; real Postgres via `TEST_DATABASE_URL` (database `lq_tts_test`, one throwaway schema `t_<hex>` per test file); in-process fake engine and fake LQ-Studio HTTP servers.

### Spec clarifications made while planning (detail, no change to approved behaviour)

1. **Create-hold ref.** The spec wants the hold *before* the engine job exists, so the create ref cannot contain the engine job id: it uses a web-generated uuid that is also sent as `Idempotency-Key`. LQ-Studio treats refs as opaque (`/^tts:[A-Za-z0-9:_-]{1,150}$/`, confirmed by plan 2A).
2. **Regenerate retries.** LQ-Studio's hold is idempotent per ref, so re-using a refunded ref would make the retry free. A retry for the same revision/sentence gets `:a<n>`.
3. **Extra columns** beyond spec §6 "(main)": `sessions.balance`, `sessions.refreshed_at` (the ≤ 5 min plan/balance cache); `jobs.voice_name`, `jobs.audio_seconds` (history list without engine calls); `charges.last_error`, `charges.flagged_at` (manual-review flag).
4. **Ownership.** The engine scopes voices by caller and `owner_ref`, but jobs only by caller. Voice ownership = engine `owner_ref == session user id`; job ownership = `jobs.user_id` in our DB. Every check fails as `404 not_found`.
5. **No callback for queued cancel/delete.** The engine cancels a queued job (or deletes any job) without a callback, so `cancel`/`DELETE` resolve the job's held charges themselves; reconciliation covers the rest.
6. **Charge decision rule** (one function, `decide`): job gone from engine → refund; charge revision < engine revision → settle (that revision finished, regenerate needs `done`); charge revision > engine revision → refund once older than 2 min (engine never got it); same revision → `done` settle, `failed`/`canceled` refund, else wait. A charge without a job row (crash between hold and engine create) → refund once older than 2 min. Callbacks only resolve charges with revision ≤ the callback's revision.
7. **Engine call fails after a successful hold** (any error, incl. network) → refund immediately. Rare orphan: the engine created the job but the response was lost → the job runs unbilled and is invisible to the user (no `jobs` row).
8. **Hold outcome unknown** (LQ-Studio 5xx/timeout) → immediate refund attempt; LQ-Studio answers `404 not_found` when no hold exists for that ref, which we record as refunded. Reconciliation retries if LQ-Studio stays down.
9. **Attempts** count only failed resolution attempts (LQ-Studio or engine unreachable), never "job still running"; at 10 the charge gets `flagged_at` and one `charge_flagged` error log line, and keeps being retried (never auto-forgiven).
10. **Multipart order.** `POST /api/voices` streams the file to the engine, so consent/name/language must arrive **before** the `audio` part (agreed with plan 2C). Audio before consent → `400 consent_required`.
11. `Me.voiceCount` is `null` when the engine is unreachable (agreed with plan 2C). `POST /api/jobs/estimate` `sentences` is an approximation (the engine has no estimate endpoint). `GET /api/health` probes LQ-Studio with `GET <LQSTUDIO_URL>/api/health` (200 = ok; the lq-server relay forwards it), caches both probes 10 s, and also returns `signupUrl` (controller ruling: env `LQS_SIGNUP_URL`, default `<LQSTUDIO_PUBLIC_URL>/signup` — LQ-Studio's real sign-up route is `/signup` in `client/src/App.jsx:439`, there is no `/register`; so PROD `https://lq-studio.com/signup`, staging `https://demo.lq-studio.com/signup`).
12. Status codes: `invalid_request` 400 (CSRF: 403), `consent_required` 400, `unauthorized`/`invalid_credentials`/`invalid_code` 401, `insufficient_credits` 402, `suspended`/`needs_verification`/`voice_limit_reached` 403, `not_found` 404, `not_regeneratable`/`voice_not_ready` 409, `too_large` 413, `unsupported_audio` 415, `rate_limited` 429 (+`Retry-After`), `lqstudio_unavailable`/`engine_unavailable` 503.
13. SSE relay writes `: keepalive\n\n` every 15 s (Cloudflare closes responses idle > 100 s).
14. Settle/refund 404 from LQ-Studio: refund 404 = nothing was held → mark `refunded`; settle 404 is an anomaly → counted as a failed attempt (reaches manual review).
15. **Upload limit 95 MB** (controller ruling 2026-10-03, replaces the spec's 200 MB for the web server only): Cloudflare Free rejects request bodies over 100 MB before they reach us. `MAX_UPLOAD_BYTES` defaults to `99614720`; the `too_large` message is derived from it (`upload exceeds 95 MB`). The engine keeps its own 200 MB limit. Accepted C2 additions (same ruling): `internal_error` (500), missing CSRF header → 403 `invalid_request`, cancel → 202 `{status:"cancel_requested"}`, `estimate.sentences` approximate.
16. **Controller rulings 2026-10-03 (second batch):** `GET /api/health` adds `signupUrl` (clarification 11). Every engine-relayed body (sentence audio, voice preview, output files) is sent with `Cache-Control: no-store`, and extra query parameters such as the client's `?v=<revision>` cache-buster are ignored on sentence audio. Role `lq_tts_web` has `CREATE` on database `lq_tts` (Task 1 Step 3), so startup migrations create `lq_tts_web_stg`, `lq_tts_web` and plan 2C's `lq_tts_web_e2e`. Downloads keep the engine's `Content-Disposition` filename (`<jobId>-r<rev>-<name>`), which the relay passes through.

**Dry run made while planning:** every code block of this plan was extracted verbatim into a scratch copy and run on Node 22 against a throwaway Postgres 16: all 13 test files (117 tests) pass, and the Task 12 entrypoint smoke prints the expected output. (The run predates clarifications 15–16, which changed the upload-limit default, the `too_large` message, the health `signupUrl`, one config test and the relay's `Cache-Control` value; expected total after them: 118 tests.) Deviating from the code below is therefore a red flag, not a style choice.

---

## File Structure

```
web/
  package.json              ESM, scripts: start, migrate, test; deps express, pg, busboy; dev vitest, supertest
  vitest.config.js          test include, setup file, worker cap
  .env.example              every server setting (real files .env / .env.stg / .env.prod are gitignored)
  server/
    index.js                entrypoint: config → pool → migrate → app.listen → reconciler
    migrate.js              CLI: run migrations only
    config.js               loadConfig(env) + PRICING constants
    context.js              createContext(): wires services shared by routes and the reconciler
    app.js                  createApp(ctx, opts): middleware + routers + static + error handler
    db/pool.js              createPool(), migrate()
    db/migrations/001_init.sql   sessions, jobs, charges, voice_consents (+ indexes)
    lib/errors.js           ApiError, STATUS, errorHandler()
    lib/log.js              JSON-line logger
    lib/pricing.js          countChars, creditsFor, rupiahFor, countSentences, makeTitle
    lib/upstream-errors.js  lqError(), engineError(), isEngineNotFound()
    clients/http.js         UpstreamError, UpstreamUnavailable, parseResponse(), requestJson()
    clients/lqstudio.js     createLqStudio(): C1 calls + ping()
    clients/engine.js       createEngine(): engine calls, stream(), uploadVoice() (streamed multipart)
    http/middleware.js      cookie helpers, clientIp(), csrf, requireAuth()
    http/relay.js           relay()/relayEngine(): stream engine bodies (Range aware)
    services/sessions.js    createSessionStore(): hashed ids, sliding expiry, revoke, cache fields
    services/accounts.js    createAccounts(): fresh() ≤5-min cache, assertActive(), me(), voice limit/count
    services/ownership.js   isUuid(), ownVoice(), ownJob(), parseIdx()
    services/jobs-repo.js   createJobsRepo(), toSummary()
    services/charges.js     decide(), createCharges(): insertHeld/hold/settle/refund/resolve/recordFailure
    services/reconcile.js   createReconciler(): 60 s loop + startup pass
    routes/auth.js          POST /auth/login, /auth/2fa, /auth/logout
    routes/me.js            GET/PATCH /me
    routes/health.js        GET /health
    routes/static.js        mountClient(): client/dist + SPA fallback
    routes/jobs.js          estimate, create, list, detail, sentences, sentence audio, files
    routes/job-actions.js   regenerate, cancel, delete
    routes/events.js        SSE relay
    routes/credits.js       GET /credits
    routes/voices.js        list, upload (streamed), preview, delete
    routes/callback.js      POST /internal/engine-callback, verifySignature()
    test/
      setup-env.js          loads web/.env (TEST_DATABASE_URL) when present
      db-url.js             testDatabaseUrl()
      helpers.js            startHarness(), USERS, sessionCookie(), signCallback(), binary/text parsers
      fakes/fake-lqstudio.js  in-memory C1 server (also launchable by plan 2C's Playwright)
      fakes/fake-engine.js    in-memory engine server
      *.test.js
```

---

### Task 1: Branch, database role, package scaffold and config

**Files:**
- Create: `web/package.json`, `web/vitest.config.js`, `web/.env.example`, `web/.env` (gitignored, not committed), `web/server/config.js`, `web/server/test/setup-env.js`, `web/server/test/db-url.js`
- Modify: `.gitignore` (repo root)
- Test: `web/server/test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env = process.env) → Config` (frozen) with fields `host, port, databaseUrl, dbSchema, engineUrl, engineToken, engineCallbackSecret, engineCallbackUrl, lqstudioUrl, lqstudioToken, topupUrl, verifyUrl, signupUrl, cookieSecure, clientDist, maxUploadBytes, reconcileIntervalMs, creditsPer1kChars, rupiahPerCredit, voiceLimitFree, voiceLimitPaid, consentVersion, maxTextChars`; `PRICING` (frozen object with the last six fields); `testDatabaseUrl() → string` (test helper). Env names: `HOST, PORT, DATABASE_URL, DB_SCHEMA, ENGINE_URL, ENGINE_TOKEN, ENGINE_CALLBACK_SECRET, ENGINE_CALLBACK_URL, LQSTUDIO_URL, LQSTUDIO_TOKEN, LQSTUDIO_PUBLIC_URL, LQS_SIGNUP_URL, COOKIE_SECURE, CLIENT_DIST, MAX_UPLOAD_BYTES, RECONCILE_INTERVAL_MS, TEST_DATABASE_URL`.

- [ ] **Step 1: Create the branch and the folder**

```bash
cd ~/Developer/LQ-TTS && export PATH=/opt/homebrew/bin:$PATH
git status --short
git switch -c feat/web-app
mkdir -p web/server/test/fakes web/server/db/migrations
git branch --show-current
```
Expected: `git status --short` prints nothing (clean tree; if not, stop and ask), last line `feat/web-app`.

- [ ] **Step 2: Ignore env files and node_modules**

```bash
cd ~/Developer/LQ-TTS
for line in 'node_modules/' '.env.*' '!.env.example'; do grep -qxF -- "$line" .gitignore || printf '%s\n' "$line" >> .gitignore; done
git check-ignore -v web/.env web/.env.stg web/.env.prod web/node_modules/x; git check-ignore web/.env.example || echo "example tracked"
```
Expected: four lines naming `.gitignore` rules for the four paths, then `example tracked`.

- [ ] **Step 3: Create role `lq_tts_web` and `web/.env`** (one-time, local socket as superuser `minato`)

```bash
cd ~/Developer/LQ-TTS/web && export PATH=/opt/homebrew/bin:$PATH
PW=$(openssl rand -hex 24)
psql -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE ROLE lq_tts_web LOGIN PASSWORD '$PW'"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT, CREATE ON DATABASE lq_tts TO lq_tts_web" -c "GRANT CONNECT, CREATE ON DATABASE lq_tts_test TO lq_tts_web"
umask 077
printf 'TEST_DATABASE_URL=postgresql://lq_tts_web:%s@127.0.0.1:5432/lq_tts_test\nDATABASE_URL=postgresql://lq_tts_web:%s@127.0.0.1:5432/lq_tts\n' "$PW" "$PW" > .env
chmod 600 .env; unset PW
set -a; . ./.env; set +a
psql "$TEST_DATABASE_URL" -Atc "select current_user"
psql "$DATABASE_URL" -Atc "select has_database_privilege('lq_tts', 'CREATE')"
```
Expected: `lq_tts_web`, then `t`. (`pg_hba` already allows scram for `127.0.0.1`.)

- [ ] **Step 4: Write `web/package.json` and install dependencies**

`web/package.json`:
```json
{
  "name": "lq-tts-web",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26" },
  "scripts": {
    "start": "node server/index.js",
    "migrate": "node server/migrate.js",
    "test": "vitest run"
  }
}
```
Run:
```bash
cd ~/Developer/LQ-TTS/web && export PATH=/opt/homebrew/bin:$PATH
npm install express@^5.2.1 pg@^8.23.1 busboy@^1.6.0
npm install -D --include=dev vitest@^5.0.3 supertest@^7.3.1
ls -d node_modules/vitest node_modules/supertest
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).join(','), Object.keys(p.devDependencies).join(','))"
```
Expected: `node_modules/vitest node_modules/supertest`, then `busboy,express,pg supertest,vitest`. (`--include=dev` guards against a global `omit=dev`/`NODE_ENV=production` npm setting, which silently skips dev packages.)

- [ ] **Step 5: Write the Vitest config, env loader, DB url helper and `.env.example`**

`web/vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.js'],
    setupFiles: ['server/test/setup-env.js'],
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers: 4,
  },
});
```

`web/server/test/setup-env.js`:
```js
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
```

`web/server/test/db-url.js`:
```js
export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (web/.env)');
  return url;
}
```

`web/.env.example`:
```
# Server settings. Real files are gitignored: web/.env (tests: TEST_DATABASE_URL, DATABASE_URL),
# web/.env.stg and web/.env.prod (one per container, written by plan 2C / Task 13).
HOST=127.0.0.1
PORT=8750
DATABASE_URL=postgresql://lq_tts_web:CHANGE_ME@127.0.0.1:5432/lq_tts
DB_SCHEMA=lq_tts_web_stg
ENGINE_URL=http://127.0.0.1:8740
ENGINE_TOKEN=CHANGE_ME
ENGINE_CALLBACK_SECRET=CHANGE_ME
ENGINE_CALLBACK_URL=http://127.0.0.1:8750/api/internal/engine-callback
LQSTUDIO_URL=http://100.80.128.19:3112
LQSTUDIO_TOKEN=CHANGE_ME_TO_AT_LEAST_32_CHARACTERS
LQSTUDIO_PUBLIC_URL=https://demo.lq-studio.com
# LQS_SIGNUP_URL defaults to <LQSTUDIO_PUBLIC_URL>/signup (LQ-Studio's sign-up route)
# LQS_SIGNUP_URL=https://demo.lq-studio.com/signup
COOKIE_SECURE=true
# CLIENT_DIST defaults to web/client/dist
# CLIENT_DIST=/app/client/dist
MAX_UPLOAD_BYTES=99614720
RECONCILE_INTERVAL_MS=60000
TEST_DATABASE_URL=postgresql://lq_tts_web:CHANGE_ME@127.0.0.1:5432/lq_tts_test
```

- [ ] **Step 6: Write the failing config test**

`web/server/test/config.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/lq_tts',
  DB_SCHEMA: 'lq_tts_web_stg',
  ENGINE_URL: 'http://127.0.0.1:8740/',
  ENGINE_TOKEN: 'engine-token',
  ENGINE_CALLBACK_SECRET: 'callback-secret',
  ENGINE_CALLBACK_URL: 'http://127.0.0.1:8750/api/internal/engine-callback',
  LQSTUDIO_URL: 'http://100.80.128.19:3112/',
  LQSTUDIO_TOKEN: 'x'.repeat(32),
  LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com/',
};

describe('loadConfig', () => {
  it('derives URLs and carries the spec pricing constants', () => {
    const c = loadConfig(base);
    expect(c.engineUrl).toBe('http://127.0.0.1:8740');
    expect(c.lqstudioUrl).toBe('http://100.80.128.19:3112');
    expect(c.topupUrl).toBe('https://demo.lq-studio.com/upgrade-plan');
    expect(c.verifyUrl).toBe('https://demo.lq-studio.com/login');
    expect(c.signupUrl).toBe('https://demo.lq-studio.com/signup');
    expect(c).toMatchObject({
      host: '127.0.0.1', port: 8750, cookieSecure: true, maxUploadBytes: 99614720, reconcileIntervalMs: 60000,
      creditsPer1kChars: 10, rupiahPerCredit: 100, voiceLimitFree: 3, voiceLimitPaid: 25, consentVersion: 'v1', maxTextChars: 20000,
    });
  });

  it('turns Secure cookies off only for COOKIE_SECURE=false', () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: '0' }).cookieSecure).toBe(true);
  });

  it('lets LQS_SIGNUP_URL override the sign-up link', () => {
    expect(loadConfig({ ...base, LQS_SIGNUP_URL: 'https://lq-studio.com/signup?ref=tts' }).signupUrl).toBe('https://lq-studio.com/signup?ref=tts');
  });

  it.each(Object.keys(base))('rejects a missing %s', (key) => {
    const env = { ...base };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('rejects a short LQ-Studio token and an unsafe schema name', () => {
    expect(() => loadConfig({ ...base, LQSTUDIO_TOKEN: 'short' })).toThrow('at least 32');
    expect(() => loadConfig({ ...base, DB_SCHEMA: 'x"; drop' })).toThrow('DB_SCHEMA');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run server/test/config.test.js`
Expected: FAIL — `Failed to load url ../config.js` (module does not exist).

- [ ] **Step 8: Write `web/server/config.js`**

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PRICING = Object.freeze({
  creditsPer1kChars: 10,
  rupiahPerCredit: 100,
  voiceLimitFree: 3,
  voiceLimitPaid: 25,
  consentVersion: 'v1',
  maxTextChars: 20000,
});

const trimSlash = (url) => url.replace(/\/+$/, '');

export function loadConfig(env = process.env) {
  const req = (key) => {
    const value = env[key];
    if (value === undefined || value === '') throw new Error(`missing required setting ${key}`);
    return value;
  };
  const dbSchema = req('DB_SCHEMA');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbSchema)) throw new Error('DB_SCHEMA must be a lowercase SQL identifier');
  const lqstudioToken = req('LQSTUDIO_TOKEN');
  if (lqstudioToken.length < 32) throw new Error('LQSTUDIO_TOKEN must be at least 32 characters');
  const publicUrl = trimSlash(req('LQSTUDIO_PUBLIC_URL'));
  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8750),
    databaseUrl: req('DATABASE_URL'),
    dbSchema,
    engineUrl: trimSlash(req('ENGINE_URL')),
    engineToken: req('ENGINE_TOKEN'),
    engineCallbackSecret: req('ENGINE_CALLBACK_SECRET'),
    engineCallbackUrl: req('ENGINE_CALLBACK_URL'),
    lqstudioUrl: trimSlash(req('LQSTUDIO_URL')),
    lqstudioToken,
    topupUrl: `${publicUrl}/upgrade-plan`,
    verifyUrl: `${publicUrl}/login`,
    signupUrl: env.LQS_SIGNUP_URL || `${publicUrl}/signup`,
    cookieSecure: env.COOKIE_SECURE !== 'false',
    clientDist: path.resolve(env.CLIENT_DIST || path.join(WEB_DIR, 'client', 'dist')),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 99614720), // 95 MB: Cloudflare rejects bodies over 100 MB
    reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS || 60000),
    ...PRICING,
  });
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run server/test/config.test.js`
Expected: PASS (13 tests).

- [ ] **Step 10: Commit**

```bash
cd ~/Developer/LQ-TTS
git status --short   # must NOT list web/.env
git add .gitignore web/package.json web/package-lock.json web/vitest.config.js web/.env.example web/server/config.js web/server/test/setup-env.js web/server/test/db-url.js web/server/test/config.test.js
git commit -m "web: scaffold server package, database role and config"
```

---

### Task 2: Errors and pricing

**Files:**
- Create: `web/server/lib/errors.js`, `web/server/lib/pricing.js`
- Test: `web/server/test/pricing.test.js`

**Interfaces:**
- Consumes: `PRICING` (Task 1).
- Produces: `STATUS` (code → HTTP status); `class ApiError(code, message = code, {status?, headers?})` with `.code .status .headers`; `errorHandler(log) → express error middleware` (writes `{error:{code,message}}`, maps body-parser errors, logs others as `unhandled_error` and answers `500 internal_error`); `countChars(text) → number` (code points); `creditsFor(chars) → int ≥ 1`; `rupiahFor(credits) → int`; `countSentences(text) → int`; `makeTitle(text) → string` (one line, ≤ 60 code points).

- [ ] **Step 1: Write the failing test**

`web/server/test/pricing.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { countChars, countSentences, creditsFor, makeTitle, rupiahFor } from '../lib/pricing.js';

describe('pricing', () => {
  it.each([[1, 1], [100, 1], [101, 2], [999, 10], [1000, 10], [1001, 11], [20000, 200]])(
    '%i chars cost %i credits', (chars, credits) => {
      expect(creditsFor(chars)).toBe(credits);
    },
  );

  it('prices one credit at Rp100', () => {
    expect(rupiahFor(11)).toBe(1100);
  });

  it('counts code points like the engine (an emoji is one character)', () => {
    expect(countChars('halo 👋')).toBe(6);
  });

  it('makes a one-line title of at most 60 characters', () => {
    expect(makeTitle('  Halo\n\n dunia  ')).toBe('Halo dunia');
    expect([...makeTitle(`${'a'.repeat(59)}👋👋`)]).toHaveLength(60);
  });

  it('approximates the sentence count', () => {
    expect(countSentences('Halo. Apa kabar? Baik!\n\nParagraf dua')).toBe(4);
    expect(countSentences('   ')).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/pricing.test.js`
Expected: FAIL — cannot load `../lib/pricing.js`.

- [ ] **Step 3: Write `web/server/lib/pricing.js` and `web/server/lib/errors.js`**

`web/server/lib/pricing.js`:
```js
import { PRICING } from '../config.js';

export const countChars = (text) => [...text].length;

export const creditsFor = (chars) => Math.max(1, Math.ceil((chars * PRICING.creditsPer1kChars) / 1000));

export const rupiahFor = (credits) => credits * PRICING.rupiahPerCredit;

// Display-only approximation; the engine's splitter decides the real sentences.
export function countSentences(text) {
  return text.split(/(?<=[.!?…])\s+|\n+/u).map((s) => s.trim()).filter(Boolean).length;
}

export function makeTitle(text) {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
}
```

`web/server/lib/errors.js`:
```js
export const STATUS = Object.freeze({
  invalid_request: 400,
  consent_required: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  invalid_code: 401,
  insufficient_credits: 402,
  suspended: 403,
  needs_verification: 403,
  voice_limit_reached: 403,
  not_found: 404,
  not_regeneratable: 409,
  voice_not_ready: 409,
  too_large: 413,
  unsupported_audio: 415,
  rate_limited: 429,
  internal_error: 500,
  lqstudio_unavailable: 503,
  engine_unavailable: 503,
});

export class ApiError extends Error {
  constructor(code, message = code, { status, headers } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    this.headers = headers ?? {};
  }
}

export function errorHandler(log) {
  // Express recognises error middleware by its four parameters.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    let apiErr = err;
    if (!(err instanceof ApiError)) {
      if (err?.type === 'entity.parse.failed') apiErr = new ApiError('invalid_request', 'malformed JSON body');
      else if (err?.type === 'entity.too.large') apiErr = new ApiError('too_large', 'request body too large');
      else {
        log.error({ event: 'unhandled_error', path: req.path, error: String(err?.stack ?? err) }, 'unhandled error');
        apiErr = new ApiError('internal_error', 'internal error');
      }
    }
    res.set(apiErr.headers).status(apiErr.status).json({ error: { code: apiErr.code, message: apiErr.message } });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/pricing.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/lib/errors.js web/server/lib/pricing.js web/server/test/pricing.test.js
git commit -m "web: API errors and credit pricing"
```

---

### Task 3: Database schema and migrations

**Files:**
- Create: `web/server/db/pool.js`, `web/server/db/migrations/001_init.sql`
- Test: `web/server/test/db.test.js`

**Interfaces:**
- Consumes: `testDatabaseUrl()` (Task 1).
- Produces: `createPool(databaseUrl, schema, {max = 10}) → pg.Pool` (every connection has `search_path=<schema>`); `migrate(pool, schema) → Promise<void>` (creates the schema, applies `db/migrations/*.sql` once each in name order under an advisory lock, records them in `schema_migrations`). Tables (all in the schema):
  - `sessions(id text pk = sha256 hex, user_id text, name, email, plan text, paid bool, lang 'id'|'en', balance double precision null, refreshed_at, created_at, expires_at, revoked_at)`
  - `jobs(id uuid pk = engine job id, user_id text, voice_id uuid, voice_name, title, chars int, status queued|running|done|failed|canceled, revision int, audio_seconds real, created_at, finished_at, deleted_at)`
  - `charges(id bigserial pk, user_id, job_id uuid null → jobs, revision int, kind job|regenerate, sentence_idx int null, chars, credits int > 0, hold_id text unique, state held|settled|refunded, created_at, resolved_at, attempts int, last_error text, flagged_at)`
  - `voice_consents(voice_id uuid pk, user_id, accepted_at, ip, consent_version)`

- [ ] **Step 1: Write the failing test**

`web/server/test/db.test.js`:
```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/db.test.js`
Expected: FAIL — cannot load `../db/pool.js`.

- [ ] **Step 3: Write the migration and the pool**

`web/server/db/migrations/001_init.sql`:
```sql
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  plan text NOT NULL,
  paid boolean NOT NULL,
  lang text NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  balance double precision,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  voice_id uuid NOT NULL,
  voice_name text NOT NULL,
  title text NOT NULL,
  chars integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  revision integer NOT NULL DEFAULT 1,
  audio_seconds real,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX jobs_user_created ON jobs (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX jobs_user_voice ON jobs (user_id, voice_id) WHERE deleted_at IS NULL;

CREATE TABLE charges (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  job_id uuid REFERENCES jobs (id),
  revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('job', 'regenerate')),
  sentence_idx integer,
  chars integer NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  hold_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'settled', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  flagged_at timestamptz
);
CREATE INDEX charges_held ON charges (created_at) WHERE state = 'held';
CREATE INDEX charges_job ON charges (job_id, revision);
CREATE INDEX charges_user_created ON charges (user_id, created_at DESC);

CREATE TABLE voice_consents (
  voice_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text NOT NULL,
  consent_version text NOT NULL
);
CREATE INDEX voice_consents_user ON voice_consents (user_id);
```

`web/server/db/pool.js`:
```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPool(databaseUrl, schema, { max = 10 } = {}) {
  if (!IDENT.test(schema)) throw new Error(`unsafe schema name ${schema}`);
  return new pg.Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
}

export async function migrate(pool, schema) {
  if (!IDENT.test(schema)) throw new Error(`unsafe schema name ${schema}`);
  const lockKey = `lq_tts_web_migrate:${schema}`;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    client.release();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/db.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/db web/server/test/db.test.js
git commit -m "web: postgres schema for sessions, jobs, charges and consents"
```

---

### Task 4: Upstream clients and fake upstream servers

**Files:**
- Create: `web/server/clients/http.js`, `web/server/clients/lqstudio.js`, `web/server/clients/engine.js`, `web/server/test/fakes/fake-lqstudio.js`, `web/server/test/fakes/fake-engine.js`
- Test: `web/server/test/clients.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class UpstreamUnavailable(service, cause, status = null)` (network error, timeout, any 5xx); `class UpstreamError(service, status, code, message, body)` (4xx; `code` read from `{error:"x"}`, `{ok:false,error:"x"}`, `{error:{code}}`, or `{error:<prose>, code:"x"}`); `parseResponse(service, res) → data | throws`; `requestJson(service, url, {method, token, body, headers, timeoutMs}) → data`.
  - `createLqStudio({baseUrl, token, timeoutMs = 10000})` → `{verify({identifier,password,ip}), verify2fa({challenge,code,ip}), getUser(id), hold({userId,amount,ref}), settle({userId,holdId,amount}), refund({userId,holdId}), ping() → bool}` (paths `/api/internal/tts/...`; `ping` = `GET /api/health` without token).
  - `createEngine({baseUrl, token, timeoutMs = 15000})` → `{health() → 'ok'|'restarting', listVoices(ownerRef), getVoice(id), deleteVoice(id), createJob({voiceId,text,settings,callbackUrl,idempotencyKey}), getJob(id), sentences(id), regenerate(id, idx, {text, style}), cancel(id), deleteJob(id), stream(path, {headers, signal}) → Response (ok or 206; else throws), uploadVoice({fields, filename, mimeType, file, signal}) → {id, status}}`. `uploadVoice` streams `file` (any async iterable); if `file.truncated` is true after the last chunk it aborts the request (the engine stores nothing) and rejects with `UpstreamUnavailable`.
  - `startFakeLqStudio({port = 0, token, users})` → `{url, state, close()}`; user shape `{id, name, email, username, password, totp: null|"123456", verified, suspended, plan, paid, balance}`. `state`: `users` (Map), `ledger` (`{ref,userId,type:'deduct'|'refund',amount}`), `settled` (Set), `calls` (`{method, path, body, headers}`, path without `/api/internal/tts`), `down`, `rateLimited`, `failNext` (Map `'POST /credits/hold'` → n answers of 503), `net(ref)`, `callsTo(path)`.
  - `startFakeEngine({port = 0, token})` → `{url, state, addVoice({owner_ref, name?, status?, language?, error_code?}) → voice, setJob(id, patch) → job, close()}`; `state`: `voices`, `jobs` (Maps), `calls` (`{method, route, path, query, headers, body}` with uuids → `:id`, sentence numbers → `:idx`), `failNext` (Map `'POST /v1/jobs'` → `{status, code, message?}` once), `healthStatus`, `events` (Map jobId → `[[event, data] | ['__sleep', ms]]`), `fileBytes` (`'0123456789abcdefghij'`), `callsTo(method, route)`. Also exports `WAV_BYTES`.

- [ ] **Step 1: Write the fake LQ-Studio server**

`web/server/test/fakes/fake-lqstudio.js`:
```js
import http from 'node:http';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// In-memory stand-in for LQ-Studio's /api/internal/tts/* (contract C1), incl. the guard's behaviour.
export async function startFakeLqStudio({ port = 0, token, users = [] } = {}) {
  const state = {
    users: new Map(users.map((u) => [String(u.id), { ...u }])),
    ledger: [],
    settled: new Set(),
    calls: [],
    down: false,
    rateLimited: false,
    failNext: new Map(),
    challenges: new Map(),
    net(ref) {
      return this.ledger.filter((l) => l.ref === ref).reduce((sum, l) => sum + (l.type === 'deduct' ? l.amount : -l.amount), 0);
    },
    callsTo(path) {
      return this.calls.filter((c) => c.path === path);
    },
  };
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, paid: u.paid });
  const byIdentifier = (identifier) => {
    const id = String(identifier ?? '').toLowerCase();
    return [...state.users.values()].find((u) => u.email.toLowerCase() === id || u.username.toLowerCase() === id);
  };
  const hasHold = (userId, ref) => state.ledger.some((l) => l.ref === ref && l.userId === userId && l.type === 'deduct');
  let challengeSeq = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, state.down ? 503 : 200, { ok: !state.down });
      const prefix = '/api/internal/tts';
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: 'not_found' });
      const path = url.pathname.slice(prefix.length);
      const body = req.method === 'POST' ? await readJson(req) : {};
      state.calls.push({ method: req.method, path, body, headers: req.headers });
      if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return json(res, 403, { ok: false, error: 'internal_route_not_public' });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: 'unauthorized' });
      if (state.down) return json(res, 503, { error: 'unavailable' });
      const key = `${req.method} ${path.startsWith('/users/') ? '/users/:id' : path}`;
      const left = state.failNext.get(key) ?? 0;
      if (left > 0) {
        state.failNext.set(key, left - 1);
        return json(res, 503, { error: 'ledger_unavailable' });
      }

      if (req.method === 'POST' && path === '/auth/verify') {
        if (state.rateLimited) return json(res, 429, { error: 'rate_limited', retryAfter: 30 });
        const u = byIdentifier(body.identifier);
        if (!u || u.password !== body.password) return json(res, 401, { error: 'invalid_credentials' });
        if (u.suspended) return json(res, 403, { error: 'suspended' });
        if (!u.verified) return json(res, 200, { status: 'needs_verification' });
        if (u.totp) {
          const challenge = `ch:${u.id}:${++challengeSeq}`;
          state.challenges.set(challenge, u.id);
          return json(res, 200, { status: 'need_2fa', challenge });
        }
        return json(res, 200, { status: 'ok', user: pub(u) });
      }
      if (req.method === 'POST' && path === '/auth/verify-2fa') {
        const u = state.users.get(state.challenges.get(body.challenge) ?? '');
        if (!u || String(body.code) !== u.totp) return json(res, 401, { error: 'invalid_code' });
        state.challenges.delete(body.challenge);
        return json(res, 200, { status: 'ok', user: pub(u) });
      }
      if (req.method === 'GET' && path.startsWith('/users/')) {
        const u = state.users.get(decodeURIComponent(path.slice('/users/'.length)));
        if (!u) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ...pub(u), balance: u.balance, suspended: u.suspended, verified: u.verified });
      }
      if (req.method === 'POST' && path === '/credits/hold') {
        const u = state.users.get(String(body.userId));
        if (!u) return json(res, 404, { error: 'not_found' });
        if (hasHold(u.id, body.ref)) return json(res, 200, { holdId: body.ref, charged: body.amount, balance: u.balance });
        if (u.balance < body.amount) return json(res, 402, { error: 'insufficient_credits', message: 'not enough credits' });
        u.balance -= body.amount;
        state.ledger.push({ ref: body.ref, userId: u.id, type: 'deduct', amount: body.amount });
        return json(res, 200, { holdId: body.ref, charged: body.amount, balance: u.balance });
      }
      if (req.method === 'POST' && (path === '/credits/settle' || path === '/credits/refund')) {
        const u = state.users.get(String(body.userId));
        if (!u || !hasHold(u.id, body.holdId)) return json(res, 404, { error: 'not_found' });
        if (path === '/credits/settle') {
          if (!state.settled.has(body.holdId)) {
            const remainder = state.net(body.holdId) - body.amount;
            if (remainder > 0) {
              u.balance += remainder;
              state.ledger.push({ ref: body.holdId, userId: u.id, type: 'refund', amount: remainder });
            }
            state.settled.add(body.holdId);
          }
          return json(res, 200, { balance: u.balance });
        }
        const owed = state.settled.has(body.holdId) ? 0 : Math.max(0, state.net(body.holdId));
        if (owed > 0) {
          u.balance += owed;
          state.ledger.push({ ref: body.holdId, userId: u.id, type: 'refund', amount: owed });
        }
        return json(res, 200, { balance: u.balance, refunded: owed });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      return json(res, 500, { error: 'internal', message: String(err) });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
```

- [ ] **Step 2: Write the fake engine server**

`web/server/test/fakes/fake-engine.js`:
```js
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import busboy from 'busboy';

export const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 7)]);
const FILE_TYPES = { 'final.mp3': 'audio/mpeg', 'final.wav': 'audio/wav', 'subs.srt': 'application/x-subrip', 'subs.vtt': 'text/vtt' };
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, code, message = code) => json(res, status, { error: { code, message } });

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// In-memory stand-in for the voice engine API (same paths and JSON shapes as engine/lq_tts_engine/api/app.py).
export async function startFakeEngine({ port = 0, token } = {}) {
  const state = {
    voices: new Map(),
    jobs: new Map(),
    calls: [],
    failNext: new Map(),
    healthStatus: 200,
    events: new Map(),
    fileBytes: Buffer.from('0123456789abcdefghij'),
    callsTo(method, route) {
      return this.calls.filter((c) => c.method === method && c.route === route);
    },
  };

  const voiceOut = (v) => ({
    id: v.id, name: v.name, owner_ref: v.owner_ref, language: v.language, status: v.status, error_code: v.error_code,
    ref_transcript: null, ref_seconds: v.ref_seconds, clip_start_s: null, clip_end_s: null, created_at: v.created_at,
    preview_url: v.status === 'ready' ? `/v1/voices/${v.id}/preview.wav` : null,
  });
  const jobView = (j) => ({
    id: j.id, status: j.status, error_code: j.error_code, revision: j.revision,
    progress: { done: j.sentences.filter((s) => s.status === 'done' || s.status === 'needs_review').length, total: j.sentences.length },
    needs_review: j.sentences.filter((s) => s.status === 'needs_review').length,
    queue_position: 0, chars: j.chars, audio_seconds: j.audio_seconds, settings: j.settings,
    files: j.doneRevision
      ? Object.fromEntries(Object.keys(FILE_TYPES).map((n) => [n, `/v1/jobs/${j.id}/files/${n}?revision=${j.doneRevision}`]))
      : {},
    created_at: j.created_at, finished_at: j.finished_at,
  });
  const sentenceOut = (j, s) => ({
    idx: s.idx, paragraph_idx: s.paragraph_idx, text: s.text, style: s.style, status: s.status, takes: s.takes,
    score: s.score, asr_text: null, duration_s: s.duration_s, start_s: s.start_s, end_s: s.end_s,
    audio_url: s.audio ? `/v1/jobs/${j.id}/sentences/${s.idx}/audio.wav` : null,
  });

  function addVoice({ owner_ref, name = 'Voice', status = 'ready', language = 'id', error_code = null }) {
    const v = {
      id: crypto.randomUUID(), owner_ref, name, status, language, error_code,
      ref_seconds: status === 'ready' ? 12.5 : null, created_at: now(), bytes: 0, sha256: null, fields: {},
    };
    state.voices.set(v.id, v);
    return v;
  }

  function setJob(id, patch) {
    const j = state.jobs.get(id);
    Object.assign(j, patch);
    if (patch.status === 'done') {
      j.doneRevision = j.revision;
      j.finished_at = now();
      for (const s of j.sentences) {
        s.status = 'done';
        s.audio = true;
      }
    } else if (patch.status === 'failed' || patch.status === 'canceled') {
      j.finished_at = now();
    }
    return j;
  }

  function receiveVoice(req, res, call) {
    return new Promise((resolve) => {
      const bb = busboy({ headers: req.headers });
      const fields = {};
      let file = null;
      bb.on('field', (name, value) => {
        fields[name] = value;
      });
      bb.on('file', (name, stream, info) => {
        const hash = crypto.createHash('sha256');
        file = { filename: info.filename, mimeType: info.mimeType, bytes: 0, sha256: null };
        stream.on('data', (chunk) => {
          file.bytes += chunk.length;
          hash.update(chunk);
        });
        stream.on('end', () => {
          file.sha256 = hash.digest('hex');
        });
      });
      bb.on('error', () => {
        res.destroy();
        resolve();
      });
      bb.on('close', () => {
        call.body = { fields, file };
        if (!fields.name || !fields.owner_ref || !file) {
          fail(res, 400, 'invalid_request', 'name, owner_ref and audio are required');
        } else if (!['.mp3', '.wav', '.m4a', '.flac'].includes(path.extname(file.filename).toLowerCase())) {
          fail(res, 415, 'unsupported_audio', 'use MP3, WAV, M4A or FLAC');
        } else {
          const v = addVoice({ owner_ref: fields.owner_ref, name: fields.name, status: 'processing', language: fields.language ?? null });
          Object.assign(v, { bytes: file.bytes, sha256: file.sha256, fields });
          json(res, 202, { id: v.id, status: v.status });
        }
        resolve();
      });
      req.on('aborted', () => resolve());
      req.on('error', () => resolve());
      req.pipe(bb);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      const p = url.pathname;
      const route = p.replace(UUID_IN_PATH, ':id').replace(/\/sentences\/\d+/, '/sentences/:idx');
      const call = { method: req.method, route, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body: null };
      state.calls.push(call);
      if (route === '/v1/health') {
        if (state.healthStatus === 200) return json(res, 200, { model_loaded: true, queue_depth: 0 });
        return fail(res, state.healthStatus, 'model_loading', 'worker has not loaded the model');
      }
      if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'unauthorized', 'missing or invalid service token');
      const failKey = `${req.method} ${route}`;
      const planned = state.failNext.get(failKey);
      if (planned) {
        state.failNext.delete(failKey);
        req.resume();
        return fail(res, planned.status, planned.code, planned.message ?? planned.code);
      }
      const id = p.match(UUID_IN_PATH)?.[0];
      const idx = Number(p.match(/\/sentences\/(\d+)/)?.[1]);

      if (req.method === 'POST' && route === '/v1/voices') return await receiveVoice(req, res, call);
      if (req.method === 'GET' && route === '/v1/voices') {
        const owner = url.searchParams.get('owner_ref');
        if (!owner) return fail(res, 400, 'invalid_request', 'query.owner_ref: Field required');
        const list = [...state.voices.values()].filter((v) => v.owner_ref === owner).reverse();
        return json(res, 200, list.map(voiceOut));
      }
      if (route.startsWith('/v1/voices/:id')) {
        const v = state.voices.get(id);
        if (!v) return fail(res, 404, 'not_found', 'voice not found');
        if (req.method === 'GET' && route === '/v1/voices/:id') return json(res, 200, voiceOut(v));
        if (req.method === 'GET' && route === '/v1/voices/:id/preview.wav') {
          if (v.status !== 'ready') return fail(res, 404, 'not_found', 'voice has no preview yet');
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV_BYTES.length });
          return res.end(WAV_BYTES);
        }
        if (req.method === 'DELETE' && route === '/v1/voices/:id') {
          state.voices.delete(id);
          for (const j of [...state.jobs.values()]) if (j.voice_id === id) state.jobs.delete(j.id);
          res.writeHead(204);
          return res.end();
        }
      }
      if (req.method === 'POST' && route === '/v1/jobs') {
        const body = await readJson(req);
        call.body = body;
        const key = req.headers['idempotency-key'];
        const existing = key ? [...state.jobs.values()].find((j) => j.idem === key) : null;
        if (existing) return json(res, 202, { id: existing.id, sentences_total: existing.sentences.length, estimated_seconds: 12 });
        const v = state.voices.get(body.voice_id);
        if (!v) return fail(res, 404, 'not_found', 'voice not found');
        if (v.status !== 'ready') return fail(res, 409, 'voice_not_ready', `voice is ${v.status}`);
        const text = String(body.text ?? '').trim();
        if (!text) return fail(res, 400, 'invalid_text', 'text is empty');
        const j = {
          id: crypto.randomUUID(), voice_id: v.id, text, settings: { speed: 0.9, ...(body.settings ?? {}) },
          callback_url: body.callback_url ?? null, idem: key ?? null, status: 'queued', error_code: null, revision: 1,
          doneRevision: 0, chars: [...text].length, audio_seconds: null, created_at: now(), finished_at: null,
          sentences: text.split(/(?<=[.!?])\s+/).filter(Boolean).map((t, i) => ({
            idx: i, paragraph_idx: 0, text: t, style: null, status: 'pending', takes: 0, score: null,
            duration_s: null, start_s: null, end_s: null, audio: false,
          })),
        };
        state.jobs.set(j.id, j);
        return json(res, 202, { id: j.id, sentences_total: j.sentences.length, estimated_seconds: 12 });
      }
      if (route.startsWith('/v1/jobs/:id')) {
        const j = state.jobs.get(id);
        if (!j) {
          req.resume();
          return fail(res, 404, 'not_found', 'job not found');
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id') return json(res, 200, jobView(j));
        if (req.method === 'DELETE' && route === '/v1/jobs/:id') {
          state.jobs.delete(id);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id/sentences') return json(res, 200, j.sentences.map((s) => sentenceOut(j, s)));
        if (req.method === 'GET' && route === '/v1/jobs/:id/sentences/:idx/audio.wav') {
          const s = j.sentences.find((x) => x.idx === idx);
          if (!s?.audio) return fail(res, 404, 'not_found', 'sentence audio not found');
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV_BYTES.length });
          return res.end(WAV_BYTES);
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders(); // Starlette's StreamingResponse sends headers before the first event
          const script = state.events.get(id) ?? [['job_done', { revision: j.revision }]];
          for (const [event, data] of script) {
            if (event === '__sleep') await sleep(data);
            else res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          return res.end();
        }
        if (req.method === 'POST' && route === '/v1/jobs/:id/sentences/:idx/regenerate') {
          const body = await readJson(req);
          call.body = body;
          if (j.status !== 'done') return fail(res, 409, 'not_regeneratable', `job is ${j.status}; only finished jobs can be regenerated`);
          const s = j.sentences.find((x) => x.idx === idx);
          if (!s) return fail(res, 404, 'not_found', 'sentence not found');
          if (body.text !== undefined && body.text !== null) s.text = body.text;
          if (body.style !== undefined && body.style !== null) s.style = body.style || null;
          s.status = 'pending';
          j.revision += 1;
          j.status = 'queued';
          j.finished_at = null;
          return json(res, 202, { revision: j.revision });
        }
        if (req.method === 'POST' && route === '/v1/jobs/:id/cancel') {
          if (j.status === 'queued') {
            j.status = 'canceled';
            j.finished_at = now();
          } else if (j.status === 'running') {
            j.cancel_requested = true;
          }
          return json(res, 202, { status: 'cancel_requested' });
        }
        if (req.method === 'GET' && route.startsWith('/v1/jobs/:id/files/')) {
          const name = p.split('/').at(-1);
          const rev = Number(url.searchParams.get('revision')) || j.doneRevision;
          if (!FILE_TYPES[name] || !rev || rev > j.doneRevision) return fail(res, 404, 'not_found', 'file not found');
          const bytes = state.fileBytes;
          const headers = {
            'content-type': FILE_TYPES[name], 'accept-ranges': 'bytes',
            'content-disposition': `attachment; filename="${j.id}-r${rev}-${name}"`,
          };
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : bytes.length - 1;
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
            return res.end(bytes.subarray(start, end + 1));
          }
          res.writeHead(200, { ...headers, 'content-length': bytes.length });
          return res.end(bytes);
        }
      }
      return fail(res, 404, 'not_found', 'no such route');
    } catch (err) {
      return fail(res, 500, 'internal_error', String(err));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    addVoice,
    setJob,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
```

- [ ] **Step 3: Write the failing client test**

`web/server/test/clients.test.js`:
```js
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../clients/engine.js';
import { UpstreamUnavailable } from '../clients/http.js';
import { createLqStudio } from '../clients/lqstudio.js';
import { startFakeEngine } from './fakes/fake-engine.js';
import { startFakeLqStudio } from './fakes/fake-lqstudio.js';

const LQ_TOKEN = 'l'.repeat(40);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('upstream clients', () => {
  let lq;
  let eng;
  let lqClient;
  let engine;
  beforeAll(async () => {
    lq = await startFakeLqStudio({
      token: LQ_TOKEN,
      users: [{ id: 'u1', name: 'Ana', email: 'ana@example.com', username: 'ana', password: 'pw', totp: null, verified: true, suspended: false, plan: 'free', paid: false, balance: 100 }],
    });
    eng = await startFakeEngine({ token: 'engine-token' });
    lqClient = createLqStudio({ baseUrl: lq.url, token: LQ_TOKEN });
    engine = createEngine({ baseUrl: eng.url, token: 'engine-token' });
  });
  afterAll(async () => {
    await lq.close();
    await eng.close();
  });

  it('reads the error code from LQ-Studio bodies, including guard rejections', async () => {
    await expect(lqClient.verify({ identifier: 'ana', password: 'bad', ip: '1.2.3.4' }))
      .rejects.toMatchObject({ name: 'UpstreamError', status: 401, code: 'invalid_credentials' });
    await expect(createLqStudio({ baseUrl: lq.url, token: 'w'.repeat(40) }).getUser('u1'))
      .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('reads the error code from engine bodies', async () => {
    await expect(engine.getVoice(crypto.randomUUID())).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('treats 5xx and connection failures as unavailable', async () => {
    lq.state.down = true;
    try {
      await expect(lqClient.getUser('u1')).rejects.toBeInstanceOf(UpstreamUnavailable);
      expect(await lqClient.ping()).toBe(false);
    } finally {
      lq.state.down = false;
    }
    expect(await lqClient.ping()).toBe(true);
    await expect(createEngine({ baseUrl: 'http://127.0.0.1:9', token: 'x' }).getJob(crypto.randomUUID()))
      .rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it('streams an upload to the engine byte-for-byte with its fields', async () => {
    const audio = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const out = await engine.uploadVoice({
      fields: { name: 'Suara "Ana"', owner_ref: 'u1', language: 'id', transcript: undefined },
      filename: 'ana.wav',
      mimeType: 'audio/wav',
      file: Readable.from([audio.subarray(0, 1000), audio.subarray(1000)]),
    });
    expect(out.status).toBe('processing');
    const stored = eng.state.voices.get(out.id);
    expect(stored).toMatchObject({ owner_ref: 'u1', name: 'Suara "Ana"', bytes: audio.length, sha256: sha(audio) });
    expect(stored.fields).not.toHaveProperty('transcript');
  });

  it('aborts a truncated upload so the engine stores nothing', async () => {
    const before = eng.state.voices.size;
    const file = Readable.from([crypto.randomBytes(64 * 1024)]);
    file.truncated = true; // what busboy sets when the size limit was hit
    await expect(engine.uploadVoice({ fields: { name: 'x', owner_ref: 'u1' }, filename: 'x.wav', mimeType: 'audio/wav', file }))
      .rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(eng.state.voices.size).toBe(before);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run server/test/clients.test.js`
Expected: FAIL — cannot load `../clients/engine.js`.

- [ ] **Step 5: Write the clients**

`web/server/clients/http.js`:
```js
export class UpstreamUnavailable extends Error {
  constructor(service, cause, status = null) {
    super(`${service} unavailable${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'UpstreamUnavailable';
    this.service = service;
    this.cause = cause;
    this.status = status;
  }
}

export class UpstreamError extends Error {
  constructor(service, status, code, message, body) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

function errorCode(data, status) {
  if (data?.error && typeof data.error === 'object' && typeof data.error.code === 'string') return data.error.code;
  if (typeof data?.error === 'string' && MACHINE_CODE.test(data.error)) return data.error;
  if (typeof data?.code === 'string') return data.code;
  return `http_${status}`;
}

export async function parseResponse(service, res) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new UpstreamUnavailable(service, err);
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.ok) return data;
  if (res.status >= 500) throw new UpstreamUnavailable(service, new Error(`HTTP ${res.status}`), res.status);
  const message = data?.message ?? data?.error?.message ?? (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
  throw new UpstreamError(service, res.status, errorCode(data, res.status), message, data);
}

export async function requestJson(service, url, { method = 'GET', token, body, headers = {}, timeoutMs = 10000 } = {}) {
  const allHeaders = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamUnavailable(service, err);
  }
  return parseResponse(service, res);
}
```

`web/server/clients/lqstudio.js`:
```js
import { requestJson } from './http.js';

export function createLqStudio({ baseUrl, token, timeoutMs = 10000 }) {
  const call = (method, path, body) =>
    requestJson('lqstudio', `${baseUrl}/api/internal/tts${path}`, { method, token, body, timeoutMs });
  return {
    verify: ({ identifier, password, ip }) => call('POST', '/auth/verify', { identifier, password, ip }),
    verify2fa: ({ challenge, code, ip }) => call('POST', '/auth/verify-2fa', { challenge, code, ip }),
    getUser: (id) => call('GET', `/users/${encodeURIComponent(id)}`),
    hold: ({ userId, amount, ref }) => call('POST', '/credits/hold', { userId, amount, ref }),
    settle: ({ userId, holdId, amount }) => call('POST', '/credits/settle', { userId, holdId, amount }),
    refund: ({ userId, holdId }) => call('POST', '/credits/refund', { userId, holdId }),
    async ping() {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
        await res.body?.cancel();
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
```

`web/server/clients/engine.js`:
```js
import crypto from 'node:crypto';
import { parseResponse, requestJson, UpstreamUnavailable } from './http.js';

export function createEngine({ baseUrl, token, timeoutMs = 15000 }) {
  const call = (method, path, body, headers) =>
    requestJson('engine', `${baseUrl}${path}`, { method, token, body, headers, timeoutMs });
  return {
    async health() {
      try {
        const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(3000) });
        await res.body?.cancel();
        return res.ok ? 'ok' : 'restarting';
      } catch {
        return 'restarting';
      }
    },
    listVoices: (ownerRef) => call('GET', `/v1/voices?owner_ref=${encodeURIComponent(ownerRef)}`),
    getVoice: (id) => call('GET', `/v1/voices/${id}`),
    deleteVoice: (id) => call('DELETE', `/v1/voices/${id}`),
    createJob: ({ voiceId, text, settings, callbackUrl, idempotencyKey }) =>
      call('POST', '/v1/jobs', { voice_id: voiceId, text, settings, callback_url: callbackUrl }, { 'idempotency-key': idempotencyKey }),
    getJob: (id) => call('GET', `/v1/jobs/${id}`),
    sentences: (id) => call('GET', `/v1/jobs/${id}/sentences`),
    regenerate: (id, idx, { text, style }) => call('POST', `/v1/jobs/${id}/sentences/${idx}/regenerate`, { text, style }),
    cancel: (id) => call('POST', `/v1/jobs/${id}/cancel`),
    deleteJob: (id) => call('DELETE', `/v1/jobs/${id}`),

    // Long-lived or binary responses: the caller pipes res.body. Non-2xx answers throw like requestJson.
    async stream(path, { headers = {}, signal } = {}) {
      let res;
      try {
        res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers }, signal });
      } catch (err) {
        throw new UpstreamUnavailable('engine', err);
      }
      if (!res.ok) await parseResponse('engine', res);
      return res;
    },

    // Re-encodes one file plus text fields as multipart and streams it; memory use stays at one chunk.
    async uploadVoice({ fields, filename, mimeType, file, signal }) {
      const boundary = `lqtts-${crypto.randomBytes(16).toString('hex')}`;
      const safeName = String(filename || 'audio').replace(/["\r\n\\]/g, '_');
      async function* parts() {
        for (const [name, value] of Object.entries(fields)) {
          if (value === undefined || value === null || value === '') continue;
          yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
        }
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${safeName}"\r\n`
          + `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
        );
        for await (const chunk of file) yield chunk;
        if (file.truncated) throw new Error('upload exceeded the size limit');
        yield Buffer.from(`\r\n--${boundary}--\r\n`);
      }
      let res;
      try {
        res = await fetch(`${baseUrl}/v1/voices`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: ReadableStream.from(parts()),
          duplex: 'half',
          signal,
        });
      } catch (err) {
        throw new UpstreamUnavailable('engine', err);
      }
      return parseResponse('engine', res);
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/test/clients.test.js`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/clients web/server/test/fakes web/server/test/clients.test.js
git commit -m "web: LQ-Studio and engine clients with streamed upload; fake upstreams"
```

---
### Task 5: Sessions, CSRF, login with 2FA, `/api/me` with a ≤ 5-minute cache

**Files:**
- Create: `web/server/lib/log.js`, `web/server/lib/upstream-errors.js`, `web/server/http/middleware.js`, `web/server/services/sessions.js`, `web/server/services/accounts.js`, `web/server/context.js`, `web/server/app.js`, `web/server/routes/auth.js`, `web/server/routes/me.js`, `web/server/test/helpers.js`
- Test: `web/server/test/auth.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1); `ApiError`, `errorHandler` (Task 2); `createPool`, `migrate` (Task 3); `createLqStudio`, `createEngine`, `UpstreamError`, fakes (Task 4).
- Produces:
  - `log` = `{info(fields, msg), warn(fields, msg), error(fields, msg)}` (JSON lines on stdout). Every module receives the logger as `ctx.log` with this shape.
  - `lqError(err) → ApiError` (known C1 codes pass through, `rate_limited` adds `Retry-After`, anything else → `lqstudio_unavailable`); `engineError(err) → ApiError` (`not_found`, `voice_not_ready`, `not_regeneratable`, `too_large`, `unsupported_audio` pass through; `invalid_text`/`invalid_settings`/`invalid_request` → `invalid_request` with the engine message; anything else → `engine_unavailable`); `isEngineNotFound(err) → bool`.
  - `COOKIE = 'lqtts_sid'`; `readSessionCookie(req) → string|null`; `setSessionCookie(res, raw, config)`; `clearSessionCookie(res, config)`; `clientIp(req) → string`; `csrf` middleware; `requireAuth(ctx)` middleware → sets `req.session` (a `sessions` row) and `req.sessionRaw`.
  - `hashSessionId(raw) → sha256 hex`; `createSessionStore(pool)` → `{create(user, balance) → {raw, session}, find(raw) → row|null, slide(session) → bool, revoke(id), revokeUser(userId), refresh(sessionId, lqUser) → row|null, setBalance(userId, balance), setLang(userId, lang)}`.
  - `ME_CACHE_MS = 300000`; `createAccounts(ctx)` → `{fresh(session) → session row (plan/balance ≤ 5 min old), assertActive(lqUser, userId), voiceLimit(paid) → 3|25, voiceCount(userId) → number|null, me(session) → Me}` where `Me = {id, name, email, plan, paid, lang, balance, voiceLimit, voiceCount, topupUrl}`.
  - `createContext({config, pool, lqstudio, engine, log}) → ctx` with `ctx.sessions`, `ctx.accounts` (later tasks add more).
  - `createApp(ctx, opts) → express app` (Task 6 adds option `healthCacheMs = 10000`, Task 9 adds `sseKeepaliveMs = 15000`; the harness always passes `{healthCacheMs: 0, ...}`).
  - Test helpers: `LQ_TOKEN`, `ENGINE_TOKEN`, `CALLBACK_SECRET`, `USERS` (`ana` free 100, `budi` pro paid 1000, `tfa` TOTP `123456`, `unverified`, `suspended`, `poor` free 0 — user ids equal the keys, email `<id>@example.com`, password `secret-pass`), `startHarness({env, app}) → h` with `h.schema, h.pool, h.lq, h.engine, h.ctx, h.app, h.logs, h.config, h.login(user) → cookie, h.as(cookie) → {get, post, patch, del, upload}, h.close()`; `sessionCookie(res)`; `signCallback(payload, {secret, ts}) → {body, headers}`; `binary`, `text` (supertest parsers).

- [ ] **Step 1: Write the test harness**

`web/server/test/helpers.js`:
```js
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { createEngine } from '../clients/engine.js';
import { createLqStudio } from '../clients/lqstudio.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { createPool, migrate } from '../db/pool.js';
import { testDatabaseUrl } from './db-url.js';
import { startFakeEngine } from './fakes/fake-engine.js';
import { startFakeLqStudio } from './fakes/fake-lqstudio.js';

export const LQ_TOKEN = 'lq-test-token-'.padEnd(40, 'x');
export const ENGINE_TOKEN = 'engine-test-token';
export const CALLBACK_SECRET = 'callback-test-secret';

const user = (id, extra = {}) => ({
  id, name: id, email: `${id}@example.com`, username: id, password: 'secret-pass', totp: null,
  verified: true, suspended: false, plan: 'free', paid: false, balance: 100, ...extra,
});

export const USERS = {
  ana: user('ana'),
  budi: user('budi', { plan: 'pro', paid: true, balance: 1000 }),
  tfa: user('tfa', { totp: '123456' }),
  unverified: user('unverified', { verified: false }),
  suspended: user('suspended', { suspended: true }),
  poor: user('poor', { balance: 0 }),
};

export const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
export const text = (res, cb) => binary(res, (err, buf) => cb(err, buf.toString('utf8')));

export function sessionCookie(res) {
  const line = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('lqtts_sid='));
  if (!line) throw new Error('no session cookie');
  return line.split(';')[0];
}

export function signCallback(payload, { secret = CALLBACK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return { body, headers: { 'content-type': 'application/json', 'x-lq-timestamp': String(ts), 'x-lq-signature': signature } };
}

export async function startHarness({ env = {}, app: appOptions = {} } = {}) {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const pool = createPool(testDatabaseUrl(), schema, { max: 4 });
  await migrate(pool, schema);
  const lq = await startFakeLqStudio({ token: LQ_TOKEN, users: Object.values(USERS) });
  const engine = await startFakeEngine({ token: ENGINE_TOKEN });
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    DB_SCHEMA: schema,
    ENGINE_URL: engine.url,
    ENGINE_TOKEN,
    ENGINE_CALLBACK_SECRET: CALLBACK_SECRET,
    ENGINE_CALLBACK_URL: 'http://127.0.0.1:8750/api/internal/engine-callback',
    LQSTUDIO_URL: lq.url,
    LQSTUDIO_TOKEN: LQ_TOKEN,
    LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
    COOKIE_SECURE: 'false',
    CLIENT_DIST: '/nonexistent-lq-tts-client-dist',
    ...env,
  });
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (fields, msg) => logs.push({ level, msg, ...fields })]));
  const ctx = createContext({
    config, pool, log,
    lqstudio: createLqStudio({ baseUrl: lq.url, token: LQ_TOKEN, timeoutMs: 3000 }),
    engine: createEngine({ baseUrl: engine.url, token: ENGINE_TOKEN, timeoutMs: 3000 }),
  });
  const app = createApp(ctx, { healthCacheMs: 0, ...appOptions });
  return {
    schema, pool, lq, engine, ctx, app, logs, config,
    async login(u = USERS.ana) {
      const res = await request(app).post('/api/auth/login').set('x-requested-with', 'lq-tts')
        .send({ identifier: u.email, password: u.password });
      if (res.body.status !== 'ok') throw new Error(`login failed: ${JSON.stringify(res.body)}`);
      return sessionCookie(res);
    },
    as(cookie) {
      const go = (r) => r.set('cookie', cookie).set('x-requested-with', 'lq-tts');
      return {
        get: (p) => go(request(app).get(p)),
        post: (p, body) => go(request(app).post(p)).send(body ?? {}),
        patch: (p, body) => go(request(app).patch(p)).send(body ?? {}),
        del: (p) => go(request(app).delete(p)),
        upload: (p) => go(request(app).post(p)),
      };
    },
    async close() {
      await lq.close();
      await engine.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

`web/server/test/auth.test.js`:
```js
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USERS, sessionCookie, startHarness } from './helpers.js';

const hash = (cookie) => crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');

describe('auth, sessions and /api/me', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const login = (body, headers = {}) =>
    request(h.app).post('/api/auth/login').set('x-requested-with', 'lq-tts').set(headers).send(body);
  const twofa = (body) => request(h.app).post('/api/auth/2fa').set('x-requested-with', 'lq-tts').send(body);

  it('logs in by username, forwards the end-user IP in the body only, and sets a hardened cookie', async () => {
    const res = await login({ identifier: 'ANA', password: 'secret-pass' }, { 'cf-connecting-ip': '203.0.113.7' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      user: {
        id: 'ana', name: 'ana', email: 'ana@example.com', plan: 'free', paid: false, lang: 'id', balance: 100,
        voiceLimit: 3, voiceCount: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan',
      },
    });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('lqtts_sid='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const verify = h.lq.state.callsTo('/auth/verify').at(-1);
    expect(verify.body).toEqual({ identifier: 'ANA', password: 'secret-pass', ip: '203.0.113.7' });
    expect(verify.headers['cf-connecting-ip']).toBeUndefined();
  });

  it('stores only a hash of the 256-bit session id', async () => {
    const cookie = await h.login();
    const raw = cookie.split('=')[1];
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    const { rows } = await h.pool.query('SELECT id FROM sessions WHERE user_id = $1', ['ana']);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(hash(cookie));
    expect(ids).not.toContain(raw);
  });

  it('asks for 2FA and opens a session only after a valid code', async () => {
    const first = await login({ identifier: 'tfa@example.com', password: 'secret-pass' });
    expect(first.body).toEqual({ status: 'need_2fa', challenge: expect.any(String) });
    expect(first.headers['set-cookie']).toBeUndefined();
    const bad = await twofa({ challenge: first.body.challenge, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_code');
    expect(bad.headers['set-cookie']).toBeUndefined();
    const ok = await twofa({ challenge: first.body.challenge, code: '123456' });
    expect(ok.body.status).toBe('ok');
    expect(ok.body.user.id).toBe('tfa');
    expect((await h.as(sessionCookie(ok)).get('/api/me')).status).toBe(200);
  });

  it.each([
    ['unverified@example.com', 'secret-pass', 200, { status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/login' }],
    ['ana@example.com', 'wrong', 401, { error: { code: 'invalid_credentials', message: 'wrong email/username or password' } }],
    ['suspended@example.com', 'secret-pass', 403, { error: { code: 'suspended', message: 'this account is suspended' } }],
  ])('maps the LQ-Studio answer for %s', async (identifier, password, status, body) => {
    const res = await login({ identifier, password });
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('passes rate limits through with Retry-After', async () => {
    h.lq.state.rateLimited = true;
    try {
      const res = await login({ identifier: 'ana', password: 'x' });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.body.error.code).toBe('rate_limited');
    } finally {
      h.lq.state.rateLimited = false;
    }
  });

  it('reports an LQ-Studio outage as lqstudio_unavailable', async () => {
    h.lq.state.down = true;
    try {
      const res = await login({ identifier: 'ana', password: 'secret-pass' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('lqstudio_unavailable');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('rejects mutating calls without X-Requested-With before doing anything', async () => {
    const before = h.lq.state.calls.length;
    const res = await request(h.app).post('/api/auth/login').send({ identifier: 'ana', password: 'secret-pass' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_request');
    expect(h.lq.state.calls.length).toBe(before);
  });

  it('rejects requests without a valid session', async () => {
    const res = await request(h.app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect((await request(h.app).get('/api/me').set('cookie', 'lqtts_sid=forged')).status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const cookie = await h.login();
    expect((await h.as(cookie).post('/api/auth/logout')).status).toBe(204);
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [hash(cookie)]);
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('slides the 30-day expiry when the session is used', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET expires_at = now() + interval '2 days' WHERE id = $1`, [hash(cookie)]);
    const res = await h.as(cookie).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^lqtts_sid=/);
    const { rows: [row] } = await h.pool.query(
      `SELECT expires_at > now() + interval '29 days' AS slid FROM sessions WHERE id = $1`, [hash(cookie)],
    );
    expect(row.slid).toBe(true);
  });

  it('switches the language and remembers it on the next login', async () => {
    const cookie = await h.login(USERS.budi);
    expect((await h.as(cookie).patch('/api/me', { lang: 'en' })).body.lang).toBe('en');
    expect((await h.as(cookie).patch('/api/me', { lang: 'fr' })).status).toBe(400);
    const again = await h.login(USERS.budi);
    expect((await h.as(again).get('/api/me')).body).toMatchObject({ lang: 'en', plan: 'pro', paid: true, voiceLimit: 25 });
  });

  it('serves plan and balance from a cache of at most 5 minutes', async () => {
    const cookie = await h.login();
    const before = h.lq.state.callsTo('/users/ana').length;
    h.lq.state.users.get('ana').balance = 42;
    try {
      expect((await h.as(cookie).get('/api/me')).body.balance).toBe(100);
      expect(h.lq.state.callsTo('/users/ana').length).toBe(before);
      await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '301 seconds' WHERE id = $1`, [hash(cookie)]);
      expect((await h.as(cookie).get('/api/me')).body.balance).toBe(42);
      expect(h.lq.state.callsTo('/users/ana').length).toBe(before + 1);
    } finally {
      h.lq.state.users.get('ana').balance = 100;
    }
  });

  it('keeps serving the cached copy while LQ-Studio is down', async () => {
    const cookie = await h.login();
    await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '10 minutes' WHERE id = $1`, [hash(cookie)]);
    h.lq.state.down = true;
    try {
      const res = await h.as(cookie).get('/api/me');
      expect(res.status).toBe(200);
      expect(typeof res.body.balance).toBe('number');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('ends every session of an account LQ-Studio now reports suspended', async () => {
    const cookie = await h.login(USERS.poor);
    h.lq.state.users.get('poor').suspended = true;
    try {
      await h.pool.query(`UPDATE sessions SET refreshed_at = now() - interval '10 minutes' WHERE user_id = 'poor'`);
      const res = await h.as(cookie).get('/api/me');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('suspended');
    } finally {
      h.lq.state.users.get('poor').suspended = false;
    }
    expect((await h.as(cookie).get('/api/me')).status).toBe(401);
  });

  it('counts processing and ready voices, not failed ones', async () => {
    const cookie = await h.login(USERS.budi);
    h.engine.addVoice({ owner_ref: 'budi', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'budi', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'budi', status: 'failed', error_code: 'no_clean_speech' });
    expect((await h.as(cookie).get('/api/me')).body.voiceCount).toBe(2);
  });

  it('reports voiceCount null when the engine is unreachable', async () => {
    const cookie = await h.login();
    h.engine.state.failNext.set('GET /v1/voices', { status: 503, code: 'disk_full' });
    const res = await h.as(cookie).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.voiceCount).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run server/test/auth.test.js`
Expected: FAIL — `Failed to load url ../app.js` (imported by `helpers.js`; the app does not exist yet).

- [ ] **Step 4: Write the logger, upstream error mapping, middleware and session store**

`web/server/lib/log.js`:
```js
function write(level, fields, msg) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

export const log = {
  info: (fields, msg) => write('info', fields, msg),
  warn: (fields, msg) => write('warn', fields, msg),
  error: (fields, msg) => write('error', fields, msg),
};
```

`web/server/lib/upstream-errors.js`:
```js
import { UpstreamError } from '../clients/http.js';
import { ApiError } from './errors.js';

const LQ_MESSAGES = {
  invalid_credentials: 'wrong email/username or password',
  invalid_code: 'wrong or expired code',
  suspended: 'this account is suspended',
  insufficient_credits: 'not enough credits — top up on LQ-Studio',
};

export function lqError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamError) {
    if (err.code === 'rate_limited') {
      const wait = Number(err.body?.retryAfter) || 60;
      return new ApiError('rate_limited', `too many attempts, try again in ${wait} s`, { headers: { 'retry-after': String(wait) } });
    }
    if (LQ_MESSAGES[err.code]) return new ApiError(err.code, LQ_MESSAGES[err.code]);
  }
  return new ApiError('lqstudio_unavailable', 'LQ-Studio is temporarily unavailable');
}

const ENGINE_CODES = {
  not_found: 'not_found',
  voice_not_ready: 'voice_not_ready',
  not_regeneratable: 'not_regeneratable',
  too_large: 'too_large',
  unsupported_audio: 'unsupported_audio',
  invalid_text: 'invalid_request',
  invalid_settings: 'invalid_request',
  invalid_request: 'invalid_request',
};

export function engineError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamError && ENGINE_CODES[err.code]) return new ApiError(ENGINE_CODES[err.code], err.message);
  return new ApiError('engine_unavailable', 'the voice engine is unavailable, please try again');
}

export const isEngineNotFound = (err) => err instanceof UpstreamError && err.status === 404;
```

`web/server/http/middleware.js`:
```js
import { ApiError } from '../lib/errors.js';

export const COOKIE = 'lqtts_sid';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readSessionCookie(req) {
  const match = /(?:^|;\s*)lqtts_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
}

export function setSessionCookie(res, raw, config) {
  res.cookie(COOKIE, raw, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: MAX_AGE_MS });
}

export function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
}

export function clientIp(req) {
  const ip = req.get('cf-connecting-ip')?.trim() || req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function csrf(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path === '/internal/engine-callback') return next();
  if (req.get('x-requested-with') !== 'lq-tts') {
    return next(new ApiError('invalid_request', 'missing X-Requested-With: lq-tts header', { status: 403 }));
  }
  return next();
}

export function requireAuth({ sessions, config }) {
  return async (req, res, next) => {
    const raw = readSessionCookie(req);
    const session = await sessions.find(raw);
    if (!session) {
      if (raw) clearSessionCookie(res, config);
      throw new ApiError('unauthorized', 'please log in');
    }
    if (await sessions.slide(session)) setSessionCookie(res, raw, config);
    req.session = session;
    req.sessionRaw = raw;
    next();
  };
}
```

`web/server/services/sessions.js`:
```js
import crypto from 'node:crypto';

export const SESSION_DAYS = 30;
const SLIDE_AFTER_MS = 3600 * 1000;

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
        `INSERT INTO sessions (id, user_id, name, email, plan, paid, lang, balance, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9)) RETURNING *`,
        [hashSessionId(raw), userId, user.name ?? '', user.email ?? '', user.plan ?? 'free', Boolean(user.paid),
          prev?.lang ?? 'id', balance ?? null, SESSION_DAYS],
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
    async refresh(sessionId, user) {
      const { rows } = await pool.query(
        `UPDATE sessions SET name = $2, email = $3, plan = $4, paid = $5, balance = $6, refreshed_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL RETURNING *`,
        [String(user.id), user.name ?? '', user.email ?? '', user.plan ?? 'free', Boolean(user.paid), user.balance ?? null],
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
```

- [ ] **Step 5: Write the account service, context, routers and app**

`web/server/services/accounts.js`:
```js
import { UpstreamError } from '../clients/http.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';

export const ME_CACHE_MS = 5 * 60 * 1000;

export function createAccounts({ sessions, lqstudio, engine, config }) {
  async function assertActive(user, userId) {
    if (user.suspended) {
      await sessions.revokeUser(userId);
      throw new ApiError('suspended', 'this account is suspended');
    }
    if (!user.verified) {
      await sessions.revokeUser(userId);
      throw new ApiError('needs_verification', 'finish verifying your email and phone on LQ-Studio');
    }
  }

  // Plan, paid flag and balance from LQ-Studio, cached on the session row for at most ME_CACHE_MS.
  async function fresh(session) {
    const age = Date.now() - new Date(session.refreshed_at).getTime();
    if (session.balance !== null && age < ME_CACHE_MS) return session;
    let user;
    try {
      user = await lqstudio.getUser(session.user_id);
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        await sessions.revokeUser(session.user_id);
        throw new ApiError('unauthorized', 'account not found');
      }
      if (session.balance !== null) return session; // LQ-Studio down: keep serving the cached copy
      throw lqError(err);
    }
    await assertActive(user, session.user_id);
    return (await sessions.refresh(session.id, user)) ?? session;
  }

  const voiceLimit = (paid) => (paid ? config.voiceLimitPaid : config.voiceLimitFree);

  async function voiceCount(userId) {
    try {
      const voices = await engine.listVoices(userId);
      return voices.filter((v) => v.status === 'processing' || v.status === 'ready').length;
    } catch {
      return null;
    }
  }

  async function me(session) {
    const s = await fresh(session);
    return {
      id: s.user_id, name: s.name, email: s.email, plan: s.plan, paid: s.paid, lang: s.lang, balance: s.balance,
      voiceLimit: voiceLimit(s.paid), voiceCount: await voiceCount(s.user_id), topupUrl: config.topupUrl,
    };
  }

  return { fresh, assertActive, voiceLimit, voiceCount, me };
}
```

`web/server/context.js`:
```js
import { createAccounts } from './services/accounts.js';
import { createSessionStore } from './services/sessions.js';

export function createContext({ config, pool, lqstudio, engine, log }) {
  const ctx = { config, pool, lqstudio, engine, log };
  ctx.sessions = createSessionStore(pool);
  ctx.accounts = createAccounts(ctx);
  return ctx;
}
```

`web/server/routes/auth.js`:
```js
import express from 'express';
import { clearSessionCookie, clientIp, readSessionCookie, setSessionCookie } from '../http/middleware.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';
import { hashSessionId } from '../services/sessions.js';

const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

export function authRouter(ctx) {
  const { lqstudio, sessions, accounts, config } = ctx;
  const router = express.Router();
  const needsVerification = { status: 'needs_verification', verifyUrl: config.verifyUrl };

  async function startSession(res, user) {
    let full;
    try {
      full = await lqstudio.getUser(user.id);
    } catch (err) {
      throw lqError(err);
    }
    if (!full.verified) return needsVerification;
    await accounts.assertActive(full, String(user.id));
    const { raw, session } = await sessions.create({ ...user, ...full }, full.balance);
    setSessionCookie(res, raw, config);
    return { status: 'ok', user: await accounts.me(session) };
  }

  async function answer(res, out) {
    if (out?.status === 'need_2fa') return res.json({ status: 'need_2fa', challenge: out.challenge });
    if (out?.status === 'needs_verification') return res.json(needsVerification);
    if (out?.status !== 'ok' || !out.user) throw new ApiError('lqstudio_unavailable', 'unexpected answer from LQ-Studio');
    return res.json(await startSession(res, out.user));
  }

  router.post('/auth/login', async (req, res) => {
    const { identifier, password } = req.body ?? {};
    if (!isText(identifier, 200) || !isText(password, 200)) throw new ApiError('invalid_request', 'identifier and password are required');
    let out;
    try {
      out = await lqstudio.verify({ identifier: identifier.trim(), password, ip: clientIp(req) });
    } catch (err) {
      throw lqError(err);
    }
    await answer(res, out);
  });

  router.post('/auth/2fa', async (req, res) => {
    const { challenge } = req.body ?? {};
    const code = typeof req.body?.code === 'number' ? String(req.body.code) : req.body?.code;
    if (!isText(challenge, 1000) || !isText(code, 64)) throw new ApiError('invalid_request', 'challenge and code are required');
    let out;
    try {
      out = await lqstudio.verify2fa({ challenge, code: code.trim(), ip: clientIp(req) });
    } catch (err) {
      throw lqError(err);
    }
    await answer(res, out);
  });

  router.post('/auth/logout', async (req, res) => {
    const raw = readSessionCookie(req);
    if (raw) await sessions.revoke(hashSessionId(raw));
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
```

`web/server/routes/me.js`:
```js
import express from 'express';
import { ApiError } from '../lib/errors.js';

export function meRouter({ accounts, sessions }) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    res.json(await accounts.me(req.session));
  });

  router.patch('/me', async (req, res) => {
    const { lang } = req.body ?? {};
    if (lang !== 'id' && lang !== 'en') throw new ApiError('invalid_request', 'lang must be "id" or "en"');
    await sessions.setLang(req.session.user_id, lang);
    res.json(await accounts.me({ ...req.session, lang }));
  });

  return router;
}
```

`web/server/app.js`:
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/test/auth.test.js`
Expected: PASS (19 tests).

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/lib/log.js web/server/lib/upstream-errors.js web/server/http web/server/services/sessions.js web/server/services/accounts.js web/server/context.js web/server/app.js web/server/routes/auth.js web/server/routes/me.js web/server/test/helpers.js web/server/test/auth.test.js
git commit -m "web: LQ-Studio login with 2FA, hashed sliding sessions, CSRF header, cached /api/me"
```

---

### Task 6: Health, client hosting and SPA fallback

**Files:**
- Create: `web/server/routes/health.js`, `web/server/routes/static.js`
- Modify: `web/server/app.js` (full replacement below)
- Test: `web/server/test/health-static.test.js`

**Interfaces:**
- Consumes: `createEngine().health()`, `createLqStudio().ping()` (Task 4); `startHarness` (Task 5).
- Produces: `healthRouter(ctx, {cacheMs})` → `GET /api/health` (no auth, always 200) `{engine:'ok'|'restarting', lqstudio:'ok'|'down', signupUrl}` (`signupUrl` = `config.signupUrl`); `mountClient(app, clientDist) → bool` (serves `client/dist`, `/assets` immutable, unknown `/assets/*` 404, every other non-`/api` GET → `index.html`; does nothing if `index.html` is missing).

- [ ] **Step 1: Write the failing test**

`web/server/test/health-static.test.js`:
```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers.js';

describe('health', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports both upstreams without a session', async () => {
    const res = await request(h.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ engine: 'ok', lqstudio: 'ok', signupUrl: 'https://demo.lq-studio.com/signup' });
  });

  it('reports a restarting engine and a down LQ-Studio, still with 200', async () => {
    h.engine.state.healthStatus = 503;
    h.lq.state.down = true;
    try {
      const res = await request(h.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ engine: 'restarting', lqstudio: 'down', signupUrl: 'https://demo.lq-studio.com/signup' });
    } finally {
      h.engine.state.healthStatus = 200;
      h.lq.state.down = false;
    }
  });

  it('answers unknown API paths with a JSON 404 for signed-in users', async () => {
    const res = await h.as(await h.login()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('client hosting', () => {
  let h;
  let dist;
  beforeAll(async () => {
    dist = await fs.mkdtemp(path.join(os.tmpdir(), 'lqtts-dist-'));
    await fs.mkdir(path.join(dist, 'assets'));
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await fs.writeFile(path.join(dist, 'assets', 'app-1a2b.css'), 'body{margin:0}');
    h = await startHarness({ env: { CLIENT_DIST: dist } });
  });
  afterAll(async () => {
    await h.close();
    await fs.rm(dist, { recursive: true, force: true });
  });

  it('serves hashed assets as immutable', async () => {
    const res = await request(h.app).get('/assets/app-1a2b.css');
    expect(res.status).toBe(200);
    expect(res.text).toBe('body{margin:0}');
    expect(res.headers['cache-control']).toContain('immutable');
    expect((await request(h.app).get('/assets/missing.js')).status).toBe(404);
  });

  it('falls back to index.html for app routes but never for /api', async () => {
    const page = await request(h.app).get('/voices/123');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="root"');
    const api = await request(h.app).get('/api/unknown');
    expect(api.status).toBe(401);
    expect(api.body.error.code).toBe('unauthorized');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/health-static.test.js`
Expected: FAIL — `/api/health` answers 401 (no health route yet) and `/voices/123` answers 404.

- [ ] **Step 3: Write the routes and replace `app.js`**

`web/server/routes/health.js`:
```js
import express from 'express';

export function healthRouter({ engine, lqstudio, config }, { cacheMs = 10000 } = {}) {
  const router = express.Router();
  let cached = null;
  router.get('/health', async (req, res) => {
    if (!cached || Date.now() - cached.at >= cacheMs) {
      cached = {
        at: Date.now(),
        value: Promise.all([engine.health(), lqstudio.ping()])
          .then(([e, l]) => ({ engine: e, lqstudio: l ? 'ok' : 'down', signupUrl: config.signupUrl })),
      };
    }
    res.set('cache-control', 'no-store').json(await cached.value);
  });
  return router;
}
```

`web/server/routes/static.js`:
```js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export function mountClient(app, clientDist) {
  const index = path.join(clientDist, 'index.html');
  if (!fs.existsSync(index)) return false;
  app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  app.use('/assets', (req, res) => res.status(404).end());
  app.use(express.static(clientDist, { index: false }));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.set('cache-control', 'no-cache').sendFile(index);
  });
  return true;
}
```

`web/server/app.js` (replace the whole file):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';

export function createApp(ctx, { healthCacheMs = 10000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/test/health-static.test.js server/test/auth.test.js`
Expected: PASS (5 + 19 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/routes/health.js web/server/routes/static.js web/server/app.js web/server/test/health-static.test.js
git commit -m "web: health endpoint and client hosting with SPA fallback"
```

---
### Task 7: Charges, job creation (hold → engine → refund on failure), history, detail, files, credits

**Files:**
- Create: `web/server/services/charges.js`, `web/server/services/jobs-repo.js`, `web/server/services/ownership.js`, `web/server/http/relay.js`, `web/server/routes/jobs.js`, `web/server/routes/credits.js`
- Modify: `web/server/context.js`, `web/server/app.js` (full replacements below)
- Test: `web/server/test/charges.test.js`, `web/server/test/jobs.test.js`

**Interfaces:**
- Consumes: `ctx.sessions`, `ctx.accounts` (Task 5); `engineError`, `lqError`, `isEngineNotFound` (Task 5); `UpstreamError` (Task 4); pricing helpers (Task 2).
- Produces:
  - `HELD_MIN_AGE_MS = 120000`, `FLAG_AFTER_ATTEMPTS = 10`; `decide(charge, view, now = Date.now()) → 'settle'|'refund'|'wait'` where `view = {status, revision} | null` (null = job gone from the engine).
  - `createCharges(ctx)` → `{insertHeld({userId, jobId?, revision, kind, sentenceIdx?, chars, credits, holdId}) → row | null (null = hold_id already exists), hold(charge) → C1 hold answer (402/404 delete the row and throw; unknown outcome → immediate refund attempt, then throw lqstudio_unavailable), settle(charge), refund(charge), refundNow(charge) (never throws; records failures), recordFailure(charge, err), resolveOne(charge, view) → bool (false = attempt failed), resolveJob(jobId, view, {maxRevision?}) → bool}`.
  - `createJobsRepo(pool)` → `{insertWithCharge({id, userId, voiceId, voiceName, title, chars, chargeId}), own(userId, id) → row+credits | null, get(id), list(userId, {limit, before}), applyEngineState(id, {status, revision, audioSeconds?, finishedAt?}) (ignored when revision < stored revision), markDeleted(id), markVoiceDeleted(userId, voiceId) → [jobId]}`; `toSummary(row) → JobSummary`.
  - `isUuid(v)`, `ownVoice(ctx, userId, voiceId) → engine voice`, `ownJob(ctx, userId, jobId) → jobs row`, `parseIdx(raw) → int` (all failures → `404 not_found`).
  - `relay(res, upstreamResponse)`, `relayEngine(ctx, req, res, enginePath)` (forwards `Range`; copies content-type/length/range, accept-ranges, content-disposition, etag, last-modified).
  - `jobsRouter(ctx)`: `POST /jobs/estimate`, `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/sentences`, `GET /jobs/:id/sentences/:idx/audio`, `GET /jobs/:id/files/:name`; helpers `filesFor(jobId, engineFiles)`, `toSentence(jobId, engineSentence)`.
  - `creditsRouter(ctx)`: `GET /credits`.
  - `ctx.jobsRepo`, `ctx.charges` added by `createContext`.

- [ ] **Step 1: Write the failing tests**

`web/server/test/charges.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { decide } from '../services/charges.js';

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
```

`web/server/test/jobs.test.js`:
```js
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

describe('voiceover jobs', () => {
  let h;
  let ana;
  let budi;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    budi = h.as(await h.login(USERS.budi));
    voice = h.engine.addVoice({ owner_ref: 'ana', name: 'Suara Ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const lastHold = () => h.lq.state.callsTo('/credits/hold').at(-1).body;
  const chargeByRef = async (ref) => (await h.pool.query('SELECT * FROM charges WHERE hold_id = $1', [ref])).rows[0];

  it('estimates characters, credits, rupiah, balance and sentences', async () => {
    const res = await ana.post('/api/jobs/estimate', { text: '  Halo dunia. Apa kabar?  ' });
    expect(res.body).toEqual({ chars: 22, credits: 1, rupiah: 100, balance: 100, sentences: 2 });
    expect((await ana.post('/api/jobs/estimate', { text: '' })).body).toMatchObject({ chars: 0, credits: 0, rupiah: 0 });
    expect((await ana.post('/api/jobs/estimate', { text: 'a'.repeat(20001) })).status).toBe(413);
  });

  it('holds credits, queues the engine job and records both', async () => {
    const text = 'Halo dunia. '.repeat(20).trim(); // 239 chars → 3 credits
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text, settings: { speed: 1.1 } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), credits: 3, estimatedSeconds: 12 });
    const hold = lastHold();
    expect(hold).toEqual({ userId: 'ana', amount: 3, ref: expect.stringMatching(/^tts:[0-9a-f-]{36}:r1$/) });
    const engineJob = h.engine.state.jobs.get(res.body.id);
    expect(engineJob).toMatchObject({ text, callback_url: 'http://127.0.0.1:8750/api/internal/engine-callback', idem: hold.ref.split(':')[1] });
    expect(engineJob.settings.speed).toBe(1.1);
    expect(h.lq.state.users.get('ana').balance).toBe(97);
    expect(await chargeByRef(hold.ref)).toMatchObject({
      user_id: 'ana', job_id: res.body.id, kind: 'job', revision: 1, chars: 239, credits: 3, state: 'held',
    });
    const list = await ana.get('/api/jobs');
    expect(list.body.items[0]).toMatchObject({
      id: res.body.id, title: text.slice(0, 60), voiceId: voice.id, voiceName: 'Suara Ana', status: 'queued',
      chars: 239, credits: 3, revision: 1, audioSeconds: null, finishedAt: null,
    });
  });

  it('queues nothing and keeps no charge when the balance is too low', async () => {
    h.lq.state.users.get('ana').balance = 2;
    const jobsBefore = h.engine.state.jobs.size;
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'x'.repeat(300) });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('insufficient_credits');
    expect(h.engine.state.jobs.size).toBe(jobsBefore);
    expect(await chargeByRef(lastHold().ref)).toBeUndefined();
  });

  it('refunds the hold when the engine rejects the job and shows the engine reason', async () => {
    h.engine.state.failNext.set('POST /v1/jobs', { status: 400, code: 'invalid_settings', message: 'settings.speed: too fast' });
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.', settings: { speed: 9 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'invalid_request', message: 'settings.speed: too fast' });
    const { ref } = lastHold();
    expect(h.lq.state.net(ref)).toBe(0);
    expect(h.lq.state.users.get('ana').balance).toBe(100);
    expect((await chargeByRef(ref)).state).toBe('refunded');
  });

  it('refunds the hold when the engine is down', async () => {
    h.engine.state.failNext.set('POST /v1/jobs', { status: 503, code: 'disk_full' });
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('engine_unavailable');
    expect(h.lq.state.net(lastHold().ref)).toBe(0);
    expect((await chargeByRef(lastHold().ref)).state).toBe('refunded');
  });

  it('holds nothing for a voice that is not ready or not owned', async () => {
    const processing = h.engine.addVoice({ owner_ref: 'ana', status: 'processing' });
    const holds = h.lq.state.callsTo('/credits/hold').length;
    const notReady = await ana.post('/api/jobs', { voiceId: processing.id, text: 'Halo.' });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('voice_not_ready');
    const foreign = await budi.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(foreign.status).toBe(404);
    expect(h.lq.state.callsTo('/credits/hold').length).toBe(holds);
  });

  it('queues nothing when LQ-Studio fails during the hold, and releases the charge', async () => {
    h.lq.state.failNext.set('POST /credits/hold', 1);
    const jobs = h.engine.state.jobs.size;
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('lqstudio_unavailable');
    expect(h.engine.state.jobs.size).toBe(jobs);
    expect((await chargeByRef(lastHold().ref)).state).toBe('refunded');
  });

  it('pages history newest first with limit and before', async () => {
    const own = h.engine.addVoice({ owner_ref: 'budi', name: 'Budi' });
    const ids = [];
    for (const n of [1, 2, 3]) ids.push((await budi.post('/api/jobs', { voiceId: own.id, text: `Kalimat ${n}.` })).body.id);
    const first = await budi.get('/api/jobs?limit=2');
    expect(first.body.items.map((j) => j.id)).toEqual([ids[2], ids[1]]);
    expect(first.body.nextBefore).toBe(first.body.items[1].createdAt);
    const second = await budi.get(`/api/jobs?limit=2&before=${encodeURIComponent(first.body.nextBefore)}`);
    expect(second.body.items.map((j) => j.id)).toEqual([ids[0]]);
    expect(second.body.nextBefore).toBeNull();
    expect((await budi.get('/api/jobs?limit=0')).status).toBe(400);
  });

  it('shows engine progress, files and revisions of a finished job', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu. Dua.' });
    h.engine.setJob(id, { status: 'done', audio_seconds: 3.5 });
    const res = await ana.get(`/api/jobs/${id}`);
    expect(res.body).toMatchObject({
      id, status: 'done', audioSeconds: 3.5, revision: 1, credits: 1, progress: { done: 2, total: 2 }, needsReview: 0,
      revisions: [1], settings: { speed: 0.9 },
      files: {
        'final.mp3': `/api/jobs/${id}/files/final.mp3?revision=1`,
        'final.wav': `/api/jobs/${id}/files/final.wav?revision=1`,
        'subs.srt': `/api/jobs/${id}/files/subs.srt?revision=1`,
        'subs.vtt': `/api/jobs/${id}/files/subs.vtt?revision=1`,
      },
    });
    expect(res.body.finishedAt).not.toBeNull();
    const sentences = await ana.get(`/api/jobs/${id}/sentences`);
    expect(sentences.body[1]).toEqual({
      idx: 1, paragraphIdx: 0, text: 'Dua.', style: null, status: 'done', score: null,
      durationS: null, startS: null, endS: null, audioUrl: `/api/jobs/${id}/sentences/1/audio`,
    });
  });

  it('treats a job the engine no longer has as gone', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Hilang.' });
    h.engine.state.jobs.delete(id);
    expect((await ana.get(`/api/jobs/${id}`)).status).toBe(404);
    expect((await ana.get('/api/jobs')).body.items.find((j) => j.id === id)).toBeUndefined();
  });

  it('streams sentence audio and output files, passing Range through', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu. Dua.' });
    h.engine.setJob(id, { status: 'done' });
    const audio = await ana.get(`/api/jobs/${id}/sentences/0/audio?v=1`).buffer(true).parse(binary); // client cache-buster is ignored
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(audio.body, WAV_BYTES)).toBe(0);
    const part = await ana.get(`/api/jobs/${id}/files/final.mp3?revision=1`).set('range', 'bytes=2-5').buffer(true).parse(binary);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/20');
    expect(part.headers['content-disposition']).toContain(`${id}-r1-final.mp3`);
    expect(part.body.toString()).toBe('2345');
    expect((await ana.get(`/api/jobs/${id}/files/secret.txt`)).status).toBe(404);
    expect((await ana.get(`/api/jobs/${id}/files/final.mp3?revision=abc`)).status).toBe(400);
  });

  it("hides other users' jobs with 404 and never asks the engine", async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Rahasia.' });
    const engineCalls = h.engine.state.calls.length;
    for (const path of [`/api/jobs/${id}`, `/api/jobs/${id}/sentences`, `/api/jobs/${id}/sentences/0/audio`, `/api/jobs/${id}/files/final.mp3`]) {
      const res = await budi.get(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(h.engine.state.calls.length).toBe(engineCalls);
    expect((await budi.get('/api/jobs')).body.items.find((j) => j.id === id)).toBeUndefined();
    expect((await budi.get('/api/jobs/not-a-uuid')).status).toBe(404);
  });

  it('lists only my TTS usage with states and titles on the credits page', async () => {
    const res = await ana.get('/api/credits');
    expect(res.status).toBe(200);
    expect(res.body.topupUrl).toBe('https://demo.lq-studio.com/upgrade-plan');
    expect(typeof res.body.balance).toBe('number');
    const { rows: [{ n }] } = await h.pool.query(`SELECT count(*)::int AS n FROM charges WHERE user_id = 'ana'`);
    expect(res.body.usage).toHaveLength(n);
    expect(res.body.usage[0]).toEqual({
      id: expect.any(String), jobId: expect.any(String), title: expect.any(String), kind: 'job',
      chars: expect.any(Number), credits: expect.any(Number), state: 'held', createdAt: expect.any(String),
    });
    expect(res.body.usage.some((u) => u.state === 'refunded')).toBe(true);
    const budiJobs = new Set((await budi.get('/api/credits')).body.usage.map((u) => u.jobId));
    expect(res.body.usage.some((u) => u.jobId && budiJobs.has(u.jobId))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/test/charges.test.js server/test/jobs.test.js`
Expected: FAIL — cannot load `../services/charges.js`; jobs tests fail (404 `no such endpoint` / missing module).

- [ ] **Step 3: Write the charge service, job repository and ownership helpers**

`web/server/services/charges.js`:
```js
import { UpstreamError } from '../clients/http.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';

export const HELD_MIN_AGE_MS = 2 * 60 * 1000;
export const FLAG_AFTER_ATTEMPTS = 10;

// One rule for callbacks, reconciliation, cancel and delete. view = {status, revision} or null (job gone).
export function decide(charge, view, now = Date.now()) {
  const old = now - new Date(charge.created_at).getTime() >= HELD_MIN_AGE_MS;
  if (charge.job_id === null) return old ? 'refund' : 'wait';
  if (view === null) return 'refund';
  if (charge.revision < view.revision) return 'settle';
  if (charge.revision > view.revision) return old ? 'refund' : 'wait';
  if (view.status === 'done') return 'settle';
  if (view.status === 'failed' || view.status === 'canceled') return 'refund';
  return 'wait';
}

export function createCharges({ pool, lqstudio, sessions, log }) {
  async function insertHeld({ userId, jobId = null, revision, kind, sentenceIdx = null, chars, credits, holdId }) {
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [userId, jobId, revision, kind, sentenceIdx, chars, credits, holdId],
      );
      return row;
    } catch (err) {
      if (err.code === '23505') return null;
      throw err;
    }
  }

  async function finish(charge, state, balance) {
    await pool.query(
      `UPDATE charges SET state = $2, resolved_at = now(), last_error = NULL WHERE id = $1 AND state = 'held'`,
      [charge.id, state],
    );
    if (typeof balance === 'number') await sessions.setBalance(charge.user_id, balance);
    log.info({ event: `charge_${state}`, chargeId: charge.id, holdId: charge.hold_id, credits: charge.credits }, `charge ${state}`);
  }

  async function settle(charge) {
    const out = await lqstudio.settle({ userId: charge.user_id, holdId: charge.hold_id, amount: charge.credits });
    await finish(charge, 'settled', out?.balance);
  }

  async function refund(charge) {
    let out;
    try {
      out = await lqstudio.refund({ userId: charge.user_id, holdId: charge.hold_id });
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        await finish(charge, 'refunded', null); // LQ-Studio holds nothing for this ref: nothing to give back
        return;
      }
      throw err;
    }
    await finish(charge, 'refunded', out?.balance);
  }

  async function recordFailure(charge, err) {
    const { rows: [row] } = await pool.query(
      'UPDATE charges SET attempts = attempts + 1, last_error = $2 WHERE id = $1 RETURNING attempts, flagged_at',
      [charge.id, String(err?.message ?? err).slice(0, 500)],
    );
    log.warn({ event: 'charge_attempt_failed', chargeId: charge.id, holdId: charge.hold_id, attempts: row?.attempts, error: String(err?.message ?? err) }, 'charge resolution failed');
    if (row && row.attempts >= FLAG_AFTER_ATTEMPTS && row.flagged_at === null) {
      await pool.query('UPDATE charges SET flagged_at = now() WHERE id = $1', [charge.id]);
      log.error(
        { event: 'charge_flagged', chargeId: charge.id, holdId: charge.hold_id, userId: charge.user_id, credits: charge.credits, attempts: row.attempts },
        'charge needs manual review',
      );
    }
  }

  async function refundNow(charge) {
    try {
      await refund(charge);
    } catch (err) {
      await recordFailure(charge, err);
    }
  }

  async function hold(charge) {
    let out;
    try {
      out = await lqstudio.hold({ userId: charge.user_id, amount: charge.credits, ref: charge.hold_id });
    } catch (err) {
      if (err instanceof UpstreamError && (err.code === 'insufficient_credits' || err.code === 'not_found')) {
        await pool.query(`DELETE FROM charges WHERE id = $1 AND state = 'held'`, [charge.id]);
        if (err.code === 'not_found') {
          await sessions.revokeUser(charge.user_id);
          throw new ApiError('unauthorized', 'account not found');
        }
        throw lqError(err);
      }
      await refundNow(charge); // outcome unknown: give back whatever may have been taken
      throw lqError(err);
    }
    if (typeof out?.balance === 'number') await sessions.setBalance(charge.user_id, out.balance);
    return out;
  }

  async function resolveOne(charge, view) {
    const action = decide(charge, view);
    if (action === 'wait') return true;
    try {
      if (action === 'settle') await settle(charge);
      else await refund(charge);
      return true;
    } catch (err) {
      await recordFailure(charge, err);
      return false;
    }
  }

  async function resolveJob(jobId, view, { maxRevision = 2147483647 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE job_id = $1 AND state = 'held' AND revision <= $2 ORDER BY id`, [jobId, maxRevision],
    );
    let ok = true;
    for (const charge of rows) ok = (await resolveOne(charge, view)) && ok;
    return ok;
  }

  return { insertHeld, hold, settle, refund, refundNow, recordFailure, resolveOne, resolveJob };
}
```

`web/server/services/jobs-repo.js`:
```js
const WITH_CREDITS = `j.*, coalesce((SELECT sum(c.credits) FROM charges c WHERE c.job_id = j.id AND c.state <> 'refunded'), 0)::int AS credits`;

export const toSummary = (r) => ({
  id: r.id, title: r.title, voiceId: r.voice_id, voiceName: r.voice_name, status: r.status, chars: r.chars,
  credits: r.credits, audioSeconds: r.audio_seconds, revision: r.revision, createdAt: r.created_at, finishedAt: r.finished_at,
});

export function createJobsRepo(pool) {
  return {
    async insertWithCharge({ id, userId, voiceId, voiceName, title, chars, chargeId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status, revision)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', 1)`,
          [id, userId, voiceId, voiceName, title, chars],
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
    async list(userId, { limit, before }) {
      const { rows } = await pool.query(
        `SELECT ${WITH_CREDITS} FROM jobs j
         WHERE j.user_id = $1 AND j.deleted_at IS NULL AND ($2::timestamptz IS NULL OR j.created_at < $2)
         ORDER BY j.created_at DESC LIMIT $3`,
        [userId, before, limit],
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
```

`web/server/services/ownership.js`:
```js
import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

export async function ownVoice({ engine }, userId, voiceId) {
  if (!isUuid(voiceId)) throw new ApiError('not_found', 'voice not found');
  let voice;
  try {
    voice = await engine.getVoice(voiceId.toLowerCase());
  } catch (err) {
    throw engineError(err);
  }
  if (voice.owner_ref !== String(userId)) throw new ApiError('not_found', 'voice not found');
  return voice;
}

export async function ownJob({ jobsRepo }, userId, jobId) {
  if (!isUuid(jobId)) throw new ApiError('not_found', 'job not found');
  const job = await jobsRepo.own(userId, jobId.toLowerCase());
  if (!job) throw new ApiError('not_found', 'job not found');
  return job;
}

export function parseIdx(raw) {
  if (!/^\d{1,6}$/.test(String(raw))) throw new ApiError('not_found', 'sentence not found');
  return Number(raw);
}
```

- [ ] **Step 4: Write the relay, the routers, and replace `context.js` and `app.js`**

`web/server/http/relay.js`:
```js
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { engineError } from '../lib/upstream-errors.js';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag'];

export async function relay(res, upstream) {
  res.status(upstream.status);
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('cache-control', 'no-store');
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    res.destroy(); // the browser went away mid-download
  }
}

export async function relayEngine(ctx, req, res, enginePath) {
  const range = req.get('range');
  let upstream;
  try {
    upstream = await ctx.engine.stream(enginePath, { headers: range ? { range } : {} });
  } catch (err) {
    throw engineError(err);
  }
  await relay(res, upstream);
}
```

`web/server/routes/jobs.js`:
```js
import crypto from 'node:crypto';
import express from 'express';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { countChars, countSentences, creditsFor, makeTitle, rupiahFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { toSummary } from '../services/jobs-repo.js';
import { ownJob, ownVoice, parseIdx } from '../services/ownership.js';

const FILE_NAMES = new Set(['final.mp3', 'final.wav', 'subs.srt', 'subs.vtt']);

function readText(value, max) {
  if (typeof value !== 'string') throw new ApiError('invalid_request', 'text is required');
  const text = value.trim();
  const chars = countChars(text);
  if (chars > max) throw new ApiError('too_large', 'text exceeds 20,000 characters');
  return { text, chars };
}

export function filesFor(jobId, engineFiles) {
  const out = {};
  for (const [name, url] of Object.entries(engineFiles ?? {})) {
    const rev = new URL(url, 'http://engine').searchParams.get('revision');
    out[name] = `/api/jobs/${jobId}/files/${name}${rev ? `?revision=${rev}` : ''}`;
  }
  return out;
}

export const toSentence = (jobId, s) => ({
  idx: s.idx, paragraphIdx: s.paragraph_idx, text: s.text, style: s.style, status: s.status, score: s.score,
  durationS: s.duration_s, startS: s.start_s, endS: s.end_s,
  audioUrl: s.audio_url ? `/api/jobs/${jobId}/sentences/${s.idx}/audio` : null,
});

export function jobsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo } = ctx;
  const router = express.Router();

  router.post('/jobs/estimate', async (req, res) => {
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    const credits = chars === 0 ? 0 : creditsFor(chars);
    const session = await accounts.fresh(req.session);
    res.json({ chars, credits, rupiah: rupiahFor(credits), balance: session.balance, sentences: countSentences(text) });
  });

  router.post('/jobs', async (req, res) => {
    const { voiceId, settings = {} } = req.body ?? {};
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    if (chars === 0) throw new ApiError('invalid_request', 'text is empty');
    if (typeof voiceId !== 'string') throw new ApiError('invalid_request', 'voiceId is required');
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new ApiError('invalid_request', 'settings must be an object');
    }
    const userId = req.session.user_id;
    await accounts.fresh(req.session);
    const voice = await ownVoice(ctx, userId, voiceId);
    if (voice.status !== 'ready') throw new ApiError('voice_not_ready', `voice is ${voice.status}`);
    const credits = creditsFor(chars);
    const key = crypto.randomUUID();
    const charge = await charges.insertHeld({ userId, revision: 1, kind: 'job', chars, credits, holdId: `tts:${key}:r1` });
    await charges.hold(charge);
    let created;
    try {
      created = await engine.createJob({ voiceId: voice.id, text, settings, callbackUrl: config.engineCallbackUrl, idempotencyKey: key });
    } catch (err) {
      await charges.refundNow(charge);
      throw engineError(err);
    }
    await jobsRepo.insertWithCharge({
      id: created.id, userId, voiceId: voice.id, voiceName: voice.name, title: makeTitle(text), chars, chargeId: charge.id,
    });
    res.status(202).json({ id: created.id, credits, estimatedSeconds: created.estimated_seconds });
  });

  router.get('/jobs', async (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_request', 'limit must be 1-100');
    let before = null;
    if (req.query.before !== undefined) {
      before = new Date(String(req.query.before));
      if (Number.isNaN(before.getTime())) throw new ApiError('invalid_request', 'before must be an ISO date');
    }
    const rows = await jobsRepo.list(req.session.user_id, { limit, before });
    res.json({ items: rows.map(toSummary), nextBefore: rows.length === limit ? rows.at(-1).created_at.toISOString() : null });
  });

  router.get('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    let view;
    try {
      view = await engine.getJob(job.id);
    } catch (err) {
      if (isEngineNotFound(err)) {
        await jobsRepo.markDeleted(job.id);
        throw new ApiError('not_found', 'job not found');
      }
      throw engineError(err);
    }
    await jobsRepo.applyEngineState(job.id, {
      status: view.status, revision: view.revision, audioSeconds: view.audio_seconds, finishedAt: view.finished_at,
    });
    const row = await jobsRepo.own(req.session.user_id, job.id);
    res.json({
      ...toSummary(row),
      progress: view.progress,
      needsReview: view.needs_review,
      settings: view.settings,
      files: filesFor(job.id, view.files),
      revisions: Array.from({ length: view.revision }, (_, i) => i + 1),
    });
  });

  router.get('/jobs/:id/sentences', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    let list;
    try {
      list = await engine.sentences(job.id);
    } catch (err) {
      throw engineError(err);
    }
    res.json(list.map((s) => toSentence(job.id, s)));
  });

  router.get('/jobs/:id/sentences/:idx/audio', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    const idx = parseIdx(req.params.idx);
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/sentences/${idx}/audio.wav`);
  });

  router.get('/jobs/:id/files/:name', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    if (!FILE_NAMES.has(req.params.name)) throw new ApiError('not_found', 'unknown file');
    const rev = req.query.revision;
    if (rev !== undefined && !/^[1-9]\d{0,5}$/.test(String(rev))) throw new ApiError('invalid_request', 'revision must be a positive integer');
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/files/${req.params.name}${rev ? `?revision=${rev}` : ''}`);
  });

  return router;
}
```

`web/server/routes/credits.js`:
```js
import express from 'express';

export function creditsRouter({ accounts, pool, config }) {
  const router = express.Router();
  router.get('/credits', async (req, res) => {
    const session = await accounts.fresh(req.session);
    const { rows } = await pool.query(
      `SELECT c.id, c.job_id, j.title, c.kind, c.chars, c.credits, c.state, c.created_at
       FROM charges c LEFT JOIN jobs j ON j.id = c.job_id
       WHERE c.user_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
      [req.session.user_id],
    );
    res.json({
      balance: session.balance,
      topupUrl: config.topupUrl,
      usage: rows.map((r) => ({
        id: String(r.id), jobId: r.job_id, title: r.title, kind: r.kind, chars: r.chars, credits: r.credits,
        state: r.state, createdAt: r.created_at,
      })),
    });
  });
  return router;
}
```

`web/server/context.js` (replace the whole file):
```js
import { createAccounts } from './services/accounts.js';
import { createCharges } from './services/charges.js';
import { createJobsRepo } from './services/jobs-repo.js';
import { createSessionStore } from './services/sessions.js';

export function createContext({ config, pool, lqstudio, engine, log }) {
  const ctx = { config, pool, lqstudio, engine, log };
  ctx.sessions = createSessionStore(pool);
  ctx.accounts = createAccounts(ctx);
  ctx.jobsRepo = createJobsRepo(pool);
  ctx.charges = createCharges(ctx);
  return ctx;
}
```

`web/server/app.js` (replace the whole file):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { creditsRouter } from './routes/credits.js';
import { healthRouter } from './routes/health.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';

export function createApp(ctx, { healthCacheMs = 10000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/test/charges.test.js server/test/jobs.test.js`
Expected: PASS (11 + 13 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/services/charges.js web/server/services/jobs-repo.js web/server/services/ownership.js web/server/http/relay.js web/server/routes/jobs.js web/server/routes/credits.js web/server/context.js web/server/app.js web/server/test/charges.test.js web/server/test/jobs.test.js
git commit -m "web: hold-before-queue job creation with refund on engine failure; history, files, credits"
```

---

### Task 8: Regenerate one sentence, cancel, delete

**Files:**
- Create: `web/server/routes/job-actions.js`
- Modify: `web/server/app.js` (full replacement below)
- Test: `web/server/test/job-actions.test.js`

**Interfaces:**
- Consumes: `ctx.charges` (`insertHeld`, `hold`, `refundNow`, `resolveJob`), `ctx.jobsRepo` (`applyEngineState`, `markDeleted`), `ownJob`, `parseIdx` (Task 7); `engineError`, `isEngineNotFound` (Task 5); pricing (Task 2).
- Produces: `jobActionsRouter(ctx)` with `POST /jobs/:id/sentences/:idx/regenerate` `{text?, style?}` → 202 `{revision, credits}`; `POST /jobs/:id/cancel` → 202 `{status:'cancel_requested'}`; `DELETE /jobs/:id` → 204.

- [ ] **Step 1: Write the failing test**

`web/server/test/job-actions.test.js`:
```js
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS, startHarness } from './helpers.js';

describe('regenerate, cancel and delete', () => {
  let h;
  let ana;
  let budi;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    budi = h.as(await h.login(USERS.budi));
    voice = h.engine.addVoice({ owner_ref: 'ana', name: 'Suara Ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const newJob = async (text = 'Satu. Dua.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const doneJob = async (text) => {
    const id = await newJob(text);
    h.engine.setJob(id, { status: 'done' });
    return id;
  };
  const charges = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;
  const holdsFor = (prefix) => h.lq.state.callsTo('/credits/hold').filter((c) => c.body.ref.startsWith(prefix));

  it('holds credits for one sentence and queues a new revision', async () => {
    const id = await doneJob();
    const res = await ana.post(`/api/jobs/${id}/sentences/1/regenerate`, { text: ' Dua lagi. ', style: 'calm' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ revision: 2, credits: 1 });
    expect(holdsFor(`tts:${id}:`).at(-1).body).toEqual({ userId: 'ana', amount: 1, ref: `tts:${id}:r2:s1` });
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').at(-1).body).toEqual({ text: 'Dua lagi.', style: 'calm' });
    expect((await charges(id)).at(-1)).toMatchObject({ kind: 'regenerate', revision: 2, sentence_idx: 1, chars: 9, credits: 1, state: 'held' });
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'queued', revision: 2, credits: 2 });
  });

  it('refuses unfinished jobs before holding anything', async () => {
    const id = await newJob();
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(0);
    expect((await ana.post(`/api/jobs/${await doneJob()}/sentences/9/regenerate`, {})).status).toBe(404);
  });

  it('refunds when the engine rejects the regeneration and uses a fresh ref for the retry', async () => {
    const id = await doneJob();
    h.engine.state.failNext.set('POST /v1/jobs/:id/sentences/:idx/regenerate', { status: 400, code: 'invalid_text', message: 'text must be exactly one sentence' });
    const bad = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, { text: 'Satu. Dua.' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: 'invalid_request', message: 'text must be exactly one sentence' });
    expect(h.lq.state.net(`tts:${id}:r2:s0`)).toBe(0);
    expect((await charges(id)).at(-1).state).toBe('refunded');
    const retry = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(retry.status).toBe(202);
    expect(holdsFor(`tts:${id}:`).at(-1).body.ref).toBe(`tts:${id}:r2:s0:a2`);
    expect(h.lq.state.net(`tts:${id}:r2:s0:a2`)).toBe(1);
  });

  it('answers 402 and queues nothing when the balance is too low', async () => {
    const id = await doneJob();
    h.lq.state.users.get('ana').balance = 0;
    const regenCalls = h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length;
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('insufficient_credits');
    expect(h.engine.state.callsTo('POST', '/v1/jobs/:id/sentences/:idx/regenerate').length).toBe(regenCalls);
    expect((await charges(id)).filter((c) => c.kind === 'regenerate')).toHaveLength(0);
  });

  it('refuses a second regeneration of a sentence while one is held', async () => {
    const id = await doneJob();
    await h.pool.query(
      `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id)
       VALUES ('ana', $1, 2, 'regenerate', 0, 4, 1, $2)`,
      [id, `tts:${id}:r2:s0`],
    );
    const res = await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_regeneratable');
    expect(holdsFor(`tts:${id}:`)).toHaveLength(0);
  });

  it('cancelling a queued job refunds it at once', async () => {
    const id = await newJob();
    const res = await ana.post(`/api/jobs/${id}/cancel`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'cancel_requested' });
    expect(h.engine.state.jobs.get(id).status).toBe('canceled');
    expect((await charges(id))[0].state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('cancelling a running job leaves the hold for the callback', async () => {
    const id = await newJob();
    h.engine.setJob(id, { status: 'running' });
    expect((await ana.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    expect((await charges(id))[0].state).toBe('held');
  });

  it('deleting a queued job refunds it and hides it', async () => {
    const id = await newJob();
    expect((await ana.del(`/api/jobs/${id}`)).status).toBe(204);
    expect(h.engine.state.jobs.has(id)).toBe(false);
    expect((await charges(id))[0].state).toBe('refunded');
    expect((await ana.get(`/api/jobs/${id}`)).status).toBe(404);
  });

  it('deleting a finished job whose callback was lost settles it', async () => {
    const id = await doneJob();
    expect((await ana.del(`/api/jobs/${id}`)).status).toBe(204);
    const [c] = await charges(id);
    expect(c.state).toBe('settled');
    expect(h.lq.state.callsTo('/credits/settle').at(-1).body).toEqual({ userId: 'ana', holdId: c.hold_id, amount: 1 });
  });

  it("refuses to touch another user's job", async () => {
    const id = await doneJob();
    for (const res of [
      await budi.post(`/api/jobs/${id}/sentences/0/regenerate`, {}),
      await budi.post(`/api/jobs/${id}/cancel`),
      await budi.del(`/api/jobs/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(h.engine.state.jobs.get(id).status).toBe('done');
    expect((await charges(id))[0].state).toBe('held');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/job-actions.test.js`
Expected: FAIL — the action routes answer `404 no such endpoint`.

- [ ] **Step 3: Write `web/server/routes/job-actions.js` and replace `app.js`**

`web/server/routes/job-actions.js`:
```js
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { countChars, creditsFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { ownJob, parseIdx } from '../services/ownership.js';

export function jobActionsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo, pool } = ctx;
  const router = express.Router();

  async function engineView(jobId) {
    try {
      return await engine.getJob(jobId);
    } catch (err) {
      if (isEngineNotFound(err)) return null;
      throw engineError(err);
    }
  }

  router.post('/jobs/:id/sentences/:idx/regenerate', async (req, res) => {
    const userId = req.session.user_id;
    const job = await ownJob(ctx, userId, req.params.id);
    const idx = parseIdx(req.params.idx);
    const { text, style } = req.body ?? {};
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || countChars(text.trim()) > config.maxTextChars)) {
      throw new ApiError('invalid_request', 'text must be one non-empty sentence');
    }
    if (style !== undefined && (typeof style !== 'string' || style.length > 200)) {
      throw new ApiError('invalid_request', 'style must be a string of at most 200 characters');
    }
    await accounts.fresh(req.session);
    const view = await engineView(job.id);
    if (!view) throw new ApiError('not_found', 'job not found');
    if (view.status !== 'done') throw new ApiError('not_regeneratable', `job is ${view.status}; only finished jobs can be regenerated`);
    let sentences;
    try {
      sentences = await engine.sentences(job.id);
    } catch (err) {
      throw engineError(err);
    }
    const sentence = sentences.find((s) => s.idx === idx);
    if (!sentence) throw new ApiError('not_found', 'sentence not found');

    const newText = text?.trim();
    const chars = countChars(newText ?? sentence.text);
    const credits = creditsFor(chars);
    const revision = view.revision + 1;
    const base = `tts:${job.id}:r${revision}:s${idx}`;
    const { rows: [prior] } = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'held')::int AS held
       FROM charges WHERE hold_id = $1 OR hold_id LIKE $2`,
      [base, `${base}:a%`],
    );
    if (prior.held > 0) throw new ApiError('not_regeneratable', 'this sentence is already being regenerated');
    const holdId = prior.n === 0 ? base : `${base}:a${prior.n + 1}`;
    const charge = await charges.insertHeld({ userId, jobId: job.id, revision, kind: 'regenerate', sentenceIdx: idx, chars, credits, holdId });
    if (!charge) throw new ApiError('not_regeneratable', 'this sentence is already being regenerated');
    await charges.hold(charge);
    let out;
    try {
      out = await engine.regenerate(job.id, idx, { text: newText, style });
    } catch (err) {
      await charges.refundNow(charge);
      throw engineError(err);
    }
    await jobsRepo.applyEngineState(job.id, { status: 'queued', revision: out.revision });
    res.status(202).json({ revision: out.revision, credits });
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    try {
      await engine.cancel(job.id);
    } catch (err) {
      throw engineError(err);
    }
    // A queued job is canceled on the spot and the engine sends no callback for it.
    const view = await engineView(job.id).catch(() => null);
    if (view && ['done', 'failed', 'canceled'].includes(view.status)) {
      await jobsRepo.applyEngineState(job.id, { status: view.status, revision: view.revision, finishedAt: view.finished_at });
      await charges.resolveJob(job.id, { status: view.status, revision: view.revision });
    }
    res.status(202).json({ status: 'cancel_requested' });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    const view = await engineView(job.id);
    if (view) {
      try {
        await engine.deleteJob(job.id);
      } catch (err) {
        if (!isEngineNotFound(err)) throw engineError(err);
      }
    }
    await jobsRepo.markDeleted(job.id);
    // Deleting stops queued/running work without a callback: settle what finished, refund the rest.
    let finalView = null;
    if (view) {
      const stopped = view.status === 'queued' || view.status === 'running';
      finalView = { status: stopped ? 'canceled' : view.status, revision: view.revision };
    }
    await charges.resolveJob(job.id, finalView);
    res.status(204).end();
  });

  return router;
}
```

`web/server/app.js` (replace the whole file):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { creditsRouter } from './routes/credits.js';
import { healthRouter } from './routes/health.js';
import { jobActionsRouter } from './routes/job-actions.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';

export function createApp(ctx, { healthCacheMs = 10000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', jobActionsRouter(ctx));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/job-actions.test.js server/test/jobs.test.js`
Expected: PASS (10 + 13 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/routes/job-actions.js web/server/app.js web/server/test/job-actions.test.js
git commit -m "web: per-sentence regenerate with its own hold, cancel and delete with refunds"
```

---

### Task 9: Live progress (SSE relay)

**Files:**
- Create: `web/server/routes/events.js`
- Modify: `web/server/app.js` (full replacement below)
- Test: `web/server/test/events.test.js`

**Interfaces:**
- Consumes: `ownJob` (Task 7); `ctx.engine.stream` (Task 4); `engineError` (Task 5).
- Produces: `translateEvent(block) → string | null` (renames `job_failed.error_code` → `errorCode`; other events unchanged); `eventsRouter(ctx, {keepaliveMs = 15000})` → `GET /jobs/:id/events` (`text/event-stream`; events `sentence_done {idx,status,score,revision}`, `job_done {revision}`, `job_failed {status,errorCode}`; `: keepalive` comment every `keepaliveMs`); `createApp(ctx, {healthCacheMs, sseKeepaliveMs})`.

- [ ] **Step 1: Write the failing test**

`web/server/test/events.test.js`:
```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USERS, startHarness, text } from './helpers.js';

describe('job events', () => {
  let h;
  let ana;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('relays engine events and renames error_code to errorCode', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.events.set(id, [
      ['sentence_done', { idx: 0, status: 'done', score: 0.97, revision: 1 }],
      ['job_failed', { status: 'failed', error_code: 'synthesis_failed' }],
    ]);
    const res = await ana.get(`/api/jobs/${id}/events`).buffer(true).parse(text);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.body).toBe(
      'event: sentence_done\ndata: {"idx":0,"status":"done","score":0.97,"revision":1}\n\n'
      + 'event: job_failed\ndata: {"status":"failed","errorCode":"synthesis_failed"}\n\n',
    );
  });

  it("hides another user's event stream", async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    const budi = h.as(await h.login(USERS.budi));
    expect((await budi.get(`/api/jobs/${id}/events`)).status).toBe(404);
  });

  it('reports an engine outage before the stream starts', async () => {
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.failNext.set('GET /v1/jobs/:id/events', { status: 503, code: 'disk_full' });
    const res = await ana.get(`/api/jobs/${id}/events`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('engine_unavailable');
  });
});

describe('job events keepalive', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness({ app: { sseKeepaliveMs: 20 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('writes keepalive comments while the engine is quiet', async () => {
    const ana = h.as(await h.login(USERS.ana));
    const voice = h.engine.addVoice({ owner_ref: 'ana' });
    const { body: { id } } = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu.' });
    h.engine.state.events.set(id, [['__sleep', 150], ['job_done', { revision: 1 }]]);
    const res = await ana.get(`/api/jobs/${id}/events`).buffer(true).parse(text);
    expect(res.body).toMatch(/^(: keepalive\n\n)+event: job_done\ndata: \{"revision":1\}\n\n$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/events.test.js`
Expected: FAIL — `/api/jobs/:id/events` answers `404 no such endpoint`.

- [ ] **Step 3: Write `web/server/routes/events.js` and replace `app.js`**

`web/server/routes/events.js`:
```js
import express from 'express';
import { engineError } from '../lib/upstream-errors.js';
import { ownJob } from '../services/ownership.js';

export function translateEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  let payload;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (event === 'job_failed') payload = { status: payload.status, errorCode: payload.error_code ?? null };
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function eventsRouter(ctx, { keepaliveMs = 15000 } = {}) {
  const router = express.Router();
  router.get('/jobs/:id/events', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let upstream;
    try {
      upstream = await ctx.engine.stream(`/v1/jobs/${job.id}/events`, { signal: abort.signal });
    } catch (err) {
      throw engineError(err);
    }
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
    }, keepaliveMs);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const out = translateEvent(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          if (out) res.write(out);
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // the browser or the engine went away; the browser's EventSource reconnects
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  });
  return router;
}
```

`web/server/app.js` (replace the whole file):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { creditsRouter } from './routes/credits.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { jobActionsRouter } from './routes/job-actions.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';

export function createApp(ctx, { healthCacheMs = 10000, sseKeepaliveMs = 15000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', jobActionsRouter(ctx));
  app.use('/api', eventsRouter(ctx, { keepaliveMs: sseKeepaliveMs }));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/events.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/routes/events.js web/server/app.js web/server/test/events.test.js
git commit -m "web: SSE relay of engine job events with keepalive"
```

---
### Task 10: Voices — streamed upload with consent and plan limit, preview, delete

**Files:**
- Create: `web/server/routes/voices.js`
- Modify: `web/server/app.js` (full replacement below)
- Test: `web/server/test/voices.test.js`

**Interfaces:**
- Consumes: `ctx.accounts` (`fresh`, `voiceCount`, `voiceLimit`) (Task 5); `ctx.engine.uploadVoice`, `listVoices`, `deleteVoice` (Task 4); `ownVoice`, `relayEngine`, `ctx.jobsRepo.markVoiceDeleted`, `ctx.charges.resolveJob` (Task 7); `clientIp` (Task 5).
- Produces: `toVoice(engineVoice) → {id, name, language, status, errorCode, refSeconds, createdAt, previewUrl}`; `voicesRouter(ctx)`: `GET /voices`, `POST /voices` (multipart: `name`, `language?` (`auto`|`id`|`en`), `transcript?`, `consent="true"` **before** `audio`) → 202 `{id, status}`, `GET /voices/:id/preview` (audio/wav), `DELETE /voices/:id` → 204 (also hides the voice's jobs and refunds their held charges, because the engine deletes them).

- [ ] **Step 1: Write the failing test**

`web/server/test/voices.test.js`:
```js
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WAV_BYTES } from './fakes/fake-engine.js';
import { USERS, binary, startHarness } from './helpers.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function upload(client, { fields = { name: 'Suara Saya', consent: 'true' }, file = Buffer.alloc(4096, 1), filename = 'me.wav', headers = {} } = {}) {
  let req = client.upload('/api/voices').set(headers);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req.attach('audio', file, filename);
}

describe('voices', () => {
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
  const engineUploads = () => h.engine.state.callsTo('POST', '/v1/voices').length;

  it('lists only my voices in the browser shape', async () => {
    const mine = h.engine.addVoice({ owner_ref: 'ana', name: 'A' });
    h.engine.addVoice({ owner_ref: 'budi', name: 'B' });
    const res = await ana.get('/api/voices');
    expect(res.body).toEqual([{
      id: mine.id, name: 'A', language: 'id', status: 'ready', errorCode: null, refSeconds: 12.5,
      createdAt: mine.created_at, previewUrl: `/api/voices/${mine.id}/preview`,
    }]);
  });

  it('streams the recording to the engine and records consent with IP and version', async () => {
    const audio = crypto.randomBytes(2 * 1024 * 1024 + 3);
    const res = await upload(budi, {
      fields: { name: 'Narator', language: 'en', transcript: 'Hello there.', consent: 'true' },
      file: audio, filename: 'take.flac', headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'processing' });
    const stored = h.engine.state.voices.get(res.body.id);
    expect(stored).toMatchObject({ owner_ref: 'budi', name: 'Narator', language: 'en', bytes: audio.length, sha256: sha(audio) });
    expect(stored.fields.transcript).toBe('Hello there.');
    const { rows: [consent] } = await h.pool.query('SELECT * FROM voice_consents WHERE voice_id = $1', [res.body.id]);
    expect(consent).toMatchObject({ user_id: 'budi', ip: '198.51.100.9', consent_version: 'v1' });
    expect(consent.accepted_at).toBeInstanceOf(Date);
  });

  it('requires consent before the file and forwards nothing without it', async () => {
    const before = engineUploads();
    expect((await upload(budi, { fields: { name: 'X' } })).body.error.code).toBe('consent_required');
    expect((await upload(budi, { fields: { name: 'X', consent: 'false' } })).body.error.code).toBe('consent_required');
    const late = await budi.upload('/api/voices').field('name', 'X').attach('audio', Buffer.alloc(10), 'a.wav').field('consent', 'true');
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('consent_required');
    expect(engineUploads()).toBe(before);
  });

  it('rejects unsupported files and missing names before the engine', async () => {
    const before = engineUploads();
    const txt = await upload(budi, { filename: 'notes.txt' });
    expect(txt.status).toBe(415);
    expect(txt.body.error.code).toBe('unsupported_audio');
    expect((await upload(budi, { fields: { consent: 'true' } })).body.error.code).toBe('invalid_request');
    expect(engineUploads()).toBe(before);
  });

  it('stops a Free account at 3 processing/ready voices (failed ones do not count)', async () => {
    const poor = h.as(await h.login(USERS.poor));
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'ready' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'poor', status: 'failed', error_code: 'no_clean_speech' });
    const before = engineUploads();
    const res = await upload(poor);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('voice_limit_reached');
    expect(engineUploads()).toBe(before);
  });

  it('lets a paid account keep 25 voices', async () => {
    const have = (await budi.get('/api/me')).body.voiceCount;
    for (let i = have; i < 24; i += 1) h.engine.addVoice({ owner_ref: 'budi', status: 'ready' });
    expect((await upload(budi)).status).toBe(202);
    const over = await upload(budi);
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('voice_limit_reached');
  });

  it("streams the preview of my voice and hides other users' voices", async () => {
    const mine = h.engine.addVoice({ owner_ref: 'ana', name: 'Preview' });
    const res = await ana.get(`/api/voices/${mine.id}/preview`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Buffer.compare(res.body, WAV_BYTES)).toBe(0);
    expect((await budi.get(`/api/voices/${mine.id}/preview`)).status).toBe(404);
    expect((await budi.del(`/api/voices/${mine.id}`)).status).toBe(404);
    expect(h.engine.state.voices.has(mine.id)).toBe(true);
  });

  it('deleting a voice removes its jobs and refunds their held charges', async () => {
    const doomed = h.engine.addVoice({ owner_ref: 'ana', name: 'Doomed' });
    const { body: { id: jobId } } = await ana.post('/api/jobs', { voiceId: doomed.id, text: 'Halo.' });
    const balance = h.lq.state.users.get('ana').balance;
    expect((await ana.del(`/api/voices/${doomed.id}`)).status).toBe(204);
    expect(h.engine.state.voices.has(doomed.id)).toBe(false);
    expect((await ana.get(`/api/jobs/${jobId}`)).status).toBe(404);
    const { rows: [charge] } = await h.pool.query('SELECT state FROM charges WHERE job_id = $1', [jobId]);
    expect(charge.state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(balance + 1);
  });
});

describe('voice upload size limit', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness({ env: { MAX_UPLOAD_BYTES: String(1024 * 1024) } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers 413 when the stream passes the limit and the engine keeps nothing', async () => {
    const budi = h.as(await h.login(USERS.budi));
    const res = await upload(budi, { file: crypto.randomBytes(1.5 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({ code: 'too_large', message: 'upload exceeds 1 MB' });
    expect(h.engine.state.voices.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/voices.test.js`
Expected: FAIL — `/api/voices` answers `404 no such endpoint`.

- [ ] **Step 3: Write `web/server/routes/voices.js` and replace `app.js`**

`web/server/routes/voices.js`:
```js
import path from 'node:path';
import busboy from 'busboy';
import express from 'express';
import { clientIp } from '../http/middleware.js';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';
import { ownVoice } from '../services/ownership.js';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac']);
const LANGUAGES = new Set(['id', 'en']);

export const toVoice = (v) => ({
  id: v.id, name: v.name, language: v.language, status: v.status, errorCode: v.error_code,
  refSeconds: v.ref_seconds, createdAt: v.created_at, previewUrl: v.preview_url ? `/api/voices/${v.id}/preview` : null,
});

// Parses the multipart body; onFile(fields, fileStream, info) sees the fields that came before the file.
function receiveUpload(req, { maxBytes, onFile }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 64 * 1024 } });
    } catch {
      reject(new ApiError('invalid_request', 'expected a multipart/form-data body'));
      return;
    }
    const fields = {};
    let work = null;
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, file, info) => {
      if (name !== 'audio' || work) {
        file.resume();
        return;
      }
      work = onFile(fields, file, info).catch((err) => {
        file.resume(); // drain the rest so the request can finish
        throw err;
      });
      work.catch(() => {});
    });
    bb.on('error', () => reject(new ApiError('invalid_request', 'malformed multipart body')));
    bb.on('close', () => {
      if (work) {
        work.then(resolve, reject);
        return;
      }
      reject(fields.consent === 'true'
        ? new ApiError('invalid_request', 'an audio file is required')
        : new ApiError('consent_required', 'consent is required to clone a voice'));
    });
    req.pipe(bb);
  });
}

export function voicesRouter(ctx) {
  const { config, engine, accounts, pool, jobsRepo, charges } = ctx;
  const router = express.Router();

  router.get('/voices', async (req, res) => {
    let voices;
    try {
      voices = await engine.listVoices(req.session.user_id);
    } catch (err) {
      throw engineError(err);
    }
    res.json(voices.map(toVoice));
  });

  router.post('/voices', async (req, res) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      throw new ApiError('invalid_request', 'expected multipart/form-data');
    }
    if (Number(req.headers['content-length'] ?? 0) > config.maxUploadBytes + 1024 * 1024) {
      throw new ApiError('too_large', `upload exceeds ${Math.floor(config.maxUploadBytes / 1048576)} MB`);
    }
    const userId = req.session.user_id;
    const ip = clientIp(req);
    const created = await receiveUpload(req, {
      maxBytes: config.maxUploadBytes,
      onFile: async (fields, file, { filename, mimeType }) => {
        if (fields.consent !== 'true') throw new ApiError('consent_required', 'consent is required to clone a voice');
        const name = (fields.name ?? '').trim();
        if (!name || name.length > 80) throw new ApiError('invalid_request', 'name is required (at most 80 characters)');
        const language = fields.language && fields.language !== 'auto' ? fields.language : undefined;
        if (language !== undefined && !LANGUAGES.has(language)) throw new ApiError('invalid_request', 'language must be auto, id or en');
        const transcript = fields.transcript?.trim() || undefined;
        if (transcript && transcript.length > 5000) throw new ApiError('invalid_request', 'transcript is too long');
        if (!AUDIO_EXTS.has(path.extname(filename ?? '').toLowerCase())) {
          throw new ApiError('unsupported_audio', 'use MP3, WAV, M4A or FLAC');
        }
        const session = await accounts.fresh(req.session);
        const count = await accounts.voiceCount(userId);
        if (count === null) throw new ApiError('engine_unavailable', 'the voice engine is unavailable, please try again');
        const limit = accounts.voiceLimit(session.paid);
        if (count >= limit) throw new ApiError('voice_limit_reached', `your plan keeps at most ${limit} voices`);
        try {
          return await engine.uploadVoice({ fields: { name, owner_ref: userId, language, transcript }, filename, mimeType, file });
        } catch (err) {
          if (file.truncated) throw new ApiError('too_large', `upload exceeds ${Math.floor(config.maxUploadBytes / 1048576)} MB`);
          throw engineError(err);
        }
      },
    });
    try {
      await pool.query(
        'INSERT INTO voice_consents (voice_id, user_id, ip, consent_version) VALUES ($1, $2, $3, $4)',
        [created.id, userId, ip, config.consentVersion],
      );
    } catch (err) {
      await engine.deleteVoice(created.id).catch(() => {}); // no consent record → no voice
      throw err;
    }
    res.status(202).json({ id: created.id, status: created.status });
  });

  router.get('/voices/:id/preview', async (req, res) => {
    const voice = await ownVoice(ctx, req.session.user_id, req.params.id);
    await relayEngine(ctx, req, res, `/v1/voices/${voice.id}/preview.wav`);
  });

  router.delete('/voices/:id', async (req, res) => {
    const userId = req.session.user_id;
    const voice = await ownVoice(ctx, userId, req.params.id);
    try {
      await engine.deleteVoice(voice.id);
    } catch (err) {
      throw engineError(err);
    }
    for (const jobId of await jobsRepo.markVoiceDeleted(userId, voice.id)) await charges.resolveJob(jobId, null);
    res.status(204).end();
  });

  return router;
}
```

`web/server/app.js` (replace the whole file):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { creditsRouter } from './routes/credits.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { jobActionsRouter } from './routes/job-actions.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';
import { voicesRouter } from './routes/voices.js';

export function createApp(ctx, { healthCacheMs = 10000, sseKeepaliveMs = 15000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', voicesRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', jobActionsRouter(ctx));
  app.use('/api', eventsRouter(ctx, { keepaliveMs: sseKeepaliveMs }));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/voices.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/routes/voices.js web/server/app.js web/server/test/voices.test.js
git commit -m "web: streamed voice upload with consent record and plan limit; preview and delete"
```

---

### Task 11: Signed engine callback → settle or refund

**Files:**
- Create: `web/server/routes/callback.js`
- Modify: `web/server/app.js` (full replacement below)
- Test: `web/server/test/callback.test.js`

**Interfaces:**
- Consumes: `ctx.jobsRepo.get`, `applyEngineState`, `ctx.charges.resolveJob` (Task 7); `isUuid` (Task 7); `signCallback`, `CALLBACK_SECRET` (Task 5 helpers).
- Produces: `verifySignature(secret, timestamp, bodyBuffer, signature, nowS = now) → bool` (engine scheme: `X-LQ-Signature: sha256=<hex HMAC-SHA256 of "<ts>.<raw body>">`, `X-LQ-Timestamp` within ±300 s, constant-time compare); `callbackRouter(ctx)` → `POST /api/internal/engine-callback` body `{job_id, status: done|failed|canceled, revision}` → 200 `{ok:true}` when every affected charge resolved, 503 `{ok:false}` otherwise (the engine retries after 1, 5, 30, 120, 300 s); 401 on a bad/expired signature; unknown job → 200.

- [ ] **Step 1: Write the failing test**

`web/server/test/callback.test.js`:
```js
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifySignature } from '../routes/callback.js';
import { USERS, signCallback, startHarness } from './helpers.js';

describe('verifySignature', () => {
  // Vector produced by the engine itself: lq_tts_engine.callbacks.sign("callback-test-secret", "1700000000", body)
  const body = Buffer.from('{"job_id":"00000000-0000-4000-8000-000000000000","status":"done","revision":1}');
  const sig = 'sha256=30055abf79cae25a7690d14507b83a13da137680b9d70ba0de7b6422160ef12c';

  it("accepts the engine's own signature and rejects stale or altered ones", () => {
    expect(verifySignature('callback-test-secret', '1700000000', body, sig, 1700000000)).toBe(true);
    expect(verifySignature('callback-test-secret', '1700000000', body, sig, 1700000301)).toBe(false);
    expect(verifySignature('other-secret', '1700000000', body, sig, 1700000000)).toBe(false);
    expect(verifySignature('callback-test-secret', '1700000000', Buffer.from(`${body} `), sig, 1700000000)).toBe(false);
    expect(verifySignature('callback-test-secret', 'abc', body, sig, 1700000000)).toBe(false);
  });
});

describe('engine callback', () => {
  let h;
  let ana;
  let voice;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const heldJob = async (text = 'Halo dunia.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const charges = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;
  const callback = (payload, opts) => {
    const { body, headers } = signCallback(payload, opts);
    return request(h.app).post('/api/internal/engine-callback').set(headers).send(body);
  };
  const settlesFor = (holdId) => h.lq.state.callsTo('/credits/settle').filter((c) => c.body.holdId === holdId);

  it('settles a finished job exactly once, even when the callback repeats', async () => {
    const id = await heldJob();
    h.engine.setJob(id, { status: 'done', audio_seconds: 2.5 });
    const res = await callback({ job_id: id, status: 'done', revision: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [c] = await charges(id);
    expect(c.state).toBe('settled');
    expect(c.resolved_at).not.toBeNull();
    expect(settlesFor(c.hold_id).map((x) => x.body)).toEqual([{ userId: 'ana', holdId: c.hold_id, amount: 1 }]);
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    expect(settlesFor(c.hold_id)).toHaveLength(1);
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'done', audioSeconds: 2.5 });
    expect(job.finishedAt).not.toBeNull();
  });

  it.each(['failed', 'canceled'])('refunds a %s job in full', async (status) => {
    const id = await heldJob();
    h.engine.setJob(id, { status });
    expect((await callback({ job_id: id, status, revision: 1 })).status).toBe(200);
    const [c] = await charges(id);
    expect(c.state).toBe('refunded');
    expect(h.lq.state.net(c.hold_id)).toBe(0);
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('rejects wrong, stale and tampered signatures without moving money', async () => {
    const id = await heldJob();
    const lqCalls = h.lq.state.calls.length;
    expect((await callback({ job_id: id, status: 'failed', revision: 1 }, { secret: 'wrong-secret' })).status).toBe(401);
    expect((await callback({ job_id: id, status: 'failed', revision: 1 }, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    const { body, headers } = signCallback({ job_id: id, status: 'done', revision: 1 });
    const tampered = await request(h.app).post('/api/internal/engine-callback').set(headers).send(body.replace('done', 'failed'));
    expect(tampered.status).toBe(401);
    expect((await request(h.app).post('/api/internal/engine-callback').send('{}')).status).toBe(401);
    expect(h.lq.state.calls.length).toBe(lqCalls);
    expect((await charges(id))[0].state).toBe('held');
  });

  it('acknowledges callbacks for jobs it does not know', async () => {
    const res = await callback({ job_id: '00000000-0000-4000-8000-000000000000', status: 'done', revision: 1 });
    expect(res.status).toBe(200);
  });

  it('answers 503 so the engine retries when LQ-Studio is down, and counts the attempt', async () => {
    const id = await heldJob();
    h.lq.state.failNext.set('POST /credits/settle', 1);
    const res = await callback({ job_id: id, status: 'done', revision: 1 });
    expect(res.status).toBe(503);
    expect((await charges(id))[0]).toMatchObject({ state: 'held', attempts: 1 });
    expect((await charges(id))[0].last_error).not.toBeNull();
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    expect((await charges(id))[0].state).toBe('settled');
  });

  it('a late retry for an older revision leaves the newer regeneration alone', async () => {
    const id = await heldJob('Satu. Dua.');
    h.engine.setJob(id, { status: 'done' });
    await callback({ job_id: id, status: 'done', revision: 1 });
    expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
    await h.pool.query(`UPDATE charges SET created_at = now() - interval '10 minutes' WHERE job_id = $1`, [id]);
    expect((await callback({ job_id: id, status: 'done', revision: 1 })).status).toBe(200);
    const all = await charges(id);
    expect(all.map((c) => [c.revision, c.state])).toEqual([[1, 'settled'], [2, 'held']]);
    const job = (await ana.get('/api/jobs')).body.items.find((j) => j.id === id);
    expect(job).toMatchObject({ status: 'queued', revision: 2 });
  });

  it('rejects a signed body that is not a terminal job event', async () => {
    const res = await callback({ job_id: 'nope', status: 'running', revision: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/callback.test.js`
Expected: FAIL — cannot load `../routes/callback.js`.

- [ ] **Step 3: Write `web/server/routes/callback.js` and replace `app.js`**

`web/server/routes/callback.js`:
```js
import crypto from 'node:crypto';
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../services/ownership.js';

const MAX_SKEW_S = 300;
const TERMINAL = new Set(['done', 'failed', 'canceled']);

// Same scheme as engine/lq_tts_engine/callbacks.py: "sha256=" + HMAC-SHA256(secret, "<ts>." + raw body).
export function verifySignature(secret, timestamp, body, signature, nowS = Math.floor(Date.now() / 1000)) {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`);
  const given = Buffer.from(String(signature));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function callbackRouter(ctx) {
  const { config, engine, jobsRepo, charges, log } = ctx;
  const router = express.Router();
  router.post('/internal/engine-callback', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const timestamp = req.get('x-lq-timestamp') ?? '';
    const signature = req.get('x-lq-signature') ?? '';
    if (!verifySignature(config.engineCallbackSecret, timestamp, body, signature)) {
      log.warn({ event: 'callback_rejected' }, 'engine callback with a bad or expired signature');
      throw new ApiError('unauthorized', 'bad signature');
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ApiError('invalid_request', 'body must be JSON');
    }
    const { job_id: jobId, status, revision } = payload ?? {};
    if (!isUuid(jobId) || !TERMINAL.has(status) || !Number.isInteger(revision) || revision < 1) {
      throw new ApiError('invalid_request', 'job_id, a terminal status and revision are required');
    }
    const job = await jobsRepo.get(jobId);
    if (!job) {
      log.warn({ event: 'callback_unknown_job', jobId }, 'callback for a job this web app does not know');
      res.json({ ok: true });
      return;
    }
    let audioSeconds = null;
    try {
      const view = await engine.getJob(jobId);
      if (view.revision === revision) audioSeconds = view.audio_seconds;
    } catch {
      // the payload alone is enough to settle or refund
    }
    await jobsRepo.applyEngineState(jobId, { status, revision, audioSeconds });
    const ok = await charges.resolveJob(jobId, { status, revision }, { maxRevision: revision });
    res.status(ok ? 200 : 503).json({ ok });
  });
  return router;
}
```

`web/server/app.js` (replace the whole file — the callback router goes **before** `express.json` so it reads the raw body for the HMAC):
```js
import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { callbackRouter } from './routes/callback.js';
import { creditsRouter } from './routes/credits.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { jobActionsRouter } from './routes/job-actions.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';
import { voicesRouter } from './routes/voices.js';

export function createApp(ctx, { healthCacheMs = 10000, sseKeepaliveMs = 15000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', callbackRouter(ctx));
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', voicesRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', jobActionsRouter(ctx));
  app.use('/api', eventsRouter(ctx, { keepaliveMs: sseKeepaliveMs }));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/callback.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/routes/callback.js web/server/app.js web/server/test/callback.test.js
git commit -m "web: HMAC-verified engine callback settles or refunds idempotently"
```

---

### Task 12: Reconciliation loop and the runnable entrypoint

**Files:**
- Create: `web/server/services/reconcile.js`, `web/server/index.js`, `web/server/migrate.js`
- Test: `web/server/test/reconcile.test.js`

**Interfaces:**
- Consumes: `ctx.charges` (`resolveOne`, `recordFailure`), `ctx.jobsRepo.applyEngineState` (Task 7); `UpstreamError` (Task 4); `createApp` (Task 11); `log` (Task 5).
- Produces: `createReconciler(ctx, {intervalMs = 60000})` → `{runOnce() → Promise<{checked}>` (single-flight), `start()` (one pass now, then every `intervalMs`, timer unref'd), `stop() → Promise}`. A pass takes up to 500 charges `held` for > 2 min, asks the engine once per job, and applies `decide`. `node server/index.js` (migrate → listen on `HOST:PORT` → reconciler; SIGTERM/SIGINT stop cleanly); `node server/migrate.js`.

- [ ] **Step 1: Write the failing test**

`web/server/test/reconcile.test.js`:
```js
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReconciler } from '../services/reconcile.js';
import { USERS, startHarness } from './helpers.js';

describe('reconciliation', () => {
  let h;
  let ana;
  let voice;
  let reconciler;
  beforeAll(async () => {
    h = await startHarness();
    ana = h.as(await h.login(USERS.ana));
    voice = h.engine.addVoice({ owner_ref: 'ana' });
    reconciler = createReconciler(h.ctx);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.lq.state.users.get('ana').balance = 100;
  });
  const job = async (text = 'Halo.') => (await ana.post('/api/jobs', { voiceId: voice.id, text })).body.id;
  const lastCharge = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [jobId])).rows[0];
  const age = (jobId, minutes = 3) =>
    h.pool.query('UPDATE charges SET created_at = now() - make_interval(mins => $2) WHERE job_id = $1', [jobId, minutes]);
  const orphanCharge = async (ref, extra = '') => {
    await h.ctx.lqstudio.hold({ userId: 'ana', amount: 1, ref });
    await h.pool.query(
      `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id, created_at) VALUES ${extra}`,
    );
  };

  it('settles finished jobs and refunds failed, canceled and vanished ones', async () => {
    const done = await job();
    const failed = await job();
    const canceled = await job();
    const gone = await job();
    h.engine.setJob(done, { status: 'done' });
    h.engine.setJob(failed, { status: 'failed', error_code: 'synthesis_failed' });
    h.engine.setJob(canceled, { status: 'canceled' });
    h.engine.state.jobs.delete(gone);
    for (const id of [done, failed, canceled, gone]) await age(id);
    await reconciler.runOnce();
    expect((await lastCharge(done)).state).toBe('settled');
    for (const id of [failed, canceled, gone]) {
      const c = await lastCharge(id);
      expect(c.state).toBe('refunded');
      expect(h.lq.state.net(c.hold_id)).toBe(0);
    }
    expect(h.lq.state.users.get('ana').balance).toBe(99);
  });

  it('leaves running jobs and young charges alone without counting attempts', async () => {
    const running = await job();
    const young = await job();
    h.engine.setJob(running, { status: 'running' });
    h.engine.setJob(young, { status: 'done' });
    await age(running);
    await reconciler.runOnce();
    expect(await lastCharge(running)).toMatchObject({ state: 'held', attempts: 0 });
    expect((await lastCharge(young)).state).toBe('held');
    h.engine.setJob(running, { status: 'canceled' }); // leave no stray held charge for the next tests
    await reconciler.runOnce();
    expect((await lastCharge(running)).state).toBe('refunded');
  });

  it('refunds a create that crashed between the hold and the job row', async () => {
    const ref = 'tts:11111111-1111-4111-8111-111111111111:r1';
    await orphanCharge(ref, `('ana', NULL, 1, 'job', NULL, 5, 1, '${ref}', now() - interval '3 minutes')`);
    expect(h.lq.state.users.get('ana').balance).toBe(99);
    await reconciler.runOnce();
    const { rows: [c] } = await h.pool.query('SELECT state FROM charges WHERE hold_id = $1', [ref]);
    expect(c.state).toBe('refunded');
    expect(h.lq.state.users.get('ana').balance).toBe(100);
  });

  it('refunds a regeneration the engine never received and settles the revision it did finish', async () => {
    const id = await job('Satu. Dua.');
    h.engine.setJob(id, { status: 'done' });
    const ref = `tts:${id}:r2:s0`;
    await orphanCharge(ref, `('ana', '${id}', 2, 'regenerate', 0, 5, 1, '${ref}', now() - interval '3 minutes')`);
    await age(id);
    await reconciler.runOnce();
    const { rows } = await h.pool.query('SELECT revision, state FROM charges WHERE job_id = $1 ORDER BY revision', [id]);
    expect(rows).toEqual([{ revision: 1, state: 'settled' }, { revision: 2, state: 'refunded' }]);
  });

  it('counts failed attempts, flags once at 10 and keeps trying until it succeeds', async () => {
    const id = await job();
    h.engine.setJob(id, { status: 'done' });
    await age(id);
    await h.pool.query('UPDATE charges SET attempts = 8 WHERE job_id = $1', [id]);
    h.lq.state.down = true;
    try {
      await reconciler.runOnce();
      expect(await lastCharge(id)).toMatchObject({ state: 'held', attempts: 9, flagged_at: null });
      await reconciler.runOnce();
      const flagged = await lastCharge(id);
      expect(flagged.attempts).toBe(10);
      expect(flagged.flagged_at).not.toBeNull();
      await reconciler.runOnce();
      expect(h.logs.filter((l) => l.event === 'charge_flagged' && l.chargeId === flagged.id)).toHaveLength(1);
    } finally {
      h.lq.state.down = false;
    }
    await reconciler.runOnce();
    expect((await lastCharge(id)).state).toBe('settled');
  });

  it('counts an attempt when the engine cannot be asked', async () => {
    const id = await job();
    await age(id);
    h.engine.state.failNext.set('GET /v1/jobs/:id', { status: 503, code: 'disk_full' });
    await reconciler.runOnce();
    expect(await lastCharge(id)).toMatchObject({ state: 'held', attempts: 1 });
  });

  it('runs once at start and then on its interval', async () => {
    const id = await job();
    await age(id);
    const looping = createReconciler(h.ctx, { intervalMs: 50 });
    looping.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      h.engine.setJob(id, { status: 'done' });
      const deadline = Date.now() + 3000;
      while ((await lastCharge(id)).state === 'held' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await lastCharge(id)).state).toBe('settled');
    } finally {
      await looping.stop();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/reconcile.test.js`
Expected: FAIL — cannot load `../services/reconcile.js`.

- [ ] **Step 3: Write the reconciler**

`web/server/services/reconcile.js`:
```js
import { UpstreamError } from '../clients/http.js';

export function createReconciler({ pool, engine, charges, jobsRepo, log }, { intervalMs = 60000 } = {}) {
  async function pass() {
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE state = 'held' AND created_at < now() - interval '2 minutes' ORDER BY id LIMIT 500`,
    );
    const views = new Map();
    for (const charge of rows) {
      let view = null;
      if (charge.job_id !== null) {
        if (views.has(charge.job_id)) {
          view = views.get(charge.job_id);
        } else {
          try {
            const v = await engine.getJob(charge.job_id);
            view = { status: v.status, revision: v.revision };
            await jobsRepo.applyEngineState(charge.job_id, { ...view, audioSeconds: v.audio_seconds, finishedAt: v.finished_at });
          } catch (err) {
            if (!(err instanceof UpstreamError && err.status === 404)) {
              await charges.recordFailure(charge, err);
              continue;
            }
            view = null; // the engine no longer has the job
          }
          views.set(charge.job_id, view);
        }
      }
      await charges.resolveOne(charge, view);
    }
    if (rows.length) log.info({ event: 'reconcile_pass', checked: rows.length }, 'reconciliation pass');
    return { checked: rows.length };
  }

  let running = null;
  let timer = null;
  const runOnce = () => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };
  const safeRun = () => runOnce().catch((err) => log.error({ event: 'reconcile_failed', error: String(err?.stack ?? err) }, 'reconciliation pass failed'));

  return {
    runOnce,
    start() {
      safeRun();
      timer = setInterval(safeRun, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/test/reconcile.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the entrypoints**

`web/server/migrate.js`:
```js
import { loadConfig } from './config.js';
import { createPool, migrate } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbSchema, { max: 1 });
try {
  await migrate(pool, config.dbSchema);
  console.log(`migrated schema ${config.dbSchema}`);
} finally {
  await pool.end();
}
```

`web/server/index.js`:
```js
import { createApp } from './app.js';
import { createEngine } from './clients/engine.js';
import { createLqStudio } from './clients/lqstudio.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createPool, migrate } from './db/pool.js';
import { log } from './lib/log.js';
import { createReconciler } from './services/reconcile.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbSchema);
await migrate(pool, config.dbSchema);

const ctx = createContext({
  config,
  pool,
  log,
  lqstudio: createLqStudio({ baseUrl: config.lqstudioUrl, token: config.lqstudioToken }),
  engine: createEngine({ baseUrl: config.engineUrl, token: config.engineToken }),
});
const server = createApp(ctx).listen(config.port, config.host, () => {
  log.info({ event: 'listening', host: config.host, port: config.port, schema: config.dbSchema }, 'lq-tts web listening');
});
server.requestTimeout = 30 * 60 * 1000; // 95 MB uploads on slow links
const reconciler = createReconciler(ctx, { intervalMs: config.reconcileIntervalMs });
reconciler.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ event: 'shutdown', signal }, 'shutting down');
  server.close();
  server.closeIdleConnections();
  await reconciler.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

- [ ] **Step 6: Smoke-run the real process against the fakes**

```bash
cd ~/Developer/LQ-TTS/web && export PATH=/opt/homebrew/bin:$PATH
set -a; . ./.env; set +a
export SMOKE_LQ_TOKEN=$(openssl rand -hex 24)
node -e "import('./server/test/fakes/fake-lqstudio.js').then((m) => m.startFakeLqStudio({ port: 3991, token: process.env.SMOKE_LQ_TOKEN, users: [{ id: 'u1', name: 'Smoke', email: 'smoke@example.com', username: 'smoke', password: 'smoke-pass', totp: null, verified: true, suspended: false, plan: 'free', paid: false, balance: 100 }] }))" & LQ_PID=$!
node -e "import('./server/test/fakes/fake-engine.js').then((m) => m.startFakeEngine({ port: 3992, token: 'smoke-engine' }))" & ENG_PID=$!
sleep 1
HOST=127.0.0.1 PORT=3990 DATABASE_URL="$TEST_DATABASE_URL" DB_SCHEMA=lq_tts_web_smoke ENGINE_URL=http://127.0.0.1:3992 ENGINE_TOKEN=smoke-engine ENGINE_CALLBACK_SECRET=smoke-secret ENGINE_CALLBACK_URL=http://127.0.0.1:3990/api/internal/engine-callback LQSTUDIO_URL=http://127.0.0.1:3991 LQSTUDIO_TOKEN="$SMOKE_LQ_TOKEN" LQSTUDIO_PUBLIC_URL=https://demo.lq-studio.com COOKIE_SECURE=false node server/index.js & WEB_PID=$!
sleep 2
curl -s http://127.0.0.1:3990/api/health; echo
curl -s -c /tmp/lqtts-smoke.jar -H 'X-Requested-With: lq-tts' -H 'Content-Type: application/json' -d '{"identifier":"smoke","password":"smoke-pass"}' http://127.0.0.1:3990/api/auth/login; echo
curl -s -b /tmp/lqtts-smoke.jar http://127.0.0.1:3990/api/me; echo
kill -TERM $WEB_PID; wait $WEB_PID; echo "exit $?"
kill $LQ_PID $ENG_PID
psql "$TEST_DATABASE_URL" -qc 'DROP SCHEMA lq_tts_web_smoke CASCADE'
rm -f /tmp/lqtts-smoke.jar; unset SMOKE_LQ_TOKEN
```
Expected, in order: a JSON `listening` log line; `{"engine":"ok","lqstudio":"ok","signupUrl":"https://demo.lq-studio.com/signup"}`; `{"status":"ok","user":{"id":"u1",...,"balance":100,"voiceLimit":3,"voiceCount":0,...}}`; the same `Me` object; a `shutdown` log line; `exit 0`.

- [ ] **Step 7: Run the whole server suite once**

Run: `npx vitest run`
Expected: PASS — 13 files, 0 failures.

- [ ] **Step 8: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/server/services/reconcile.js web/server/index.js web/server/migrate.js web/server/test/reconcile.test.js
git commit -m "web: reconciliation loop and runnable server entrypoint"
```

---

### Task 13: Engine caller `lq-tts-stg` and an end-to-end smoke against the real engine

**Files:**
- Modify (untracked, gitignored, never printed): `engine/.env` (append caller `lq-tts-stg` to `LQTTS_TOKENS` and `LQTTS_CALLBACK_SECRETS`), `web/.env.stg` (keys `ENGINE_TOKEN`, `ENGINE_CALLBACK_SECRET`; other keys belong to plan 2C and are kept)
- Backup: `~/.config/lq-tts/engine.env.bak-2026-10-03` (mode 600, outside the repo)
- Test: smoke commands only (nothing is committed in this task)

**Interfaces:**
- Consumes: the running engine (`lq-tts-engine-api`, `lq-tts-engine-worker`, `127.0.0.1:8740`); `verifySignature` (Task 11); the server (Task 12); `startFakeLqStudio` (Task 4).
- Produces: engine caller `lq-tts-stg` (token + callback secret) usable by the staging web container; `web/.env.stg` holding that token/secret for plan 2C.

- [ ] **Step 1: Make sure the engine is idle**

```bash
cd ~/Developer/LQ-TTS && export PATH=/opt/homebrew/bin:$PATH
psql -d lq_tts -Atc "SELECT count(*) FROM lq_tts_engine.jobs WHERE status IN ('queued','running') AND deleted_at IS NULL"
psql -d lq_tts -Atc "SELECT count(*) FROM lq_tts_engine.voices WHERE status = 'processing' AND deleted_at IS NULL"
```
Expected: `0` and `0`. If not, wait and rerun (a worker restart would interrupt running work).

- [ ] **Step 2: Back up `engine/.env` and add the caller (values never shown)**

```bash
cd ~/Developer/LQ-TTS && export PATH=/opt/homebrew/bin:$PATH
mkdir -p ~/.config/lq-tts && chmod 700 ~/.config/lq-tts
cp -p engine/.env ~/.config/lq-tts/engine.env.bak-2026-10-03 && chmod 600 ~/.config/lq-tts/engine.env.bak-2026-10-03
NEW_TOKEN=$(openssl rand -hex 24) NEW_SECRET=$(openssl rand -hex 24) python3 - <<'PY'
import os, pathlib

token, secret = os.environ["NEW_TOKEN"], os.environ["NEW_SECRET"]

def with_stg(line, value):
    key, _, raw = line.partition("=")
    pairs = [p for p in raw.split(",") if p and not p.startswith("lq-tts-stg:")]
    pairs.append(f"lq-tts-stg:{value}")
    return f"{key}={','.join(pairs)}"

engine = pathlib.Path("engine/.env")
lines = engine.read_text().splitlines()
seen = set()
for i, line in enumerate(lines):
    if line.startswith("LQTTS_TOKENS="):
        lines[i] = with_stg(line, token)
        seen.add("tokens")
    elif line.startswith("LQTTS_CALLBACK_SECRETS="):
        lines[i] = with_stg(line, secret)
        seen.add("secrets")
assert seen == {"tokens", "secrets"}, "engine/.env lacks LQTTS_TOKENS or LQTTS_CALLBACK_SECRETS"
engine.write_text("\n".join(lines) + "\n")

web = pathlib.Path("web/.env.stg")
kept = [l for l in (web.read_text().splitlines() if web.exists() else [])
        if not l.startswith(("ENGINE_TOKEN=", "ENGINE_CALLBACK_SECRET="))]
web.write_text("\n".join(kept + [f"ENGINE_TOKEN={token}", f"ENGINE_CALLBACK_SECRET={secret}"]) + "\n")
os.chmod(web, 0o600)
print("written")
PY
python3 - <<'PY'
import pathlib
for line in pathlib.Path("engine/.env").read_text().splitlines():
    key, _, raw = line.partition("=")
    if key in ("LQTTS_TOKENS", "LQTTS_CALLBACK_SECRETS"):
        print(key, sorted(p.split(":")[0] for p in raw.split(",") if p))
PY
git status --short engine web
```
Expected: `written`; `LQTTS_TOKENS ['lq-studio', 'lq-tts', 'lq-tts-stg']`; `LQTTS_CALLBACK_SECRETS ['lq-studio', 'lq-tts', 'lq-tts-stg']`; `git status` lists neither `engine/.env` nor `web/.env.stg`.

- [ ] **Step 3: Restart only the two engine apps and wait for health**

```bash
cd ~/Developer/LQ-TTS && export PATH=/opt/homebrew/bin:$PATH
pm2 restart lq-tts-engine-api lq-tts-engine-worker
for i in $(seq 1 60); do code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8740/v1/health); [ "$code" = 200 ] && break; sleep 3; done; echo "health $code"
pm2 jlist | python3 -c "import json,sys; [print(p['name'], p['pm2_env']['status']) for p in json.load(sys.stdin) if p['name'].startswith('lq-tts-engine')]"
```
Expected: `health 200`; `lq-tts-engine-api online`; `lq-tts-engine-worker online`. (Do not pass `--update-env`: it would copy this shell's environment into the engine.)

- [ ] **Step 4: Check every caller token and the new callback secret without printing them**

```bash
cd ~/Developer/LQ-TTS && export PATH=/opt/homebrew/bin:$PATH
python3 - <<'PY'
import pathlib, urllib.error, urllib.request
for line in pathlib.Path("engine/.env").read_text().splitlines():
    key, _, raw = line.partition("=")
    if key != "LQTTS_TOKENS":
        continue
    for pair in filter(None, raw.split(",")):
        caller, _, token = pair.partition(":")
        req = urllib.request.Request("http://127.0.0.1:8740/v1/voices?owner_ref=probe", headers={"Authorization": f"Bearer {token}"})
        try:
            code = urllib.request.urlopen(req, timeout=10).status
        except urllib.error.HTTPError as err:
            code = err.code
        print(caller, code)
PY
cd web
ENGINE_CALLBACK_SECRET=$(python3 -c "import pathlib; print(next(l.split('=', 1)[1] for l in pathlib.Path('.env.stg').read_text().splitlines() if l.startswith('ENGINE_CALLBACK_SECRET=')))")
TS=$(date +%s)
SIG=$(cd ../engine && .venv/bin/python -c "import sys; from lq_tts_engine.config import load_config; from lq_tts_engine.callbacks import sign; print(sign(load_config().callback_secrets['lq-tts-stg'], sys.argv[1], b'{\"probe\":1}'))" "$TS")
ENGINE_CALLBACK_SECRET="$ENGINE_CALLBACK_SECRET" node -e "import('./server/routes/callback.js').then((m) => console.log('callback secret matches:', m.verifySignature(process.env.ENGINE_CALLBACK_SECRET, process.argv[1], Buffer.from('{\"probe\":1}'), process.argv[2])))" "$TS" "$SIG"
unset ENGINE_CALLBACK_SECRET SIG
```
Expected: `lq-tts 200`, `lq-studio 200`, `lq-tts-stg 200` (any order); `callback secret matches: true`.

- [ ] **Step 5: End-to-end smoke — the web server on the real engine (fake LQ-Studio, throwaway schema)**

```bash
cd ~/Developer/LQ-TTS/web && export PATH=/opt/homebrew/bin:$PATH
set -a; . ./.env; set +a
read_stg() { python3 -c "import pathlib,sys; print(next(l.split('=', 1)[1] for l in pathlib.Path('.env.stg').read_text().splitlines() if l.startswith(sys.argv[1] + '=')))" "$1"; }
export STG_ENGINE_TOKEN=$(read_stg ENGINE_TOKEN) STG_CALLBACK_SECRET=$(read_stg ENGINE_CALLBACK_SECRET) SMOKE_LQ_TOKEN=$(openssl rand -hex 24)
node -e "import('./server/test/fakes/fake-lqstudio.js').then((m) => m.startFakeLqStudio({ port: 3991, token: process.env.SMOKE_LQ_TOKEN, users: [{ id: 'smoke-u1', name: 'Smoke', email: 'smoke@example.com', username: 'smoke', password: 'smoke-pass', totp: null, verified: true, suspended: false, plan: 'free', paid: false, balance: 100 }] }))" & LQ_PID=$!
sleep 1
HOST=127.0.0.1 PORT=3990 DATABASE_URL="$TEST_DATABASE_URL" DB_SCHEMA=lq_tts_web_smoke ENGINE_URL=http://127.0.0.1:8740 ENGINE_TOKEN="$STG_ENGINE_TOKEN" ENGINE_CALLBACK_SECRET="$STG_CALLBACK_SECRET" ENGINE_CALLBACK_URL=http://127.0.0.1:3990/api/internal/engine-callback LQSTUDIO_URL=http://127.0.0.1:3991 LQSTUDIO_TOKEN="$SMOKE_LQ_TOKEN" LQSTUDIO_PUBLIC_URL=https://demo.lq-studio.com COOKIE_SECURE=false node server/index.js > /tmp/lqtts-smoke.log & WEB_PID=$!
sleep 2
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=3 /tmp/lqtts-smoke.wav
J=/tmp/lqtts-smoke.jar; B=http://127.0.0.1:3990/api; H='X-Requested-With: lq-tts'
curl -s $B/health; echo
curl -s -c $J -H "$H" -H 'Content-Type: application/json' -d '{"identifier":"smoke","password":"smoke-pass"}' $B/auth/login; echo
curl -s -b $J $B/voices; echo
VOICE=$(curl -s -b $J -H "$H" -F name=Smoke -F consent=true -F audio=@/tmp/lqtts-smoke.wav $B/voices | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], file=sys.stderr); print(d['id'])")
curl -s -b $J $B/voices | python3 -c "import json,sys; print([v['name'] for v in json.load(sys.stdin)])"
psql "$TEST_DATABASE_URL" -Atc "SELECT user_id, consent_version FROM lq_tts_web_smoke.voice_consents WHERE voice_id = '$VOICE'"
curl -s -o /dev/null -w 'delete %{http_code}\n' -b $J -H "$H" -X DELETE $B/voices/$VOICE
curl -s -b $J $B/voices; echo
kill -TERM $WEB_PID; wait $WEB_PID; kill $LQ_PID
psql "$TEST_DATABASE_URL" -qc 'DROP SCHEMA lq_tts_web_smoke CASCADE'
rm -f /tmp/lqtts-smoke.jar /tmp/lqtts-smoke.wav /tmp/lqtts-smoke.log
unset STG_ENGINE_TOKEN STG_CALLBACK_SECRET SMOKE_LQ_TOKEN
```
Expected, in order: `{"engine":"ok","lqstudio":"ok","signupUrl":"https://demo.lq-studio.com/signup"}`; `{"status":"ok","user":{"id":"smoke-u1",...,"voiceCount":0,...}}`; `[]`; `processing` (stderr); `['Smoke']`; `smoke-u1|v1`; `delete 204`; `[]`. This proves the streamed multipart upload, the `lq-tts-stg` token and `owner_ref` scoping against the real FastAPI engine.

- [ ] **Step 6: Record the result (no commit)**

Nothing tracked changed in this task. Confirm with `cd ~/Developer/LQ-TTS && git status --short` → empty. Tell the plan-2C owner that `web/.env.stg` now holds `ENGINE_TOKEN` and `ENGINE_CALLBACK_SECRET` for caller `lq-tts-stg`, and that PROD uses the existing caller `lq-tts` (its values are in `engine/.env`; copy them into `web/.env.prod` the same way, without printing).

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| §2 session: opaque id, httpOnly/Secure/SameSite=Lax cookie, revocable row; browser never sees tokens | 5 |
| §3/§7 login by email or username, 2FA, needs_verification link, logout, `/me`, `PATCH /me {lang}` | 5 |
| §4 price formula, hold before queue, settle = hold on done, refund on failed/canceled, 402 → nothing queued | 2, 7, 11 |
| §4 regenerate: same formula on the sentence, separate hold | 8 |
| §4 voice limit by plan (processing + ready), consent required | 10 |
| §5 C1 calls with `ip` from `CF-Connecting-IP`; refs per spec (create ref uses web uuid, clarification 1) | 4, 5, 7, 8 |
| §6 tables `sessions`, `jobs`, `charges`, `voice_consents` with indexes | 3 |
| §7 all browser endpoints (contract C2), CSRF header, engine callback HMAC | 5–11 |
| §7 ownership on every job/voice access (`owner_ref` / `jobs.user_id`) | 7, 8, 9, 10 |
| §8.1 LQ-Studio unavailable: login message, job creation blocked, playback still works | 5, 7 |
| §8.2 hold ok + engine create failed → refund immediately with the engine's reason | 7 |
| §8.3 reconciliation every 60 s + startup, > 2 min, attempts, flag after 10, never forgiven | 12 |
| §8.4 engine restarting → `/api/health` `restarting` | 6 |
| §8.5 voice failure code exposed as `errorCode` | 10 |
| §8.6 plan/status refreshed at login and on `/me` (≤ 5 min); suspended/unverified end the session | 5 |
| §8.7 upload limits (size, type, consent, voice limit) before forwarding | 10 |
| §9 Vitest + supertest, fake engine + fake LQ-Studio, every money path, auth/2FA, expiry/revoke, limit, consent, ownership, CSRF | 4–12 |
| C3 runnable `node server/index.js`, env for both environments, engine caller `lq-tts-stg` | 1, 12, 13 |
