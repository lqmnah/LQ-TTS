from __future__ import annotations

import os
import uuid
from pathlib import Path

import numpy as np
import psycopg
import pytest
import soundfile as sf
from dotenv import dotenv_values

from lq_tts_engine.db import make_pool, migrate
from lq_tts_engine.repo import Repo

ENGINE_DIR = Path(__file__).resolve().parent.parent


def test_database_url() -> str:
    url = os.environ.get("LQTTS_TEST_DATABASE_URL") or dotenv_values(ENGINE_DIR / ".env").get("LQTTS_TEST_DATABASE_URL")
    if not url:
        pytest.fail("LQTTS_TEST_DATABASE_URL is not set (engine/.env)")
    return url


test_database_url.__test__ = False  # helper, not a test


@pytest.fixture
def repo():
    url = test_database_url()
    schema = f"t_{uuid.uuid4().hex[:12]}"
    migrate(url, schema)
    pool = make_pool(url, schema, max_size=4)
    try:
        yield Repo(pool)
    finally:
        pool.close()
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def sql(repo: Repo, query: str, params=()):
    with repo.pool.connection() as conn:
        return conn.execute(query, params)


@pytest.fixture
def ready_voice(repo, tmp_path):
    """A ready voice owned by caller 'lq-tts' with a 2 s tone reference file."""
    ref = tmp_path / "ref.wav"
    t = np.arange(2 * 48000) / 48000
    sf.write(ref, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000)
    voice_id = uuid.uuid4()
    repo.create_voice(voice_id, "lq-tts", "user-1", "Pandji", "id", str(ref), None)
    repo.voice_ready(voice_id, ref_audio_path=str(ref), ref_transcript="halo semua", ref_seconds=2.0,
                     clip_start_s=0.0, clip_end_s=2.0, language="id")
    return repo.get_voice_any(voice_id)
