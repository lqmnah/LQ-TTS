# LQ-TTS Public API (sub-project 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro, Ultra and Sultan accounts (staff count as paid) create API keys on the LQ-TTS web app and make voiceovers from their own code through `https://tts.lq-studio.com/v1/*`: list voices, estimate, create (idempotent, signed webhook or polling), read status, download MP3/WAV/SRT/VTT, cancel or delete. Billed once per job on the shared LQ-Studio credits at the web price, never starving web users.

**Architecture:** A new `/v1` router inside the existing Express server (`web/server`), mounted before the cookie/CSRF stack. It authenticates `Authorization: Bearer lqtts_<key_id>_<secret>` against a new `api_keys` table (sha256 of the secret, constant-time compare; per-key webhook secret sealed with AES-256-GCM under a new `API_ENC_KEY`), checks the account through an in-memory 5-minute LQ-Studio cache (tokenVersion, suspension, plan; auto-revoke), rate-limits 60/min per account, and reuses the web create, charge, cancel and delete code (extracted into `services/voiceovers.js` and `services/job-control.js`). Jobs and charges get `source='api'`; the engine gets an optional, per-caller-clamped `priority` (web 5, API 1, regenerate 10) with a 10-minute starvation guard. Webhooks go through an outbox table with SSRF checks at create and at send time (DNS resolved, connection pinned to the checked IP, no redirects), HMAC signing and 0 s / 1 min / 5 min / 30 min attempts. The client gets an "API" page (keys, one-time secret panel, deliveries), a public docs page `/developers` and an "API" chip in History.

**Tech Stack:** Python 3.12, FastAPI, psycopg 3, pytest via uv (engine); Node 26 ESM, Express 5, pg 8, undici 8 (`Agent`, `request`), Vitest 5 + supertest (server); React 19.3, react-router 7.18, Tailwind 4.3, Testing Library + user-event 14 (client); Playwright 1.63 (e2e); pm2 (engine) and Docker compose (web) on mac-studio.

**Spec:** `docs/superpowers/specs/2026-10-04-public-api-design.md` (commit 521bf26 on `feat/public-api`). Read it before Task 1; this plan argues from it. Where the spec left a choice open, the decision is recorded under "Decisions" below and every task follows it.

## Global Constraints

- Every command runs on **mac-studio**. Non-interactive ssh needs `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH"` first (uv, node, npx, docker, pm2, psql live there).
- Work happens only in the worktree **`~/Developer/LQ-TTS-api`** on branch `feat/public-api` (from `main` c17bbd7). Never edit, switch, reset or run tools that write inside **`~/Developer/LQ-TTS`**: pm2 runs the live engine from that checkout. Only the Release section touches it, run by the controller.
- The worktree's `engine/.env`, `web/.env` and `web/.env.stg` are symlinks to the main checkout's files (gitignored, already in place). Never `cat`/`echo`/print them, `~/.config/lq-tts/*`, a token, an API key, a webhook secret or `API_ENC_KEY`. Errors and logs added by this plan name keys and settings, never values.
- Engine tests: `cd ~/Developer/LQ-TTS-api/engine && uv run pytest -q <paths>` (default `-m 'not slow'` from `pyproject.toml`; `uv run` creates the worktree's own gitignored `.venv` without the ML extra, which these tests do not need).
- Web server tests: `cd ~/Developer/LQ-TTS-api/web && npx vitest run <paths>` (reads `TEST_DATABASE_URL` from `web/.env`). Client tests: `cd ~/Developer/LQ-TTS-api/web/client && npx vitest run <paths>`.
- Engine change must stay backward compatible with the web image deployed today: the new `priority` field is optional; omitted, a job gets priority 5 (the web level), so the current PROD web image and the `lq-studio` caller keep working unchanged. The engine is released first (Release A), before any web image that sends `priority` exists.
- Commits: stage explicit paths only (never `git add -A` or `.`), then `git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "..."`. No `Co-Authored-By`, no Claude/Anthropic/AI wording anywhere (SOP G8).
- Web error shape stays `{ error: { code, message } }`; an `ApiError` may add detail fields next to `code` and `message` (only `insufficient_credits` does: `balance`, and on `/v1` also `topupUrl`). New web codes: `invalid_webhook_url` 400, `plan_required` 403, `key_limit_reached` 403, `idempotency_conflict` 409, `too_many_jobs` 429. Engine error shape unchanged.
- UI copy: Indonesian and English, identical key sets in `web/client/src/i18n/id.js` and `en.js`, zero em dashes (`—`), no emoji; `i18n.test.js` enforces it. Use "·" or a comma where a dash would go.
- Operate mode with the existing tokens and primitives only (`bg-bg`, `bg-surface`, `bg-surface-2`, `border-line`, `text-ink`, `text-muted`, `text-dim`, `text-accent`, `bg-accent-soft`, `bg-danger-soft`, `rounded-panel`, `rounded-control`, `buttonClass`, `Button`, `Field`, `inputClass`, `Notice`, `EmptyState`, `StatusChip`, `PageHeader`, `Segmented`, `Skeleton`); no new colors, fonts, shadows or radii.
- SOP G4 skills load together before any UI edit (Tasks 10 and 11): `~/.claude/skills/ui-pro-max/SKILL.md`, `~/.claude/skills/impeccable/SKILL.md` (Operate mode; run `node ~/.claude/skills/impeccable/scripts/context.mjs --target web/client/src` once per session from `~/Developer/LQ-TTS-api`; read `~/.claude/skills/impeccable/reference/operate.md`; read `~/.claude/skills/impeccable/reference/craft-floor.md` **right before** the first UI file edit of each session), `~/.claude/skills/design-taste-frontend/SKILL.md`, `~/.claude/skills/gpt-taste/SKILL.md`. A missing skill is reported, not skipped.
- SOP G5 proof is Playwright on mac-studio (Task 12): real clicks, `exact: true` text, clean console and network (the `guard` fixture), screenshots under `web/e2e/artifacts/`. Screenshots of the one-time key panel mask the key and the secret.
- Tasks never restart pm2 apps or containers, never touch staging or PROD, and never change `~/.config/lq-tts/*`; only the Release section does, run by the controller.
- The Pandji VO Profile stays `api_allowed = false` on staging and PROD (his consent covers tts.lq-studio.com only). Only the throwaway local e2e schema flips it, to exercise the CLI flag.

## Decisions (spec ambiguities resolved)

1. **Browser addresses.** `/api/*` is the JSON API namespace, so the SPA cannot live there. The API page is the in-app route `/api-keys`, the public docs page is `/developers`. `GET /api` answers `302 → /api-keys` and `GET /api/docs` answers `302 → /developers`, so the spec's URLs (`tts.lq-studio.com/api`, `/api/docs`) still work.
2. **Account changes.** Suspension, a plan below Pro, and a higher tokenVersion revoke every affected key of the account (audit line `api_key_auto_revoked` with `reason` `suspended` / `plan` / `tv`); the request that notices answers 403 `suspended`, 403 `plan_required` or 401 `unauthorized`, later requests with those keys 401. Unverified answers 403 `needs_verification` without revoking. LQ-Studio 404 for the user revokes (`account_gone`) and answers 401.
3. **Account cache for keys.** In memory per web process (one process per environment), keyed by user id, same `ME_CACHE_MS` (5 min) and outage rule (`OUTAGE_RETRY_MS`, 1 min: serve the cached copy, ask again after a minute) as web sessions. No cached copy and LQ-Studio down → 503 `lqstudio_unavailable`.
4. **Rate limit.** In memory, fixed one-minute window per account (all its keys), counted after the key is validated and before the account check (protects LQ-Studio). 61st request → 429 `rate_limited` + `Retry-After` (seconds to the window end).
5. **`last_used_at`** is written only when the stored value is older than a minute (checked in memory and again in SQL).
6. **File names.** Public names `final.mp3`, `final.wav`, `subtitles.srt`, `subtitles.vtt` map to the engine's `final.mp3`, `final.wav`, `subs.srt`, `subs.vtt`. `/v1` always serves the newest revision. `files` is `{mp3, wav, srt, vtt}` with only the files that exist, and is left out while there are none.
7. **`GET /v1/voices`** answers `{ voices: [...] }`; a profile's `description` is `{ id, en }`; own voices have no `description`. Only `ready` voices are listed.
8. **Voice checks.** Another account's voice, an inactive profile or a profile without `api_allowed` → 404 `not_found`. The caller's own voice that is still processing → 409 `voice_not_ready` (same as `POST /api/jobs`, "validated exactly as for POST /api/jobs").
9. **`formats`** is shorthand for `settings.formats`; when both are given the top-level `formats` wins. The engine validates both, as for the web.
10. **Idempotency** lives in the web DB (`api_idempotency`, per account, 24 h). A replay answers 202 with the job's current `{jobId, credits, status}` and header `Idempotent-Replayed: true`, without checking that the body matches. The same key while the first request is still in flight → 409 `idempotency_conflict`. A create that fails frees its key; a claim with no job left behind for 2 minutes (crash) can be taken over.
11. **2-job cap** counts the account's API jobs in `queued|running` plus API holds without a job younger than 2 minutes (creates in flight); check and charge insert are serialized per account by a transaction-scoped advisory lock.
12. **Engine priority.** Omitted → 5. Every caller may ask within 1-5 unless `LQTTS_PRIORITY_RANGES` (optional, `caller:low-high`, 0-9) narrows or widens it; out-of-range values are clamped, not refused. Regenerate stays 10, outside every caller range. Starvation guard: at claim time a queued job with priority below 5 whose `created_at` is more than 600 s ago ranks as 5 (ties then go FIFO, so the old API job runs before newer web jobs). `queue_position` and `chars_ahead` rank the same way.
13. **Webhook events** fire only for revision 1 (the render the API created), only for `done` and `failed`, at most once per job (unique `job_id`). They are recorded by the engine callback and, when a callback was lost, by the reconciler. The body is frozen at that moment (credits after settle/refund). A revoked key's pending deliveries are dropped (`key_revoked`). Next attempt = `created_at` + 60 / 300 / 1800 s, but never sooner than 30 s after the previous attempt (no back-to-back burst after downtime). An extra `LQTTS-Delivery: <id>` header identifies the delivery.
14. **`WEBHOOK_ALLOW_LOOPBACK=true`** is refused at startup unless `COOKIE_SECURE=false` (only local runs have that). With it, a URL whose every address is loopback may use http and any port; everything else still needs https, port 443 and public addresses.
15. **402 details.** `insufficient_credits` carries `balance` (from LQ-Studio's 402 body) everywhere, and `topupUrl` on `/v1`.
16. **Webhook secret** format `whsec_<52 base32>`; the HMAC key is that whole string (UTF-8).
17. **`API_ENC_KEY`** is required at startup: 32 bytes in base64 (`openssl rand -base64 32`, 44 characters). Each container env file gets its own value before the new image starts (Release B).
18. **`DELETE /v1/tts/{id}`** on a queued or running job cancels it (job stays, status `canceled`, refund rules of the web cancel); on any other state it deletes. Both answer 204.
19. **Reading any own job.** `/v1/tts/{id}` serves every job of the key's account, web-made ones included; another account's job is 404.
20. **Staging gate account.** The staging-only LQ-Studio account `tts-e2e` is re-seeded as plan `pro` (seed script change in Task 12) so the gate can create a real key through the UI.

---

## File Structure

| Path | Status | Responsibility / change |
|---|---|---|
| `engine/lq_tts_engine/config.py` | modify | `DEFAULT_PRIORITY`, `DEFAULT_PRIORITY_RANGE`, `LQTTS_PRIORITY_RANGES` → `Config.priority_ranges`, `priority_for()` |
| `engine/lq_tts_engine/repo.py` | modify | `create_job(..., priority)`, `_rank()` starvation-aware ordering in `claim_job`, `queue_position`, `chars_ahead` |
| `engine/lq_tts_engine/api/app.py` | modify | `JobIn.priority`, clamp via `priority_for` |
| `engine/tests/test_config_settings.py`, `test_repo_queue.py`, `test_api_jobs.py` | modify | priority tests |
| `web/server/db/migrations/007_public_api.sql` | create | `api_keys`, `api_idempotency`, `webhook_deliveries`; `jobs.source/api_key_id/webhook_url`, `charges.source`, `voice_profiles.api_allowed` |
| `web/server/lib/crypto-box.js` | create | `parseEncKey`, `seal`, `open`, `base32` |
| `web/server/config.js` | modify | `apiEncKey` (required), `webhookAllowLoopback` |
| `web/server/lib/errors.js` | modify | new codes, `ApiError` `details` |
| `web/server/lib/upstream-errors.js` | modify | 402 keeps `balance` |
| `web/server/services/api-keys.js` | create | key format, create (Pro gate is in the route) / list / revoke / autoRevoke / find / touch / webhookSecret |
| `web/server/routes/api-keys.js` | create | `GET/POST /api/keys`, `DELETE /api/keys/:id` (browser, session + CSRF) |
| `web/server/services/voiceovers.js` | create | `PRIORITY`, `readText`, `readJobInput`, `queueVoiceover` (shared web/API create) |
| `web/server/services/job-control.js` | create | `busy`, `withLease`, `engineView`, `cancel`, `remove` (moved from `routes/job-actions.js`) |
| `web/server/routes/jobs.js`, `routes/job-actions.js` | modify | use the shared services; web jobs send priority 5 |
| `web/server/services/jobs-repo.js`, `services/charges.js`, `clients/engine.js` | modify | `source`, `api_key_id`, `webhook_url`; `insertHeld(..., client)`; `createJob({priority})` |
| `web/server/services/api-accounts.js` | create | 5-min LQ-Studio cache for API callers |
| `web/server/services/rate-limit.js` | create | per-account fixed-window limiter |
| `web/server/http/api-auth.js` | create | `requireApiKey` (Bearer, account rules, auto-revoke, rate limit, touch) |
| `web/server/routes/v1.js` | create | `/v1/voices`, `/v1/estimate`, `/v1/tts` (+ `/:id`, `/:id/files/:name`, DELETE) |
| `web/server/services/api-jobs.js` | create | 2-job cap reservation, idempotency claims, `apiFiles`, `toApiJob`, `API_FILES` |
| `web/server/services/ownership.js`, `services/profiles.js` | modify | `usableVoice(..., {api})`; `setApiAllowed` |
| `web/server/services/webhook-security.js` | create | `isPublicAddress`, `resolveWebhookUrl`, `WebhookUrlError`, `signWebhook` |
| `web/server/services/webhooks.js` | create | outbox: `onTerminal`, worker (`runOnce`, `kick`, `start`, `stop`), sender, `listForUser` |
| `web/server/routes/callback.js`, `services/reconcile.js`, `index.js` | modify | record webhooks; start/stop the worker |
| `web/server/context.js`, `web/server/app.js` | modify | wire services; mount `/v1`, `/api/keys`, redirects |
| `web/server/cli/profile-add.js` | modify | `--api-allowed true|false --slug <slug>`; `--list` shows `api`; redact `API_ENC_KEY` |
| `web/server/test/helpers.js`, `fakes/fake-engine.js` | modify | `API_ENC_KEY`, user `cici`, `h.apiKey()`, `h.api()`; fake stores `priority` |
| `web/server/test/*.test.js` | create/modify | see each task |
| `web/.env.example` | modify | `API_ENC_KEY`, `WEBHOOK_ALLOW_LOOPBACK` |
| `web/client/src/lib/api.js`, `lib/types.js` | modify | `apiKeys`, `createApiKey`, `revokeApiKey`; typedefs |
| `web/client/src/pages/ApiPage.jsx` (+ test) | create | API page |
| `web/client/src/lib/api-docs.js`, `pages/DevelopersPage.jsx` (+ test) | create | public docs page |
| `web/client/src/router.jsx`, `components/AppShell.jsx` (+ test), `pages/HistoryPage.jsx` (+ test) | modify | routes, nav item, API chip |
| `web/client/src/i18n/id.js`, `en.js`, `i18n.test.js` | modify | new keys and families |
| `web/e2e/target.mjs`, `harness/run-server.mjs`, `playwright.config.js`, `tests/api.spec.js`, `tests/journey.spec.js`, `staging/seed-lqstudio-user.mjs` | create/modify | Pro e2e user, loopback webhooks, `api` project, staging account as Pro |

---

## Setup (controller, once, before Task 1)

- [ ] **Step 1: Install dependencies in the worktree and record baselines**

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH"
python3 ~/brain/_brain/bin/brain-task.py check "lq-tts public api"   # SOP: no duplicate or conflicting task open
cd ~/Developer/LQ-TTS-api
git status -sb                                   # expect: ## feat/public-api, nothing else
(cd web && npm ci --no-audit --no-fund)
(cd web/client && npm ci --no-audit --no-fund)
(cd web/e2e && npm ci --no-audit --no-fund)
(cd engine && uv run pytest -q | tail -n 1)      # record E0, e.g. "N passed, 1 deselected"
(cd web && npx vitest run 2>&1 | tail -n 5)      # record W0 test files / tests
(cd web/client && npx vitest run 2>&1 | tail -n 5)  # record C0
```
Expected: all three suites green. `node_modules` and `.venv` are gitignored, so `git status -sb` stays clean. Every task below states how many tests it adds; "suite green" means baseline + the tests added so far, 0 failed.

---
### Task 1: Engine priority field, per-caller clamp and starvation guard

**Files:**
- Modify: `engine/lq_tts_engine/config.py` (constants and helpers after `_pairs`, `Config` dataclass, `load_config`)
- Modify: `engine/lq_tts_engine/repo.py` (`create_job` :86-113, `claim_job` :138-146, `queue_position` :263-270, `chars_ahead` :272-280)
- Modify: `engine/lq_tts_engine/api/app.py` (`JobIn` :121-126, `create_job` :295-323, import :19)
- Test: `engine/tests/test_config_settings.py`, `engine/tests/test_repo_queue.py`, `engine/tests/test_api_jobs.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /v1/jobs` accepts optional `"priority": <int>`; stored value = `priority_for(cfg, caller, requested)`. `config.DEFAULT_PRIORITY = 5`, `config.DEFAULT_PRIORITY_RANGE = (1, 5)`, `config.MAX_CALLER_PRIORITY = 9`, `Config.priority_ranges: dict[str, tuple[int, int]]` (env `LQTTS_PRIORITY_RANGES="caller:low-high,..."`, optional), `config.priority_for(cfg, caller, requested: int | None) -> int`, `repo.STARVED_AFTER_S = 600`, `Repo.create_job(..., priority: int = DEFAULT_PRIORITY)`. The web server (Task 4) sends 5 for web jobs and 1 for API jobs.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_config_settings.py` and extend its import line to `from lq_tts_engine.config import load_config, priority_for`:
```python
def test_priority_ranges_are_per_caller_and_optional():
    assert load_config(BASE_ENV).priority_ranges == {}
    cfg = load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "lq-studio:3-3"})
    assert cfg.priority_ranges == {"lq-studio": (3, 3)}
    with pytest.raises(ValueError, match="LQTTS_PRIORITY_RANGES: unknown caller nobody"):
        load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "nobody:1-5"})
    for bad in ("5-1", "1", "a-5", "0-10", "-1-5"):
        with pytest.raises(ValueError, match="LQTTS_PRIORITY_RANGES: lq-tts: expected"):
            load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": f"lq-tts:{bad}"})


def test_priority_for_clamps_to_the_callers_range():
    cfg = load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "lq-studio:3-3"})
    assert [priority_for(cfg, "lq-tts", p) for p in (None, 0, 1, 5, 9, 10)] == [5, 1, 1, 5, 5, 5]
    assert [priority_for(cfg, "lq-studio", p) for p in (None, 1, 9)] == [3, 3, 3]
```

In `engine/tests/test_repo_queue.py`, give the helper a `priority` parameter (existing callers keep the default) and append two tests:
```python
def new_job(repo, voice, text=TEXT, priority=5):
    job, _ = repo.create_job(caller="lq-tts", voice_id=voice["id"], text=text, settings={}, callback_url=None,
                             idempotency_key=None, units=split_script(text), priority=priority)
    return job
```
```python
def test_web_jobs_are_claimed_before_older_api_jobs(repo, ready_voice):
    api = new_job(repo, ready_voice, priority=1)
    sql(repo, "UPDATE jobs SET created_at = now() - interval '5 minutes' WHERE id=%s", (api["id"],))
    web = new_job(repo, ready_voice)
    assert repo.queue_position(api["id"]) == 1 and repo.queue_position(web["id"]) == 0
    assert repo.chars_ahead(api["id"]) == web["chars"]
    assert [repo.claim_job()["id"], repo.claim_job()["id"]] == [web["id"], api["id"]]


def test_an_api_job_waiting_over_ten_minutes_ranks_as_a_web_job(repo, ready_voice):
    starved = new_job(repo, ready_voice, priority=1)
    sql(repo, "UPDATE jobs SET created_at = now() - interval '11 minutes' WHERE id=%s", (starved["id"],))
    web = new_job(repo, ready_voice)
    assert repo.queue_position(starved["id"]) == 0 and repo.queue_position(web["id"]) == 1
    assert repo.claim_job()["id"] == starved["id"]
```

Append to `engine/tests/test_api_jobs.py`:
```python
def stored_priority(repo, response):
    assert response.status_code == 202, response.text
    return repo.get_job_any(uuid.UUID(response.json()["id"]))["priority"]


def test_priority_is_optional_and_clamped_to_the_callers_range(client, cfg, repo, ready_voice):
    assert stored_priority(repo, post_job(client, ready_voice)) == 5
    assert stored_priority(repo, post_job(client, ready_voice, priority=1)) == 1
    assert stored_priority(repo, post_job(client, ready_voice, priority=0)) == 1
    assert stored_priority(repo, post_job(client, ready_voice, priority=9)) == 5
    narrow = TestClient(create_app(Config(**{**cfg.__dict__, "priority_ranges": {"lq-tts": (2, 2)}}), repo))
    assert stored_priority(repo, post_job(narrow, ready_voice, priority=5)) == 2
    r = post_job(client, ready_voice, priority="high")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-api/engine && uv run pytest -q tests/test_config_settings.py tests/test_repo_queue.py tests/test_api_jobs.py`
Expected: FAIL — `ImportError: cannot import name 'priority_for'` for the config file; `TypeError: ... unexpected keyword argument 'priority'` in the repo tests; `body.priority: Extra inputs are not permitted` (400) in the API test.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/config.py` — add after `_pairs` (the module already has `from __future__ import annotations`):
```python
DEFAULT_PRIORITY = 5  # the web level; a job created without "priority" gets it, so older callers keep their place
DEFAULT_PRIORITY_RANGE = (1, 5)  # what any caller may ask for unless LQTTS_PRIORITY_RANGES says otherwise
MAX_CALLER_PRIORITY = 9  # 10 is the regenerate lane (Repo.request_regenerate); no caller may create jobs there


def _priority_range(caller: str, raw: str) -> tuple[int, int]:
    low, sep, high = raw.partition("-")
    if not sep or not low.isdigit() or not high.isdigit() or not 0 <= int(low) <= int(high) <= MAX_CALLER_PRIORITY:
        raise ValueError(f"LQTTS_PRIORITY_RANGES: {caller}: expected 'low-high' with "
                         f"0 <= low <= high <= {MAX_CALLER_PRIORITY}")
    return int(low), int(high)


def priority_for(cfg: Config, caller: str, requested: int | None) -> int:
    """Queue priority of a new job: the caller's request (DEFAULT_PRIORITY when absent) clamped to its range."""
    low, high = cfg.priority_ranges.get(caller, DEFAULT_PRIORITY_RANGE)
    return min(max(DEFAULT_PRIORITY if requested is None else requested, low), high)
```
Add the field at the end of `Config`:
```python
    callback_hosts: dict[str, frozenset[str]] = field(default_factory=dict)
    priority_ranges: dict[str, tuple[int, int]] = field(default_factory=dict)
```
In `load_config`, after the `callback_hosts` loop:
```python
    priority_ranges: dict[str, tuple[int, int]] = {}
    for caller, raw in _pairs(env.get("LQTTS_PRIORITY_RANGES") or "", "LQTTS_PRIORITY_RANGES").items():
        if caller not in caller_tokens:
            raise ValueError(f"LQTTS_PRIORITY_RANGES: unknown caller {caller}")
        priority_ranges[caller] = _priority_range(caller, raw)
```
and pass `priority_ranges=priority_ranges,` as the last argument of the `Config(...)` call.

`engine/lq_tts_engine/repo.py` — add the import and helper below the existing imports:
```python
from .config import DEFAULT_PRIORITY
from .text.split import Unit

Row = dict[str, Any]
STARVED_AFTER_S = 600


def _rank(alias: str) -> str:
    """Queue rank of a queued job: its priority, lifted to DEFAULT_PRIORITY once a lower-priority (API) job has waited
    STARVED_AFTER_S, so API work behind a steady stream of web jobs still runs. Regenerates (10) stay ahead."""
    return (f"(CASE WHEN {alias}.priority < {DEFAULT_PRIORITY} "
            f"AND {alias}.created_at < now() - interval '{STARVED_AFTER_S} seconds' "
            f"THEN {DEFAULT_PRIORITY} ELSE {alias}.priority END)")
```
(`from .text.split import Unit` and `Row = ...` already exist; only the `config` import, the constant and `_rank` are new.)

Replace `create_job`'s signature and INSERT (the idempotency block in between stays as is):
```python
    def create_job(self, *, caller, voice_id, text, settings: dict, callback_url, idempotency_key,
                   units: Sequence[Unit], priority: int = DEFAULT_PRIORITY) -> tuple[Row, bool]:
```
```python
            job = conn.execute(
                "INSERT INTO jobs (id, voice_id, caller, text, settings, callback_url, idempotency_key, chars, priority) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
                (uuid.uuid4(), voice_id, caller, text, Jsonb(settings), callback_url, idempotency_key, len(text),
                 priority),
            ).fetchone()
```
Replace `claim_job`, `queue_position` and `chars_ahead`:
```python
    def claim_job(self, lease_s: int = 60) -> Row | None:
        return self._one(
            "UPDATE jobs SET status='running', lease_until = now() + %s * interval '1 second', "
            "started_at = coalesce(started_at, now()) "
            "WHERE id = (SELECT q.id FROM jobs q WHERE q.status='queued' "
            f"            ORDER BY {_rank('q')} DESC, q.created_at FOR UPDATE SKIP LOCKED LIMIT 1) "
            "RETURNING *",
            (lease_s,),
        )
```
```python
    def queue_position(self, job_id) -> int:
        row = self._one(
            "SELECT count(q.id) AS n FROM jobs j JOIN jobs q ON q.status='queued' AND q.deleted_at IS NULL "
            f"AND ({_rank('q')} > {_rank('j')} OR ({_rank('q')} = {_rank('j')} AND q.created_at < j.created_at)) "
            "WHERE j.id=%s AND j.status='queued'",
            (job_id,),
        )
        return int(row["n"]) if row else 0

    def chars_ahead(self, job_id) -> int:
        row = self._one(
            "SELECT coalesce(sum(q.chars), 0) AS n FROM jobs j JOIN jobs q ON q.deleted_at IS NULL AND q.id <> j.id "
            f"AND (q.status='running' OR (q.status='queued' AND ({_rank('q')} > {_rank('j')} "
            f"     OR ({_rank('q')} = {_rank('j')} AND q.created_at < j.created_at)))) "
            "WHERE j.id=%s",
            (job_id,),
        )
        return int(row["n"]) if row else 0
```

`engine/lq_tts_engine/api/app.py` — import line 19 becomes `from ..config import Config, load_config, priority_for`; `JobIn` gains the field:
```python
class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    voice_id: uuid.UUID
    text: str
    settings: dict[str, Any] = {}
    callback_url: str | None = None
    priority: int | None = None  # clamped per caller (config.priority_for); absent = the web level
```
and the `repo.create_job(...)` call at the end of `create_job` becomes:
```python
        job, _ = repo.create_job(caller=who, voice_id=body.voice_id, text=text, settings=settings.model_dump(),
                                 callback_url=body.callback_url, idempotency_key=key, units=units,
                                 priority=priority_for(cfg, who, body.priority))
```

- [ ] **Step 4: Run the tests to verify they pass, then the whole engine suite**

Run: `cd ~/Developer/LQ-TTS-api/engine && uv run pytest -q tests/test_config_settings.py tests/test_repo_queue.py tests/test_api_jobs.py && uv run pytest -q`
Expected: PASS; the full suite is E0 + 5 passed, 1 deselected, 0 failed (`test_finish_and_fail` still sees priority 0 after `finish_job`, `test_regenerate_rules` still sees 10).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add engine/lq_tts_engine/config.py engine/lq_tts_engine/repo.py engine/lq_tts_engine/api/app.py \
  engine/tests/test_config_settings.py engine/tests/test_repo_queue.py engine/tests/test_api_jobs.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: optional per-caller job priority with a 10-minute starvation guard"
```
Record this commit SHA: Release A fast-forwards `main` to it.

---
### Task 2: Migration 007, `API_ENC_KEY`, sealed secrets and error details

**Files:**
- Create: `web/server/db/migrations/007_public_api.sql`
- Create: `web/server/lib/crypto-box.js`
- Modify: `web/server/config.js`, `web/server/lib/errors.js`, `web/server/lib/upstream-errors.js`, `web/server/cli/profile-add.js` (secrets list :221), `web/.env.example`
- Modify (tests): `web/server/test/helpers.js`, `web/server/test/shutdown.test.js` (boot env), `web/server/test/config.test.js`, `web/server/test/db.test.js`, `web/server/test/errors.test.js`
- Create (test): `web/server/test/crypto-box.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Tables/columns (exact names): `api_keys(id uuid PK, user_id, name, key_id, secret_hash, webhook_secret_enc, tv, created_at, last_used_at, revoked_at, revoked_reason)`, `api_idempotency(user_id, idem_key, job_id, created_at)`, `webhook_deliveries(id bigserial, api_key_id, user_id, job_id UNIQUE, event, url, body, state, attempts, next_attempt_at, sending_until, last_status, last_error, created_at, finished_at)`, `jobs.source` (`'web'|'api'`, default `'web'`), `jobs.api_key_id`, `jobs.webhook_url`, `charges.source`, `voice_profiles.api_allowed` (default false).
  - `lib/crypto-box.js`: `parseEncKey(raw: string) -> Buffer(32)`, `seal(key: Buffer, plaintext: string, aad: string) -> string` (`v1.<iv>.<tag>.<data>`, base64url), `open(key, sealed, aad) -> string` (throws on any mismatch), `base32(buf: Buffer) -> string` (RFC 4648, lowercase, unpadded).
  - `config.apiEncKey: Buffer`, `config.webhookAllowLoopback: boolean`.
  - `new ApiError(code, message, { status, headers, details })`; the JSON error object is `{ ...details, code, message }`. `STATUS` adds `invalid_webhook_url: 400, plan_required: 403, key_limit_reached: 403, idempotency_conflict: 409, too_many_jobs: 429`.
  - `lqError(err)` for LQ-Studio's 402 returns `ApiError('insufficient_credits', ..., { details: { balance } })` when the body carries a numeric balance.
  - Test helpers: `API_ENC_KEY` export (base64 of 32 bytes of 7).

- [ ] **Step 1: Write the failing tests**

Create `web/server/test/crypto-box.test.js`:
```js
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32, open, parseEncKey, seal } from '../lib/crypto-box.js';

const KEY = crypto.randomBytes(32);

describe('crypto box', () => {
  it('opens what it sealed, only with the same key and the same row binding', () => {
    const sealed = seal(KEY, 'whsec_abc', 'api_key:1');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('whsec_abc');
    expect(open(KEY, sealed, 'api_key:1')).toBe('whsec_abc');
    expect(() => open(KEY, sealed, 'api_key:2')).toThrow();
    expect(() => open(crypto.randomBytes(32), sealed, 'api_key:1')).toThrow();
    expect(() => open(KEY, 'v2.a.b.c', 'api_key:1')).toThrow('unknown format');
    expect(seal(KEY, 'same', 'a')).not.toBe(seal(KEY, 'same', 'a'));
  });

  it('encodes base32 per RFC 4648, lowercase and unpadded', () => {
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32(Buffer.from('f'))).toBe('my');
    expect(base32(crypto.randomBytes(32))).toMatch(/^[a-z2-7]{52}$/);
  });

  it('parses a 32-byte base64 key', () => {
    expect(parseEncKey(KEY.toString('base64'))).toEqual(KEY);
  });
});
```

In `web/server/test/config.test.js` add `API_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),` as the last entry of `base` (the existing `rejects a missing %s` table then covers it), and append inside the `describe`:
```js
  it('requires API_ENC_KEY to be 32 bytes in base64 and never echoes it', () => {
    for (const bad of ['short', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), `${'A'.repeat(43)}!`]) {
      let message = '';
      try {
        loadConfig({ ...base, API_ENC_KEY: bad });
      } catch (err) {
        message = err.message;
      }
      expect(message).toMatch(/^API_ENC_KEY must be 32 bytes in base64/);
      expect(message).not.toContain(bad);
    }
    expect(loadConfig(base).apiEncKey).toEqual(Buffer.alloc(32, 1));
  });

  it('allows loopback webhooks only for local runs without Secure cookies', () => {
    expect(loadConfig(base).webhookAllowLoopback).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: 'false', WEBHOOK_ALLOW_LOOPBACK: 'true' }).webhookAllowLoopback).toBe(true);
    expect(() => loadConfig({ ...base, WEBHOOK_ALLOW_LOOPBACK: 'true' })).toThrow('WEBHOOK_ALLOW_LOOPBACK');
  });
