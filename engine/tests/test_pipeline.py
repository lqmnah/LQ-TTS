import pytest
import soundfile as sf

from lq_tts_engine.audio.finish import measure_lufs
from lq_tts_engine.pipeline import Deps, latest_revision, revision_dir, run_job
from lq_tts_engine.text.split import split_script
from tests.fakes import FakeTranscriber, ToneSynth

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def setup(repo, voice, tmp_path, settings=None, scripted=None, synth=None):
    units = split_script(TEXT)
    repo.create_job(caller="lq-tts", voice_id=voice["id"], text=TEXT, settings=settings or {}, callback_url=None,
                    idempotency_key=None, units=units)
    deps = Deps(repo=repo, synth=synth or ToneSynth(),
                asr=FakeTranscriber(sentence_texts={u.idx: u.text for u in units}, scripted=scripted),
                data_dir=tmp_path / "data")
    return deps, repo.claim_job()


never = lambda: False  # noqa: E731


def test_happy_path_writes_all_formats_with_exact_pauses(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    assert run_job(job, deps, should_stop=never) == "done"
    out = revision_dir(deps.data_dir, job["id"], 1)
    assert {p.name for p in out.iterdir()} == {"final.mp3", "final.wav", "subs.srt", "subs.vtt"}
    s = repo.list_sentences(job["id"])
    assert [x["status"] for x in s] == ["done"] * 3 and [x["takes"] for x in s] == [1, 1, 1]
    assert s[1]["start_s"] - s[0]["end_s"] == pytest.approx(0.45, abs=1e-3)
    assert s[2]["start_s"] - s[1]["end_s"] == pytest.approx(0.80, abs=1e-3)
    assert (out / "subs.srt").read_text().count(" --> ") == 3
    assert abs(measure_lufs(out / "final.wav") + 14.0) <= 1.0
    job_row = repo.get_job_any(job["id"])
    assert job_row["status"] == "done"
    assert job_row["audio_seconds"] == pytest.approx(sf.info(out / "final.wav").duration, abs=0.01)


def test_failed_check_triggers_retake_and_keeps_passing_take(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, scripted={1: ["salah total", "salah lagi"]})
    run_job(job, deps, should_stop=never)
    s1 = repo.get_sentence(job["id"], 1)
    assert (s1["status"], s1["takes"], s1["score"]) == ("done", 3, pytest.approx(1.0))
    assert s1["audio_path"].endswith("s0001_r1_t3.wav")
    assert len(deps.synth.calls) == 5


def test_four_failed_takes_mark_needs_review_but_job_completes(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, scripted={0: ["a b c"] * 4})
    assert run_job(job, deps, should_stop=never) == "done"
    s0 = repo.get_sentence(job["id"], 0)
    assert (s0["status"], s0["takes"]) == ("needs_review", 4)


def test_silent_take_is_retaken(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, synth=ToneSynth(silent_takes=1))
    run_job(job, deps, should_stop=never)
    assert repo.get_sentence(job["id"], 0)["takes"] == 2


def test_cancel_then_resume_skips_finished_sentences(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    done_count = {"n": 0}

    def stop_after_first():
        done_count["n"] += 1
        return done_count["n"] > 2  # before take 1 of sentence 0, then between sentences

    assert run_job(job, deps, should_stop=stop_after_first) == "canceled"
    assert [x["status"] for x in repo.list_sentences(job["id"])] == ["done", "pending", "pending"]
    assert run_job(job, deps, should_stop=never) == "done"
    assert len(deps.synth.calls) == 3


def test_regenerate_builds_new_revision_and_keeps_old(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    run_job(job, deps, should_stop=never)
    assert repo.request_regenerate("lq-tts", job["id"], 1, "Kalimat kedua yang baru.", None) == 2
    deps.asr.sentence_texts[1] = "Kalimat kedua yang baru."
    job2 = repo.claim_job()
    assert run_job(job2, deps, should_stop=never) == "done"
    assert len(deps.synth.calls) == 4
    assert (revision_dir(deps.data_dir, job["id"], 1) / "final.wav").exists()
    assert (revision_dir(deps.data_dir, job["id"], 2) / "final.wav").exists()
    assert latest_revision(deps.data_dir, job["id"]) == 2
    assert repo.get_sentence(job["id"], 1)["audio_path"].endswith("s0001_r2_t1.wav")


def test_only_requested_formats_are_kept(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, settings={"formats": ["mp3"]})
    run_job(job, deps, should_stop=never)
    assert {p.name for p in revision_dir(deps.data_dir, job["id"], 1).iterdir()} == {"final.mp3"}


def test_speed_setting_slows_sentences(repo, ready_voice, tmp_path):
    deps_fast, job_fast = setup(repo, ready_voice, tmp_path / "a", settings={"speed": 1.0})
    run_job(job_fast, deps_fast, should_stop=never)
    deps_slow, job_slow = setup(repo, ready_voice, tmp_path / "b", settings={"speed": 0.8})
    run_job(job_slow, deps_slow, should_stop=never)
    fast = repo.get_sentence(job_fast["id"], 0)["duration_s"]
    slow = repo.get_sentence(job_slow["id"], 0)["duration_s"]
    assert slow / fast == pytest.approx(1.25, rel=0.05)


def test_voice_not_ready_fails_job(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    repo.delete_voice_cascade("lq-tts", ready_voice["id"])
    assert run_job(job, deps, should_stop=never) == "failed"
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "voice_not_ready")


def test_failed_assembly_leaves_previous_revision_visible(repo, ready_voice, tmp_path, monkeypatch):
    deps, job = setup(repo, ready_voice, tmp_path)
    assert run_job(job, deps, should_stop=never) == "done"
    assert repo.request_regenerate("lq-tts", job["id"], 1, "Kalimat kedua yang baru.", None) == 2
    deps.asr.sentence_texts[1] = "Kalimat kedua yang baru."
    job2 = repo.claim_job()

    def boom(*args, **kwargs):
        raise RuntimeError("encode failed")

    monkeypatch.setattr("lq_tts_engine.pipeline.finish.encode_mp3", boom)
    with pytest.raises(RuntimeError, match="encode failed"):
        run_job(job2, deps, should_stop=never)
    assert latest_revision(deps.data_dir, job["id"]) == 1
    assert not revision_dir(deps.data_dir, job["id"], 2).exists()
def test_each_sentence_is_logged(repo, ready_voice, tmp_path, caplog):
    caplog.set_level("INFO", logger="lq_tts_engine.pipeline")
    deps, job = setup(repo, ready_voice, tmp_path)
    run_job(job, deps, should_stop=never)
    recs = [r for r in caplog.records if r.name == "lq_tts_engine.pipeline" and r.getMessage() == "sentence done"]
    assert [r.ctx["idx"] for r in recs] == [0, 1, 2] and all(r.ctx["status"] == "done" for r in recs)




def test_failed_job_leaves_no_sentence_running(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=ValueError("boom")))
    with pytest.raises(ValueError):
        run_job(job, deps, should_stop=never)
    assert [s["status"] for s in repo.list_sentences(job["id"])] == ["pending"] * len(split_script(TEXT))
