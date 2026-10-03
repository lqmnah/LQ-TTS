# LQ-Studio Internal TTS API (Plan 2A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LQ-TTS (mac-studio) a Bearer-guarded, tailnet-only LQ-Studio API at `/api/internal/tts/*`. It verifies LQ-Studio logins (password + 2FA) and holds, settles and refunds LQ-Studio credits through the single credit kernel. It ships to LQ-Studio staging first, then PROD, on lq-server.

**Architecture:**
- **Router:** a thin HTTP router, `server/http/routes/internal-tts.routes.js`, sits on top of two new pure factories:
  - `server/services/akun/login-verify.js` holds the login and 2FA logic, extracted from `auth.routes.js`. From now on `/api/auth/login[/2fa]` and the TTS door both use this single implementation.
  - `server/services/uang/tts-credits.js` does hold/settle/refund over the real kernel, with refId idempotency.
- **Network:** the app port stays loopback-only. A tiny host relay, `ops/host/jembatan-tts-internal.mjs` (run by systemd `--user` units), publishes only `/api/internal/tts/*` and `GET /api/health`:
  - PROD on `100.80.128.19:3101`
  - staging on `100.80.128.19:3112`

**Tech Stack:**
- Node: v22 on the lq-server host, v26 in the containers
- Express 4, zod 4, jsonwebtoken 9, otplib 12 (via `services/akun/twofa.js`), bcryptjs
- `node:test` with the repo's JSON-DB harness
- Docker compose on lq-server, systemd `--user`

**Spec:** The LQ-TTS web-app design: `docs/superpowers/specs/2026-10-02-web-app-design.md`, committed on branch `main` of `~/Developer/LQ-TTS` on mac-studio. Read it with:

```bash
ssh mac-studio 'cd ~/Developer/LQ-TTS && git show main:docs/superpowers/specs/2026-10-02-web-app-design.md'
```

Relevant parts: Amendment A, §2 (cross-host link), §4, §5, §8.1, §9. The LQ-Studio deploy SOP is `/home/lq/lq-studio-stg/CLAUDE.md` §2–§8, which is identical to the PROD repo copy.

## Global Constraints

**Where to work, and how to commit**
- Edit ONLY in `/home/lq/lq-studio-stg`, on branch `feat-lq-tts-internal` cut from `origin/main`.
  - NEVER edit `/home/lq/lq-studio-prod/repo`. It only receives `git pull --ff-only`.
- Every commit uses `git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit …`.
  - No `Co-Authored-By`, Claude, Anthropic or AI attribution anywhere.
- Push only with `bash ~/brain/_brain/bin/brain-push.sh`.
  - Then verify: `git ls-remote origin refs/heads/<br>` == `git rev-parse <br>`.
  - Never `--force`.

**Secrets**
- Never print, echo, log or commit a secret value.
- Tokens are created and moved ONLY with the exact commands in Tasks 9–10. They are stored in env files, piped over ssh stdin, and never placed in argv or on screen.

**The door**
- Paths live under `/api/internal/tts/*`.
- Every route uses the existing guard `makeInternalSocialAuth`:
  - secret env `LQ_TTS_INTERNAL_TOKEN`: at least 32 chars, different per environment
  - rate limit of 600 requests / 60 s, in its own bucket `internal_tts:<clientIp>`
  - any `cf-ray` or `cf-connecting-ip` header gets 403
  - an empty or short secret gets 503

**Ledger and user shapes**
- Ledger rows use `reason` `tts` (hold), `tts_settle` and `tts_refund`.
  - `refId` = the caller's `ref`/`holdId`, verbatim. It is opaque and validated only as `/^tts:[A-Za-z0-9:_-]{1,150}$/`.
  - `refType` = `job`.
- `user` = `{id, name, email, plan, paid}`.
  - `plan = effectiveTierId(user)`.
  - `paid` = plan ∈ {`pro`, `ultra`, `sultan`}, or the user is staff (`admin`/`superadmin`).

**Contract C1 (verbatim)**
- Base URLs:
  - PROD `http://100.80.128.19:3101`
  - staging `http://100.80.128.19:3112`
- Header `Authorization: Bearer <LQ_TTS_INTERNAL_TOKEN>`.
- Errors are `{error: <code>, message?}`.

| Endpoint | Body | Responses |
|---|---|---|
| `POST /api/internal/tts/auth/verify` | `{identifier, password, ip}` | `200 {status:"ok", user}` · `200 {status:"need_2fa", challenge}` · `200 {status:"needs_verification"}` · `401 invalid_credentials` · `403 suspended` · `429 rate_limited` (+`retryAfter` seconds) |
| `POST /api/internal/tts/auth/verify-2fa` | `{challenge, code, ip}` | `200 {status:"ok", user}` · `401 invalid_code` · `429 rate_limited` |
| `GET /api/internal/tts/users/:id` | — | `200 {id, name, email, plan, paid, balance, suspended, verified}` · `404 not_found` |
| `POST /api/internal/tts/credits/hold` | `{userId, amount, ref}` | `200 {holdId, charged, balance}` · `402 insufficient_credits` · `404 not_found` |
| `POST /api/internal/tts/credits/settle` | `{userId, holdId, amount}` | `200 {balance}` |
| `POST /api/internal/tts/credits/refund` | `{userId, holdId}` | `200 {balance, refunded}` |

