from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .text.split import Unit

Row = dict[str, Any]


class NotRegeneratable(Exception):
    """The job is not in a state that allows regenerating a sentence."""


class Repo:
    def __init__(self, pool: ConnectionPool):
        self.pool = pool

    def _one(self, query: str, params: Sequence[Any] = ()) -> Row | None:
        with self.pool.connection() as conn:
            return conn.execute(query, params).fetchone()

    def _all(self, query: str, params: Sequence[Any] = ()) -> list[Row]:
        with self.pool.connection() as conn:
            return conn.execute(query, params).fetchall()

    # ---- voices -------------------------------------------------------------
    def create_voice(self, voice_id, caller, owner_ref, name, language, source_path, user_transcript) -> Row:
        return self._one(
            "INSERT INTO voices (id, caller, owner_ref, name, language, source_path, user_transcript) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (voice_id, caller, owner_ref, name, language, source_path, user_transcript),
        )

    def get_voice(self, caller, voice_id) -> Row | None:
        return self._one("SELECT * FROM voices WHERE id=%s AND caller=%s AND deleted_at IS NULL", (voice_id, caller))

    def get_voice_any(self, voice_id) -> Row | None:
        return self._one("SELECT * FROM voices WHERE id=%s", (voice_id,))

    def list_voices(self, caller, owner_ref) -> list[Row]:
        return self._all(
            "SELECT * FROM voices WHERE caller=%s AND owner_ref=%s AND deleted_at IS NULL ORDER BY created_at DESC",
            (caller, owner_ref),
        )

    def soft_delete_voice(self, caller, voice_id) -> bool:
        return self._one(
            "UPDATE voices SET deleted_at=now() WHERE id=%s AND caller=%s AND deleted_at IS NULL RETURNING id",
            (voice_id, caller),
        ) is not None

    def next_voice_to_prepare(self) -> Row | None:
        return self._one(
            "SELECT * FROM voices WHERE status='processing' AND deleted_at IS NULL ORDER BY created_at LIMIT 1"
        )

    def voice_ready(self, voice_id, *, ref_audio_path, ref_transcript, ref_seconds, clip_start_s, clip_end_s, language) -> None:
        self._one(
            "UPDATE voices SET status='ready', error_code=NULL, ref_audio_path=%s, ref_transcript=%s, "
            "ref_seconds=%s, clip_start_s=%s, clip_end_s=%s, language=%s WHERE id=%s RETURNING id",
            (ref_audio_path, ref_transcript, ref_seconds, clip_start_s, clip_end_s, language, voice_id),
        )

    def voice_failed(self, voice_id, code: str) -> None:
        self._one("UPDATE voices SET status='failed', error_code=%s WHERE id=%s RETURNING id", (code, voice_id))

    # ---- jobs ---------------------------------------------------------------
    def create_job(self, *, caller, voice_id, text, settings: dict, callback_url, idempotency_key,
                   units: Sequence[Unit]) -> tuple[Row, bool]:
        with self.pool.connection() as conn, conn.transaction():
            if idempotency_key:
                existing = conn.execute(
                    "SELECT *, created_at > now() - interval '24 hours' AS fresh FROM jobs "
                    "WHERE caller=%s AND idempotency_key=%s FOR UPDATE",
                    (caller, idempotency_key),
                ).fetchone()
                if existing is not None:
                    if existing.pop("fresh"):
                        return existing, False
                    conn.execute("UPDATE jobs SET idempotency_key=NULL WHERE id=%s", (existing["id"],))
            job = conn.execute(
                "INSERT INTO jobs (id, voice_id, caller, text, settings, callback_url, idempotency_key, chars) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
                (uuid.uuid4(), voice_id, caller, text, Jsonb(settings), callback_url, idempotency_key, len(text)),
            ).fetchone()
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO sentences (job_id, idx, paragraph_idx, text, style) VALUES (%s, %s, %s, %s, %s)",
                    [(job["id"], u.idx, u.paragraph_idx, u.text, u.style) for u in units],
                )
            return job, True

    def get_job(self, caller, job_id) -> Row | None:
        return self._one("SELECT * FROM jobs WHERE id=%s AND caller=%s AND deleted_at IS NULL", (job_id, caller))

    def get_job_any(self, job_id) -> Row | None:
        return self._one("SELECT * FROM jobs WHERE id=%s", (job_id,))

    def list_sentences(self, job_id) -> list[Row]:
        return self._all("SELECT * FROM sentences WHERE job_id=%s ORDER BY idx", (job_id,))

    def get_sentence(self, job_id, idx: int) -> Row | None:
        return self._one("SELECT * FROM sentences WHERE job_id=%s AND idx=%s", (job_id, idx))

    def purge_job(self, job_id) -> None:
        self._one("DELETE FROM jobs WHERE id=%s RETURNING id", (job_id,))
