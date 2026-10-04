import pytest

from lq_tts_engine.repo import NotRegeneratable
from lq_tts_engine.text.split import split_script
from tests.conftest import sql

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def new_job(repo, voice, text=TEXT, priority=5):
    job, _ = repo.create_job(caller="lq-tts", voice_id=voice["id"], text=text, settings={}, callback_url=None,
                             idempotency_key=None, units=split_script(text), priority=priority)
    return job


def finish_all(repo, job_id):
    for s in repo.list_sentences(job_id):
        repo.save_sentence(job_id, s["idx"], status="done", takes=1, score=1.0, asr_text=s["text"],
                           audio_path=f"/takes/{s['idx']}.wav", duration_s=1.0)
    repo.finish_job(job_id, 3.0)


def test_claim_is_fifo_and_exclusive(repo, ready_voice):
    a, b = new_job(repo, ready_voice), new_job(repo, ready_voice)
    first, second = repo.claim_job(), repo.claim_job()
    assert (first["id"], second["id"]) == (a["id"], b["id"])
    assert first["status"] == "running" and first["started_at"] is not None
    assert repo.claim_job() is None


def test_regenerate_jumps_the_queue(repo, ready_voice):
    done = new_job(repo, ready_voice)
    repo.claim_job()
    finish_all(repo, done["id"])
    waiting = new_job(repo, ready_voice)
    assert repo.request_regenerate("lq-tts", done["id"], 1, None, None) == 2
    assert repo.queue_position(waiting["id"]) == 1
    assert repo.claim_job()["id"] == done["id"]


def test_expired_lease_requeues_and_resumes_at_next_sentence(repo, ready_voice):
    job = new_job(repo, ready_voice)
    repo.claim_job(lease_s=0)
    repo.save_sentence(job["id"], 0, status="done", takes=1, score=1.0, asr_text="x", audio_path="/a.wav", duration_s=1.0)
    repo.mark_sentence_running(job["id"], 1)
    rows = repo.requeue_expired()
    assert [(r["id"], r["status"]) for r in rows] == [(job["id"], "queued")]
    fresh = repo.get_job_any(job["id"])
    assert fresh["attempts"] == 1 and fresh["lease_until"] is None
    assert repo.next_pending_sentence(job["id"])["idx"] == 1


def test_third_expiry_fails_job_as_worker_crashed(repo, ready_voice):
    job = new_job(repo, ready_voice)
    for _ in range(3):
        assert repo.claim_job(lease_s=0)["id"] == job["id"]
        repo.requeue_expired()
    fresh = repo.get_job_any(job["id"])
    assert (fresh["status"], fresh["error_code"], fresh["attempts"]) == ("failed", "worker_crashed", 3)
    assert repo.claim_job() is None


def test_renewed_lease_is_not_requeued(repo, ready_voice):
    job = new_job(repo, ready_voice)
    repo.claim_job(lease_s=0)
    repo.renew_lease(job["id"], 60)
    assert repo.requeue_expired() == []


def test_cancel_queued_job_is_immediate_running_job_is_requested(repo, ready_voice):
    queued, running = new_job(repo, ready_voice), new_job(repo, ready_voice)
    sql(repo, "UPDATE jobs SET created_at = created_at - interval '1 minute' WHERE id=%s", (running["id"],))
    assert repo.claim_job()["id"] == running["id"]
    assert repo.request_cancel("lq-tts", queued["id"]) and repo.request_cancel("lq-tts", running["id"])
    assert repo.get_job_any(queued["id"])["status"] == "canceled"
    assert repo.get_job_any(running["id"])["status"] == "running" and repo.cancel_requested(running["id"])
    repo.mark_canceled(running["id"])
    assert repo.get_job_any(running["id"])["status"] == "canceled"
    assert repo.request_cancel("lq-studio", queued["id"]) is False


def test_regenerate_rules(repo, ready_voice):
    job = new_job(repo, ready_voice)
    with pytest.raises(NotRegeneratable):
        repo.request_regenerate("lq-tts", job["id"], 0, None, None)
    repo.claim_job()
    finish_all(repo, job["id"])
    with pytest.raises(LookupError):
        repo.request_regenerate("lq-tts", job["id"], 99, None, None)
    with pytest.raises(LookupError):
        repo.request_regenerate("lq-studio", job["id"], 0, None, None)
    sql(repo, "UPDATE sentences SET style='cheerful' WHERE job_id=%s AND idx=1", (job["id"],))
    assert repo.request_regenerate("lq-tts", job["id"], 1, "Kalimat kedua yang baru.", "") == 2
    s1 = repo.get_sentence(job["id"], 1)
    assert (s1["status"], s1["text"], s1["style"]) == ("pending", "Kalimat kedua yang baru.", None)
    assert repo.get_sentence(job["id"], 0)["status"] == "done"
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["priority"], j["revision"], j["finished_at"]) == ("queued", 10, 2, None)


