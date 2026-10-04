# No `from __future__ import annotations` here: FastAPI must resolve the local `Caller` alias at runtime.
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

from ..callbacks import callback_url_allowed
from ..config import Config, load_config, priority_for
from ..db import make_pool, migrate
from ..pipeline import job_dir, latest_revision, revision_dir
from ..repo import NotRegeneratable, Repo
from ..retention import free_gb
from ..settings import JobSettings
from ..text.split import is_single_sentence, split_script

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
FILE_TYPES = {"final.mp3": "audio/mpeg", "final.wav": "audio/wav",
              "subs.srt": "application/x-subrip", "subs.vtt": "text/vtt"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}, **extra})


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


class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    voice_id: uuid.UUID
    text: str
    settings: dict[str, Any] = {}
    callback_url: str | None = None
    priority: int | None = None  # clamped per caller (config.priority_for); absent = the web level


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
    app.add_middleware(BodyLimit)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTP_CODES.get(exc.status_code, "invalid_request" if exc.status_code < 500 else "internal_error")
        response = _error(exc.status_code, code, str(exc.detail))
        response.headers.update(exc.headers or {})
        return response

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
        who = caller_for(cfg.tokens, token) if token else None
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
        jobs = repo.delete_voice_cascade(who, voice_id)
        if jobs is None:
            raise ApiError(404, "not_found", "voice not found")
        shutil.rmtree(cfg.data_dir / "voices" / str(voice_id), ignore_errors=True)
        for job in jobs:
            if job["status"] != "running":  # the worker purges running jobs when they stop
                shutil.rmtree(job_dir(cfg.data_dir, job["id"]), ignore_errors=True)
                repo.purge_job(job["id"])
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
    Caller = caller

    def own_job(who: str, job_id: uuid.UUID) -> dict:
        job = repo.get_job(who, job_id)
        if job is None:
            raise ApiError(404, "not_found", "job not found")
        return job

    def estimate_seconds(job: dict) -> int:
        st = repo.worker_state()
        rtf = (st["rtf"] if st and st["rtf"] else None) or DEFAULT_RTF
        return round((repo.chars_ahead(job["id"]) + job["chars"]) / CHARS_PER_SECOND * rtf)

    def job_view(job: dict) -> dict:
        sentences = repo.list_sentences(job["id"])
        latest = latest_revision(cfg.data_dir, job["id"])
        files: dict[str, str] = {}
        if latest:
            folder = revision_dir(cfg.data_dir, job["id"], latest)
            files = {name: f"/v1/jobs/{job['id']}/files/{name}?revision={latest}"
                     for name in FILE_TYPES if (folder / name).exists()}
        return {
            "id": job["id"], "status": job["status"], "error_code": job["error_code"], "revision": job["revision"],
            "progress": {"done": sum(s["status"] in ("done", "needs_review") for s in sentences), "total": len(sentences)},
            "needs_review": sum(s["status"] == "needs_review" for s in sentences),
            "queue_position": repo.queue_position(job["id"]) if job["status"] == "queued" else 0,
            "chars": job["chars"], "audio_seconds": job["audio_seconds"], "settings": job["settings"],
            "files": files, "created_at": job["created_at"], "finished_at": job["finished_at"],
        }

    def accepted(job: dict) -> dict:
        return {"id": str(job["id"]), "sentences_total": len(repo.list_sentences(job["id"])),
                "estimated_seconds": estimate_seconds(job)}

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
        if body.callback_url is not None and not callback_url_allowed(
                body.callback_url, cfg.callback_hosts.get(who, frozenset())):
            raise ApiError(400, "invalid_callback_url",
                           "callback_url must be http(s) to loopback or to a host allowed for this caller")
        voice = own_voice(who, body.voice_id)
        if voice["status"] != "ready":
            raise ApiError(409, "voice_not_ready", f"voice is {voice['status']}")
        units = split_script(text)
        if not units:
            raise ApiError(400, "invalid_text", "no sentences found")
        job, _ = repo.create_job(caller=who, voice_id=body.voice_id, text=text, settings=settings.model_dump(),
                                 callback_url=body.callback_url, idempotency_key=key, units=units,
                                 priority=priority_for(cfg, who, body.priority))
        return accepted(job)

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: uuid.UUID, who: Caller) -> dict:
        return job_view(own_job(who, job_id))

    @app.get("/v1/jobs/{job_id}/sentences")
    def sentences(job_id: uuid.UUID, who: Caller) -> list[dict]:
        own_job(who, job_id)
        keys = ("idx", "paragraph_idx", "text", "style", "status", "takes", "score", "asr_text",
                "duration_s", "start_s", "end_s")
        return [{**{k: s[k] for k in keys},
                 "audio_url": f"/v1/jobs/{job_id}/sentences/{s['idx']}/audio.wav" if s["audio_path"] else None}
                for s in repo.list_sentences(job_id)]

    @app.get("/v1/jobs/{job_id}/sentences/{idx}/audio.wav")
    def sentence_audio(job_id: uuid.UUID, idx: int, who: Caller) -> FileResponse:
        own_job(who, job_id)
        s = repo.get_sentence(job_id, idx)
        if s is None or not s["audio_path"] or not Path(s["audio_path"]).exists():
            raise ApiError(404, "not_found", "sentence audio not found")
        return FileResponse(s["audio_path"], media_type="audio/wav")

    @app.get("/v1/jobs/{job_id}/events")
    async def events(job_id: uuid.UUID, who: Caller, request: Request) -> StreamingResponse:
        if await run_in_threadpool(repo.get_job, who, job_id) is None:
            raise ApiError(404, "not_found", "job not found")

        async def stream():
            seen: dict[int, str] = {}
            while True:
                if await request.is_disconnected():
                    return
                job = await run_in_threadpool(repo.get_job, who, job_id)
                if job is None:
                    return
                for s in await run_in_threadpool(repo.list_sentences, job_id):
                    key = f"{s['status']}:{s['updated_at'].isoformat()}"
                    if s["status"] in ("done", "needs_review") and seen.get(s["idx"]) != key:
                        seen[s["idx"]] = key
                        yield _sse("sentence_done", {"idx": s["idx"], "status": s["status"], "score": s["score"],
                                                     "revision": job["revision"]})
                if job["status"] == "done":
                    yield _sse("job_done", {"revision": job["revision"]})
                    return
                if job["status"] in ("failed", "canceled"):
                    yield _sse("job_failed", {"status": job["status"], "error_code": job["error_code"]})
                    return
                await asyncio.sleep(sse_poll_s)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/v1/jobs/{job_id}/sentences/{idx}/regenerate", status_code=202)
    def regenerate(job_id: uuid.UUID, idx: int, body: RegenerateIn, who: Caller) -> dict:
        need_disk()
        text, style = None, body.style
        if body.text is not None:
            if not is_single_sentence(body.text):
                raise ApiError(400, "invalid_text", "text must be exactly one sentence")
            unit = split_script(body.text)[0]
            text = unit.text
            if style is None and unit.style:
                style = unit.style
        try:
            revision = repo.request_regenerate(who, job_id, idx, text, style)
        except LookupError as exc:
            raise ApiError(404, "not_found", str(exc)) from exc
        except NotRegeneratable as exc:
            raise ApiError(409, "not_regeneratable", str(exc)) from exc
        return {"revision": revision}

    @app.post("/v1/jobs/{job_id}/cancel", status_code=202)
    def cancel(job_id: uuid.UUID, who: Caller) -> dict:
        own_job(who, job_id)
        repo.request_cancel(who, job_id)
        return {"status": "cancel_requested"}

    @app.delete("/v1/jobs/{job_id}", status_code=204)
    def delete_job(job_id: uuid.UUID, who: Caller) -> Response:
        row = repo.delete_job(who, job_id)
        if row is None:
            raise ApiError(404, "not_found", "job not found")
        if row["status"] != "running":
            shutil.rmtree(job_dir(cfg.data_dir, job_id), ignore_errors=True)
            repo.purge_job(job_id)
        return Response(status_code=204)

    @app.get("/v1/jobs/{job_id}/files/{name}")
    def job_file(job_id: uuid.UUID, name: str, who: Caller, revision: int | None = None) -> FileResponse:
        if name not in FILE_TYPES:
            raise ApiError(404, "not_found", "unknown file")
        own_job(who, job_id)
        rev = revision or latest_revision(cfg.data_dir, job_id)
        path = revision_dir(cfg.data_dir, job_id, rev) / name if rev else None
        if path is None or not path.exists():
            raise ApiError(404, "not_found", "file not found")
        return FileResponse(path, media_type=FILE_TYPES[name], filename=f"{job_id}-r{rev}-{name}")


def app_from_env() -> FastAPI:
    cfg = load_config()
    migrate(cfg.database_url, cfg.schema)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return create_app(cfg, Repo(make_pool(cfg.database_url, cfg.schema)))