**Repo structure rules (test-enforced)**
- No new routes in `server/index.js`, apart from one `app.use(createXRouter(...))` mount.
- Every `/api` route lives in `server/http/routes/`.
- One domain prefix = one file, unless it is listed in `PEMILIK_GANDA_SENGAJA`.
- `server/PETA-RUTE.md` must be regenerated.
- `server/index.js` has a two-way line budget (`test/monolith-budget.test.mjs` #MB3).
- Validation goes after auth and after the body parser (#VB4).
- Routers never receive DB primitives such as `getById` (#BM4 ratchet). They read users through `userRepo`.
- Tests are named `test/<name>.test.mjs`.

**Network rule**
- App compose ports stay `127.0.0.1` only (`test/client-ip-ingress.test.mjs:219`).
- The tailnet reaches the app only through the relay.

## Context notes (measured on `origin/main` = `d2d2e2aa`, 2026-10-03)

**Guard: `server/services/akun/internal-token-guard.js`**
- `makeInternalSocialAuth` is at :191-287.
- It rejects Cloudflare headers with 403 `internal_route_not_public` (:227-235).
- It fails closed with 503 when the secret is missing or shorter than `MIN_SECRET_LEN`=32 (:239-258).
- It rate-limits BEFORE comparing secrets, using the hard-coded bucket key `internal_social:${ip}` (:264). It treats `rl.allowed === false` as limited.
- It does a timing-safe Bearer compare and answers 401 `unauthorized` (:278-284).
- Every rejection body is `{ok:false, error}`.
- **Problem:** all internal callers reach the app from the same peer, the compose gateway. With the shared key, TTS traffic (600/60 s) would exhaust lq-socmed's 20/60 s bucket. Task 1 fixes this.

**Internal-social mount and per-route guard**
- The mount is `server/index.js:1438-1441`, inside the gate window: after `maintenanceGate` (:781) and `stagingLockGate` (:824), and before the SPA catch-all.
- The router applies `auth` per route, never `router.use(auth)` (`internal-social.routes.js:80-83`). The router is mounted at root, so `router.use` would guard the whole site.

**Login: `server/http/routes/auth.routes.js:92-163`**
1. `pbKey('login', identifier, ip)` → `pbCheck` → 429 with `Retry-After`.
2. Legacy `loginAttempts` per-IP lock → 429.
3. `getUserByIdentifier` (email OR username).
4. Unknown user: dummy bcrypt compare (`$2b$10$N9qo8…`), `bumpLoginFail`, `pbFail` → 401 with `Retry-After`.
5. `verifyPasswordAsync`.
6. Suspended (revealed only after a correct password) → 403.
7. On success: `loginAttempts.delete`, `pbOk`, `writeUser(lastActiveAt)`.
8. If `totpEnabled`, the challenge is `jwt.sign({twofa:true, userId, flow:'auth', tv}, JWT_SECRET, {expiresIn:'5m'})` (:130).

**2FA: `auth.routes.js:189-245`**
1. `jwt.verify` HS256 → 401. Missing `twofa`/`userId` → 400.
2. `twofaAttempts` per IP (8 → 15 min) → 429.
3. `getById` → 404.
4. `twofaAccountAttempts` per account (6 → 15 min) → 429.
5. suspended → 403. tv mismatch → 401. 2FA off → 400.
6. A backup code goes through `consumeBackupCode`. A TOTP code goes through `totpStep(code, decryptSecret(...))`, which must be greater than `totpLastStep`.
7. Failure bumps both counters → 401.
8. Success: clear the counters, write the audit row, then `writeUser` (burn the backup code / advance the step / `lastActiveAt`), then `bustAuthCache`.
- **Weakness:** the anti-replay check reads a pre-lock snapshot. Two concurrent requests with the same code can both pass. Task 3 closes this inside `writeUser`'s lock.

**Backoff and attempt counters**
- `server/infra/redis.js:157-219`: `PB_TABLE=[0,5,30,60,300,900]`. The first failure already locks that identity+IP for 5 s.
- Without Upstash env, the state lives in an in-memory store.
- `services/akun/percobaan-simpanan.js:40` `bumpLoginFail` locks an IP after 8 fails, for 15 min.

**2FA helpers: `services/akun/twofa.js`**
- `totpStep` (:30) uses a ±1 step window.
- `hashBackupCode` (:50). Backup codes look like `aaaa-bbbb`.
- `decryptSecret` (:67), `consumeBackupCode` (:80).
- `services/akun/token-kind.js:25`: any JWT carrying `twofa` or `flow` is not a session token.

**User writes and lookups**
- `services/akun/user-write.js:10` `makeWriteUser` serializes on the kernel's `_deductLocks`. If the mutator throws, nothing is persisted.
- `index.js:1624` `writeUser`, `:932` `bustAuthCache`, `:1552` `effectiveTierId` (role wins; an active `sultanUltraUntil` lifts free/pro to ultra).
- `PAID_TIERS` and `isStaff` are exported by `server/modules/identity/index.js`.
- `repositories/user.repo.js` `userRepo.byId`.

**Credit kernel: `services/uang/credit-kernel.js`, instantiated once at `index.js:367-368`**
- `withJobRefundLock` (:34): an in-process chain plus `_distJobLock`.
- `recordLedger` (:46): best-effort. On failure it returns `null` and raises a KRITIS alert.
- `_doDeduct` (:138-214): staff pay net zero, as a deduct row plus an `admin_settle` refund row at the same refId (:150-156).
- `refundCreditsStrict` (:279): reports `{paid, newBalance, reason}`.
- `deductCredits` (:330): never throws.
- `services/uang/ledger-refid.js`:
  - `computeJobRefundOwed` (:76) = Σ deduct − Σ refund, over EXACT `refId` matches with `refType 'job'` for that user.
  - `adaBuktiPotongan` (:66) proves a real deduct happened.
- `infra/db.js:501` `queryLedgerByJobPrefix` returns a prefix SUPERSET of rows (`tts:x:r1` also returns `tts:x:r10…`). The service filters to the exact refId.

**Usage page labels**
- `index.js:2980-2998` holds `_LEDGER_FEATURE_BY_REASON` and `ledgerFeatureLabel`. It is used only by `createUsageRouter` (:1362).
- `client/src/pages/UsagePage.jsx:85,145` holds the `reason_*` i18n keys. Rendering uses `c['reason_' + reason] || reason` (:183).

**Guard tests and current counts**
- `server/index.js` is 5267 lines; its budget is `MAKS_BARIS_MONOLITH=5268` (`test/monolith-budget.test.mjs:142`). Adding the mount alone would break the budget, so Task 7 moves the ledger labels out of `index.js`.
- `test/validasi-cakupan.test.mjs:41`: `MIN_RUTE_BERVALIDASI=176`, but there are currently 181 validated routes. The two-way check requires a gap of less than 6, so adding 5 validated routes means raising the floor.
- `scripts/peta-rute.mjs:52`: `PEMILIK_GANDA_SENGAJA`. `prefiksDomain('/api/internal/tts/…')` returns `/api/internal`, the same prefix internal-social already owns.
- `test/injeksi-router.test.mjs` #DI1: every key a router factory destructures must be passed at the `index.js` call site, unless the factory defaults it with `||`, `??`, `typeof` or a ternary.
- `test/router-tdz-2026-09-06.test.mjs`: every shorthand dep in a mount must be declared above the mount line, and no reassigned `let` may be injected.
- `server/http/validate.js:91` `validasi()` answers 400 with `{error:<prose>, code:'validation', field}`.
- `server/infra/error-shield.js` rewrites only 500 bodies.

**Network**
- PROD compose publishes `127.0.0.1:${APP_PORT:-3001}:3001` and `TRUSTED_INGRESS_IPS: "gateway"` (`docker-compose.lqserver-prod.yml:84-110,227-228`). Staging does the same with `127.0.0.1:3012:3002`.
- `test/client-ip-ingress.test.mjs:207-236` fails if any compose file that trusts the gateway publishes a non-loopback port.
- No host firewall is active on lq-server (`ufw`/`firewalld` are inactive). mac-studio reaches `100.80.128.19` over Tailscale (checked: port 22 is reachable).

**Maintenance gate**
- `maintenanceGate` (`index.js:762-780`) answers 503 `{maintenance:true}` for all of `/api/*`, including this door, while `MAINTENANCE_MODE` is on. LQ-TTS treats that as "LQ-Studio unavailable", per spec §8.1.

## Contract notes and deviations (reported to Main / Plan 2B; C1 base URLs and the success shapes are unchanged)

1. **Relay instead of a compose port.** The task brief said to publish `100.80.128.19:3101:3001` in compose. That would break `test/client-ip-ingress.test.mjs` and let any tailnet host forge `cf-connecting-ip` across the whole app. A host relay serves the same addresses instead. It forwards only:
   - `POST /api/internal/tts/auth/verify|verify-2fa`
   - `GET /api/internal/tts/users/<id>`
   - `POST /api/internal/tts/credits/hold|settle|refund`
   - `GET /api/health`

   Everything else gets 404 `{"error":"not_found"}`. Compose files are not changed.
2. **Settle is terminal.** Plan 2B asked for this.
   - `settle` always leaves a `tts_settle` row: a refund of `held − amount`, or a 0-credit marker when `amount == held`.
   - `refund` leaves a `tts_refund` row.
   - After either one, settle and refund move no money: refund returns `refunded: 0`, and settle returns the balance.
3. **Extra codes not listed in C1:**
   - hold: `409 ref_conflict` (the ref is already held by another user)
   - settle: `400 invalid_request` (amount > held)
   - settle/refund: `404 not_found` (no `tts` hold for that user and ref)
   - `503 ledger_unavailable` (the kernel could not pay or record; retry later)
   - verify-2fa: also `403 suspended` and `200 {status:"needs_verification"}`
   - validator 400s look like `{error:<prose>, code:"validation", field}`
   - guard rejections carry an extra `ok:false`, with codes `unauthorized`, `internal_route_not_public`, `rate_limited`, `internal_social_secret_not_configured`, `internal_social_secret_too_short`
   - `402` also returns `balance`
4. **Hold also runs under `withJobRefundLock(ref)`.** Otherwise two concurrent duplicate holds would both find no row and both deduct.
5. **Settle and refund pay through `refundCreditsStrict`**, a kernel function, rather than `refundCredits`. Only the strict variant reports whether credits really moved, and that is what `refunded` and `503` rely on. Its `bayarMeskipunStaf` is set from `adaBuktiPotongan`, exactly like `settleJobHold`.
6. **The 2FA `code` field** accepts a TOTP (exactly 6 digits after removing spaces and dashes) or a backup code (anything else).
   - Challenges minted for TTS carry `flow:'tts'` and are accepted only by the TTS door.
   - `/api/auth/login/2fa` now accepts only `flow` ∈ {`auth`, `admin`}, which are the only flows minted today.

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `server/services/akun/internal-token-guard.js` | Modify | Per-door rate bucket (`rateKey`) and secret name in logs (`envName`); defaults unchanged |
| `server/services/akun/login-verify.js` | Create | `buatVerifikasiMasuk(deps)` → `{periksaSandi, buatChallenge, periksa2fa}`; the only login and 2FA logic |
| `server/http/routes/auth.routes.js` | Modify | `/api/auth/login` and `/login/2fa` delegate to `login-verify`; HTTP responses unchanged |
| `server/services/uang/tts-credits.js` | Create | `buatKreditTts(deps)` → `{tahan, selesaikan, kembalikan}`: ledger-idempotent money over the kernel |
| `server/http/routes/internal-tts.routes.js` | Create | `createInternalTtsRouter(deps)`: guard, zod schemas, mapping results to C1 HTTP |
| `server/config/ledger-labels.js` | Create | `LEDGER_FEATURE_BY_REASON` and `ledgerFeatureLabel` (moved from `index.js`, plus `tts*`) |
| `server/index.js` | Modify | Import the router and the label module, mount the router, delete the moved label block, refresh a comment |
| `server/http/routes/internal-social.routes.js` | Modify | Header comment only (it is no longer "the only `/api/internal`") |
| `scripts/peta-rute.mjs` | Modify | `PEMILIK_GANDA_SENGAJA` entry for `/api/internal` |
| `server/PETA-RUTE.md` | Regenerate | Route map |
| `client/src/pages/UsagePage.jsx` | Modify | `reason_tts`, `reason_tts_settle`, `reason_tts_refund` (ID and EN) |
| `test/monolith-budget.test.mjs` | Modify | Lower `MAKS_BARIS_MONOLITH` to the new count |
| `test/validasi-cakupan.test.mjs` | Modify | Raise `MIN_RUTE_BERVALIDASI`; add the 3 TTS money routes to `RUTE_UANG_WAJIB` |
| `test/struktur-direktori.test.mjs` | Modify | Raise the `test/` directory budget 536 → 542 for the 6 new test files (Task 1) |
| `.env.example` | Modify | Document `LQ_TTS_INTERNAL_TOKEN` (name only) |
| `ops/host/jembatan-tts-internal.mjs` | Create | Tailnet relay (`jalurDiizinkan`, `buatJembatan`, CLI) |
| `ops/host/lq-tts-jembatan-prod.service` | Create | systemd user unit: `100.80.128.19:3101` → `127.0.0.1:3001` |
| `ops/host/lq-tts-jembatan-stg.service` | Create | systemd user unit: `100.80.128.19:3112` → `127.0.0.1:3012` |
| `ops/host/README.md` | Modify | Table row for the relay |
| `CLAUDE.md` | Modify | §2 topology bullet for the relay and token |
| `test/internal-token-guard.test.mjs` | Create | Per-door bucket |
| `test/auth-login-karakter.test.mjs` | Create | Pins the HTTP behavior of `/api/auth/login[/2fa]`, plus the 2 hardening cases |
| `test/tts-credits.test.mjs` | Create | Money semantics on the real kernel |
| `test/internal-tts.routes.test.mjs` | Create | All 6 endpoints over HTTP |
| `test/ledger-labels.test.mjs` | Create | TTS reasons are labelled |
| `test/jembatan-tts-internal.test.mjs` | Create | Relay allowlist and forwarding |

---

### Task 0: Workspace and baseline

**Files:** none.

**Interfaces:**
- Consumes: nothing.
- Produces: branch `feat-lq-tts-internal` in `/home/lq/lq-studio-stg`, cut from `origin/main`. Also a recorded baseline pass count `BASE_PASS`.

- [ ] **Step 1: Check for duplicate work in the shared brain**

Run: `cd ~ && python3 ~/brain/_brain/bin/brain-task.py check "lq-tts internal api"`
Expected: no open task on the same topic owned by another agent. If one exists, STOP and report it.

Then register the task:

```bash
python3 ~/brain/_brain/bin/brain-task.py add "LQ-Studio /api/internal/tts (plan 2A)" --mesin lq-server --proyek lq-studio --catatan "router internal-tts + jembatan tailnet 3101/3112"
```

Note the printed task id as `TASK_ID`.

- [ ] **Step 2: Clean tree, fresh branch**

Run: `cd /home/lq/lq-studio-stg && git status --porcelain`
Expected: no output. If there is any output, STOP. CLAUDE.md §8 forbids resetting a dirty tracked tree. Report it to lqmnah.

Then:

```bash
cd /home/lq/lq-studio-stg && git fetch -q origin && git checkout -B feat-lq-tts-internal origin/main
```

Expected: `Switched to a new branch 'feat-lq-tts-internal'` (or `Reset branch`).

- [ ] **Step 3: Baseline (and repair the staging dir's native modules if needed)**

The staging dir's `node_modules` may still hold the mac-era darwin `better_sqlite3.node`. Measured 2026-10-03: `node --test test/credits.test.mjs` fails with `Module did not self-register`, while the PROD checkout passes. `node_modules` is `.dockerignore`d by the staging `Dockerfile`, which runs its own `npm ci`, so rebuilding it on the host cannot affect the image.

Run: `cd /home/lq/lq-studio-stg && node --test test/credits.test.mjs 2>&1 | grep -cE 'self-register'`
Expected: `0`. If it prints a number greater than 0, run `npm ci --no-audit --no-fund` in `/home/lq/lq-studio-stg` (CLAUDE.md §8: deterministic, lockfile unchanged), then rerun until it prints `0`.

Then record the baseline. These files live outside the repo:

```bash
mkdir -p ~/.cache && cd /home/lq/lq-studio-stg
node --test test/*.test.mjs > ~/.cache/plan2a-suite-dasar.log 2>&1; grep -E '^# (pass|fail)' ~/.cache/plan2a-suite-dasar.log
grep -E '^not ok' ~/.cache/plan2a-suite-dasar.log | sed -E 's/^not ok [0-9]+ - //' | sort > ~/.cache/plan2a-gagal-dasar.txt; wc -l < ~/.cache/plan2a-gagal-dasar.txt
```

Expected: a pass count and a fail count. Note them as `BASE_PASS` and `BASE_FAIL`; the CLAUDE.md target is `# fail 0`. Every pre-existing failing test name is saved, so that Task 9 can prove nothing new fails. If `BASE_FAIL` is above 0, list the failing names in the report to Main. Do not fix unrelated failures in this branch.

Run: `wc -l server/index.js && node scripts/peta-rute.mjs --periksa`
Expected:

```
5267 server/index.js
invarian rute: bersih
```

If `origin/main` moved and the count is not 5267, every `index.js` line number in Task 7 must be re-located by its quoted text. Recompute the budget in Task 7 Step 6 from the actual `wc -l` output.

No commit.

---

### Task 1: Per-door rate bucket in the internal guard

**Files:**
- Modify: `server/services/akun/internal-token-guard.js:186-196,209,245,256,264,274`
- Modify: `test/struktur-direktori.test.mjs` (the `'test'` budget line in `ANGGARAN`)
- Test: `test/internal-token-guard.test.mjs` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `makeInternalSocialAuth(getSecret, { log?, clientIp?, rlHit?, rateMax?, rateWindowSec?, rateKey?: string = 'internal_social', envName?: string = 'LQ_SOCIAL_TOKEN' })`.
  - The rate-limit key becomes `` `${rateKey}:${clientIp(req)}` ``.
  - The log prefix becomes `` `[${rateKey with _→-}]` ``.
  - Error codes are unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/internal-token-guard.test.mjs`:

```js
// test/internal-token-guard.test.mjs
// Ember batas laju PER PINTU untuk makeInternalSocialAuth.
//
// Semua pemanggil internal tiba dari peer yang SAMA (gateway compose di belakang
// tunnel/jembatan host), jadi clientIp() mereka identik. Dengan satu kunci ember
// bersama, pintu LQ-TTS (600/60 dtk) menghabiskan jatah lq-socmed (20/60 dtk) dan
// jadwal posting berhenti — tanpa satu galat pun di sisi LQ-TTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInternalSocialAuth } from '../server/services/akun/internal-token-guard.js';

const SECRET = 'x'.repeat(40);

async function jalankan(mw) {
  let status = 200;
  let lanjut = false;
  const res = {
    status(c) { status = c; return this; },
    json() { return this; },
  };
  await mw({ headers: { authorization: `Bearer ${SECRET}` }, originalUrl: '/api/internal/uji' }, res, () => { lanjut = true; });
  return { status, lanjut };
}

test('#IG1 tanpa rateKey ember tetap internal_social:<ip> dengan 20/60 (lq-socmed tidak berubah)', async () => {
  const panggilan = [];
  const mw = makeInternalSocialAuth(() => SECRET, {
    clientIp: () => '172.24.0.1',
    rlHit: async (k, max, win) => { panggilan.push([k, max, win]); return { allowed: true }; },
    log: () => {},
  });
  assert.equal((await jalankan(mw)).lanjut, true);
  assert.deepEqual(panggilan, [['internal_social:172.24.0.1', 20, 60]]);
});

test('#IG2 rateKey sendiri = ember sendiri: 25 panggilan pintu TTS tidak menghabiskan jatah lq-socmed', async () => {
  const hitungan = new Map();
  const rlHit = async (k, max) => {
    const n = (hitungan.get(k) || 0) + 1;
    hitungan.set(k, n);
    return { allowed: n <= max };
  };
  const dasar = { clientIp: () => '172.24.0.1', rlHit, log: () => {} };
  const sosial = makeInternalSocialAuth(() => SECRET, dasar);
  const tts = makeInternalSocialAuth(() => SECRET, { ...dasar, rateKey: 'internal_tts', envName: 'LQ_TTS_INTERNAL_TOKEN', rateMax: 600, rateWindowSec: 60 });
  for (let i = 0; i < 25; i++) assert.equal((await jalankan(tts)).lanjut, true, `panggilan TTS ke-${i + 1}`);
  const s = await jalankan(sosial);
  assert.equal(s.lanjut, true, 'lq-socmed tertolak karena embernya dipakai pintu TTS');
  assert.equal(hitungan.get('internal_tts:172.24.0.1'), 25);
  assert.equal(hitungan.get('internal_social:172.24.0.1'), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/lq/lq-studio-stg && node --test test/internal-token-guard.test.mjs`
Expected: `#IG1` passes and `#IG2` FAILS. The failure is either `lq-socmed tertolak karena embernya dipakai pintu TTS` or an `undefined !== 25` assertion, because both doors count into `internal_social:172.24.0.1`.

- [ ] **Step 3: Implement**

Edit `server/services/akun/internal-token-guard.js`.

(a) Lines 188-190: replace the two JSDoc lines

```js
 * @param {number} [opts.rateMax]
 * @param {number} [opts.rateWindowSec]
```

with

```js
 * @param {number} [opts.rateMax]
 * @param {number} [opts.rateWindowSec]
 * @param {string} [opts.rateKey]  awalan ember batas laju + label log (bawaan 'internal_social')
 * @param {string} [opts.envName]  nama env secret untuk pesan log (bawaan 'LQ_SOCIAL_TOKEN')
```

(b) After line 195 (`  const rateWindowSec = opts.rateWindowSec ?? 60;`) insert:

```js
  // Ember PER PINTU. Semua pemanggil internal tiba dari peer yang SAMA (gateway
  // compose di belakang tunnel/jembatan host), jadi tanpa awalan sendiri pintu LQ-TTS
  // (600/60 dtk) menghabiskan ember lq-socmed (20/60 dtk) dan jadwal posting berhenti.
  const rateKey = opts.rateKey || 'internal_social';
  const envName = opts.envName || 'LQ_SOCIAL_TOKEN';
  const label = `[${rateKey.replace(/_/g, '-')}]`;
```

(c) Line 209: replace

```js
      log(`[internal-social] MENOLAK ${req?.originalUrl || req?.path || ''} dari ${ipOf(req)}: ${msg}`);
```

with

```js
      log(`${label} MENOLAK ${req?.originalUrl || req?.path || ''} dari ${ipOf(req)}: ${msg}`);
```

(d) Line 245: replace

```js
        'LQ_SOCIAL_TOKEN tidak diset. Pintu ini gagal TERTUTUP — set di PROD/.env lalu restart.'
```

with

```js
        `${envName} tidak diset. Pintu ini gagal TERTUTUP — set di .env lalu buat ulang kontainernya.`
```

(e) Line 256: replace

```js
        `LQ_SOCIAL_TOKEN hanya ${secret.length} karakter; minimum ${MIN_SECRET_LEN}.`
```

with

```js
        `${envName} hanya ${secret.length} karakter; minimum ${MIN_SECRET_LEN}.`
```

(f) Line 264: replace

```js
        const rl = await rlHit(`internal_social:${ipOf(req)}`, rateMax, rateWindowSec);
```

with

```js
        const rl = await rlHit(`${rateKey}:${ipOf(req)}`, rateMax, rateWindowSec);
```

(g) Line 274: replace

```js
        log(`[internal-social] batas laju TIDAK aktif: ${e?.message || e}`);
```

with

```js
        log(`${label} batas laju TIDAK aktif: ${e?.message || e}`);
```

(h) Test-directory budget, done once here for the whole plan. `test/struktur-direktori.test.mjs` #SD1 counts `git ls-files` per directory, and `test/` is at its budget of 536. Plan 2A adds 6 test files across Tasks 1–8. The file itself says the `test/` budget legitimately rises with each new guard. Raising the budget here keeps every intermediate commit green. In that file, replace the beginning of the line

```js
  'test': 536,   // 536 +mode-render
```

with

```js
  'test': 542,   // 542 +internal-token-guard +auth-login-karakter +tts-credits +internal-tts.routes +ledger-labels +jembatan-tts-internal (pintu internal LQ-TTS 2026-10-03) · 536 +mode-render
```

Keep the rest of that line unchanged.

- [ ] **Step 4: Run the guard tests**

Run: `git add test/internal-token-guard.test.mjs test/struktur-direktori.test.mjs && node --test test/internal-token-guard.test.mjs test/internal-token-guard-ratelimit.test.mjs test/internal-social.routes.test.mjs test/internal-social-multiakun.test.mjs test/tipe-ratchet.test.mjs test/struktur-direktori.test.mjs 2>&1 | tail -8`

The JSDoc edit (a) is what keeps `#TR1` (`tsc --checkJs`, 196 errors) green: without it, `rateKey`/`envName` become two new type errors.
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /home/lq/lq-studio-stg
git add server/services/akun/internal-token-guard.js test/internal-token-guard.test.mjs test/struktur-direktori.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(internal-guard): per-door rate bucket (rateKey) so a second internal door cannot starve lq-socmed"
```

---

### Task 2: Pin the HTTP behavior of `/api/auth/login` and `/api/auth/login/2fa`

**Files:**
- Test: `test/auth-login-karakter.test.mjs` (create). There is no production change in this task.

**Interfaces:**
- Consumes: the existing `createAuthRouter(deps)` from `server/http/routes/auth.routes.js`.
- Produces: the test helpers `aplikasi()`, `kirim(jalur, body, ip)`, `challenge(userId, tv, flow)`, `kodeSalah()` and `userDb(id)`. Task 3 extends this file.

- [ ] **Step 1: Write the test**

Create `test/auth-login-karakter.test.mjs`:

```js
// test/auth-login-karakter.test.mjs
// Potret perilaku HTTP /api/auth/login dan /api/auth/login/2fa: status, Retry-After,
// bentuk badan, isi token. Ditulis SEBELUM logika keduanya dipindah ke
// services/akun/login-verify.js supaya pemindahannya terbukti tidak mengubah apa
// pun yang dilihat klien. Router ASLI, basis data JSON sementara, bcrypt + otplib +
// backoff progresif (penyimpan memori redis.js) ASLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { createRequire } from 'node:module';

// Env WAJIB disetel sebelum apa pun menyentuh infra/db.js — impor di bawah dinamis.
process.env.DATA_DIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lq-auth-karakter-'));
process.env.DB_BACKEND = 'json';
const express = (await import('express')).default;
const jwt = (await import('jsonwebtoken')).default;
const { FILES } = await import('../server/config/tabel-db.js');
const db = await import('../server/infra/db.js');
const redis = await import('../server/infra/redis.js');
const identitas = await import('../server/modules/identity/index.js');
const { createAuthRouter } = await import('../server/http/routes/auth.routes.js');
const { errorShield } = await import('../server/infra/error-shield.js');
const { tr, ACTIONABLE } = await import('../server/web/i18n.js');
const { authenticator } = createRequire(import.meta.url)('otplib');

const JWT_SECRET = 'uji-karakter-auth-bukan-produksi';
const SANDI = 'Sandi-Uji-123!';
const HASH = await db.hashPasswordAsync(SANDI);
const TOTP = authenticator.generateSecret();
const CADANGAN = ['abcd-1234', 'beef-0042'];
const dasar = { password: HASH, role: 'user', credits: 100, emailVerified: true, phoneVerified: true };
const USERS = [
  { ...dasar, id: 'u-biasa', email: 'biasa@uji.test', username: 'biasa', name: 'Biasa', tier: 'free' },
  {
    ...dasar, id: 'u-2fa', email: 'duafa@uji.test', username: 'duafa', name: 'Dua FA', tier: 'pro', tokenVersion: 3,
    totpEnabled: true, totpSecret: identitas.encryptSecret(TOTP, JWT_SECRET), totpBackupCodes: CADANGAN.map(identitas.hashBackupCode),
  },
  {
    ...dasar, id: 'u-2fa-kunci', email: 'kunci@uji.test', username: 'kunci', name: 'Kunci', tier: 'free',
    totpEnabled: true, totpSecret: identitas.encryptSecret(TOTP, JWT_SECRET), totpBackupCodes: [],
  },
  { ...dasar, id: 'u-beku', email: 'beku@uji.test', username: 'beku', name: 'Beku', tier: 'free', suspended: true },
];
const semai = () => fs.writeFileSync(nodePath.join(process.env.DATA_DIR, 'users.json'), JSON.stringify(USERS));
const userDb = (id) => JSON.parse(fs.readFileSync(nodePath.join(process.env.DATA_DIR, 'users.json'), 'utf8')).find((u) => u.id === id);

// SATU writeUser untuk seluruh berkas — rantai kuncinya harus sama untuk semua permintaan.
const writeUser = identitas.makeWriteUser({ getById: db.getById, upsert: db.upsert, locks: new Map(), FILES });

function aplikasi() {
  const app = express();
  app.use(express.json());
  app.use(errorShield(tr));
  app.use(createAuthRouter({
    ACTIONABLE, FILES, JWT_SECRET, USER_TOKEN_TTL: '7d', jwt, tr,
    authMiddleware: (_q, _s, n) => n(), signupLockGuard: (_q, _s, n) => n(),
    clientIp: (req) => req.headers['x-uji-ip'] || '10.9.9.9', bustAuthCache: () => {},
    getById: db.getById, getUserByIdentifier: db.getUserByIdentifier, verifyPasswordAsync: db.verifyPasswordAsync,
    pbKey: redis.pbKey, pbCheck: redis.pbCheck, pbFail: redis.pbFail, pbOk: redis.pbOk,
    loginAttempts: identitas.loginAttempts, bumpLoginFail: identitas.bumpLoginFail,
    twofaAttempts: identitas.twofaAttempts, twofaAccountAttempts: identitas.twofaAccountAttempts,
    totpStep: identitas.totpStep, decryptSecret: identitas.decryptSecret, consumeBackupCode: identitas.consumeBackupCode,
    writeUser,
  }));
  return app;
}

async function kirim(jalur, body, ip) {
  const app = aplikasi();
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}${jalur}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-uji-ip': ip }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json(), retryAfter: r.headers.get('retry-after') };
  } finally { s.close(); }
}

// Ember backoff + kunci per-IP hidup di memori proses dan bertahan antar-uji: tiap uji
// memakai IP sendiri supaya tidak saling mewarisi kunci.
let nIp = 0;
const ipBaru = () => { nIp += 1; return `10.20.${Math.floor(nIp / 200)}.${(nIp % 200) + 1}`; };
const challenge = (userId, tv, flow = 'auth') => jwt.sign({ twofa: true, userId, flow, tv }, JWT_SECRET, { expiresIn: '5m' });
const kodeSalah = () => String((Number(authenticator.generate(TOTP)) + 1) % 1e6).padStart(6, '0');

test('#AK1 akun tak dikenal → 401 + Retry-After 5, tanpa token', async () => {
  semai();
  const r = await kirim('/api/auth/login', { identifier: 'tidak-ada@uji.test', password: SANDI }, ipBaru());
  assert.equal(r.status, 401);
  assert.equal(r.retryAfter, '5');
  assert.equal(typeof r.json.error, 'string');
  assert.equal(r.json.token, undefined);
});

test('#AK2 sandi salah → 401; sandi BENAR dari IP yang sama sesudahnya → 429 rate_limit; IP lain → 200', async () => {
  semai();
  const ip = ipBaru();
  const a = await kirim('/api/auth/login', { identifier: 'biasa@uji.test', password: 'salah' }, ip);
  assert.equal(a.status, 401);
  assert.equal(a.retryAfter, '5');
  const b = await kirim('/api/auth/login', { identifier: 'biasa@uji.test', password: SANDI }, ip);
  assert.equal(b.status, 429);
  assert.equal(b.json.code, 'rate_limit');
  assert.ok(Number(b.retryAfter) >= 1 && Number(b.retryAfter) <= 5, `Retry-After=${b.retryAfter}`);
  const c = await kirim('/api/auth/login', { identifier: 'biasa@uji.test', password: SANDI }, ipBaru());
  assert.equal(c.status, 200);
});

test('#AK3 sukses tanpa 2FA (lewat USERNAME) → {token, adminToken:null}; token sesi milik user itu', async () => {
  semai();
  const r = await kirim('/api/auth/login', { identifier: 'biasa', password: SANDI }, ipBaru());
  assert.equal(r.status, 200);
  assert.equal(r.json.adminToken, null);
  const d = jwt.verify(r.json.token, JWT_SECRET);
  assert.equal(d.userId, 'u-biasa');
  assert.equal(d.email, 'biasa@uji.test');
  assert.equal(d.role, 'user');
  assert.equal(d.tv, 0);
  assert.ok(userDb('u-biasa').lastActiveAt, 'lastActiveAt tidak ditulis');
});

test('#AK4 akun dibekukan: sandi benar → 403; sandi salah → 401 (bukan orakel)', async () => {
  semai();
  assert.equal((await kirim('/api/auth/login', { identifier: 'beku@uji.test', password: SANDI }, ipBaru())).status, 403);
  assert.equal((await kirim('/api/auth/login', { identifier: 'beku@uji.test', password: 'salah' }, ipBaru())).status, 401);
});

test('#AK5 akun ber-2FA → {need2fa, challenge} ber-flow auth + tv, tanpa token', async () => {
  semai();
  const r = await kirim('/api/auth/login', { identifier: 'duafa@uji.test', password: SANDI }, ipBaru());
  assert.equal(r.status, 200);
  assert.equal(r.json.need2fa, true);
  assert.equal(r.json.token, undefined);
  const d = jwt.verify(r.json.challenge, JWT_SECRET);
  assert.deepEqual([d.twofa, d.userId, d.flow, d.tv], [true, 'u-2fa', 'auth', 3]);
});

test('#AK6 kode TOTP benar → token + totpLastStep maju; kode yang SAMA diputar ulang → 401', async () => {
  semai();
  const kode = authenticator.generate(TOTP);
  const a = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), code: kode }, ipBaru());
  assert.equal(a.status, 200);
  assert.equal(jwt.verify(a.json.token, JWT_SECRET).userId, 'u-2fa');
  assert.ok(userDb('u-2fa').totpLastStep > 0, 'totpLastStep tidak maju');
  const b = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), code: kode }, ipBaru());
  assert.equal(b.status, 401);
});

test('#AK7 kode cadangan → token dan TERBAKAR; dipakai lagi → 401', async () => {
  semai();
  const a = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), backupCode: 'abcd-1234' }, ipBaru());
  assert.equal(a.status, 200);
  assert.equal(userDb('u-2fa').totpBackupCodes.length, 1);
  const b = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), backupCode: 'abcd-1234' }, ipBaru());
  assert.equal(b.status, 401);
});

test('#AK8 challenge rusak → 401; token SESI (tanpa twofa) sebagai challenge → 400', async () => {
  semai();
  assert.equal((await kirim('/api/auth/login/2fa', { challenge: 'bukan.jwt.sah', code: '123456' }, ipBaru())).status, 401);
  const sesi = jwt.sign({ userId: 'u-2fa', tv: 3 }, JWT_SECRET, { expiresIn: '5m' });
  assert.equal((await kirim('/api/auth/login/2fa', { challenge: sesi, code: authenticator.generate(TOTP) }, ipBaru())).status, 400);
});

test('#AK9 tokenVersion berubah sejak challenge dicetak → 401', async () => {
  semai();
  const r = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 2), code: authenticator.generate(TOTP) }, ipBaru());
  assert.equal(r.status, 401);
});

test('#AK10 6 kode salah (IP berbeda-beda) → akun terkunci: kode BENAR dari IP baru pun 429', async () => {
  semai();
  for (let i = 0; i < 6; i++) {
    const r = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa-kunci', 0), code: kodeSalah() }, ipBaru());
    assert.equal(r.status, 401, `percobaan ${i + 1}`);
  }
  const r = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa-kunci', 0), code: authenticator.generate(TOTP) }, ipBaru());
  assert.equal(r.status, 429);
});
```

- [ ] **Step 2: Run it against the unchanged code**

Run: `cd /home/lq/lq-studio-stg && node --test test/auth-login-karakter.test.mjs 2>&1 | tail -8`
Expected: `# pass 10`, `# fail 0`. This test pins the current behavior.

