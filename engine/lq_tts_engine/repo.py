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

    def delete_voice_cascade(self, caller, voice_id) -> list[Row] | None:
        """Soft-delete a voice and delete_job every live job made with it, in one transaction."""
        with self.pool.connection() as conn, conn.transaction():
            if conn.execute(
                "UPDATE voices SET deleted_at=now() WHERE id=%s AND caller=%s AND deleted_at IS NULL RETURNING id",
                (voice_id, caller),
            ).fetchone() is None:
                return None
            return conn.execute(
                "UPDATE jobs SET deleted_at=now(), cancel_requested = (status='running'), "
                "status = CASE WHEN status='queued' THEN 'canceled' ELSE status END "
                "WHERE voice_id=%s AND deleted_at IS NULL RETURNING id, status",
                (voice_id,),
            ).fetchall()

    def next_voice_to_prepare(self) -> Row | None:
        return self._one(
            "SELECT * FROM voices WHERE status='processing' AND deleted_at IS NULL ORDER BY created_at LIMIT 1"
        )

    def voice_ready(self, voice_id, *, ref_audio_path, ref_transcript, ref_seconds, clip_start_s, clip_end_s, language) -> bool:
        return self._one(
            "UPDATE voices SET status='ready', error_code=NULL, ref_audio_path=%s, ref_transcript=%s, "
            "ref_seconds=%s, clip_start_s=%s, clip_end_s=%s, language=%s "
            "WHERE id=%s AND deleted_at IS NULL RETURNING id",
            (ref_audio_path, ref_transcript, ref_seconds, clip_start_s, clip_end_s, language, voice_id),
        ) is not None

    def voice_failed(self, voice_id, code: str) -> bool:
        return self._one(
            "UPDATE voices SET status='failed', error_code=%s WHERE id=%s AND deleted_at IS NULL RETURNING id",
            (code, voice_id),
        ) is not None

    # ---- jobs ---------------------------------------------------------------
    def create_job(self, *, caller, voice_id, text, settings: dict, callback_url, idempotency_key,
                   units: Sequence[Unit]) -> tuple[Row, bool]:
        with self.pool.connection() as conn, conn.transaction():
            if idempotency_key:
                conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s || chr(31) || %s, 0))",
                    (caller, idempotency_key),
                )
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

    def find_idempotent_job(self, caller, key: str) -> Row | None:
        """The job this caller created with this Idempotency-Key in the last 24 hours (create_job's replay window)."""
        return self._one(
            "SELECT * FROM jobs WHERE caller=%s AND idempotency_key=%s AND created_at > now() - interval '24 hours'",
            (caller, key),
        )

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

    # ---- queue --------------------------------------------------------------
    def claim_job(self, lease_s: int = 60) -> Row | None:
        return self._one(
            "UPDATE jobs SET status='running', lease_until = now() + %s * interval '1 second', "
            "started_at = coalesce(started_at, now()) "
            "WHERE id = (SELECT id FROM jobs WHERE status='queued' "
            "            ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1) "
            "RETURNING *",
            (lease_s,),
        )

    def renew_lease(self, job_id, lease_s: int = 60) -> None:
        self._one(
            "UPDATE jobs SET lease_until = now() + %s * interval '1 second' "
            "WHERE id=%s AND status='running' RETURNING id",
            (lease_s, job_id),
        )

    def requeue_expired(self, max_attempts: int = 3) -> list[Row]:
        with self.pool.connection() as conn, conn.transaction():
            rows = conn.execute(
                "UPDATE jobs SET attempts = attempts + 1, lease_until = NULL, "
                "status = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE 'queued' END, "
                "error_code = CASE WHEN attempts + 1 >= %s THEN 'worker_crashed' ELSE error_code END, "
                "finished_at = CASE WHEN attempts + 1 >= %s THEN now() ELSE finished_at END "
                "WHERE status='running' AND lease_until < now() RETURNING id, status",
                (max_attempts, max_attempts, max_attempts),
            ).fetchall()
            if rows:
                conn.execute(
                    "UPDATE sentences SET status='pending', updated_at=now() WHERE status='running' AND job_id = ANY(%s)",
                    ([r["id"] for r in rows],),
                )
        return rows

    def next_pending_sentence(self, job_id) -> Row | None:
        return self._one(
            "SELECT * FROM sentences WHERE job_id=%s AND status='pending' ORDER BY idx LIMIT 1", (job_id,)
        )

    def mark_sentence_running(self, job_id, idx: int) -> None:
        self._one(
            "UPDATE sentences SET status='running', updated_at=now() WHERE job_id=%s AND idx=%s RETURNING idx",
            (job_id, idx),
        )

    def save_sentence(self, job_id, idx: int, *, status, takes, score, asr_text, audio_path, duration_s) -> None:
        self._one(
            "UPDATE sentences SET status=%s, takes=%s, score=%s, asr_text=%s, audio_path=%s, duration_s=%s, "
            "updated_at=now() WHERE job_id=%s AND idx=%s RETURNING idx",
            (status, takes, score, asr_text, audio_path, duration_s, job_id, idx),
        )

    def set_sentence_times(self, job_id, times: Sequence[tuple[int, float, float]]) -> None:
        with self.pool.connection() as conn, conn.cursor() as cur:
            cur.executemany(
                "UPDATE sentences SET start_s=%s, end_s=%s WHERE job_id=%s AND idx=%s",
                [(start, end, job_id, idx) for idx, start, end in times],
            )

    def finish_job(self, job_id, audio_seconds: float) -> None:
        self._one(
            "UPDATE jobs SET status='done', audio_seconds=%s, finished_at=now(), lease_until=NULL, priority=0, "
            "error_code=NULL WHERE id=%s RETURNING id",
            (audio_seconds, job_id),
        )

    def fail_job(self, job_id, code: str) -> None:
        self._one(
            "UPDATE jobs SET status='failed', error_code=%s, finished_at=now(), lease_until=NULL WHERE id=%s RETURNING id",
            (code, job_id),
        )

    def request_cancel(self, caller, job_id) -> bool:
        return self._one(
            "UPDATE jobs SET cancel_requested = true, "
            "status = CASE WHEN status='queued' THEN 'canceled' ELSE status END, "
            "finished_at = CASE WHEN status='queued' THEN now() ELSE finished_at END "
            "WHERE id=%s AND caller=%s AND deleted_at IS NULL AND status IN ('queued', 'running') RETURNING id",
            (job_id, caller),
        ) is not None

    def cancel_requested(self, job_id) -> bool:
        row = self._one("SELECT cancel_requested FROM jobs WHERE id=%s", (job_id,))
        return bool(row and row["cancel_requested"])

    def mark_canceled(self, job_id) -> None:
        self._one(
            "UPDATE jobs SET status='canceled', finished_at=now(), lease_until=NULL WHERE id=%s RETURNING id",
            (job_id,),
        )

    def request_regenerate(self, caller, job_id, idx: int, text: str | None, style: str | None) -> int:
        with self.pool.connection() as conn, conn.transaction():
            job = conn.execute(
                "SELECT * FROM jobs WHERE id=%s AND caller=%s AND deleted_at IS NULL FOR UPDATE", (job_id, caller)
            ).fetchone()
            if job is None:
                raise LookupError("job not found")
            sentence = conn.execute("SELECT idx FROM sentences WHERE job_id=%s AND idx=%s", (job_id, idx)).fetchone()
            if sentence is None:
                raise LookupError("sentence not found")
            if job["status"] != "done":
                raise NotRegeneratable(f"job is {job['status']}; only finished jobs can be regenerated")
            conn.execute(
                "UPDATE sentences SET status='pending', text = coalesce(%s, text), "
                "style = CASE WHEN %s::text IS NULL THEN style ELSE nullif(%s, '') END, updated_at=now() "
                "WHERE job_id=%s AND idx=%s",
                (text, style, style, job_id, idx),
            )
            revision = job["revision"] + 1
            conn.execute(
                "UPDATE jobs SET status='queued', priority=10, revision=%s, finished_at=NULL, error_code=NULL, "
                "attempts=0, cancel_requested=false WHERE id=%s",
                (revision, job_id),
            )
            return revision

    def delete_job(self, caller, job_id) -> Row | None:
        return self._one(
            "UPDATE jobs SET deleted_at=now(), cancel_requested = (status='running'), "
            "status = CASE WHEN status='queued' THEN 'canceled' ELSE status END "
            "WHERE id=%s AND caller=%s AND deleted_at IS NULL RETURNING id, status",
            (job_id, caller),
        )

    def queue_position(self, job_id) -> int:
        row = self._one(
            "SELECT count(q.id) AS n FROM jobs j JOIN jobs q ON q.status='queued' AND q.deleted_at IS NULL "
            "AND (q.priority > j.priority OR (q.priority = j.priority AND q.created_at < j.created_at)) "
            "WHERE j.id=%s AND j.status='queued'",
            (job_id,),
        )
        return int(row["n"]) if row else 0

    def chars_ahead(self, job_id) -> int:
        row = self._one(
            "SELECT coalesce(sum(q.chars), 0) AS n FROM jobs j JOIN jobs q ON q.deleted_at IS NULL AND q.id <> j.id "
            "AND (q.status='running' OR (q.status='queued' AND (q.priority > j.priority "
            "     OR (q.priority = j.priority AND q.created_at < j.created_at)))) "
            "WHERE j.id=%s",
            (job_id,),
        )
        return int(row["n"]) if row else 0

    def queue_depth(self) -> int:
        return int(self._one("SELECT count(*) AS n FROM jobs WHERE status='queued' AND deleted_at IS NULL")["n"])

    # ---- worker state -------------------------------------------------------
    def heartbeat(self, *, model_loaded: bool, device: str, rtf: float | None) -> None:
        self._one(
            "INSERT INTO worker_state (id, beat_at, model_loaded, device, rtf) VALUES (1, now(), %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET beat_at=now(), model_loaded=EXCLUDED.model_loaded, "
            "device=EXCLUDED.device, rtf=coalesce(EXCLUDED.rtf, worker_state.rtf) RETURNING id",
            (model_loaded, device, rtf),
        )

    def worker_state(self) -> Row | None:
        return self._one(
            "SELECT *, extract(epoch FROM now() - beat_at)::float AS age_s FROM worker_state WHERE id=1"
        )

    def referenced_take_paths(self) -> set[str]:
        return {r["audio_path"] for r in self._all("SELECT audio_path FROM sentences WHERE audio_path IS NOT NULL")}
