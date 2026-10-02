from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from .callbacks import CallbackSender
from .config import load_config
from .db import make_pool, migrate
from .pipeline import Deps, SynthesisFailed, job_dir, run_job
from .repo import Repo
from .retention import purge_unreferenced_takes
from .voiceprep import NoCleanSpeech, prepare_voice

LEASE_S, RENEW_S, PURGE_EVERY_S, IDLE_SLEEP_S = 60, 15, 3600, 1.0
log = logging.getLogger("lq_tts_engine.worker")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {"ts": round(record.created, 3), "level": record.levelname, "logger": record.name,
                   "msg": record.getMessage(), **getattr(record, "ctx", {})}
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def _is_device_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in text for marker in ("mps", "metal", "out of memory"))


class LeaseKeeper:
    """Renews the job lease and the worker heartbeat every RENEW_S seconds while a job runs."""

    def __init__(self, deps: Deps, job_id, device: str):
        self.deps, self.job_id, self.device = deps, job_id, device
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(RENEW_S):
            if self.job_id is not None:
                self.deps.repo.renew_lease(self.job_id, LEASE_S)
            self.deps.repo.heartbeat(model_loaded=True, device=self.device, rtf=self.deps.rolling_rtf())

    def __enter__(self) -> "LeaseKeeper":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()


def handle_voice(voice: dict, deps: Deps) -> None:
    ref = deps.data_dir / "voices" / str(voice["id"]) / "ref.wav"
    hint = voice["language"] if voice["language"] not in (None, "", "auto") else None
    ctx = {"ctx": {"voice": str(voice["id"])}}
    try:
        prepared = prepare_voice(Path(voice["source_path"]), ref, deps.asr,
                                 user_transcript=voice["user_transcript"], language=hint)
    except NoCleanSpeech:
        deps.repo.voice_failed(voice["id"], "no_clean_speech")
        log.info("voice failed: no clean speech", extra=ctx)
        return
    except subprocess.CalledProcessError:
        deps.repo.voice_failed(voice["id"], "unsupported_audio")
        log.info("voice failed: unreadable audio", extra=ctx)
        return
    except Exception:  # noqa: BLE001 - never leave a voice stuck in processing
        log.exception("voice failed: unexpected error", extra=ctx)
        deps.repo.voice_failed(voice["id"], "internal_error")
        return
    deps.repo.voice_ready(voice["id"], ref_audio_path=str(ref), ref_transcript=prepared.transcript,
                          ref_seconds=prepared.ref_seconds, clip_start_s=prepared.clip_start_s,
                          clip_end_s=prepared.clip_end_s, language=prepared.language)
    log.info("voice ready", extra={"ctx": {**ctx["ctx"], "clip": [prepared.clip_start_s, prepared.clip_end_s]}})


def report_expired(repo: Repo, callbacks) -> None:
    for row in repo.requeue_expired():
        log.warning("lease expired", extra={"ctx": {"job": str(row["id"]), "status": row["status"]}})
        if row["status"] != "failed":
            continue
        job = repo.get_job_any(row["id"])
        if job is not None and job["callback_url"]:
            callbacks.send(job["caller"], job["callback_url"],
                           {"job_id": str(job["id"]), "status": job["status"], "revision": job["revision"]})


def handle_job(job: dict, deps: Deps, callbacks: CallbackSender, *, device: str) -> None:
    repo = deps.repo
    ctx = {"ctx": {"job": str(job["id"]), "revision": job["revision"]}}
    log.info("job started", extra=ctx)
    try:
        with LeaseKeeper(deps, job["id"], device):
            outcome = run_job(job, deps, should_stop=lambda: repo.cancel_requested(job["id"]))
    except Exception as exc:  # noqa: BLE001 - classify and record every failure
        if _is_device_error(exc):
            log.exception("device error; exiting so pm2 restarts the worker", extra=ctx)
            sys.exit(3)
        log.exception("job failed", extra=ctx)
        repo.fail_job(job["id"], "synthesis_failed" if isinstance(exc, SynthesisFailed) else "internal_error")
        outcome = "failed"
    if outcome == "canceled":
        repo.mark_canceled(job["id"])
        fresh = repo.get_job_any(job["id"])
        if fresh is not None and fresh["deleted_at"] is not None:
            shutil.rmtree(job_dir(deps.data_dir, job["id"]), ignore_errors=True)
            repo.purge_job(job["id"])
            log.info("job deleted while running; purged", extra=ctx)
            return
    fresh = repo.get_job_any(job["id"])
    log.info("job finished", extra={"ctx": {**ctx["ctx"], "status": fresh["status"]}})
    if fresh["callback_url"]:
        callbacks.send(fresh["caller"], fresh["callback_url"],
                       {"job_id": str(fresh["id"]), "status": fresh["status"], "revision": fresh["revision"]})


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    cfg = load_config()
    migrate(cfg.database_url, cfg.schema)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    repo = Repo(make_pool(cfg.database_url, cfg.schema, max_size=4))
    repo.heartbeat(model_loaded=False, device=cfg.device, rtf=None)

    from .asr import WhisperTranscriber
    from .synth import VoxSynth

    log.info("loading models", extra={"ctx": {"device": cfg.device}})
    deps = Deps(repo=repo, synth=VoxSynth(cfg.device), asr=WhisperTranscriber(cfg.whisper_model),
                data_dir=cfg.data_dir)
    callbacks = CallbackSender(cfg.callback_secrets)
    log.info("worker ready")
    last_purge = 0.0
    while True:
        repo.heartbeat(model_loaded=True, device=cfg.device, rtf=deps.rolling_rtf())
        report_expired(repo, callbacks)
        if time.monotonic() - last_purge > PURGE_EVERY_S:
            removed = purge_unreferenced_takes(cfg.data_dir, repo.referenced_take_paths())
            log.info("purged takes", extra={"ctx": {"removed": removed}})
            last_purge = time.monotonic()
        voice = repo.next_voice_to_prepare()
        if voice is not None:
            with LeaseKeeper(deps, None, cfg.device):
                handle_voice(voice, deps)
            continue
        job = repo.claim_job(LEASE_S)
        if job is not None:
            handle_job(job, deps, callbacks, device=cfg.device)
            continue
        time.sleep(IDLE_SLEEP_S)


if __name__ == "__main__":
    main()