```

In `web/server/test/db.test.js` extend the expected migration list with `'007_public_api.sql'` and append:
```js
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
```

Append to `web/server/test/errors.test.js` (it already imports `express`, `request`, `describe/expect/it` and `errorHandler`; add `ApiError` to the `../lib/errors.js` import and `lqError` from `../lib/upstream-errors.js`, `UpstreamError` from `../clients/http.js`):
```js
describe('error details', () => {
  it('adds an ApiError\'s details next to code and message, never replacing them', async () => {
    const detailed = express();
    detailed.get('/x', () => {
      throw new ApiError('insufficient_credits', 'not enough', { details: { balance: 3, code: 'other', message: 'other' } });
    });
    detailed.use(errorHandler({ error() {} }));
    const res = await request(detailed).get('/x');
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: { code: 'insufficient_credits', message: 'not enough', balance: 3 } });
  });

  it('keeps the balance LQ-Studio sent with a 402', () => {
    const err = lqError(new UpstreamError('lqstudio', 402, 'insufficient_credits', 'insufficient_credits', { error: 'insufficient_credits', balance: 5 }));
    expect(err).toMatchObject({ code: 'insufficient_credits', status: 402, details: { balance: 5 } });
    expect(lqError(new UpstreamError('lqstudio', 402, 'insufficient_credits', 'x', null)).details).toEqual({});
  });
});
```

In `web/server/test/helpers.js` export the key and pass it to the harness config:
```js
export const API_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
```
```js
    CLIENT_DIST: '/nonexistent-lq-tts-client-dist',
    API_ENC_KEY,
    ...env,
```
In `web/server/test/shutdown.test.js` import `API_ENC_KEY` from `./helpers.js` and add `API_ENC_KEY,` to the `boot()` env object (after `CLIENT_DIST`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/crypto-box.test.js server/test/config.test.js server/test/db.test.js server/test/errors.test.js`
Expected: FAIL — `Cannot find module '../lib/crypto-box.js'`; config `apiEncKey` undefined and no throw for loopback; db list lacks `007_public_api.sql`; errors body has no `balance`.

- [ ] **Step 3: Implement**

Create `web/server/db/migrations/007_public_api.sql`:
```sql
CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[a-z2-7]{12}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  webhook_secret_enc text NOT NULL,
  tv integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('user', 'tv', 'plan', 'suspended', 'account_gone'))
);
CREATE INDEX api_keys_user_active ON api_keys (user_id, created_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE jobs
  ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api')),
  ADD COLUMN api_key_id uuid REFERENCES api_keys (id),
  ADD COLUMN webhook_url text;
CREATE INDEX jobs_api_active ON jobs (user_id) WHERE source = 'api' AND deleted_at IS NULL AND status IN ('queued', 'running');

ALTER TABLE charges ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api'));

ALTER TABLE voice_profiles ADD COLUMN api_allowed boolean NOT NULL DEFAULT false;

CREATE TABLE api_idempotency (
  user_id text NOT NULL,
  idem_key text NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys (id),
  user_id text NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  event text NOT NULL CHECK (event IN ('job.done', 'job.failed')),
  url text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dropped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sending_until timestamptz,
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_key ON webhook_deliveries (api_key_id, created_at DESC);
```

Create `web/server/lib/crypto-box.js`:
```js
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** API_ENC_KEY: 32 random bytes in base64 (`openssl rand -base64 32`). The error names the setting, never the value. */
export function parseEncKey(raw) {
  const key = /^[A-Za-z0-9+/]{43}=$/.test(String(raw)) ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length !== 32) throw new Error('API_ENC_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  return key;
}

/** AES-256-GCM. `aad` binds the value to its row, so a sealed value copied to another row does not open. */
export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function open(key, sealed, aad) {
  const [version, iv, tag, data] = String(sealed).split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('sealed value has an unknown format');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** RFC 4648 base32, lowercase, without padding. */
export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
```

`web/server/config.js` — add `import { parseEncKey } from './lib/crypto-box.js';` at the top; inside `loadConfig`, before `return`:
```js
  const cookieSecure = env.COOKIE_SECURE !== 'false';
  const webhookAllowLoopback = env.WEBHOOK_ALLOW_LOOPBACK === 'true';
  // Loopback webhooks are for the local e2e receiver only; every deployed container runs with Secure cookies.
  if (webhookAllowLoopback && cookieSecure) {
    throw new Error('WEBHOOK_ALLOW_LOOPBACK=true is for local runs only and needs COOKIE_SECURE=false');
  }
```
In the returned object replace `cookieSecure: env.COOKIE_SECURE !== 'false',` with `cookieSecure,` and add after `reconcileIntervalMs`:
```js
    apiEncKey: parseEncKey(req('API_ENC_KEY')),
    webhookAllowLoopback,
```

`web/server/lib/errors.js` — extend `STATUS` (keep alphabetical-by-status order as today):
```js
export const STATUS = Object.freeze({
  invalid_request: 400,
  consent_required: 400,
  invalid_webhook_url: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  invalid_code: 401,
  insufficient_credits: 402,
  suspended: 403,
  needs_verification: 403,
  voice_limit_reached: 403,
  plan_required: 403,
  key_limit_reached: 403,
  not_found: 404,
  not_regeneratable: 409,
  voice_not_ready: 409,
  idempotency_conflict: 409,
  too_large: 413,
  unsupported_audio: 415,
  rate_limited: 429,
  too_many_jobs: 429,
  internal_error: 500,
  lqstudio_unavailable: 503,
  engine_unavailable: 503,
});

export class ApiError extends Error {
  constructor(code, message = code, { status, headers, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    this.headers = headers ?? {};
    this.details = details ?? {};
  }
}
```
and the last line of `errorHandler`:
```js
    res.set(apiErr.headers).status(apiErr.status).json({ error: { ...apiErr.details, code: apiErr.code, message: apiErr.message } });
```
(`ApiError`s built from body-parser errors have empty `details`.)

`web/server/lib/upstream-errors.js` — replace `if (LQ_MESSAGES[err.code]) return new ApiError(err.code, LQ_MESSAGES[err.code]);` with:
```js
    if (LQ_MESSAGES[err.code]) {
      // LQ-Studio's 402 carries the balance (contract C1); /v1 also adds topupUrl.
      const balance = err.code === 'insufficient_credits' && Number.isFinite(err.body?.balance) ? { balance: err.body.balance } : {};
      return new ApiError(err.code, LQ_MESSAGES[err.code], { details: balance });
    }
```

`web/server/cli/profile-add.js` line 221 — the redaction list also covers the new key:
```js
  const secrets = [config.engineToken, config.lqstudioToken, config.engineCallbackSecret, config.databaseUrl, config.apiEncKey.toString('base64')];
```

`web/.env.example` — append:
```
# 32 random bytes, base64: openssl rand -base64 32 | node ops/env-set.mjs <env-file> API_ENC_KEY (seals webhook secrets)
API_ENC_KEY=CHANGE_ME_32_BYTES_BASE64
# Local e2e only (needs COOKIE_SECURE=false): webhooks may go to http://127.0.0.1:<port>
# WEBHOOK_ALLOW_LOOPBACK=true
```

- [ ] **Step 4: Run the tests to verify they pass, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/crypto-box.test.js server/test/config.test.js server/test/db.test.js server/test/errors.test.js && npx vitest run`
Expected: PASS; full suite W0 + 1 file (crypto-box) and + 3 crypto + 2 config (+1 table row for the missing key) + 1 db + 2 errors tests, 0 failed. If an existing test pins the exact body of a web 402, update its expectation to include `balance` (intended change, Decision 15) and name it in the commit message.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/db/migrations/007_public_api.sql web/server/lib/crypto-box.js web/server/config.js \
  web/server/lib/errors.js web/server/lib/upstream-errors.js web/server/cli/profile-add.js web/.env.example \
  web/server/test/crypto-box.test.js web/server/test/config.test.js web/server/test/db.test.js \
  web/server/test/errors.test.js web/server/test/helpers.js web/server/test/shutdown.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: migration 007 for the public API, API_ENC_KEY sealing, error details"
```

---

### Task 3: API key store and browser key routes

**Files:**
- Create: `web/server/services/api-keys.js`, `web/server/routes/api-keys.js`
- Modify: `web/server/context.js`, `web/server/app.js`
- Test: `web/server/test/api-keys.test.js`

**Interfaces:**
- Consumes: Task 2 `seal`, `open`, `base32`, `config.apiEncKey`, table `api_keys`, codes `plan_required`, `key_limit_reached`.
- Produces:
  - `services/api-keys.js`: `KEY_PREFIX = 'lqtts_'`, `MAX_ACTIVE_KEYS = 5`, `hashSecret(secret) -> hex`, `parseApiKey(raw) -> {keyId, secret} | null`, `keyPrefix(keyId) -> 'lqtts_<keyId>_…'`, `toApiKey(row) -> {id, name, prefix, createdAt, lastUsedAt}`, `createApiKeys({pool, config, log})` returning `{ create(userId, {name, tv}) -> {row, key, webhookSecret}, list(userId) -> rows, revoke(userId, id) -> boolean, autoRevoke(userId, reason, {belowTv}?) -> count, find(rawKey) -> row|null, touch(row), webhookSecret(row) -> string }`.
  - `ctx.apiKeys`.
  - `GET /api/keys` → `{ keys: ApiKey[] }` (Task 8 adds `deliveries`); `POST /api/keys {name}` → 201 `{id, name, prefix, createdAt, lastUsedAt, key, webhookSecret}`; `DELETE /api/keys/:id` → 204 or 404.
  - Audit log events: `api_key_created`, `api_key_revoked` (info), `api_key_auto_revoked` (warn, with `reason`); fields `userId`, `keyId` (the public key id), never a secret.

- [ ] **Step 1: Write the failing test**

Create `web/server/test/api-keys.test.js`:
```js
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
    expect(list.body).toEqual({ keys: [{ id: res.body.id, name: 'Zapier', prefix: res.body.prefix, createdAt: res.body.createdAt, lastUsedAt: null }] });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/api-keys.test.js`
Expected: FAIL — `Cannot find module '../services/api-keys.js'`.

- [ ] **Step 3: Implement**

Create `web/server/services/api-keys.js`:
```js
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
```

Create `web/server/routes/api-keys.js`:
```js
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { toApiKey } from '../services/api-keys.js';
import { isUuid } from '../services/ownership.js';

const MAX_NAME = 60; // code points, as the api_keys CHECK counts them

export function apiKeysRouter(ctx) {
  const { accounts, apiKeys } = ctx;
  const router = express.Router();

  router.get('/keys', async (req, res) => {
    const keys = await apiKeys.list(req.session.user_id);
    res.set('Cache-Control', 'no-store').json({ keys: keys.map(toApiKey) });
  });

  router.post('/keys', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || [...name].length > MAX_NAME) throw new ApiError('invalid_request', `name is required (at most ${MAX_NAME} characters)`);
    const session = await accounts.fresh(req.session);
    if (!session.paid) throw new ApiError('plan_required', 'API keys need a Pro, Ultra or Sultan plan');
    const { row, key, webhookSecret } = await apiKeys.create(session.user_id, { name, tv: session.user_tv });
    res.status(201).set('Cache-Control', 'no-store').json({ ...toApiKey(row), key, webhookSecret });
  });

  router.delete('/keys/:id', async (req, res) => {
    if (!isUuid(req.params.id) || !(await apiKeys.revoke(req.session.user_id, req.params.id.toLowerCase()))) {
      throw new ApiError('not_found', 'API key not found');
    }
    res.status(204).end();
  });

  return router;
}
```

`web/server/context.js` — import `createApiKeys` from `./services/api-keys.js` and add `ctx.apiKeys = createApiKeys(ctx);` right after `const ctx = { ... };`.

`web/server/app.js` — import `apiKeysRouter` from `./routes/api-keys.js` and mount it behind the session check, after `creditsRouter`:
```js
  app.use('/api', creditsRouter(ctx));
  app.use('/api', apiKeysRouter(ctx));
```

- [ ] **Step 4: Run the test to verify it passes, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/api-keys.test.js && npx vitest run`
Expected: PASS (12 tests in the new file: 8 `it` + 4 table rows); suite green.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/api-keys.js web/server/routes/api-keys.js web/server/context.js web/server/app.js web/server/test/api-keys.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: API key store and browser key routes (Pro only, at most five)"
```

---
### Task 4: Shared create path with source and priority

**Files:**
- Create: `web/server/services/voiceovers.js`
- Modify: `web/server/routes/jobs.js` (imports :1-8, `readText` :26-32, `POST /jobs/estimate` :53-58, `POST /jobs` :60-87)
- Modify: `web/server/services/jobs-repo.js` (`toSummary` :3-6, `insertWithCharge` :10-27), `web/server/services/charges.js` (`insertHeld` :21-33), `web/server/clients/engine.js` (`createJob` :24-25)
- Modify (test): `web/server/test/fakes/fake-engine.js` (job object :198-206), `web/server/test/jobs.test.js`

