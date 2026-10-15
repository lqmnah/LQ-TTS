import shutil
import time
import uuid

import numpy as np
import pytest
import soundfile as sf

from lq_tts_engine.pipeline import Deps, job_dir
from lq_tts_engine.text.split import split_script
from lq_tts_engine.worker import _is_device_error, handle_job, handle_voice
from tests.fakes import FakeTranscriber, ToneSynth
from tests.test_voiceprep import steady_words

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini."


class Recorder:
    def __init__(self):
        self.sent = []

    def send(self, caller, url, payload):
        self.sent.append((caller, url, payload))


def make(repo, voice, tmp_path, synth=None, callback_url="http://app.local/cb"):
    units = split_script(TEXT)
    repo.create_job(caller="lq-tts", voice_id=voice["id"], text=TEXT, settings={}, callback_url=callback_url,
                    idempotency_key=None, units=units)
    deps = Deps(repo=repo, synth=synth or ToneSynth(),
                asr=FakeTranscriber(sentence_texts={u.idx: u.text for u in units}), data_dir=tmp_path / "data")
    return deps, repo.claim_job()


def test_done_job_sends_callback(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path)
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    assert rec.sent == [("lq-tts", "http://app.local/cb", {"job_id": str(job["id"]), "status": "done", "revision": 1})]


def test_unexpected_error_fails_job_and_reports(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=ValueError("boom")))
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "internal_error")
    assert rec.sent[0][2]["status"] == "failed"


def test_silent_synthesis_fails_job_as_synthesis_failed(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(silent_takes=99))
    handle_job(job, deps, Recorder(), device="cpu")
    assert repo.get_job_any(job["id"])["error_code"] == "synthesis_failed"


def test_device_error_exits_for_pm2_restart_and_leaves_job_for_recovery(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=RuntimeError("MPS backend out of memory")))
    with pytest.raises(SystemExit) as exc:
        handle_job(job, deps, Recorder(), device="mps")
    assert exc.value.code == 3
    assert repo.get_job_any(job["id"])["status"] == "running"


def test_cancel_marks_canceled_and_delete_purges_files(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path)
    repo.request_cancel("lq-tts", job["id"])
    handle_job(job, deps, Recorder(), device="cpu")
    assert repo.get_job_any(job["id"])["status"] == "canceled"

    deps2, job2 = make(repo, ready_voice, tmp_path)
    job_dir(deps2.data_dir, job2["id"]).mkdir(parents=True)
    repo.delete_job("lq-tts", job2["id"])
    rec = Recorder()
    handle_job(job2, deps2, rec, device="cpu")
    assert repo.get_job_any(job2["id"]) is None and not job_dir(deps2.data_dir, job2["id"]).exists()
    assert rec.sent == []


def _voice(repo, tmp_path, seconds, words):
    src = tmp_path / f"src-{uuid.uuid4().hex}.wav"
    t = np.arange(int(seconds * 48000)) / 48000
    sf.write(src, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000)
    vid = uuid.uuid4()
    repo.create_voice(vid, "lq-tts", "u", "Pandji", None, str(src), None)
    deps = Deps(repo=repo, synth=ToneSynth(), asr=FakeTranscriber(voice_words=words, duration=seconds),
                data_dir=tmp_path / "data")
    return vid, deps


def test_handle_voice_ready_and_failed(repo, tmp_path):
    vid, deps = _voice(repo, tmp_path, 30.0, steady_words(2.0, 16.0, gap=0.3))
    handle_voice(repo.get_voice_any(vid), deps)
    v = repo.get_voice_any(vid)
    assert v["status"] == "ready" and (deps.data_dir / "voices" / str(vid) / "ref.wav").exists()

    vid2, deps2 = _voice(repo, tmp_path, 6.0, steady_words(0.0, 5.0))
    handle_voice(repo.get_voice_any(vid2), deps2)
    v2 = repo.get_voice_any(vid2)
    assert (v2["status"], v2["error_code"]) == ("failed", "no_clean_speech")
class ExplodingTranscriber(FakeTranscriber):
    def transcribe(self, path, language, vad=False):
        raise ValueError("decoder exploded")
def test_handle_voice_unexpected_error_marks_failed(repo, tmp_path):
    vid, deps = _voice(repo, tmp_path, 30.0, steady_words(2.0, 16.0, gap=0.3))
    deps.asr = ExplodingTranscriber()
    handle_voice(repo.get_voice_any(vid), deps)
    v = repo.get_voice_any(vid)
    assert (v["status"], v["error_code"]) == ("failed", "internal_error")
def test_report_expired_sends_callback_for_worker_crashed(repo, ready_voice, tmp_path):
    from lq_tts_engine.worker import report_expired
    repo.create_job(caller="lq-tts", voice_id=ready_voice["id"], text=TEXT, settings={},
                    callback_url="http://app.local/cb", idempotency_key=None, units=split_script(TEXT))
    rec = Recorder()
    for _ in range(3):
        job = repo.claim_job(lease_s=0)
        time.sleep(0.01)
        report_expired(repo, rec)
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "worker_crashed")
    assert rec.sent == [("lq-tts", "http://app.local/cb", {"job_id": str(job["id"]), "status": "failed", "revision": 1})]
def test_lease_keeper_without_job_keeps_heartbeat_fresh(repo, monkeypatch, tmp_path):
    from lq_tts_engine import worker
    monkeypatch.setattr(worker, "RENEW_S", 0.05)
    deps = Deps(repo=repo, synth=ToneSynth(), asr=FakeTranscriber(), data_dir=tmp_path / "data")
    repo.heartbeat(model_loaded=True, device="cpu", rtf=None)
    before = repo.worker_state()["beat_at"]
    with worker.LeaseKeeper(deps, None, "cpu"):
        time.sleep(0.3)
    assert repo.worker_state()["beat_at"] > before
def test_job_deleted_during_assembly_is_purged(repo, ready_voice, tmp_path, monkeypatch):
    from lq_tts_engine import pipeline
    deps, job = make(repo, ready_voice, tmp_path)
    original = pipeline.assemble_revision
    def deleting(*args, **kwargs):
        repo.delete_job("lq-tts", job["id"])
        return original(*args, **kwargs)
    monkeypatch.setattr(pipeline, "assemble_revision", deleting)
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    assert repo.get_job_any(job["id"]) is None and not job_dir(deps.data_dir, job["id"]).exists()
    assert rec.sent == []
def test_deleted_job_with_missing_voice_is_purged(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path)
    repo.delete_job("lq-tts", job["id"])
    repo.delete_voice_cascade("lq-tts", ready_voice["id"])
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    assert repo.get_job_any(job["id"]) is None and not job_dir(deps.data_dir, job["id"]).exists()
    assert rec.sent == []
def test_voice_deleted_during_prep_stays_deleted(repo, tmp_path):
    vid, deps = _voice(repo, tmp_path, 30.0, steady_words(2.0, 16.0, gap=0.3))
    class DeletingTranscriber(FakeTranscriber):
        def transcribe(self, path, language, vad=False):
            repo.delete_voice_cascade("lq-tts", vid)
            return super().transcribe(path, language, vad=vad)
    deps.asr = DeletingTranscriber(voice_words=steady_words(2.0, 16.0, gap=0.3), duration=30.0)
    handle_voice(repo.get_voice_any(vid), deps)
    v = repo.get_voice_any(vid)
    assert v["status"] == "processing" and v["deleted_at"] is not None
    assert not (deps.data_dir / "voices" / str(vid)).exists()




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
