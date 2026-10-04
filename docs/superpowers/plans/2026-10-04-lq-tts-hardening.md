# LQ-TTS Hardening (engine backlog + web deferred minors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every still-open item of the engine "FIX SOON" backlog and the web deferred minors that were handed to this round, each behavioural fix proven by a test that fails first, then ship engine and web without dropping a single live job.

**Architecture:** Small, local fixes in the files that own each behaviour: the worker loop (`engine/lq_tts_engine/worker.py`, `pipeline.py`, `retention.py`), the FastAPI app (`api/app.py`) plus one pure-ASGI body-limit middleware, the callback sender and its config (`callbacks.py`, `config.py`), the text front end (`text/split.py`, `subs.py`), and on the web side `config.js`, `lib/errors.js`, `routes/auth.js`, `routes/job-actions.js`, `services/reconcile.js`. No new services, no schema migrations, no new dependencies. Callback SSRF protection is an allowlist: loopback always, plus optional per-caller hosts from a new optional env key `LQTTS_CALLBACK_HOSTS`; every caller in use today posts loopback URLs, so no env change is needed to ship.

**Tech Stack:** Python 3.12, FastAPI/Starlette, psycopg 3, httpx, pytest (uv); Node 26 ESM, Express 5, pg 8, Vitest 5 + supertest; pm2 (engine), Docker compose (web) on mac-studio.

**Spec / requirements:** no design doc; the requirements are two backlogs, re-verified against `main` 4fa80a0 in the table below:
- Engine: `~/brain/lq-tts-engine-2026-10-02.md` § "Backlog (FIX SOON …)" items 1-13 (lq-server), detail in `~/brain/lq-tts-engine-sdd-ledger-2026-10-02.md` (Task 6/7/9/10/11/12/13 minors, "Final: parked" lines). Callback contract: `docs/superpowers/specs/2026-10-02-voice-engine-design.md` §5.6.
- Web: `.superpowers/sdd/2026-10-03-web-2b-server/progress.md` and `.superpowers/sdd/2026-10-03-vo-profiles/progress.md` (lines marked `deferred`).

## Verified status (against `main` 4fa80a0, 2026-10-04)

| # | Item | Still present? | Evidence (file:line on 4fa80a0) |
|---|---|---|---|
| E1 | worker DELETE race between `finish_job` and re-read → `fresh None` TypeError | yes | `engine/lq_tts_engine/worker.py:118-124` (`fresh["status"]` read when `fresh is None`) |
| E2 | `_is_device_error` matches substring `mps` ("timestamps") → false exit(3) | yes | `worker.py:33-35` (`marker in text`) |
| E3 | empty Idempotency-Key → 500 on 2nd job; replay after disk/voice checks | yes | `api/app.py:219,230-232` gates run before `repo.create_job` (`app.py:236`); `repo.py:95` skips lookup for `""` but `repo.py:112` stores it |
| E4 | callbacks: validate `callback_url` at POST, secret per token, catch all + log "dropped" | yes | `app.py:58` (any string), `callbacks.py:46` (`self.secrets[caller]` KeyError), `callbacks.py:52` (only `httpx.HTTPError`), `config.py:51` (no coverage check) |
| E5 | purge takes `FileNotFoundError` racing DELETE | yes | `retention.py:14-17` (glob → `stat` → `unlink`, no guard) |
| E6 | in-flight sentence left `running` when the job fails | yes | `pipeline.py:160-165` (reset only on `Canceled`) |
| E7 | SRT/VTT text escaping (`<`, `-->`) | yes | `subs.py:21-28` (`c.text` written raw) |
| E8 | Starlette HTTPException handler; ffprobe timeout; orphan voice folder | yes (all three) | `app.py:81-89` (only `ApiError` + validation handlers), `app.py:45-49` (no `timeout=`), `app.py:120-137` (`create_voice` outside any cleanup) |
| E9 | caller-isolation tests list/preview/delete; stale-heartbeat 503 test | yes | `engine/tests/test_api_voices.py:90` checks only `GET /v1/voices/{id}` with the other token; `test_api_voices.py:96-102` has no stale case |
| E10 | duplicate token in config silently remaps caller | yes | `config.py:50` (dict inversion), `config.py:19` (duplicate caller overwrites) |
| E11 | sentence unit length cap (20k chars, no punctuation = one unit) | yes | `text/split.py:83-84` (merged units appended uncapped) |
| E12 | remove `Repo.soft_delete_voice` (tests only) | yes | `repo.py:51-55`; used only by `tests/test_pipeline.py:109`, `tests/test_worker.py:145,154`, `tests/test_repo_store.py:27` |
| E13 | request size limits, callback SSRF, constant-time token compare | yes | `app.py:112-130` (multipart fully parsed before the size check; JSON unbounded), `app.py:58`, `app.py:93` (`cfg.tokens.get(token)`) |
| W1 | numeric env validation in `config.js` (RECONCILE done) | yes for `PORT`, `MAX_UPLOAD_BYTES` | `web/server/config.js:36,50` (`Number(...)`, NaN accepted); `RECONCILE_INTERVAL_MS` validated at `config.js:16-22` |
| W2 | errorHandler: charset/encoding/aborted body errors; headersSent branch test | yes | `web/server/lib/errors.js:42-47` (only parse/too-large mapped); no test references `headersSent`/`errorHandler` |
| W3 | new login revokes the session cookie it replaced | yes | `web/server/routes/auth.js:14-30` (`startSession` never reads the old cookie) |
| W4 | reconcile `'2 minutes'` literal → `HELD_MIN_AGE_MS` | yes | `web/server/services/reconcile.js:25` vs `services/charges.js:5` |
| W5 | cancel right after a regenerate 202 may 409 | yes, cheap → **fix** | `web/server/routes/job-actions.js:103` answers inside `withLease`; release runs later in `finally` (`:26-30`) |
| W6 | pin: regenerate after profile deactivation | yes (untested) | `web/server/test/voice-profiles.test.js:125-134` covers preview/create only |
| W7 | pin: `voice_profiles` CHECKs gender/language/13 tags/name length | yes (partly pinned) | `test/profiles.test.js:80-91` pins slug, empty and non-array tags only; constraints in `db/migrations/006_voice_profiles.sql:3-8` |
| W8 | pin: failed-profile list item | yes (untested) | no `failed` case in `test/voice-profiles.test.js` |
| W9 | remove unused export `toProfile` | yes | `web/server/routes/voice-profiles.js:4` (`export`, no importer) |
| W10 | `/api/me` outage retries LQ-Studio on every call | **no — already fixed, dropped** | `web/server/services/accounts.js:33-37` (`deferRefresh`, `OUTAGE_RETRY_MS`), `http/middleware.js:45`; final-review fix 392e7bd; `test/auth.test.js:159` |

Totals: 23 items checked, 22 still present (13 engine + 9 web), 1 already fixed (W10, dropped).

Not in this plan (skipped with reason): web-2b Task 7 fake-engine fidelity minors (test fake only, "no web branch depends"); web-2b Task 8 `pg_try_advisory_lock` → lease (accepted ruling); vo-profiles "signal during the upload itself" (accepted); engine ledger minors outside backlog items 1-13 (ACCEPT in the final triage).

## Global Constraints

- Every command runs on **mac-studio**. Non-interactive ssh needs `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH"` first (uv, node, npx, docker, pm2 live there).
- Work happens only in the worktree **`~/Developer/LQ-TTS-hardening`** on branch `fix/hardening` (created from `main` 4fa80a0). Never edit, switch or reset **`~/Developer/LQ-TTS`**: pm2 runs the live engine (`lq-tts-engine-api`, `lq-tts-engine-worker`) from that checkout, so a crash-restart there must always load `main`.
- The worktree's `engine/.env` and `web/.env` are symlinks to the main checkout's files (gitignored, already in place). Never `cat`/`echo`/print them, a token or a secret; error messages added by this plan name keys and callers, never values.
- Engine tests: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q <paths>` (the default `-m 'not slow'` comes from `pyproject.toml`; the worktree has its own `.venv` without the ML extra, which these tests do not need). Baseline: `151 passed, 1 deselected`.
- Web tests: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run <paths>` (reads `TEST_DATABASE_URL` from `web/.env`). Baseline: `Test Files 19 passed (19)`, `Tests 243 passed (243)`.
- Tasks never restart pm2 apps or containers and never touch PROD; only the Release section does, run by the controller.
- Commits: stage explicit paths only, then `git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "..."`. No `Co-Authored-By`, no Claude/Anthropic/AI wording anywhere (SOP G8).
- Engine API error shape stays `{"error": {"code": ..., "message": ...}}`; new codes introduced here: `invalid_callback_url` (400), `method_not_allowed` (405). Web error shape stays `{ error: { code, message } }`.
- Callers in use today (engine `.env`): `lq-tts` (PROD web, callbacks `http://127.0.0.1:8751/api/internal/engine-callback`), `lq-tts-stg` (staging web, `http://127.0.0.1:8750/...`), `lq-studio`; the local e2e server posts `http://127.0.0.1:8760/...`. All are loopback, so the new allowlist needs no `LQTTS_CALLBACK_HOSTS` entry. All three callers already have a callback secret.

---

## File Structure