**Interfaces:**
- Consumes: Task 2 columns `jobs.source/api_key_id/webhook_url`, `charges.source`.
- Produces:
  - `services/voiceovers.js`: `PRIORITY = { web: 5, api: 1 }`; `readText(value, max) -> {text, chars}` (moved from `routes/jobs.js`, unchanged); `readJobInput(body, maxChars) -> {text, chars, voiceId, settings}`; `queueVoiceover(ctx, {charge, key, userId, voice, text, chars, settings, source = 'web', apiKeyId = null, webhookUrl = null}) -> engine create answer {id, estimated_seconds, ...}` (holds the charge, creates the engine job with `PRIORITY[source]`, refunds at once on an engine refusal, records the job row with the charge).
  - `charges.insertHeld({..., source = 'web'}, client = pool)`.
  - `jobsRepo.insertWithCharge({..., source = 'web', apiKeyId = null, webhookUrl = null})`; `toSummary(row).source`.
  - `engine.createJob({..., priority})` sends `priority` in the JSON body.
  - Fake engine keeps `priority` on its job objects.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('voiceover jobs', ...)` of `web/server/test/jobs.test.js`:
```js
  it('queues web voiceovers at web priority and labels the job and its charge web', async () => {
    const res = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' });
    expect(res.status).toBe(202);
    expect(h.engine.state.callsTo('POST', '/v1/jobs').at(-1).body.priority).toBe(5);
    expect(h.engine.state.jobs.get(res.body.id).priority).toBe(5);
    const list = await ana.get('/api/jobs');
    expect(list.body.items.find((j) => j.id === res.body.id).source).toBe('web');
    const { rows: [charge] } = await h.pool.query('SELECT source FROM charges WHERE job_id = $1', [res.body.id]);
    expect(charge.source).toBe('web');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/jobs.test.js`
Expected: FAIL — `expected undefined to be 5`.

- [ ] **Step 3: Implement**

Create `web/server/services/voiceovers.js`:
```js
import { ApiError } from '../lib/errors.js';
import { countChars, makeTitle } from '../lib/pricing.js';
import { engineError } from '../lib/upstream-errors.js';

/** Engine queue priority by source (the engine clamps to its 1-5 caller range): web first, API after; regenerate is 10. */
export const PRIORITY = Object.freeze({ web: 5, api: 1 });

export function readText(value, max) {
  if (typeof value !== 'string') throw new ApiError('invalid_request', 'text is required');
  const text = value.trim();
  const chars = countChars(text);
  if (chars > max) throw new ApiError('too_large', 'text exceeds 20,000 characters');
  return { text, chars };
}

/** The body of a voiceover create, checked the same way for POST /api/jobs and POST /v1/tts. */
export function readJobInput(body, maxChars) {
  const { voiceId, settings = {} } = body ?? {};
  const { text, chars } = readText(body?.text, maxChars);
  if (chars === 0) throw new ApiError('invalid_request', 'text is empty');
  if (typeof voiceId !== 'string') throw new ApiError('invalid_request', 'voiceId is required');
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new ApiError('invalid_request', 'settings must be an object');
  }
  return { text, chars, voiceId, settings };
}

/**
 * Holds the already inserted charge, queues the engine job and records it with the charge. `key` is the engine
 * Idempotency-Key and the middle of the hold ref. An engine refusal refunds the hold at once.
 */
export async function queueVoiceover(ctx, { charge, key, userId, voice, text, chars, settings, source = 'web', apiKeyId = null, webhookUrl = null }) {
  const { charges, engine, jobsRepo, config } = ctx;
  await charges.hold(charge);
  let created;
  try {
    created = await engine.createJob({
      voiceId: voice.id, text, settings, callbackUrl: config.engineCallbackUrl, idempotencyKey: key, priority: PRIORITY[source],
    });
  } catch (err) {
    await charges.refundNow(charge);
    throw engineError(err);
  }
  await jobsRepo.insertWithCharge({
    id: created.id, userId, voiceId: voice.id, voiceName: voice.name, title: makeTitle(text), chars, chargeId: charge.id,
    source, apiKeyId, webhookUrl,
  });
  return created;
}
```

`web/server/routes/jobs.js`:
- Imports: replace the pricing and add the service import, delete the local `readText` function (lines 26-32):
```js
import crypto from 'node:crypto';
import express from 'express';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { countSentences, creditsFor, rupiahFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { toSummary } from '../services/jobs-repo.js';
import { isUuid, ownJob, parseIdx, usableVoice } from '../services/ownership.js';
import { queueVoiceover, readJobInput, readText } from '../services/voiceovers.js';
```
- `POST /jobs/estimate` keeps its body (it now uses the imported `readText`).
- Replace the `POST /jobs` handler:
```js
  router.post('/jobs', async (req, res) => {
    const { text, chars, voiceId, settings } = readJobInput(req.body, config.maxTextChars);
    const userId = req.session.user_id;
    await accounts.fresh(req.session);
    const voice = await usableVoice(ctx, userId, voiceId);
    if (voice.status !== 'ready') throw new ApiError('voice_not_ready', `voice is ${voice.status}`);
    const credits = creditsFor(chars);
    const key = crypto.randomUUID();
    const charge = await charges.insertHeld({ userId, revision: 1, kind: 'job', chars, credits, holdId: `tts:${key}:r1` });
    const created = await queueVoiceover(ctx, { charge, key, userId, voice, text, chars, settings });
    res.status(202).json({ id: created.id, credits, estimatedSeconds: created.estimated_seconds });
  });
```
- In `jobsRouter`, the destructuring becomes `const { config, engine, accounts, charges, jobsRepo } = ctx;` (unchanged names; `engine` is still used by GET routes).

`web/server/services/jobs-repo.js`:
```js
export const toSummary = (r) => ({
  id: r.id, title: r.title, voiceId: r.voice_id, voiceName: r.voice_name, status: r.status, chars: r.chars,
  credits: r.credits, audioSeconds: r.audio_seconds, revision: r.revision, createdAt: r.created_at, finishedAt: r.finished_at,
  source: r.source,
});
```
```js
    async insertWithCharge({ id, userId, voiceId, voiceName, title, chars, chargeId, source = 'web', apiKeyId = null, webhookUrl = null }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status, revision, source, api_key_id, webhook_url)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', 1, $7, $8, $9)`,
          [id, userId, voiceId, voiceName, title, chars, source, apiKeyId, webhookUrl],
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
```

`web/server/services/charges.js` — `insertHeld` gains `source` and an optional client (Task 7 inserts inside its own transaction):
```js
  async function insertHeld({ userId, jobId = null, revision, kind, sentenceIdx = null, chars, credits, holdId, source = 'web' }, client = pool) {
    try {
      const { rows: [row] } = await client.query(
        `INSERT INTO charges (user_id, job_id, revision, kind, sentence_idx, chars, credits, hold_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [userId, jobId, revision, kind, sentenceIdx, chars, credits, holdId, source],
      );
      return row;
    } catch (err) {
      if (err.code === '23505') return null;
      throw err;
    }
  }
```

`web/server/clients/engine.js`:
```js
    createJob: ({ voiceId, text, settings, callbackUrl, idempotencyKey, priority }) =>
      call('POST', '/v1/jobs', { voice_id: voiceId, text, settings, callback_url: callbackUrl, priority }, { 'idempotency-key': idempotencyKey }),
```
(`JSON.stringify` drops an undefined `priority`, so callers that pass none send none.)

`web/server/test/fakes/fake-engine.js` — in the job object created by `POST /v1/jobs`, after `callback_url`, add `priority: body.priority ?? null,`.

- [ ] **Step 4: Run the test to verify it passes, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/jobs.test.js && npx vitest run`
Expected: PASS (+1 test); suite green (callback, reconcile and job-actions tests still create jobs through the moved code).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/voiceovers.js web/server/routes/jobs.js web/server/services/jobs-repo.js \
  web/server/services/charges.js web/server/clients/engine.js web/server/test/fakes/fake-engine.js web/server/test/jobs.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: shared voiceover create path, web jobs at priority 5, source on jobs and charges"
```

---

### Task 5: `/v1` key authentication, account checks, rate limit and `GET /v1/voices`

**Files:**
- Create: `web/server/services/api-accounts.js`, `web/server/services/rate-limit.js`, `web/server/http/api-auth.js`, `web/server/routes/v1.js`
- Modify: `web/server/services/profiles.js` (add `setApiAllowed`), `web/server/context.js`, `web/server/app.js`
- Modify (test): `web/server/test/helpers.js` (user `cici`, `h.apiKey()`, `h.api()`)
- Test: `web/server/test/v1-auth.test.js`

**Interfaces:**
- Consumes: Task 3 `ctx.apiKeys` (`find`, `autoRevoke`, `touch`); `accounts.ME_CACHE_MS`, `OUTAGE_RETRY_MS`; `sessions.userTv`; `profilesWithVoices`; Task 2 codes.
- Produces:
  - `createApiAccounts({ lqstudio }, { now }?) -> { get(userId) -> user | null, cache: Map }` (null = LQ-Studio no longer knows the user). `ctx.apiAccounts`.
  - `createRateLimiter({ limit = 60, windowMs = 60000, now }?) -> { limit, hit(id) -> {ok: true} | {ok: false, retryAfterS}, reset() }`. `ctx.apiLimiter`.
  - `requireApiKey(ctx)` middleware: sets `req.apiKey` (the `api_keys` row) and `req.apiUserId`.
  - `v1Router(ctx)`: auth → `express.json({ limit: '256kb' })` → `Cache-Control: no-store` → routes → 404 `not_found`. Task 7 replaces this file with the full router (same head and tail).
  - `GET /v1/voices` → `{ voices: [{id, name, language, kind: 'own'}, {id, name, language, kind: 'profile', description: {id, en}}] }`.
  - `profiles.setApiAllowed(slug, allowed: boolean) -> boolean` (false: no such slug).
  - App: `GET /api` → 302 `/api-keys`, `GET /api/docs` → 302 `/developers`, `/v1` mounted before every `/api` middleware.
  - Test harness: `USERS.cici` (plan `ultra`, paid, balance 1000); `h.apiKey(userId = 'budi', { tv = 0 }?) -> Promise<string>` (full key); `h.api(key)` → `{ get, post, del }` supertest helpers that send `Authorization: Bearer <key>` (no cookie, no CSRF header).

- [ ] **Step 1: Write the failing test**

In `web/server/test/helpers.js` add the user and the two helpers:
```js
export const USERS = {
  ana: user('ana'),
  budi: user('budi', { plan: 'pro', paid: true, balance: 1000 }),
  cici: user('cici', { plan: 'ultra', paid: true, balance: 1000 }),
  tfa: user('tfa', { totp: '123456' }),
  unverified: user('unverified', { verified: false }),
  suspended: user('suspended', { suspended: true }),
  poor: user('poor', { balance: 0 }),
};
```
inside the object `startHarness` returns, after `as(cookie) {...},`:
```js
    // A live API key for the user, made through the store (the browser route needs a session).
    async apiKey(userId = 'budi', { tv = 0 } = {}) {
      return (await ctx.apiKeys.create(userId, { name: 'test key', tv })).key;
    },
    api(key) {
      const go = (r) => (key ? r.set('authorization', `Bearer ${key}`) : r);
      return {
        get: (p) => go(request(app).get(p)),
        post: (p, body) => go(request(app).post(p)).send(body ?? {}),
        del: (p) => go(request(app).delete(p)),
      };
    },
```

Create `web/server/test/v1-auth.test.js`:
```js
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ME_CACHE_MS } from '../services/accounts.js';
import { parseApiKey } from '../services/api-keys.js';
import { createRateLimiter } from '../services/rate-limit.js';
import { USERS, startHarness } from './helpers.js';

const meta = (slug, name) => ({
  slug, name, gender: 'male', language: 'id',
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }],
  bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: name, attestedBy: 'lqmnah', scope: 'Public library voice' },
  sort: 100,
});

describe('createRateLimiter', () => {
  it('allows `limit` hits per window per id and says when the window ends', () => {
    const clock = { now: 0 };
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock.now });
    expect([limiter.hit('a'), limiter.hit('a')]).toEqual([{ ok: true }, { ok: true }]);
    clock.now = 400;
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterS: 1 });
    expect(limiter.hit('b')).toEqual({ ok: true });
    clock.now = 1000;
    expect(limiter.hit('a')).toEqual({ ok: true });
    limiter.hit('a');
    limiter.reset();
    expect(limiter.hit('a')).toEqual({ ok: true });
  });
});

describe('/v1 authentication and account checks', () => {
  let h;
  let key;
  beforeAll(async () => {
    h = await startHarness();
    key = await h.apiKey('budi');
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.ctx.apiLimiter.reset();
    h.ctx.apiAccounts.cache.clear();
    Object.assign(h.lq.state.users.get('cici'), { plan: 'ultra', paid: true, suspended: false, verified: true });
  });
  const usedAt = async (raw) => (await h.pool.query('SELECT last_used_at FROM api_keys WHERE key_id = $1', [parseApiKey(raw).keyId])).rows[0].last_used_at;

  it('answers 401 without a valid Bearer key, whatever cookie comes along', async () => {
    const cookie = await h.login(USERS.budi);
    const tampered = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    for (const req of [
      request(h.app).get('/v1/voices'),
      request(h.app).get('/v1/voices').set('cookie', cookie),
      request(h.app).get('/v1/voices').set('authorization', `Bearer ${tampered}`),
      request(h.app).get('/v1/voices').set('authorization', `Basic ${key}`),
      request(h.app).get('/v1/nope').set('cookie', cookie),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('serves a valid key without cookies or CORS, and a key never opens a cookie route', async () => {
    const res = await h.api(key).get('/v1/voices');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await request(h.app).get('/api/jobs').set('authorization', `Bearer ${key}`)).status).toBe(401);
    const unknown = await h.api(key).get('/v1/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
  });

  it('lists ready own voices and API-allowed active profiles only', async () => {
    const mine = h.engine.addVoice({ owner_ref: 'budi', name: 'Suara Budi' });
    h.engine.addVoice({ owner_ref: 'budi', name: 'Masih proses', status: 'processing' });
    h.engine.addVoice({ owner_ref: 'ana', name: 'Punya Ana' });
    const allowed = h.engine.addVoice({ owner_ref: 'library', name: 'Pandji' });
    const webOnly = h.engine.addVoice({ owner_ref: 'library', name: 'Rina' });
    await h.ctx.profiles.upsert(meta('api-ok', 'Pandji'), allowed.id);
    await h.ctx.profiles.upsert(meta('web-only', 'Rina'), webOnly.id);
    expect(await h.ctx.profiles.setApiAllowed('api-ok', true)).toBe(true);
    expect(await h.ctx.profiles.setApiAllowed('nobody', true)).toBe(false);
    const res = await h.api(key).get('/v1/voices');
    expect(res.body).toEqual({
      voices: [
        { id: mine.id, name: 'Suara Budi', language: 'id', kind: 'own' },
        { id: allowed.id, name: 'Pandji', language: 'id', kind: 'profile', description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' } },
      ],
    });
    await h.ctx.profiles.deactivate('api-ok');
    expect((await h.api(key).get('/v1/voices')).body.voices.map((v) => v.id)).toEqual([mine.id]);
  });

  it('records the last use at most once a minute', async () => {
    await h.pool.query('UPDATE api_keys SET last_used_at = NULL WHERE key_id = $1', [parseApiKey(key).keyId]);
    await h.api(key).get('/v1/voices');
    const first = await usedAt(key);
    expect(first).not.toBeNull();
    await h.api(key).get('/v1/voices');
    expect((await usedAt(key)).getTime()).toBe(first.getTime());
    await h.pool.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE key_id = $1`, [parseApiKey(key).keyId]);
    await h.api(key).get('/v1/voices');
    expect((await usedAt(key)).getTime()).toBeGreaterThan(Date.now() - 30_000);
  });

  it('limits an account to 60 requests a minute across all its keys', async () => {
    const other = await h.apiKey('budi');
    for (let i = 0; i < 60; i += 1) expect((await h.api(i % 2 ? key : other).get('/v1/voices')).status).toBe(200);
    const res = await h.api(key).get('/v1/voices');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await h.api(await h.apiKey('cici')).get('/v1/voices')).status).toBe(200);
  });

  it('rechecks the account at most every five minutes and rides out an LQ-Studio outage on the cached copy', async () => {
    const k = await h.apiKey('cici');
    const reads = () => h.lq.state.calls.filter((c) => c.path === '/users/cici').length;
    expect((await h.api(k).get('/v1/voices')).status).toBe(200);
    const before = reads();
    h.lq.state.users.get('cici').suspended = true;
    expect((await h.api(k).get('/v1/voices')).status).toBe(200); // still inside the 5-minute cache
    expect(reads()).toBe(before);
    h.lq.state.users.get('cici').suspended = false;
    h.ctx.apiAccounts.cache.get('cici').at -= ME_CACHE_MS;
    h.lq.state.down = true;
    try {
      expect((await h.api(k).get('/v1/voices')).status).toBe(200);
      expect((await h.api(k).get('/v1/voices')).status).toBe(200);
      expect(reads()).toBe(before + 1); // asked once, then waits OUTAGE_RETRY_MS
      h.ctx.apiAccounts.cache.clear();
      const cold = await h.api(k).get('/v1/voices');
      expect(cold.status).toBe(503);
      expect(cold.body.error.code).toBe('lqstudio_unavailable');
    } finally {
      h.lq.state.down = false;
    }
  });

  it('revokes the keys of a suspended account', async () => {
    const k = await h.apiKey('cici');
    h.lq.state.users.get('cici').suspended = true;
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('suspended');
    h.lq.state.users.get('cici').suspended = false;
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'suspended' }));
  });

  it('refuses an unverified account without revoking its key', async () => {
    const k = await h.apiKey('cici');
    h.lq.state.users.get('cici').verified = false;
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('needs_verification');
    h.lq.state.users.get('cici').verified = true;
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(200);
  });

  it('revokes the keys of an account that drops below Pro', async () => {
    const k = await h.apiKey('cici');
    Object.assign(h.lq.state.users.get('cici'), { plan: 'free', paid: false });
    const res = await h.api(k).get('/v1/voices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_required');
    Object.assign(h.lq.state.users.get('cici'), { plan: 'ultra', paid: true });
    h.ctx.apiAccounts.cache.clear();
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'plan' }));
  });

  it('revokes keys made before a password change or log-out-everywhere, keeps newer ones', async () => {
    const before = await h.apiKey('cici', { tv: 0 });
    h.lq.bumpTv('cici');
    const res = await h.api(before).get('/v1/voices');
    expect(res.status).toBe(401);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'tv' }));
    const after = await h.apiKey('cici', { tv: 1 });
    expect((await h.api(after).get('/v1/voices')).status).toBe(200);
  });

  it('revokes the keys of an account LQ-Studio no longer knows', async () => {
    const k = await h.apiKey('cici');
    const saved = h.lq.state.users.get('cici');
    h.lq.state.users.delete('cici');
    try {
      expect((await h.api(k).get('/v1/voices')).status).toBe(401);
      expect(h.logs).toContainEqual(expect.objectContaining({ event: 'api_key_auto_revoked', userId: 'cici', reason: 'account_gone' }));
    } finally {
      h.lq.state.users.set('cici', saved);
    }
    expect((await h.api(k).get('/v1/voices')).status).toBe(401);
  });

  it('sends the spec addresses of the API page and its docs to the app routes', async () => {
    const page = await request(h.app).get('/api');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/api-keys');
    const docs = await request(h.app).get('/api/docs');
    expect(docs.status).toBe(302);
    expect(docs.headers.location).toBe('/developers');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/v1-auth.test.js`
Expected: FAIL — `Cannot find module '../services/rate-limit.js'`.

- [ ] **Step 3: Implement**

Create `web/server/services/api-accounts.js`:
```js
import { UpstreamError } from '../clients/http.js';
import { lqError } from '../lib/upstream-errors.js';
import { ME_CACHE_MS, OUTAGE_RETRY_MS } from './accounts.js';

const MAX_CACHED = 10_000;

/**
 * LQ-Studio's view of API callers (plan, paid, suspension, verification, tokenVersion), cached per user for at most
 * ME_CACHE_MS like web sessions, in memory (one web process per environment). While LQ-Studio is unreachable the
 * cached copy is served and asked again only after OUTAGE_RETRY_MS. `get` answers null when LQ-Studio no longer
 * knows the user. `cache` is exposed for tests and operations (clearing it forces a re-read).
 */
export function createApiAccounts({ lqstudio }, { now = Date.now } = {}) {
  const cache = new Map(); // userId → { user, at }

  async function get(userId) {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < ME_CACHE_MS) return hit.user;
    let user;
    try {
      user = await lqstudio.getUser(userId);
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        cache.delete(userId);
        return null;
      }
      if (hit) {
        hit.at = now() - ME_CACHE_MS + OUTAGE_RETRY_MS;
        return hit.user;
      }
      throw lqError(err);
    }
    cache.delete(userId); // re-inserted last: Map order is the eviction order
    cache.set(userId, { user, at: now() });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return user;
  }

  return { get, cache };
}
```

Create `web/server/services/rate-limit.js`:
```js
/** Fixed windows per id (an account), in memory: one web process per environment. */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map(); // id → { start, count }

  function prune(t) {
    for (const [id, w] of windows) if (t - w.start >= windowMs) windows.delete(id);
  }

  return {
    limit,
    hit(id) {
      const t = now();
      let w = windows.get(id);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(id, w);
        if (windows.size > 10_000) prune(t);
      }
      w.count += 1;
      if (w.count <= limit) return { ok: true };
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    },
    reset() {
      windows.clear();
    },
  };
}
```

Create `web/server/http/api-auth.js`:
```js
import { ApiError } from '../lib/errors.js';
import { userTv } from '../services/sessions.js';

const BEARER = /^Bearer +(\S+)$/i;

/**
 * /v1 authentication: `Authorization: Bearer lqtts_<key_id>_<secret>` only; cookies are never read. Then the
 * per-account rate limit, then the account rules (≤ 5-minute LQ-Studio cache): suspension, a plan below Pro and a
 * newer tokenVersion revoke the account's keys; unverified is refused without revoking.
 */
export function requireApiKey({ apiKeys, apiAccounts, apiLimiter }) {
  return async (req, res, next) => {
    const raw = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const key = raw ? await apiKeys.find(raw) : null;
    if (!key) throw new ApiError('unauthorized', 'missing, invalid or revoked API key');
    const userId = key.user_id;
    const hit = apiLimiter.hit(userId);
    if (!hit.ok) {
      throw new ApiError('rate_limited', `at most ${apiLimiter.limit} requests a minute; try again in ${hit.retryAfterS} s`, {
        headers: { 'retry-after': String(hit.retryAfterS) },
      });
    }
    const user = await apiAccounts.get(userId);
    if (user === null) {
      await apiKeys.autoRevoke(userId, 'account_gone');
      throw new ApiError('unauthorized', 'account not found');
    }
    if (user.suspended) {
      await apiKeys.autoRevoke(userId, 'suspended');
      throw new ApiError('suspended', 'this account is suspended');
    }
    if (!user.verified) throw new ApiError('needs_verification', 'finish verifying your email and phone on LQ-Studio');
    const tv = userTv(user);
    if (tv > key.tv) {
      await apiKeys.autoRevoke(userId, 'tv', { belowTv: tv });
      throw new ApiError('unauthorized', 'this API key was revoked: the password changed or every session was logged out');
    }
    if (!user.paid) {
      await apiKeys.autoRevoke(userId, 'plan');
      throw new ApiError('plan_required', 'the API needs a Pro, Ultra or Sultan plan');
    }
    await apiKeys.touch(key);
    req.apiKey = key;
    req.apiUserId = userId;
    next();
  };
}
```

Create `web/server/routes/v1.js` (Task 7 replaces it with the full router):
```js
import express from 'express';
import { requireApiKey } from '../http/api-auth.js';
import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';
import { profilesWithVoices } from '../services/profiles.js';

export function v1Router(ctx) {
  const { engine } = ctx;
  const router = express.Router();
  router.use(requireApiKey(ctx));
  router.use(express.json({ limit: '256kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/voices', async (req, res) => {
    let own;
    try {
      own = await engine.listVoices(req.apiUserId);
    } catch (err) {
      throw engineError(err);
    }
    const profiles = await profilesWithVoices(ctx);
    res.json({
      voices: [
        ...own.filter((v) => v.status === 'ready').map((v) => ({ id: v.id, name: v.name, language: v.language, kind: 'own' })),
        ...profiles.filter(({ row, voice }) => row.api_allowed && voice?.status === 'ready').map(({ row }) => ({
          id: row.voice_id, name: row.name, language: row.language, kind: 'profile',
          description: { id: row.description_id, en: row.description_en },
        })),
      ],
    });
  });

  router.use(() => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  return router;
}
```

`web/server/services/profiles.js` — add to the object `createProfiles` returns, after `deactivate`:
```js
    async setApiAllowed(slug, allowed) {
      const { rowCount } = await pool.query('UPDATE voice_profiles SET api_allowed = $2 WHERE slug = $1', [slug, allowed]);
      return rowCount > 0;
    },
```
(`upsert` does not touch `api_allowed`, so replacing a profile's voice keeps the flag.)

`web/server/context.js` — import `createApiAccounts` from `./services/api-accounts.js` and `createRateLimiter` from `./services/rate-limit.js`; after `ctx.accounts = ...` add:
```js
  ctx.apiAccounts = createApiAccounts(ctx);
  ctx.apiLimiter = createRateLimiter();
```

`web/server/app.js` — import `v1Router` from `./routes/v1.js`; right after the security-header middleware and before `app.use('/api', callbackRouter(ctx))`:
```js
  // The spec's browser addresses (tts.lq-studio.com/api and /api/docs); the JSON API has no GET /api of its own.
  app.get('/api', (req, res) => res.redirect(302, '/api-keys'));
  app.get('/api/docs', (req, res) => res.redirect(302, '/developers'));
  // Server-to-server API: Bearer keys only, before (so never behind) the cookie, CSRF and session middleware.
  app.use('/v1', v1Router(ctx));
```

- [ ] **Step 4: Run the test to verify it passes, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/v1-auth.test.js && npx vitest run`
Expected: PASS (13 tests in the new file); suite green.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/api-accounts.js web/server/services/rate-limit.js web/server/http/api-auth.js \
  web/server/routes/v1.js web/server/services/profiles.js web/server/context.js web/server/app.js \
  web/server/test/helpers.js web/server/test/v1-auth.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: /v1 Bearer-key auth with account checks, auto-revoke, rate limit, GET /v1/voices"
```

---
### Task 6: Webhook URL guard (SSRF) and signature

**Files:**
- Create: `web/server/services/webhook-security.js`
- Test: `web/server/test/webhook-security.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_WEBHOOK_URL = 500`; `class WebhookUrlError extends Error`.
  - `isPublicAddress(address: string) -> boolean` (false for loopback, RFC1918, link-local incl. 169.254.169.254, CGNAT 100.64/10, 0/8, multicast, reserved 240/4 incl. broadcast, benchmark 198.18/15, documentation ranges, `::`, `::1`, ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, discard 100::/64, Teredo 2001::/32, 6to4 2002::/16, docs 2001:db8::/32, IPv4-mapped forms of private IPv4, any non-IP).
  - `lookupAll(host) -> Promise<{address, family}[]>` (DNS, all records).
  - `resolveWebhookUrl(raw, { allowLoopback = false, lookup = lookupAll }?) -> Promise<{ url: string, address: string, family: 4|6 }>`; throws `WebhookUrlError` with a message safe to show the caller. `address` is the one a delivery must connect to.
  - `signWebhook(secret, body: string, timestamp = now) -> 't=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>'`.

- [ ] **Step 1: Write the failing test**

Create `web/server/test/webhook-security.test.js`:
```js
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebhookUrlError, isPublicAddress, resolveWebhookUrl, signWebhook } from '../services/webhook-security.js';

const answers = (...addresses) => vi.fn(async () => addresses.map((address) => ({ address, family: net.isIP(address) })));

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.10',
    '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2001::1', '2002:a00:1::1', 'not-an-ip', '',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('resolveWebhookUrl', () => {
  it('accepts https on 443 to a host that resolves only to public addresses, and pins the first one', async () => {
    const lookup = answers('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(resolveWebhookUrl('https://hooks.example.com/lqtts?x=1', { lookup })).resolves.toEqual({
      url: 'https://hooks.example.com/lqtts?x=1', address: '93.184.216.34', family: 4,
    });
    expect(lookup).toHaveBeenCalledWith('hooks.example.com');
    await expect(resolveWebhookUrl('https://hooks.example.com:443/x', { lookup })).resolves.toMatchObject({ url: 'https://hooks.example.com/x' });
  });

  it.each([
    ['http://hooks.example.com/x', /must use https/],
    ['https://hooks.example.com:8443/x', /port 443/],
    ['https://user:pw@hooks.example.com/x', /user name or password/],
    [`https://hooks.example.com/${'a'.repeat(480)}`, /at most 500/],
    ['ftp://hooks.example.com/x', /must use https/],
    ['not a url', /not a valid URL/],
    [42, /at most 500/],
  ])('refuses %s before any DNS lookup', async (raw, message) => {
    const lookup = answers('93.184.216.34');
    await expect(resolveWebhookUrl(raw, { lookup })).rejects.toThrow(message);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['https://10.0.0.1/x', []],
    ['https://[::1]/x', []],
    ['https://169.254.169.254/latest/meta-data', []],
    ['https://inside.example.com/x', ['10.0.0.7']],
    ['https://mixed.example.com/x', ['93.184.216.34', '192.168.1.5']],
    ['https://rebind.example.com/x', ['::ffff:127.0.0.1']],
  ])('refuses %s, which reaches a non-public address', async (raw, resolved) => {
    await expect(resolveWebhookUrl(raw, { lookup: answers(...resolved) })).rejects.toThrow(/public address/);
  });

  it('refuses a host that does not resolve', async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const err = await resolveWebhookUrl('https://nowhere.example.com/x', { lookup }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookUrlError);
    expect(err.message).toMatch(/does not resolve/);
    await expect(resolveWebhookUrl('https://empty.example.com/x', { lookup: answers() })).rejects.toThrow(/does not resolve/);
  });

  it('lets local runs reach a loopback receiver over http on any port, and nothing else private', async () => {
    await expect(resolveWebhookUrl('http://127.0.0.1:9999/hook', { allowLoopback: true })).resolves.toEqual({
      url: 'http://127.0.0.1:9999/hook', address: '127.0.0.1', family: 4,
    });
    await expect(resolveWebhookUrl('http://localhost:9999/hook', { allowLoopback: true, lookup: answers('127.0.0.1', '::1') }))
      .resolves.toMatchObject({ address: '127.0.0.1' });
    await expect(resolveWebhookUrl('http://10.0.0.1:9999/hook', { allowLoopback: true })).rejects.toThrow(/must use https/);
    await expect(resolveWebhookUrl('https://192.168.1.5/hook', { allowLoopback: true })).rejects.toThrow(/public address/);
    await expect(resolveWebhookUrl('http://127.0.0.1:9999/hook')).rejects.toThrow(/must use https/);
    await expect(resolveWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(/public address/);
  });
});

describe('signWebhook', () => {
  it('signs "<t>.<body>" with HMAC-SHA256 under the webhook secret', () => {
    expect(signWebhook('whsec_test', '{"event":"job.done"}', 1700000000))
      .toBe('t=1700000000,v1=f86a58b1a8a35080339acb9adaaf07138b28ac2cb787c4437a5ff327c61d0ef1');
    expect(signWebhook('whsec_test', '{"event":"job.done"}')).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
  });
});
```
(The vector was computed independently: `node -e "console.log(require('crypto').createHmac('sha256','whsec_test').update('1700000000.{\"event\":\"job.done\"}').digest('hex'))"`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/webhook-security.test.js`
Expected: FAIL — `Cannot find module '../services/webhook-security.js'`.

- [ ] **Step 3: Implement**

Create `web/server/services/webhook-security.js`:
```js
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

export const MAX_WEBHOOK_URL = 500;

/** A webhookUrl the server will not call; the message is safe to return to the API caller. */
export class WebhookUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(prefix, bits, 'ipv6');

const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True only for addresses on the public internet (see the BLOCKED ranges); anything that is not an IP is false. */
export function isPublicAddress(address) {
  const ip = String(address).toLowerCase();
  const mapped = MAPPED_DOTTED.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, 'ipv4');
  if (family === 6) return !ip.startsWith('::ffff:') && !BLOCKED.check(ip, 'ipv6');
  return false;
}

const isLoopback = (address) => /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address);

export const lookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Checks a webhook URL and resolves its host, at create time and again before every delivery: https, port 443, no
 * user info, at most MAX_WEBHOOK_URL characters, and every resolved address public. With allowLoopback (local e2e
 * only, config.webhookAllowLoopback) a URL whose every address is loopback may also use http and any port.
 * Answers the address the delivery must connect to, so a second DNS answer can never redirect it.
 */
export async function resolveWebhookUrl(raw, { allowLoopback = false, lookup = lookupAll } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_WEBHOOK_URL) {
    throw new WebhookUrlError(`webhookUrl must be a URL of at most ${MAX_WEBHOOK_URL} characters`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('webhookUrl is not a valid URL');
  }
  const httpOk = allowLoopback && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpOk) throw new WebhookUrlError('webhookUrl must use https');
  if (!allowLoopback && url.port !== '' && url.port !== '443') throw new WebhookUrlError('webhookUrl must use port 443');
  if (url.username || url.password) throw new WebhookUrlError('webhookUrl must not contain a user name or password');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      addresses = [];
    }
    if (!addresses.length) throw new WebhookUrlError('webhookUrl host does not resolve');
  }
  if (!(allowLoopback && addresses.every((a) => isLoopback(a.address)))) {
    if (url.protocol !== 'https:') throw new WebhookUrlError('webhookUrl must use https');
    if (url.port !== '' && url.port !== '443') throw new WebhookUrlError('webhookUrl must use port 443');
    if (!addresses.every((a) => isPublicAddress(a.address))) throw new WebhookUrlError('webhookUrl must point to a public address');
  }
  return { url: url.href, address: addresses[0].address, family: addresses[0].family };
}

/** `LQTTS-Signature` value: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>. */
export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/webhook-security.test.js`
Expected: PASS, 56 tests (39 address rows, 16 URL tests and rows, 1 signature test); no network access: every test injects `lookup` or uses an IP literal.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/webhook-security.js web/server/test/webhook-security.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: webhook URL guard (public addresses only, pinned) and HMAC signature"
```

---
### Task 7: `/v1` voiceover endpoints (estimate, create, status, files, cancel/delete)

**Files:**
- Create: `web/server/services/api-jobs.js`, `web/server/services/job-control.js`
- Modify: `web/server/routes/job-actions.js` (whole file below), `web/server/routes/v1.js` (whole file below), `web/server/services/ownership.js` (`usableVoice` :21-33), `web/server/context.js`
- Test: `web/server/test/v1-jobs.test.js`

**Interfaces:**
- Consumes: Task 4 `readText`, `readJobInput`, `queueVoiceover`, `charges.insertHeld(charge, client)`; Task 5 `requireApiKey` (`req.apiKey`, `req.apiUserId`), `h.apiKey`, `h.api`, `USERS.cici`; Task 6 `resolveWebhookUrl`, `WebhookUrlError`; `relayEngine`, `ownJob`, `jobsRepo.own/applyEngineState/markDeleted`.
- Produces:
  - `services/api-jobs.js`: `MAX_ACTIVE_API_JOBS = 2`; `API_FILES` (public name → engine name); `apiFiles(jobId, engineFiles) -> {mp3?, wav?, srt?, vtt?} | null`; `toApiJob(row, view) -> {jobId, status, progress, credits, errorCode, files?, createdAt}`; `readIdempotencyKey(raw) -> string | null`; `createApiJobs(pool) -> { reserve(charges, charge) -> chargeRow, claimKey(userId, key) -> boolean, keyJob(userId, key) -> jobId | null, bindKey(userId, key, jobId), releaseKey(userId, key) }`. `ctx.apiJobs`.
  - `services/job-control.js`: `busy()`; `createJobControl(ctx) -> { withLease(jobId, work), engineView(jobId) -> view | null, cancel(job), remove(job, view) }`. `ctx.jobControl`.
  - `usableVoice(ctx, userId, voiceId, { api = false }?)`: with `api`, a library voice also needs `api_allowed`.
  - Endpoints: `POST /v1/estimate {text}` → `{chars, credits, sentences}`; `POST /v1/tts {text, voiceId, settings?, formats?, webhookUrl?}` (+ `Idempotency-Key`) → 202 `{jobId, credits, status: 'queued'}` (replay: same shape, current status, header `Idempotent-Replayed: true`); `GET /v1/tts/:id` → `toApiJob`; `GET /v1/tts/:id/files/:name` (stream); `DELETE /v1/tts/:id` → 204.

- [ ] **Step 1: Write the failing test**

Create `web/server/test/v1-jobs.test.js`:
```js
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS, binary, startHarness } from './helpers.js';

