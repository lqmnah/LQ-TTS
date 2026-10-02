import uuid

import pytest

from lq_tts_engine.pipeline import Deps, job_dir, run_job
from lq_tts_engine.text.split import split_script
from tests.fakes import FakeTranscriber, ToneSynth
from tests.test_api_voices import AUTH, OTHER, cfg, client  # noqa: F401  (fixtures)

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def post_job(client, voice, text=TEXT, **extra):
    headers = {**AUTH, **extra.pop("headers", {})}
    return client.post("/v1/jobs", headers=headers, json={"voice_id": str(voice["id"]), "text": text, **extra})


def work(repo, cfg, text=TEXT):
    units = split_script(text)
    deps = Deps(repo=repo, synth=ToneSynth(), asr=FakeTranscriber(sentence_texts={u.idx: u.text for u in units}),
                data_dir=cfg.data_dir)
    job = repo.claim_job()
    assert run_job(job, deps, should_stop=lambda: False) == "done"
    return deps


def test_create_job_returns_count_and_estimate(client, ready_voice):
    r = post_job(client, ready_voice)
    assert r.status_code == 202
    body = r.json()
    assert body["sentences_total"] == 3 and body["estimated_seconds"] == round(len(TEXT) / 16 * 0.82)


def test_job_validation_errors(client, ready_voice, repo):
    assert post_job(client, ready_voice, text="   ").json()["error"]["code"] == "invalid_text"
    r = post_job(client, ready_voice, text="a" * 20_001)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    r = post_job(client, ready_voice, settings={"speed": 2.0})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_settings"
    assert post_job(client, {"id": uuid.uuid4()}).status_code == 404
    vid = uuid.uuid4()
    repo.create_voice(vid, "lq-tts", "user-1", "x", None, "/x", None)
    r = post_job(client, {"id": vid})
    assert r.status_code == 409 and r.json()["error"]["code"] == "voice_not_ready"


def test_idempotency_key_returns_same_job(client, ready_voice):
    a = post_job(client, ready_voice, headers={"Idempotency-Key": "k1"}).json()["id"]
    b = post_job(client, ready_voice, headers={"Idempotency-Key": "k1"}).json()["id"]
    assert a == b


def test_full_flow_status_sentences_files_and_events(client, ready_voice, repo, cfg):
    job_id = post_job(client, ready_voice).json()["id"]
    queued = client.get(f"/v1/jobs/{job_id}", headers=AUTH).json()
    assert (queued["status"], queued["queue_position"], queued["progress"]) == ("queued", 0, {"done": 0, "total": 3})
    work(repo, cfg)
    job = client.get(f"/v1/jobs/{job_id}", headers=AUTH).json()
    assert job["status"] == "done" and job["revision"] == 1 and job["needs_review"] == 0
    assert set(job["files"]) == {"final.mp3", "final.wav", "subs.srt", "subs.vtt"}
    sentences = client.get(f"/v1/jobs/{job_id}/sentences", headers=AUTH).json()
    assert [s["status"] for s in sentences] == ["done"] * 3
    audio = client.get(sentences[0]["audio_url"], headers=AUTH)
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"
    mp3 = client.get(job["files"]["final.mp3"], headers=AUTH)
    assert mp3.status_code == 200 and mp3.headers["content-type"] == "audio/mpeg"
    srt = client.get(f"/v1/jobs/{job_id}/files/subs.srt", headers=AUTH)
    assert srt.text.count(" --> ") == 3
    with client.stream("GET", f"/v1/jobs/{job_id}/events", headers=AUTH) as stream:
        text = "".join(stream.iter_text())
    assert text.count("event: sentence_done") == 3 and text.rstrip().endswith('"revision": 1}')
    assert "event: job_done" in text


def test_files_404_for_unknown_name_or_revision(client, ready_voice, repo, cfg):
    job_id = post_job(client, ready_voice).json()["id"]
    work(repo, cfg)
    assert client.get(f"/v1/jobs/{job_id}/files/secret.txt", headers=AUTH).status_code == 404
    assert client.get(f"/v1/jobs/{job_id}/files/final.mp3?revision=7", headers=AUTH).status_code == 404


def test_regenerate_rules_and_new_revision(client, ready_voice, repo, cfg):
    job_id = post_job(client, ready_voice).json()["id"]
    r = client.post(f"/v1/jobs/{job_id}/sentences/1/regenerate", headers=AUTH, json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_regeneratable"
    work(repo, cfg)
    r = client.post(f"/v1/jobs/{job_id}/sentences/1/regenerate", headers=AUTH,
                    json={"text": "Ini kalimat satu. Ini kalimat dua yang lain."})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_text"
    assert client.post(f"/v1/jobs/{job_id}/sentences/9/regenerate", headers=AUTH, json={}).status_code == 404
    r = client.post(f"/v1/jobs/{job_id}/sentences/1/regenerate", headers=AUTH,
                    json={"text": "Kalimat kedua yang baru.", "style": "cheerful"})
    assert r.status_code == 202 and r.json() == {"revision": 2}
    s1 = repo.get_sentence(uuid.UUID(job_id), 1)
    assert (s1["text"], s1["style"], s1["status"]) == ("Kalimat kedua yang baru.", "cheerful", "pending")


def test_cancel_and_delete(client, ready_voice, repo, cfg):
    queued = post_job(client, ready_voice).json()["id"]
    assert client.post(f"/v1/jobs/{queued}/cancel", headers=AUTH).status_code == 202
    assert client.get(f"/v1/jobs/{queued}", headers=AUTH).json()["status"] == "canceled"
    finished = post_job(client, ready_voice).json()["id"]
    work(repo, cfg)
    folder = job_dir(cfg.data_dir, finished)
    assert folder.exists()
    assert client.delete(f"/v1/jobs/{finished}", headers={"Authorization": f"Bearer {OTHER}"}).status_code == 404
    assert client.delete(f"/v1/jobs/{finished}", headers=AUTH).status_code == 204
    assert not folder.exists() and repo.get_job_any(uuid.UUID(finished)) is None
    assert client.get(f"/v1/jobs/{finished}", headers=AUTH).status_code == 404


def test_disk_full_refuses_new_jobs(cfg, repo, ready_voice):
    from fastapi.testclient import TestClient

    from lq_tts_engine.api.app import create_app
    from lq_tts_engine.config import Config

    full = TestClient(create_app(Config(**{**cfg.__dict__, "min_free_gb": 1e12}), repo))
    r = post_job(full, ready_voice)
    assert r.status_code == 503 and r.json()["error"]["code"] == "disk_full"
