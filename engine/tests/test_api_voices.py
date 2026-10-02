import uuid
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from lq_tts_engine.api import app as api_module
from lq_tts_engine.api.app import create_app
from lq_tts_engine.config import Config

TOKEN, OTHER = "tok-lqtts", "tok-studio"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def cfg(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    return Config(database_url="unused", schema="unused", data_dir=data,
                  tokens={TOKEN: "lq-tts", OTHER: "lq-studio"},
                  callback_secrets={"lq-tts": "s1", "lq-studio": "s2"}, device="cpu", whisper_model="small",
                  min_free_gb=0.0)


@pytest.fixture
def client(cfg, repo):
    return TestClient(create_app(cfg, repo, sse_poll_s=0.05))


def wav_bytes(tmp_path, seconds=12.0):
    path = tmp_path / "upload.wav"
    t = np.arange(int(seconds * 48000)) / 48000
    sf.write(path, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000)
    return path.read_bytes()


def upload(client, tmp_path, name="Pandji", filename="vo.wav", data=None, headers=AUTH):
    return client.post("/v1/voices", headers=headers,
                       data={"name": name, "owner_ref": "user-1", "language": "id"},
                       files={"audio": (filename, data if data is not None else wav_bytes(tmp_path), "audio/wav")})


def test_requests_without_valid_token_are_rejected(client):
    for headers in ({}, {"Authorization": "Bearer nope"}):
        r = client.get("/v1/voices?owner_ref=user-1", headers=headers)
        assert r.status_code == 401 and r.json() == {"error": {"code": "unauthorized", "message": "missing or invalid service token"}}


def test_upload_creates_processing_voice_and_stores_source(client, cfg, repo, tmp_path):
    r = upload(client, tmp_path)
    assert r.status_code == 202 and r.json()["status"] == "processing"
    vid = uuid.UUID(r.json()["id"])
    row = repo.get_voice("lq-tts", vid)
    assert Path(row["source_path"]) == cfg.data_dir / "voices" / str(vid) / "source.wav"
    assert Path(row["source_path"]).stat().st_size > 0


def test_unsupported_extension_and_garbage_audio_are_415(client, tmp_path):
    assert upload(client, tmp_path, filename="notes.txt").json()["error"]["code"] == "unsupported_audio"
    r = upload(client, tmp_path, filename="fake.mp3", data=b"not audio at all" * 100)
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_audio"


def test_upload_over_limit_is_413(client, tmp_path, monkeypatch):
    monkeypatch.setattr(api_module, "MAX_UPLOAD_BYTES", 1000)
    r = upload(client, tmp_path)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


def test_disk_full_refuses_upload(cfg, repo, tmp_path):
    full = Config(**{**cfg.__dict__, "min_free_gb": 1e12})
    r = upload(TestClient(create_app(full, repo)), tmp_path)
    assert r.status_code == 503 and r.json()["error"]["code"] == "disk_full"


def test_list_get_preview_delete_and_caller_isolation(client, repo, tmp_path, cfg):
    vid = uuid.UUID(upload(client, tmp_path).json()["id"])
    ref = cfg.data_dir / "voices" / str(vid) / "ref.wav"
    sf.write(ref, np.zeros(48000, dtype=np.float32), 48000)
    repo.voice_ready(vid, ref_audio_path=str(ref), ref_transcript="halo", ref_seconds=1.0,
                     clip_start_s=0.0, clip_end_s=1.0, language="id")
    listed = client.get("/v1/voices?owner_ref=user-1", headers=AUTH).json()
    assert [v["id"] for v in listed] == [str(vid)]
    detail = client.get(f"/v1/voices/{vid}", headers=AUTH).json()
    assert (detail["status"], detail["ref_transcript"], detail["preview_url"]) == ("ready", "halo", f"/v1/voices/{vid}/preview.wav")
    preview = client.get(f"/v1/voices/{vid}/preview.wav", headers=AUTH)
    assert preview.status_code == 200 and preview.headers["content-type"] == "audio/wav"
    assert client.get(f"/v1/voices/{vid}", headers={"Authorization": f"Bearer {OTHER}"}).status_code == 404
    assert client.delete(f"/v1/voices/{vid}", headers=AUTH).status_code == 204
    assert not (cfg.data_dir / "voices" / str(vid)).exists()
    assert client.get(f"/v1/voices/{vid}", headers=AUTH).status_code == 404


def test_health_reports_model_loading_until_worker_beats(client, repo):
    r = client.get("/v1/health")
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_loading"
    repo.heartbeat(model_loaded=True, device="mps", rtf=0.66)
    body = client.get("/v1/health").json()
    assert body["model_loaded"] is True and body["device"] == "mps" and body["queue_depth"] == 0
    assert body["rolling_rtf"] == pytest.approx(0.66)