const meta = (slug, name) => ({
  slug, name, gender: 'male', language: 'id',
  description: { id: 'Pria.', en: 'Male.' }, tags: [{ id: 'Pria', en: 'Male' }], bestFor: { id: 'Narasi.', en: 'Narration.' },
  consent: { subject: name, attestedBy: 'lqmnah', scope: 'Public library voice' }, sort: 100,
});

describe('/v1 voiceovers', () => {
  let h;
  let key;
  let budi;
  let voice;
  beforeAll(async () => {
    h = await startHarness({ env: { WEBHOOK_ALLOW_LOOPBACK: 'true' } });
    key = await h.apiKey('budi');
    budi = h.api(key);
    voice = h.engine.addVoice({ owner_ref: 'budi', name: 'Suara Budi' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    h.ctx.apiLimiter.reset();
    h.lq.state.users.get('budi').balance = 1000;
    // Earlier tests' jobs must not count toward the 2-job cap.
    for (const j of h.engine.state.jobs.values()) if (j.status === 'queued' || j.status === 'running') h.engine.setJob(j.id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')`);
  });
  const create = (body = {}, headers = {}) => {
    let r = budi.post('/v1/tts', { voiceId: voice.id, text: 'Halo dunia.', ...body });
    for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
    return r;
  };
  const holds = () => h.lq.state.callsTo('/credits/hold').length;
  const chargesOf = async (jobId) => (await h.pool.query('SELECT * FROM charges WHERE job_id = $1 ORDER BY id', [jobId])).rows;

  it('estimates like the web app', async () => {
    const res = await budi.post('/v1/estimate', { text: '  Halo dunia. Apa kabar?  ' });
    expect(res.body).toEqual({ chars: 22, credits: 1, sentences: 2 });
    expect((await budi.post('/v1/estimate', { text: '' })).body).toEqual({ chars: 0, credits: 0, sentences: 0 });
    expect((await budi.post('/v1/estimate', { text: 'a'.repeat(20001) })).status).toBe(413);
  });

  it('queues a voiceover at API priority, billed like the web, and lists it in the web history as API', async () => {
    const text = 'Halo dunia. '.repeat(20).trim(); // 239 chars → 3 credits
    const res = await create({ text, settings: { speed: 1.1 }, formats: ['mp3', 'srt'] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: expect.any(String), credits: 3, status: 'queued' });
    const call = h.engine.state.callsTo('POST', '/v1/jobs').at(-1);
    expect(call.body).toMatchObject({ voice_id: voice.id, text, priority: 1, settings: { speed: 1.1, formats: ['mp3', 'srt'] } });
    expect(h.lq.state.users.get('budi').balance).toBe(997);
    const { rows: [job] } = await h.pool.query('SELECT source, api_key_id, webhook_url FROM jobs WHERE id = $1', [res.body.jobId]);
    expect(job).toEqual({ source: 'api', api_key_id: (await h.ctx.apiKeys.find(key)).id, webhook_url: null });
    expect(await chargesOf(res.body.jobId)).toMatchObject([{ source: 'api', state: 'held', credits: 3, kind: 'job' }]);
    const web = h.as(await h.login(USERS.budi));
    expect((await web.get('/api/jobs')).body.items.find((j) => j.id === res.body.jobId)).toMatchObject({ source: 'api', credits: 3 });
  });

  it('validates text, voice, settings, formats and webhookUrl exactly like POST /api/jobs, holding nothing', async () => {
    const before = holds();
    const cases = [
      [{ text: '   ' }, 400, 'invalid_request'],
      [{ text: 'a'.repeat(20001) }, 413, 'too_large'],
      [{ voiceId: undefined }, 400, 'invalid_request'],
      [{ settings: [] }, 400, 'invalid_request'],
      [{ formats: 'mp3' }, 400, 'invalid_request'],
      [{ webhookUrl: 7 }, 400, 'invalid_request'],
      [{ webhookUrl: 'https://10.0.0.1/hook' }, 400, 'invalid_webhook_url'],
      [{ webhookUrl: 'http://10.0.0.2:8080/hook' }, 400, 'invalid_webhook_url'],
    ];
    for (const [body, status, code] of cases) {
      const res = await create(body);
      expect([res.status, res.body.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(holds()).toBe(before);
    h.engine.state.failNext.set('POST /v1/jobs', { status: 400, code: 'invalid_settings', message: 'settings.speed: too fast' });
    const refused = await create({ settings: { speed: 9 } });
    expect(refused.body.error).toEqual({ code: 'invalid_request', message: 'settings.speed: too fast' });
    expect(h.lq.state.net(h.lq.state.callsTo('/credits/hold').at(-1).body.ref)).toBe(0);
  });

  it("accepts the caller's own ready voices and API-allowed profiles only", async () => {
    const before = holds();
    const anas = h.engine.addVoice({ owner_ref: 'ana' });
    const processing = h.engine.addVoice({ owner_ref: 'budi', status: 'processing' });
    const webOnly = h.engine.addVoice({ owner_ref: 'library', name: 'Rina' });
    await h.ctx.profiles.upsert(meta('web-only', 'Rina'), webOnly.id);
    for (const id of [anas.id, webOnly.id, 'not-a-uuid']) {
      const res = await create({ voiceId: id });
      expect([res.status, res.body.error.code]).toEqual([404, 'not_found']);
    }
    const notReady = await create({ voiceId: processing.id });
    expect([notReady.status, notReady.body.error.code]).toEqual([409, 'voice_not_ready']);
    expect(holds()).toBe(before);
    const allowed = h.engine.addVoice({ owner_ref: 'library', name: 'Pandji' });
    await h.ctx.profiles.upsert(meta('api-ok', 'Pandji'), allowed.id);
    await h.ctx.profiles.setApiAllowed('api-ok', true);
    expect((await create({ voiceId: allowed.id })).status).toBe(202);
  });

  it('answers 402 with the balance and the top-up link, keeping no job and no charge', async () => {
    h.lq.state.users.get('budi').balance = 0;
    const jobsBefore = h.engine.state.jobs.size;
    const res = await create({});
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'insufficient_credits', balance: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan' });
    expect(h.engine.state.jobs.size).toBe(jobsBefore);
    const ref = h.lq.state.callsTo('/credits/hold').at(-1).body.ref;
    expect((await h.pool.query('SELECT 1 FROM charges WHERE hold_id = $1', [ref])).rowCount).toBe(0);
  });

  it('keeps at most two API jobs queued or running per account', async () => {
    const first = await create({});
    expect((await create({})).status).toBe(202);
    const before = holds();
    const third = await create({});
    expect([third.status, third.body.error.code]).toEqual([429, 'too_many_jobs']);
    expect(holds()).toBe(before);
    h.engine.setJob(first.body.jobId, { status: 'done' });
    expect((await budi.get(`/v1/tts/${first.body.jobId}`)).body.status).toBe('done'); // reading records it
    expect((await create({})).status).toBe(202);
  });

  it('holds the cap when creates race', async () => {
    const results = await Promise.all([0, 1, 2, 3].map(() => create({})));
    expect(results.map((r) => r.status).sort()).toEqual([202, 202, 429, 429]);
  });

  it('replays an Idempotency-Key for 24 hours without a second hold', async () => {
    const first = await create({}, { 'idempotency-key': 'order-1' });
    const before = holds();
    const again = await create({ text: 'Teks lain.' }, { 'idempotency-key': 'order-1' });
    expect(again.status).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual({ jobId: first.body.jobId, credits: 1, status: 'queued' });
    expect(holds()).toBe(before);
    const otherAccount = await h.api(await h.apiKey('cici')).post('/v1/tts', { voiceId: h.engine.addVoice({ owner_ref: 'cici' }).id, text: 'Halo.' }).set('idempotency-key', 'order-1');
    expect(otherAccount.status).toBe(202);
    expect(otherAccount.body.jobId).not.toBe(first.body.jobId);
    await h.pool.query(`UPDATE api_idempotency SET created_at = now() - interval '25 hours' WHERE user_id = 'budi' AND idem_key = 'order-1'`);
    h.engine.setJob(first.body.jobId, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [first.body.jobId]);
    const later = await create({}, { 'idempotency-key': 'order-1' });
    expect(later.status).toBe(202);
    expect(later.body.jobId).not.toBe(first.body.jobId);
  });

  it('frees a key whose create failed, refuses a key still in flight, and checks the key format', async () => {
    const bad = await create({ voiceId: h.engine.addVoice({ owner_ref: 'ana' }).id }, { 'idempotency-key': 'retry-me' });
    expect(bad.status).toBe(404);
    expect((await create({}, { 'idempotency-key': 'retry-me' })).status).toBe(202);
    await h.pool.query(`INSERT INTO api_idempotency (user_id, idem_key) VALUES ('budi', 'in-flight')`);
    const busy = await create({}, { 'idempotency-key': 'in-flight' });
    expect([busy.status, busy.body.error.code]).toEqual([409, 'idempotency_conflict']);
    await h.pool.query(`UPDATE api_idempotency SET created_at = now() - interval '3 minutes' WHERE idem_key = 'in-flight'`);
    h.engine.setJob((await h.pool.query(`SELECT job_id FROM api_idempotency WHERE idem_key = 'retry-me'`)).rows[0].job_id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE source = 'api'`);
    expect((await create({}, { 'idempotency-key': 'in-flight' })).status).toBe(202); // abandoned claim taken over
    for (const value of ['x'.repeat(101), 'has space']) {
      const res = await create({}, { 'idempotency-key': value });
      expect([res.status, res.body.error.code]).toEqual([400, 'invalid_request']);
    }
  });

  it('reports status, progress and download paths, and streams the files under their public names', async () => {
    const { body: { jobId } } = await create({});
    const queued = await budi.get(`/v1/tts/${jobId}`);
    expect(queued.body).toEqual({ jobId, status: 'queued', progress: { done: 0, total: 1 }, credits: 1, errorCode: null, createdAt: expect.any(String) });
    h.engine.setJob(jobId, { status: 'done', audio_seconds: 1.5 });
    const done = await budi.get(`/v1/tts/${jobId}`);
    expect(done.body).toMatchObject({
      status: 'done', progress: { done: 1, total: 1 },
      files: {
        mp3: `/v1/tts/${jobId}/files/final.mp3`, wav: `/v1/tts/${jobId}/files/final.wav`,
        srt: `/v1/tts/${jobId}/files/subtitles.srt`, vtt: `/v1/tts/${jobId}/files/subtitles.vtt`,
      },
    });
    const srt = await budi.get(`/v1/tts/${jobId}/files/subtitles.srt`).buffer(true).parse(binary);
    expect(srt.status).toBe(200);
    expect(srt.headers['content-type']).toBe('application/x-subrip');
    expect(srt.body.equals(h.engine.state.fileBytes)).toBe(true);
    expect(h.engine.state.calls.at(-1).path).toBe(`/v1/jobs/${jobId}/files/subs.srt`);
    expect((await budi.get(`/v1/tts/${jobId}/files/subs.srt`)).status).toBe(404);
  });

  it("reports a failure's engine code", async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'failed', error_code: 'synthesis_failed' });
    expect((await budi.get(`/v1/tts/${jobId}`)).body).toMatchObject({ status: 'failed', errorCode: 'synthesis_failed' });
  });

  it("never shows or touches another account's job", async () => {
    const { body: { jobId } } = await create({});
    const cici = h.api(await h.apiKey('cici'));
    for (const res of [await cici.get(`/v1/tts/${jobId}`), await cici.get(`/v1/tts/${jobId}/files/final.mp3`), await cici.del(`/v1/tts/${jobId}`)]) {
      expect([res.status, res.body.error.code]).toEqual([404, 'not_found']);
    }
    expect(h.engine.state.jobs.get(jobId).status).toBe('queued');
  });

  it('cancels a queued job with a refund, then deletes it on the second DELETE', async () => {
    const { body: { jobId } } = await create({});
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await chargesOf(jobId))[0].state).toBe('refunded');
    expect((await budi.get(`/v1/tts/${jobId}`)).body).toMatchObject({ status: 'canceled', credits: 0 });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await budi.get(`/v1/tts/${jobId}`)).status).toBe(404);
  });

  it('asks the engine to stop a running job and leaves its hold for the callback', async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'running' });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect(h.engine.state.jobs.get(jobId).cancel_requested).toBe(true);
    expect((await chargesOf(jobId))[0].state).toBe('held');
  });

  it('settles a finished job when it is deleted', async () => {
    const { body: { jobId } } = await create({});
    h.engine.setJob(jobId, { status: 'done' });
    expect((await budi.del(`/v1/tts/${jobId}`)).status).toBe(204);
    expect((await chargesOf(jobId))[0].state).toBe('settled');
    expect((await budi.get(`/v1/tts/${jobId}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/v1-jobs.test.js`
Expected: FAIL — `/v1/estimate` and `/v1/tts` answer 404 `not_found`.

- [ ] **Step 3: Implement**

Create `web/server/services/api-jobs.js`:
```js
import { ApiError } from '../lib/errors.js';

export const MAX_ACTIVE_API_JOBS = 2;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,100}$/;

/** Public file name → engine file name (the engine calls the subtitles subs.*). */
export const API_FILES = Object.freeze({
  'final.mp3': 'final.mp3', 'final.wav': 'final.wav', 'subtitles.srt': 'subs.srt', 'subtitles.vtt': 'subs.vtt',
});
const BY_ENGINE_NAME = Object.freeze({
  'final.mp3': ['mp3', 'final.mp3'], 'final.wav': ['wav', 'final.wav'], 'subs.srt': ['srt', 'subtitles.srt'], 'subs.vtt': ['vtt', 'subtitles.vtt'],
});

/** {mp3, wav, srt, vtt} download paths for the engine files that exist (newest revision); null while there are none. */
export function apiFiles(jobId, engineFiles) {
  const out = {};
  for (const name of Object.keys(engineFiles ?? {})) {
    const known = BY_ENGINE_NAME[name];
    if (known) out[known[0]] = `/v1/tts/${jobId}/files/${known[1]}`;
  }
  return Object.keys(out).length ? out : null;
}

export function toApiJob(row, view) {
  const files = apiFiles(row.id, view?.files);
  return {
    jobId: row.id,
    status: row.status,
    progress: view?.progress ?? null,
    credits: row.credits,
    errorCode: view?.error_code ?? null,
    ...(files ? { files } : {}),
    createdAt: row.created_at,
  };
}

export function readIdempotencyKey(raw) {
  if (raw === undefined) return null;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new ApiError('invalid_request', 'Idempotency-Key must be 1 to 100 visible ASCII characters');
  return raw;
}

export function createApiJobs(pool) {
  return {
    /**
     * Inserts the held charge of a new API job unless the account already has MAX_ACTIVE_API_JOBS queued or running.
     * Creates still waiting for the engine (held API charges without a job, under 2 minutes old) count too.
     * Serialized per account by a transaction-scoped lock, so racing creates cannot both pass.
     */
    async reserve(charges, charge) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lqtts_api_jobs:${charge.userId}`]);
        const { rows: [{ n }] } = await client.query(
          `SELECT (SELECT count(*) FROM jobs WHERE user_id = $1 AND source = 'api' AND deleted_at IS NULL AND status IN ('queued', 'running'))
                + (SELECT count(*) FROM charges WHERE user_id = $1 AND source = 'api' AND kind = 'job' AND job_id IS NULL
                     AND state = 'held' AND created_at > now() - interval '2 minutes') AS n`,
          [charge.userId],
        );
        if (Number(n) >= MAX_ACTIVE_API_JOBS) {
          throw new ApiError('too_many_jobs', `at most ${MAX_ACTIVE_API_JOBS} API voiceovers can be queued or running at once`);
        }
        const row = await charges.insertHeld({ ...charge, source: 'api' }, client);
        await client.query('COMMIT');
        return row;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // True when this request owns the key: new, older than 24 h, or a claim abandoned without a job for 2 minutes.
    async claimKey(userId, key) {
      const { rowCount } = await pool.query(
        `INSERT INTO api_idempotency (user_id, idem_key) VALUES ($1, $2)
         ON CONFLICT (user_id, idem_key) DO UPDATE SET job_id = NULL, created_at = now()
         WHERE api_idempotency.created_at < now() - interval '24 hours'
            OR (api_idempotency.job_id IS NULL AND api_idempotency.created_at < now() - interval '2 minutes')`,
        [userId, key],
      );
      return rowCount > 0;
    },
    async keyJob(userId, key) {
      const { rows: [row] } = await pool.query('SELECT job_id FROM api_idempotency WHERE user_id = $1 AND idem_key = $2', [userId, key]);
      return row?.job_id ?? null;
    },
    async bindKey(userId, key, jobId) {
      await pool.query('UPDATE api_idempotency SET job_id = $3 WHERE user_id = $1 AND idem_key = $2', [userId, key, jobId]);
    },
    async releaseKey(userId, key) {
      await pool.query('DELETE FROM api_idempotency WHERE user_id = $1 AND idem_key = $2 AND job_id IS NULL', [userId, key]);
    },
  };
}
```

Create `web/server/services/job-control.js` (the lease, cancel and delete code moved out of `routes/job-actions.js`, unchanged in behaviour):
```js
import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';

export const busy = () => new ApiError('not_regeneratable', 'a previous change on this job is still being settled; try again shortly');

/** Per-job lease, cancel and delete, shared by the web routes (routes/job-actions.js) and DELETE /v1/tts/:id. */
export function createJobControl({ pool, engine, charges, jobsRepo, log }) {
  // One regenerate or cancel per job at a time, as a lease row rather than a lock, so nothing pins a pooled
  // connection. The lease expires, so a crashed request cannot block the job for good.
  async function withLease(jobId, work) {
    const token = randomUUID();
    const { rowCount } = await pool.query(
      `UPDATE jobs SET regen_lease = $2, regen_until = now() + interval '60 seconds'
       WHERE id = $1 AND (regen_until IS NULL OR regen_until < now()) RETURNING id`,
      [jobId, token],
    );
    if (rowCount === 0) throw busy();
    try {
      return await work();
    } finally {
      // Matching the token: a request whose lease expired never clears its successor's.
      await pool.query('UPDATE jobs SET regen_lease = NULL, regen_until = NULL WHERE id = $1 AND regen_lease = $2', [jobId, token])
        .catch((err) => log.warn({ event: 'regen_lease_release_failed', jobId, err: err.message }, 'could not release regenerate lease'));
    }
  }

  async function engineView(jobId) {
    try {
      return await engine.getJob(jobId);
    } catch (err) {
      if (isEngineNotFound(err)) return null;
      throw engineError(err);
    }
  }

  // Shares the regenerate lease, so cancel never resolves charges before a regeneration records its revision.
  async function cancel(job) {
    await withLease(job.id, async () => {
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
    });
  }

  // Deleting stops queued/running work without a callback: settle what finished, refund the rest. `view` is the
  // engine's answer read just before (null: the engine no longer has the job).
  async function remove(job, view) {
    if (view) {
      try {
        await engine.deleteJob(job.id);
      } catch (err) {
        if (!isEngineNotFound(err)) throw engineError(err);
      }
    }
    await jobsRepo.markDeleted(job.id);
    let finalView = null;
    if (view) {
      const stopped = view.status === 'queued' || view.status === 'running';
      finalView = { status: stopped ? 'canceled' : view.status, revision: view.revision };
    }
    await charges.resolveJob(job.id, finalView);
  }

  return { withLease, engineView, cancel, remove };
}
```

Replace `web/server/routes/job-actions.js` with (regenerate body unchanged, cancel/delete delegate):
```js
import express from 'express';
import { ApiError } from '../lib/errors.js';
import { countChars, creditsFor } from '../lib/pricing.js';
import { engineError } from '../lib/upstream-errors.js';
import { busy } from '../services/job-control.js';
import { ownJob, parseIdx } from '../services/ownership.js';

export function jobActionsRouter(ctx) {
  const { config, engine, accounts, charges, jobsRepo, pool, jobControl } = ctx;
  const { withLease, engineView } = jobControl;
  const router = express.Router();

  router.post('/jobs/:id/sentences/:idx/regenerate', async (req, res) => {
    const userId = req.session.user_id;
    const job = await ownJob(ctx, userId, req.params.id);
    const idx = parseIdx(req.params.idx);
    const { text, style } = req.body ?? {};
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || countChars(text.trim()) > config.maxSentenceChars)) {
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
    // Serialized per job from the guard until the charge carries the engine's revision: two sentences passing the
    // guard together would leave the engine-rejected one held at the accepted one's revision.
    const accepted = await withLease(job.id, async () => {
      // Job-wide: decide() ignores sentence_idx, so a held charge for any sentence at a newer revision would be
      // judged by this regeneration's outcome.
      const { rowCount: held } = await pool.query(
        `SELECT 1 FROM charges WHERE job_id = $1 AND state = 'held' AND revision > $2 LIMIT 1`,
        [job.id, view.revision],
      );
      if (held > 0) throw busy();
      // Retries count up from the highest earlier attempt (the bare ref is attempt 1); rows can be deleted.
      const { rows: [prior] } = await pool.query(
        `SELECT max(CASE WHEN hold_id = $1 THEN 1 ELSE substring(hold_id FROM ':a([0-9]+)$')::int END) AS n
         FROM charges WHERE hold_id = $1 OR hold_id LIKE $2`,
        [base, `${base}:a%`],
      );
      const holdId = prior.n === null ? base : `${base}:a${prior.n + 1}`;
      const charge = await charges.insertHeld({ userId, jobId: job.id, revision, kind: 'regenerate', sentenceIdx: idx, chars, credits, holdId });
      if (!charge) throw busy();
      await charges.hold(charge);
      let out;
      try {
        out = await engine.regenerate(job.id, idx, { text: newText, style });
      } catch (err) {
        await charges.refundNow(charge);
        throw engineError(err);
      }
      if (out.revision !== revision) {
        // decide() must judge the revision that actually does the work.
        await pool.query(`UPDATE charges SET revision = $2 WHERE id = $1 AND state = 'held'`, [charge.id, out.revision]);
      }
      await jobsRepo.applyEngineState(job.id, { status: 'queued', revision: out.revision });
      return { revision: out.revision, credits };
    });
    // Answered after withLease's finally cleared the lease, so a cancel sent right after this 202 is not busy.
    res.status(202).json(accepted);
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    await jobControl.cancel(job);
    res.status(202).json({ status: 'cancel_requested' });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    await jobControl.remove(job, await engineView(job.id));
    res.status(204).end();
  });

  return router;
}
```

`web/server/services/ownership.js` — replace `usableVoice`:
```js
/**
 * A voice the user may preview and voice over with: their own, or an active VO Profile (library voice).
 * With `api`, a profile must also be allowed for the API (voice_profiles.api_allowed).
 */
export async function usableVoice(ctx, userId, voiceId, { api = false } = {}) {
  if (!isUuid(voiceId)) throw new ApiError('not_found', 'voice not found');
  let voice;
  try {
    voice = await ctx.engine.getVoice(voiceId.toLowerCase());
  } catch (err) {
    throw engineError(err);
  }
  if (voice.owner_ref === String(userId)) return voice;
  if (voice.owner_ref === LIBRARY_OWNER) {
    const profile = await ctx.profiles.get(voice.id);
    if (profile && (!api || profile.api_allowed)) return voice;
  }
  throw new ApiError('not_found', 'voice not found');
}
```

Replace `web/server/routes/v1.js` with the full router:
```js
import crypto from 'node:crypto';
import express from 'express';
import { requireApiKey } from '../http/api-auth.js';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { countSentences, creditsFor } from '../lib/pricing.js';
import { engineError, isEngineNotFound } from '../lib/upstream-errors.js';
import { API_FILES, readIdempotencyKey, toApiJob } from '../services/api-jobs.js';
import { ownJob, usableVoice } from '../services/ownership.js';
import { profilesWithVoices } from '../services/profiles.js';
import { queueVoiceover, readJobInput, readText } from '../services/voiceovers.js';
import { WebhookUrlError, resolveWebhookUrl } from '../services/webhook-security.js';

/** Public API (spec §2.2): Bearer keys only, JSON, errors {error:{code,message}}. Mounted at /v1 before any cookie code. */
export function v1Router(ctx) {
  const { config, engine, charges, jobsRepo, apiJobs, jobControl } = ctx;
  const router = express.Router();
  router.use(requireApiKey(ctx));
  router.use(express.json({ limit: '256kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/voices', async (req, res) => {
    let own;
    try {
      own = await engine.listVoices(req.apiUserId);
    } catch (err) {
      throw engineError(err);
    }
    const profiles = await profilesWithVoices(ctx);
    res.json({
      voices: [
        ...own.filter((v) => v.status === 'ready').map((v) => ({ id: v.id, name: v.name, language: v.language, kind: 'own' })),
        ...profiles.filter(({ row, voice }) => row.api_allowed && voice?.status === 'ready').map(({ row }) => ({
          id: row.voice_id, name: row.name, language: row.language, kind: 'profile',
          description: { id: row.description_id, en: row.description_en },
        })),
      ],
    });
  });

  router.post('/estimate', async (req, res) => {
    const { text, chars } = readText(req.body?.text, config.maxTextChars);
    res.json({ chars, credits: chars === 0 ? 0 : creditsFor(chars), sentences: countSentences(text) });
  });

  async function checkedWebhookUrl(raw) {
    if (raw === null) return null;
    try {
      return (await resolveWebhookUrl(raw, { allowLoopback: config.webhookAllowLoopback })).url;
    } catch (err) {
      if (err instanceof WebhookUrlError) throw new ApiError('invalid_webhook_url', err.message);
      throw err;
    }
  }

  router.post('/tts', async (req, res) => {
    const userId = req.apiUserId;
    const input = readJobInput(req.body, config.maxTextChars);
    const { formats, webhookUrl = null } = req.body;
    if (formats !== undefined && !Array.isArray(formats)) throw new ApiError('invalid_request', 'formats must be an array');
    if (webhookUrl !== null && typeof webhookUrl !== 'string') throw new ApiError('invalid_request', 'webhookUrl must be a string');
    const settings = formats === undefined ? input.settings : { ...input.settings, formats };
    const idemKey = readIdempotencyKey(req.get('idempotency-key'));
    if (idemKey && !(await apiJobs.claimKey(userId, idemKey))) {
      const prior = await apiJobs.keyJob(userId, idemKey);
      if (!prior) throw new ApiError('idempotency_conflict', 'a request with this Idempotency-Key is still being processed');
      const job = await ownJob(ctx, userId, prior);
      res.status(202).set('Idempotent-Replayed', 'true').json({ jobId: job.id, credits: job.credits, status: job.status });
      return;
    }
    try {
      const voice = await usableVoice(ctx, userId, input.voiceId, { api: true });
      if (voice.status !== 'ready') throw new ApiError('voice_not_ready', `voice is ${voice.status}`);
      const webhook = await checkedWebhookUrl(webhookUrl);
      const credits = creditsFor(input.chars);
      const key = crypto.randomUUID();
      const charge = await apiJobs.reserve(charges, { userId, revision: 1, kind: 'job', chars: input.chars, credits, holdId: `tts:${key}:r1` });
      let created;
      try {
        created = await queueVoiceover(ctx, {
          charge, key, userId, voice, text: input.text, chars: input.chars, settings,
          source: 'api', apiKeyId: req.apiKey.id, webhookUrl: webhook,
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'insufficient_credits') {
          throw new ApiError(err.code, err.message, { details: { ...err.details, topupUrl: config.topupUrl } });
        }
        throw err;
      }
      if (idemKey) await apiJobs.bindKey(userId, idemKey, created.id);
      res.status(202).json({ jobId: created.id, credits, status: 'queued' });
    } catch (err) {
      if (idemKey) await apiJobs.releaseKey(userId, idemKey).catch(() => {});
      throw err;
    }
  });

  router.get('/tts/:id', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
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
    res.json(toApiJob(await jobsRepo.own(req.apiUserId, job.id), view));
  });

  router.get('/tts/:id/files/:name', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
    const engineName = Object.hasOwn(API_FILES, req.params.name) ? API_FILES[req.params.name] : null;
    if (!engineName) throw new ApiError('not_found', 'unknown file; use final.mp3, final.wav, subtitles.srt or subtitles.vtt');
    await relayEngine(ctx, req, res, `/v1/jobs/${job.id}/files/${engineName}`);
  });

  // Cancels queued or running work (refund rules of the web cancel); anything else is deleted.
  router.delete('/tts/:id', async (req, res) => {
    const job = await ownJob(ctx, req.apiUserId, req.params.id);
    const view = await jobControl.engineView(job.id);
    if (view && (view.status === 'queued' || view.status === 'running')) await jobControl.cancel(job);
    else await jobControl.remove(job, view);
    res.status(204).end();
  });

  router.use(() => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  return router;
}
```

`web/server/context.js` — import `createApiJobs` from `./services/api-jobs.js` and `createJobControl` from `./services/job-control.js`; after `ctx.charges = createCharges(ctx);` add:
```js
  ctx.jobControl = createJobControl(ctx);
  ctx.apiJobs = createApiJobs(pool);
```

- [ ] **Step 4: Run the test to verify it passes, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/v1-jobs.test.js && npx vitest run`
Expected: PASS (15 tests in the new file); suite green, including the unchanged `job-actions.test.js` (cancel, delete and lease tests now run through `services/job-control.js`).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/api-jobs.js web/server/services/job-control.js web/server/routes/job-actions.js \
  web/server/routes/v1.js web/server/services/ownership.js web/server/context.js web/server/test/v1-jobs.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: /v1 estimate, idempotent capped create, status, files and cancel/delete"
```

---
### Task 8: Webhook outbox, signed delivery with retries, callback and reconciler hooks

**Files:**
- Create: `web/server/services/webhooks.js`
- Modify: `web/server/routes/callback.js` (:17-55), `web/server/services/reconcile.js` (:6, :23-49), `web/server/routes/api-keys.js` (GET), `web/server/context.js`, `web/server/index.js`
- Test: `web/server/test/webhooks.test.js`

**Interfaces:**
- Consumes: Task 2 table `webhook_deliveries`; Task 3 `apiKeys.webhookSecret(row)`, `apiKeys.create`, `apiKeys.revoke`; Task 6 `resolveWebhookUrl`, `WebhookUrlError`, `signWebhook`; Task 7 `apiFiles`; `jobsRepo.get/own`, `engine.getJob`.
- Produces:
  - `ATTEMPT_DELAYS_S = [0, 60, 300, 1800]`, `DELIVERY_TIMEOUT_MS = 10000`, `MIN_RETRY_GAP_S = 30`.
  - `createWebhooks(ctx, { timeoutMs = DELIVERY_TIMEOUT_MS, lookup }?) -> { onTerminal(jobId, {status, revision}) -> boolean, runOnce() -> Promise<{handled}>, kick(), start({intervalMs = 5000}?), stop(), listForUser(userId) -> Delivery[] }`. `runOnce()` always returns a pass that starts after the call (passes are serialized). `ctx.webhooks`.
  - Delivery request: `POST <webhookUrl>`, body = the stored JSON `{event, jobId, status, credits, errorCode? (failed), files? (done), createdAt}`, headers `Content-Type: application/json`, `User-Agent: LQ-TTS-Webhooks/1`, `LQTTS-Event`, `LQTTS-Delivery: <id>`, `LQTTS-Signature: t=<unix>,v1=<hex>`; 10 s timeout; redirects not followed; connection pinned to the address `resolveWebhookUrl` checked.
  - `GET /api/keys` → `{ keys, deliveries: [{id, keyId, keyName, jobId, event, state, attempts, lastStatus, createdAt, finishedAt}] }` (last 20 per active key, newest first).
  - Log events: `webhook_dropped` (warn), `webhook_enqueue_failed` (warn), `webhooks_failed` (error).

- [ ] **Step 1: Write the failing test**

Create `web/server/test/webhooks.test.js`:
```js
import crypto from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReconciler } from '../services/reconcile.js';
import { createWebhooks } from '../services/webhooks.js';
import { USERS, signCallback, startHarness } from './helpers.js';

// A local HTTP receiver; `answer(req)` returns [status, body, headers] or null to never answer.
async function startReceiver() {
  const hits = [];
  let answer = () => [200, 'ok', {}];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    hits.push({ path: req.url, headers: req.headers, body });
    const out = answer(req);
    if (!out) return; // hang
    res.writeHead(out[0], out[2] ?? {});
    res.end(out[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/hook`,
    base,
    hits,
    answer(fn) {
      answer = fn;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

describe('webhooks', () => {
  let h;
  let made;
  let budi;
  let voice;
  let receiver;
  let hooks;
  beforeAll(async () => {
    h = await startHarness({ env: { WEBHOOK_ALLOW_LOOPBACK: 'true' } });
    await h.ctx.webhooks.stop(); // no background passes: each test runs `hooks` itself
    hooks = createWebhooks(h.ctx, { timeoutMs: 500 });
    made = await h.ctx.apiKeys.create('budi', { name: 'hooks', tv: 0 });
    budi = h.api(made.key);
    voice = h.engine.addVoice({ owner_ref: 'budi' });
    receiver = await startReceiver();
  });
  afterAll(async () => {
    await receiver.close();
    await h.close();
  });
  beforeEach(async () => {
    h.ctx.apiLimiter.reset();
    receiver.answer(() => [200, 'ok', {}]);
    receiver.hits.length = 0;
    for (const j of h.engine.state.jobs.values()) if (j.status === 'queued' || j.status === 'running') h.engine.setJob(j.id, { status: 'done' });
    await h.pool.query(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')`);
  });
  const apiJob = async (client = budi, webhookUrl = receiver.url) => {
    const res = await client.post('/v1/tts', { voiceId: voice.id, text: 'Halo dunia.', ...(webhookUrl ? { webhookUrl } : {}) });
    expect(res.status).toBe(202);
    return res.body.jobId;
  };
  const callback = (payload) => {
    const { body, headers } = signCallback(payload);
    return request(h.app).post('/api/internal/engine-callback').set(headers).send(body);
  };
  const delivery = async (jobId) => (await h.pool.query('SELECT * FROM webhook_deliveries WHERE job_id = $1', [jobId])).rows[0];
  const makeDue = (jobId) => h.pool.query('UPDATE webhook_deliveries SET next_attempt_at = now() WHERE job_id = $1', [jobId]);
  const verify = (hit, secret) => {
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['lqtts-signature']);
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(60);
    expect(crypto.createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex')).toBe(v1);
  };

  it('sends one signed job.done to the webhookUrl and lists it on the API page', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200);
    expect((await callback({ job_id: jobId, status: 'done', revision: 1 })).status).toBe(200); // repeated callback
    await hooks.runOnce();
    expect(receiver.hits).toHaveLength(1);
    const [hit] = receiver.hits;
    expect(hit.path).toBe('/hook');
    expect(hit.headers).toMatchObject({ 'content-type': 'application/json', 'lqtts-event': 'job.done', 'user-agent': 'LQ-TTS-Webhooks/1' });
    verify(hit, made.webhookSecret);
    expect(JSON.parse(hit.body)).toEqual({
      event: 'job.done', jobId, status: 'done', credits: 1,
      files: {
        mp3: `/v1/tts/${jobId}/files/final.mp3`, wav: `/v1/tts/${jobId}/files/final.wav`,
        srt: `/v1/tts/${jobId}/files/subtitles.srt`, vtt: `/v1/tts/${jobId}/files/subtitles.vtt`,
      },
      createdAt: expect.any(String),
    });
    expect(await delivery(jobId)).toMatchObject({ state: 'delivered', attempts: 1, last_status: 200, event: 'job.done' });
    expect(hit.headers['lqtts-delivery']).toBe(String((await delivery(jobId)).id));
    const page = await h.as(await h.login(USERS.budi)).get('/api/keys');
    expect(page.body.deliveries).toContainEqual({
      id: expect.any(String), keyId: made.row.id, keyName: 'hooks', jobId, event: 'job.done', state: 'delivered',
      attempts: 1, lastStatus: 200, createdAt: expect.any(String), finishedAt: expect.any(String),
    });
  });

  it('sends job.failed with the engine code and zero credits after the refund', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'failed', error_code: 'synthesis_failed' });
    await callback({ job_id: jobId, status: 'failed', revision: 1 });
    await hooks.runOnce();
    expect(JSON.parse(receiver.hits[0].body)).toEqual({
      event: 'job.failed', jobId, status: 'failed', credits: 0, errorCode: 'synthesis_failed', createdAt: expect.any(String),
    });
  });

  it('records nothing for web jobs, API jobs without a webhookUrl, cancellations and later revisions', async () => {
    const web = h.as(await h.login(USERS.budi));
    const webJob = (await web.post('/api/jobs', { voiceId: voice.id, text: 'Halo.' })).body.id;
    const silent = await apiJob(budi, null);
    const canceled = await apiJob();
    for (const [jobId, status] of [[webJob, 'done'], [silent, 'done'], [canceled, 'canceled']]) {
      h.engine.setJob(jobId, { status });
      await callback({ job_id: jobId, status, revision: 1 });
      expect(await delivery(jobId)).toBeUndefined();
    }
    expect(await h.ctx.webhooks.onTerminal(canceled, { status: 'done', revision: 2 })).toBe(false);
    expect(await delivery(canceled)).toBeUndefined();
  });

  it('retries at 1, 5 and 30 minutes, then drops the delivery', async () => {
    receiver.answer(() => [500, 'no', {}]);
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    const first = await delivery(jobId);
    expect(first).toMatchObject({ state: 'pending', attempts: 1, last_status: 500 });
    const gap = (new Date(first.next_attempt_at) - new Date(first.created_at)) / 1000;
    expect(gap).toBeGreaterThanOrEqual(59);
    expect(gap).toBeLessThan(62);
    await hooks.runOnce();
    expect((await delivery(jobId)).attempts).toBe(1); // not due yet
    for (const attempts of [2, 3]) {
      await makeDue(jobId);
      await hooks.runOnce();
      expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts });
    }
    await makeDue(jobId);
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'dropped', attempts: 4, last_status: 500 });
    expect(receiver.hits).toHaveLength(4);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'webhook_dropped', jobId, attempts: 4 }));
  });

  it('never follows a redirect and counts it as a failure', async () => {
    receiver.answer((req) => (req.url === '/hook' ? [302, '', { location: `${receiver.base}/elsewhere` }] : [200, 'ok', {}]));
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    expect(receiver.hits.map((x) => x.path)).toEqual(['/hook']);
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_status: 302 });
  });

  it('gives up on a receiver that does not answer in time', async () => {
    receiver.answer(() => null);
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'pending', attempts: 1, last_status: null, last_error: 'timeout' });
  });

  it('checks the address again at send time and refuses a non-public one', async () => {
    const jobId = crypto.randomUUID();
    await h.pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body) VALUES ($1, 'budi', $2, 'job.done', 'https://10.0.0.1/hook', '{}')`,
      [made.row.id, jobId],
    );
    await hooks.runOnce();
    const row = await delivery(jobId);
    expect(row).toMatchObject({ state: 'pending', attempts: 1, last_status: null });
    expect(row.last_error).toMatch(/^blocked: /);
    expect(receiver.hits).toHaveLength(0);
  });

  it("drops a revoked key's deliveries without sending", async () => {
    const other = await h.ctx.apiKeys.create('budi', { name: 'short-lived', tv: 0 });
    const jobId = await apiJob(h.api(other.key));
    h.engine.setJob(jobId, { status: 'done' });
    await callback({ job_id: jobId, status: 'done', revision: 1 });
    await h.ctx.apiKeys.revoke('budi', other.row.id);
    await hooks.runOnce();
    expect(await delivery(jobId)).toMatchObject({ state: 'dropped', last_error: 'key_revoked' });
    expect(receiver.hits).toHaveLength(0);
  });

  it('is recorded by the reconciler when the engine callback was lost', async () => {
    const jobId = await apiJob();
    h.engine.setJob(jobId, { status: 'done' });
    await h.pool.query(`UPDATE charges SET created_at = now() - interval '3 minutes' WHERE job_id = $1`, [jobId]);
    await createReconciler(h.ctx).runOnce();
    expect(await delivery(jobId)).toMatchObject({ event: 'job.done', state: 'pending' });
    await hooks.runOnce();
    expect(JSON.parse(receiver.hits[0].body)).toMatchObject({ event: 'job.done', jobId, credits: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/webhooks.test.js`
Expected: FAIL — `Cannot find module '../services/webhooks.js'`.

- [ ] **Step 3: Implement**

Create `web/server/services/webhooks.js`:
```js
import { Agent, request } from 'undici';
import { apiFiles } from './api-jobs.js';
import { WebhookUrlError, resolveWebhookUrl, signWebhook } from './webhook-security.js';

export const ATTEMPT_DELAYS_S = Object.freeze([0, 60, 300, 1800]); // after the event; the 4th failure drops it
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MIN_RETRY_GAP_S = 30; // after downtime, retries still never come back to back
const EVENTS = Object.freeze({ done: 'job.done', failed: 'job.failed' });
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_ABORTED']);

export const toDelivery = (r) => ({
  id: String(r.id), keyId: r.api_key_id, keyName: r.key_name, jobId: r.job_id, event: r.event, state: r.state,
  attempts: r.attempts, lastStatus: r.last_status, createdAt: r.created_at, finishedAt: r.finished_at,
});

export function createWebhooks(ctx, { timeoutMs = DELIVERY_TIMEOUT_MS, lookup } = {}) {
  const { pool, engine, jobsRepo, apiKeys, config, log } = ctx;

  /**
   * Records the webhook of an API job's first render reaching done or failed, at most once per job. The body is
   * frozen now: credits after settle/refund, files or errorCode from the engine when it answers.
   */
  async function onTerminal(jobId, { status, revision }) {
    if (revision !== 1 || !EVENTS[status]) return false;
    const job = await jobsRepo.get(jobId);
    if (!job || job.source !== 'api' || !job.webhook_url || !job.api_key_id) return false;
    let view = null;
    try {
      view = await engine.getJob(jobId);
    } catch {
      // the event, status and credits are enough
    }
    const row = await jobsRepo.own(job.user_id, jobId);
    const body = JSON.stringify({
      event: EVENTS[status],
      jobId,
      status,
      credits: row?.credits ?? 0,
      ...(status === 'failed' ? { errorCode: view?.error_code ?? null } : {}),
      ...(status === 'done' && view ? { files: apiFiles(jobId, view.files) ?? {} } : {}),
      createdAt: job.created_at,
    });
    const { rowCount } = await pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (job_id) DO NOTHING`,
      [job.api_key_id, job.user_id, jobId, EVENTS[status], job.webhook_url, body],
    );
    if (rowCount > 0) kick();
    return rowCount > 0;
  }

  async function claimDue(limit = 20) {
    const { rows } = await pool.query(
      `UPDATE webhook_deliveries d SET sending_until = now() + make_interval(secs => $2::double precision / 1000)
       FROM api_keys k
       WHERE k.id = d.api_key_id
         AND d.id IN (SELECT id FROM webhook_deliveries
                      WHERE state = 'pending' AND next_attempt_at <= now() AND (sending_until IS NULL OR sending_until < now())
                      ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING d.*, k.revoked_at AS key_revoked_at, k.webhook_secret_enc`,
      [limit, timeoutMs + 20_000],
    );
    return rows;
  }

  // Resolves and checks the URL again, then POSTs to exactly the checked address. Never follows redirects.
  async function send(row) {
    let target;
    try {
      target = await resolveWebhookUrl(row.url, { allowLoopback: config.webhookAllowLoopback, ...(lookup ? { lookup } : {}) });
    } catch (err) {
      return { error: err instanceof WebhookUrlError ? `blocked: ${err.message}` : 'resolve_failed' };
    }
    const secret = apiKeys.webhookSecret({ id: row.api_key_id, webhook_secret_enc: row.webhook_secret_enc });
    const pinned = (hostname, options, callback) => (options?.all
      ? callback(null, [{ address: target.address, family: target.family }])
      : callback(null, target.address, target.family));
    const agent = new Agent({ connect: { timeout: timeoutMs, lookup: pinned }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    try {
      const res = await request(target.url, {
        method: 'POST',
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
        body: row.body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LQ-TTS-Webhooks/1',
          'lqtts-event': row.event,
          'lqtts-delivery': String(row.id),
          'lqtts-signature': signWebhook(secret, row.body),
        },
      });
      await res.body.dump().catch(() => {});
      return { status: res.statusCode, delivered: res.statusCode >= 200 && res.statusCode < 300 };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || TIMEOUT_CODES.has(err?.code);
      return { error: timedOut ? 'timeout' : String(err?.code ?? 'connect_failed') };
    } finally {
      agent.destroy().catch(() => {});
    }
  }

  async function record(row, outcome) {
    if (outcome.delivered) {
      await pool.query(
        `UPDATE webhook_deliveries SET state = 'delivered', attempts = attempts + 1, last_status = $2, last_error = NULL,
           finished_at = now(), sending_until = NULL WHERE id = $1`,
        [row.id, outcome.status],
      );
      return;
    }
    const attempts = row.attempts + 1;
    const final = Boolean(outcome.drop) || attempts >= ATTEMPT_DELAYS_S.length;
    await pool.query(
      `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, sending_until = NULL,
         state = CASE WHEN $5::boolean THEN 'dropped' ELSE 'pending' END,
         finished_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
         next_attempt_at = CASE WHEN $5::boolean THEN next_attempt_at
           ELSE greatest(created_at + make_interval(secs => $6::double precision), now() + make_interval(secs => $7::double precision)) END
       WHERE id = $1`,
      [row.id, attempts, outcome.status ?? null, outcome.error ?? null, final, final ? 0 : ATTEMPT_DELAYS_S[attempts], MIN_RETRY_GAP_S],
    );
    if (final) {
      log.warn({ event: 'webhook_dropped', deliveryId: String(row.id), jobId: row.job_id, attempts, error: outcome.error ?? `HTTP ${outcome.status}` }, 'webhook delivery dropped');
    }
  }

  let stopped = false;
  async function pass() {
    let handled = 0;
    while (!stopped) {
      const rows = await claimDue();
      if (!rows.length) break;
      for (const row of rows) {
        handled += 1;
        await record(row, row.key_revoked_at ? { drop: true, error: 'key_revoked' } : await send(row));
      }
    }
    return { handled };
  }

  // Passes run one at a time; every caller gets a pass that starts after its call.
  let chain = Promise.resolve();
  let waiting = null;
  function runOnce() {
    if (waiting) return waiting;
    const next = chain.then(() => {
      waiting = null;
      return pass();
    });
    waiting = next;
    chain = next.catch(() => {});
    return next;
  }
  const safeRun = () => runOnce().catch((err) =>
    log.error({ event: 'webhooks_failed', error: String(err?.stack ?? err) }, 'webhook pass failed'));
  function kick() {
    if (!stopped) safeRun();
  }

  let timer = null;
  return {
    onTerminal,
    runOnce,
    kick,
    start({ intervalMs = 5000 } = {}) {
      stopped = false;
      timer = setInterval(safeRun, intervalMs);
      timer.unref();
      safeRun();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      await chain;
    },
    // The last 20 deliveries of each of the user's active keys, newest first.
    async listForUser(userId) {
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT d.*, k.name AS key_name,
                  row_number() OVER (PARTITION BY d.api_key_id ORDER BY d.created_at DESC, d.id DESC) AS rn
           FROM webhook_deliveries d JOIN api_keys k ON k.id = d.api_key_id
           WHERE k.user_id = $1 AND k.revoked_at IS NULL) x
         WHERE rn <= 20 ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return rows.map(toDelivery);
    },
  };
}
```
Note `stop()` sets `stopped`, so a test's own `createWebhooks` instance keeps running while the context's instance is stopped; `pass()` of a stopped instance does nothing.

`web/server/routes/callback.js` — take `webhooks` from the context and record the event after the charges are resolved (the callback answer does not depend on it):
```js
  const { config, engine, jobsRepo, charges, webhooks, log } = ctx;