| Path | Status | Responsibility / change |
|---|---|---|
| `engine/lq_tts_engine/worker.py` | modify | `fresh is None` early return; word-boundary device-error check |
| `engine/lq_tts_engine/pipeline.py` | modify | reset the in-flight sentence on any exception |
| `engine/lq_tts_engine/retention.py` | modify | purge tolerates files/folders removed mid-pass |
| `engine/lq_tts_engine/api/app.py` | modify | idempotent replay first + empty key ignored; HTTPException handler; ffprobe timeout; voice folder cleanup; `BodyLimit` middleware; constant-time `caller_for`; `callback_url` allowlist check |
| `engine/lq_tts_engine/repo.py` | modify | `find_idempotent_job`; remove `soft_delete_voice` |
| `engine/lq_tts_engine/callbacks.py` | modify | `callback_url_allowed`; `deliver` never raises, always logs "dropped" |
| `engine/lq_tts_engine/config.py` | modify | `callback_hosts`; secret required per caller; duplicate caller/token fail at startup |
| `engine/lq_tts_engine/subs.py` | modify | cue text escaping |
| `engine/lq_tts_engine/text/split.py` | modify | `MAX_UNIT_CHARS` cap on units |
| `engine/tests/test_worker.py`, `test_pipeline.py`, `test_callbacks_retention.py`, `test_api_jobs.py`, `test_api_voices.py`, `test_config_settings.py`, `test_finish_subs.py`, `test_split.py`, `test_repo_store.py` | modify | failing-first tests, pins, `soft_delete_voice` → `delete_voice_cascade` |
| `web/server/config.js` | modify | `wholeNumber` for `PORT`, `MAX_UPLOAD_BYTES`, `RECONCILE_INTERVAL_MS` |
| `web/server/lib/errors.js` | modify | body-parser error table |
| `web/server/routes/auth.js` | modify | revoke the replaced session on login |
| `web/server/routes/job-actions.js` | modify | answer regenerate after the lease is released |
| `web/server/services/reconcile.js` | modify | use `HELD_MIN_AGE_MS` |
| `web/server/routes/voice-profiles.js` | modify | `toProfile` no longer exported |
| `web/server/test/config.test.js`, `auth.test.js`, `job-actions.test.js`, `profiles.test.js`, `voice-profiles.test.js` | modify | failing-first tests and pins |
| `web/server/test/errors.test.js` | create | errorHandler unit tests |

---

### Task 1: Engine worker robustness (backlog 1, 2, 5, 6)

**Files:**
- Modify: `engine/lq_tts_engine/worker.py:1-35` (imports, `_is_device_error`), `worker.py:118-124` (`handle_job` tail)
- Modify: `engine/lq_tts_engine/pipeline.py:159-165` (`run_job` inner try)
- Modify: `engine/lq_tts_engine/retention.py:1-19`
- Test: `engine/tests/test_worker.py`, `engine/tests/test_pipeline.py`, `engine/tests/test_callbacks_retention.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `worker._is_device_error(exc) -> bool` (same signature, word-boundary match); `retention.purge_unreferenced_takes(data_dir, referenced, *, older_than_s, now) -> int` (same signature).

- [ ] **Step 1: Write the failing tests**

In `engine/tests/test_worker.py` add `import shutil` to the imports at the top and change line 10 to:

```python
from lq_tts_engine.worker import _is_device_error, handle_job, handle_voice
```

Append to `engine/tests/test_worker.py`:

```python


def test_device_error_check_matches_whole_words_only():
    assert _is_device_error(RuntimeError("MPS backend out of memory"))
    assert _is_device_error(RuntimeError("Metal command buffer failed"))
    assert _is_device_error(RuntimeError("Invalid buffer size on mps:0"))
    assert not _is_device_error(ValueError("word timestamps are not monotonic"))
    assert not _is_device_error(TypeError("json dumps failed"))


def test_error_mentioning_timestamps_fails_the_job_without_exiting(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=ValueError("bad timestamps")))
    handle_job(job, deps, Recorder(), device="mps")
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "internal_error")


def test_job_purged_between_finish_and_reread_ends_quietly(repo, ready_voice, tmp_path, monkeypatch):
    deps, job = make(repo, ready_voice, tmp_path)
    finish = repo.finish_job

    def finish_then_api_delete(job_id, seconds):
        finish(job_id, seconds)
        # DELETE /v1/jobs/{id} sees a finished job and purges it on the spot (folder first, then the row).
        repo.delete_job("lq-tts", job_id)
        shutil.rmtree(job_dir(deps.data_dir, job_id), ignore_errors=True)
        repo.purge_job(job_id)

    monkeypatch.setattr(repo, "finish_job", finish_then_api_delete)
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    assert repo.get_job_any(job["id"]) is None
    assert rec.sent == []
```

Append to `engine/tests/test_pipeline.py`:

```python


def test_failed_job_leaves_no_sentence_running(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=ValueError("boom")))
    with pytest.raises(ValueError):
        run_job(job, deps, should_stop=never)
    assert [s["status"] for s in repo.list_sentences(job["id"])] == ["pending"] * len(split_script(TEXT))
```

In `engine/tests/test_callbacks_retention.py` add `from pathlib import Path` after `import time`, then append:

```python


def test_purge_skips_takes_deleted_mid_purge(tmp_path, monkeypatch):
    takes = tmp_path / "jobs" / "j1" / "takes"
    takes.mkdir(parents=True)
    gone, kept = takes / "s0000_r1_t1.wav", takes / "s0001_r1_t1.wav"
    eight_days_ago = time.time() - 8 * 86400
    for p in (gone, kept):
        p.write_bytes(b"x")
        os.utime(p, (eight_days_ago, eight_days_ago))
    real_stat = Path.stat

    def racing_stat(self, *args, **kwargs):
        if self == gone and os.path.exists(gone):
            os.unlink(gone)  # DELETE /v1/jobs removes the folder while the purge runs
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", racing_stat)
    assert purge_unreferenced_takes(tmp_path, set()) == 1
    assert not os.path.exists(kept)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q tests/test_worker.py tests/test_pipeline.py tests/test_callbacks_retention.py`
Expected: 5 failed — `test_device_error_check_matches_whole_words_only` (assert on "timestamps"), `test_error_mentioning_timestamps_fails_the_job_without_exiting` (`SystemExit: 3`), `test_job_purged_between_finish_and_reread_ends_quietly` (`TypeError: 'NoneType' object is not subscriptable`), `test_failed_job_leaves_no_sentence_running` (`['running', 'pending']` != `['pending', 'pending']`), `test_purge_skips_takes_deleted_mid_purge` (`FileNotFoundError`); the rest pass.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/worker.py`: add `import re` after `import json`, then replace `_is_device_error` (lines 33-35) with:

```python
_DEVICE_ERROR = re.compile(r"\b(?:mps|metal)\b|out of memory")


def _is_device_error(exc: BaseException) -> bool:
    """MPS/Metal/OOM failures only; whole words, so "timestamps" or "dumps" never match."""
    return _DEVICE_ERROR.search(f"{type(exc).__name__}: {exc}".lower()) is not None
```

In `handle_job`, replace lines 118-119:

```python
    fresh = repo.get_job_any(job["id"])
    if fresh is not None and fresh["deleted_at"] is not None:
```

with:

```python
    fresh = repo.get_job_any(job["id"])
    if fresh is None:  # a DELETE after finish_job saw a finished job and purged it itself
        log.info("job deleted after it finished; already purged", extra=ctx)
        return
    if fresh["deleted_at"] is not None:
```

`engine/lq_tts_engine/pipeline.py`: replace lines 160-165 (the inner `try`/`except Canceled`) with:

```python
            try:
                process_sentence(job, sentence, voice, deps, should_stop)
            except Exception:
                # Canceled, failed or device error: the in-flight sentence never stays "running".
                deps.repo.save_sentence(job["id"], sentence["idx"], status="pending", takes=0, score=None,
                                        asr_text=None, audio_path=sentence["audio_path"], duration_s=sentence["duration_s"])
                raise
```

`engine/lq_tts_engine/retention.py`: replace `purge_unreferenced_takes` with:

```python
def _entries(folder: Path) -> list[Path]:
    try:
        return list(folder.iterdir())
    except (FileNotFoundError, NotADirectoryError):  # removed by a DELETE mid-pass, or not a folder
        return []


def purge_unreferenced_takes(data_dir: Path, referenced: set[str], *, older_than_s: float = SEVEN_DAYS_S,
                             now: float | None = None) -> int:
    now = time.time() if now is None else now
    removed = 0
    for job in _entries(data_dir / "jobs"):
        for path in _entries(job / "takes"):
            if path.suffix != ".wav":
                continue
            try:
                if str(path) in referenced or now - path.stat().st_mtime < older_than_s:
                    continue
                path.unlink()
            except FileNotFoundError:  # its job was deleted while this pass ran
                continue
            removed += 1
    return removed
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q`
Expected: `156 passed, 1 deselected`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add engine/lq_tts_engine/worker.py engine/lq_tts_engine/pipeline.py engine/lq_tts_engine/retention.py engine/tests/test_worker.py engine/tests/test_pipeline.py engine/tests/test_callbacks_retention.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: worker survives purge races, resets the in-flight sentence, device check on whole words"
```

---

### Task 2: Engine API HTTP hardening (backlog 3, 8, 13: body limits + constant-time tokens)

**Files:**
- Modify: `engine/lq_tts_engine/api/app.py` (imports, constants, `_has_audio_stream`, `create_app` handlers + `caller`, `create_voice`, `create_job`)
- Modify: `engine/lq_tts_engine/repo.py` (add `find_idempotent_job` after `create_job`)
- Test: `engine/tests/test_api_jobs.py`, `engine/tests/test_api_voices.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `app.caller_for(tokens: dict[str, str], token: str) -> str | None`; `app.BodyLimit` (ASGI middleware); module constants `MAX_JSON_BYTES = 256 * 1024`, `MULTIPART_OVERHEAD_BYTES = 1024 * 1024`, `FFPROBE_TIMEOUT_S = 30`; `Repo.find_idempotent_job(caller, key: str) -> Row | None`; inner helper `accepted(job) -> dict` inside `register_job_routes`. Task 3 edits `create_job` again and keeps all of this.