If anything fails here, the test is wrong, not the router. Fix the test until it describes the current behavior.

- [ ] **Step 3: Commit**

```bash
git add test/auth-login-karakter.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "test(auth): pin HTTP behaviour of /api/auth/login and /login/2fa before extracting their logic"
```

---

### Task 3: Extract `login-verify.js`; the login routes delegate to it (flow allowlist + anti-replay under the lock)

**Files:**
- Create: `server/services/akun/login-verify.js`
- Modify: `server/http/routes/auth.routes.js:20` (import), `:90` (construction), `:92-132` (login handler head), `:189-235` (2FA handler head)
- Test: `test/auth-login-karakter.test.mjs` (append 2 tests)

**Interfaces:**
- Consumes the injected functions listed below.
- Produces `buatVerifikasiMasuk(deps)` → `{ periksaSandi, buatChallenge, periksa2fa }`, where `deps` = `{ JWT_SECRET, jwt, getUserByIdentifier, ambilUser(id)→user|null, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk, loginAttempts: Map, bumpLoginFail, twofaAttempts: Map, twofaAccountAttempts: Map, totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache }`:
  - `periksaSandi({identifier, password, ip})` → one of:
    - `{hasil:'terkunci_pb', waitSec}`
    - `{hasil:'terkunci_ip', waitSec}`
    - `{hasil:'salah', waitSec}`
    - `{hasil:'ditangguhkan', user}`
    - `{hasil:'lolos', user}`
  - `buatChallenge(user, flow:string)` → a JWT string with claims `{twofa:true, userId, flow, tv}` and a 5-minute expiry.
  - `periksa2fa({challenge, code?, backupCode?, ip, flows:string[]})` → `{hasil}` with `hasil` ∈:
    - `'challenge_kedaluwarsa'`, `'challenge_tidak_sah'`
    - `'terkunci_ip'` or `'terkunci_akun'` (both with `waitSec`)
    - `'user_hilang'`, `'ditangguhkan'`, `'sesi_tidak_sah'`, `'2fa_mati'`, `'kode_salah'`
    - `'lolos'`, with `user` and `payload`

- [ ] **Step 1: Write the failing tests**

Append to `test/auth-login-karakter.test.mjs`:

```js
test('#AK11 challenge LQ-TTS (flow tts) DITOLAK pintu login LQ-Studio → 400, kodenya tidak terpakai', async () => {
  semai();
  const r = await kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3, 'tts'), code: authenticator.generate(TOTP) }, ipBaru());
  assert.equal(r.status, 400);
  assert.equal(userDb('u-2fa').totpLastStep, undefined);
});

test('#AK12 dua permintaan SERENTAK dengan kode yang sama → tepat satu token', async () => {
  semai();
  const kode = authenticator.generate(TOTP);
  const [a, b] = await Promise.all([
    kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), code: kode }, ipBaru()),
    kirim('/api/auth/login/2fa', { challenge: challenge('u-2fa', 3), code: kode }, ipBaru()),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/auth-login-karakter.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected:
- `#AK11` fails with `200 !== 400`, because the current route accepts any `twofa` payload.
- `#AK12` fails with `[200, 200]`, because both requests read the same pre-lock snapshot. If `#AK12` passes by chance, the race window happened to close; continue anyway.

- [ ] **Step 3: Create the service**

Create `server/services/akun/login-verify.js`:

```js
// server/services/akun/login-verify.js
// SATU implementasi pemeriksaan sandi + faktor kedua, dipakai DUA pintu:
//   • /api/auth/login + /api/auth/login/2fa      (http/routes/auth.routes.js)
//   • /api/internal/tts/auth/verify[-2fa]        (http/routes/internal-tts.routes.js)
//
// Pabrik MURNI: semua keadaan — Map percobaan, ember backoff progresif, baris user —
// DISUNTIK, jadi dua instans berbagi papan tulis yang SAMA dan batas laju tidak bisa
// dilewati dengan berpindah pintu (#TDZ4: Map disuntik sebagai objek yang sama).
// Hasilnya diskriminan `{ hasil, ... }`; tiap pintu memetakan sendiri ke HTTP-nya.
//
// 🔑 Anti-replay diperiksa DUA kali: sekali pada snapshot (supaya kode salah dihitung
// tanpa menyentuh kunci), lalu SEKALI LAGI di dalam giliran writeUser terhadap baris
// SEGAR. Versi lama hanya memeriksa snapshot, jadi dua permintaan serentak dengan kode
// yang sama sama-sama lolos sebelum salah satunya sempat menulis totpLastStep.

// Hash bcrypt palsu: membandingkan sandi dengannya menyamakan waktu jawab akun yang
// tidak ada dengan akun yang ada (tanpa enumerasi akun lewat waktu).
const HASH_PALSU = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const LIMA_BELAS_MENIT = 15 * 60 * 1000;
const SUDAH_TERPAKAI = Symbol('kode-2fa-sudah-terpakai');

export function buatVerifikasiMasuk({
  JWT_SECRET, jwt, getUserByIdentifier, ambilUser, verifyPasswordAsync,
  pbKey, pbCheck, pbFail, pbOk, loginAttempts, bumpLoginFail,
  twofaAttempts, twofaAccountAttempts, totpStep, decryptSecret, consumeBackupCode,
  writeUser, bustAuthCache,
}) {
  async function periksaSandi({ identifier, password, ip }) {
    // Progressive backoff (PROGRESSIVE-BACKOFF-SPEC §6.1): per {identifierHash:ip}, di atas
    // kunci legacy 8 gagal → 15 menit per IP yang tetap jadi lapis kedua.
    const kunci = pbKey('login', identifier, ip);
    const pb = await pbCheck(kunci);
    if (pb.locked) return { hasil: 'terkunci_pb', waitSec: pb.waitSec };
    const la = loginAttempts.get(ip);
    if (la && la.until > Date.now()) return { hasil: 'terkunci_ip', waitSec: Math.ceil((la.until - Date.now()) / 1000) };

    const user = await getUserByIdentifier(identifier);
    if (!user) {
      try { await verifyPasswordAsync(password, HASH_PALSU); } catch { /* hanya penyama waktu */ }
      bumpLoginFail(ip);
      return { hasil: 'salah', waitSec: (await pbFail(kunci)).waitSec };
    }
    if (!(await verifyPasswordAsync(password, user.password))) {
      bumpLoginFail(ip);
      return { hasil: 'salah', waitSec: (await pbFail(kunci)).waitSec };
    }
    // Pembekuan hanya terungkap SESUDAH sandi benar (bukan orakel pra-auth).
    if (user.suspended) return { hasil: 'ditangguhkan', user };
    loginAttempts.delete(ip);
    await pbOk(kunci);
    user.lastActiveAt = new Date().toISOString();
    // writeUser (audit H2): serialisasi di _deductLocks + baca ulang baris SEGAR supaya
    // perpindahan kredit serentak tidak tertimpa snapshot ini.
    await writeUser(user.id, (u) => { u.lastActiveAt = user.lastActiveAt; });
    return { hasil: 'lolos', user };
  }

  // Challenge 5 menit. `twofa` + `flow` menjadikannya BUKAN token sesi (token-kind.js),
  // dan `flow` memberi tahu pintu mana yang boleh menukarnya.
  const buatChallenge = (user, flow) =>
    jwt.sign({ twofa: true, userId: user.id, flow, tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '5m' });

  async function periksa2fa({ challenge, code, backupCode, ip, flows }) {
    let payload;
    try { payload = jwt.verify(challenge, JWT_SECRET, { algorithms: ['HS256'] }); } catch { return { hasil: 'challenge_kedaluwarsa' }; }
    if (!payload || !payload.twofa || !payload.userId || !flows.includes(payload.flow)) return { hasil: 'challenge_tidak_sah' };
    const att = twofaAttempts.get(ip) || { count: 0, until: 0 };
    if (att.until > Date.now()) return { hasil: 'terkunci_ip', waitSec: Math.ceil((att.until - Date.now()) / 1000) };
    const user = await ambilUser(payload.userId);
    if (!user) return { hasil: 'user_hilang' };
    // Kunci per-AKUN — lepas dari IP sumber, jadi merotasi IP tidak membantu menebak kode.
    const acct = twofaAccountAttempts.get(user.id) || { count: 0, until: 0 };
    if (acct.until > Date.now()) return { hasil: 'terkunci_akun', waitSec: Math.ceil((acct.until - Date.now()) / 1000) };
    if (user.suspended) return { hasil: 'ditangguhkan' };
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) return { hasil: 'sesi_tidak_sah' };
    if (!user.totpEnabled || !user.totpSecret) return { hasil: '2fa_mati' };

    let langkah = null;
    let cadangan = false;
    if (backupCode) cadangan = consumeBackupCode(backupCode, user.totpBackupCodes || []) !== null;
    else if (code) {
      const s = totpStep(code, decryptSecret(user.totpSecret, JWT_SECRET));
      if (s !== null && s > (user.totpLastStep || 0)) langkah = s;
    }

    let diterima = false;
    if (cadangan || langkah !== null) {
      const waktu = new Date().toISOString();
      try {
        await writeUser(user.id, (u) => {
          // Pemeriksaan ULANG terhadap baris SEGAR di dalam giliran kunci: kode yang
          // sudah dipakai permintaan lain di sela ini DITOLAK, dan karena mutator
          // melempar, writeUser tidak menyimpan apa pun.
          if (cadangan) {
            const sisa = consumeBackupCode(backupCode, u.totpBackupCodes || []);
            if (!sisa) throw SUDAH_TERPAKAI;
            u.totpBackupCodes = sisa;   // kode cadangan TERBAKAR
          }
          if (langkah !== null) {
            if (!(langkah > (u.totpLastStep || 0))) throw SUDAH_TERPAKAI;
            u.totpLastStep = langkah;   // penanda anti-replay maju
          }
          u.lastActiveAt = waktu;
          diterima = true;
        });
      } catch (e) {
        if (e !== SUDAH_TERPAKAI) throw e;
      }
    }

    if (!diterima) {
      att.count++; if (att.count >= 8) { att.until = Date.now() + LIMA_BELAS_MENIT; att.count = 0; } att.at = Date.now(); twofaAttempts.set(ip, att);
      acct.count++; if (acct.count >= 6) { acct.until = Date.now() + LIMA_BELAS_MENIT; acct.count = 0; } acct.at = Date.now(); twofaAccountAttempts.set(user.id, acct);
      return { hasil: 'kode_salah' };
    }
    twofaAttempts.delete(ip);
    twofaAccountAttempts.delete(user.id);
    bustAuthCache();
    return { hasil: 'lolos', user, payload };
  }

  return { periksaSandi, buatChallenge, periksa2fa };
}
```

- [ ] **Step 4: Make `auth.routes.js` delegate to the service**

(a) After line 20 (`import { PHONE_OTP_REQUIRED, EMAIL_OTP_REQUIRED } from '../../services/akun/signup-otp-gate.js';`) insert:

```js
import { buatVerifikasiMasuk } from '../../services/akun/login-verify.js';   // SATU logika sandi+2FA untuk pintu ini dan /api/internal/tts
```

(b) After line 90 (`  const router = patchAsync(express.Router());`) insert:

```js
  // Pemeriksaan sandi + 2FA dirakit dari dependensi yang SAMA yang dulu dipakai inline di
  // sini (Map percobaan & ember backoff disuntik sebagai objek yang sama → satu papan tulis).
  const masuk = buatVerifikasiMasuk({
    JWT_SECRET, jwt, getUserByIdentifier, ambilUser: (id) => getById(FILES.users, id), verifyPasswordAsync,
    pbKey, pbCheck, pbFail, pbOk, loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts,
    totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache,
  });
```

(c) Replace lines 92-132 (from `  router.post('/api/auth/login', validasi({ body: SKEMA_LOGIN }), async (req, res) => {` through the closing `    }` of the `if (user.totpEnabled) { … }` block) with the block below. Keep line 133 (blank) and everything from line 134 (`    const isSuperadmin = user.role === 'superadmin';`) to line 163 unchanged.

```js
  router.post('/api/auth/login', validasi({ body: SKEMA_LOGIN }), async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: tr(req, 'Username/email & password wajib', 'Username/email and password are required') });
  
    const lip = clientIp(req);
    // Backoff progresif, kunci legacy per-IP, pembanding sandi berwaktu-sama, dan urutan
    // pembekuan hidup di services/akun/login-verify.js. Respons di bawah TIDAK berubah
    // (dijaga test/auth-login-karakter.test.mjs).
    const cek = await masuk.periksaSandi({ identifier, password, ip: lip });
    if (cek.hasil === 'terkunci_pb') return res.status(429).set('Retry-After', String(cek.waitSec)).json({ error: tr(req, `Terlalu banyak percobaan login. Coba lagi dalam ${cek.waitSec}s.`, `Too many login attempts. Try again in ${cek.waitSec}s.`), code: ACTIONABLE.RATE_LIMIT });
    if (cek.hasil === 'terkunci_ip') return res.status(429).json({ error: tr(req, `Terlalu banyak percobaan login. Coba lagi dalam ${cek.waitSec}s`, `Too many login attempts. Try again in ${cek.waitSec}s`) });
    // Audit L2: waitSec backoff sebagai Retry-After supaya klien bisa menampilkan hitung mundur.
    if (cek.hasil === 'salah') return res.status(401).set('Retry-After', String(cek.waitSec)).json({ error: tr(req, 'Username/email atau password salah', 'Wrong username/email or password') });
    // Suspension only revealed AFTER correct credentials (not a pre-auth oracle).
    if (cek.hasil === 'ditangguhkan') return res.status(403).json({ error: tr(req, 'Account suspended. Hubungi admin.', 'Account suspended. Please contact an admin.') });
    const user = cek.user;
  
    // 2FA gate (opt-in): an admin/superadmin with TOTP enabled must clear a second
    // factor before any token is issued — returns a 5-min challenge; the client then
    // POSTs the code to /api/auth/login/2fa. Zero effect on accounts without 2FA.
    // 2026-07-10: fires for ANY user with totpEnabled (was admin/superadmin-only).
    if (user.totpEnabled) {
      return res.json({ need2fa: true, challenge: masuk.buatChallenge(user, 'auth') });
    }
```

(d) Replace lines 189-235 (from `  router.post('/api/auth/login/2fa', validasi({ body: SKEMA_LOGIN_2FA }), async (req, res) => {` through `    bustAuthCache();`) with the block below. Keep everything from line 236 (`    if (payload.flow === 'admin') {`) through line 245 (`  });`) unchanged.

```js
  router.post('/api/auth/login/2fa', validasi({ body: SKEMA_LOGIN_2FA }), async (req, res) => {
    const { challenge, code, backupCode } = req.body || {};
    // Challenge, kunci per-IP & per-AKUN, tokenVersion, anti-replay TOTP (diperiksa ulang
    // di dalam kunci writeUser) dan kode cadangan sekali-pakai: services/akun/login-verify.js.
    // `flows` menolak challenge milik pintu lain — LQ-TTS mencetak flow 'tts'.
    const cek = await masuk.periksa2fa({ challenge, code, backupCode, ip: clientIp(req), flows: ['auth', 'admin'] });
    if (cek.hasil === 'challenge_kedaluwarsa') return res.status(401).json({ error: tr(req, 'Sesi 2FA kedaluwarsa — login ulang.', 'Your 2FA session expired — please sign in again.') });
    if (cek.hasil === 'challenge_tidak_sah') return res.status(400).json({ error: tr(req, 'Challenge tidak valid.', 'Invalid challenge.') });
    if (cek.hasil === 'terkunci_ip') return res.status(429).json({ error: tr(req, `Terlalu banyak percobaan. Coba lagi dalam ${cek.waitSec}s`, `Too many attempts. Try again in ${cek.waitSec}s`) });
    if (cek.hasil === 'user_hilang') return res.status(404).json({ error: tr(req, 'User tidak ditemukan', 'User not found') });
    if (cek.hasil === 'terkunci_akun') return res.status(429).json({ error: tr(req, `Akun terkunci sementara — terlalu banyak percobaan 2FA. Coba lagi ${cek.waitSec}s.`, `Account temporarily locked — too many 2FA attempts. Try again in ${cek.waitSec}s.`) });
    if (cek.hasil === 'ditangguhkan') return res.status(403).json({ error: 'Account suspended.' });
    if (cek.hasil === 'sesi_tidak_sah') return res.status(401).json({ error: tr(req, 'Sesi tidak valid — login ulang.', 'Invalid session — please sign in again.') });
    if (cek.hasil === '2fa_mati') return res.status(400).json({ error: tr(req, '2FA tidak aktif.', '2FA is not enabled.') });
    if (cek.hasil === 'kode_salah') return res.status(401).json({ error: tr(req, 'Kode 2FA salah.', 'Wrong 2FA code.') });
    const { user, payload } = cek;
    // Jalur sukses KEDUA: akun ber-2FA tidak pernah lewat res.json di /api/auth/login.
    try {
      await catatAuditPeristiwa({
              action: payload.flow === 'admin' ? 'admin_login' : 'login',
              userId: user.id,
              changes: { role: user.role || 'user', twofa: true },
              ip: clientIp(req),
            });
    } catch (e) { console.error('[audit] gagal mencatat login 2FA', e?.message || e); }
```

- [ ] **Step 5: Run the behavior tests and the structural guards**

Run:

```bash
git add server/services/akun/login-verify.js && node --test test/auth-login-karakter.test.mjs test/route-module-freevars.test.mjs test/services-freevars.test.mjs test/injeksi-router.test.mjs test/validasi-badan-menyeluruh.test.mjs test/batas-modul.test.mjs test/estimasi-unlimited-sumber-clipper.test.mjs test/twofa.test.mjs test/progressive-backoff.test.mjs test/nama-berkas-layanan.test.mjs test/penjaga-tidak-lulus-hampa.test.mjs test/tipe-ratchet.test.mjs 2>&1 | tail -8
```

Expected: `# fail 0`. All 12 `#AK` tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/akun/login-verify.js server/http/routes/auth.routes.js test/auth-login-karakter.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "refactor(auth): one password+2FA implementation (services/akun/login-verify.js); 2FA flow allowlist and anti-replay re-checked inside the user lock"
```

---

### Task 4: Credit service `tts-credits.js` on the real kernel

**Files:**
- Create: `server/services/uang/tts-credits.js`
- Test: `test/tts-credits.test.mjs` (create)

**Interfaces:**
- Consumes the kernel functions from `buatKernelKredit(...)`: `deductCredits(uid, cost, ledgerCtx)`, `refundCreditsStrict(uid, amount, ledgerCtx, {bayarMeskipunStaf})`, `recordLedger(entry)`, `withJobRefundLock(key, fn)`. Also consumes `queryLedgerByJobPrefix(prefix)` from `infra/db.js`, plus `ambilUser(id)`.
- Produces `buatKreditTts(deps)` → `{ tahan, selesaikan, kembalikan }`, with module-private constants `ALASAN_TAHAN='tts'`, `ALASAN_SELESAI='tts_settle'`, `ALASAN_KEMBALI='tts_refund'` (not exported: #PH4 forbids exports without readers):
  - `tahan({userId, amount, ref})` → `{hasil:'ok', holdId, charged, balance}` | `{hasil:'saldo_kurang', balance}` | `{hasil:'tidak_ada'}` | `{hasil:'bentrok'}`
  - `selesaikan({userId, holdId, amount})` → `{hasil:'ok', balance}` | `{hasil:'tidak_ada'}` | `{hasil:'melebihi'}` | `{hasil:'gagal', alasan}`
  - `kembalikan({userId, holdId})` → `{hasil:'ok', balance, refunded}` | `{hasil:'tidak_ada'}` | `{hasil:'gagal', alasan}`

- [ ] **Step 1: Write the failing tests**

Create `test/tts-credits.test.mjs`:

```js
// test/tts-credits.test.mjs
// Uang LQ-TTS di atas kernel kredit ASLI (basis data JSON sementara): hold idempoten,
// settle/refund tepat sekali termasuk duplikat SERENTAK, keduanya terminal, staf
// net-nol, ref berawalan sama tidak tercampur, isolasi antar-pengguna.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lq-tts-credits-'));
process.env.DB_BACKEND = 'json';
const { FILES } = await import('../server/config/tabel-db.js');
const db = await import('../server/infra/db.js');
const { buatKernelKredit } = await import('../server/services/uang/credit-kernel.js');
const { buatKreditTts } = await import('../server/services/uang/tts-credits.js');

