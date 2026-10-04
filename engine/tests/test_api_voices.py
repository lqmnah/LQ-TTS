import subprocess
import uuid
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from lq_tts_engine.api import app as api_module
from lq_tts_engine.api.app import caller_for, create_app
from lq_tts_engine.config import Config
from tests.conftest import sql

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
