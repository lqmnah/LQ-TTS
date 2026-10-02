# No `from __future__ import annotations` here: FastAPI must resolve the local `Caller` alias at runtime.
import asyncio
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

from ..config import Config, load_config
from ..db import make_pool, migrate
from ..pipeline import job_dir, latest_revision, revision_dir
from ..repo import NotRegeneratable, Repo
from ..retention import free_gb
from ..settings import JobSettings
from ..text.split import is_single_sentence, split_script

MAX_TEXT_CHARS = 20_000
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
CHARS_PER_SECOND = 16.0
DEFAULT_RTF = 0.82
HEARTBEAT_STALE_S = 60.0
UPLOAD_EXTS = {".mp3", ".wav", ".m4a", ".flac"}
FILE_TYPES = {"final.mp3": "audio/mpeg", "final.wav": "audio/wav",
              "subs.srt": "application/x-subrip", "subs.vtt": "text/vtt"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}, **extra})


def _has_audio_stream(path: Path) -> bool:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return probe.returncode == 0 and probe.stdout.strip() == "audio"


class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    voice_id: uuid.UUID
    text: str
    settings: dict[str, Any] = {}
    callback_url: str | None = None


class RegenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = None
    style: str | None = None


def _voice_out(v: dict) -> dict:
    out = {k: v[k] for k in ("id", "name", "owner_ref", "language", "status", "error_code", "ref_transcript",
                             "ref_seconds", "clip_start_s", "clip_end_s", "created_at")}
    out["preview_url"] = f"/v1/voices/{v['id']}/preview.wav" if v["status"] == "ready" else None
    return out


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def create_app(cfg: Config, repo: Repo, *, sse_poll_s: float = 1.0) -> FastAPI:
    app = FastAPI(title="LQ-TTS engine", version="1")

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []))
        return _error(400, "invalid_request", f"{where}: {first.get('msg', 'invalid request')}")

    def caller(authorization: Annotated[str | None, Header()] = None) -> str:
        token = (authorization or "").removeprefix("Bearer ").strip()
        who = cfg.tokens.get(token) if token else None
        if who is None:
            raise ApiError(401, "unauthorized", "missing or invalid service token")
        return who

    Caller = Annotated[str, Depends(caller)]

    def need_disk() -> None:
        if free_gb(cfg.data_dir) < cfg.min_free_gb:
            raise ApiError(503, "disk_full", f"less than {cfg.min_free_gb:g} GB free")

    def own_voice(who: str, voice_id: uuid.UUID) -> dict:
        voice = repo.get_voice(who, voice_id)
        if voice is None:
            raise ApiError(404, "not_found", "voice not found")
        return voice

    # ---- voices -------------------------------------------------------------
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
        dest = folder / f"source{ext}"
        size = 0
        too_large = False
        with dest.open("wb") as fh:
            while chunk := audio.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    too_large = True
                    break
                fh.write(chunk)
        if too_large:
            shutil.rmtree(folder)
            raise ApiError(413, "too_large", "upload exceeds 200 MB")
        if not _has_audio_stream(dest):
            shutil.rmtree(folder)
            raise ApiError(415, "unsupported_audio", "file has no readable audio")
        row = repo.create_voice(voice_id, who, owner_ref, name, language, str(dest), transcript)
        return {"id": str(row["id"]), "status": row["status"]}

    @app.get("/v1/voices")
    def list_voices(who: Caller, owner_ref: str) -> list[dict]:
        return [_voice_out(v) for v in repo.list_voices(who, owner_ref)]

    @app.get("/v1/voices/{voice_id}")
    def get_voice(voice_id: uuid.UUID, who: Caller) -> dict:
        return _voice_out(own_voice(who, voice_id))

    @app.get("/v1/voices/{voice_id}/preview.wav")
    def preview(voice_id: uuid.UUID, who: Caller) -> FileResponse:
        voice = own_voice(who, voice_id)
        if voice["status"] != "ready" or not Path(voice["ref_audio_path"]).exists():
            raise ApiError(404, "not_found", "voice has no preview yet")
        return FileResponse(voice["ref_audio_path"], media_type="audio/wav")

    @app.delete("/v1/voices/{voice_id}", status_code=204)
    def delete_voice(voice_id: uuid.UUID, who: Caller) -> Response:
        if not repo.soft_delete_voice(who, voice_id):
            raise ApiError(404, "not_found", "voice not found")
        shutil.rmtree(cfg.data_dir / "voices" / str(voice_id), ignore_errors=True)
        return Response(status_code=204)

    # ---- health -------------------------------------------------------------
    @app.get("/v1/health")
    def health() -> Any:
        st = repo.worker_state()
        body = {
            "model_loaded": bool(st and st["model_loaded"] and st["age_s"] < HEARTBEAT_STALE_S),
            "device": st["device"] if st else None,
            "queue_depth": repo.queue_depth(),
            "worker_heartbeat_age_s": round(st["age_s"], 1) if st else None,
            "rolling_rtf": st["rtf"] if st else None,
        }
        if not body["model_loaded"]:
            return _error(503, "model_loading", "worker has not loaded the model", health=body)
        return body

    register_job_routes(app, cfg, repo, caller=Caller, need_disk=need_disk, own_voice=own_voice, sse_poll_s=sse_poll_s)
    return app


def register_job_routes(app: FastAPI, cfg: Config, repo: Repo, *, caller, need_disk, own_voice, sse_poll_s: float) -> None:
    """Job endpoints are added in Task 12."""


def app_from_env() -> FastAPI:
    cfg = load_config()
    migrate(cfg.database_url, cfg.schema)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return create_app(cfg, Repo(make_pool(cfg.database_url, cfg.schema)))