// effectiveTierId asli tinggal di index.js; cabang yang relevan di sini: role menang, lalu tier.
const effectiveTierId = (u) => (!u ? 'free' : (u.role === 'admin' || u.role === 'superadmin') ? u.role : String(u.tier || 'free').toLowerCase());
const kernel = buatKernelKredit({
  FILES, PROMO_UNLIMITED_DAILY_CR: 5000, _distJobLock: (_k, fn) => fn(), alertAdmin: async () => {},
  effectiveTierId, getSettings: async () => ({}), isGoogleModelId: () => false, isGoogleVideoModelId: () => false,
  unlimitedDayKey: () => '2026-10-03',
});
const kredit = buatKreditTts({
  deductCredits: kernel.deductCredits, refundCreditsStrict: kernel.refundCreditsStrict, recordLedger: kernel.recordLedger,
  withJobRefundLock: kernel.withJobRefundLock, queryLedgerByJobPrefix: db.queryLedgerByJobPrefix,
  ambilUser: (id) => db.getById(FILES.users, id),
});

const USERS = [
  { id: 'u-a', role: 'user', tier: 'free', credits: 100 },
  { id: 'u-b', role: 'user', tier: 'pro', credits: 50 },
  { id: 'u-staf', role: 'admin', tier: 'free', credits: 999999 },
];
const semai = () => {
  fs.writeFileSync(nodePath.join(process.env.DATA_DIR, 'users.json'), JSON.stringify(USERS));
  fs.writeFileSync(nodePath.join(process.env.DATA_DIR, 'credit_ledger.json'), '[]');
};
const baca = (t) => JSON.parse(fs.readFileSync(nodePath.join(process.env.DATA_DIR, `${t}.json`), 'utf8'));
const saldo = (id) => baca('users').find((u) => u.id === id).credits;
const baris = (ref) => baca('credit_ledger').filter((e) => e.refId === ref);
const REF = 'tts:7f3c2a1e-0000-4000-8000-000000000001:r1';

test('#KT1 hold memotong SEKALI dan menulis satu baris tts ber-refType job', async () => {
  semai();
  const r = await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(r, { hasil: 'ok', holdId: REF, charged: 10, balance: 90 });
  assert.equal(saldo('u-a'), 90);
  const rows = baris(REF);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].type, rows[0].amount, rows[0].reason, rows[0].refType, rows[0].userId], ['deduct', -10, 'tts', 'job', 'u-a']);
});

test('#KT2 hold ULANG dengan ref yang sama → hasil asli, tanpa potongan kedua', async () => {
  semai();
  const a = await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  const b = await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(b, a);
  assert.equal(saldo('u-a'), 90);
  assert.equal(baris(REF).length, 1);
});

test('#KT3 dua hold SERENTAK dengan ref yang sama → satu potongan', async () => {
  semai();
  const [a, b] = await Promise.all([
    kredit.tahan({ userId: 'u-a', amount: 10, ref: REF }),
    kredit.tahan({ userId: 'u-a', amount: 10, ref: REF }),
  ]);
  assert.equal(a.charged, 10);
  assert.equal(b.charged, 10);
  assert.equal(saldo('u-a'), 90);
  assert.equal(baris(REF).length, 1);
});

test('#KT4 saldo kurang → saldo_kurang, saldo & ledger utuh', async () => {
  semai();
  assert.deepEqual(await kredit.tahan({ userId: 'u-a', amount: 500, ref: REF }), { hasil: 'saldo_kurang', balance: 100 });
  assert.equal(saldo('u-a'), 100);
  assert.equal(baris(REF).length, 0);
});

test('#KT5 pengguna tidak ada → tidak_ada', async () => {
  semai();
  assert.deepEqual(await kredit.tahan({ userId: 'u-hantu', amount: 10, ref: REF }), { hasil: 'tidak_ada' });
});

test('#KT6 ref yang sudah ditahan pengguna LAIN → bentrok, saldo pengguna kedua utuh', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.tahan({ userId: 'u-b', amount: 10, ref: REF }), { hasil: 'bentrok' });
  assert.equal(saldo('u-b'), 50);
});

test('#KT7 staf: hold net-nol (charged 0, saldo tetap); refund mengembalikan 0', async () => {
  semai();
  const r = await kredit.tahan({ userId: 'u-staf', amount: 10, ref: REF });
  assert.deepEqual(r, { hasil: 'ok', holdId: REF, charged: 0, balance: 999999 });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-staf', holdId: REF }), { hasil: 'ok', balance: 999999, refunded: 0 });
  assert.equal(saldo('u-staf'), 999999);
});

test('#KT8 settle penuh → baris penanda 0 kredit; sesudahnya refund = 0 dan settle ulang tidak menulis apa pun', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 10 }), { hasil: 'ok', balance: 90 });
  const penanda = baris(REF).filter((e) => e.reason === 'tts_settle');
  assert.equal(penanda.length, 1);
  assert.equal(penanda[0].amount, 0);
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-a', holdId: REF }), { hasil: 'ok', balance: 90, refunded: 0 });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 10 }), { hasil: 'ok', balance: 90 });
  assert.equal(baris(REF).length, 2);
  assert.equal(saldo('u-a'), 90);
});

test('#KT9 settle sebagian → sisa hold kembali SEKALI; settle ulang tidak mengembalikan lagi', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 4 }), { hasil: 'ok', balance: 96 });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 4 }), { hasil: 'ok', balance: 96 });
  const settle = baris(REF).filter((e) => e.reason === 'tts_settle');
  assert.equal(settle.length, 1);
  assert.equal(settle[0].amount, 6);
  assert.equal(saldo('u-a'), 96);
});

test('#KT10 settle melebihi hold → melebihi, tidak ada uang bergerak', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 11 }), { hasil: 'melebihi' });
  assert.equal(baris(REF).length, 1);
  assert.equal(saldo('u-a'), 90);
});

test('#KT11 refund mengembalikan hold penuh SEKALI; sesudahnya refund = 0 dan settle tidak menagih', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-a', holdId: REF }), { hasil: 'ok', balance: 100, refunded: 10 });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-a', holdId: REF }), { hasil: 'ok', balance: 100, refunded: 0 });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 10 }), { hasil: 'ok', balance: 100 });
  assert.equal(baris(REF).filter((e) => e.reason === 'tts_refund').length, 1);
  assert.equal(baris(REF).length, 2);
  assert.equal(saldo('u-a'), 100);
});

test('#KT12 tiga refund SERENTAK → total yang dikembalikan = hold, satu baris tts_refund', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  const hasil = await Promise.all([1, 2, 3].map(() => kredit.kembalikan({ userId: 'u-a', holdId: REF })));
  assert.equal(hasil.reduce((s, r) => s + r.refunded, 0), 10);
  assert.equal(baris(REF).filter((e) => e.reason === 'tts_refund').length, 1);
  assert.equal(saldo('u-a'), 100);
});

test('#KT13 settle dan refund SERENTAK → tepat satu yang berlaku (yang lebih dulu antre)', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  const [s, r] = await Promise.all([
    kredit.selesaikan({ userId: 'u-a', holdId: REF, amount: 10 }),
    kredit.kembalikan({ userId: 'u-a', holdId: REF }),
  ]);
  assert.deepEqual(s, { hasil: 'ok', balance: 90 });
  assert.deepEqual(r, { hasil: 'ok', balance: 90, refunded: 0 });
  const terminal = baris(REF).filter((e) => e.reason === 'tts_settle' || e.reason === 'tts_refund');
  assert.equal(terminal.length, 1);
  assert.equal(saldo('u-a'), 90);
});

test('#KT14 pengguna lain tidak bisa settle/refund hold milik orang → tidak_ada, saldo pemilik utuh', async () => {
  semai();
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  assert.deepEqual(await kredit.selesaikan({ userId: 'u-b', holdId: REF, amount: 10 }), { hasil: 'tidak_ada' });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-b', holdId: REF }), { hasil: 'tidak_ada' });
  assert.equal(saldo('u-a'), 90);
  assert.equal(saldo('u-b'), 50);
});