def test_finish_and_fail(repo, ready_voice):
    a, b = new_job(repo, ready_voice), new_job(repo, ready_voice)
    repo.claim_job()
    repo.set_sentence_times(a["id"], [(0, 0.0, 1.0), (1, 1.45, 2.0), (2, 2.8, 3.0)])
    finish_all(repo, a["id"])
    ja = repo.get_job_any(a["id"])
    assert (ja["status"], ja["audio_seconds"], ja["priority"], ja["lease_until"]) == ("done", 3.0, 0, None)
    assert repo.get_sentence(a["id"], 1)["start_s"] == pytest.approx(1.45)
    repo.claim_job()
    repo.fail_job(b["id"], "internal_error")
    jb = repo.get_job_any(b["id"])
    assert (jb["status"], jb["error_code"]) == ("failed", "internal_error") and jb["finished_at"] is not None


def test_delete_job(repo, ready_voice):
    queued, running = new_job(repo, ready_voice), new_job(repo, ready_voice)
    sql(repo, "UPDATE jobs SET created_at = created_at - interval '1 minute' WHERE id=%s", (running["id"],))
    repo.claim_job()
    assert repo.delete_job("lq-tts", queued["id"])["status"] == "canceled"
    r = repo.delete_job("lq-tts", running["id"])
    assert r["status"] == "running" and repo.cancel_requested(running["id"])
    assert repo.get_job("lq-tts", running["id"]) is None
    assert repo.delete_job("lq-tts", running["id"]) is None


def test_queue_metrics_and_worker_state(repo, ready_voice):
    a, b = new_job(repo, ready_voice), new_job(repo, ready_voice)
    assert repo.queue_depth() == 2 and repo.queue_position(b["id"]) == 1
    assert repo.chars_ahead(b["id"]) == a["chars"]
    assert repo.worker_state() is None
    repo.heartbeat(model_loaded=False, device="mps", rtf=None)
    repo.heartbeat(model_loaded=True, device="mps", rtf=0.7)
    repo.heartbeat(model_loaded=True, device="mps", rtf=None)
    st = repo.worker_state()
    assert (st["model_loaded"], st["device"], st["rtf"]) == (True, "mps", pytest.approx(0.7))
    assert st["age_s"] < 5


def test_referenced_take_paths(repo, ready_voice):
    job = new_job(repo, ready_voice)
    repo.save_sentence(job["id"], 0, status="done", takes=1, score=1.0, asr_text="x", audio_path="/t/a.wav", duration_s=1.0)
    assert repo.referenced_take_paths() == {"/t/a.wav"}


def test_deleted_running_job_is_reclaimed_after_crash(repo, ready_voice):
    job = new_job(repo, ready_voice)
    repo.claim_job(lease_s=0)
    assert repo.delete_job("lq-tts", job["id"])["status"] == "running"
    repo.requeue_expired()
    claimed = repo.claim_job()
    assert claimed is not None and claimed["id"] == job["id"]
    assert claimed["cancel_requested"] is True and claimed["deleted_at"] is not None


def test_delete_voice_cascade_marks_jobs_deleted(repo, ready_voice):
    done = new_job(repo, ready_voice)
    assert repo.claim_job()["id"] == done["id"]
    finish_all(repo, done["id"])
    running = new_job(repo, ready_voice)
    assert repo.claim_job()["id"] == running["id"]
    queued = new_job(repo, ready_voice)
    assert repo.delete_voice_cascade("other", ready_voice["id"]) is None
    rows = repo.delete_voice_cascade("lq-tts", ready_voice["id"])
    assert {r["id"]: r["status"] for r in rows} == {done["id"]: "done", running["id"]: "running",
                                                     queued["id"]: "canceled"}
    jobs = {j: repo.get_job_any(j) for j in (done["id"], running["id"], queued["id"])}
    assert all(j["deleted_at"] is not None for j in jobs.values())
    assert jobs[running["id"]]["cancel_requested"] and jobs[running["id"]]["status"] == "running"
    assert jobs[queued["id"]]["status"] == "canceled"
    assert repo.get_voice_any(ready_voice["id"])["deleted_at"] is not None
    assert repo.delete_voice_cascade("lq-tts", ready_voice["id"]) is None


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