- [ ] **Step 1: Write the failing tests**

In `engine/tests/test_api_jobs.py` replace the import block (lines 1-8) with:

```python
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from lq_tts_engine.api.app import create_app
from lq_tts_engine.config import Config
from lq_tts_engine.pipeline import Deps, job_dir, run_job
from lq_tts_engine.text.split import split_script
from tests.conftest import sql
from tests.fakes import FakeTranscriber, ToneSynth
from tests.test_api_voices import AUTH, OTHER, cfg, client  # noqa: F401  (fixtures)
```

Append to `engine/tests/test_api_jobs.py`:

```python


def test_empty_idempotency_key_is_ignored(client, ready_voice):
    a = post_job(client, ready_voice, headers={"Idempotency-Key": ""})
    b = post_job(client, ready_voice, headers={"Idempotency-Key": ""})
    assert (a.status_code, b.status_code) == (202, 202)
    assert a.json()["id"] != b.json()["id"]


def test_idempotent_replay_wins_over_disk_and_voice_checks(client, cfg, repo, ready_voice):
    first = post_job(client, ready_voice, headers={"Idempotency-Key": "k-replay"}).json()
    full = TestClient(create_app(Config(**{**cfg.__dict__, "min_free_gb": 1e12}), repo))
    r = post_job(full, ready_voice, headers={"Idempotency-Key": "k-replay"})
    assert r.status_code == 202 and r.json()["id"] == first["id"]
    sql(repo, "UPDATE voices SET status='processing' WHERE id=%s", (ready_voice["id"],))
    r = post_job(client, ready_voice, headers={"Idempotency-Key": "k-replay"})
    assert r.status_code == 202 and r.json()["id"] == first["id"]


def test_json_body_over_the_limit_is_refused_streamed_or_not(client, ready_voice):
    payload = json.dumps({"voice_id": str(ready_voice["id"]), "text": "a" * 300_000}).encode()
    headers = {**AUTH, "Content-Type": "application/json"}
    for body in (payload, iter([payload])):  # Content-Length, then chunked
        r = client.post("/v1/jobs", headers=headers, content=body)
        assert r.status_code == 413
        assert r.json() == {"error": {"code": "too_large", "message": "request body too large"}}
```

In `engine/tests/test_api_voices.py` add `import subprocess` after `import uuid`, and change the `create_app` import line to:

```python
from lq_tts_engine.api.app import caller_for, create_app
```

Append to `engine/tests/test_api_voices.py`:

```python


def multipart_stream(size: int):
    yield (b'--b\r\nContent-Disposition: form-data; name="name"\r\n\r\nPandji\r\n'
           b'--b\r\nContent-Disposition: form-data; name="owner_ref"\r\n\r\nuser-1\r\n'
           b'--b\r\nContent-Disposition: form-data; name="audio"; filename="vo.wav"\r\nContent-Type: audio/wav\r\n\r\n')
    for _ in range(size // 1000):
        yield b"\0" * 1000
    yield b"\r\n--b--\r\n"


def no_voice_folders(cfg) -> bool:
    folder = cfg.data_dir / "voices"
    return not folder.exists() or not any(folder.iterdir())


def test_streamed_upload_over_the_body_limit_is_refused_before_parsing(client, cfg, monkeypatch):
    monkeypatch.setattr(api_module, "MAX_UPLOAD_BYTES", 1000)
    monkeypatch.setattr(api_module, "MULTIPART_OVERHEAD_BYTES", 1000)
    r = client.post("/v1/voices", headers={**AUTH, "Content-Type": "multipart/form-data; boundary=b"},
                    content=multipart_stream(50_000))
    assert r.status_code == 413
    assert r.json() == {"error": {"code": "too_large", "message": "request body too large"}}
    assert no_voice_folders(cfg)


def test_unknown_route_and_wrong_method_use_the_error_shape(client):
    r = client.get("/v1/nope", headers=AUTH)
    assert r.status_code == 404 and r.json() == {"error": {"code": "not_found", "message": "Not Found"}}
    r = client.put("/v1/health")
    assert r.status_code == 405
    assert r.json() == {"error": {"code": "method_not_allowed", "message": "Method Not Allowed"}}
    assert r.headers["allow"] == "GET"


def test_ffprobe_that_hangs_is_unsupported_audio(client, cfg, tmp_path, monkeypatch):
    seen = {}

    def hanging(cmd, **kwargs):
        seen["timeout"] = kwargs.get("timeout")
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    monkeypatch.setattr(api_module.subprocess, "run", hanging)
    r = upload(client, tmp_path)
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_audio"
    assert seen["timeout"] == api_module.FFPROBE_TIMEOUT_S
    assert no_voice_folders(cfg)


def test_failed_voice_insert_leaves_no_folder(cfg, repo, tmp_path, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr(repo, "create_voice", broken)
    r = upload(TestClient(create_app(cfg, repo), raise_server_exceptions=False), tmp_path)
    assert r.status_code == 500
    assert no_voice_folders(cfg)


def test_token_lookup_accepts_only_exact_tokens():
    tokens = {TOKEN: "lq-tts", OTHER: "lq-studio"}
    assert caller_for(tokens, TOKEN) == "lq-tts" and caller_for(tokens, OTHER) == "lq-studio"
    for wrong in (TOKEN[:-1], TOKEN + "x", TOKEN.upper(), "", TOKEN + "\0"):
        assert caller_for(tokens, wrong) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q tests/test_api_jobs.py tests/test_api_voices.py`
Expected: collection error `ImportError: cannot import name 'caller_for'` for both files (test_api_jobs imports fixtures from test_api_voices). To see the individual failures, temporarily run only the jobs tests with the old import line; not required. After Step 3 every new test must pass.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/repo.py` — add after `create_job` (after line 119):

```python
    def find_idempotent_job(self, caller, key: str) -> Row | None:
        """The job this caller created with this Idempotency-Key in the last 24 hours (create_job's replay window)."""
        return self._one(
            "SELECT * FROM jobs WHERE caller=%s AND idempotency_key=%s AND created_at > now() - interval '24 hours'",
            (caller, key),
        )
```

`engine/lq_tts_engine/api/app.py`:

Imports (lines 2-14) become:

```python
import asyncio
import hmac
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
```

Constants (lines 24-29) become:

```python
MAX_TEXT_CHARS = 20_000
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MULTIPART_OVERHEAD_BYTES = 1024 * 1024  # form fields and boundaries around the audio file
MAX_JSON_BYTES = 256 * 1024  # 20,000 characters of 4-byte UTF-8 plus settings
FFPROBE_TIMEOUT_S = 30
CHARS_PER_SECOND = 16.0
DEFAULT_RTF = 0.82
HEARTBEAT_STALE_S = 60.0
UPLOAD_EXTS = {".mp3", ".wav", ".m4a", ".flac"}
HTTP_CODES = {404: "not_found", 405: "method_not_allowed", 413: "too_large"}
```

Replace `_has_audio_stream` (lines 44-50) with the following, and add `caller_for` and `BodyLimit` right after it:

```python
def _has_audio_stream(path: Path) -> bool:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=FFPROBE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return False
    return probe.returncode == 0 and probe.stdout.strip() == "audio"


def caller_for(tokens: dict[str, str], token: str) -> str | None:
    """Compares against every configured token in constant time, so response timing never reveals a near match."""
    who = None
    for known, name in tokens.items():
        if hmac.compare_digest(known.encode(), token.encode()):
            who = name
    return who