test('#KT15 ref berawalan sama (…:r1 vs …:r1:s3) tidak tercampur', async () => {
  semai();
  const SUB = `${REF}:s3`;
  await kredit.tahan({ userId: 'u-a', amount: 10, ref: REF });
  await kredit.tahan({ userId: 'u-a', amount: 3, ref: SUB });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-a', holdId: REF }), { hasil: 'ok', balance: 97, refunded: 10 });
  assert.deepEqual(await kredit.kembalikan({ userId: 'u-a', holdId: SUB }), { hasil: 'ok', balance: 100, refunded: 3 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/tts-credits.test.mjs 2>&1 | tail -5`
Expected: the run fails with `ERR_MODULE_NOT_FOUND` for `server/services/uang/tts-credits.js`.

- [ ] **Step 3: Implement the service**

Create `server/services/uang/tts-credits.js`:

```js
// server/services/uang/tts-credits.js
// Tahan / selesaikan / kembalikan kredit untuk LQ-TTS (tts.lq-studio.com) — di atas
// kernel kredit TUNGGAL (credit-kernel.js). Tidak ada jalur uang kedua di sini: setiap
// rupiah bergerak lewat deductCredits / refundCreditsStrict / recordLedger kernel.
//
// Kernel tidak punya kunci idempotensi, jadi idempotensinya milik BUKU BESAR:
//   • refId baris = `ref` LQ-TTS apa adanya (opak, `tts:…`), refType 'job';
//   • hold MEMBACA baris ref itu lebih dulu — sudah ada potongan `tts` ⇒ hasil asli,
//     tanpa memotong lagi;
//   • settle/refund membayar hanya SISA terutang (computeJobRefundOwed: Σ deduct − Σ
//     refund atas refId PERSIS), dan ketiganya berjalan di bawah withJobRefundLock(ref),
//     jadi duplikat serentak tidak pernah memindahkan uang dua kali;
//   • settle dan refund TERMINAL: keduanya selalu meninggalkan baris (`tts_settle` /
//     `tts_refund`; settle penuh = baris penanda 0 kredit). Sesudahnya tidak ada lagi
//     uang yang bergerak untuk ref itu — refund sesudah settle = 0, settle sesudah
//     refund tidak menagih.
// Akun staf ditagih net-nol oleh kernel (deduct + admin_settle), jadi `charged` = 0.
import { adaBuktiPotongan, computeJobRefundOwed } from './ledger-refid.js';
import { canonicalLedgerType } from './ledger-types.js';

const ALASAN_TAHAN = 'tts';
const ALASAN_SELESAI = 'tts_settle';
const ALASAN_KEMBALI = 'tts_refund';
// Baris refund yang ditulis KERNEL sendiri untuk menetralkan potongan akun tak-terbatas.
const PENETRAL = new Set(['admin_settle', 'unlimited_settle']);
const besar = (e) => Math.abs(Number(e.amount) || 0);

export function buatKreditTts({ deductCredits, refundCreditsStrict, recordLedger, withJobRefundLock, queryLedgerByJobPrefix, ambilUser }) {
  // queryLedgerByJobPrefix mengembalikan SUPERSET berawalan (`tts:x:r1` ikut membawa
  // `tts:x:r1:s3`, `tts:x:r10`); yang dihitung hanya refId PERSIS.
  const barisRef = async (ref) => (await queryLedgerByJobPrefix(ref)).filter((e) => e && e.refId === ref);
  const milik = (rows, userId) => rows.filter((e) => e.userId === userId && e.refType === 'job');
  const tahanan = (rows) => rows.filter((e) => e.reason === ALASAN_TAHAN && canonicalLedgerType(e.type) === 'deduct');
  const tuntas = (rows) => rows.some((e) => e.reason === ALASAN_SELESAI || e.reason === ALASAN_KEMBALI);
  const nominal = (rows) => tahanan(rows).reduce((s, e) => s + besar(e), 0);
  const terpungut = (rows) => Math.max(0, nominal(rows) - rows.filter((e) => PENETRAL.has(e.reason)).reduce((s, e) => s + besar(e), 0));
  const sisa = (rows, ref, userId) => computeJobRefundOwed(rows, ref, userId, 0, { wajibBuktiLedger: true });
  const saldo = async (userId) => Number((await ambilUser(userId))?.credits) || 0;
  const gagalBayar = (r) => (r.reason === 'user_missing' || r.reason === 'user_vanished'
    ? { hasil: 'tidak_ada' }
    : { hasil: 'gagal', alasan: r.reason || 'tidak_dibayar' });

  function tahan({ userId, amount, ref }) {
    return withJobRefundLock(ref, async () => {
      const semua = await barisRef(ref);
      if (semua.some((e) => e.userId !== userId)) return { hasil: 'bentrok' };
      const punyaku = milik(semua, userId);
      if (tahanan(punyaku).length) return { hasil: 'ok', holdId: ref, charged: terpungut(punyaku), balance: await saldo(userId) };
      const c = await deductCredits(userId, amount, { reason: ALASAN_TAHAN, refId: ref, refType: 'job', metadata: { subtype: 'tts', hold: amount } });
      if (!c.ok) return c.error === 'insufficient_credits' ? { hasil: 'saldo_kurang', balance: Number(c.remaining) || 0 } : { hasil: 'tidak_ada' };
      const sesudah = milik(await barisRef(ref), userId);
      // Baris ledger bisa gagal ditulis (kernel mengalarm KRITIS) sementara kreditnya
      // sudah terpotong — yang dilaporkan tetap yang benar-benar dipungut.
      return { hasil: 'ok', holdId: ref, charged: tahanan(sesudah).length ? terpungut(sesudah) : amount, balance: Number(c.remaining) || 0 };
    });
  }

  function selesaikan({ userId, holdId, amount }) {
    return withJobRefundLock(holdId, async () => {
      const rows = milik(await barisRef(holdId), userId);
      if (!tahanan(rows).length) return { hasil: 'tidak_ada' };
      if (amount > nominal(rows)) return { hasil: 'melebihi' };
      if (tuntas(rows)) return { hasil: 'ok', balance: await saldo(userId) };
      const ctx = { type: 'refund', reason: ALASAN_SELESAI, refId: holdId, refType: 'job', metadata: { subtype: 'tts', settled: amount } };
      const kembali = Math.max(0, sisa(rows, holdId, userId) - amount);
      if (kembali > 0) {
        const r = await refundCreditsStrict(userId, kembali, ctx, { bayarMeskipunStaf: adaBuktiPotongan(rows, holdId, userId) });
        if (!r.paid) return gagalBayar(r);
        return { hasil: 'ok', balance: Number(r.newBalance) || 0 };
      }
      // Tidak ada sisa untuk dikembalikan: tetap tulis PENANDA 0 kredit supaya settle
      // terminal (refund sesudahnya membaca baris ini dan membayar 0).
      const bal = await saldo(userId);
      const penanda = await recordLedger({ userId, ...ctx, amount: 0, balanceAfter: bal });
      if (!penanda) return { hasil: 'gagal', alasan: 'ledger_write_failed' };
      return { hasil: 'ok', balance: bal };
    });
  }

  function kembalikan({ userId, holdId }) {
    return withJobRefundLock(holdId, async () => {
      const rows = milik(await barisRef(holdId), userId);
      if (!tahanan(rows).length) return { hasil: 'tidak_ada' };
      const owed = tuntas(rows) ? 0 : sisa(rows, holdId, userId);
      if (owed <= 0) return { hasil: 'ok', balance: await saldo(userId), refunded: 0 };
      const r = await refundCreditsStrict(
        userId, owed,
        { type: 'refund', reason: ALASAN_KEMBALI, refId: holdId, refType: 'job', metadata: { subtype: 'tts' } },
        { bayarMeskipunStaf: adaBuktiPotongan(rows, holdId, userId) },
      );
      if (!r.paid) return gagalBayar(r);
      return { hasil: 'ok', balance: Number(r.newBalance) || 0, refunded: owed };
    });
  }

  return { tahan, selesaikan, kembalikan };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `git add server/services/uang/tts-credits.js test/tts-credits.test.mjs && node --test test/tts-credits.test.mjs test/services-freevars.test.mjs test/batas-modul.test.mjs test/credit-kernel-single.test.mjs test/nama-berkas-layanan.test.mjs test/penjaga-tidak-lulus-hampa.test.mjs 2>&1 | tail -8`

`#NM4` (`test/nama-berkas-layanan.test.mjs`) forbids Indonesian technical words such as `kredit` in `server/services/**` file names. That is why the file is `tts-credits.js`. `#PH4` forbids exports without readers, which is why the `ALASAN_*` constants are not exported.
Expected: `# fail 0`. All 15 `#KT` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/uang/tts-credits.js test/tts-credits.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(uang): LQ-TTS hold/settle/refund over the single credit kernel, ledger-idempotent per ref, settle/refund terminal"
```

---

### Task 5: Router `internal-tts.routes.js`: guard, auth/verify, auth/verify-2fa, users/:id

**Files:**
- Create: `server/http/routes/internal-tts.routes.js`
- Test: `test/internal-tts.routes.test.mjs` (create)

**Interfaces:**
- Consumes:
  - `makeInternalSocialAuth` with `rateKey`/`envName` (Task 1)
  - `buatVerifikasiMasuk` (Task 3)
  - from the identity door: `userRepo.byId`, `PAID_TIERS`, `isStaff`
  - `catatAuditPeristiwa` from `modules/ops/index.js`
- Produces `createInternalTtsRouter({ getSecret, clientIp, rlHit, log?, JWT_SECRET, jwt, getUserByIdentifier, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk, loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts, totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache, effectiveTierId })` → an Express router serving:
  - `POST /api/internal/tts/auth/verify`
  - `POST /api/internal/tts/auth/verify-2fa`
  - `GET /api/internal/tts/users/:id`

  Task 6 adds 5 credit deps and 3 routes.

- [ ] **Step 1: Write the failing tests**

Create `test/internal-tts.routes.test.mjs`:

```js
// test/internal-tts.routes.test.mjs
// Pintu internal LQ-TTS (/api/internal/tts/*) lewat HTTP sungguhan: gerbang, login,
// 2FA, profil, dan kredit. Router ASLI + error-shield produksi, basis data JSON
// sementara, kernel kredit ASLI, bcrypt/otplib/backoff ASLI. Semantik uang yang rinci
// (idempotensi, serentak, terminal) diuji di test/tts-credits.test.mjs; di sini yang
// diuji pemetaannya ke kontrak HTTP C1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lq-internal-tts-'));
process.env.DB_BACKEND = 'json';
const express = (await import('express')).default;
const jwt = (await import('jsonwebtoken')).default;
const { FILES } = await import('../server/config/tabel-db.js');
const db = await import('../server/infra/db.js');
const redis = await import('../server/infra/redis.js');
const identitas = await import('../server/modules/identity/index.js');
const { buatKernelKredit } = await import('../server/services/uang/credit-kernel.js');
const { createInternalTtsRouter } = await import('../server/http/routes/internal-tts.routes.js');
const { errorShield } = await import('../server/infra/error-shield.js');
const { tr } = await import('../server/web/i18n.js');
const { authenticator } = createRequire(import.meta.url)('otplib');

const SECRET = 'rahasia-lq-tts-internal-yang-cukup-panjang-40';
const JWT_SECRET = 'uji-internal-tts-bukan-produksi';
const SANDI = 'Sandi-Uji-123!';
const HASH = await db.hashPasswordAsync(SANDI);
const TOTP = authenticator.generateSecret();
const dasar = { password: HASH, role: 'user', credits: 100, emailVerified: true, phoneVerified: true };
const USERS = [
  { ...dasar, id: 'u-pro', email: 'pro@uji.test', username: 'propro', name: 'Pro Uji', tier: 'pro' },
  { ...dasar, id: 'u-free', email: 'free@uji.test', username: 'freefree', name: 'Free Uji', tier: 'free', credits: 5 },
  { ...dasar, id: 'u-belum', email: 'belum@uji.test', username: 'belum', name: 'Belum', tier: 'free', phoneVerified: false },
  {
    ...dasar, id: 'u-2fa', email: 'duafa@uji.test', username: 'duafa', name: 'Dua FA', tier: 'pro', tokenVersion: 1,
    totpEnabled: true, totpSecret: identitas.encryptSecret(TOTP, JWT_SECRET), totpBackupCodes: ['abcd-1234', 'beef-0042'].map(identitas.hashBackupCode),
  },
  {
    ...dasar, id: 'u-2fa-kunci', email: 'kunci@uji.test', username: 'kunci', name: 'Kunci', tier: 'free',
    totpEnabled: true, totpSecret: identitas.encryptSecret(TOTP, JWT_SECRET), totpBackupCodes: [],
  },
  { ...dasar, id: 'u-beku', email: 'beku@uji.test', username: 'beku', name: 'Beku', tier: 'free', suspended: true },
  { ...dasar, id: 'u-admin', email: 'admin@uji.test', username: 'adminuji', name: 'Admin Uji', role: 'admin', tier: 'free', credits: 999999 },
];
const semai = () => {
  fs.writeFileSync(nodePath.join(process.env.DATA_DIR, 'users.json'), JSON.stringify(USERS));
  fs.writeFileSync(nodePath.join(process.env.DATA_DIR, 'credit_ledger.json'), '[]');
};
const baca = (t) => JSON.parse(fs.readFileSync(nodePath.join(process.env.DATA_DIR, `${t}.json`), 'utf8'));

// effectiveTierId asli tinggal di index.js; cabang yang relevan di sini: role menang, lalu tier.
const effectiveTierId = (u) => (!u ? 'free' : (u.role === 'admin' || u.role === 'superadmin') ? u.role : String(u.tier || 'free').toLowerCase());
const kernel = buatKernelKredit({
  FILES, PROMO_UNLIMITED_DAILY_CR: 5000, _distJobLock: (_k, fn) => fn(), alertAdmin: async () => {},
  effectiveTierId, getSettings: async () => ({}), isGoogleModelId: () => false, isGoogleVideoModelId: () => false,
  unlimitedDayKey: () => '2026-10-03',
});
const writeUser = identitas.makeWriteUser({ getById: db.getById, upsert: db.upsert, locks: kernel._deductLocks, FILES });

function aplikasi({ secret = SECRET, rlHit } = {}) {
  const app = express();
  // Sama seperti produksi: error-shield dipasang SEBELUM router.
  app.use(errorShield(tr));
  app.use(createInternalTtsRouter({
    getSecret: () => secret, clientIp: () => '172.24.0.1', rlHit, log: () => {},
    JWT_SECRET, jwt, getUserByIdentifier: db.getUserByIdentifier, verifyPasswordAsync: db.verifyPasswordAsync,
    pbKey: redis.pbKey, pbCheck: redis.pbCheck, pbFail: redis.pbFail, pbOk: redis.pbOk,
    loginAttempts: identitas.loginAttempts, bumpLoginFail: identitas.bumpLoginFail,
    twofaAttempts: identitas.twofaAttempts, twofaAccountAttempts: identitas.twofaAccountAttempts,
    totpStep: identitas.totpStep, decryptSecret: identitas.decryptSecret, consumeBackupCode: identitas.consumeBackupCode,
    writeUser, bustAuthCache: () => {}, effectiveTierId,
    deductCredits: kernel.deductCredits, refundCreditsStrict: kernel.refundCreditsStrict, recordLedger: kernel.recordLedger,
    withJobRefundLock: kernel.withJobRefundLock, queryLedgerByJobPrefix: db.queryLedgerByJobPrefix,
  }));
  app.get('/api/public/ping', (_q, res) => res.json({ ok: true }));
  return app;
}

async function kirim(app, method, jalur, { body, headers = {}, token = SECRET } = {}) {
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const h = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
    const r = await fetch(`http://127.0.0.1:${s.address().port}${jalur}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const teks = await r.text();
    let json = null;
    try { json = JSON.parse(teks); } catch { /* bukan JSON */ }
    return { status: r.status, json, retryAfter: r.headers.get('retry-after') };
  } finally { s.close(); }
}

let nIp = 0;
const ipBaru = () => { nIp += 1; return `10.30.${Math.floor(nIp / 200)}.${(nIp % 200) + 1}`; };
const challengeTts = (userId, tv) => jwt.sign({ twofa: true, userId, flow: 'tts', tv }, JWT_SECRET, { expiresIn: '5m' });
const VERIFY = '/api/internal/tts/auth/verify';
const VERIFY_2FA = '/api/internal/tts/auth/verify-2fa';
const SEHAT = '/api/internal/tts/users/__lqtts_health__';

// ── gerbang ────────────────────────────────────────────────────────────────

test('#G1 tanpa Bearer / Bearer salah → 401 unauthorized', async () => {
  const app = aplikasi();
  const a = await kirim(app, 'GET', SEHAT, { token: null });
  assert.equal(a.status, 401);
  assert.equal(a.json.error, 'unauthorized');
  assert.equal((await kirim(app, 'GET', SEHAT, { token: 'salah' })).status, 401);
});

test('#G2 header Cloudflare (cf-ray / cf-connecting-ip) → 403 walau Bearer benar', async () => {
  const app = aplikasi();
  for (const h of [{ 'cf-ray': 'abc123' }, { 'cf-connecting-ip': '203.0.113.9' }]) {
    const r = await kirim(app, 'GET', SEHAT, { headers: h });
    assert.equal(r.status, 403, JSON.stringify(h));
    assert.equal(r.json.error, 'internal_route_not_public');
  }
});

test('#G3 secret kosong atau < 32 karakter → 503, gagal TERTUTUP', async () => {
  const kosong = await kirim(aplikasi({ secret: '' }), 'GET', SEHAT);
  assert.equal(kosong.status, 503);
  assert.equal(kosong.json.error, 'internal_social_secret_not_configured');
  const pendek = await kirim(aplikasi({ secret: 'p'.repeat(31) }), 'GET', SEHAT, { token: 'p'.repeat(31) });
  assert.equal(pendek.status, 503);
  assert.equal(pendek.json.error, 'internal_social_secret_too_short');
});

test('#G4 batas laju: ember internal_tts:<ip> 600/60 dtk; ditolak → 429 rate_limited', async () => {
  const panggilan = [];
  const rlHit = async (k, max, win) => { panggilan.push([k, max, win]); return { allowed: panggilan.length <= 1 }; };
  const app = aplikasi({ rlHit });
  assert.equal((await kirim(app, 'GET', SEHAT)).status, 404);
  const r = await kirim(app, 'GET', SEHAT);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.deepEqual(panggilan[0], ['internal_tts:172.24.0.1', 600, 60]);
});

test('#G5 gerbang TIDAK bocor ke rute lain di aplikasi yang sama', async () => {
  assert.equal((await kirim(aplikasi(), 'GET', '/api/public/ping', { token: null })).status, 200);
});

// ── auth/verify ────────────────────────────────────────────────────────────

test('#V1 akun tak dikenal → 401 invalid_credentials', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', VERIFY, { body: { identifier: 'hantu@uji.test', password: SANDI, ip: ipBaru() } });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'invalid_credentials' });
});

test('#V2 backoff memakai `ip` di BADAN: sandi salah lalu benar dari ip sama → 429 + retryAfter; ip lain → ok', async () => {
  semai();
  const app = aplikasi();
  const ip = ipBaru();
  assert.equal((await kirim(app, 'POST', VERIFY, { body: { identifier: 'pro@uji.test', password: 'salah', ip } })).status, 401);
  const b = await kirim(app, 'POST', VERIFY, { body: { identifier: 'pro@uji.test', password: SANDI, ip } });
  assert.equal(b.status, 429);
  assert.equal(b.json.error, 'rate_limited');
  assert.ok(b.json.retryAfter >= 1 && b.json.retryAfter <= 5, `retryAfter=${b.json.retryAfter}`);
  assert.equal(b.retryAfter, String(b.json.retryAfter));
  const c = await kirim(app, 'POST', VERIFY, { body: { identifier: 'pro@uji.test', password: SANDI, ip: ipBaru() } });
  assert.equal(c.status, 200);
  assert.equal(c.json.status, 'ok');
});

test('#V3 akun dibekukan: sandi benar → 403 suspended; sandi salah → 401 (bukan orakel)', async () => {
  semai();
  const app = aplikasi();
  const a = await kirim(app, 'POST', VERIFY, { body: { identifier: 'beku@uji.test', password: SANDI, ip: ipBaru() } });
  assert.equal(a.status, 403);
  assert.deepEqual(a.json, { error: 'suspended' });
  assert.equal((await kirim(app, 'POST', VERIFY, { body: { identifier: 'beku@uji.test', password: 'salah', ip: ipBaru() } })).status, 401);
});

test('#V4 email/HP belum terverifikasi → 200 needs_verification', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', VERIFY, { body: { identifier: 'belum@uji.test', password: SANDI, ip: ipBaru() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'needs_verification' });
});

test('#V5 sukses lewat USERNAME → user TEPAT {id,name,email,plan,paid} (tanpa hash/rahasia)', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', VERIFY, { body: { identifier: 'propro', password: SANDI, ip: ipBaru() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok', user: { id: 'u-pro', name: 'Pro Uji', email: 'pro@uji.test', plan: 'pro', paid: true } });
});

test('#V6 akun ber-2FA → need_2fa; challenge ber-flow tts dan BUKAN token sesi', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', VERIFY, { body: { identifier: 'duafa@uji.test', password: SANDI, ip: ipBaru() } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'need_2fa');
  const d = jwt.verify(r.json.challenge, JWT_SECRET);
  assert.deepEqual([d.twofa, d.userId, d.flow, d.tv], [true, 'u-2fa', 'tts', 1]);
  assert.equal(identitas.isSessionToken(d), false);
});

test('#V7 badan cacat → 400 sebelum apa pun dicek: ip hilang, medan asing', async () => {
  semai();
  const app = aplikasi();
  assert.equal((await kirim(app, 'POST', VERIFY, { body: { identifier: 'pro@uji.test', password: SANDI } })).status, 400);
  assert.equal((await kirim(app, 'POST', VERIFY, { body: { identifier: 'pro@uji.test', password: SANDI, ip: ipBaru(), admin: true } })).status, 400);
});

// ── auth/verify-2fa ────────────────────────────────────────────────────────

test('#F1 TOTP benar → ok + user; kode yang SAMA diputar ulang → 401 invalid_code', async () => {
  semai();
  const app = aplikasi();
  const code = authenticator.generate(TOTP);
  const a = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa', 1), code, ip: ipBaru() } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { status: 'ok', user: { id: 'u-2fa', name: 'Dua FA', email: 'duafa@uji.test', plan: 'pro', paid: true } });
  const b = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa', 1), code, ip: ipBaru() } });
  assert.equal(b.status, 401);
  assert.deepEqual(b.json, { error: 'invalid_code' });
});

test('#F2 kode cadangan → ok dan TERBAKAR; dipakai lagi → 401', async () => {
  semai();
  const app = aplikasi();
  const a = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa', 1), code: 'abcd-1234', ip: ipBaru() } });
  assert.equal(a.status, 200);
  assert.equal(baca('users').find((u) => u.id === 'u-2fa').totpBackupCodes.length, 1);
  const b = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa', 1), code: 'abcd-1234', ip: ipBaru() } });
  assert.equal(b.status, 401);
});

test('#F3 challenge milik login LQ-Studio (flow auth) atau rusak → 401 invalid_code', async () => {
  semai();
  const app = aplikasi();
  const auth = jwt.sign({ twofa: true, userId: 'u-2fa', flow: 'auth', tv: 1 }, JWT_SECRET, { expiresIn: '5m' });
  for (const challenge of [auth, 'bukan.jwt.sah']) {
    const r = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge, code: authenticator.generate(TOTP), ip: ipBaru() } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'invalid_code');
  }
});

test('#F4 6 kode salah → akun terkunci; kode BENAR dari ip baru pun 429 rate_limited', async () => {
  semai();
  const app = aplikasi();
  const salah = String((Number(authenticator.generate(TOTP)) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 6; i++) {
    const r = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa-kunci', 0), code: salah, ip: ipBaru() } });
    assert.equal(r.status, 401, `percobaan ${i + 1}`);
  }
  const r = await kirim(app, 'POST', VERIFY_2FA, { body: { challenge: challengeTts('u-2fa-kunci', 0), code: authenticator.generate(TOTP), ip: ipBaru() } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.ok(r.json.retryAfter > 0);
});

// ── users/:id ──────────────────────────────────────────────────────────────

test('#U1 profil + saldo + status; staf = plan admin & paid; tak dikenal / id cacat → 404', async () => {
  semai();
  const app = aplikasi();
  const a = await kirim(app, 'GET', '/api/internal/tts/users/u-free');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { id: 'u-free', name: 'Free Uji', email: 'free@uji.test', plan: 'free', paid: false, balance: 5, suspended: false, verified: true });
  const b = await kirim(app, 'GET', '/api/internal/tts/users/u-admin');
  assert.deepEqual([b.json.plan, b.json.paid, b.json.balance], ['admin', true, 999999]);
  const c = await kirim(app, 'GET', '/api/internal/tts/users/u-belum');
  assert.equal(c.json.verified, false);
  for (const jalur of [SEHAT, '/api/internal/tts/users/a.b']) {
    const r = await kirim(app, 'GET', jalur);
    assert.equal(r.status, 404, jalur);
    assert.deepEqual(r.json, { error: 'not_found' });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/internal-tts.routes.test.mjs 2>&1 | tail -5`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/http/routes/internal-tts.routes.js`.

- [ ] **Step 3: Implement the router (auth + users)**

Create `server/http/routes/internal-tts.routes.js`:

```js
// server/http/routes/internal-tts.routes.js
// Pintu internal untuk LQ-TTS (tts.lq-studio.com, web app di mac-studio): verifikasi
// login LQ-Studio dan tahan/selesaikan/kembalikan kredit LQ-Studio.
//
// Jalur jaringannya BUKAN port app: port app tetap 127.0.0.1 (TRUSTED_INGRESS_IPS =
// gateway, test/client-ip-ingress.test.mjs). LQ-TTS memanggil lewat jembatan host
// ops/host/jembatan-tts-internal.mjs — 100.80.128.19:3101 (PROD) / :3112 (staging) —
// yang HANYA meneruskan /api/internal/tts/* (+ GET /api/health).
//
// Tidak ada logika auth atau uang yang ditulis ulang di sini:
//   • sandi + 2FA → services/akun/login-verify.js (SAMA dengan /api/auth/login[/2fa])
//   • kredit      → services/uang/tts-credits.js di atas kernel kredit tunggal
//   • gerbang     → makeInternalSocialAuth: Bearer LQ_TTS_INTERNAL_TOKEN (≥32, gagal-
//                   TERTUTUP), tolak header Cloudflare, ember sendiri 600 / 60 dtk.
//
// IP pengguna akhir datang di BADAN (`ip`, dari CF-Connecting-IP di sisi LQ-TTS): semua
// panggilan tiba dari peer yang SAMA, jadi backoff login & kunci 2FA per-IP memakainya.
//
// ⚠️ MIDDLEWARE PER-RUTE, seperti internal-social: router ini dipasang di ROOT, jadi
// `router.use(auth)` akan memasang gerbang Bearer pada SELURUH situs.
//
// Kliennya MESIN: galat = { error: <kode> }, bukan prosa ber-tr() — kecuali 400 dari
// validasi() bersama ({ error, code: 'validation', field }) dan 500 (error-shield).

import express from 'express';
import { z } from 'zod';
import { patchAsync } from '../async-shield.js';
import { ketat, validasi } from '../validate.js';
import { userRepo } from '../../repositories/user.repo.js';   // lapisan repo — router tidak menerima primitif DB (#BM4)
import { makeInternalSocialAuth, PAID_TIERS, isStaff } from '../../modules/identity/index.js';
import { catatAuditPeristiwa } from '../../modules/ops/index.js';
import { buatVerifikasiMasuk } from '../../services/akun/login-verify.js';

const ID_PENGGUNA = /^[A-Za-z0-9_-]{1,80}$/;
const IP = z.string().min(2).max(45).regex(/^[0-9A-Fa-f:.]+$/);

const SKEMA_VERIFY = ketat({
  identifier: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
  ip: IP,
});
const SKEMA_VERIFY_2FA = ketat({
  challenge: z.string().min(1).max(400),
  code: z.string().min(1).max(64),
  ip: IP,
});

export function createInternalTtsRouter({
  getSecret, clientIp, rlHit, log = (m) => console.error(m), JWT_SECRET, jwt,
  getUserByIdentifier, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk,
  loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts,
  totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache, effectiveTierId,
}) {
  const router = patchAsync(express.Router());
  const auth = makeInternalSocialAuth(getSecret, {
    log, clientIp, rlHit, rateKey: 'internal_tts', envName: 'LQ_TTS_INTERNAL_TOKEN', rateMax: 600, rateWindowSec: 60,
  });
  const ambilUser = (id) => userRepo.byId(id);
  const masuk = buatVerifikasiMasuk({
    JWT_SECRET, jwt, getUserByIdentifier, ambilUser, verifyPasswordAsync,
    pbKey, pbCheck, pbFail, pbOk, loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts,
    totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache,
  });

  const profil = (u) => {
    const plan = effectiveTierId(u);
    return { id: u.id, name: u.name || u.username || '', email: u.email || '', plan, paid: PAID_TIERS.has(plan) || isStaff(u) };
  };
  const terverifikasi = (u) => Boolean(u.emailVerified && u.phoneVerified);
  const tolakLaju = (res, waitSec) => res.status(429).set('Retry-After', String(waitSec)).json({ error: 'rate_limited', retryAfter: waitSec });

  router.post('/api/internal/tts/auth/verify', auth, express.json({ limit: '4kb' }), validasi({ body: SKEMA_VERIFY }), async (req, res) => {
    const { identifier, password, ip } = req.body;
    const cek = await masuk.periksaSandi({ identifier, password, ip });
    if (cek.hasil === 'terkunci_pb' || cek.hasil === 'terkunci_ip') return tolakLaju(res, cek.waitSec);
    if (cek.hasil === 'salah') return res.status(401).json({ error: 'invalid_credentials' });
    if (cek.hasil === 'ditangguhkan') return res.status(403).json({ error: 'suspended' });
    const u = cek.user;
    res.set('Cache-Control', 'no-store');
    // API LQ-Studio menuntut email DAN HP terverifikasi untuk pemakaian kredit apa pun.
    if (!terverifikasi(u)) return res.json({ status: 'needs_verification' });
    if (u.totpEnabled) return res.json({ status: 'need_2fa', challenge: masuk.buatChallenge(u, 'tts') });
    await catatAuditPeristiwa({ action: 'login', userId: u.id, changes: { role: u.role || 'user', via: 'lq-tts' }, ip });
    return res.json({ status: 'ok', user: profil(u) });
  });

  router.post('/api/internal/tts/auth/verify-2fa', auth, express.json({ limit: '4kb' }), validasi({ body: SKEMA_VERIFY_2FA }), async (req, res) => {
    const { challenge, code, ip } = req.body;
    // Satu medan untuk dua jenis kode: TOTP = tepat 6 digit (spasi/strip dibuang),
    // selebihnya diperlakukan sebagai kode cadangan (aaaa-bbbb).
    const totp = /^\d{6}$/.test(code.replace(/[\s-]/g, ''));
    const cek = await masuk.periksa2fa({ challenge, ip, flows: ['tts'], code: totp ? code : undefined, backupCode: totp ? undefined : code });
    if (cek.hasil === 'terkunci_ip' || cek.hasil === 'terkunci_akun') return tolakLaju(res, cek.waitSec);
    if (cek.hasil === 'ditangguhkan') return res.status(403).json({ error: 'suspended' });
    if (cek.hasil !== 'lolos') return res.status(401).json({ error: 'invalid_code' });
    const u = cek.user;
    res.set('Cache-Control', 'no-store');
    if (!terverifikasi(u)) return res.json({ status: 'needs_verification' });
    await catatAuditPeristiwa({ action: 'login', userId: u.id, changes: { role: u.role || 'user', twofa: true, via: 'lq-tts' }, ip });
    return res.json({ status: 'ok', user: profil(u) });
  });

  router.get('/api/internal/tts/users/:id', auth, async (req, res) => {
    const id = String(req.params.id || '');
    const u = ID_PENGGUNA.test(id) ? await ambilUser(id) : null;
    if (!u) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    return res.json({ ...profil(u), balance: Number(u.credits) || 0, suspended: Boolean(u.suspended), verified: terverifikasi(u) });
  });

  return router;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/internal-tts.routes.test.mjs test/route-module-freevars.test.mjs test/validasi-badan-menyeluruh.test.mjs test/batas-modul.test.mjs test/tipe-ratchet.test.mjs 2>&1 | tail -8`

`#TR1` is the `tsc --checkJs` ratchet (196 errors). It stays green only because `log` has a parameter default (`log = (m) => console.error(m)`); a bare `log` makes TS demand it at the `index.js` call site in Task 7.
Expected: `# fail 0`. All `#G`, `#V`, `#F` and `#U1` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/internal-tts.routes.js test/internal-tts.routes.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(internal-tts): guarded /api/internal/tts auth/verify, verify-2fa and users/:id for LQ-TTS"
```

---

### Task 6: Credit endpoints on the router

**Files:**
- Modify: `server/http/routes/internal-tts.routes.js` (import, schemas, factory params, routes)
- Test: `test/internal-tts.routes.test.mjs` (append)

**Interfaces:**
- Consumes: `buatKreditTts` (Task 4).
- Produces: the same factory, now also destructuring `deductCredits, refundCreditsStrict, recordLedger, withJobRefundLock, queryLedgerByJobPrefix`. It adds:
  - `POST /api/internal/tts/credits/hold` → 200 `{holdId, charged, balance}` | 402 `{error:'insufficient_credits', balance}` | 404 `not_found` | 409 `ref_conflict`
  - `POST /api/internal/tts/credits/settle` → 200 `{balance}` | 400 `invalid_request` | 404 `not_found` | 503 `ledger_unavailable`
  - `POST /api/internal/tts/credits/refund` → 200 `{balance, refunded}` | 404 `not_found` | 503 `ledger_unavailable`

- [ ] **Step 1: Write the failing tests**

Append to `test/internal-tts.routes.test.mjs`:

```js
// ── kredit ─────────────────────────────────────────────────────────────────

const HOLD = '/api/internal/tts/credits/hold';
const SETTLE = '/api/internal/tts/credits/settle';
const REFUND = '/api/internal/tts/credits/refund';
const ref = (n) => `tts:7f3c2a1e-0000-4000-8000-00000000000${n}:r1`;
const barisRef = (r) => baca('credit_ledger').filter((e) => e.refId === r);
const saldoDb = (id) => baca('users').find((u) => u.id === id).credits;

test('#C1 hold → 200 {holdId, charged, balance}; satu baris ledger tts ber-refType job', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', HOLD, { body: { userId: 'u-pro', amount: 10, ref: ref(1) } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { holdId: ref(1), charged: 10, balance: 90 });
  const rows = barisRef(ref(1));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].reason, rows[0].refType, rows[0].amount], ['tts', 'job', -10]);
});

test('#C2 saldo kurang → 402 insufficient_credits; saldo dan ledger utuh', async () => {
  semai();
  const r = await kirim(aplikasi(), 'POST', HOLD, { body: { userId: 'u-free', amount: 10, ref: ref(2) } });
  assert.equal(r.status, 402);
  assert.deepEqual(r.json, { error: 'insufficient_credits', balance: 5 });
  assert.equal(saldoDb('u-free'), 5);
  assert.equal(barisRef(ref(2)).length, 0);
});

test('#C3 pengguna tak dikenal → 404 not_found; ref milik pengguna lain → 409 ref_conflict', async () => {
  semai();
  const app = aplikasi();
  const a = await kirim(app, 'POST', HOLD, { body: { userId: 'u-hantu', amount: 10, ref: ref(3) } });
  assert.equal(a.status, 404);
  assert.deepEqual(a.json, { error: 'not_found' });
  assert.equal((await kirim(app, 'POST', HOLD, { body: { userId: 'u-pro', amount: 10, ref: ref(3) } })).status, 200);
  const b = await kirim(app, 'POST', HOLD, { body: { userId: 'u-free', amount: 1, ref: ref(3) } });
  assert.equal(b.status, 409);
  assert.deepEqual(b.json, { error: 'ref_conflict' });
  assert.equal(saldoDb('u-free'), 5);
});

test('#C4 masukan cacat → 400 sebelum uang disentuh', async () => {
  semai();
  const app = aplikasi();
  const cacat = [
    { userId: 'u-pro', amount: 0, ref: ref(4) },
    { userId: 'u-pro', amount: 1.5, ref: ref(4) },
    { userId: 'u-pro', amount: 10, ref: 'job:bukan-tts' },
    { userId: 'u-pro', amount: 10, ref: ref(4), userIdLain: 'u-free' },
  ];
  for (const body of cacat) assert.equal((await kirim(app, 'POST', HOLD, { body })).status, 400, JSON.stringify(body));
  assert.equal(saldoDb('u-pro'), 100);
  assert.equal(baca('credit_ledger').length, 0);
});

test('#C5 settle → 200 {balance}; melebihi hold → 400 invalid_request; pengguna lain → 404', async () => {
  semai();
  const app = aplikasi();
  await kirim(app, 'POST', HOLD, { body: { userId: 'u-pro', amount: 10, ref: ref(5) } });
  const lebih = await kirim(app, 'POST', SETTLE, { body: { userId: 'u-pro', holdId: ref(5), amount: 11 } });
  assert.equal(lebih.status, 400);
  assert.equal(lebih.json.error, 'invalid_request');
  const lain = await kirim(app, 'POST', SETTLE, { body: { userId: 'u-free', holdId: ref(5), amount: 10 } });
  assert.equal(lain.status, 404);
  const ok = await kirim(app, 'POST', SETTLE, { body: { userId: 'u-pro', holdId: ref(5), amount: 10 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { balance: 90 });
});

test('#C6 refund → 200 {balance, refunded}; refund sesudah settle → refunded 0; pengguna lain → 404', async () => {
  semai();
  const app = aplikasi();
  await kirim(app, 'POST', HOLD, { body: { userId: 'u-pro', amount: 10, ref: ref(6) } });
  const a = await kirim(app, 'POST', REFUND, { body: { userId: 'u-pro', holdId: ref(6) } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { balance: 100, refunded: 10 });
  await kirim(app, 'POST', HOLD, { body: { userId: 'u-pro', amount: 10, ref: ref(7) } });
  await kirim(app, 'POST', SETTLE, { body: { userId: 'u-pro', holdId: ref(7), amount: 10 } });
  const b = await kirim(app, 'POST', REFUND, { body: { userId: 'u-pro', holdId: ref(7) } });
  assert.deepEqual(b.json, { balance: 90, refunded: 0 });
  const c = await kirim(app, 'POST', REFUND, { body: { userId: 'u-free', holdId: ref(6) } });
  assert.equal(c.status, 404);
  assert.deepEqual(c.json, { error: 'not_found' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/internal-tts.routes.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `#C1`–`#C6` fail with `404 !== 200` (or a similar 404 assertion) because the routes do not exist yet. Every other test passes.

- [ ] **Step 3: Implement the credit routes**

Edit `server/http/routes/internal-tts.routes.js`:

(a) After the line `import { buatVerifikasiMasuk } from '../../services/akun/login-verify.js';` insert:

```js
import { buatKreditTts } from '../../services/uang/tts-credits.js';
```

(b) After the `SKEMA_VERIFY_2FA` declaration (after its closing `});`) insert:

```js
// `ref`/`holdId` OPAK milik LQ-TTS (mis. `tts:<uuid>:r1`, `tts:<job>:r2:s3:a1`); ia
// menjadi refId ledger apa adanya, jadi bentuknya dibatasi tanpa ditafsirkan.
const REF_TTS = z.string().regex(/^tts:[A-Za-z0-9:_-]{1,150}$/);
const USER_ID = z.string().regex(ID_PENGGUNA);
const SKEMA_HOLD = ketat({ userId: USER_ID, amount: z.number().int().min(1).max(1_000_000), ref: REF_TTS });
const SKEMA_SETTLE = ketat({ userId: USER_ID, holdId: REF_TTS, amount: z.number().int().min(0).max(1_000_000) });
const SKEMA_REFUND = ketat({ userId: USER_ID, holdId: REF_TTS });
```

(c) Replace the factory parameter list

```js
export function createInternalTtsRouter({
  getSecret, clientIp, rlHit, log = (m) => console.error(m), JWT_SECRET, jwt,
  getUserByIdentifier, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk,
  loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts,
  totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache, effectiveTierId,
}) {
```

with

```js
export function createInternalTtsRouter({
  getSecret, clientIp, rlHit, log = (m) => console.error(m), JWT_SECRET, jwt,
  getUserByIdentifier, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk,
  loginAttempts, bumpLoginFail, twofaAttempts, twofaAccountAttempts,
  totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache, effectiveTierId,
  deductCredits, refundCreditsStrict, recordLedger, withJobRefundLock, queryLedgerByJobPrefix,
}) {
```

(d) After the `const masuk = buatVerifikasiMasuk({ … });` statement insert:

```js
  const kredit = buatKreditTts({ deductCredits, refundCreditsStrict, recordLedger, withJobRefundLock, queryLedgerByJobPrefix, ambilUser });
  // Kernel tidak bisa membayar/mencatat (refund tidak menaikkan saldo, penanda gagal
  // ditulis): 503 supaya LQ-TTS mencoba lagi — rekonsiliasinya mengulang tiap 60 dtk.
  const bukuGagal = (res, holdId, alasan) => {
    log(`[internal-tts] kredit TIDAK berpindah untuk ${holdId}: ${alasan}`);
    return res.status(503).json({ error: 'ledger_unavailable' });
  };
```

(e) Before the final `  return router;` insert:

```js
  router.post('/api/internal/tts/credits/hold', auth, express.json({ limit: '4kb' }), validasi({ body: SKEMA_HOLD }), async (req, res) => {
    const r = await kredit.tahan(req.body);
    res.set('Cache-Control', 'no-store');
    if (r.hasil === 'ok') return res.json({ holdId: r.holdId, charged: r.charged, balance: r.balance });
    if (r.hasil === 'saldo_kurang') return res.status(402).json({ error: 'insufficient_credits', balance: r.balance });
    if (r.hasil === 'bentrok') return res.status(409).json({ error: 'ref_conflict' });
    return res.status(404).json({ error: 'not_found' });
  });

  router.post('/api/internal/tts/credits/settle', auth, express.json({ limit: '4kb' }), validasi({ body: SKEMA_SETTLE }), async (req, res) => {
    const r = await kredit.selesaikan(req.body);
    res.set('Cache-Control', 'no-store');
    if (r.hasil === 'ok') return res.json({ balance: r.balance });
    if (r.hasil === 'melebihi') return res.status(400).json({ error: 'invalid_request', message: 'amount exceeds the held credits' });
    if (r.hasil === 'gagal') return bukuGagal(res, req.body.holdId, r.alasan);
    return res.status(404).json({ error: 'not_found' });
  });

  router.post('/api/internal/tts/credits/refund', auth, express.json({ limit: '4kb' }), validasi({ body: SKEMA_REFUND }), async (req, res) => {
    const r = await kredit.kembalikan(req.body);
    res.set('Cache-Control', 'no-store');
    if (r.hasil === 'ok') return res.json({ balance: r.balance, refunded: r.refunded });
    if (r.hasil === 'gagal') return bukuGagal(res, req.body.holdId, r.alasan);
    return res.status(404).json({ error: 'not_found' });
  });

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/internal-tts.routes.test.mjs test/tts-credits.test.mjs test/route-module-freevars.test.mjs test/validasi-badan-menyeluruh.test.mjs 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/internal-tts.routes.js test/internal-tts.routes.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(internal-tts): credits hold/settle/refund endpoints (C1) over tts-credits"
```

---

### Task 7: Wire into the app: mount, ledger labels, Usage page, route map, ratchets, env docs

**Files:**
- Create: `server/config/ledger-labels.js`, `test/ledger-labels.test.mjs`
- Modify:
  - `server/index.js:50,185,1430,1441,2980-2998`
  - `server/http/routes/internal-social.routes.js:4`
  - `scripts/peta-rute.mjs:75-76`
  - `server/PETA-RUTE.md` (regenerated)
  - `client/src/pages/UsagePage.jsx:85,145`
  - `test/monolith-budget.test.mjs:142`
  - `test/validasi-cakupan.test.mjs:41,60`
  - `.env.example:74`

**Interfaces:**
- Consumes: `createInternalTtsRouter` (Tasks 5–6), and the kernel values already in `index.js` scope.
- Produces:
  - `export function ledgerFeatureLabel(e, j)` from `server/config/ledger-labels.js` (the reason map stays a module-private `const`; `test/penjaga-tidak-lulus-hampa.test.mjs` #PH4 forbids exports without readers)
  - `/api/internal/tts/*` live in the app, reading `process.env.LQ_TTS_INTERNAL_TOKEN` per request

- [ ] **Step 1: Write the failing label test**

Create `test/ledger-labels.test.mjs`:

```js
// test/ledger-labels.test.mjs
// Baris ledger LQ-TTS harus terbaca "LQ-TTS" di kolom Fitur halaman Usage — tanpa
// entri, ledgerFeatureLabel jatuh ke Title Case mentah ("Tts", "Tts Settle").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFeatureLabel } from '../server/config/ledger-labels.js';

test('#LL1 hold, settle, dan refund LQ-TTS berlabel "LQ-TTS"', () => {
  for (const reason of ['tts', 'tts_settle', 'tts_refund']) {
    assert.equal(ledgerFeatureLabel({ reason, metadata: { subtype: 'tts' } }, null), 'LQ-TTS', reason);
  }
});
```

Run: `node --test test/ledger-labels.test.mjs 2>&1 | tail -3`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/config/ledger-labels.js`.

- [ ] **Step 2: Create `server/config/ledger-labels.js`**

```js
// server/config/ledger-labels.js
// Label FITUR satu baris buku besar (+ job yang tergabung, kalau ada) — kolom "Fitur"
// di halaman Usage (http/routes/usage.routes.js). Dipindah UTUH dari server/index.js
// 2026-10-03 saat alasan LQ-TTS ditambahkan; tidak merujuk ADMIN_FEATURE_LABELS.
const LEDGER_FEATURE_BY_REASON = {
  ai_shorts_render: 'AI Video', quick_render: 'AI Video', aishort_motion: 'AI Video',
  playground: 'Playground', longform_render: 'Long-Form', longform_aimode: 'Long-Form',
  animated_story_render: 'Animated Story', canvas: 'Canvas', canvas_visual: 'Canvas',
  board_tile: 'Canvas', drama_render: 'Drama', clipper: 'AI Clipper', influencer: 'AI Influencer',
  render: 'Generation', topup: 'Top-up', bonus: 'Bonus', referral: 'Referral',
  tts: 'LQ-TTS', tts_settle: 'LQ-TTS', tts_refund: 'LQ-TTS',
};

export function ledgerFeatureLabel(e, j) {
  if (j && j.studioLabel) return j.studioLabel;
  const r = e && e.reason;
  if (r && LEDGER_FEATURE_BY_REASON[r]) return LEDGER_FEATURE_BY_REASON[r];
  const md = (e && e.metadata) || {};
  if (md.subtype && LEDGER_FEATURE_BY_REASON[md.subtype]) return LEDGER_FEATURE_BY_REASON[md.subtype];
  if (md.type && LEDGER_FEATURE_BY_REASON[md.type]) return LEDGER_FEATURE_BY_REASON[md.type];
  if (r) return String(r).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return null;
}
```

Run: `node --test test/ledger-labels.test.mjs 2>&1 | tail -3`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 3: Edit `server/index.js`, bottom-up so the original line numbers stay valid**

(e) Delete lines 2980-2998 entirely. These are the two comment lines `// Human feature label for a ledger entry …` and `// (does NOT reference ADMIN_FEATURE_LABELS …`, the `const _LEDGER_FEATURE_BY_REASON = { … };` block, and the `function ledgerFeatureLabel(e, j) { … }` block.

After the deletion, line 2979 (`}` closing `resolveModelMeta`) is directly followed by `// Curated PRESETS (template layer): …`.

(d) After line 1441 (`}));`, which closes `app.use(createInternalSocialRouter({`) insert these 10 lines (one blank line first):

```js

// ─── PINTU INTERNAL: login + kredit untuk LQ-TTS (tts.lq-studio.com) ───
// Terjangkau HANYA lewat jembatan tailnet di host (ops/host/jembatan-tts-internal.mjs);
// gerbang & ember batas laju sendiri (LQ_TTS_INTERNAL_TOKEN, 600/60 dtk), gagal-TERTUTUP.
app.use(createInternalTtsRouter({
  JWT_SECRET, jwt, clientIp, rlHit, getSecret: () => process.env.LQ_TTS_INTERNAL_TOKEN || '',
  getUserByIdentifier, verifyPasswordAsync, pbKey, pbCheck, pbFail, pbOk, loginAttempts, bumpLoginFail,
  twofaAttempts, twofaAccountAttempts, totpStep, decryptSecret, consumeBackupCode, writeUser, bustAuthCache,
  effectiveTierId, deductCredits, refundCreditsStrict, recordLedger, withJobRefundLock, queryLedgerByJobPrefix,
}));
```

(c) Line 1430: replace

```js
// Satu-satunya rute /api/internal/*. lq-socmed (di lq-server) meminjam access token
```

with

```js
// Pintu /api/internal/* pertama (kedua: LQ-TTS, di bawah). lq-socmed meminjam access token
```

(b) After line 185 (`import { createInternalSocialRouter } from './http/routes/internal-social.routes.js'; // pintu peminjaman token untuk lq-socmed`) insert:

```js
import { createInternalTtsRouter } from './http/routes/internal-tts.routes.js'; // pintu login + kredit untuk LQ-TTS (jembatan tailnet)
```

(a) After line 50 (`import { FILES } from './config/tabel-db.js';`) insert:

```js
import { ledgerFeatureLabel } from './config/ledger-labels.js';   // label Fitur baris ledger (halaman Usage), termasuk LQ-TTS
```

Run: `node -c server/index.js && wc -l server/index.js`
Expected: no syntax error, and `5260 server/index.js` (5267 − 19 + 1 + 1 + 10).

- [ ] **Step 4: Header comment in `internal-social.routes.js`**

Line 4: replace

```js
// Satu-satunya rute /api/internal/*. Ada supaya lq-socmed (penjadwal sosial di lq-server)
```

with

```js
// Satu dari dua pintu /api/internal/* (yang lain: internal-tts.routes.js). Ada supaya lq-socmed (penjadwal sosial di lq-server)
```

- [ ] **Step 5: Register the shared prefix and regenerate the route map**

In `scripts/peta-rute.mjs`, insert before line 76 (`]);`, which closes `PEMILIK_GANDA_SENGAJA`) and after the `'/api/videos'` entry's closing `],`:

```js
  ['/api/internal',
   'SENGAJA — dua pintu MESIN dengan rahasia, pemanggil, dan jalur jaringan berbeda: '
   + '`internal-social` (lq-socmed, LQ_SOCIAL_TOKEN, meminjam token akun brand) dan '
   + '`internal-tts` (LQ-TTS di mac-studio lewat jembatan tailnet, LQ_TTS_INTERNAL_TOKEN, '
   + 'login + kredit). Menyatukannya membuat satu berkas memegang dua kredensial dan dua '
   + 'ember batas laju — kebocoran satu pintu jadi kuasa atas yang lain.'],
```

Run: `node scripts/peta-rute.mjs`
Expected:

```
peta ditulis: server/PETA-RUTE.md — 350 rute, 58 berkas, 109 prefiks domain
invarian rute: bersih
```

- [ ] **Step 6: Ratchets**

(a) In `test/monolith-budget.test.mjs`, line 142, replace the beginning of the line

```js
const MAKS_BARIS_MONOLITH = 5268;   // 5299 → 5268 (2026-09-27: makeKieImageFallback → services/konten/gambar-konten.js)
```

with

```js
const MAKS_BARIS_MONOLITH = 5261;   // 5268 → 5261 (2026-10-03: label Fitur ledger → config/ledger-labels.js, + pintu LQ-TTS) · 5299 → 5268 (2026-09-27: makeKieImageFallback → services/konten/gambar-konten.js)
```

Keep the rest of the line (` · 5301 → 5299 …`) unchanged.

⚠️ `#MB3` counts `SRC.split('\n').length`. That is `wc -l` + 1, because the file ends with a newline: today `wc -l` = 5267 and the budget is 5268. So the budget is the Step 3 `wc -l` value plus 1, i.e. **5261** if Step 3 printed 5260. Use exactly that value: the ratchet is two-way.

(b) Count the validated routes:

```bash
node -e "const fs=require('fs'),p=require('path');const D='server/http/routes';let n=0;for(const f of fs.readdirSync(D).filter(f=>f.endsWith('.js'))){n+=(fs.readFileSync(p.join(D,f),'utf8').match(/router\.(get|post|put|patch|delete)\([^;]*?validasi\(/g)||[]).length}console.log(n)"
```

Expected: `186`.

In `test/validasi-cakupan.test.mjs`, line 41, replace

```js
const MIN_RUTE_BERVALIDASI = 176;   // 162 -> 177 (2026-09-09): 13 rute diamankan + 2 webhook Telegram akhirnya TERBACA
```

with the following (use the printed number if it is not 186):

```js
const MIN_RUTE_BERVALIDASI = 186;   // 176 -> 186 (2026-10-03): ratchet disusulkan ke 181 yang sudah ada + 5 rute /api/internal/tts bervalidasi
                                    // 162 -> 177 (2026-09-09): 13 rute diamankan + 2 webhook Telegram akhirnya TERBACA
```

(c) In the same file, after line 60 (`  ['admin-refund', "'/api/admin/refunds/:id/reject'"],`) insert:

```js
  ['internal-tts', "'/api/internal/tts/credits/hold'"],
  ['internal-tts', "'/api/internal/tts/credits/settle'"],
  ['internal-tts', "'/api/internal/tts/credits/refund'"],
```

- [ ] **Step 7: Usage page labels**

In `client/src/pages/UsagePage.jsx`, after line 85 (`    reason_render: 'Render Video',`, in the `id` block) insert:

```js
    reason_tts: 'LQ-TTS · Suara AI',
    reason_tts_settle: 'LQ-TTS · Selesai',
    reason_tts_refund: 'LQ-TTS · Refund (gagal/batal)',
```

After line 145 (`    reason_render: 'Video Render',`, in the `en` block; it becomes line 148 after the insert above) insert:

```js
    reason_tts: 'LQ-TTS · AI Voice',
    reason_tts_settle: 'LQ-TTS · Settled',
    reason_tts_refund: 'LQ-TTS · Refund (failed/canceled)',
```

- [ ] **Step 8: Document the env name (no value)**

In `.env.example`, after line 74 (`#   (that file is git-tracked; RENDER_SECRET leaked to GitHub exactly that way).`) insert:

```
# LQ_TTS_INTERNAL_TOKEN=             # LQ-TTS web (mac-studio) → /api/internal/tts/* via the host relay
#   (ops/host/lq-tts-jembatan-{prod,stg}.service). ≥32 chars, DIFFERENT per environment;
#   empty/short ⇒ 503. Lives in the app's env_file .env (PROD: repo/.env, mirrored in ../.env).
```

- [ ] **Step 9: Structural guards, client lint, and a boot smoke**

Run:

```bash
git add -A server test scripts client/src .env.example   # stage first: #SD1 and #PH4 read `git ls-files`
node --test test/ledger-labels.test.mjs test/peta-rute.test.mjs test/monolith-budget.test.mjs test/monolith-freevars-2026-09-06.test.mjs test/router-tdz-2026-09-06.test.mjs test/injeksi-router.test.mjs test/route-module-freevars.test.mjs test/credit-kernel-single.test.mjs test/validasi-badan-menyeluruh.test.mjs test/validasi-cakupan.test.mjs test/batas-modul.test.mjs test/test-gate.test.mjs test/masking-galat.test.mjs test/usage-routes-pagination.test.mjs test/async-route-shield.test.mjs test/client-ip-ingress.test.mjs test/server-boots.test.mjs test/struktur-direktori.test.mjs test/penjaga-tidak-lulus-hampa.test.mjs test/nama-berkas-layanan.test.mjs test/tipe-ratchet.test.mjs 2>&1 | tail -8
```

Expected: `# fail 0`.

Run: `(cd client && npx eslint src/pages/UsagePage.jsx)`
Expected: 0 errors (warnings are allowed).

Boot smoke. This proves the real `server/index.js` mounts the door, reads the token per request, and maps the kernel. The token below is a throwaway local value, not a secret.

```bash
cd /home/lq/lq-studio-stg
D=$(mktemp -d); T=smoke-token-bukan-rahasia-0123456789abcdef
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test DB_BACKEND=sqlite DATA_DIR="$D/data" UPLOAD_DIR="$D/uploads" OUTPUT_DIR="$D/output" CACHE_DIR="$D/cache" DRAFTS_DIR="$D/drafts" WA_DATA_DIR="$D/wa" PORT=39871 HOST=127.0.0.1 JWT_SECRET=uji-boot-hermetis LQ_TTS_INTERNAL_TOKEN="$T" node server/index.js > "$D/boot.log" 2>&1 &
PID=$!
for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:39871/api/health && break; sleep 1; done
B=http://127.0.0.1:39871/api/internal/tts
curl -s -w ' %{http_code}\n' "$B/users/__lqtts_health__" -H "Authorization: Bearer $T"
curl -s -w ' %{http_code}\n' "$B/users/__lqtts_health__"
curl -s -w ' %{http_code}\n' "$B/users/__lqtts_health__" -H "Authorization: Bearer $T" -H 'cf-ray: smoke'
curl -s -w ' %{http_code}\n' -X POST "$B/credits/hold" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"userId":"smoke-tidak-ada","amount":1,"ref":"tts:smoke:r1"}'
curl -s -w ' %{http_code}\n' -X POST "$B/auth/verify" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"identifier":"smoke@example.invalid","password":"x","ip":"198.51.100.7"}'
kill "$PID"; rm -rf "$D"
```

Expected output, in order:

```
{"error":"not_found"} 404
{"ok":false,"error":"unauthorized"} 401
{"ok":false,"error":"internal_route_not_public"} 403
{"error":"not_found"} 404
{"error":"invalid_credentials"} 401
```

- [ ] **Step 10: Commit**

```bash
git add server/config/ledger-labels.js test/ledger-labels.test.mjs server/index.js server/http/routes/internal-social.routes.js scripts/peta-rute.mjs server/PETA-RUTE.md test/monolith-budget.test.mjs test/validasi-cakupan.test.mjs client/src/pages/UsagePage.jsx .env.example
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(internal-tts): mount /api/internal/tts, Usage labels for tts/tts_settle/tts_refund, route map + ratchets"
```

---

### Task 8: Tailnet relay, its units, and the docs

**Files:**
- Create: `ops/host/jembatan-tts-internal.mjs`, `ops/host/lq-tts-jembatan-prod.service`, `ops/host/lq-tts-jembatan-stg.service`, `test/jembatan-tts-internal.test.mjs`
- Modify: `ops/host/README.md` (lq-server table), `CLAUDE.md` §2 (after line 36)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (it only forwards HTTP).
- Produces:
  - `export function jalurDiizinkan(method:string, url:string): boolean`
  - `export function buatJembatan({ tujuanHost:string, tujuanPort:number }): http.Server`
  - CLI: `node jembatan-tts-internal.mjs --dengar <ipv4:port> --tuju <ipv4:port>`
  - Units `lq-tts-jembatan-prod` (3101 → 3001) and `lq-tts-jembatan-stg` (3112 → 3012), both running `~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/jembatan-tts-internal.test.mjs`:

```js
// test/jembatan-tts-internal.test.mjs
// Jembatan tailnet LQ-TTS: HANYA pintu /api/internal/tts/* (+ GET /api/health) yang
// boleh lewat, dan yang lewat diteruskan UTUH — termasuk header Cloudflare, supaya
// gerbang aplikasi yang menolaknya (403), bukan jembatan yang diam-diam membuangnya.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { jalurDiizinkan, buatJembatan } from '../ops/host/jembatan-tts-internal.mjs';

const dengar = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('#JT1 daftar-izin: metode + jalur PERSIS; selebihnya ditolak', () => {
  const lolos = [
    ['POST', '/api/internal/tts/auth/verify'], ['POST', '/api/internal/tts/auth/verify-2fa'],
    ['GET', '/api/internal/tts/users/u-1'], ['GET', '/api/internal/tts/users/__lqtts_health__'],
    ['POST', '/api/internal/tts/credits/hold'], ['POST', '/api/internal/tts/credits/settle'],
    ['POST', '/api/internal/tts/credits/refund'], ['GET', '/api/health'],
  ];
  for (const [m, u] of lolos) assert.equal(jalurDiizinkan(m, u), true, `${m} ${u}`);
  const tolak = [
    ['POST', '/api/auth/login'], ['GET', '/api/auth/check'], ['GET', '/'],
    ['GET', '/api/internal/social-token?platform=threads'],
    ['POST', '/api/internal/tts/auth/verify/'], ['POST', '/api/internal/tts/auth/verify?x=1'],
    ['POST', '/api/internal/tts/../auth/login'], ['POST', '/api/internal/tts/%2e%2e/auth/login'],
    ['GET', '/api/internal/tts/users/a%2Fb'], ['GET', '//api/internal/tts/users/u-1'],
    ['GET', '/api/internal/tts/credits/hold'], ['POST', '/api/internal/tts/users/u-1'],
    ['DELETE', '/api/internal/tts/credits/refund'], ['GET', '/api/health?x=1'],
    ['GET', 'http://127.0.0.1:3001/api/auth/check'],
  ];
  for (const [m, u] of tolak) assert.equal(jalurDiizinkan(m, u), false, `${m} ${u}`);
});

test('#JT2 permintaan sah diteruskan UTUH: metode, jalur, badan, Authorization, header Cloudflare', async () => {
  let dilihat = null;
  const hulu = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      dilihat = { method: req.method, url: req.url, headers: req.headers, body: b };
      res.writeHead(201, { 'content-type': 'application/json', 'x-hulu': 'ya' });
      res.end('{"ok":true}');
    });
  });
  const jembatan = buatJembatan({ tujuanHost: '127.0.0.1', tujuanPort: await dengar(hulu) });
  const p = await dengar(jembatan);
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/internal/tts/credits/hold`, {
      method: 'POST',
      headers: { authorization: 'Bearer rahasia-uji', 'content-type': 'application/json', 'cf-ray': 'abc' },
      body: '{"userId":"u-1"}',
    });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-hulu'), 'ya');
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(dilihat.method, 'POST');
    assert.equal(dilihat.url, '/api/internal/tts/credits/hold');
    assert.equal(dilihat.body, '{"userId":"u-1"}');
    assert.equal(dilihat.headers.authorization, 'Bearer rahasia-uji');
    assert.equal(dilihat.headers['cf-ray'], 'abc', 'header Cloudflare harus sampai ke gerbang aplikasi (yang menolaknya 403)');
  } finally { jembatan.close(); hulu.close(); }
});

test('#JT3 jalur di luar daftar-izin → 404 not_found dan hulu TIDAK pernah dihubungi', async () => {
  let dihubungi = 0;
  const hulu = http.createServer((_req, res) => { dihubungi += 1; res.end('bocor'); });
  const jembatan = buatJembatan({ tujuanHost: '127.0.0.1', tujuanPort: await dengar(hulu) });
  const p = await dengar(jembatan);
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/auth/check`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not_found' });
    assert.equal(dihubungi, 0);
  } finally { jembatan.close(); hulu.close(); }
});

test('#JT4 hulu mati → 502 upstream_unavailable', async () => {
  const sementara = http.createServer();
  const mati = await dengar(sementara);
  await new Promise((r) => sementara.close(r));
  const jembatan = buatJembatan({ tujuanHost: '127.0.0.1', tujuanPort: mati });
  const p = await dengar(jembatan);
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'upstream_unavailable' });
  } finally { jembatan.close(); }
});
```

Run: `node --test test/jembatan-tts-internal.test.mjs 2>&1 | tail -3`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `ops/host/jembatan-tts-internal.mjs`.

- [ ] **Step 2: Create the relay**

Create `ops/host/jembatan-tts-internal.mjs`:

```js
#!/usr/bin/env node
// ops/host/jembatan-tts-internal.mjs — jembatan tailnet SEMPIT untuk pintu internal LQ-TTS.
//
// Port app LQ-Studio SENGAJA hanya terbit di 127.0.0.1: compose mempercayai `gateway`
// sebagai ingress (TRUSTED_INGRESS_IPS), dan port non-loopback mana pun membuat siapa
// pun di jaringan itu bisa memalsukan cf-connecting-ip untuk SELURUH aplikasi (dijaga
// test/client-ip-ingress.test.mjs). LQ-TTS di mac-studio butuh /api/internal/tts/* lewat
// Tailscale — jadi yang diterbitkan bukan port app, melainkan jembatan ini:
//   100.80.128.19:3101 → 127.0.0.1:3001 (PROD) · 100.80.128.19:3112 → 127.0.0.1:3012 (staging)
//
// Ia meneruskan HANYA pasangan metode+jalur di IZIN (persis: tanpa query, tanpa
// %-enkode, tanpa segmen titik) dan menjawab 404 untuk selebihnya TANPA menyentuh hulu.
// Header diteruskan apa adanya (kecuali hop-by-hop): Authorization untuk gerbang Bearer,
// dan cf-ray/cf-connecting-ip SAMPAI ke gerbang supaya ia menolak 403. Itu aman: setiap
// jalur yang lolos dijaga makeInternalSocialAuth, yang menolak permintaan ber-header
// Cloudflare sebelum apa pun membaca IP-nya.
//
// Mandiri (hanya node:*) karena yang dijalankan unit adalah SALINAN di
// ~/.local/lib/lq-tts-jembatan/ — dir staging berganti cabang, jadi unit tidak boleh
// menjalankan berkas di checkout.
// Pakai: node jembatan-tts-internal.mjs --dengar 100.80.128.19:3112 --tuju 127.0.0.1:3012
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const IZIN = [
  ['POST', /^\/api\/internal\/tts\/auth\/verify(?:-2fa)?$/],
  ['GET', /^\/api\/internal\/tts\/users\/[A-Za-z0-9_-]{1,80}$/],
  ['POST', /^\/api\/internal\/tts\/credits\/(?:hold|settle|refund)$/],
  ['GET', /^\/api\/health$/],
];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host']);

export function jalurDiizinkan(method, url) {
  return typeof url === 'string' && IZIN.some(([m, pola]) => m === method && pola.test(url));
}

const salinHeader = (h) => {
  const o = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase())) o[k] = v;
  return o;
};

const jawabJson = (res, status, body) => {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function buatJembatan({ tujuanHost, tujuanPort }) {
  return http.createServer((req, res) => {
    if (!jalurDiizinkan(req.method, req.url)) return jawabJson(res, 404, { error: 'not_found' });
    const hulu = http.request({
      host: tujuanHost,
      port: tujuanPort,
      method: req.method,
      path: req.url,
      headers: { ...salinHeader(req.headers), host: `${tujuanHost}:${tujuanPort}` },
      agent: false,          // satu koneksi per permintaan: volume kecil, tanpa soket menggantung
      timeout: 30_000,
    }, (r) => {
      res.writeHead(r.statusCode || 502, salinHeader(r.headers));
      r.pipe(res);
    });
    hulu.on('timeout', () => hulu.destroy(new Error('timeout hulu')));
    hulu.on('error', () => jawabJson(res, 502, { error: 'upstream_unavailable' }));
    req.pipe(hulu);
  });
}

function alamat(teks, nama) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(teks || ''));
  if (!m) throw new Error(`--${nama} wajib berbentuk ipv4:port, dapat ${JSON.stringify(teks)}`);
  return { host: m[1], port: Number(m[2]) };
}

const arg = (nama) => {
  const i = process.argv.indexOf(`--${nama}`);
  return i > 1 ? process.argv[i + 1] : undefined;
};

// Bentuk aman-spasi (bukan perbandingan dengan path mentah): lihat scripts/dijalankan-langsung.mjs.
const dijalankanLangsung = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();

if (dijalankanLangsung) {
  const dengar = alamat(arg('dengar'), 'dengar');
  const tuju = alamat(arg('tuju'), 'tuju');
  const server = buatJembatan({ tujuanHost: tuju.host, tujuanPort: tuju.port });
  server.on('error', (e) => {
    console.error(`[jembatan-tts] GAGAL mendengar ${dengar.host}:${dengar.port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(dengar.port, dengar.host, () => {
    console.log(`[jembatan-tts] ${dengar.host}:${dengar.port} → ${tuju.host}:${tuju.port} (hanya /api/internal/tts/* + GET /api/health)`);
  });
}
```

Run: `node --test test/jembatan-tts-internal.test.mjs 2>&1 | tail -3`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 3: Create the units**

Create `ops/host/lq-tts-jembatan-stg.service`:

```ini
# ~/.config/systemd/user/lq-tts-jembatan-stg.service (lq-server, unit USER — tanpa sudo).
# Jembatan tailnet LQ-TTS STAGING: 100.80.128.19:3112 → 127.0.0.1:3012, HANYA
# /api/internal/tts/* (+ GET /api/health). Port app tetap loopback (TRUSTED_INGRESS_IPS =
# gateway, dijaga test/client-ip-ingress.test.mjs); jembatan ini yang menerbitkan pintu sempitnya.
# Pasang: install -D -m 644 ops/host/jembatan-tts-internal.mjs ~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs &&
#   cp ops/host/lq-tts-jembatan-stg.service ~/.config/systemd/user/ &&
#   systemctl --user daemon-reload && systemctl --user enable --now lq-tts-jembatan-stg
# Gagal bind (Tailscale belum naik saat boot) = keluar 1 → Restart=always mencoba lagi tiap 5 dtk.
[Unit]
Description=Jembatan tailnet LQ-TTS staging: 100.80.128.19:3112 -> 127.0.0.1:3012 (/api/internal/tts/* saja)
After=network-online.target

[Service]
ExecStart=/usr/local/bin/node %h/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs --dengar 100.80.128.19:3112 --tuju 127.0.0.1:3012
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Create `ops/host/lq-tts-jembatan-prod.service`:

```ini
# ~/.config/systemd/user/lq-tts-jembatan-prod.service (lq-server, unit USER — tanpa sudo).
# Jembatan tailnet LQ-TTS PROD: 100.80.128.19:3101 → 127.0.0.1:3001, HANYA
# /api/internal/tts/* (+ GET /api/health). Port app tetap loopback (TRUSTED_INGRESS_IPS =
# gateway, dijaga test/client-ip-ingress.test.mjs); jembatan ini yang menerbitkan pintu sempitnya.
# Pasang: install -D -m 644 ops/host/jembatan-tts-internal.mjs ~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs &&
#   cp ops/host/lq-tts-jembatan-prod.service ~/.config/systemd/user/ &&
#   systemctl --user daemon-reload && systemctl --user enable --now lq-tts-jembatan-prod
# Gagal bind (Tailscale belum naik saat boot) = keluar 1 → Restart=always mencoba lagi tiap 5 dtk.
[Unit]
Description=Jembatan tailnet LQ-TTS PROD: 100.80.128.19:3101 -> 127.0.0.1:3001 (/api/internal/tts/* saja)
After=network-online.target

[Service]
ExecStart=/usr/local/bin/node %h/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs --dengar 100.80.128.19:3101 --tuju 127.0.0.1:3001
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Docs**

In `ops/host/README.md`, in the `## lq-server (PROD sejak 2026-09-23)` table, after the `| \`lq-demo-tunnel.service\` | …` row, add:

```
| `lq-tts-jembatan-{prod,stg}.service` + `jembatan-tts-internal.mjs` | systemd **user** | selalu — jembatan tailnet LQ-TTS: `100.80.128.19:3101` → PROD `127.0.0.1:3001`, `:3112` → staging `127.0.0.1:3012`; HANYA `/api/internal/tts/*` + `GET /api/health` (selebihnya 404). Yang dijalankan SALINAN di `~/.local/lib/lq-tts-jembatan/` (dir staging berganti cabang) |
```

In `CLAUDE.md`, after line 36 (the `- **AI Clipper merender klip SERENTAK** …` bullet) insert:

```
- 🔌 **Pintu LQ-TTS lewat tailnet = JEMBATAN HOST, bukan port compose.** `lq-tts-jembatan-prod` (100.80.128.19:3101 → 127.0.0.1:3001) dan `lq-tts-jembatan-stg` (:3112 → 127.0.0.1:3012), unit systemd user dari `ops/host/`, meneruskan HANYA `/api/internal/tts/*` (+ `GET /api/health`). Port app tetap 127.0.0.1 karena `TRUSTED_INGRESS_IPS=gateway` — port non-loopback = siapa pun di tailnet memalsukan cf-connecting-ip (dijaga `test/client-ip-ingress.test.mjs`). Rahasia `LQ_TTS_INTERNAL_TOKEN` (≥32 char, beda per env) di `.env` env_file (PROD: `repo/.env`, dicermin ke `../.env`); kosong ⇒ 503. Ganti rahasia = edit `.env` + `up -d` + perbarui `LQSTUDIO_TOKEN` LQ-TTS di mac-studio.
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/jembatan-tts-internal.test.mjs test/cadangan-terenkripsi.test.mjs test/impor-server-ada.test.mjs test/struktur-direktori.test.mjs 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add ops/host/jembatan-tts-internal.mjs ops/host/lq-tts-jembatan-prod.service ops/host/lq-tts-jembatan-stg.service ops/host/README.md CLAUDE.md test/jembatan-tts-internal.test.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "feat(ops): tailnet relay exposing only /api/internal/tts/* on 100.80.128.19:3101/3112 (app ports stay loopback)"
```

---

### Task 9: Gates, then STAGING deploy, then tailnet smoke, then push

**Files:** none changed. Deploy only.

**Interfaces:**
- Consumes: branch `feat-lq-tts-internal` (Tasks 1–8).
- Produces:
  - LQ-Studio staging serving `/api/internal/tts/*` on `http://100.80.128.19:3112`
  - `LQ_TTS_INTERNAL_TOKEN` stored in `/home/lq/lq-studio-stg/.env`, which Plan 2B/2C pipe from there
  - `origin/staging` and `origin/main` containing the work

- [ ] **Step 1: Full pre-deploy gates (CLAUDE.md §4), on the feature branch**

```bash
cd /home/lq/lq-studio-stg
node -c server/index.js
(cd client && npx eslint src/pages/UsagePage.jsx)
node --test test/*.test.mjs > ~/.cache/plan2a-suite-akhir.log 2>&1; grep -E '^# (pass|fail)' ~/.cache/plan2a-suite-akhir.log
grep -E '^not ok' ~/.cache/plan2a-suite-akhir.log | sed -E 's/^not ok [0-9]+ - //' | sort > ~/.cache/plan2a-gagal-akhir.txt
comm -13 ~/.cache/plan2a-gagal-dasar.txt ~/.cache/plan2a-gagal-akhir.txt   # NEW failures — must print nothing
node scripts/aset-r2.mjs tarik
(cd client && npm run build)
node scripts/peta-rute.mjs --periksa
git status --porcelain
```

Expected:
- the syntax check is OK and eslint reports 0 errors
- `# pass` is `BASE_PASS` + 58 or more. Measured on a throwaway copy, the new files add 58 passing test points: 2 `#IG`, 12 `#AK`, 15 `#KT`, 23 router tests, 1 `#LL`, 4 `#JT`, plus 1 per-file wrapper.
- `# fail` equals `BASE_FAIL`.
- the `comm` line prints NOTHING. That means no new failing test, and it is the hard gate. Pre-existing host-only failures (e.g. the `remotion/public/content` symlink tests `#RC1/#RC4/#UB*` noted in the brain on 2026-10-01) may appear in both lists.
- `tarik` succeeds and the build exits 0
- `invarian rute: bersih`
- `git status --porcelain` prints nothing (`client/dist` is gitignored)

- [ ] **Step 2: Create the staging token, without printing it, before the container is recreated**

```bash
F=/home/lq/lq-studio-stg/.env
if [ "$(grep -c '^LQ_TTS_INTERNAL_TOKEN=' "$F")" = 0 ]; then
  [ -n "$(tail -c1 "$F")" ] && echo >> "$F"
  printf 'LQ_TTS_INTERNAL_TOKEN=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" >> "$F"
fi
grep -c '^LQ_TTS_INTERNAL_TOKEN=' "$F"
awk -F= '/^LQ_TTS_INTERNAL_TOKEN=/{print length($2)}' "$F"
```

Expected: `1` and then `64`. Only the count and the length are printed, never the value.

- [ ] **Step 3: Merge into staging and rebuild (CLAUDE.md §5 step 1)**

```bash
cd /home/lq/lq-studio-stg
curl -s localhost:3012/ | grep -o 'assets/index-[^"]*\.js'   # note as STG_BUNDLE_OLD
git checkout staging && git pull --ff-only origin staging
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com merge --no-ff --no-edit feat-lq-tts-internal
node scripts/aset-r2.mjs tarik
docker compose -f docker-compose.lqserver.yml build staging
until docker exec -w /app lq-studio-stg-lqs node scripts/cek-job-aktif.mjs; do echo "job aktif — tunggu 60 dtk"; sleep 60; done
docker compose -f docker-compose.lqserver.yml up -d staging
```

Expected:
- the merge succeeds without conflicts (if there is a conflict, `git merge --abort` and STOP)
- the build exits 0
- `cek-job-aktif` eventually exits 0
- `up -d` recreates `lq-studio-stg-lqs`

- [ ] **Step 4: Verify staging (CLAUDE.md §6) plus the door inside the host**

```bash
for p in / /api/pricing /api/health; do curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:3012$p; done
docker inspect -f '{{.State.Health.Status}} restarts={{.RestartCount}}' lq-studio-stg-lqs
curl -s localhost:3012/ | grep -o 'assets/index-[^"]*\.js'
node scripts/cek-log-deploy.mjs --kontainer lq-studio-stg-lqs --sejak 10m; echo "exit=$?"
docker exec lq-studio-stg-lqs node -e "console.log((process.env.LQ_TTS_INTERNAL_TOKEN||'').length)"
curl -s -w ' %{http_code}\n' http://127.0.0.1:3012/api/internal/tts/users/__lqtts_health__
```

Expected:
- `/ 200`, `/api/pricing 200`, `/api/health 200`
- `healthy restarts=0`, or the same RestartCount as before
- a bundle name different from `STG_BUNDLE_OLD`
- `exit=0`
- `64`
- `{"ok":false,"error":"unauthorized"} 401`. A 401 (not 503) proves the route is mounted and the token is configured.

If any check fails, STOP. Staging is not PROD, so debug here. Do not continue to PROD.

- [ ] **Step 5: Install and start the staging relay**

```bash
cd /home/lq/lq-studio-stg
install -D -m 644 ops/host/jembatan-tts-internal.mjs ~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs
cp ops/host/lq-tts-jembatan-stg.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now lq-tts-jembatan-stg
systemctl --user is-active lq-tts-jembatan-stg
ss -ltn | grep -c '100.80.128.19:3112'
journalctl --user -u lq-tts-jembatan-stg -n 3 -o cat
```

Expected: `active`, then `1`, then the log line `[jembatan-tts] 100.80.128.19:3112 → 127.0.0.1:3012 (hanya /api/internal/tts/* + GET /api/health)`.

- [ ] **Step 6: Tailnet smoke FROM mac-studio. The token travels over ssh stdin and is never displayed.**

```bash
grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' /home/lq/lq-studio-stg/.env | cut -d= -f2- | ssh mac-studio 'read -r T; B=http://100.80.128.19:3112
curl -s -o /dev/null -w "health %{http_code}\n" "$B/api/health"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__" -H "Authorization: Bearer $T"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__" -H "Authorization: Bearer $T" -H "cf-ray: smoke-2a"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__" -H "Authorization: Bearer $T" -H "cf-connecting-ip: 203.0.113.9"
curl -s -w " %{http_code}\n" "$B/api/auth/check"
curl -s -w " %{http_code}\n" -X POST "$B/api/internal/tts/auth/verify" -H "Authorization: Bearer $T" -H "content-type: application/json" -d "{\"identifier\":\"smoke-2a-tidak-ada@example.invalid\",\"password\":\"x\",\"ip\":\"198.51.100.7\"}"
curl -s -w " %{http_code}\n" -X POST "$B/api/internal/tts/credits/hold" -H "Authorization: Bearer $T" -H "content-type: application/json" -d "{\"userId\":\"smoke-2a-tidak-ada\",\"amount\":1,\"ref\":\"tts:smoke-2a:r1\"}"'
```

Expected, line by line:

```
health 200
{"error":"not_found"} 404
{"ok":false,"error":"unauthorized"} 401
{"ok":false,"error":"internal_route_not_public"} 403
{"ok":false,"error":"internal_route_not_public"} 403
{"error":"not_found"} 404
{"error":"invalid_credentials"} 401
{"error":"not_found"} 404
```

What each line proves:
- line 2: reachable, authorized, routed
- lines 4–5: the guard rejects a Cloudflare-forwarded request
- line 6: the relay blocks every non-TTS path
- lines 7–8: the login and kernel paths are live, using non-existent subjects so no money moves

If a curl times out while `ss` shows the listener, a Tailscale ACL is blocking tcp/3112 from mac-studio. Report it to lqmnah; there is no workaround in this plan.

- [ ] **Step 7: Push staging and then main (CLAUDE.md §5)**

```bash
cd /home/lq/lq-studio-stg
git branch --show-current                      # staging
bash ~/brain/_brain/bin/brain-push.sh
[ "$(git ls-remote origin refs/heads/staging | cut -f1)" = "$(git rev-parse staging)" ] && echo staging-ok
git checkout -B main feat-lq-tts-internal
bash ~/brain/_brain/bin/brain-push.sh
[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$(git rev-parse main)" ] && echo main-ok
```

Expected: `staging-ok` and `main-ok`. `brain-push.sh` refuses any commit carrying Claude attribution; if it does, STOP and fix the commit author or message (never `--force`).

- [ ] **Step 8: Hand off to Plans 2B/2C**

Send Main this message: "LQ-Studio staging internal TTS API live at http://100.80.128.19:3112; token at `/home/lq/lq-studio-stg/.env` key `LQ_TTS_INTERNAL_TOKEN`; smoke 8/8 as expected." Do not include the value.

---

### Task 10: PROD deploy, verify, relay, smoke, cleanup

**Files:** none changed. Deploy only.

**Interfaces:**
- Consumes: `origin/main` containing Tasks 1–8, already verified on staging (Task 9).
- Produces:
  - LQ-Studio PROD serving `/api/internal/tts/*` on `http://100.80.128.19:3101`
  - `LQ_TTS_INTERNAL_TOKEN` stored in `/home/lq/lq-studio-prod/repo/.env` (mirrored in `/home/lq/lq-studio-prod/.env`)

Run every step strictly one after another (CLAUDE.md §5b). Never run two of them in parallel.

- [ ] **Step 1: Snapshot and rollback tag (mandatory)**

```bash
/home/lq/lq-studio-prod/repo/scripts/snapshot-pra-deploy.sh lq-tts-internal; echo "exit=$?"
docker tag lq-studio-prod:lqs lq-studio-prod:pra-lq-tts-internal
```

Expected: `exit=0`, which means an encrypted dump was proven decryptable. If the exit code is not 0, DO NOT DEPLOY.

- [ ] **Step 2: Pull the source**

```bash
cd /home/lq/lq-studio-prod/repo
git status --porcelain --untracked-files=no
git rev-parse --short HEAD   # note as PROD_PRE_SHA (rollback target)
git pull --ff-only origin main
git merge-base --is-ancestor "$(git -C /home/lq/lq-studio-stg rev-parse feat-lq-tts-internal)" HEAD && echo "berisi-kerja-2A"
```

Expected:
- the status check prints nothing. If tracked files are dirty, STOP and snapshot them to a `host-snapshot/prod-<ts>` branch per CLAUDE.md §8.
- the pull fast-forwards
- `berisi-kerja-2A`

- [ ] **Step 3: Client build in the PROD dir (mandatory: `Dockerfile.vps` only copies `client/dist`)**

```bash
cd /home/lq/lq-studio-prod/repo
node scripts/aset-r2.mjs tarik
(cd client && npm ci && npm run build)
grep -o 'assets/index-[^"]*\.js' client/dist/index.html   # note as PROD_BUNDLE_BUILT
```

Expected: both commands exit 0, and a bundle name is printed.

- [ ] **Step 4: Create the PROD token (a different value from staging), without printing it**

```bash
R=/home/lq/lq-studio-prod/repo/.env; A=/home/lq/lq-studio-prod/.env
V=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
for F in "$R" "$A"; do
  if [ "$(grep -c '^LQ_TTS_INTERNAL_TOKEN=' "$F")" = 0 ]; then
    [ -n "$(tail -c1 "$F")" ] && echo >> "$F"
    printf 'LQ_TTS_INTERNAL_TOKEN=%s\n' "$V" >> "$F"
  fi
done
unset V
for F in "$R" "$A"; do grep -c '^LQ_TTS_INTERNAL_TOKEN=' "$F"; awk -F= '/^LQ_TTS_INTERNAL_TOKEN=/{print length($2)}' "$F"; done
[ "$(grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' "$R" | cut -d= -f2- | sha256sum)" != "$(grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' /home/lq/lq-studio-stg/.env | cut -d= -f2- | sha256sum)" ] && echo beda-dari-staging
```

Expected: `1` / `64` / `1` / `64`, then `beda-dari-staging`.

- [ ] **Step 5: Build, wait for idle, recreate**

```bash
cd /home/lq/lq-studio-prod/repo
docker compose --env-file ../.env -f docker-compose.lqserver-prod.yml build app
docker exec -w /app lq-studio-prod-app node scripts/cek-job-aktif.mjs; echo "exit=$?"
```

Handle the `cek-job-aktif` exit code:
- `exit=1` means jobs are active. Rerun every 60 s until it reports 0: `until docker exec -w /app lq-studio-prod-app node scripts/cek-job-aktif.mjs; do sleep 60; done`.
- `exit=2` means the DB is unreadable. STOP.

Once it reports 0:

```bash
docker compose --env-file ../.env -f docker-compose.lqserver-prod.yml up -d app
```

Expected: the build exits 0 and `up -d` recreates `lq-studio-prod-app`.

- [ ] **Step 6: Verify PROD (CLAUDE.md §5 tail + §6)**

```bash
docker exec lq-studio-prod-app ls -la /app/client/dist/index.html
curl -s localhost:3001/ | grep -o 'assets/index-[^"]*\.js'
for p in / /api/pricing /api/health; do curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:3001$p; done
curl -s -o /dev/null -w 'https %{http_code}\n' https://lq-studio.com/
docker inspect -f '{{.State.Health.Status}} restarts={{.RestartCount}}' lq-studio-prod-app
cd /home/lq/lq-studio-prod/repo && node scripts/cek-log-deploy.mjs --kontainer lq-studio-prod-app --sejak 10m; echo "exit=$?"
docker logs lq-studio-prod-app 2>&1 | grep -m1 '\[render-lambda\] anggaran'
docker exec lq-studio-prod-app node -e "console.log((process.env.LQ_TTS_INTERNAL_TOKEN||'').length)"
curl -s -w ' %{http_code}\n' http://127.0.0.1:3001/api/internal/tts/users/__lqtts_health__
curl -s -w ' %{http_code}\n' https://lq-studio.com/api/internal/tts/users/__lqtts_health__
```

Expected:
- the served bundle equals `PROD_BUNDLE_BUILT`
- `/ 200`, `/api/pricing 200`, `/api/health 200`, `https 200`
- `healthy`, with RestartCount not rising
- `exit=0`
- `anggaran 850 · slot penjadwal 22`
- `64`
- `{"ok":false,"error":"unauthorized"} 401` on the loopback port
- status `403` through the public domain: either our `{"ok":false,"error":"internal_route_not_public"}` (the guard refuses Cloudflare-forwarded requests) or a Cloudflare block page, if an edge rule for `/api/internal/*` exists. Both prove the internet path is refused. Any `2xx`, `401` or `404` here is a FAIL.

If ANY check fails, roll back immediately (see "Rollback" below). Do not debug on live PROD.

- [ ] **Step 7: Start the PROD relay**

```bash
cmp /home/lq/lq-studio-prod/repo/ops/host/jembatan-tts-internal.mjs ~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs && echo sama
cp /home/lq/lq-studio-prod/repo/ops/host/lq-tts-jembatan-prod.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now lq-tts-jembatan-prod
systemctl --user is-active lq-tts-jembatan-prod
ss -ltn | grep -c '100.80.128.19:3101'
```

Expected: `sama`, `active`, `1`. If `cmp` reports a difference, run `install -D -m 644 /home/lq/lq-studio-prod/repo/ops/host/jembatan-tts-internal.mjs ~/.local/lib/lq-tts-jembatan/jembatan-tts-internal.mjs && systemctl --user restart lq-tts-jembatan-stg` first.

- [ ] **Step 8: Tailnet smoke from mac-studio against PROD**

```bash
grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' /home/lq/lq-studio-prod/repo/.env | cut -d= -f2- | ssh mac-studio 'read -r T; B=http://100.80.128.19:3101
curl -s -o /dev/null -w "health %{http_code}\n" "$B/api/health"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__" -H "Authorization: Bearer $T"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__"
curl -s -w " %{http_code}\n" "$B/api/internal/tts/users/__lqtts_health__" -H "Authorization: Bearer $T" -H "cf-ray: smoke-2a"
curl -s -w " %{http_code}\n" "$B/api/auth/check"
curl -s -w " %{http_code}\n" -X POST "$B/api/internal/tts/credits/hold" -H "Authorization: Bearer $T" -H "content-type: application/json" -d "{\"userId\":\"smoke-2a-tidak-ada\",\"amount\":1,\"ref\":\"tts:smoke-2a:r1\"}"'
```

Expected (the last line is `credits/hold` for a non-existent user — 404, no money moves):

```
health 200
{"error":"not_found"} 404
{"ok":false,"error":"unauthorized"} 401
{"ok":false,"error":"internal_route_not_public"} 403
{"error":"not_found"} 404
{"error":"not_found"} 404
```

- [ ] **Step 9: Clean up and close the task**

```bash
cd /home/lq/lq-studio-stg && git branch --show-current     # main (from Task 9 Step 7), not the feature branch
git branch -D feat-lq-tts-internal
python3 ~/brain/_brain/bin/brain-task.py done "$TASK_ID" --sha "$(git -C /home/lq/lq-studio-prod/repo rev-parse --short HEAD)" --bukti "PROD+staging /api/internal/tts live; tailnet smoke 3101/3112 OK; guard 403 on cf-ray; bundle hash = build"
```

Expected: the branch is deleted and the task is marked done.

Send Main this message: "LQ-Studio PROD internal TTS API live at http://100.80.128.19:3101; token at `/home/lq/lq-studio-prod/repo/.env` key `LQ_TTS_INTERNAL_TOKEN`." Do not include the value.

#### Rollback (CLAUDE.md §7), used if any check in Step 6 or Step 8 fails

```bash
docker tag lq-studio-prod:pra-lq-tts-internal lq-studio-prod:lqs
cd /home/lq/lq-studio-prod/repo && docker compose --env-file ../.env -f docker-compose.lqserver-prod.yml up -d app
systemctl --user disable --now lq-tts-jembatan-prod
cd /home/lq/lq-studio-prod/repo && git reset --hard "$PROD_PRE_SHA"   # recorded in Step 2; aligns the source with the restored image
```

The ledger is untouched by a rollback; no TTS rows exist until LQ-TTS starts calling. If the DB is damaged, run `pg_restore` with the `backups/pre-lq-tts-internal-*.dump.age` snapshot from Step 1.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Covered by |
|---|---|
| §5 router file and mount | Tasks 5–7 |
| §5 guard `makeInternalSocialAuth` + own env + 600/60 | Tasks 1 and 5 (#G1–#G4) |
| §5 "only existing functions" (`getUserByIdentifier`, `verifyPasswordAsync`, pb*, `totpStep`/`decryptSecret`/`consumeBackupCode`, `writeUser`, `bustAuthCache`, `effectiveTierId`, kernel, `queryLedgerByJobPrefix`) | Task 3 extracts the auth logic instead of copying it; Task 4 uses the kernel only |
| §5 `ip` in the body drives backoff | #V2 |
| §5 reasons + refId + refType + Usage labels | Tasks 4 and 7 |
| §5 endpoint table | Tasks 5–6 (#V*, #F*, #U1, #C*) |
| §5 `user` shape, plan/paid | #V5, #U1 |
| §5 idempotency (hold reads first; settle/refund under lock, net only) | #KT2, #KT3, #KT8–#KT13 |
| §5 non-session challenge | #V6, #AK11 |
| Amendment A3 `needs_verification` | #V4 |
| Amendment A5 staff net-zero | #KT7, #U1 |
| §2 cross-host link (Tailscale only, guard rejects CF, ≥32-char secret) | Tasks 8–10 (relay), #G2/#G3, the smokes |
| §9 LQ-Studio tests (idempotent hold, exactly-once, cross-user, guard) | Tasks 4–6; repo guard tests in Task 7 Step 9 and Task 9 Step 1 |
| §9 release order (staging, then PROD with snapshot + tag) | Tasks 9–10 |
| Task brief: Cloudflare header 403 over Tailscale | Task 9 Step 6 / Task 10 Step 8 |

The brief's compose port binding is deliberately replaced by the relay; see Contract note 1.

**2. Placeholder scan:** There is no TBD or TODO. Every code step has full code.

Values that depend on drift are spelled out as explicit commands: `wc -l` and the validated-route count, each with the expected number.

The only runtime-noted values are `BASE_PASS`, `TASK_ID`, `STG_BUNDLE_OLD` and `PROD_BUNDLE_BUILT`. Each is produced by a command in the same plan.

**3. Type consistency**

| Name | Defined | Used |
|---|---|---|
| `buatVerifikasiMasuk` → `{periksaSandi, buatChallenge, periksa2fa}` with the `hasil` values above | Task 3 | Task 3 (`auth.routes.js`) and Task 5 (`internal-tts.routes.js`) |
| `buatKreditTts` → `{tahan, selesaikan, kembalikan}` with `hasil` ∈ `ok`/`saldo_kurang`/`tidak_ada`/`bentrok`/`melebihi`/`gagal` | Task 4 | mapped in Task 6 |
| `makeInternalSocialAuth` options `rateKey`/`envName` | Task 1 | Task 5 |
| `createInternalTtsRouter` dep names (credit deps added in Task 6) | Task 5 | Task 7 mount, and the test harness (which passes the credit deps from the start) |
| `ledgerFeatureLabel` | Task 7 (`server/config/ledger-labels.js`) | Task 7 (imported in `index.js`; passed into `createUsageRouter` unchanged at :1362) |

## Execution

The plan is complete. The recommended way to run it is **subagent-driven**, using superpowers:subagent-driven-development, with one fresh subagent per task and a review between tasks. Tasks 9–10 must run on lq-server in one shell session, strictly in order.

The alternative is inline execution with superpowers:executing-plans.