```
```js
    await jobsRepo.applyEngineState(jobId, { status, revision, audioSeconds });
    const ok = await charges.resolveJob(jobId, { status, revision }, { maxRevision: revision });
    await webhooks.onTerminal(jobId, { status, revision }).catch((err) =>
      log.warn({ event: 'webhook_enqueue_failed', jobId, error: String(err?.message ?? err) }, 'could not record the webhook'));
    res.status(ok ? 200 : 503).json({ ok });
```

`web/server/services/reconcile.js` — destructure `webhooks` too (`export function createReconciler({ pool, engine, charges, jobsRepo, webhooks, log }, ...)`) and, at the end of `pass()` before the `if (checked) log.info(...)` line:
```js
    // A lost engine callback also lost its webhook: record it once the charges above are resolved.
    for (const [jobId, out] of seen) {
      if (out.view && (out.view.status === 'done' || out.view.status === 'failed')) {
        await webhooks.onTerminal(jobId, out.view).catch((err) =>
          log.warn({ event: 'webhook_enqueue_failed', jobId, error: String(err?.message ?? err) }, 'could not record the webhook'));
      }
    }
```

`web/server/routes/api-keys.js` — the list carries the deliveries:
```js
  const { accounts, apiKeys, webhooks } = ctx;
```
```js
  router.get('/keys', async (req, res) => {
    const userId = req.session.user_id;
    const [keys, deliveries] = await Promise.all([apiKeys.list(userId), webhooks.listForUser(userId)]);
    res.set('Cache-Control', 'no-store').json({ keys: keys.map(toApiKey), deliveries });
  });
```
and in `web/server/test/api-keys.test.js` the one exact list assertion becomes:
```js
    expect(list.body).toEqual({ keys: [{ id: res.body.id, name: 'Zapier', prefix: res.body.prefix, createdAt: res.body.createdAt, lastUsedAt: null }], deliveries: [] });
```

`web/server/context.js` — import `createWebhooks` from `./services/webhooks.js` and add as the last line before `return ctx;`:
```js
  ctx.webhooks = createWebhooks(ctx);
```

`web/server/index.js` — start the worker after the reconciler and stop it during shutdown, before the pool closes:
```js
const reconciler = createReconciler(ctx, { intervalMs: config.reconcileIntervalMs });
reconciler.start();
ctx.webhooks.start();
```
```js
  await reconciler.stop();
  await ctx.webhooks.stop();
  await pool.end();
```

- [ ] **Step 4: Run the test to verify it passes, then the web suite**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/webhooks.test.js && npx vitest run`
Expected: PASS (9 tests in the new file); suite green, including `shutdown.test.js` (the real entrypoint now also starts and drains the webhook worker) and `api-keys.test.js`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/services/webhooks.js web/server/routes/callback.js web/server/services/reconcile.js \
  web/server/routes/api-keys.js web/server/context.js web/server/index.js \
  web/server/test/webhooks.test.js web/server/test/api-keys.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: signed webhook outbox with pinned delivery, retries at 1/5/30 min, deliveries on /api/keys"
```

---

### Task 9: Admin CLI `--api-allowed`

**Files:**
- Modify: `web/server/cli/profile-add.js` (header comment :1-8, `USAGE` :25, `parseCliArgs` :45-62, `listProfiles` :195-201, `runProfileAdd` :203-217)
- Test: `web/server/test/profile-add.test.js`

**Interfaces:**
- Consumes: Task 5 `profiles.setApiAllowed(slug, allowed)`.
- Produces: `node server/cli/profile-add.js --api-allowed <true|false> --slug <slug>` → prints `profile <slug> api allowed` / `profile <slug> api not allowed`, exit 0; unknown slug → `error: profile <slug> not found`, exit 1. `--list` lines end in ` api` for API-allowed profiles. Release runs it only on lqmnah's word (Pandji stays false).

- [ ] **Step 1: Write the failing tests**

In `web/server/test/profile-add.test.js`, add rows to the `it.each` table of `refuses %j before any upload`:
```js
    [['--api-allowed', 'yes', '--slug', 'x'], /^error: --api-allowed must be true or false$/],
    [['--api-allowed', 'true'], /^error: --slug is required with --api-allowed$/],
    [['--slug', 'x', '--list'], /^error: usage: profile-add\.js/],
    [['--api-allowed', 'true', '--slug', 'x', '--filename', 'a.mp3'], /^error: usage: profile-add\.js/],