async def _too_large(send) -> None:
    body = json.dumps({"error": {"code": "too_large", "message": "request body too large"}}).encode()
    await send({"type": "http.response.start", "status": 413,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class BodyLimit:
    """413 too_large for bodies over the route's limit, before parsing; counts chunked (streamed) bodies too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES if scope["path"] == "/v1/voices" else MAX_JSON_BYTES
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await _too_large(send)
            return
        seen, over = 0, False

        async def counted():
            nonlocal seen, over
            if over:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    over = True  # the app sees a disconnect and stops reading; its answer is replaced below
                    return {"type": "http.disconnect"}
            return message

        async def guarded(message):
            if not over:
                await send(message)

        try:
            await self.app(scope, counted, guarded)
        except Exception:
            if not over:
                raise
        if over:
            await _too_large(send)
```

In `create_app`, right after `app = FastAPI(title="LQ-TTS engine", version="1")` add:

```python
    app.add_middleware(BodyLimit)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTP_CODES.get(exc.status_code, "invalid_request" if exc.status_code < 500 else "internal_error")
        response = _error(exc.status_code, code, str(exc.detail))
        response.headers.update(exc.headers or {})
        return response
```

Replace the body of `caller` (lines 92-96):

```python
    def caller(authorization: Annotated[str | None, Header()] = None) -> str:
        token = (authorization or "").removeprefix("Bearer ").strip()
        who = caller_for(cfg.tokens, token) if token else None
        if who is None:
            raise ApiError(401, "unauthorized", "missing or invalid service token")
        return who
```

Replace `create_voice` (lines 111-138):

```python
    @app.post("/v1/voices", status_code=202)
    def create_voice(who: Caller, audio: UploadFile = File(...), name: str = Form(...), owner_ref: str = Form(...),
                     language: str | None = Form(None), transcript: str | None = Form(None)) -> dict:
        need_disk()
        ext = Path(audio.filename or "").suffix.lower()
        if ext not in UPLOAD_EXTS:
            raise ApiError(415, "unsupported_audio", "use MP3, WAV, M4A or FLAC")
        voice_id = uuid.uuid4()
        folder = cfg.data_dir / "voices" / str(voice_id)
        folder.mkdir(parents=True)
        try:
            dest = folder / f"source{ext}"
            size = 0
            with dest.open("wb") as fh:
                while chunk := audio.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise ApiError(413, "too_large", "upload exceeds 200 MB")
                    fh.write(chunk)
            if not _has_audio_stream(dest):
                raise ApiError(415, "unsupported_audio", "file has no readable audio")
            row = repo.create_voice(voice_id, who, owner_ref, name, language, str(dest), transcript)
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)  # never leave a folder without a voice row
            raise
        return {"id": str(row["id"]), "status": row["status"]}
```

In `register_job_routes`, add after `job_view` (after line 215):

```python
    def accepted(job: dict) -> dict:
        return {"id": str(job["id"]), "sentences_total": len(repo.list_sentences(job["id"])),
                "estimated_seconds": estimate_seconds(job)}
```

Replace `create_job` (lines 217-239):

```python
    @app.post("/v1/jobs", status_code=202)
    def create_job(body: JobIn, who: Caller, idempotency_key: Annotated[str | None, Header()] = None) -> dict:
        key = (idempotency_key or "").strip() or None
        if key is not None and (replay := repo.find_idempotent_job(who, key)) is not None:
            return accepted(replay)  # a retried POST gets its job back, whatever disk or voice say now
        need_disk()
        text = body.text.strip()
        if not text:
            raise ApiError(400, "invalid_text", "text is empty")
        if len(text) > MAX_TEXT_CHARS:
            raise ApiError(413, "too_large", "text exceeds 20,000 characters")
        try:
            settings = JobSettings(**body.settings)
        except ValidationError as exc:
            first = exc.errors()[0]
            raise ApiError(400, "invalid_settings", f"{'.'.join(map(str, first['loc']))}: {first['msg']}") from exc
        voice = own_voice(who, body.voice_id)
        if voice["status"] != "ready":
            raise ApiError(409, "voice_not_ready", f"voice is {voice['status']}")
        units = split_script(text)
        if not units:
            raise ApiError(400, "invalid_text", "no sentences found")
        job, _ = repo.create_job(caller=who, voice_id=body.voice_id, text=text, settings=settings.model_dump(),
                                 callback_url=body.callback_url, idempotency_key=key, units=units)
        return accepted(job)
```

(`repo.create_job` keeps its locked lookup, so two concurrent first requests with one key still produce one job.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q`
Expected: `164 passed, 1 deselected` (the existing `test_upload_over_limit_is_413` still passes: code `too_large`).

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add engine/lq_tts_engine/api/app.py engine/lq_tts_engine/repo.py engine/tests/test_api_jobs.py engine/tests/test_api_voices.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: body limits, spec-shaped 404/405, idempotent replay first, ffprobe timeout, no orphan voice folders, constant-time tokens"
```

---

### Task 3: Engine callbacks and SSRF (backlog 4, 13: callback SSRF)

**Files:**
- Modify: `engine/lq_tts_engine/callbacks.py`
- Modify: `engine/lq_tts_engine/config.py`
- Modify: `engine/lq_tts_engine/api/app.py` (`create_job`, import)
- Test: `engine/tests/test_callbacks_retention.py`, `engine/tests/test_config_settings.py`, `engine/tests/test_api_jobs.py`

**Interfaces:**
- Consumes: Task 2's `create_job` (with `key`, `accepted`).
- Produces: `callbacks.LOOPBACK_HOSTS: frozenset[str]`; `callbacks.callback_url_allowed(url: str, extra_hosts: frozenset[str] = frozenset()) -> bool`; `Config.callback_hosts: dict[str, frozenset[str]]` (default `{}`), filled from optional env `LQTTS_CALLBACK_HOSTS` = `caller:host1|host2,caller2:host3` (hosts lowercased); `load_config` raises `ValueError` naming the caller when a caller has no callback secret, or when `LQTTS_CALLBACK_HOSTS` names an unknown caller. Task 5 edits `load_config` again and keeps all of this.

- [ ] **Step 1: Write the failing tests**

In `engine/tests/test_callbacks_retention.py` add `import logging` after `import json`, then append:

```python


def test_unusable_url_or_unknown_caller_is_logged_as_dropped(caplog):
    sender, seen, sleeps = make_sender([200])
    with caplog.at_level(logging.WARNING, logger="lq_tts_engine.callbacks"):
        assert sender.deliver("lq-tts", "http://a\x00b/", {"job_id": "j1"}) is False  # httpx.InvalidURL
        assert sender.deliver("nobody", "http://app.local/cb", {"job_id": "j2"}) is False  # no secret
    dropped = [r.getMessage() for r in caplog.records if r.getMessage().startswith("callback dropped")]
    assert len(dropped) == 2 and seen == []
```

Append to `engine/tests/test_config_settings.py`:

```python


def test_every_caller_needs_a_callback_secret():
    with pytest.raises(ValueError, match="no callback secret for caller lq-studio"):
        load_config({**BASE_ENV, "LQTTS_CALLBACK_SECRETS": "lq-tts:sec-a"})


def test_callback_hosts_are_per_caller_and_optional():
    assert load_config(BASE_ENV).callback_hosts == {}
    cfg = load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": "lq-studio:Hooks.Example.com|10.0.0.5"})
    assert cfg.callback_hosts == {"lq-studio": frozenset({"hooks.example.com", "10.0.0.5"})}
    with pytest.raises(ValueError, match="unknown caller nobody"):
        load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": "nobody:x.example"})
```

Append to `engine/tests/test_api_jobs.py`:

```python


def test_callback_url_must_be_loopback_or_allowed_for_the_caller(client, cfg, repo, ready_voice):
    for bad in ("http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://user@127.0.0.1/cb",
                "http://hooks.example.com/cb", "gopher://127.0.0.1/", "http://127.0.0.1:99999/cb", ""):
        r = post_job(client, ready_voice, callback_url=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_callback_url", bad
    for good in ("http://127.0.0.1:8751/api/internal/engine-callback", "http://localhost:8760/cb", "https://[::1]/cb"):
        assert post_job(client, ready_voice, callback_url=good).status_code == 202, good
    hosts = {"lq-tts": frozenset({"hooks.example.com"})}
    allowed = TestClient(create_app(Config(**{**cfg.__dict__, "callback_hosts": hosts}), repo))
    assert post_job(allowed, ready_voice, callback_url="https://hooks.example.com/cb").status_code == 202
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q tests/test_callbacks_retention.py tests/test_config_settings.py tests/test_api_jobs.py`
Expected: 4 failed — `httpx.InvalidURL` raised from `deliver`; `DID NOT RAISE <class 'ValueError'>` for the secret test; `AttributeError: 'Config' object has no attribute 'callback_hosts'`; `assert 202 == 400` for the metadata URL.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/callbacks.py` — add `from urllib.parse import urlsplit` after `from collections.abc import Callable`; add after `RETRY_DELAYS_S`:

```python
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
```

add after `verify`:

```python
def callback_url_allowed(url: str, extra_hosts: frozenset[str] = frozenset()) -> bool:
    """http(s) to loopback, or to a host configured for the caller; no credentials, a valid port."""
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError when the port is not a number in range
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return (parts.scheme in ("http", "https") and not parts.username and not parts.password
            and host != "" and (host in LOOPBACK_HOSTS or host in extra_hosts))
```

Replace `deliver`:

```python
    def deliver(self, caller: str, url: str, payload: dict) -> bool:
        secret = self.secrets.get(caller)
        if secret is None:
            log.warning("callback dropped: no secret for caller",
                        extra={"ctx": {"caller": caller, "url": url, "payload": payload}})
            return False
        body = json.dumps(payload, separators=(",", ":")).encode()
        last_error = None
        for delay in (0, *self.delays):
            if delay:
                self.sleep(delay)
            timestamp = str(int(time.time()))
            headers = {"Content-Type": "application/json", "X-LQ-Timestamp": timestamp,
                       "X-LQ-Signature": sign(secret, timestamp, body)}
            try:
                with self.client_factory() as client:
                    response = client.post(url, content=body, headers=headers)
                if 200 <= response.status_code < 300:
                    return True
                last_error = f"HTTP {response.status_code}"
            except Exception as exc:  # noqa: BLE001 - the sender thread must always end in delivered or "dropped"
                last_error = f"{type(exc).__name__}: {exc}"
        log.warning("callback dropped after retries",
                    extra={"ctx": {"url": url, "payload": payload, "error": last_error}})
        return False
```

`engine/lq_tts_engine/config.py` — change `from dataclasses import dataclass` to `from dataclasses import dataclass, field`; add to `Config` after `min_free_gb: float`:

```python
    callback_hosts: dict[str, frozenset[str]] = field(default_factory=dict)
```

Replace the tail of `load_config` (from `caller_tokens = ...` to the end):

```python
    caller_tokens = _pairs(get("LQTTS_TOKENS"), "LQTTS_TOKENS")
    tokens = {token: caller for caller, token in caller_tokens.items()}
    callback_secrets = _pairs(get("LQTTS_CALLBACK_SECRETS"), "LQTTS_CALLBACK_SECRETS")
    for caller in sorted(caller_tokens):
        if caller not in callback_secrets:
            raise ValueError(f"LQTTS_CALLBACK_SECRETS: no callback secret for caller {caller}")
    callback_hosts: dict[str, frozenset[str]] = {}
    for caller, hosts in _pairs(env.get("LQTTS_CALLBACK_HOSTS") or "", "LQTTS_CALLBACK_HOSTS").items():
        if caller not in caller_tokens:
            raise ValueError(f"LQTTS_CALLBACK_HOSTS: unknown caller {caller}")
        callback_hosts[caller] = frozenset(h.strip().lower() for h in hosts.split("|") if h.strip())
    return Config(
        database_url=get("LQTTS_DATABASE_URL"),
        schema=get("LQTTS_SCHEMA", "lq_tts_engine"),
        data_dir=Path(get("LQTTS_DATA_DIR")).expanduser(),
        tokens=tokens,
        callback_secrets=callback_secrets,
        device=get("LQTTS_DEVICE", "mps"),
        whisper_model=get("LQTTS_WHISPER_MODEL", "small"),
        min_free_gb=float(get("LQTTS_MIN_FREE_GB", "20")),
        callback_hosts=callback_hosts,
    )
```

`engine/lq_tts_engine/api/app.py` — add `from ..callbacks import callback_url_allowed` before `from ..config import Config, load_config`; in `create_job`, insert right after the `JobSettings` `try/except` block:

```python
        if body.callback_url is not None and not callback_url_allowed(
                body.callback_url, cfg.callback_hosts.get(who, frozenset())):
            raise ApiError(400, "invalid_callback_url",
                           "callback_url must be http(s) to loopback or to a host allowed for this caller")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q`
Expected: `168 passed, 1 deselected`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add engine/lq_tts_engine/callbacks.py engine/lq_tts_engine/config.py engine/lq_tts_engine/api/app.py engine/tests/test_callbacks_retention.py engine/tests/test_config_settings.py engine/tests/test_api_jobs.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: callback URL allowlist, a secret per caller, callbacks always end delivered or dropped"
```

---

### Task 4: Engine text, subtitles and splitter (backlog 7, 11)

**Files:**
- Modify: `engine/lq_tts_engine/subs.py:17-28`
- Modify: `engine/lq_tts_engine/text/split.py` (constants, new `_cap`, final loop at lines 83-84)
- Test: `engine/tests/test_finish_subs.py`, `engine/tests/test_split.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `split.MAX_UNIT_CHARS = 400`; `split._cap(sentence: str, limit: int = MAX_UNIT_CHARS) -> list[str]`. `split_script` keeps its signature; every `Unit.text` is now at most 400 characters. Consequence: `is_single_sentence` (regenerate) refuses text longer than 400 characters, matching how a fresh job would split it.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_finish_subs.py`:

```python


def test_cue_text_cannot_break_out_of_its_cue():
    cue = [Cue(0.0, 1.0, "a < b --> c & d\n\nnext")]
    assert to_srt(cue) == "1\n00:00:00,000 --> 00:00:01,000\na ‹ b --› c & d next\n\n"
    assert to_vtt(cue) == "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na &lt; b --&gt; c &amp; d next\n\n"
```

Append to `engine/tests/test_split.py`:

```python


def test_unpunctuated_script_is_cut_into_bounded_units_at_spaces():
    text = "{{style: tegas}} " + " ".join(["kata"] * 4000)
    units = split_script(text)
    assert len(units) > 40
    assert max(len(u.text) for u in units) <= 400
    assert " ".join(u.text for u in units).split() == ["kata"] * 4000
    assert {u.style for u in units} == {"tegas"}
    assert [u.paragraph_end for u in units] == [False] * (len(units) - 1) + [True]
    assert [u.idx for u in units] == list(range(len(units)))


def test_long_unit_prefers_to_break_after_a_comma():
    units = split_script("satu dua tiga empat, " * 60)
    assert len(units) > 1 and max(len(u.text) for u in units) <= 400
    assert all(u.text.endswith(",") for u in units[:-1])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q tests/test_finish_subs.py tests/test_split.py`
Expected: 3 failed — SRT/VTT string mismatch (`a < b --> c & d\n\nnext` written raw), `assert 1 > 40`, `assert 1 > 1`.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/subs.py` — replace `to_srt` and `to_vtt` (lines 21-28) with:

```python
def _line(text: str) -> str:
    return " ".join(text.split())  # a blank line inside a cue would end the cue early


def _srt_text(text: str) -> str:
    # SRT has no escapes and players read <i>/<b>/<font>: swap angle brackets for look-alikes, which also defuses "-->".
    return _line(text).replace("<", "‹").replace(">", "›")


def _vtt_text(text: str) -> str:
    return _line(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_srt(cues: list[Cue]) -> str:
    return "".join(
        f"{i}\n{_ts(c.start_s, ',')} --> {_ts(c.end_s, ',')}\n{_srt_text(c.text)}\n\n" for i, c in enumerate(cues, 1)
    )


def to_vtt(cues: list[Cue]) -> str:
    return "WEBVTT\n\n" + "".join(
        f"{_ts(c.start_s, '.')} --> {_ts(c.end_s, '.')}\n{_vtt_text(c.text)}\n\n" for c in cues
    )
```

`engine/lq_tts_engine/text/split.py` — add after `_PARA = re.compile(r"\n\s*\n")`:

```python
MAX_UNIT_CHARS = 400  # one synthesis call; a 20,000-character unit without punctuation would exhaust memory
_SOFT_BREAK = re.compile(r"[,;:]\s")
```

add after `_sentences_in`:

```python
def _cap(sentence: str, limit: int = MAX_UNIT_CHARS) -> list[str]:
    """Cuts a unit longer than limit after its last comma/semicolon/colon, else at its last space, else hard."""
    pieces: list[str] = []
    rest = sentence
    while len(rest) > limit:
        window = rest[: limit + 1]
        cut = max((m.end() for m in _SOFT_BREAK.finditer(window)), default=0)
        if cut < limit // 2:
            space = window.rfind(" ")
            cut = space + 1 if space > 0 else limit
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return pieces
```

replace the last loop of the paragraph (lines 83-84):

```python
        for n, (sentence, style) in enumerate(merged):
            units.append(Unit(len(units), p_idx, sentence, style, n == len(merged) - 1))
```

with:

```python
        capped = [(piece, style) for sentence, style in merged for piece in _cap(sentence)]
        for n, (sentence, style) in enumerate(capped):
            units.append(Unit(len(units), p_idx, sentence, style, n == len(capped) - 1))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q`
Expected: `171 passed, 1 deselected`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add engine/lq_tts_engine/subs.py engine/lq_tts_engine/text/split.py engine/tests/test_finish_subs.py engine/tests/test_split.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: escape subtitle cue text, cap synthesis units at 400 characters"
```

---

### Task 5: Engine config, cleanup and test pins (backlog 9, 10, 12)

**Files:**
- Modify: `engine/lq_tts_engine/config.py` (`_pairs`, `load_config` token map)
- Modify: `engine/lq_tts_engine/repo.py:51-55` (delete `soft_delete_voice`)
- Modify: `engine/tests/test_pipeline.py:109`, `engine/tests/test_worker.py:145,154`, `engine/tests/test_repo_store.py:27`
- Test: `engine/tests/test_config_settings.py`, `engine/tests/test_api_voices.py`

**Interfaces:**
- Consumes: Task 3's `load_config` (secret coverage, `callback_hosts`).
- Produces: `load_config` raises `ValueError` "`<KEY>: <caller> is listed twice`" for a repeated name and "`LQTTS_TOKENS: callers <a> and <b> share one token`" (never printing the token). `Repo.soft_delete_voice` no longer exists; callers use `Repo.delete_voice_cascade(caller, voice_id) -> list[Row] | None`.

- [ ] **Step 1: Write the failing test and the pins**

Append to `engine/tests/test_config_settings.py`:

```python


def test_duplicate_token_or_caller_fails_at_startup():
    with pytest.raises(ValueError, match="callers lq-tts and lq-studio share one token"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts:same,lq-studio:same"})
    with pytest.raises(ValueError, match="LQTTS_TOKENS: lq-tts is listed twice"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts:tok-a,lq-tts:tok-b"})
```

In `engine/tests/test_api_voices.py` add `from tests.conftest import sql` after the `lq_tts_engine` imports, then append these two pins (behaviour is already correct; they lock it in, so they pass on the first run):

```python


def test_other_caller_cannot_list_preview_or_delete_a_voice(client, repo, tmp_path, cfg):
    vid = uuid.UUID(upload(client, tmp_path).json()["id"])
    ref = cfg.data_dir / "voices" / str(vid) / "ref.wav"
    sf.write(ref, np.zeros(48000, dtype=np.float32), 48000)
    repo.voice_ready(vid, ref_audio_path=str(ref), ref_transcript="halo", ref_seconds=1.0,
                     clip_start_s=0.0, clip_end_s=1.0, language="id")
    other = {"Authorization": f"Bearer {OTHER}"}
    assert client.get("/v1/voices?owner_ref=user-1", headers=other).json() == []
    assert client.get(f"/v1/voices/{vid}/preview.wav", headers=other).status_code == 404
    assert client.delete(f"/v1/voices/{vid}", headers=other).status_code == 404
    assert repo.get_voice("lq-tts", vid) is not None and ref.exists()


def test_health_is_503_when_the_worker_heartbeat_is_stale(client, repo):
    repo.heartbeat(model_loaded=True, device="mps", rtf=None)
    sql(repo, "UPDATE worker_state SET beat_at = now() - interval '61 seconds'")
    r = client.get("/v1/health")
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_loading"
    assert r.json()["health"]["worker_heartbeat_age_s"] >= 60
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q tests/test_config_settings.py tests/test_api_voices.py`
Expected: 1 failed — `test_duplicate_token_or_caller_fails_at_startup` (`DID NOT RAISE <class 'ValueError'>`); the two pins pass.

- [ ] **Step 3: Implement**

`engine/lq_tts_engine/config.py` — in `_pairs`, insert before `out[key] = value`:

```python
        if key in out:
            raise ValueError(f"{name}: {key} is listed twice")
```

in `load_config` replace `tokens = {token: caller for caller, token in caller_tokens.items()}` with:

```python
    tokens: dict[str, str] = {}
    for caller, token in caller_tokens.items():
        if token in tokens:
            raise ValueError(f"LQTTS_TOKENS: callers {tokens[token]} and {caller} share one token")
        tokens[token] = caller
```

`engine/lq_tts_engine/repo.py` — delete `soft_delete_voice` (lines 51-55, the method and the blank line after it).

Point the tests at the cascade:
- `engine/tests/test_pipeline.py:109` → `    repo.delete_voice_cascade("lq-tts", ready_voice["id"])`
- `engine/tests/test_worker.py:145` → `    repo.delete_voice_cascade("lq-tts", ready_voice["id"])`
- `engine/tests/test_worker.py:154` → `            repo.delete_voice_cascade("lq-tts", vid)`
- `engine/tests/test_repo_store.py:27` → `    assert repo.delete_voice_cascade("lq-tts", vid) == []`

Then confirm nothing else uses it:

Run: `cd ~/Developer/LQ-TTS-hardening && git grep -n soft_delete_voice`
Expected: no output (exit 1).

- [ ] **Step 4: Run the whole engine suite**

Run: `cd ~/Developer/LQ-TTS-hardening/engine && uv run pytest -q`
Expected: `174 passed, 1 deselected`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add engine/lq_tts_engine/config.py engine/lq_tts_engine/repo.py engine/tests/test_config_settings.py engine/tests/test_api_voices.py engine/tests/test_pipeline.py engine/tests/test_worker.py engine/tests/test_repo_store.py
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "engine: refuse duplicate callers and tokens at startup, drop soft_delete_voice, pin caller isolation and stale heartbeat"
```

---

### Task 6: Web config and error handling (W1, W2)

**Files:**
- Modify: `web/server/config.js:15-22,36,50-51`
- Modify: `web/server/lib/errors.js:32-51`
- Create: `web/server/test/errors.test.js`
- Test: `web/server/test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: config keys keep their names (`port`, `maxUploadBytes`, `reconcileIntervalMs`); bad values now throw `"<KEY> must be a whole number, at least <min> and at most <max>"`. Ranges: `PORT` 0-65535 (default 8750; `0` is used by `shutdown.test.js`), `MAX_UPLOAD_BYTES` 1-99614720 (default 99614720), `RECONCILE_INTERVAL_MS` 1000-2147483647 (default 60000).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('loadConfig', ...)` block of `web/server/test/config.test.js` (before its closing `});`):

```js
  it('rejects a PORT or MAX_UPLOAD_BYTES that is not a whole number in range', () => {
    expect(loadConfig({ ...base, PORT: '0' }).port).toBe(0);
    expect(loadConfig({ ...base, MAX_UPLOAD_BYTES: '1048576' }).maxUploadBytes).toBe(1048576);
    for (const bad of ['abc', '-1', '80.5', '65536', '1e3']) {
      expect(() => loadConfig({ ...base, PORT: bad })).toThrow('PORT');
    }
    for (const bad of ['abc', '0', '95MB', '99614721', '1.5']) {
      expect(() => loadConfig({ ...base, MAX_UPLOAD_BYTES: bad })).toThrow('MAX_UPLOAD_BYTES');
    }
  });
```

Create `web/server/test/errors.test.js`:

```js
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../lib/errors.js';

const logs = [];
const log = { error: (fields) => logs.push(fields) };
const app = express();
app.use(express.json());
app.post('/x', (req, res) => res.json(req.body));
app.use(errorHandler(log));

const fakeRes = ({ headersSent = false } = {}) => ({
  headersSent,
  destroyed: false,
  statusCode: undefined,
  body: undefined,
  destroy() {
    this.destroyed = true;
  },
  set() {
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe('errorHandler', () => {
  it('answers an unsupported body charset or encoding with 415 invalid_request', async () => {
    const variants = [
      { 'content-type': 'application/json; charset=latin1' },
      { 'content-type': 'application/json', 'content-encoding': 'compress' },
    ];
    for (const headers of variants) {
      const res = await request(app).post('/x').set(headers).send('{"a":1}');
      expect(res.status).toBe(415);
      expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'unsupported body charset or encoding' } });
    }
    expect(logs).toEqual([]);
  });

  it('answers a body cut off mid-request with 400 invalid_request', () => {
    const res = fakeRes();
    errorHandler(log)(Object.assign(new Error('request aborted'), { type: 'request.aborted' }), { path: '/x' }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'request body was cut off' } });
    expect(logs).toEqual([]);
  });

  it('closes the connection instead of answering twice once headers are sent', () => {
    const res = fakeRes({ headersSent: true });
    errorHandler(log)(new Error('late failure'), { path: '/x' }, res);
    expect(res.destroyed).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run server/test/config.test.js server/test/errors.test.js`
Expected: 3 failed — config (`expected [Function] to throw ... 'PORT'`), charset (`expected 500 to be 415`), aborted (`expected 500 to be 400`); the headersSent pin passes (the branch exists, it was only untested).

- [ ] **Step 3: Implement**

`web/server/config.js` — replace `intervalMs` (lines 16-22) with:

```js
// Whole decimal numbers only: Number() turns 'abc' into NaN and '1e3' into 1000 without complaint.
const wholeNumber = (env, key, fallback, min, max) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be a whole number, at least ${min} and at most ${max}`);
  }
  return n;
};
```

and change the three config lines:

```js
    port: wholeNumber(env, 'PORT', 8750, 0, 65535),
```

```js
    maxUploadBytes: wholeNumber(env, 'MAX_UPLOAD_BYTES', 99614720, 1, 99614720), // 95 MB: Cloudflare rejects bodies over 100 MB
    reconcileIntervalMs: wholeNumber(env, 'RECONCILE_INTERVAL_MS', 60000, 1000, 2147483647),
```

`web/server/lib/errors.js` — add before `export function errorHandler`:

```js
// body-parser failures by err.type: [code, message, status]. Anything else is a bug and logs as unhandled.
const BODY_ERRORS = Object.freeze({
  'entity.parse.failed': ['invalid_request', 'malformed JSON body', 400],
  'entity.too.large': ['too_large', 'request body too large', 413],
  'charset.unsupported': ['invalid_request', 'unsupported body charset or encoding', 415],
  'encoding.unsupported': ['invalid_request', 'unsupported body charset or encoding', 415],
  'request.aborted': ['invalid_request', 'request body was cut off', 400],
  'request.size.invalid': ['invalid_request', 'request body was cut off', 400],
});
```

and replace the `if (!(err instanceof ApiError)) { ... }` block with:

```js
    if (!(err instanceof ApiError)) {
      const known = BODY_ERRORS[err?.type];
      if (known) {
        apiErr = new ApiError(known[0], known[1], { status: known[2] });
      } else {
        log.error({ event: 'unhandled_error', path: req.path, error: String(err?.stack ?? err) }, 'unhandled error');
        apiErr = new ApiError('internal_error', 'internal error');
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run`
Expected: `Test Files 20 passed (20)`, `Tests 247 passed (247)`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add web/server/config.js web/server/lib/errors.js web/server/test/config.test.js web/server/test/errors.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: validate numeric env, map every body-parser error, pin the headersSent branch"
```

---

### Task 7: Web sessions, job actions and reconcile (W3, W4, W5)

**Files:**
- Modify: `web/server/routes/auth.js:14-37,48,61` (`startSession`, `answer`, their callers)
- Modify: `web/server/routes/job-actions.js:73-104`
- Modify: `web/server/services/reconcile.js:1,24-28`
- Test: `web/server/test/auth.test.js`, `web/server/test/job-actions.test.js`

**Interfaces:**
- Consumes: `readSessionCookie(req)` (`http/middleware.js`), `hashSessionId(raw)` and `sessions.revoke(id)` (`services/sessions.js`), `HELD_MIN_AGE_MS` (`services/charges.js:5`).
- Produces: no new exports. Behaviour: a login (password or 2FA) from a browser that carries a session cookie revokes that session; `POST /api/jobs/:id/sentences/:idx/regenerate` answers 202 only after its lease row is cleared.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('auth, sessions and /api/me', ...)` in `web/server/test/auth.test.js`:

```js
  it('revokes the session a new login replaces', async () => {
    const old = await h.login();
    const res = await login({ identifier: USERS.ana.email, password: USERS.ana.password }, { cookie: old });
    expect(res.body.status).toBe('ok');
    expect((await h.as(old).get('/api/me')).status).toBe(401);
    expect((await h.as(sessionCookie(res)).get('/api/me')).status).toBe(200);
  });
```

Append inside `describe('regenerate, cancel and delete', ...)` in `web/server/test/job-actions.test.js`:

```js
  it('answers a regeneration only after its lease is released, so an immediate cancel goes through', async () => {
    const id = await doneJob();
    const query = h.pool.query;
    // Slow lease release: before the fix the 202 overtook it and the cancel below met a held lease (409).
    h.pool.query = async function slowRelease(sql, ...rest) {
      if (typeof sql === 'string' && sql.startsWith('UPDATE jobs SET regen_lease = NULL')) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return query.call(this, sql, ...rest);
    };
    try {
      expect((await ana.post(`/api/jobs/${id}/sentences/0/regenerate`, {})).status).toBe(202);
      expect((await ana.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    } finally {
      h.pool.query = query;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run server/test/auth.test.js server/test/job-actions.test.js`
Expected: 2 failed — `expected 200 to be 401` (old cookie still valid) and `expected 409 to be 202` (cancel met the lease).

- [ ] **Step 3: Implement**

`web/server/routes/auth.js` — `startSession` takes `req` and revokes the replaced session after the new one exists:

```js
  async function startSession(req, res, user) {
    let full;
    try {
      full = await lqstudio.getUser(user.id);
    } catch (err) {
      throw lqError(err);
    }
    if (!full.verified) return needsVerification;
    await accounts.assertActive(full, String(user.id));
    // tokenVersion moved after verify (password change, "log out everywhere"): the credential just checked is void.
    const tv = userTv(user);
    if (userTv(full) > tv) throw new ApiError('invalid_credentials', 'your password changed, please log in again');
    // The session carries the tv of the verified login.
    const { raw, session } = await sessions.create({ ...user, ...full, tv }, full.balance);
    // The browser's previous session ends here instead of living on unseen for 30 days.
    const replaced = readSessionCookie(req);
    if (replaced) await sessions.revoke(hashSessionId(replaced));
    setSessionCookie(res, raw, config);
    return { status: 'ok', user: await accounts.me(session) };
  }

  async function answer(req, res, out) {
    if (out?.status === 'need_2fa') return res.json({ status: 'need_2fa', challenge: out.challenge });
    if (out?.status === 'needs_verification') return res.json(needsVerification);
    if (out?.status !== 'ok' || !out.user) throw new ApiError('lqstudio_unavailable', 'unexpected answer from LQ-Studio');
    return res.json(await startSession(req, res, out.user));
  }
```

and in both `/auth/login` and `/auth/2fa` handlers change `await answer(res, out);` to:

```js
    await answer(req, res, out);
```

`web/server/routes/job-actions.js` — change line 73 from `await withLease(job.id, async () => {` to:

```js
    const accepted = await withLease(job.id, async () => {
```

and replace lines 102-104:

```js
      await jobsRepo.applyEngineState(job.id, { status: 'queued', revision: out.revision });
      res.status(202).json({ revision: out.revision, credits });
    });
```

with:

```js
      await jobsRepo.applyEngineState(job.id, { status: 'queued', revision: out.revision });
      return { revision: out.revision, credits };
    });
    // Answered after withLease's finally cleared the lease, so a cancel sent right after this 202 is not busy.
    res.status(202).json(accepted);
```

`web/server/services/reconcile.js` — add `import { HELD_MIN_AGE_MS } from './charges.js';` as line 2 and replace the query in `pass()`:

```js
    const { rows } = await pool.query(
      `SELECT * FROM charges WHERE state = 'held' AND created_at < now() - make_interval(secs => $2::double precision / 1000)
       ORDER BY (flagged_at IS NOT NULL), attempts, id LIMIT $1`,
      [batchSize, HELD_MIN_AGE_MS],
    );
```

(Refactor, no behaviour change: `reconcile.test.js` "leaves running jobs and young charges alone" and "settles finished jobs ..." keep covering the 2-minute edge.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run`
Expected: `Test Files 20 passed (20)`, `Tests 249 passed (249)`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add web/server/routes/auth.js web/server/routes/job-actions.js web/server/services/reconcile.js web/server/test/auth.test.js web/server/test/job-actions.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: login revokes the replaced session, regenerate answers after its lease, reconcile uses HELD_MIN_AGE_MS"
```

---

### Task 8: Web profile test pins and dead export (W6, W7, W8, W9)

**Files:**
- Modify: `web/server/routes/voice-profiles.js:4`
- Test: `web/server/test/profiles.test.js`, `web/server/test/voice-profiles.test.js`

**Interfaces:**
- Consumes: `addProfile(slug, { status, name, sort, ownerRef })` and `meta(slug, ...)` helpers already in `voice-profiles.test.js`; `h.engine.state.voices` (Map of fake engine voices); `h.ctx.profiles.deactivate(slug)`.
- Produces: `toProfile` is module-private.

These are pins for behaviour that is already correct (deferred as "untested"), so they pass on their first run; that is expected and is why this task has no red step.

- [ ] **Step 1: Write the pins**

Append inside `describe('voice profile store', ...)` in `web/server/test/profiles.test.js`:

```js
  it('refuses a gender, language, tag count or name length outside the spec', async () => {
    const tag = { id: 'a', en: 'a' };
    const insert = ({ name = 'X', gender = 'male', language = 'id', tags = [tag] } = {}) => pool.query(
      `INSERT INTO voice_profiles (voice_id, slug, name, gender, language, description_id, description_en, tags,
         best_for_id, best_for_en, consent_subject, consent_attested_by, consent_scope, consent_granted_at)
       VALUES ($1, $2, $3, $4, $5, 'd', 'd', $6::jsonb, 'b', 'b', 's', 'a', 'sc', now())`,
      [uuid(), `chk-${crypto.randomBytes(4).toString('hex')}`, name, gender, language, JSON.stringify(tags)],
    );
    for (const bad of [{ gender: 'other' }, { language: 'fr' }, { tags: Array(13).fill(tag) }, { name: '' }, { name: 'n'.repeat(81) }]) {
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
    }
    for (const ok of [{ gender: 'female' }, { gender: 'neutral' }, { language: 'en' }, { tags: Array(12).fill(tag) }, { name: 'n'.repeat(80) }]) {
      await insert(ok);
    }
  });
```

Append inside `describe('VO Profiles', ...)` in `web/server/test/voice-profiles.test.js`:

```js
  it('still regenerates a sentence of a finished job after its profile is deactivated', async () => {
    const voice = await addProfile('regen-retired');
    const job = await ana.post('/api/jobs', { voiceId: voice.id, text: 'Satu dua tiga. Empat lima enam.' });
    expect(job.status).toBe(202);
    h.engine.setJob(job.body.id, { status: 'done' });
    await h.ctx.profiles.deactivate('regen-retired');
    const res = await ana.post(`/api/jobs/${job.body.id}/sentences/0/regenerate`, {});
    expect(res.status).toBe(202);
    expect(res.body.revision).toBe(2);
  });

  it('lists a profile whose engine voice failed, with its status and error code', async () => {
    const voice = await addProfile('broken', { status: 'failed' });
    h.engine.state.voices.get(voice.id).error_code = 'no_clean_speech';
    const item = (await ana.get('/api/voice-profiles')).body.find((p) => p.id === voice.id);
    expect(item).toMatchObject({ slug: 'broken', status: 'failed', errorCode: 'no_clean_speech' });
  });
```

- [ ] **Step 2: Remove the unused export**

`web/server/routes/voice-profiles.js` line 4: change `export const toProfile = (row, voice) => ({` to:

```js
const toProfile = (row, voice) => ({
```

Run: `cd ~/Developer/LQ-TTS-hardening && git grep -n toProfile`
Expected: exactly the two lines in `web/server/routes/voice-profiles.js` (definition and the `list.map` use).

- [ ] **Step 3: Run the web suite**

Run: `cd ~/Developer/LQ-TTS-hardening/web && npx vitest run`
Expected: `Test Files 20 passed (20)`, `Tests 252 passed (252)`.

- [ ] **Step 4: Commit**

```bash
cd ~/Developer/LQ-TTS-hardening
git add web/server/routes/voice-profiles.js web/server/test/profiles.test.js web/server/test/voice-profiles.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: pin profile constraints, failed profiles and regenerate after deactivation; toProfile private"
```

---

## Release (controller)

Run by the controller after Tasks 1-8 are reviewed. All commands on mac-studio with the PATH export from Global Constraints. Never print `.env` contents or tokens.

1. **Merge into the live checkout (no push yet).** The engine runs from `~/Developer/LQ-TTS`, so it must hold the new code before the restart.
   ```bash
   cd ~/Developer/LQ-TTS
   git status --porcelain            # expect: empty
   git tag pre-hardening main
   git merge --ff-only fix/hardening
   git log --oneline -1              # expect: the Task 8 commit
   ```
   pm2 has not restarted anything, so the running engine still has the old code in memory.

2. **Engine config preflight** (new startup checks: secret per caller, no duplicate callers/tokens, optional callback hosts). Uses the live venv's interpreter directly, never `uv sync`:
   ```bash
   cd ~/Developer/LQ-TTS/engine
   .venv/bin/python -c "from lq_tts_engine.config import load_config; c = load_config(); print('callers', sorted(set(c.tokens.values())), 'hosts', sorted(c.callback_hosts))"
   ```
   Expected: `callers ['lq-studio', 'lq-tts', 'lq-tts-stg'] hosts []`. Any `ValueError` → stop, fix the engine `.env` first (it names the key and caller, not the secret).

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
   Expected: `busy jobs=0 voices=0`. Anything else → wait and re-run; never restart over live work.

4. **Restart only the two engine apps, then health.**
   ```bash
   pm2 restart lq-tts-engine-api lq-tts-engine-worker
   for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8740/v1/health)" = 200 ] && break; sleep 5; done
   curl -s http://127.0.0.1:8740/v1/health; echo
   pm2 logs lq-tts-engine-worker --lines 30 --nostream | grep -E '"worker ready"|Error' | tail -n 3
   ```
   Expected: `{"model_loaded":true,"device":"mps",...}` and a `worker ready` line, no `Error`.

5. **Callers check** (every configured token still authenticates; prints caller names and status codes only):
   ```bash
   cd ~/Developer/LQ-TTS/engine
   .venv/bin/python - <<'PY'
   import httpx
   from lq_tts_engine.config import load_config
   for token, caller in load_config().tokens.items():
       r = httpx.get("http://127.0.0.1:8740/v1/voices", params={"owner_ref": "release-probe"},
                     headers={"Authorization": f"Bearer {token}"}, timeout=10)
       print(caller, r.status_code)
   PY
   for c in lq-tts-web-stg lq-tts-web-prod; do docker exec $c node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json()).then((b) => console.log('$c', b.engine))"; done
   ```
   Expected: `lq-tts 200`, `lq-studio 200`, `lq-tts-stg 200`; `lq-tts-web-stg ok`, `lq-tts-web-prod ok`.
   Engine rollback (same busy gate first): `cd ~/Developer/LQ-TTS && git switch --detach pre-hardening && pm2 restart lq-tts-engine-api lq-tts-engine-worker`.

6. **Web: build and recreate staging.**
   ```bash
   cd ~/Developer/LQ-TTS/web
   ops/build-image.sh stg
   docker compose up -d stg
   docker inspect -f '{{.State.Health.Status}}' lq-tts-web-stg   # repeat until: healthy
   ```

7. **Staging gate (controller runs).** Open the temporary Cloudflare Access service-token door and run `E2E_TARGET=staging-public npx playwright test --project=journey --project=screens --project=smoke` exactly as plan 2C Task 14 Steps 3 and 4 (`docs/superpowers/plans/2026-10-03-web-2c-client-release.md`), then close the door. Expected: `5 passed`. The journey generates real audio through the restarted engine, so it also proves the engine end to end (callback allowlist included: staging posts `http://127.0.0.1:8750/...`).

8. **Promote the same image to PROD.**
   ```bash
   cd ~/Developer/LQ-TTS/web
   docker image inspect lq-tts-web:prod >/dev/null 2>&1 && docker tag lq-tts-web:prod lq-tts-web:prod-prev
   docker tag lq-tts-web:stg lq-tts-web:prod
   docker compose --profile prod up -d prod
   docker image inspect -f '{{.Id}}' lq-tts-web:stg lq-tts-web:prod   # two identical ids
   docker inspect -f '{{.State.Health.Status}}' lq-tts-web-prod      # repeat until: healthy
   ```

9. **PROD health + smoke.**
   ```bash
   docker exec lq-tts-web-prod node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json()).then(console.log)"
   cd ~/Developer/LQ-TTS/web/e2e && E2E_TARGET=prod npx playwright test --project=smoke; cd ..
   ```
   Expected: `{ engine: 'ok', lqstudio: 'ok', signupUrl: ... }`; smoke `1 passed`.
   Web rollback: `docker tag lq-tts-web:prod-prev lq-tts-web:prod && docker compose --profile prod up -d prod`.

10. **Publish and record.** Push `main` per SOP G8 (no Claude attribution; `git push origin main`, then `git ls-remote origin main` equals `git rev-parse main`), delete the tag `pre-hardening` locally once PROD has run clean for a day, remove the worktree (`git worktree remove ../LQ-TTS-hardening`, after deleting its two `.env` symlinks), and close the brain task with `brain-task.py done ... --bukti` (engine suite 174 passed, web suite 252 passed, busy gate 0/0, callers 3×200, stg gate 5/5, PROD smoke 1/1, merged SHA).

---

## Self-review

Requirement → task map (every still-present item has a task; W10 dropped as fixed):

| Item | Task | Proof |
|---|---|---|
| E1 fresh None race | 1 | `test_job_purged_between_finish_and_reread_ends_quietly` (red: TypeError) |
| E2 device-error substring | 1 | `test_device_error_check_matches_whole_words_only`, `test_error_mentioning_timestamps_fails_the_job_without_exiting` |
| E5 purge race | 1 | `test_purge_skips_takes_deleted_mid_purge` |
| E6 sentence stuck running | 1 | `test_failed_job_leaves_no_sentence_running` |
| E3 empty key + replay order | 2 | `test_empty_idempotency_key_is_ignored`, `test_idempotent_replay_wins_over_disk_and_voice_checks` |
| E8 HTTPException / ffprobe / orphan folder | 2 | `test_unknown_route_and_wrong_method_use_the_error_shape`, `test_ffprobe_that_hangs_is_unsupported_audio`, `test_failed_voice_insert_leaves_no_folder` |
| E13 size limits / constant-time tokens | 2 | `test_json_body_over_the_limit_is_refused_streamed_or_not`, `test_streamed_upload_over_the_body_limit_is_refused_before_parsing`, `test_token_lookup_accepts_only_exact_tokens` |
| E4 callback URL at POST, secret per caller, catch-all + "dropped" | 3 | `test_callback_url_must_be_loopback_or_allowed_for_the_caller`, `test_every_caller_needs_a_callback_secret`, `test_unusable_url_or_unknown_caller_is_logged_as_dropped` |
| E13 callback SSRF | 3 | allowlist test above + `test_callback_hosts_are_per_caller_and_optional` |
| E7 SRT/VTT escaping | 4 | `test_cue_text_cannot_break_out_of_its_cue` |
| E11 unit length cap | 4 | `test_unpunctuated_script_is_cut_into_bounded_units_at_spaces`, `test_long_unit_prefers_to_break_after_a_comma` |
| E10 duplicate token | 5 | `test_duplicate_token_or_caller_fails_at_startup` |
| E12 soft_delete_voice | 5 | `git grep` empty; suite green on the cascade |
| E9 isolation + stale heartbeat | 5 | pins `test_other_caller_cannot_list_preview_or_delete_a_voice`, `test_health_is_503_when_the_worker_heartbeat_is_stale` |
| W1 numeric env | 6 | `rejects a PORT or MAX_UPLOAD_BYTES ...` |
| W2 errorHandler + headersSent | 6 | `errors.test.js` (3 tests) |
| W3 login revokes replaced session | 7 | `revokes the session a new login replaces` |
| W5 cancel after regenerate | 7 | `answers a regeneration only after its lease is released ...` |
| W4 reconcile literal | 7 | refactor; existing reconcile tests |
| W6/W7/W8 pins | 8 | three pins |
| W9 toProfile | 8 | `git grep` |

Placeholder scan: no TBD/TODO; every code step carries the code. Names checked across tasks: `caller_for`, `BodyLimit`, `MULTIPART_OVERHEAD_BYTES`, `FFPROBE_TIMEOUT_S`, `accepted`, `find_idempotent_job`, `callback_url_allowed`, `callback_hosts`, `MAX_UNIT_CHARS`, `wholeNumber`, `BODY_ERRORS` are defined where first used and reused verbatim. Test counts: engine 151 → 156 → 164 → 168 → 171 → 174; web 243 → 247 → 249 → 252 (one new file, 20).
