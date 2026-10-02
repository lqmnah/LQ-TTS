import threading
import uuid

from lq_tts_engine.text.split import split_script
from tests.conftest import sql

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def new_job(repo, voice, key=None, caller="lq-tts"):
    return repo.create_job(caller=caller, voice_id=voice["id"], text=TEXT, settings={"speed": 0.9},
                           callback_url=None, idempotency_key=key, units=split_script(TEXT))


def test_voice_lifecycle_and_caller_isolation(repo):
    vid = uuid.uuid4()
    row = repo.create_voice(vid, "lq-tts", "user-1", "Pandji", None, "/x/source.mp3", "halo")
    assert row["status"] == "processing" and row["user_transcript"] == "halo"
    assert repo.get_voice("lq-studio", vid) is None
    assert repo.next_voice_to_prepare()["id"] == vid
    repo.voice_ready(vid, ref_audio_path="/x/ref.wav", ref_transcript="halo semua", ref_seconds=14.25,
                     clip_start_s=0.0, clip_end_s=14.25, language="id")
    v = repo.get_voice("lq-tts", vid)
    assert (v["status"], v["language"], v["clip_end_s"]) == ("ready", "id", 14.25)
    assert repo.next_voice_to_prepare() is None
    assert [x["id"] for x in repo.list_voices("lq-tts", "user-1")] == [vid]
    assert repo.soft_delete_voice("lq-tts", vid) is True
    assert repo.get_voice("lq-tts", vid) is None and repo.list_voices("lq-tts", "user-1") == []
    assert repo.get_voice_any(vid)["deleted_at"] is not None


def test_voice_failed_records_code(repo):
    vid = uuid.uuid4()
    repo.create_voice(vid, "lq-tts", "u", "n", None, "/x", None)
    repo.voice_failed(vid, "no_clean_speech")
    v = repo.get_voice_any(vid)
    assert (v["status"], v["error_code"]) == ("failed", "no_clean_speech")


def test_create_job_stores_sentences_in_order(repo, ready_voice):
    job, created = new_job(repo, ready_voice)
    assert created and job["status"] == "queued" and job["revision"] == 1 and job["chars"] == len(TEXT)
    rows = repo.list_sentences(job["id"])
    assert [(r["idx"], r["paragraph_idx"], r["status"]) for r in rows] == [(0, 0, "pending"), (1, 0, "pending"), (2, 1, "pending")]
    assert repo.get_sentence(job["id"], 2)["text"] == "Paragraf baru mulai sekarang."
    assert repo.get_job("lq-studio", job["id"]) is None


def test_idempotency_key_returns_same_job_within_24h(repo, ready_voice):
    first, created1 = new_job(repo, ready_voice, key="abc")
    again, created2 = new_job(repo, ready_voice, key="abc")
    assert created1 and not created2 and again["id"] == first["id"]


def test_idempotency_key_older_than_24h_creates_new_job(repo, ready_voice):
    first, _ = new_job(repo, ready_voice, key="abc")
    sql(repo, "UPDATE jobs SET created_at = now() - interval '25 hours' WHERE id=%s", (first["id"],))
    second, created = new_job(repo, ready_voice, key="abc")
    assert created and second["id"] != first["id"]
    assert repo.get_job_any(first["id"])["idempotency_key"] is None


def test_purge_job_removes_job_and_sentences(repo, ready_voice):
    job, _ = new_job(repo, ready_voice)
    repo.purge_job(job["id"])
    assert repo.get_job_any(job["id"]) is None and repo.list_sentences(job["id"]) == []


def test_concurrent_same_idempotency_key_returns_one_job(repo, ready_voice):
    # warm the pool so both threads get an open connection and truly overlap
    with repo.pool.connection(), repo.pool.connection():
        pass
    barrier = threading.Barrier(2)
    results, errors = [], []

    def worker():
        barrier.wait()
        try:
            results.append(new_job(repo, ready_voice, key="race"))
        except Exception as exc:  # surfaced via the assertion below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert results[0][0]["id"] == results[1][0]["id"]
    assert sorted(created for _, created in results) == [False, True]
    assert sql(repo, "SELECT count(*) AS n FROM jobs WHERE idempotency_key='race'").fetchone()["n"] == 1