```
and append inside `describe('profile-add CLI', ...)`, before `it('never printed a secret in any run above', ...)`:
```js
  it('allows and disallows a profile for the API by slug, keeps the flag on replace, and lists it', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'api-flag' }), '--filename', 'a.wav']);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(false);
    const on = await run(['--api-allowed', 'true', '--slug', 'api-flag']);
    expect(on).toMatchObject({ code: 0, lines: ['profile api-flag api allowed'], errors: [] });
    expect((await run(['--list'])).lines).toContain(`profile api-flag voice ${id} ready api`);
    const replaced = await run(['--meta', writeMeta({ slug: 'api-flag' }), '--filename', 'a.wav']);
    expect(replaced.code).toBe(0);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(true);
    const off = await run(['--api-allowed', 'false', '--slug', 'api-flag']);
    expect(off.lines).toEqual(['profile api-flag api not allowed']);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(false);
    const unknown = await run(['--api-allowed', 'true', '--slug', 'nobody']);
    expect(unknown).toMatchObject({ code: 1, errors: ['error: profile nobody not found'] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/profile-add.test.js`
Expected: FAIL — `Unknown option '--api-allowed'`.

- [ ] **Step 3: Implement**

`web/server/cli/profile-add.js`:
- Header comment, after the `deactivate:` line:
```js
//   API access:     docker exec <container> node server/cli/profile-add.js --api-allowed true|false --slug pandji
//                   (only when the voice owner has agreed to API use; replacing a profile keeps the flag)
```
- `USAGE`:
```js
export const USAGE = 'usage: profile-add.js --meta <file.json> --filename <name.mp3|.wav|.m4a|.flac> < audio | --deactivate <slug> | --api-allowed <true|false> --slug <slug> | --list';
```
- `parseCliArgs`:
```js
function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      meta: { type: 'string' }, filename: { type: 'string' }, deactivate: { type: 'string' }, 'grace-seconds': { type: 'string' },
      list: { type: 'boolean' }, 'api-allowed': { type: 'string' }, slug: { type: 'string' },
    },
    allowPositionals: true,
  });
  const modes = [values.meta !== undefined, values.deactivate !== undefined, values.list === true, values['api-allowed'] !== undefined]
    .filter(Boolean).length;
  if (positionals.length || modes !== 1) throw new Error(USAGE);
  if (values['api-allowed'] !== undefined) {
    if (values.filename !== undefined || values['grace-seconds'] !== undefined) throw new Error(USAGE);
    if (values['api-allowed'] !== 'true' && values['api-allowed'] !== 'false') throw new Error('--api-allowed must be true or false');
    if (!values.slug) throw new Error('--slug is required with --api-allowed');
    return { ...values, apiAllowed: values['api-allowed'] === 'true' };
  }
  if (values.slug !== undefined) throw new Error(USAGE);
  if (values.meta === undefined) {
    if (values.filename !== undefined || values['grace-seconds'] !== undefined) throw new Error(USAGE);
    return values;
  }
  if (!values.filename) throw new Error('--filename is required with --meta');
  if (!AUDIO_TYPES[path.extname(values.filename).toLowerCase()]) throw new Error('--filename must end in .mp3, .wav, .m4a or .flac');
  const grace = values['grace-seconds'] ?? String(GRACE_SECONDS);
  if (!/^\d+$/.test(grace)) throw new Error('--grace-seconds must be a whole number of seconds');
  return { ...values, graceMs: Number(grace) * 1000 };
}
```
- New function after `deactivate`:
```js
async function setApiAllowed({ profiles }, slug, allowed, out) {
  if (!(await profiles.setApiAllowed(slug, allowed))) throw new Error(`profile ${slug} not found`);
  out(`profile ${slug} api ${allowed ? 'allowed' : 'not allowed'}`);
  return 0;
}
```
- `listProfiles` line:
```js
  rows.forEach((row, i) => out(`profile ${row.slug} voice ${row.voice_id} ${states[i]}${row.api_allowed ? ' api' : ''}`));
```
- `runProfileAdd`, after the `--deactivate` branch:
```js
    if (args.apiAllowed !== undefined) return await setApiAllowed(ctx, args.slug, args.apiAllowed, out);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-api/web && npx vitest run server/test/profile-add.test.js`
Expected: PASS (+4 table rows, +1 test; `never printed a secret` still passes).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/server/cli/profile-add.js web/server/test/profile-add.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: profile-add --api-allowed true|false --slug, list shows API access"
```

---
### Task 10: Client API page, navigation and History "API" chip

**Before editing:** load the SOP G4 skills listed in Global Constraints (all four, Operate mode, `craft-floor.md` right before the first UI edit).

**Files:**
- Create: `web/client/src/pages/ApiPage.jsx`, `web/client/src/pages/ApiPage.test.jsx`
- Modify: `web/client/src/lib/api.js` (`api` object), `web/client/src/lib/types.js`, `web/client/src/router.jsx`, `web/client/src/components/AppShell.jsx` (+ `AppShell.test.jsx`), `web/client/src/pages/HistoryPage.jsx` (+ `HistoryPage.test.jsx`), `web/client/src/i18n/id.js`, `web/client/src/i18n/en.js`, `web/client/src/i18n/i18n.test.js`

**Interfaces:**
- Consumes: Task 3/8 browser routes `GET /api/keys` → `{keys, deliveries}`, `POST /api/keys {name}` → `NewApiKey`, `DELETE /api/keys/:id`; `me.paid`, `me.topupUrl` from `/api/me`; Task 4 `JobSummary.source`.
- Produces: in-app route `/api-keys` (inside the shell), nav item "API"; `api.apiKeys()`, `api.createApiKey(name)`, `api.revokeApiKey(id)`; test ids `api-upgrade`, `api-key-row` (`data-key-id`), `api-key-confirm`, `new-key-panel`, `new-key-value`, `new-webhook-secret`, `delivery-row` (`data-state`), `api-chip`. Task 11 adds `/developers`; the page links to it.

- [ ] **Step 1: Write the failing tests**

Create `web/client/src/pages/ApiPage.test.jsx`:
```jsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.js';
import { ME, renderRoutes } from '../test/render.jsx';
import ApiPage from './ApiPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { apiKeys: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [
  { path: '/api-keys', element: <ApiPage /> },
  { path: '/developers', element: <p>docs page</p> },
  { path: '/jobs/:id', element: <p>job page</p> },
];
const PRO = { ...ME, plan: 'pro', paid: true };
const KEY = { id: 'k1', name: 'Zapier', prefix: 'lqtts_abcdefghijkl_…', createdAt: '2026-10-04T08:00:00Z', lastUsedAt: null };
const FULL_KEY = `lqtts_abcdefghijkl_${'a'.repeat(52)}`;
const SECRET = `whsec_${'b'.repeat(52)}`;

beforeEach(() => vi.clearAllMocks());

describe('ApiPage', () => {
  it('shows a free account the upgrade notice and loads no keys', async () => {
    renderRoutes(routes, { path: '/api-keys' });
    expect(screen.getByRole('heading', { level: 1, name: 'API' })).toBeInTheDocument();
    expect(screen.getByTestId('api-upgrade')).toHaveTextContent('Pro, Ultra dan Sultan');
    expect(screen.getByRole('link', { name: 'Upgrade paket' })).toHaveAttribute('href', ME.topupUrl);
    expect(screen.getByRole('link', { name: 'Dokumentasi API' })).toHaveAttribute('href', '/developers');
    expect(api.apiKeys).not.toHaveBeenCalled();
  });

  it('shows a Pro account the empty state, then the error with a retry', async () => {
    api.apiKeys.mockRejectedValueOnce(new ApiError(0, 'network', 'down')).mockResolvedValueOnce({ keys: [], deliveries: [] });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.click(await screen.findByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByText('Belum ada kunci API')).toBeInTheDocument();
    expect(screen.getByText('Belum ada webhook yang dikirim.')).toBeInTheDocument();
  });

  it('creates a key and shows the full key and the webhook secret once', async () => {
    api.apiKeys.mockResolvedValue({ keys: [], deliveries: [] });
    api.createApiKey.mockResolvedValue({ ...KEY, key: FULL_KEY, webhookSecret: SECRET });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.click(await screen.findByRole('button', { name: 'Buat kunci' }));
    expect(screen.getByText('Beri nama kunci ini dulu.')).toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Nama kunci'), '  Zapier ');
    await user.click(screen.getByRole('button', { name: 'Buat kunci' }));
    expect(api.createApiKey).toHaveBeenCalledWith('Zapier');
    const panel = await screen.findByTestId('new-key-panel');
    expect(panel).toHaveFocus();
    expect(within(panel).getByTestId('new-key-value')).toHaveTextContent(FULL_KEY);
    expect(within(panel).getByTestId('new-webhook-secret')).toHaveTextContent(SECRET);
    const copyKey = within(panel).getByRole('button', { name: 'Salin Kunci API' });
    await user.click(copyKey);
    expect(await navigator.clipboard.readText()).toBe(FULL_KEY);
    expect(copyKey).toHaveTextContent('Tersalin');
    expect(screen.getAllByTestId('api-key-row')).toHaveLength(1);
    expect(screen.getByLabelText('Nama kunci')).toHaveValue('');
    await user.click(within(panel).getByRole('button', { name: 'Sudah saya simpan' }));
    expect(screen.queryByTestId('new-key-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(FULL_KEY)).not.toBeInTheDocument();
  });

  it('shows why a create failed', async () => {
    api.apiKeys.mockResolvedValue({ keys: [], deliveries: [] });
    api.createApiKey.mockRejectedValue(new ApiError(403, 'key_limit_reached', 'limit'));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.type(await screen.findByLabelText('Nama kunci'), 'Zapier');
    await user.click(screen.getByRole('button', { name: 'Buat kunci' }));
    expect(await screen.findByText('Sudah ada 5 kunci API aktif. Cabut satu dulu.')).toBeInTheDocument();
  });

  it('turns creating off at five keys', async () => {
    const keys = [1, 2, 3, 4, 5].map((n) => ({ ...KEY, id: `k${n}`, name: `Kunci ${n}` }));
    api.apiKeys.mockResolvedValue({ keys, deliveries: [] });
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    expect(await screen.findByRole('button', { name: 'Buat kunci' })).toBeDisabled();
    expect(screen.getByText('Maksimal 5 kunci aktif. Cabut satu untuk membuat yang baru.')).toBeInTheDocument();
  });

  it('revokes a key only after the inline confirm, moving focus into and out of it', async () => {
    api.apiKeys.mockResolvedValue({ keys: [{ ...KEY, lastUsedAt: null }], deliveries: [] });
    api.revokeApiKey.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    const row = await screen.findByTestId('api-key-row');
    expect(within(row).getByText('lqtts_abcdefghijkl_…')).toBeInTheDocument();
    expect(within(row).getByText(/belum pernah dipakai/)).toBeInTheDocument();
    const trigger = within(row).getByRole('button', { name: 'Cabut kunci Zapier' });
    await user.click(trigger);
    const confirm = screen.getByTestId('api-key-confirm');
    expect(within(confirm).getByRole('button', { name: 'Cabut kunci' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Batal' }));
    expect(api.revokeApiKey).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(within(screen.getByTestId('api-key-confirm')).getByRole('button', { name: 'Cabut kunci' }));
    expect(api.revokeApiKey).toHaveBeenCalledWith('k1');
    expect(await screen.findByText('Belum ada kunci API')).toBeInTheDocument();
  });

  it('lists webhook deliveries with their state', async () => {
    api.apiKeys.mockResolvedValue({
      keys: [KEY],
      deliveries: [
        { id: '2', keyId: 'k1', keyName: 'Zapier', jobId: 'j2', event: 'job.failed', state: 'dropped', attempts: 4, lastStatus: 500, createdAt: '2026-10-04T09:00:00Z', finishedAt: '2026-10-04T09:36:00Z' },
        { id: '1', keyId: 'k1', keyName: 'Zapier', jobId: 'j1', event: 'job.done', state: 'delivered', attempts: 1, lastStatus: 200, createdAt: '2026-10-04T08:00:00Z', finishedAt: '2026-10-04T08:00:01Z' },
      ],
    });
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    const rows = await screen.findAllByTestId('delivery-row');
    expect(rows.map((r) => r.dataset.state)).toEqual(['dropped', 'delivered']);
    expect(within(rows[0]).getByText('Gagal')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Terkirim')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'job.done' })).toHaveAttribute('href', '/jobs/j1');
  });
});
```

Append to `web/client/src/pages/HistoryPage.test.jsx`:
```jsx
  it('marks voiceovers made through the API', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a', { source: 'api' }), summary('b', { source: 'web' })], nextBefore: null });
    renderRoutes(routes, { path: '/history' });
    const rows = await screen.findAllByTestId('history-row');
    expect(within(rows[0]).getByTestId('api-chip')).toHaveTextContent('API');
    expect(within(rows[1]).queryByTestId('api-chip')).not.toBeInTheDocument();
  });
```

Append to `web/client/src/components/AppShell.test.jsx`:
```jsx
  it('links the API page from the navigation', () => {
    renderRoutes(routes);
    for (const link of screen.getAllByRole('link', { name: 'API' })) expect(link).toHaveAttribute('href', '/api-keys');
  });
```

In `web/client/src/i18n/i18n.test.js` add `'plan_required', 'key_limit_reached'` to `C2_ERROR_CODES` and `'api.delivery': ['delivered', 'pending', 'dropped'],` to `DYNAMIC_FAMILIES`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-api/web/client && npx vitest run src/pages/ApiPage.test.jsx src/pages/HistoryPage.test.jsx src/components/AppShell.test.jsx src/i18n/i18n.test.js`
Expected: FAIL — `Failed to resolve import "./ApiPage.jsx"`; no `api-chip`; no `API` link; `error.plan_required` missing.

- [ ] **Step 3: Implement**

`web/client/src/lib/api.js` — add to the `api` object, after `credits`:
```js
  /** Active keys of the account and the last 20 webhook deliveries per key. @returns {Promise<{keys: ApiKey[], deliveries: ApiDelivery[]}>} */
  apiKeys: () => request('/keys'),
  /** The full key and the webhook secret are in this answer only. 403 `plan_required` / `key_limit_reached`. @param {string} name @returns {Promise<NewApiKey>} */
  createApiKey: (name) => request('/keys', { method: 'POST', body: { name } }),
  /** @param {string} id @returns {Promise<null>} */
  revokeApiKey: (id) => request(`/keys/${enc(id)}`, { method: 'DELETE' }),
```
and the typedef imports at the top:
```js
/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').NewApiKey} NewApiKey */
/** @typedef {import('./types.js').ApiDelivery} ApiDelivery */
```

`web/client/src/lib/types.js` — `JobSummary` gains `source:'web'|'api'` (insert `, source:'web'|'api'` before the closing `}}` of its typedef) and append:
```js
/** `prefix` is `lqtts_<key_id>_…`; the full key is never listed. @typedef {{id:string, name:string, prefix:string, createdAt:string, lastUsedAt:string|null}} ApiKey */
/** Shown once, right after creation. @typedef {ApiKey & {key:string, webhookSecret:string}} NewApiKey */
/** @typedef {{id:string, keyId:string, keyName:string, jobId:string, event:'job.done'|'job.failed', state:'pending'|'delivered'|'dropped', attempts:number, lastStatus:number|null, createdAt:string, finishedAt:string|null}} ApiDelivery */
```

Create `web/client/src/pages/ApiPage.jsx`:
```jsx
import { ArrowSquareOutIcon, BookOpenTextIcon, CheckIcon, CopyIcon, KeyIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, Field, Notice, PageHeader, Skeleton, StatusChip, buttonClass, inputClass, touchLinkClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';

const MAX_NAME = 60;
const MAX_KEYS = 5;
const DELIVERY_TONE = { delivered: 'success', pending: 'progress', dropped: 'danger' };
const listed = ({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt });

export default function ApiPage() {
  const { t } = useI18n();
  const { me } = useSession();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('api.title')}
        subtitle={t('api.subtitle')}
        actions={(
          <Link to="/developers" className={buttonClass('secondary')}>
            <BookOpenTextIcon size={18} aria-hidden />
            {t('api.docs_link')}
          </Link>
        )}
      />
      {me?.paid ? <ApiKeys /> : (
        <Notice
          testId="api-upgrade"
          action={(
            <a href={me?.topupUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'sm')}>
              {t('api.upgrade_cta')}
              <ArrowSquareOutIcon size={16} aria-hidden />
            </a>
          )}
        >
          {t('api.upgrade_body')}
        </Notice>
      )}
    </div>
  );
}

function ApiKeys() {
  const { t } = useI18n();
  const data = useResource(() => api.apiKeys(), []);
  const [created, setCreated] = useState(null);

  if (data.data === undefined && !data.error) return <Skeleton className="h-40" />;
  if (data.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={data.reload}>{t('common.retry')}</Button>}>{errorText(t, data.error)}</Notice>;
  }
  const { keys, deliveries } = data.data;
  const removeKey = (id) => data.setData((d) => ({ ...d, keys: d.keys.filter((k) => k.id !== id), deliveries: d.deliveries.filter((x) => x.keyId !== id) }));
  const addKey = (made) => {
    setCreated(made);
    data.setData((d) => ({ ...d, keys: [listed(made), ...d.keys] }));
  };

  return (
    <>
      {created ? <NewKeyPanel created={created} onDone={() => setCreated(null)} /> : null}
      <section aria-labelledby="keys-heading" className="flex flex-col gap-3">
        <h2 id="keys-heading" className="text-lg font-semibold text-ink">{t('api.keys_title')}</h2>
        {keys.length === 0 ? (
          <EmptyState icon={KeyIcon} title={t('api.empty_title')} body={t('api.empty_body')} />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
            {keys.map((key) => <KeyRow key={key.id} apiKey={key} onRevoked={() => removeKey(key.id)} />)}
          </ul>
        )}
        <CreateKey full={keys.length >= MAX_KEYS} onCreated={addKey} />
      </section>
      <Deliveries deliveries={deliveries} />
    </>
  );
}

function CreateKey({ full, onCreated }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError({ code: 'name_required' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createApiKey(trimmed));
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const message = error ? (error.code === 'name_required' ? t('api.name_required') : errorText(t, error)) : null;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-5 md:flex-row md:items-start">
      <Field id="api-key-name" label={t('api.name_label')} help={full ? t('api.limit_reached') : t('api.name_help')} error={message} className="min-w-0 flex-1">
        <input
          id="api-key-name"
          value={name}
          maxLength={MAX_NAME}
          autoComplete="off"
          disabled={full || busy}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={message ? 'true' : undefined}
          aria-describedby={message ? 'api-key-name-error' : 'api-key-name-help'}
          className={`${inputClass} h-11`}
        />
      </Field>
      <Button type="submit" variant="primary" icon={KeyIcon} loading={busy} disabled={full} className="md:mt-7">{t('api.create')}</Button>
    </form>
  );
}

function NewKeyPanel({ created, onDone }) {
  const { t } = useI18n();
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby="new-key-heading" data-testid="new-key-panel" className="flex flex-col gap-4 rounded-panel border border-accent bg-accent-soft p-5 outline-none">
      <div>
        <h2 id="new-key-heading" className="text-lg font-semibold text-ink">{t('api.new_title', { name: created.name })}</h2>
        <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{t('api.new_body')}</p>
      </div>
      <SecretRow label={t('api.new_key')} value={created.key} testId="new-key-value" />
      <SecretRow label={t('api.new_webhook_secret')} value={created.webhookSecret} testId="new-webhook-secret" />
      <Button variant="primary" className="self-start" onClick={onDone}>{t('api.new_done')}</Button>
    </section>
  );
}

function SecretRow({ label, value, testId }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code data-testid={testId} className="min-w-0 flex-1 select-all rounded-control border border-line bg-surface px-3 py-2 font-mono text-sm text-ink [overflow-wrap:anywhere]">{value}</code>
        <Button size="sm" icon={copied ? CheckIcon : CopyIcon} onClick={copy} aria-label={t('api.copy_named', { label })}>
          {copied ? t('api.copied') : t('api.copy')}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">{copied ? t('api.copied') : ''}</span>
      {failed ? <p role="alert" className="text-sm text-danger">{t('api.copy_failed')}</p> : null}
    </div>
  );
}

function KeyRow({ apiKey, onRevoked }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  const promptId = `key-revoke-${apiKey.id}`;
  const confirmId = `key-revoke-confirm-${apiKey.id}`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.revokeApiKey(apiKey.id);
      onRevoked();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const used = apiKey.lastUsedAt ? t('api.last_used', { date: formatDateTime(apiKey.lastUsedAt, lang) }) : t('api.never_used');
  return (
    <li data-testid="api-key-row" data-key-id={apiKey.id} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink [overflow-wrap:anywhere]">{apiKey.name}</p>
          <p className="mt-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">{apiKey.prefix}</p>
          <p className="mt-1 text-xs text-muted">{t('api.created_at', { date: formatDateTime(apiKey.createdAt, lang) })} · {used}</p>
        </div>
        <Button ref={triggerRef} variant="ghost" size="sm" icon={TrashIcon} aria-expanded={confirming} aria-controls={confirming ? confirmId : undefined} onClick={() => setConfirming(true)} aria-label={t('api.revoke_named', { name: apiKey.name })}>
          <span className="hidden md:inline">{t('api.revoke')}</span>
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{errorText(t, error)}</p> : null}
      {confirming ? (
        <div id={confirmId} data-testid="api-key-confirm" className="flex flex-col gap-3 rounded-control bg-danger-soft p-3 lg:flex-row lg:items-center lg:justify-between">
          <p id={promptId} role="alert" className="text-sm text-ink">{t('api.revoke_confirm')}</p>
          <div className="flex flex-wrap gap-2 lg:shrink-0">
            <Button ref={confirmRef} variant="danger" size="sm" loading={busy} aria-describedby={promptId} onClick={revoke}>{t('api.revoke')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Deliveries({ deliveries }) {
  const { t, lang } = useI18n();
  return (
    <section aria-labelledby="deliveries-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="deliveries-heading" className="text-lg font-semibold text-ink">{t('api.deliveries_title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('api.deliveries_help')}</p>
      </div>
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted">{t('api.deliveries_empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-panel border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="hidden whitespace-nowrap px-4 py-3 font-medium md:table-cell">{t('api.col.time')}</th>
                <th scope="col" className="w-full px-4 py-3 font-medium">{t('api.col.event')}</th>
                <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">{t('api.col.key')}</th>
                <th scope="col" className="hidden whitespace-nowrap px-4 py-3 text-right font-medium md:table-cell">{t('api.col.attempts')}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t('api.col.state')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deliveries.map((d) => {
                const state = DELIVERY_TONE[d.state] ? d.state : 'pending';
                return (
                  <tr key={d.id} data-testid="delivery-row" data-state={d.state} className="align-top">
                    <td className="hidden whitespace-nowrap px-4 py-3 text-muted md:table-cell">{formatDateTime(d.createdAt, lang)}</td>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${d.jobId}`} className={`font-mono text-ink transition-colors duration-150 hover:text-accent ${touchLinkClass}`}>{d.event}</Link>
                      <p className="mt-0.5 text-xs text-muted md:hidden">{formatDateTime(d.createdAt, lang)}</p>
                      <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere] lg:hidden">{d.keyName}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-muted [overflow-wrap:anywhere] lg:table-cell">{d.keyName}</td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono tabular md:table-cell">{d.attempts}{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ''}</td>
                    <td className="whitespace-nowrap px-4 py-3"><StatusChip tone={DELIVERY_TONE[state]} status={state}>{t(`api.delivery.${state}`)}</StatusChip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

`web/client/src/router.jsx` — import `ApiPage` from `./pages/ApiPage.jsx` and add the child route after `credits`:
```jsx
      { path: 'credits', element: <CreditsPage /> },
      { path: 'api-keys', element: <ApiPage /> },
```

`web/client/src/components/AppShell.jsx` — add `CodeIcon` to the icon import, a nav item, and five bottom tabs:
```jsx
const NAV = [
  { to: '/', key: 'nav.tts', icon: TextAaIcon, end: true },
  { to: '/voices', key: 'nav.voices', icon: UserSoundIcon },
  { to: '/history', key: 'nav.history', icon: ClockCounterClockwiseIcon },
  { to: '/credits', key: 'nav.credits', icon: CoinsIcon },
  { to: '/api-keys', key: 'nav.api', icon: CodeIcon },
];
```
In the bottom `<nav data-testid="bottom-nav" ...>` change `grid-cols-4` to `grid-cols-5`.

`web/client/src/pages/HistoryPage.jsx` — add `StatusChip` to the `ui.jsx` import; in `HistoryRow`, right after the title `<Link ...>{job.title}</Link>`:
```jsx
        {job.source === 'api' ? <span className="ml-2 inline-flex align-middle"><StatusChip testId="api-chip">{t('history.api_chip')}</StatusChip></span> : null}
```

`web/client/src/i18n/id.js` — add (in the `nav.*`, `error.*`, `history.*` groups for the first four, and a new `api.*` group before `notfound.*`):
```js
  'nav.api': 'API',
  'error.plan_required': 'Fitur ini butuh paket Pro, Ultra atau Sultan.',
  'error.key_limit_reached': 'Sudah ada 5 kunci API aktif. Cabut satu dulu.',
  'history.api_chip': 'API',

  'api.title': 'API',
  'api.subtitle': 'Buat voiceover dari aplikasi dan otomasi kamu sendiri, dibayar dengan kredit LQ-Studio yang sama.',
  'api.docs_link': 'Dokumentasi API',
  'api.upgrade_body': 'API tersedia untuk paket Pro, Ultra dan Sultan. Upgrade paket di LQ-Studio untuk membuat kunci API.',
  'api.upgrade_cta': 'Upgrade paket',
  'api.keys_title': 'Kunci API',
  'api.empty_title': 'Belum ada kunci API',
  'api.empty_body': 'Buat satu kunci untuk setiap aplikasi, supaya bisa dicabut satu per satu.',
  'api.name_label': 'Nama kunci',
  'api.name_help': 'Contoh: Zapier atau server produksi. Maksimal 60 karakter.',
  'api.name_required': 'Beri nama kunci ini dulu.',
  'api.limit_reached': 'Maksimal 5 kunci aktif. Cabut satu untuk membuat yang baru.',
  'api.create': 'Buat kunci',
  'api.new_title': 'Kunci {name} siap',
  'api.new_body': 'Simpan kunci API dan rahasia webhook ini sekarang. Keduanya hanya ditampilkan sekali dan tidak bisa dilihat lagi.',
  'api.new_key': 'Kunci API',
  'api.new_webhook_secret': 'Rahasia webhook',
  'api.new_done': 'Sudah saya simpan',
  'api.copy': 'Salin',
  'api.copy_named': 'Salin {label}',
  'api.copied': 'Tersalin',
  'api.copy_failed': 'Gagal menyalin. Pilih teksnya lalu salin manual.',
  'api.created_at': 'Dibuat {date}',
  'api.last_used': 'terakhir dipakai {date}',
  'api.never_used': 'belum pernah dipakai',
  'api.revoke': 'Cabut kunci',
  'api.revoke_named': 'Cabut kunci {name}',
  'api.revoke_confirm': 'Aplikasi yang memakai kunci ini langsung berhenti bekerja. Lanjutkan?',
  'api.deliveries_title': 'Pengiriman webhook',
  'api.deliveries_help': '20 pengiriman terakhir untuk setiap kunci aktif.',
  'api.deliveries_empty': 'Belum ada webhook yang dikirim.',
  'api.col.time': 'Waktu',
  'api.col.event': 'Event',
  'api.col.key': 'Kunci',
  'api.col.attempts': 'Percobaan',
  'api.col.state': 'Status',
  'api.delivery.delivered': 'Terkirim',
  'api.delivery.pending': 'Menunggu',
  'api.delivery.dropped': 'Gagal',
```
`web/client/src/i18n/en.js` — the same keys:
```js
  'nav.api': 'API',
  'error.plan_required': 'This needs a Pro, Ultra or Sultan plan.',
  'error.key_limit_reached': 'You already have 5 active API keys. Revoke one first.',
  'history.api_chip': 'API',

  'api.title': 'API',
  'api.subtitle': 'Make voiceovers from your own apps and automations, paid with the same LQ-Studio credits.',
  'api.docs_link': 'API docs',
  'api.upgrade_body': 'The API is available on the Pro, Ultra and Sultan plans. Upgrade on LQ-Studio to create API keys.',
  'api.upgrade_cta': 'Upgrade plan',
  'api.keys_title': 'API keys',
  'api.empty_title': 'No API keys yet',
  'api.empty_body': 'Create one key per app, so you can revoke them one at a time.',
  'api.name_label': 'Key name',
  'api.name_help': 'For example: Zapier or production server. At most 60 characters.',
  'api.name_required': 'Give this key a name first.',
  'api.limit_reached': 'At most 5 active keys. Revoke one to create a new one.',
  'api.create': 'Create key',
  'api.new_title': 'Key {name} is ready',
  'api.new_body': 'Save this API key and webhook secret now. They are shown only once and cannot be viewed again.',
  'api.new_key': 'API key',
  'api.new_webhook_secret': 'Webhook secret',
  'api.new_done': 'I have saved them',
  'api.copy': 'Copy',
  'api.copy_named': 'Copy {label}',
  'api.copied': 'Copied',
  'api.copy_failed': 'Could not copy. Select the text and copy it by hand.',
  'api.created_at': 'Created {date}',
  'api.last_used': 'last used {date}',
  'api.never_used': 'never used',
  'api.revoke': 'Revoke key',
  'api.revoke_named': 'Revoke key {name}',
  'api.revoke_confirm': 'Apps using this key stop working right away. Continue?',
  'api.deliveries_title': 'Webhook deliveries',
  'api.deliveries_help': 'The last 20 deliveries for each active key.',
  'api.deliveries_empty': 'No webhooks sent yet.',
  'api.col.time': 'Time',
  'api.col.event': 'Event',
  'api.col.key': 'Key',
  'api.col.attempts': 'Attempts',
  'api.col.state': 'Status',
  'api.delivery.delivered': 'Delivered',
  'api.delivery.pending': 'Pending',
  'api.delivery.dropped': 'Dropped',
```

- [ ] **Step 4: Run the tests to verify they pass, then the client suite and a build**

Run: `cd ~/Developer/LQ-TTS-api/web/client && npx vitest run src/pages/ApiPage.test.jsx src/pages/HistoryPage.test.jsx src/components/AppShell.test.jsx src/i18n/i18n.test.js && npx vitest run && npx vite build`
Expected: PASS (7 new ApiPage tests, +1 History, +1 AppShell); suite green; build writes `dist/` without warnings about missing exports. Delete nothing in `dist/` by hand (gitignored).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/client/src/pages/ApiPage.jsx web/client/src/pages/ApiPage.test.jsx web/client/src/lib/api.js web/client/src/lib/types.js \
  web/client/src/router.jsx web/client/src/components/AppShell.jsx web/client/src/components/AppShell.test.jsx \
  web/client/src/pages/HistoryPage.jsx web/client/src/pages/HistoryPage.test.jsx \
  web/client/src/i18n/id.js web/client/src/i18n/en.js web/client/src/i18n/i18n.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: API page with one-time key panel, deliveries, nav item and History API chip"
```

---
### Task 11: Public API docs page `/developers`

**Before editing:** the SOP G4 skills from Global Constraints stay loaded (reload them in a new session; `craft-floor.md` right before the first UI edit).

**Files:**
- Create: `web/client/src/lib/api-docs.js`, `web/client/src/pages/DevelopersPage.jsx`, `web/client/src/pages/DevelopersPage.test.jsx`
- Modify: `web/client/src/router.jsx`, `web/client/src/i18n/id.js`, `web/client/src/i18n/en.js`, `web/client/src/i18n/i18n.test.js`

**Interfaces:**
- Consumes: Task 10 route `/api-keys`; `Segmented`, `LANG_OPTIONS`, `buttonClass`; the server contract of Tasks 5-8 (documented, not called).
- Produces: public route `/developers` outside `RequireSession` (no `/api/me` call); `lib/api-docs.js` exports `BASE_URL`, `ENDPOINTS` (`[method, path, key]`), `ERRORS` (`[code, status]`), `SAMPLES` (`auth`, `create`, `createAnswer`, `poll`, `pollAnswer`, `download`, `webhookBody`, `verifyNode`, `verifyPython`).

- [ ] **Step 1: Write the failing test**

Create `web/client/src/pages/DevelopersPage.test.jsx`:
```jsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { routes } from '../router.jsx';
import { renderRoutes } from '../test/render.jsx';

describe('DevelopersPage', () => {
  it('is public and covers auth, endpoints, webhooks, errors and limits', () => {
    renderRoutes(routes, { path: '/developers', me: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Dokumentasi API LQ TTS' })).toBeInTheDocument();
    for (const name of ['Autentikasi', 'Endpoint', 'Membuat voiceover', 'Cek status dan unduh', 'Webhook', 'Error', 'Batas']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText('/v1/tts/{jobId}/files/{name}')).toBeInTheDocument();
    expect(screen.getByText(/verifyLqttsWebhook/)).toBeInTheDocument();
    expect(screen.getByText(/def verify_lqtts_webhook/)).toBeInTheDocument();
    expect(screen.getByText('too_many_jobs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buka halaman API' })).toHaveAttribute('href', '/api-keys');
  });

  it('switches to English without a session', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/developers', me: null });
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { level: 1, name: 'LQ TTS API docs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Limits' })).toBeInTheDocument();
  });
});
```

In `web/client/src/i18n/i18n.test.js` add to `DYNAMIC_FAMILIES`:
```js
  'docs.endpoint': ['voices', 'estimate', 'create', 'get', 'file', 'delete'],
  'docs.error': ['invalid_request', 'invalid_webhook_url', 'unauthorized', 'insufficient_credits', 'plan_required', 'suspended',
    'needs_verification', 'not_found', 'voice_not_ready', 'idempotency_conflict', 'too_large', 'too_many_jobs', 'rate_limited',
    'lqstudio_unavailable', 'engine_unavailable'],
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/LQ-TTS-api/web/client && npx vitest run src/pages/DevelopersPage.test.jsx src/i18n/i18n.test.js`
Expected: FAIL — `/developers` renders the login redirect (no route), and `docs.endpoint.voices` is missing.

- [ ] **Step 3: Implement**

Create `web/client/src/lib/api-docs.js` (code shown on the docs page; kept out of the dictionaries because code is not translated):
```js
export const BASE_URL = 'https://tts.lq-studio.com';

/** [method, path, dictionary key under docs.endpoint.*] */
export const ENDPOINTS = [
  ['GET', '/v1/voices', 'voices'],
  ['POST', '/v1/estimate', 'estimate'],
  ['POST', '/v1/tts', 'create'],
  ['GET', '/v1/tts/{jobId}', 'get'],
  ['GET', '/v1/tts/{jobId}/files/{name}', 'file'],
  ['DELETE', '/v1/tts/{jobId}', 'delete'],
];

/** [code, HTTP status]; the text is docs.error.<code>. */
export const ERRORS = [
  ['invalid_request', 400], ['invalid_webhook_url', 400], ['unauthorized', 401], ['insufficient_credits', 402],
  ['plan_required', 403], ['suspended', 403], ['needs_verification', 403], ['not_found', 404], ['voice_not_ready', 409],
  ['idempotency_conflict', 409], ['too_large', 413], ['too_many_jobs', 429], ['rate_limited', 429],
  ['lqstudio_unavailable', 503], ['engine_unavailable', 503],
];

const files = {
  mp3: '/v1/tts/JOB_ID/files/final.mp3',
  srt: '/v1/tts/JOB_ID/files/subtitles.srt',
};

export const SAMPLES = {
  auth: `curl ${BASE_URL}/v1/voices \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  create: `curl ${BASE_URL}/v1/tts \\
  -H "Authorization: Bearer $LQTTS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '{"voiceId":"VOICE_ID","text":"Halo, ini voiceover dari API.","formats":["mp3","srt"],"webhookUrl":"https://example.com/lqtts-hook"}'`,
  createAnswer: JSON.stringify({ jobId: 'JOB_ID', credits: 1, status: 'queued' }, null, 2),
  poll: `curl ${BASE_URL}/v1/tts/JOB_ID \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  pollAnswer: JSON.stringify({
    jobId: 'JOB_ID', status: 'done', progress: { done: 1, total: 1 }, credits: 1, errorCode: null, files,
    createdAt: '2026-10-04T08:00:00.000Z',
  }, null, 2),
  download: `curl -o voiceover.mp3 ${BASE_URL}/v1/tts/JOB_ID/files/final.mp3 \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  webhookBody: `POST https://example.com/lqtts-hook
Content-Type: application/json
LQTTS-Event: job.done
LQTTS-Delivery: 1842
LQTTS-Signature: t=1760000000,v1=5d41402abc4b2a76b9719d911017c592...

${JSON.stringify({ event: 'job.done', jobId: 'JOB_ID', status: 'done', credits: 1, files, createdAt: '2026-10-04T08:00:00.000Z' }, null, 2)}`,
  verifyNode: `import crypto from 'node:crypto';

// rawBody: the request body exactly as received (string or Buffer), before JSON.parse.
export function verifyLqttsWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(signatureHeader).split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const given = String(parts.v1 ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`,
  verifyPython: `import hashlib
import hmac
import time


def verify_lqtts_webhook(raw_body: bytes, signature_header: str, secret: str, tolerance_seconds: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in signature_header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`,
};
```

Create `web/client/src/pages/DevelopersPage.jsx`:
```jsx
import { KeyIcon, WaveformIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Segmented, buttonClass } from '../components/ui.jsx';
import { LANG_OPTIONS, useI18n } from '../i18n/index.jsx';
import { BASE_URL, ENDPOINTS, ERRORS, SAMPLES } from '../lib/api-docs.js';

function Code({ children }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-control border border-line bg-surface-2 p-4 text-sm leading-relaxed">
      <code className="font-mono text-ink">{children}</code>
    </pre>
  );
}

function Section({ id, title, children }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Text({ children }) {
  return <p className="max-w-[70ch] text-sm leading-relaxed text-muted">{children}</p>;
}

/** Public developer docs (spec §2.7): no session needed, language switch kept in this browser only. */
export default function DevelopersPage() {
  const { t, lang, setLang } = useI18n();
  const limits = [t('docs.limit.jobs'), t('docs.limit.rate'), t('docs.limit.chars'), t('docs.limit.queue')];
  return (
    <div className="min-h-[100dvh] bg-bg">
      <header className="sticky top-0 z-[var(--z-sticky)] flex h-14 items-center justify-between gap-4 border-b border-line bg-bg px-4 md:px-8">
        <Link to="/" className="flex items-center gap-2 text-base font-semibold text-ink">
          <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
          LQ TTS
        </Link>
        <span id="docs-lang" className="sr-only">{t('account.language')}</span>
        <Segmented options={LANG_OPTIONS} value={lang} onChange={setLang} labelledBy="docs-lang" />
      </header>
      <main id="main" className="mx-auto flex w-full max-w-[880px] flex-col gap-10 px-4 py-8 md:px-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold text-ink">{t('docs.title')}</h1>
          <Text>{t('docs.intro')}</Text>
          <Text>{t('docs.who')}</Text>
          <Link to="/api-keys" className={`${buttonClass('primary')} self-start`}>
            <KeyIcon size={18} aria-hidden />
            {t('docs.keys_link')}
          </Link>
        </div>

        <Section id="docs-auth" title={t('docs.auth_title')}>
          <Text>{t('docs.auth_body')}</Text>
          <Code>{SAMPLES.auth}</Code>
          <Text>{t('docs.auth_revoke')}</Text>
        </Section>

        <Section id="docs-endpoints" title={t('docs.endpoints_title')}>
          <Text>{t('docs.base_url', { url: BASE_URL })}</Text>
          <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
            {ENDPOINTS.map(([method, path, key]) => (
              <li key={`${method} ${path}`} className="flex flex-col gap-1 px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-ink">
                  <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{method}</span>
                  <span className="[overflow-wrap:anywhere]">{path}</span>
                </p>
                <p className="text-sm text-muted">{t(`docs.endpoint.${key}`)}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="docs-create" title={t('docs.create_title')}>
          <Text>{t('docs.create_body')}</Text>
          <Text>{t('docs.idempotency')}</Text>
          <Code>{SAMPLES.create}</Code>
          <Text>{t('docs.answer')}</Text>
          <Code>{SAMPLES.createAnswer}</Code>
        </Section>

        <Section id="docs-poll" title={t('docs.poll_title')}>
          <Text>{t('docs.poll_body')}</Text>
          <Code>{SAMPLES.poll}</Code>
          <Code>{SAMPLES.pollAnswer}</Code>
          <Code>{SAMPLES.download}</Code>
        </Section>

        <Section id="docs-webhooks" title={t('docs.webhooks_title')}>
          <Text>{t('docs.webhooks_body')}</Text>
          <Code>{SAMPLES.webhookBody}</Code>
          <Text>{t('docs.signature_body')}</Text>
          <h3 className="text-base font-semibold text-ink">{t('docs.verify_node')}</h3>
          <Code>{SAMPLES.verifyNode}</Code>
          <h3 className="text-base font-semibold text-ink">{t('docs.verify_python')}</h3>
          <Code>{SAMPLES.verifyPython}</Code>
        </Section>

        <Section id="docs-errors" title={t('docs.errors_title')}>
          <Text>{t('docs.errors_body')}</Text>
          <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
            {ERRORS.map(([code, status]) => (
              <li key={code} className="flex flex-col gap-1 px-4 py-3 md:flex-row md:items-baseline md:gap-4">
                <p className="flex shrink-0 items-baseline gap-2 font-mono text-sm md:w-64">
                  <span className="text-xs text-muted tabular">{status}</span>
                  <code className="text-ink">{code}</code>
                </p>
                <p className="text-sm text-muted">{t(`docs.error.${code}`)}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="docs-limits" title={t('docs.limits_title')}>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
            {limits.map((line) => <li key={line} className="max-w-[70ch]">{line}</li>)}
          </ul>
        </Section>
      </main>
    </div>
  );
}
```

`web/client/src/router.jsx` — import `DevelopersPage` from `./pages/DevelopersPage.jsx` and add a top-level route next to `/login`:
```jsx
  { path: '/login', element: <LoginPage /> },
  { path: '/developers', element: <DevelopersPage /> },
```

`web/client/src/i18n/id.js` — new `docs.*` group before `notfound.*`:
```js
  'docs.title': 'Dokumentasi API LQ TTS',
  'docs.intro': 'Buat voiceover dari aplikasi kamu sendiri. Harganya sama dengan aplikasi web: 10 kredit per 1.000 karakter, dipotong dari saldo LQ-Studio yang sama.',
  'docs.who': 'Untuk paket Pro, Ultra dan Sultan. Kunci dibuat di halaman API.',
  'docs.keys_link': 'Buka halaman API',
  'docs.auth_title': 'Autentikasi',
  'docs.auth_body': 'Kirim kunci di header Authorization pada setiap permintaan. Kunci hanya ditampilkan sekali saat dibuat. Simpan di server, jangan di aplikasi browser atau ponsel.',
  'docs.auth_revoke': 'Kunci langsung berhenti bekerja saat dicabut, dan dalam 5 menit setelah kata sandi diganti, akun ditangguhkan atau paket turun di bawah Pro.',
  'docs.endpoints_title': 'Endpoint',
  'docs.base_url': 'Alamat dasar: {url}',
  'docs.endpoint.voices': 'Suara yang siap dipakai: suara kloningan kamu dan VO Profile yang diizinkan untuk API.',
  'docs.endpoint.estimate': 'Hitung karakter, kredit dan kalimat sebuah teks tanpa memakai kredit.',
  'docs.endpoint.create': 'Masukkan voiceover ke antrean. Kredit ditahan sekarang, dipotong saat selesai, dan dikembalikan bila gagal.',
  'docs.endpoint.get': 'Status, progres, kredit dan tautan unduhan.',
  'docs.endpoint.file': 'Unduh final.mp3, final.wav, subtitles.srt atau subtitles.vtt.',
  'docs.endpoint.delete': 'Batalkan bila masih antre atau berjalan (kredit dikembalikan seperti di web), selain itu hapus.',
  'docs.create_title': 'Membuat voiceover',
  'docs.create_body': 'text maksimal 20.000 karakter. voiceId diambil dari GET /v1/voices. settings opsional: speed (0,7 sampai 1,3), pause_sentence_s, pause_paragraph_s, loudness_lufs. formats opsional: mp3, wav, srt, vtt.',
  'docs.idempotency': 'Kirim header Idempotency-Key (maksimal 100 karakter) supaya percobaan ulang tidak membuat voiceover kedua. Kunci yang sama dalam 24 jam mengembalikan voiceover yang sama.',
  'docs.answer': 'Jawaban:',
  'docs.poll_title': 'Cek status dan unduh',
  'docs.poll_body': 'Tanyakan status setiap beberapa detik sampai done atau failed. Cara ini selalu bisa dipakai, dengan atau tanpa webhook.',
  'docs.webhooks_title': 'Webhook',
  'docs.webhooks_body': 'Isi webhookUrl (https, port 443, alamat publik) untuk menerima POST saat voiceover selesai (job.done) atau gagal (job.failed). Jawaban 2xx berarti terkirim. Percobaan pada 0 detik, 1 menit, 5 menit dan 30 menit, masing-masing paling lama 10 detik. Redirect tidak diikuti.',
  'docs.signature_body': 'Setiap webhook membawa header LQTTS-Signature berisi t (waktu Unix) dan v1, yaitu HMAC-SHA256 heksadesimal dari t, sebuah titik, lalu body mentah. Kuncinya adalah rahasia webhook dari kunci API yang membuat voiceover. Tolak webhook bila tanda tangannya salah atau t lebih dari 5 menit.',
  'docs.verify_node': 'Verifikasi di Node.js',
  'docs.verify_python': 'Verifikasi di Python',
  'docs.errors_title': 'Error',
  'docs.errors_body': 'Setiap error berupa JSON dengan error.code dan error.message. Pakai code di aplikasi kamu, bukan message.',
  'docs.error.invalid_request': 'Isi permintaan tidak valid. Pesannya menyebut kolom yang salah.',
  'docs.error.invalid_webhook_url': 'webhookUrl bukan https, bukan port 443, berisi nama pengguna, atau menunjuk ke alamat yang tidak publik.',
  'docs.error.unauthorized': 'Kunci tidak ada, salah, atau sudah dicabut.',
  'docs.error.insufficient_credits': 'Saldo tidak cukup. Jawaban berisi balance dan topupUrl.',
  'docs.error.plan_required': 'Paket akun di bawah Pro. Kunci akun ini dicabut.',
  'docs.error.suspended': 'Akun ditangguhkan. Kunci akun ini dicabut.',
  'docs.error.needs_verification': 'Selesaikan verifikasi email dan nomor ponsel di LQ-Studio.',
  'docs.error.not_found': 'Suara atau voiceover tidak ada, atau milik akun lain.',
  'docs.error.voice_not_ready': 'Suara masih diproses.',
  'docs.error.idempotency_conflict': 'Permintaan dengan Idempotency-Key yang sama masih diproses.',
  'docs.error.too_large': 'Teks lebih dari 20.000 karakter atau body terlalu besar.',
  'docs.error.too_many_jobs': 'Sudah ada 2 voiceover API yang antre atau berjalan.',
  'docs.error.rate_limited': 'Lebih dari 60 permintaan per menit. Tunggu sesuai header Retry-After.',
  'docs.error.lqstudio_unavailable': 'LQ-Studio sedang tidak bisa dihubungi. Coba lagi nanti.',
  'docs.error.engine_unavailable': 'Mesin suara sedang tidak tersedia. Coba lagi nanti.',
  'docs.limits_title': 'Batas',
  'docs.limit.jobs': 'Maksimal 2 voiceover API yang antre atau berjalan sekaligus per akun.',
  'docs.limit.rate': 'Maksimal 60 permintaan per menit per akun, semua kunci digabung.',
  'docs.limit.chars': 'Maksimal 20.000 karakter per voiceover.',
  'docs.limit.queue': 'Voiceover dari aplikasi web dikerjakan lebih dulu. Voiceover API yang sudah menunggu lebih dari 10 menit ikut antrean yang sama.',
```
`web/client/src/i18n/en.js` — the same keys:
```js
  'docs.title': 'LQ TTS API docs',
  'docs.intro': 'Make voiceovers from your own app. Same price as the web app: 10 credits per 1,000 characters, taken from the same LQ-Studio balance.',
  'docs.who': 'For the Pro, Ultra and Sultan plans. Keys are created on the API page.',
  'docs.keys_link': 'Open the API page',
  'docs.auth_title': 'Authentication',
  'docs.auth_body': 'Send the key in the Authorization header of every request. A key is shown only once, when it is created. Keep it on your server, never in a browser or mobile app.',
  'docs.auth_revoke': 'A key stops working at once when it is revoked, and within 5 minutes after a password change, a suspension or a downgrade below Pro.',
  'docs.endpoints_title': 'Endpoints',
  'docs.base_url': 'Base URL: {url}',
  'docs.endpoint.voices': 'Voices ready to use: your cloned voices and the VO Profiles allowed for the API.',
  'docs.endpoint.estimate': 'Count the characters, credits and sentences of a text without spending credits.',
  'docs.endpoint.create': 'Queue a voiceover. Credits are held now, taken when it finishes and refunded if it fails.',
  'docs.endpoint.get': 'Status, progress, credits and download links.',
  'docs.endpoint.file': 'Download final.mp3, final.wav, subtitles.srt or subtitles.vtt.',
  'docs.endpoint.delete': 'Cancel while queued or running (refunded as on the web), otherwise delete.',
  'docs.create_title': 'Making a voiceover',
  'docs.create_body': 'text: at most 20,000 characters. voiceId: from GET /v1/voices. Optional settings: speed (0.7 to 1.3), pause_sentence_s, pause_paragraph_s, loudness_lufs. Optional formats: mp3, wav, srt, vtt.',
  'docs.idempotency': 'Send an Idempotency-Key header (at most 100 characters) so a retry never makes a second voiceover. The same key within 24 hours returns the same voiceover.',
  'docs.answer': 'Response:',
  'docs.poll_title': 'Check status and download',
  'docs.poll_body': 'Ask for the status every few seconds until it is done or failed. This always works, with or without a webhook.',
  'docs.webhooks_title': 'Webhooks',
  'docs.webhooks_body': 'Set webhookUrl (https, port 443, public address) to get a POST when a voiceover finishes (job.done) or fails (job.failed). Any 2xx answer counts as delivered. Attempts at 0 s, 1 min, 5 min and 30 min, at most 10 s each. Redirects are not followed.',
  'docs.signature_body': 'Every webhook carries an LQTTS-Signature header with t (Unix time) and v1, the hex HMAC-SHA256 of t, a dot, then the raw body. The key is the webhook secret of the API key that made the voiceover. Reject the webhook when the signature is wrong or t is more than 5 minutes off.',
  'docs.verify_node': 'Verify in Node.js',
  'docs.verify_python': 'Verify in Python',
  'docs.errors_title': 'Errors',
  'docs.errors_body': 'Every error is JSON with error.code and error.message. Use the code in your app, not the message.',
  'docs.error.invalid_request': 'The request is invalid. The message names the field.',
  'docs.error.invalid_webhook_url': 'webhookUrl is not https, not port 443, has a user name, or points to a non-public address.',
  'docs.error.unauthorized': 'The key is missing, wrong or revoked.',
  'docs.error.insufficient_credits': 'Not enough credits. The answer carries balance and topupUrl.',
  'docs.error.plan_required': 'The account plan is below Pro. Its keys are revoked.',
  'docs.error.suspended': 'The account is suspended. Its keys are revoked.',
  'docs.error.needs_verification': 'Finish verifying your email and phone number on LQ-Studio.',
  'docs.error.not_found': 'The voice or voiceover does not exist or belongs to another account.',
  'docs.error.voice_not_ready': 'The voice is still being processed.',
  'docs.error.idempotency_conflict': 'A request with the same Idempotency-Key is still being processed.',
  'docs.error.too_large': 'The text is over 20,000 characters or the body is too large.',
  'docs.error.too_many_jobs': 'Two API voiceovers are already queued or running.',
  'docs.error.rate_limited': 'More than 60 requests a minute. Wait as long as the Retry-After header says.',
  'docs.error.lqstudio_unavailable': 'LQ-Studio cannot be reached right now. Try again later.',
  'docs.error.engine_unavailable': 'The voice engine is unavailable right now. Try again later.',
  'docs.limits_title': 'Limits',
  'docs.limit.jobs': 'At most 2 API voiceovers queued or running at once per account.',
  'docs.limit.rate': 'At most 60 requests a minute per account, all its keys together.',
  'docs.limit.chars': 'At most 20,000 characters per voiceover.',
  'docs.limit.queue': 'Voiceovers from the web app run first. An API voiceover that has waited more than 10 minutes joins the same queue.',
```

- [ ] **Step 4: Run the tests to verify they pass, then the client suite and a build**

Run: `cd ~/Developer/LQ-TTS-api/web/client && npx vitest run src/pages/DevelopersPage.test.jsx src/i18n/i18n.test.js && npx vitest run && npx vite build`
Expected: PASS (+2 tests); suite green; build clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/client/src/lib/api-docs.js web/client/src/pages/DevelopersPage.jsx web/client/src/pages/DevelopersPage.test.jsx \
  web/client/src/router.jsx web/client/src/i18n/id.js web/client/src/i18n/en.js web/client/src/i18n/i18n.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: public API docs page /developers (ID/EN)"
```

---
### Task 12: End-to-end: key through the UI, `/v1` flow with a local webhook receiver (local) or polling (staging)

**Prerequisite:** Release A (engine with `priority`) is live. The local harness talks to the real engine on 127.0.0.1:8740, and the engine released before Release A refuses the new `priority` field (400). Check first: `curl -s http://127.0.0.1:8740/openapi.json | grep -c '"priority"'` must print a number above 0; otherwise stop and ask the controller to run Release A.

**Files:**
- Modify: `web/e2e/target.mjs` (`LOCAL_USERS`, new `apiCredentials()`), `web/e2e/harness/run-server.mjs` (env, Pandji API flag), `web/e2e/playwright.config.js` (project `api`), `web/e2e/tests/journey.spec.js` (comment :44), `web/e2e/staging/seed-lqstudio-user.mjs` (`tier`)
- Create: `web/e2e/tests/api.spec.js`

**Interfaces:**
- Consumes: everything above. Local server env adds `API_ENC_KEY` (random per run, the schema is throwaway) and `WEBHOOK_ALLOW_LOOPBACK=true` (`COOKIE_SECURE=false` is already set there). The local run seeds Pandji, then flips it to `api_allowed` with the Task 9 CLI flag (local schema only).
- Produces: Playwright project `api` (depends on `journey`); artifacts `web/e2e/artifacts/api/*.png`; the staging gate grows from 5 to 6 tests.

- [ ] **Step 1: Write the spec and the harness changes**

`web/e2e/target.mjs` — a second, Pro, local user without 2FA, and the credentials helper the API spec uses:
```js
export const LOCAL_USERS = [
  {
    id: 'e2e-u1', name: 'Rara Wibisono', email: 'rara.e2e@example.com', username: 'e2e-rara', password: 'e2e-pass-7391',
    totp: '482913', verified: true, suspended: false, plan: 'free', paid: false, balance: 2400,
  },
  {
    id: 'e2e-u2', name: 'Bima Pratama', email: 'bima.e2e@example.com', username: 'e2e-bima', password: 'e2e-pass-5820',
    totp: null, verified: true, suspended: false, plan: 'pro', paid: true, balance: 2400,
  },
];
```
```js
/** A Pro account for the API spec: the local Pro user, or the staging gate account (seeded as Pro). Never on PROD. */
export function apiCredentials() {
  if (TARGET === 'prod') throw new Error('E2E_TARGET=prod runs the smoke project only; the API spec never runs on PROD');
  if (TARGET === 'local') {
    const u = LOCAL_USERS[1];
    return { identifier: u.username, password: u.password, code: null };
  }
  return credentials();
}
```

`web/e2e/harness/run-server.mjs`:
- add `import { randomBytes } from 'node:crypto';`
- in the `env` object, after `CLIENT_DIST`:
```js
  API_ENC_KEY: randomBytes(32).toString('base64'), // this run's throwaway schema only
  WEBHOOK_ALLOW_LOOPBACK: 'true', // the API spec's webhook receiver listens on 127.0.0.1
```
- after `seedProfile()`, a second CLI run that allows Pandji for the API in this throwaway schema:
```js
// Locally the API spec voices over with Pandji: allow it for the API through the same CLI flag the release would use.
// Only this run's schema changes; staging and PROD keep Pandji off the API.
async function allowPandjiForApi() {
  const cli = startChild(['server/cli/profile-add.js', '--api-allowed', 'true', '--slug', 'pandji'], ['ignore', 'inherit', 'inherit']);
  const code = await new Promise((resolve) => cli.on('exit', (exitCode) => resolve(exitCode ?? 1)));
  current = null;
  if (code === 0) return null;
  process.stderr.write(`e2e seed: profile-add --api-allowed exited ${code}\n`);
  return stopSignal ? signalExitCode(stopSignal) : 1;
}
```
  and in the startup sequence:
```js
const seedFailure = await seedProfile();
if (seedFailure !== null) await cleanupAndExit(seedFailure);
const allowFailure = await allowPandjiForApi();
if (allowFailure !== null) await cleanupAndExit(allowFailure);
if (stopSignal) await cleanupAndExit(signalExitCode(stopSignal));
```

`web/e2e/playwright.config.js` — add the project:
```js
    { name: 'api', testMatch: /api\.spec\.js/, dependencies: ['journey'] },
```
(`journey` first: on staging it leaves the account's ready cloned voice the API spec uses.)

`web/e2e/tests/journey.spec.js` line 44 comment becomes `// Leftovers of an earlier failed run must not eat the plan's voice limit.`

`web/e2e/staging/seed-lqstudio-user.mjs` — the gate account is Pro so the API spec can create a real key:
```js
  role: 'user',
  tier: 'pro', // the API spec creates a real key, which needs Pro (LQ-TTS public API)
```

Create `web/e2e/tests/api.spec.js`:
```js
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { assertLayout } from '../harness/layout.mjs';
import { TARGET, accessHeaders, apiCredentials } from '../target.mjs';
import { anonymousProbe, expect, test } from './fixtures.js';
import { enterTwoFactor } from './two-factor.js';

const SCRIPT = 'Halo, ini voiceover pertama dari LQ TTS API. Terima kasih sudah mencoba.';
const ARTIFACTS = new URL('../artifacts/api/', import.meta.url);

async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lq-tts' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  }, { method, path, body });
}

// Local webhook receiver; next() waits for the next POST.
async function startReceiver() {
  const hits = [];
  const waiters = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const hit = { headers: req.headers, body };
    res.writeHead(200).end('ok');
    const waiter = waiters.shift();
    if (waiter) waiter(hit);
    else hits.push(hit);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/lqtts-hook`,
    next: (ms) => (hits.length ? Promise.resolve(hits.shift()) : new Promise((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => reject(new Error(`no webhook within ${ms} ms`)), ms);
    })),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('api: key from the UI, voiceover through /v1, webhook or polling, download, delete, revoke', async ({ page, guard, baseURL }) => {
  const creds = apiCredentials();
  let signedIn = false;
  guard.expect((res) => !signedIn && anonymousProbe(res));
  mkdirSync(ARTIFACTS, { recursive: true });

  // 1. Sign in as a Pro account
  await page.goto('/login');
  await page.getByLabel('Email atau username', { exact: true }).fill(creds.identifier);
  await page.getByLabel('Kata sandi', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  if (creds.code) {
    await expect(page.getByRole('heading', { level: 1, name: 'Verifikasi dua langkah', exact: true })).toBeVisible();
    await enterTwoFactor(page, creds, guard);
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  signedIn = true;

  // 2. API page: revoke leftovers of an earlier failed run, create a key, read it from the one-time panel
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'API', exact: true })).toBeVisible();
  const before = await apiCall(page, 'GET', '/keys');
  for (const k of before.json.keys.filter((x) => x.name.startsWith('E2E '))) await apiCall(page, 'DELETE', `/keys/${k.id}`);
  await page.reload();
  const keyName = `E2E ${Date.now().toString(36)}`;
  await page.getByLabel('Nama kunci', { exact: true }).fill(keyName);
  await page.getByRole('button', { name: 'Buat kunci', exact: true }).click();
  const panel = page.getByTestId('new-key-panel');
  await expect(panel).toBeVisible();
  const key = (await panel.getByTestId('new-key-value').textContent()).trim();
  const webhookSecret = (await panel.getByTestId('new-webhook-secret').textContent()).trim();
  expect(key).toMatch(/^lqtts_[a-z2-7]{12}_[a-z2-7]{52}$/);
  expect(webhookSecret).toMatch(/^whsec_[a-z2-7]{52}$/);
  await page.screenshot({
    path: new URL('key-created-1440.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled',
    mask: [panel.getByTestId('new-key-value'), panel.getByTestId('new-webhook-secret')],
  });
  await panel.getByRole('button', { name: 'Sudah saya simpan', exact: true }).click();
  const row = page.getByTestId('api-key-row').filter({ hasText: keyName });
  await expect(row).toHaveCount(1);

  // 3. The curl-equivalent flow from Node (server to server: no cookies)
  const v1 = (method, path, body, headers = {}) => fetch(new URL(`/v1${path}`, baseURL), {
    method,
    headers: { authorization: `Bearer ${key}`, ...accessHeaders(), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect((await fetch(new URL('/v1/voices', baseURL), { headers: accessHeaders() })).status).toBe(401);
  const { voices } = await (await v1('GET', '/voices')).json();
  const voice = TARGET === 'local'
    ? voices.find((v) => v.kind === 'profile' && v.name === 'Pandji')
    : voices.find((v) => v.kind === 'own');
  expect(voice, `a usable voice among ${JSON.stringify(voices.map((v) => `${v.kind}:${v.name}`))}`).toBeTruthy();
  const chars = [...SCRIPT].length;
  expect(await (await v1('POST', '/estimate', { text: SCRIPT })).json()).toEqual({ chars, credits: Math.max(1, Math.ceil(chars / 100)), sentences: 2 });

  const receiver = TARGET === 'local' ? await startReceiver() : null;
  try {
    const idem = `e2e-${crypto.randomUUID()}`;
    const body = { voiceId: voice.id, text: SCRIPT, formats: ['mp3', 'srt'], ...(receiver ? { webhookUrl: receiver.url } : {}) };
    const created = await v1('POST', '/tts', body, { 'idempotency-key': idem });
    expect(created.status).toBe(202);
    const { jobId, credits, status } = await created.json();
    expect(status).toBe('queued');
    const replay = await v1('POST', '/tts', body, { 'idempotency-key': idem });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await replay.json()).jobId).toBe(jobId);

    // 4. Poll until done (both targets); locally the signed webhook arrives too
    let job;
    await expect.poll(async () => {
      job = await (await v1('GET', `/tts/${jobId}`)).json();
      return job.status;
    }, { timeout: 300_000, intervals: [2_000] }).toBe('done');
    expect(job).toMatchObject({
      jobId, credits, errorCode: null,
      files: { mp3: `/v1/tts/${jobId}/files/final.mp3`, srt: `/v1/tts/${jobId}/files/subtitles.srt` },
    });
    if (receiver) {
      const hit = await receiver.next(60_000);
      expect(hit.headers['lqtts-event']).toBe('job.done');
      const [, t, v1sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['lqtts-signature']);
      expect(crypto.createHmac('sha256', webhookSecret).update(`${t}.${hit.body}`).digest('hex')).toBe(v1sig);
      expect(JSON.parse(hit.body)).toMatchObject({ event: 'job.done', jobId, status: 'done', credits, files: job.files });
    }

    // 5. Download under the public names
    const mp3 = await v1('GET', `/tts/${jobId}/files/final.mp3`);
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
    expect((await mp3.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    expect(await (await v1('GET', `/tts/${jobId}/files/subtitles.srt`)).text()).toContain(' --> ');

    // 6. The web app shows it: History chip, and locally the delivered webhook on the API page
    await page.getByRole('link', { name: 'Riwayat', exact: true }).click();
    await expect(page.locator(`[data-testid="history-row"][data-job-id="${jobId}"]`).getByTestId('api-chip')).toHaveText('API');
    await page.getByRole('link', { name: 'API', exact: true }).click();
    if (receiver) await expect(page.getByTestId('delivery-row').first()).toHaveAttribute('data-state', 'delivered');
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expect(page.locator('[data-skeleton]')).toHaveCount(0);
      await assertLayout(page, vp);
      await page.screenshot({ path: new URL(`api-page-${vp.name}.png`, ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });
    }
    await page.goto('/developers');
    await expect(page.getByRole('heading', { level: 1, name: 'Dokumentasi API LQ TTS', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await assertLayout(page, { width: 390 });
    await page.screenshot({ path: new URL('docs-390.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await assertLayout(page, { width: 1440 });
    await page.screenshot({ path: new URL('docs-1440.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });

    // 7. Delete through the API (a done job is deleted, its charge stays settled)
    expect((await v1('DELETE', `/tts/${jobId}`)).status).toBe(204);
    expect((await v1('GET', `/tts/${jobId}`)).status).toBe(404);
  } finally {
    await receiver?.close();
  }

  // 8. Revoke in the UI; the key stops at once
  await page.goto('/api-keys');
  await row.getByRole('button', { name: `Cabut kunci ${keyName}`, exact: true }).click();
  await page.getByTestId('api-key-confirm').getByRole('button', { name: 'Cabut kunci', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await v1('GET', '/voices')).status).toBe(401);
});
```

- [ ] **Step 2: Run the local gate**

Run (mac-studio, needs the built client):
```bash
cd ~/Developer/LQ-TTS-api/web/client && npx vite build
cd ~/Developer/LQ-TTS-api/web/e2e && npx playwright test --project=journey --project=screens --project=smoke --project=api 2>&1 | tail -n 15
```
Expected: `6 passed`. The API spec's console/network guard stays clean (the only expected non-2xx is the anonymous `/api/me` probe before login); the run leaves `artifacts/api/key-created-1440.png` (key and secret masked), `api-page-1440.png`, `api-page-390.png`, `docs-390.png`, `docs-1440.png`. Look at all five (SOP G5): no horizontal overflow, nav shows five items at 390 px, the one-time panel is visibly distinct, the deliveries table shows `Terkirim`. On failure read `web/e2e/report/index.html`, fix, rerun.

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/LQ-TTS-api
git add web/e2e/target.mjs web/e2e/harness/run-server.mjs web/e2e/playwright.config.js web/e2e/tests/api.spec.js \
  web/e2e/tests/journey.spec.js web/e2e/staging/seed-lqstudio-user.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/e2e: API spec (key via UI, /v1 flow, local signed webhook, staging polling), Pro gate account"
```
(`web/e2e/artifacts/`, `report/` and `test-results/` are gitignored by `web/e2e/.gitignore`; never stage them.)

---
## Release (controller)

Run by the controller only. All commands on mac-studio with the PATH export from Global Constraints. Never print `.env` contents, `~/.config/lq-tts/*`, tokens, keys or `API_ENC_KEY`. Release A runs as soon as Task 1 is reviewed (Task 12 needs it); Release B runs after Tasks 2-12 are reviewed and the local gate (Task 12 Step 2) passed.

### Release A: engine first

1. **Fast-forward the live checkout to Task 1 only.** The engine runs from `~/Developer/LQ-TTS`; `main` gets the spec, this plan and the engine commit, nothing of the web.
   ```bash
   cd ~/Developer/LQ-TTS
   git status --porcelain                       # expect: empty
   TASK1_SHA=$(git log feat/public-api --format=%H --grep='engine: optional per-caller job priority' -1)
   git log --oneline main..$TASK1_SHA           # expect: the spec commit, the plan commit, the Task 1 commit
   git tag pre-public-api main
   git merge --ff-only "$TASK1_SHA"
   ```
2. **Config preflight** (new optional `LQTTS_PRIORITY_RANGES`):
   ```bash
   cd ~/Developer/LQ-TTS/engine
   .venv/bin/python -c "from lq_tts_engine.config import load_config; c = load_config(); print('callers', sorted(set(c.tokens.values())), 'ranges', c.priority_ranges)"
   ```
   Expected: `callers ['lq-studio', 'lq-tts', 'lq-tts-stg'] ranges {}`. A `ValueError` names the key and caller only; fix the engine `.env` first.
3. **Busy gate.** Restart only when nothing is queued, running or preparing:
   ```bash
   cd ~/Developer/LQ-TTS/engine
   .venv/bin/python - <<'PY'
   import psycopg
   from lq_tts_engine.config import load_config
   c = load_config()
   with psycopg.connect(c.database_url) as k:
       jobs = k.execute("SELECT count(*) FROM lq_tts_engine.jobs WHERE status IN ('queued','running')").fetchone()[0]
       voices = k.execute("SELECT count(*) FROM lq_tts_engine.voices WHERE status = 'processing' AND deleted_at IS NULL").fetchone()[0]
   print(f"busy jobs={jobs} voices={voices}")
   PY
   ```
   Expected: `busy jobs=0 voices=0`; otherwise wait and re-run. (Jobs queued before the restart keep priority 0; with the gate there are none.)
4. **Restart the two engine apps, then health.**
   ```bash
   pm2 restart lq-tts-engine-api lq-tts-engine-worker
   for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8740/v1/health)" = 200 ] && break; sleep 5; done
   curl -s http://127.0.0.1:8740/v1/health; echo
   pm2 logs lq-tts-engine-worker --lines 30 --nostream | grep -E '"worker ready"|Error' | tail -n 3
   ```
   Expected: `{"model_loaded":true,...}` and a `worker ready` line, no `Error`.
5. **Callers check and the new field** (status codes and caller names only; the voice id is random, so no job is created):
   ```bash
   cd ~/Developer/LQ-TTS/engine
   .venv/bin/python - <<'PY'
   import uuid
   import httpx
   from lq_tts_engine.config import load_config
   for token, caller in load_config().tokens.items():
       h = {"Authorization": f"Bearer {token}"}
       v = httpx.get("http://127.0.0.1:8740/v1/voices", params={"owner_ref": "release-probe"}, headers=h, timeout=10)
       j = httpx.post("http://127.0.0.1:8740/v1/jobs", headers=h, timeout=10,
                      json={"voice_id": str(uuid.uuid4()), "text": "probe", "priority": 1})
       print(caller, v.status_code, j.status_code, j.json()["error"]["code"])
   PY
   for c in lq-tts-web-stg lq-tts-web-prod; do docker exec $c node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json()).then((b) => console.log('$c', b.engine))"; done
   ```
   Expected: `lq-tts 200 404 not_found`, `lq-studio 200 404 not_found`, `lq-tts-stg 200 404 not_found` (404 for the random voice proves `priority` is accepted; the old engine answered 400); `lq-tts-web-stg ok`, `lq-tts-web-prod ok` (the deployed web image still works: it sends no priority and gets 5).
   Rollback (same busy gate first): `cd ~/Developer/LQ-TTS && git switch --detach pre-public-api && pm2 restart lq-tts-engine-api lq-tts-engine-worker`, then `git switch main` once fixed.

### Release B: web on staging, gate, PROD

6. **Merge the rest.**
   ```bash
   cd ~/Developer/LQ-TTS
   git status --porcelain                       # expect: empty
   git merge --ff-only feat/public-api
   git log --oneline -1                         # expect: the Task 12 commit
   ```
7. **`API_ENC_KEY` per environment** (a different value in each file; generated straight into the file, never shown). Check first; set only when missing, because replacing an existing value makes every sealed webhook secret unreadable:
   ```bash
   cd ~/Developer/LQ-TTS/web
   for env in stg prod; do node ops/env-check.mjs ~/.config/lq-tts/web-$env.env API_ENC_KEY; done
   ```
   Expected on first release: `ok mode 600` and `MISSING API_ENC_KEY` for each. Then, for each file that said `MISSING`:
   ```bash
   openssl rand -base64 32 | node ops/env-set.mjs ~/.config/lq-tts/web-stg.env API_ENC_KEY
   openssl rand -base64 32 | node ops/env-set.mjs ~/.config/lq-tts/web-prod.env API_ENC_KEY
   for env in stg prod; do node ops/env-check.mjs ~/.config/lq-tts/web-$env.env API_ENC_KEY; done
   ```
   Expected: `API_ENC_KEY written to ... (value hidden, 44 chars)` twice, then `ok mode 600` and `ok API_ENC_KEY (44 chars)` for both. Never set `WEBHOOK_ALLOW_LOOPBACK` in these files (the server refuses it with Secure cookies anyway).
8. **Build and start staging.**
   ```bash
   cd ~/Developer/LQ-TTS/web
   docker image inspect lq-tts-web:stg >/dev/null 2>&1 && docker tag lq-tts-web:stg lq-tts-web:stg-prev
   ops/build-image.sh stg
   docker compose up -d stg
   docker inspect -f '{{.State.Health.Status}}' lq-tts-web-stg     # repeat until: healthy
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8750/v1/voices                          # 401
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8750/api                # 302 http://127.0.0.1:8750/api-keys
   psql -d lq_tts -Atc "SELECT name FROM lq_tts_web_stg.schema_migrations ORDER BY name DESC LIMIT 1"  # 007_public_api.sql
   ```
   Staging rollback: `docker tag lq-tts-web:stg-prev lq-tts-web:stg && docker compose up -d stg` (migration 007 only adds tables and columns; the previous image ignores them).
9. **Re-seed the staging gate account as Pro** (run on lq-server, exactly as plan 2C Task 14 Step 2; the seed script now sets `tier: 'pro'` and rotates the password and TOTP secret):
   ```bash
   set -o pipefail
   ssh mac-studio 'cat ~/Developer/LQ-TTS/web/e2e/staging/seed-lqstudio-user.mjs' \
     | docker exec -i -w /app lq-studio-stg-lqs node --input-type=module - \
     | ssh mac-studio 'umask 077; cat > ~/.config/lq-tts/e2e-staging.env && wc -l < ~/.config/lq-tts/e2e-staging.env'
   ```
   Expected: `3`. Then on mac-studio `cd ~/Developer/LQ-TTS/web && node ops/env-check.mjs ~/.config/lq-tts/e2e-staging.env LQTTS_E2E_IDENTIFIER LQTTS_E2E_PASSWORD LQTTS_E2E_TOTP_SECRET` → `ok` ×4.
10. **Staging gate with the API smoke.** Open the temporary Cloudflare Access service-token door and run the gate exactly as plan 2C Task 14 Steps 3 and 4 (`docs/superpowers/plans/2026-10-03-web-2c-client-release.md`), with the projects list extended by `--project=api`:
    `E2E_TARGET=staging-public npx playwright test --project=journey --project=screens --project=smoke --project=api`. Close the door afterwards (always, pass or fail) and delete `web/e2e/test-results`.
    Expected: `6 passed`. The `api` test is the staging API smoke: it signs in as the Pro gate account, creates a real staging key through the UI, lists voices, estimates, creates an idempotent voiceover with the account's own cloned voice, polls it to `done`, downloads MP3 and SRT, deletes it through `/v1`, revokes the key in the UI and proves the key answers 401. Its screenshots land in `web/e2e/artifacts/api/` (key and secret masked).
11. **Money moved exactly once on staging:**
    ```bash
    psql -d lq_tts -Atc "SELECT source, state, count(*) FROM lq_tts_web_stg.charges WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2 ORDER BY 1, 2"
    psql -d lq_tts -Atc "SELECT count(*) FROM lq_tts_web_stg.charges WHERE state = 'held' AND created_at < now() - interval '5 minutes'"
    ```
    Expected: an `api|settled|1` row next to the journey's web rows, and `0` stale holds.
12. **Promote the same image to PROD.**
    ```bash
    cd ~/Developer/LQ-TTS/web
    docker image inspect lq-tts-web:prod >/dev/null 2>&1 && docker tag lq-tts-web:prod lq-tts-web:prod-prev
    docker tag lq-tts-web:stg lq-tts-web:prod
    docker compose --profile prod up -d prod
    docker image inspect -f '{{.Id}}' lq-tts-web:stg lq-tts-web:prod   # two identical ids
    docker inspect -f '{{.State.Health.Status}}' lq-tts-web-prod      # repeat until: healthy
    ```
13. **PROD smoke (no paid API job without lqmnah's own account).**
    ```bash
    docker exec lq-tts-web-prod node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json()).then(console.log)"
    cd ~/Developer/LQ-TTS/web/e2e && E2E_TARGET=prod npx playwright test --project=smoke; cd ..
    curl -s https://tts.lq-studio.com/v1/voices; echo                                                  # {"error":{"code":"unauthorized",...}}
    curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://tts.lq-studio.com/api             # 302 https://tts.lq-studio.com/api-keys
    curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://tts.lq-studio.com/developers      # 200 text/html; charset=UTF-8
    docker exec lq-tts-web-prod node server/cli/profile-add.js --list                                   # pandji line without " api"
    ```
    Expected: `{ engine: 'ok', lqstudio: 'ok', ... }`; smoke `1 passed`; the three curl answers as commented; Pandji not API-allowed. A paid end-to-end API job on PROD happens only when lqmnah runs it with his own account.
    PROD rollback: `docker tag lq-tts-web:prod-prev lq-tts-web:prod && docker compose --profile prod up -d prod`.
14. **Publish and record.** Push `main` per SOP G8 (no Claude attribution: `git push origin main`, then `git ls-remote origin main` equals `git rev-parse main`). Write the brain note `~/brain/lq-tts-public-api-2026-10-04.md` (what shipped, decisions 1-20 in one line each, merged SHAs, engine/web/client test counts, Release A probe, staging gate 6/6, PROD smoke) and close the task with `python3 ~/brain/_brain/bin/brain-task.py done "lq-tts public api" --bukti "<SHA>, gate 6/6, PROD smoke 1/1"`, then `git -C ~/brain pull --rebase --autostash && bash ~/brain/_brain/bin/brain-push.sh`. After PROD has run clean for a day: `git tag -d pre-public-api`, remove the worktree (`rm ~/Developer/LQ-TTS-api/engine/.env ~/Developer/LQ-TTS-api/web/.env ~/Developer/LQ-TTS-api/web/.env.stg`, `git -C ~/Developer/LQ-TTS-api status --porcelain` must be empty, then `git worktree remove --force ~/Developer/LQ-TTS-api`; only ignored `node_modules`/`.venv` remain to be forced), and `git branch -d feat/public-api`.

---

## Self-review

Spec coverage (every requirement has a task and a proof):

| Spec | Requirement | Task | Proof |
|---|---|---|---|
| §1 | key on `tts.lq-studio.com/api` | 3, 5, 10 | `/api` → 302 `/api-keys` (v1-auth), ApiPage tests, e2e step 2 |
| §1 | list voices, create, webhook or poll, download MP3/WAV/SRT/VTT | 5, 7, 8, 12 | v1-auth voices, v1-jobs, webhooks, e2e steps 3-5 |
| §1 | credits move exactly once | 4, 7, 8 | v1-jobs create/402/cancel/delete, callback/reconcile reuse, staging money check |
| §1 | web never starved by API | 1, 4, 7 | engine ordering tests, priority 5/1 asserted in jobs/v1-jobs |
| §1 | key stops ≤ 5 min after password change/suspension/downgrade, at once on revoke | 3, 5 | v1-auth tv/suspended/plan/cache tests, api-keys revoke, e2e step 8 |
| §2.1 | table columns, key format, hash + constant-time, sealed webhook secret, shown once | 2, 3 | migration, api-keys tests |
| §2.1 | Pro+ only, max 5 | 3 | `refuses a key to a free plan`, limit and race tests |
| §2.1 | per-request user check, revocation rules, last_used once a minute | 5 | v1-auth |
| §2.2 | six endpoints, shapes, error shape | 5, 7 | v1-auth, v1-jobs |
| §2.2 | Idempotency-Key ≤ 100 chars, 24 h, per account | 7 | idempotency tests |
| §2.2 | jobs in web History labelled API | 4, 10 | `source` in summary, History chip test, e2e step 6 |
| §2.2 | voiceId own ready or API-allowed active profile, else 404 | 7 | voices test (Decision 8 for processing → 409) |
| §2.2 | validation exactly as `POST /api/jobs` | 4, 7 | shared `readJobInput`, validation test |
| §2.3 | charges reused, `source='api'`, 402 with balance + topupUrl | 2, 4, 7 | errors test, 402 test |
| §2.4 | ≤ 2 jobs, 60/min, 20,000 chars | 5, 7 | cap, race, rate tests, `too_large` |
| §2.4 | engine priority clamp, web 5 / API 1 / regen 10, starvation 10 min | 1, 4, 7 | engine tests, call-body asserts |
| §2.5 | https/443/≤500/no userinfo, public IPs only, re-resolve + pin, no redirects | 6, 8 | SSRF matrix, send-time block test, redirect test |
| §2.5 | events, body, signature headers | 6, 8 | signature vector, done/failed tests, e2e signature check |
| §2.5 | outbox 0/1/5/30 min, 10 s, 2xx, dropped, last 20 per key, polling always | 8 | retry, timeout, list tests |
| §2.6 | `api_allowed` column, CLI flag, Pandji false | 2, 9, Release 13 | db test, CLI test, PROD `--list` |
| §2.7 | API page states, one-time panel, deliveries, docs link | 10 | ApiPage tests, e2e screenshots |
| §2.7 | public docs page (auth, endpoints, Node/Python verify, errors, limits, curl) | 11 | DevelopersPage tests, e2e screenshots |
| §3 | `API_ENC_KEY` separate per env, no cookies on `/v1`, body limit, audit logs, no secrets in logs | 2, 3, 5, Release 7 | config test, cookie tests, log assertions |
| §4 | test list | 1-12 | as above |
| §5 | release order engine → staging + gate + API smoke → PROD → smoke → brain + push | Release A, B | steps 1-14 |

Placeholder scan: no TBD/TODO/"similar to"; every code step carries its code; illustrative values (`JOB_ID`, `VOICE_ID`, the shortened signature in the webhook example) appear only inside the public docs samples, where they are the documented placeholders.

Name consistency (defined once, reused verbatim): `priority_for`, `DEFAULT_PRIORITY`, `_rank`, `STARVED_AFTER_S`; `parseEncKey`, `seal`, `open`, `base32`; `createApiKeys` (`create/list/revoke/autoRevoke/find/touch/webhookSecret`), `parseApiKey`, `hashSecret`, `toApiKey`; `PRIORITY`, `readText`, `readJobInput`, `queueVoiceover`; `createApiAccounts` (`get`, `cache`), `createRateLimiter` (`hit`, `reset`, `limit`), `requireApiKey` (`req.apiKey`, `req.apiUserId`); `resolveWebhookUrl`, `WebhookUrlError`, `isPublicAddress`, `signWebhook`; `createApiJobs` (`reserve/claimKey/keyJob/bindKey/releaseKey`), `API_FILES`, `apiFiles`, `toApiJob`, `readIdempotencyKey`; `createJobControl` (`withLease/engineView/cancel/remove`), `busy`; `createWebhooks` (`onTerminal/runOnce/kick/start/stop/listForUser`); context keys `apiKeys`, `apiAccounts`, `apiLimiter`, `jobControl`, `apiJobs`, `webhooks`; harness `h.apiKey`, `h.api`, `USERS.cici`, `API_ENC_KEY`.

Tests added: engine +5; web server +1 (Task 4) +9 (Task 2) +12 (Task 3) +13 (Task 5) +56 (Task 6) +15 (Task 7) +9 (Task 8) +5 (Task 9) = +120, in 6 new test files and 6 changed ones (plus the harness); client +9 (Task 10) +2 (Task 11); e2e gate 5 → 6.
