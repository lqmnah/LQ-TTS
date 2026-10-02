# LQ-TTS Voice Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An internal HTTP service on mac-studio that turns text into natural voiceover in a cloned voice with VoxCPM2, sentence by sentence, with QA retakes, exact pauses, loudness normalization, MP3/WAV/SRT/VTT output and per-sentence regeneration.

**Architecture:** One Python package `lq_tts_engine` with two processes under pm2: a FastAPI API (`127.0.0.1:8740`) and exactly one worker that owns VoxCPM2 on MPS. Postgres (schema `lq_tts_engine`) is the job queue (`FOR UPDATE SKIP LOCKED` + leases). Audio files live under `~/Developer/LQ-TTS/data/`.

**Tech Stack:** Python 3.12 (uv), FastAPI, uvicorn, psycopg 3 + psycopg-pool, pydantic 2, numpy, soundfile, httpx, ffmpeg/ffprobe (Homebrew), `voxcpm` + `torch` (MPS), `faster-whisper` (CPU int8) + `av>=14,<16`, pytest.

**Spec:** `docs/superpowers/specs/2026-10-02-voice-engine-design.md`

## Global Constraints

- Machine: **mac-studio** only. Every shell step starts with `cd ~/Developer/LQ-TTS/engine && export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- Python `>=3.12,<3.13`; dependency set exactly as in Task 1 `pyproject.toml`.
- Commits: author `lqmnah <lqmnah@users.noreply.github.com>` (repo-local config already set). **No** `Co-Authored-By`, no Claude/Anthropic/AI attribution in any commit message (SOP-LQ G8).
- Do not stop, restart or reconfigure any other pm2 app, port or database on mac-studio. This engine uses port `8740`, database `lq_tts`, test database `lq_tts_test`, role `lq_tts_engine`.
- Defaults (verbatim from spec): speed `0.9` (range 0.7–1.3), sentence pause `0.45` s, paragraph pause `0.80` s (0–3), loudness `-14` LUFS (−24 to −9), true peak `-1` dBTP, formats `["mp3","wav","srt","vtt"]`.
- Limits (verbatim): text ≤ 20,000 chars per job; upload ≤ 200 MB, MP3/WAV/M4A/FLAC; QA pass score `0.85`; max 4 takes per sentence; lease 60 s renewed every 15 s; 3 attempts ⇒ `worker_crashed`; callback retries 1, 5, 30, 120, 300 s; refuse new work below 20 GB free; purge unreferenced takes after 7 days.
- Audio: 48 kHz mono; `final.wav` PCM 16-bit; `final.mp3` 192 kbps.
- Run tests with `uv run pytest` (slow tests excluded by default; run them with `uv run pytest -m slow`).

### Spec clarifications made while planning (implementation detail, no behavior change to approved sections)

1. Take files are named `takes/s<idx:04d>_r<revision>_t<take>.wav` (spec: `s<idx>_t<take>.wav`) so regenerated revisions never overwrite takes that older revisions reference.
2. Added `GET /v1/jobs/{id}/sentences/{idx}/audio.wav` — the spec's "per-sentence audio URL" needs an endpoint to serve it.
3. Added error codes `invalid_request` (malformed request), `invalid_settings` (settings out of range) and `voice_not_ready` (409, job for a voice still processing/failed).
4. Added table `worker_state` (heartbeat, model_loaded, rolling RTF) to serve `/health`; added columns `voices.user_transcript` and `jobs.deleted_at`.
5. `/health` needs no token (no caller data); it returns `503 model_loading` while the worker has not loaded the model or its heartbeat is older than 60 s.
6. Style markup `{{style: …}}` also forces a sentence break (text before the marker ends a sentence).
7. QA language per sentence: stop-word guess (Indonesian vs English), else the voice's detected language.

---

## File Structure

```
engine/
  pyproject.toml                 deps, pytest config
  .env.example                   documented settings (real .env is gitignored)
  ecosystem.config.cjs           pm2: lq-tts-engine-api, lq-tts-engine-worker
  scripts/e2e_smoke.py           end-to-end check against the running service
  lq_tts_engine/
    config.py                    Config + load_config() from env/.env
    settings.py                  JobSettings (defaults, ranges)
    text/split.py                split_script() -> list[Unit], is_single_sentence()
    text/numbers.py              normalize_for_match() (number words <-> digits, slang)
    text/lang.py                 guess_language() -> "id" | "en" | None
    qa.py                        PASS_SCORE, levenshtein(), score()
    audio/ops.py                 trim(), fade(), tempo(), assemble(), SilentAudio
    audio/finish.py              loudnorm(), measure_lufs(), encode_mp3()
    subs.py                      Cue, to_srt(), to_vtt()
    schema.sql                   tables (schema name templated)
    db.py                        migrate(), make_pool()
    repo.py                      Repo: voices, jobs, sentences, queue, worker_state
    asr.py                       Word, Transcript, Transcriber, WhisperTranscriber
    synth.py                     VoiceRef, Synthesizer, VoxSynth
    voiceprep.py                 Clip, select_clip(), prepare_voice(), NoCleanSpeech
    pipeline.py                  Deps, process_sentence(), assemble_revision(), run_job()
    callbacks.py                 sign(), verify(), CallbackSender
    retention.py                 purge_unreferenced_takes(), free_gb()
    api/app.py                   create_app(), app_from_env()
    worker.py                    handle_voice(), handle_job(), main()
  tests/
    conftest.py                  repo fixture (fresh schema per test), helpers
    fakes.py                     ToneSynth, FakeTranscriber
    test_*.py                    one file per module group
```

---

### Task 1: Project scaffold, config and job settings

**Files:**
- Create: `engine/pyproject.toml`, `engine/.env.example`, `engine/lq_tts_engine/__init__.py`, `engine/lq_tts_engine/config.py`, `engine/lq_tts_engine/settings.py`, `engine/lq_tts_engine/text/__init__.py`, `engine/lq_tts_engine/audio/__init__.py`, `engine/lq_tts_engine/api/__init__.py`, `engine/tests/__init__.py`
- Test: `engine/tests/test_config_settings.py`

**Interfaces:**
- Produces: `Config(database_url: str, schema: str, data_dir: Path, tokens: dict[str, str] (token→caller), callback_secrets: dict[str, str] (caller→secret), device: str, whisper_model: str, min_free_gb: float)`; `load_config(env: Mapping[str, str] | None = None) -> Config`; `JobSettings` pydantic model with fields `speed`, `pause_sentence_s`, `pause_paragraph_s`, `loudness_lufs`, `formats`.

- [ ] **Step 1: Create the package skeleton and pyproject**

`engine/pyproject.toml`:
```toml
[project]
name = "lq-tts-engine"
version = "0.1.0"
requires-python = ">=3.12,<3.13"
dependencies = [
  "fastapi>=0.115",
  "uvicorn>=0.30",
  "python-multipart>=0.0.9",
  "pydantic>=2.7",
  "psycopg[binary]>=3.2",
  "psycopg-pool>=3.2",
  "python-dotenv>=1.0",
  "numpy>=1.26",
  "soundfile>=0.12",
  "httpx>=0.27",
]

[project.optional-dependencies]
ml = ["torch>=2.5", "torchaudio>=2.5", "voxcpm", "faster-whisper>=1.0", "av>=14,<16"]

[dependency-groups]
dev = ["pytest>=8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["lq_tts_engine"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["slow: real VoxCPM2 + Whisper on MPS (minutes)"]
addopts = "-m 'not slow'"
```

Create empty files: `lq_tts_engine/__init__.py`, `lq_tts_engine/text/__init__.py`, `lq_tts_engine/audio/__init__.py`, `lq_tts_engine/api/__init__.py`, `tests/__init__.py`.

`engine/.env.example`:
```dotenv
# Copy to .env (gitignored) and fill in.
LQTTS_DATABASE_URL=postgresql://lq_tts_engine:CHANGE_ME@127.0.0.1:5432/lq_tts
LQTTS_TEST_DATABASE_URL=postgresql://lq_tts_engine:CHANGE_ME@127.0.0.1:5432/lq_tts_test
LQTTS_SCHEMA=lq_tts_engine
LQTTS_DATA_DIR=~/Developer/LQ-TTS/data
# caller:token pairs; the token decides the caller
LQTTS_TOKENS=lq-tts:CHANGE_ME,lq-studio:CHANGE_ME
# caller:secret pairs used to sign callbacks
LQTTS_CALLBACK_SECRETS=lq-tts:CHANGE_ME,lq-studio:CHANGE_ME
LQTTS_DEVICE=mps
LQTTS_WHISPER_MODEL=small
LQTTS_MIN_FREE_GB=20
```

Run: `uv sync --extra ml`
Expected: resolves and installs; `.venv/` created.

- [ ] **Step 2: Write the failing tests**

`engine/tests/test_config_settings.py`:
```python
import pytest
from pydantic import ValidationError

from lq_tts_engine.config import load_config
from lq_tts_engine.settings import JobSettings

BASE_ENV = {
    "LQTTS_DATABASE_URL": "postgresql://u:p@127.0.0.1/db",
    "LQTTS_DATA_DIR": "/tmp/lqtts-data",
    "LQTTS_TOKENS": "lq-tts:tok-a,lq-studio:tok-b",
    "LQTTS_CALLBACK_SECRETS": "lq-tts:sec-a,lq-studio:sec-b",
}


def test_tokens_map_token_to_caller():
    cfg = load_config(BASE_ENV)
    assert cfg.tokens == {"tok-a": "lq-tts", "tok-b": "lq-studio"}
    assert cfg.callback_secrets == {"lq-tts": "sec-a", "lq-studio": "sec-b"}
    assert cfg.schema == "lq_tts_engine"
    assert cfg.min_free_gb == 20.0


def test_malformed_pairs_are_rejected():
    with pytest.raises(ValueError, match="LQTTS_TOKENS"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts-without-token"})


def test_missing_required_setting_is_named():
    env = dict(BASE_ENV)
    del env["LQTTS_DATABASE_URL"]
    with pytest.raises(ValueError, match="LQTTS_DATABASE_URL"):
        load_config(env)


def test_job_settings_defaults_match_spec():
    s = JobSettings()
    assert (s.speed, s.pause_sentence_s, s.pause_paragraph_s, s.loudness_lufs) == (0.9, 0.45, 0.80, -14.0)
    assert s.formats == ["mp3", "wav", "srt", "vtt"]


@pytest.mark.parametrize("field,value", [
    ("speed", 0.69), ("speed", 1.31), ("pause_sentence_s", -0.1), ("pause_paragraph_s", 3.01),
    ("loudness_lufs", -24.5), ("loudness_lufs", -8.5),
])
def test_job_settings_reject_out_of_range(field, value):
    with pytest.raises(ValidationError):
        JobSettings(**{field: value})


def test_job_settings_accept_range_edges():
    s = JobSettings(speed=0.7, pause_sentence_s=0, pause_paragraph_s=3, loudness_lufs=-24)
    assert s.speed == 0.7


def test_job_settings_reject_unknown_keys_and_empty_formats():
    with pytest.raises(ValidationError):
        JobSettings(volume=2)
    with pytest.raises(ValidationError):
        JobSettings(formats=[])
    with pytest.raises(ValidationError):
        JobSettings(formats=["ogg"])


def test_job_settings_dedupe_formats_keeping_order():
    assert JobSettings(formats=["wav", "mp3", "wav"]).formats == ["wav", "mp3"]
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_config_settings.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.config'`.

- [ ] **Step 4: Implement config and settings**

`engine/lq_tts_engine/config.py`:
```python
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

ENGINE_DIR = Path(__file__).resolve().parent.parent


def _pairs(raw: str, name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in filter(None, (p.strip() for p in raw.split(","))):
        key, sep, value = item.partition(":")
        if not sep or not key or not value:
            raise ValueError(f"{name}: expected 'name:value' pairs, got {item!r}")
        out[key] = value
    return out


@dataclass(frozen=True)
class Config:
    database_url: str
    schema: str
    data_dir: Path
    tokens: dict[str, str]
    callback_secrets: dict[str, str]
    device: str
    whisper_model: str
    min_free_gb: float


def load_config(env: Mapping[str, str] | None = None) -> Config:
    if env is None:
        env = {**{k: v for k, v in dotenv_values(ENGINE_DIR / ".env").items() if v is not None}, **os.environ}

    def get(key: str, default: str | None = None) -> str:
        value = env.get(key, default)
        if value is None or value == "":
            raise ValueError(f"missing required setting {key}")
        return value

    caller_tokens = _pairs(get("LQTTS_TOKENS"), "LQTTS_TOKENS")
    return Config(
        database_url=get("LQTTS_DATABASE_URL"),
        schema=get("LQTTS_SCHEMA", "lq_tts_engine"),
        data_dir=Path(get("LQTTS_DATA_DIR")).expanduser(),
        tokens={token: caller for caller, token in caller_tokens.items()},
        callback_secrets=_pairs(get("LQTTS_CALLBACK_SECRETS"), "LQTTS_CALLBACK_SECRETS"),
        device=get("LQTTS_DEVICE", "mps"),
        whisper_model=get("LQTTS_WHISPER_MODEL", "small"),
        min_free_gb=float(get("LQTTS_MIN_FREE_GB", "20")),
    )
```

`engine/lq_tts_engine/settings.py`:
```python
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Format = Literal["mp3", "wav", "srt", "vtt"]


class JobSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float = Field(0.9, ge=0.7, le=1.3)
    pause_sentence_s: float = Field(0.45, ge=0, le=3)
    pause_paragraph_s: float = Field(0.80, ge=0, le=3)
    loudness_lufs: float = Field(-14.0, ge=-24, le=-9)
    formats: list[Format] = Field(default_factory=lambda: ["mp3", "wav", "srt", "vtt"])

    @field_validator("formats")
    @classmethod
    def _non_empty_unique(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("formats must not be empty")
        return list(dict.fromkeys(value))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_config_settings.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock .env.example lq_tts_engine tests
git commit -m "engine: scaffold, config and job settings"
```

---

### Task 2: Sentence splitter

**Files:**
- Create: `engine/lq_tts_engine/text/split.py`
- Test: `engine/tests/test_split.py`

**Interfaces:**
- Produces: `Unit(idx: int, paragraph_idx: int, text: str, style: str | None, paragraph_end: bool)` (frozen dataclass); `split_script(text: str) -> list[Unit]`; `is_single_sentence(text: str) -> bool`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_split.py`:
```python
from lq_tts_engine.text.split import Unit, is_single_sentence, split_script

PANDJI_P1 = (
    "Coba jujur deh. Dalam sepuluh menit terakhir, berapa kali lo ngecek HP? Satu? Tiga? "
    "Atau udah nggak keitung? Tenang, lo nggak sendirian. Kita semua hidup di zaman di mana "
    "setiap getaran, setiap bunyi ting, rasanya kayak panggilan darurat."
)


def texts(units):
    return [u.text for u in units]


def test_pandji_paragraph_merges_short_fragments_into_next_sentence():
    assert texts(split_script(PANDJI_P1)) == [
        "Coba jujur deh.",
        "Dalam sepuluh menit terakhir, berapa kali lo ngecek HP?",
        "Satu? Tiga? Atau udah nggak keitung?",
        "Tenang, lo nggak sendirian.",
        "Kita semua hidup di zaman di mana setiap getaran, setiap bunyi ting, rasanya kayak panggilan darurat.",
    ]


def test_paragraphs_set_index_and_end_flag():
    units = split_script("Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang.")
    assert [(u.idx, u.paragraph_idx, u.paragraph_end) for u in units] == [(0, 0, False), (1, 0, True), (2, 1, True)]


def test_abbreviations_do_not_end_sentences():
    assert texts(split_script("Kata dr. Budi ini penting sekali. Harganya Rp. 5000 saja hari ini.")) == [
        "Kata dr. Budi ini penting sekali.",
        "Harganya Rp. 5000 saja hari ini.",
    ]


def test_decimals_do_not_end_sentences():
    assert texts(split_script("Harganya naik 2.5 persen tahun ini. Itu cukup besar sekali.")) == [
        "Harganya naik 2.5 persen tahun ini.",
        "Itu cukup besar sekali.",
    ]


def test_trailing_fragment_merges_into_previous_sentence():
    assert texts(split_script("Kita mulai sekarang juga. Oke.")) == ["Kita mulai sekarang juga. Oke."]


def test_text_without_final_punctuation_is_one_unit():
    assert texts(split_script("Halo semua apa kabar")) == ["Halo semua apa kabar"]


def test_style_markup_applies_to_next_sentence_only_and_is_removed():
    units = split_script("{{style: cheerful, slightly faster}} Halo semua, apa kabar? Kita mulai sekarang ya.")
    assert units == [
        Unit(0, 0, "Halo semua, apa kabar?", "cheerful, slightly faster", False),
        Unit(1, 0, "Kita mulai sekarang ya.", None, True),
    ]


def test_style_markup_forces_a_sentence_break():
    units = split_script("Ini kalimat pembuka yang panjang {{style: whisper}} lalu bagian rahasia di sini.")
    assert [(u.text, u.style) for u in units] == [
        ("Ini kalimat pembuka yang panjang", None),
        ("lalu bagian rahasia di sini.", "whisper"),
    ]


def test_whitespace_is_collapsed_and_blank_input_gives_nothing():
    assert texts(split_script("  Satu   dua\n tiga empat.  ")) == ["Satu dua tiga empat."]
    assert split_script("   \n\n  ") == []


def test_is_single_sentence():
    assert is_single_sentence("Nggak usah ekstrem.")
    assert is_single_sentence("Satu? Tiga? Atau udah nggak keitung?")
    assert not is_single_sentence("Ini kalimat pertama ya. Ini kalimat kedua juga.")
    assert not is_single_sentence("Baris satu ini panjang.\n\nBaris dua.")
    assert not is_single_sentence("   ")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_split.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.text.split'`.

- [ ] **Step 3: Implement the splitter**

`engine/lq_tts_engine/text/split.py`:
```python
from __future__ import annotations

import re
from dataclasses import dataclass

ABBREVIATIONS = frozenset({
    "dr", "drs", "dra", "no", "rp", "dll", "dsb", "dkk", "mr", "mrs", "ms", "prof", "st",
    "jl", "tn", "ny", "sdr", "pt", "cv", "hlm", "vs", "etc", "jr", "sr", "bpk",
})
_STYLE = re.compile(r"\{\{\s*style\s*:\s*(.*?)\s*\}\}", re.IGNORECASE | re.DOTALL)
_END = re.compile(r"[.?!]+[\"'”’)\]]*(?=\s|$)")
_WORD = re.compile(r"\w+")
_PARA = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Unit:
    idx: int
    paragraph_idx: int
    text: str
    style: str | None
    paragraph_end: bool


def _words(text: str) -> int:
    return len(_WORD.findall(text))


def _sentences_in(chunk: str) -> list[str]:
    out: list[str] = []
    start = 0
    for match in _END.finditer(chunk):
        punct = match.group().rstrip("\"'”’)]")
        if punct == ".":
            before = _WORD.findall(chunk[start:match.start()])
            if before and before[-1].lower() in ABBREVIATIONS:
                continue
        sentence = " ".join(chunk[start:match.end()].split())
        if sentence:
            out.append(sentence)
        start = match.end()
    tail = " ".join(chunk[start:].split())
    if tail:
        out.append(tail)
    return out


def split_script(text: str) -> list[Unit]:
    units: list[Unit] = []
    paragraphs = [p for p in _PARA.split(text.replace("\r\n", "\n")) if p.strip()]
    for p_idx, paragraph in enumerate(paragraphs):
        raw: list[tuple[str, str | None]] = []
        pending_style: str | None = None
        for k, part in enumerate(_STYLE.split(paragraph)):
            if k % 2 == 1:
                pending_style = part.strip() or None
                continue
            for sentence in _sentences_in(part):
                raw.append((sentence, pending_style))
                pending_style = None

        merged: list[tuple[str, str | None]] = []
        buf, buf_style = "", None
        for sentence, style in raw:
            buf = f"{buf} {sentence}".strip()
            buf_style = buf_style or style
            if _words(buf) >= 3:
                merged.append((buf, buf_style))
                buf, buf_style = "", None
        if buf:
            if merged:
                last_text, last_style = merged[-1]
                merged[-1] = (f"{last_text} {buf}", last_style or buf_style)
            else:
                merged.append((buf, buf_style))

        for n, (sentence, style) in enumerate(merged):
            units.append(Unit(len(units), p_idx, sentence, style, n == len(merged) - 1))
    return units


def is_single_sentence(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and not _PARA.search(stripped) and len(split_script(stripped)) == 1
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_split.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/text/split.py tests/test_split.py
git commit -m "engine: sentence splitter with fragment merging and style markup"
```

---

### Task 3: Number normalization, QA score, language guess

**Files:**
- Create: `engine/lq_tts_engine/text/numbers.py`, `engine/lq_tts_engine/text/lang.py`, `engine/lq_tts_engine/qa.py`
- Test: `engine/tests/test_qa.py`

**Interfaces:**
- Produces: `normalize_for_match(text: str) -> str`; `guess_language(text: str) -> str | None` (`"id"`/`"en"`/`None`); `PASS_SCORE = 0.85`; `levenshtein(a: str, b: str) -> int`; `score(expected: str, heard: str) -> float` in `[0, 1]`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_qa.py`:
```python
import pytest

from lq_tts_engine.qa import PASS_SCORE, levenshtein, score
from lq_tts_engine.text.lang import guess_language
from lq_tts_engine.text.numbers import normalize_for_match


@pytest.mark.parametrize("text,expected", [
    ("Satu jam.", "1 jam"),
    ("dua puluh menit", "20 menit"),
    ("dua puluh lima ribu", "25000"),
    ("dua ratus lima puluh", "250"),
    ("seribu dua ratus", "1200"),
    ("tujuh belas", "17"),
    ("sepuluh ribu", "10000"),
    ("dua juta tiga ratus ribu", "2300000"),
    ("twenty three", "23"),
    ("one hundred twenty", "120"),
    ("Satu? Tiga?", "1 3"),
    ("satu tiga", "1 3"),
])
def test_number_words_become_digits(text, expected):
    assert normalize_for_match(text) == expected


def test_slang_variants_normalize_to_one_spelling():
    assert normalize_for_match("Lo nggak sendirian") == normalize_for_match("lu enggak sendirian")
    assert normalize_for_match("ngecek HP") == normalize_for_match("ngecek hape")


def test_levenshtein():
    assert levenshtein("", "abc") == 3
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("sama", "sama") == 0


def test_identical_and_empty_score_one():
    assert score("Halo semua.", "halo semua") == 1.0
    assert score("", "") == 1.0


def test_regression_spoken_numbers_written_as_digits_pass():
    # 2026-10-02: Whisper wrote "Satu? Tiga?" as "1, 3"
    assert score("Satu? Tiga? Atau udah nggak keitung?", "1, 3 atau udah gak keitung") >= PASS_SCORE


def test_real_whisper_output_from_pandji_run_passes():
    assert score(
        "Dalam sepuluh menit terakhir, berapa kali lo ngecek HP?",
        "dalam 10 menit terakhir berapa kali lo ngecek hape",
    ) >= PASS_SCORE


def test_regression_mispronounced_sentence_fails():
    # 2026-10-02: "Nggak usah ekstrem." came out as "Sosa ekstrem."
    assert score("Nggak usah ekstrem.", "Sosa ekstrem.") < PASS_SCORE


def test_score_is_bounded():
    assert 0.0 <= score("a", "completely different text") <= 1.0


@pytest.mark.parametrize("text,lang", [
    ("Tiap kali lo buka notifikasi, otak lo butuh waktu buat balik lagi ke kerjaan yang tadi.", "id"),
    ("This is the part where you decide what to do with your time.", "en"),
    ("Halo!", None),
])
def test_guess_language(text, lang):
    assert guess_language(text) == lang
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_qa.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.qa'`.

- [ ] **Step 3: Implement numbers, lang and qa**

`engine/lq_tts_engine/text/numbers.py`:
```python
from __future__ import annotations

import re

_UNITS = {
    "nol": 0, "satu": 1, "dua": 2, "tiga": 3, "empat": 4, "lima": 5, "enam": 6, "tujuh": 7,
    "delapan": 8, "sembilan": 9,
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_FIXED = {"sepuluh": 10, "sebelas": 11, "seratus": 100,
          "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
          "eighty": 80, "ninety": 90}
_GROUP_MULT = {"puluh": 10, "ratus": 100, "hundred": 100}
_SCALES = {"ribu": 1_000, "juta": 1_000_000, "thousand": 1_000, "million": 1_000_000}
_FIXED_SCALES = {"seribu": 1_000, "sejuta": 1_000_000}
_SLANG = {"nggak": "gak", "enggak": "gak", "ngga": "gak", "ga": "gak", "gk": "gak",
          "lu": "lo", "loe": "lo", "gua": "gue", "gw": "gue", "hape": "hp"}
_TOKEN = re.compile(r"[^\W_]+|[^\w\s]")


def _numbers_to_digits(tokens: list[str]) -> list[str]:
    out: list[str] = []
    total = group = last = 0
    active = last_was_unit = False

    def flush() -> None:
        nonlocal total, group, last, active, last_was_unit
        if active:
            out.append(str(total + group))
        total = group = last = 0
        active = last_was_unit = False

    for tok in tokens:
        if tok in _UNITS:
            if last_was_unit:
                flush()
            group += _UNITS[tok]
            last, active, last_was_unit = _UNITS[tok], True, True
        elif tok in _FIXED:
            if last_was_unit:
                flush()
            group += _FIXED[tok]
            last, active, last_was_unit = _FIXED[tok], True, False
        elif tok == "belas" and last_was_unit:
            group += 10
            last, last_was_unit = last + 10, False
        elif tok in _GROUP_MULT and last_was_unit:
            group += last * (_GROUP_MULT[tok] - 1)
            last, last_was_unit = last * _GROUP_MULT[tok], False
        elif tok in _SCALES and active:
            total += group * _SCALES[tok]
            group = last = 0
            last_was_unit = False
        elif tok in _FIXED_SCALES:
            if last_was_unit:
                flush()
            total += _FIXED_SCALES[tok]
            active, last_was_unit = True, False
        else:
            flush()
            out.append(tok)
    flush()
    return out


def normalize_for_match(text: str) -> str:
    tokens = [_SLANG.get(t, t) for t in _TOKEN.findall(text.lower())]
    return " ".join(t for t in _numbers_to_digits(tokens) if t.isalnum())
```

`engine/lq_tts_engine/text/lang.py`:
```python
from __future__ import annotations

import re

_ID = frozenset(
    "yang dan di ini itu dengan untuk tidak gak nggak lo gue aja kita ada dari ke akan sudah "
    "udah juga kalau jadi bisa harus buat lagi kayak".split()
)
_EN = frozenset("the and is are to of you this that with for it was be have not your what can will".split())
_WORDS = re.compile(r"[^\W\d_]+")


def guess_language(text: str) -> str | None:
    words = _WORDS.findall(text.lower())
    id_hits = sum(w in _ID for w in words)
    en_hits = sum(w in _EN for w in words)
    if en_hits > id_hits:
        return "en"
    if id_hits > 0:
        return "id"
    return None
```

`engine/lq_tts_engine/qa.py`:
```python
from __future__ import annotations

from .text.numbers import normalize_for_match

PASS_SCORE = 0.85


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def score(expected: str, heard: str) -> float:
    a, b = normalize_for_match(expected), normalize_for_match(heard)
    if not a and not b:
        return 1.0
    return max(0.0, 1.0 - levenshtein(a, b) / max(len(a), len(b)))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_qa.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/text/numbers.py lq_tts_engine/text/lang.py lq_tts_engine/qa.py tests/test_qa.py
git commit -m "engine: QA score with ID/EN number normalization and language guess"
```

---

### Task 4: Audio ops (trim, fade, tempo, assemble) + glitch regression

**Files:**
- Create: `engine/lq_tts_engine/audio/ops.py`
- Test: `engine/tests/test_audio_ops.py`

**Interfaces:**
- Produces: `class SilentAudio(ValueError)`; `trim(x: np.ndarray, sr: int, thr_db: float = -50.0, keep_s: float = 0.03, fade_s: float = 0.01) -> np.ndarray`; `fade(x: np.ndarray, sr: int, fade_s: float = 0.01) -> np.ndarray`; `tempo(x: np.ndarray, sr: int, factor: float) -> np.ndarray`; `assemble(segments: list[np.ndarray], gaps_s: list[float], sr: int) -> tuple[np.ndarray, list[tuple[float, float]]]` (audio, per-segment `(start_s, end_s)`). All float32 mono.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_audio_ops.py`:
```python
import numpy as np
import pytest

from lq_tts_engine.audio import ops

SR = 48000


def speech(seconds, seed=0):
    rng = np.random.default_rng(seed)
    return (0.3 * rng.standard_normal(int(seconds * SR))).astype(np.float32)


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype=np.float32)


def test_trim_removes_silence_but_keeps_30ms_margin():
    x = np.concatenate([silence(0.5), speech(1.0), silence(0.4)])
    y = ops.trim(x, SR)
    assert abs(len(y) / SR - 1.06) < 0.015


def test_trim_rejects_all_silent_audio():
    with pytest.raises(ops.SilentAudio):
        ops.trim(silence(1.0), SR)


def test_fade_zeroes_both_ends():
    y = ops.fade(np.ones(SR, dtype=np.float32), SR)
    assert y[0] == 0.0 and y[-1] == 0.0 and y[SR // 2] == 1.0


def test_tempo_changes_duration_and_identity_is_copy():
    x = speech(1.0)
    slow = ops.tempo(x, SR, 0.9)
    assert abs(len(slow) / SR - 1.0 / 0.9) < 0.02
    same = ops.tempo(x, SR, 1.0)
    assert np.array_equal(same, x) and same is not x


def test_assemble_inserts_exact_gaps_and_reports_times():
    a, b, c = speech(1.0, 1), speech(0.5, 2), speech(0.25, 3)
    audio, times = ops.assemble([a, b, c], [0.45, 0.80], SR)
    assert len(audio) == len(a) + 21600 + len(b) + 38400 + len(c)
    assert times == [(0.0, 1.0), (1.45, 1.95), (2.75, 3.0)]


def test_assemble_requires_one_gap_per_join():
    with pytest.raises(ValueError):
        ops.assemble([speech(0.1), speech(0.1)], [], SR)


def test_regression_joins_never_cut_into_speech():
    # 2026-10-02: pauses inserted after synthesis landed inside words and clicked.
    raw = [np.concatenate([silence(0.2), speech(1.0, s), silence(0.15)]) for s in range(3)]
    segments = [ops.fade(ops.tempo(ops.trim(r, SR), SR, 0.9), SR) for r in raw]
    audio, times = ops.assemble(segments, [0.45, 0.80], SR)
    for (_, prev_end), (next_start, _) in zip(times[:-1], times[1:]):
        gap = audio[int(round(prev_end * SR)):int(round(next_start * SR))]
        assert gap.size > 0 and np.all(gap == 0.0)
    edge = int(0.001 * SR)
    for seg in segments:
        peak = np.abs(seg).max()
        assert np.abs(seg[:edge]).max() <= 0.1 * peak + 1e-6
        assert np.abs(seg[-edge:]).max() <= 0.1 * peak + 1e-6
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_audio_ops.py -q`
Expected: FAIL — `ImportError: cannot import name 'ops'`.

- [ ] **Step 3: Implement audio ops**

`engine/lq_tts_engine/audio/ops.py`:
```python
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf


class SilentAudio(ValueError):
    """Raised when a take contains no audio above the trim threshold."""


def _frame_db(x: np.ndarray, sr: int, hop_s: float = 0.01) -> tuple[np.ndarray, int]:
    hop = max(int(hop_s * sr), 1)
    n = len(x) // hop
    if n == 0:
        return np.full(1, -180.0), hop
    frames = x[: n * hop].reshape(n, hop)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9), hop


def fade(x: np.ndarray, sr: int, fade_s: float = 0.01) -> np.ndarray:
    y = np.asarray(x, dtype=np.float32).copy()
    f = min(int(fade_s * sr), len(y) // 2)
    if f:
        y[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32)
        y[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)
    return y


def trim(x: np.ndarray, sr: int, thr_db: float = -50.0, keep_s: float = 0.03, fade_s: float = 0.01) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    db, hop = _frame_db(x, sr)
    voiced = np.flatnonzero(db > thr_db)
    if voiced.size == 0:
        raise SilentAudio("no audio above threshold")
    a = max(int(voiced[0]) * hop - int(keep_s * sr), 0)
    b = min((int(voiced[-1]) + 1) * hop + int(keep_s * sr), len(x))
    return fade(x[a:b], sr, fade_s)


def tempo(x: np.ndarray, sr: int, factor: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if abs(factor - 1.0) < 1e-9:
        return x.copy()
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.wav", Path(tmp) / "out.wav"
        sf.write(src, x, sr, subtype="FLOAT")
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-af", f"atempo={factor}",
             "-c:a", "pcm_f32le", str(dst)],
            check=True,
        )
        y, _ = sf.read(dst, dtype="float32")
    return y


def assemble(segments: list[np.ndarray], gaps_s: list[float], sr: int) -> tuple[np.ndarray, list[tuple[float, float]]]:
    if len(gaps_s) != max(len(segments) - 1, 0):
        raise ValueError("need exactly one gap between consecutive segments")
    parts: list[np.ndarray] = []
    times: list[tuple[float, float]] = []
    t = 0
    for i, seg in enumerate(segments):
        seg = np.asarray(seg, dtype=np.float32)
        times.append((t / sr, (t + len(seg)) / sr))
        parts.append(seg)
        t += len(seg)
        if i < len(gaps_s):
            n = int(round(gaps_s[i] * sr))
            parts.append(np.zeros(n, dtype=np.float32))
            t += n
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    return audio, times
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_audio_ops.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/audio/ops.py tests/test_audio_ops.py
git commit -m "engine: trim/fade/tempo/assemble with join regression test"
```

---

### Task 5: Loudness, MP3 encoding, subtitles

**Files:**
- Create: `engine/lq_tts_engine/audio/finish.py`, `engine/lq_tts_engine/subs.py`
- Test: `engine/tests/test_finish_subs.py`

**Interfaces:**
- Produces: `loudnorm(src: Path, dst: Path, lufs: float, true_peak: float = -1.0, sr: int = 48000) -> None` (writes 48 kHz mono PCM16 WAV); `measure_lufs(path: Path) -> float`; `encode_mp3(src: Path, dst: Path, sr: int = 48000) -> None`; `Cue(start_s: float, end_s: float, text: str)`; `to_srt(cues: list[Cue]) -> str`; `to_vtt(cues: list[Cue]) -> str`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_finish_subs.py`:
```python
import subprocess

import numpy as np
import soundfile as sf

from lq_tts_engine.audio import finish
from lq_tts_engine.subs import Cue, to_srt, to_vtt

SR = 48000


def quiet_program(path):
    t = np.arange(4 * SR) / SR
    x = (0.02 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    x[SR : SR + SR // 2] = 0.0
    sf.write(path, x, SR)


def test_loudnorm_reaches_target_and_writes_pcm16_mono(tmp_path):
    src, dst = tmp_path / "in.wav", tmp_path / "out.wav"
    quiet_program(src)
    finish.loudnorm(src, dst, -14.0)
    assert abs(finish.measure_lufs(dst) + 14.0) <= 1.0
    info = sf.info(dst)
    assert (info.samplerate, info.channels, info.subtype) == (48000, 1, "PCM_16")


def test_encode_mp3_is_192k_48k_mono(tmp_path):
    src, dst = tmp_path / "in.wav", tmp_path / "out.mp3"
    quiet_program(src)
    finish.encode_mp3(src, dst)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,sample_rate,channels,bit_rate", "-of", "default=nw=1", str(dst)],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "codec_name=mp3" in probe and "sample_rate=48000" in probe and "channels=1" in probe
    assert "bit_rate=192000" in probe


CUES = [Cue(0.0, 1.25, "Coba jujur deh."), Cue(3661.5, 3662.0, "Satu jam.")]


def test_srt_format():
    assert to_srt(CUES) == (
        "1\n00:00:00,000 --> 00:00:01,250\nCoba jujur deh.\n\n"
        "2\n01:01:01,500 --> 01:01:02,000\nSatu jam.\n\n"
    )


def test_vtt_format():
    assert to_vtt(CUES) == (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:01.250\nCoba jujur deh.\n\n"
        "01:01:01.500 --> 01:01:02.000\nSatu jam.\n\n"
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_finish_subs.py -q`
Expected: FAIL — `ImportError: cannot import name 'finish'`.

- [ ] **Step 3: Implement finish and subs**

`engine/lq_tts_engine/audio/finish.py`:
```python
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

_JSON = re.compile(r"\{[^{}]*\}")


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True)


def _loudness_stats(path: Path, extra: str = "") -> dict:
    out = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                "-af", f"loudnorm={extra}print_format=json", "-f", "null", "-"])
    return json.loads(_JSON.findall(out.stderr)[-1])


def loudnorm(src: Path, dst: Path, lufs: float, true_peak: float = -1.0, sr: int = 48000) -> None:
    target = f"I={lufs}:TP={true_peak}:LRA=11"
    m = _loudness_stats(src, f"{target}:")
    second = (f"loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
              f"offset={m['target_offset']}:linear=true")
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-af", second,
          "-ar", str(sr), "-ac", "1", "-c:a", "pcm_s16le", str(dst)])


def measure_lufs(path: Path) -> float:
    return float(_loudness_stats(path)["input_i"])


def encode_mp3(src: Path, dst: Path, sr: int = 48000) -> None:
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
          "-ar", str(sr), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "192k", str(dst)])
```

`engine/lq_tts_engine/subs.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Cue:
    start_s: float
    end_s: float
    text: str


def _ts(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(cues: list[Cue]) -> str:
    return "".join(
        f"{i}\n{_ts(c.start_s, ',')} --> {_ts(c.end_s, ',')}\n{c.text}\n\n" for i, c in enumerate(cues, 1)
    )


def to_vtt(cues: list[Cue]) -> str:
    return "WEBVTT\n\n" + "".join(f"{_ts(c.start_s, '.')} --> {_ts(c.end_s, '.')}\n{c.text}\n\n" for c in cues)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_finish_subs.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/audio/finish.py lq_tts_engine/subs.py tests/test_finish_subs.py
git commit -m "engine: two-pass loudnorm, mp3 encode, srt/vtt"
```

---

### Task 6: Postgres setup, schema and voice/job storage

**Files:**
- Create: `engine/lq_tts_engine/schema.sql`, `engine/lq_tts_engine/db.py`, `engine/lq_tts_engine/repo.py`, `engine/tests/conftest.py`, `engine/.env` (not committed)
- Test: `engine/tests/test_repo_store.py`

**Interfaces:**
- Consumes: `Unit` (Task 2).
- Produces: `migrate(database_url: str, schema: str) -> None`; `make_pool(database_url: str, schema: str, max_size: int = 8) -> ConnectionPool`; `class Repo(pool)` with (this task) `create_voice(voice_id, caller, owner_ref, name, language, source_path, user_transcript) -> dict`, `get_voice(caller, voice_id) -> dict | None`, `get_voice_any(voice_id) -> dict | None`, `list_voices(caller, owner_ref) -> list[dict]`, `soft_delete_voice(caller, voice_id) -> bool`, `next_voice_to_prepare() -> dict | None`, `voice_ready(voice_id, *, ref_audio_path, ref_transcript, ref_seconds, clip_start_s, clip_end_s, language) -> None`, `voice_failed(voice_id, code) -> None`, `create_job(*, caller, voice_id, text, settings: dict, callback_url, idempotency_key, units) -> tuple[dict, bool]`, `get_job(caller, job_id) -> dict | None`, `get_job_any(job_id) -> dict | None`, `list_sentences(job_id) -> list[dict]`, `get_sentence(job_id, idx) -> dict | None`, `purge_job(job_id) -> None`. Rows are dicts (psycopg `dict_row`). Fixture `repo` (fresh schema per test).

- [ ] **Step 1: Create role, databases and `.env`** (one-time, local socket as superuser `minato`)

```bash
PW=$(openssl rand -hex 24)
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE lq_tts_engine LOGIN PASSWORD '$PW'"
createdb -O lq_tts_engine lq_tts
createdb -O lq_tts_engine lq_tts_test
cat > .env <<EOF
LQTTS_DATABASE_URL=postgresql://lq_tts_engine:$PW@127.0.0.1:5432/lq_tts
LQTTS_TEST_DATABASE_URL=postgresql://lq_tts_engine:$PW@127.0.0.1:5432/lq_tts_test
LQTTS_SCHEMA=lq_tts_engine
LQTTS_DATA_DIR=~/Developer/LQ-TTS/data
LQTTS_TOKENS=lq-tts:$(openssl rand -hex 24),lq-studio:$(openssl rand -hex 24)
LQTTS_CALLBACK_SECRETS=lq-tts:$(openssl rand -hex 24),lq-studio:$(openssl rand -hex 24)
LQTTS_DEVICE=mps
LQTTS_WHISPER_MODEL=small
LQTTS_MIN_FREE_GB=20
EOF
chmod 600 .env
psql "postgresql://lq_tts_engine:$PW@127.0.0.1:5432/lq_tts_test" -Atc "select current_user"
```
Expected: last command prints `lq_tts_engine`. `git status` must not list `.env`.

- [ ] **Step 2: Write the failing tests and fixture**

`engine/tests/conftest.py`:
```python
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
```

`engine/tests/test_repo_store.py`:
```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_repo_store.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.db'`.

- [ ] **Step 4: Implement schema, db and the storage half of Repo**

`engine/lq_tts_engine/schema.sql`:
```sql
CREATE SCHEMA IF NOT EXISTS {schema};
SET search_path TO {schema};

CREATE TABLE IF NOT EXISTS voices (
  id uuid PRIMARY KEY,
  caller text NOT NULL,
  owner_ref text NOT NULL,
  name text NOT NULL,
  language text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_code text,
  source_path text NOT NULL,
  user_transcript text,
  ref_audio_path text,
  ref_transcript text,
  ref_seconds real,
  clip_start_s real,
  clip_end_s real,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS voices_owner ON voices (caller, owner_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  voice_id uuid NOT NULL REFERENCES voices(id),
  caller text NOT NULL,
  text text NOT NULL,
  settings jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  error_code text,
  priority int NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 1,
  attempts int NOT NULL DEFAULT 0,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  chars int NOT NULL,
  audio_seconds real,
  callback_url text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (caller, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (priority DESC, created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS sentences (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx int NOT NULL,
  paragraph_idx int NOT NULL,
  text text NOT NULL,
  style text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'needs_review')),
  takes int NOT NULL DEFAULT 0,
  score real,
  asr_text text,
  audio_path text,
  duration_s real,
  start_s real,
  end_s real,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE IF NOT EXISTS worker_state (
  id int PRIMARY KEY CHECK (id = 1),
  beat_at timestamptz NOT NULL,
  model_loaded boolean NOT NULL,
  device text NOT NULL,
  rtf real
);
```

`engine/lq_tts_engine/db.py`:
```python
from __future__ import annotations

import re
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

SCHEMA_SQL = Path(__file__).with_name("schema.sql")
_SAFE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _check(schema: str) -> str:
    if not _SAFE.match(schema):
        raise ValueError(f"unsafe schema name {schema!r}")
    return schema


def migrate(database_url: str, schema: str) -> None:
    sql = SCHEMA_SQL.read_text().replace("{schema}", _check(schema))
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(sql)


def make_pool(database_url: str, schema: str, max_size: int = 8) -> ConnectionPool:
    pool = ConnectionPool(
        database_url,
        min_size=1,
        max_size=max_size,
        open=True,
        kwargs={"row_factory": dict_row, "autocommit": True, "options": f"-c search_path={_check(schema)}"},
    )
    pool.wait()
    return pool
```

`engine/lq_tts_engine/repo.py`:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_repo_store.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lq_tts_engine/schema.sql lq_tts_engine/db.py lq_tts_engine/repo.py tests/conftest.py tests/test_repo_store.py
git commit -m "engine: postgres schema and voice/job storage"
```

---

### Task 7: Queue — claim, lease, recovery, cancel, regenerate, worker state

**Files:**
- Modify: `engine/lq_tts_engine/repo.py` (append methods to `Repo`)
- Test: `engine/tests/test_repo_queue.py`

**Interfaces:**
- Consumes: Task 6 `Repo`, fixtures `repo`, `ready_voice`, helper `sql`.
- Produces (new `Repo` methods): `claim_job(lease_s: int = 60) -> dict | None`; `renew_lease(job_id, lease_s: int = 60) -> None`; `requeue_expired(max_attempts: int = 3) -> list[dict]`; `next_pending_sentence(job_id) -> dict | None`; `mark_sentence_running(job_id, idx) -> None`; `save_sentence(job_id, idx, *, status, takes, score, asr_text, audio_path, duration_s) -> None`; `set_sentence_times(job_id, times: Sequence[tuple[int, float, float]]) -> None`; `finish_job(job_id, audio_seconds: float) -> None`; `fail_job(job_id, code: str) -> None`; `request_cancel(caller, job_id) -> bool`; `cancel_requested(job_id) -> bool`; `mark_canceled(job_id) -> None`; `request_regenerate(caller, job_id, idx, text: str | None, style: str | None) -> int` (raises `LookupError`, `NotRegeneratable`; `style=""` clears, `None` keeps); `delete_job(caller, job_id) -> dict | None` (returns `{id, status}`); `queue_position(job_id) -> int`; `chars_ahead(job_id) -> int`; `queue_depth() -> int`; `heartbeat(*, model_loaded: bool, device: str, rtf: float | None) -> None`; `worker_state() -> dict | None` (adds `age_s`); `referenced_take_paths() -> set[str]`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_repo_queue.py`:
```python
import pytest

from lq_tts_engine.repo import NotRegeneratable
from lq_tts_engine.text.split import split_script
from tests.conftest import sql

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def new_job(repo, voice, text=TEXT):
    job, _ = repo.create_job(caller="lq-tts", voice_id=voice["id"], text=text, settings={}, callback_url=None,
                             idempotency_key=None, units=split_script(text))
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_repo_queue.py -q`
Expected: FAIL — `AttributeError: 'Repo' object has no attribute 'claim_job'`.

- [ ] **Step 3: Append the queue methods to `Repo`** (inside the class in `engine/lq_tts_engine/repo.py`, after `purge_job`)

```python
    # ---- queue --------------------------------------------------------------
    def claim_job(self, lease_s: int = 60) -> Row | None:
        return self._one(
            "UPDATE jobs SET status='running', lease_until = now() + %s * interval '1 second', "
            "started_at = coalesce(started_at, now()) "
            "WHERE id = (SELECT id FROM jobs WHERE status='queued' AND deleted_at IS NULL "
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_repo_queue.py tests/test_repo_store.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/repo.py tests/test_repo_queue.py
git commit -m "engine: postgres queue with leases, recovery, cancel and regenerate"
```

---

### Task 8: Synthesizer/transcriber interfaces, fakes, voice preparation

**Files:**
- Create: `engine/lq_tts_engine/asr.py`, `engine/lq_tts_engine/synth.py`, `engine/lq_tts_engine/voiceprep.py`, `engine/tests/fakes.py`
- Test: `engine/tests/test_voiceprep.py`

**Interfaces:**
- Produces: `Word(start: float, end: float, text: str, score: float)`; `Transcript(words: list[Word], language: str | None, duration: float)`; `Transcriber` protocol `transcribe(path: Path, language: str | None, vad: bool = False) -> Transcript`; `WhisperTranscriber(model_name: str = "small", cpu_threads: int = 8)`; `VoiceRef(ref_audio_path: str, ref_transcript: str)`; `Synthesizer` protocol (`sample_rate: int`, `generate(text: str, voice: VoiceRef, style: str | None) -> np.ndarray`); `VoxSynth(device: str)`; `Clip(start_s, end_s, transcript)`; `select_clip(words: list[Word], duration: float, *, min_s=10.0, max_s=20.0, max_gap_s=0.6, cut_gap_s=0.25, min_ok_s=8.0, pad_s=0.05) -> Clip | None`; `class NoCleanSpeech(Exception)`; `PreparedVoice(ref_seconds, clip_start_s, clip_end_s, transcript, language)`; `prepare_voice(source: Path, ref_out: Path, transcriber: Transcriber, *, user_transcript: str | None, language: str | None) -> PreparedVoice`. Test fakes: `ToneSynth(silent_takes: int = 0, fail_with: Exception | None = None)` with `.calls`; `FakeTranscriber(sentence_texts: dict[int, str] | None = None, scripted: dict[int, list[str]] | None = None, voice_words: list[Word] | None = None, language: str = "id", duration: float = 12.0)`.

- [ ] **Step 1: Write the fakes and the failing tests**

`engine/tests/fakes.py`:
```python
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

from lq_tts_engine.asr import Transcript, Word

_TAKE = re.compile(r"^s(\d+)_r\d+_t\d+\.wav$")


class ToneSynth:
    """Deterministic stand-in for VoxCPM2: one 0.25 s tone burst per word."""

    sample_rate = 48000

    def __init__(self, silent_takes: int = 0, fail_with: Exception | None = None):
        self.calls: list[tuple[str, str | None]] = []
        self.silent_takes = silent_takes
        self.fail_with = fail_with

    def generate(self, text, voice, style):
        self.calls.append((text, style))
        if self.fail_with is not None:
            raise self.fail_with
        sr = self.sample_rate
        if len(self.calls) <= self.silent_takes:
            return np.zeros(sr // 2, dtype=np.float32)
        t = np.arange(int(0.25 * sr)) / sr
        burst = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        gap = np.zeros(int(0.05 * sr), dtype=np.float32)
        pad = np.zeros(int(0.1 * sr), dtype=np.float32)
        words = max(len(text.split()), 1)
        return np.concatenate([pad, *[np.concatenate([burst, gap]) for _ in range(words)], pad])


class FakeTranscriber:
    """Hears take files by sentence index (from the file name); hears voice uploads as `voice_words`."""

    def __init__(self, sentence_texts=None, scripted=None, voice_words=None, language="id", duration=12.0):
        self.sentence_texts = dict(sentence_texts or {})
        self.scripted = {k: list(v) for k, v in (scripted or {}).items()}
        self.voice_words = list(voice_words or [])
        self.language = language
        self.duration = duration
        self.calls: list[tuple[str, str | None, bool]] = []

    def transcribe(self, path, language, vad=False):
        self.calls.append((Path(path).name, language, vad))
        m = _TAKE.match(Path(path).name)
        if m:
            idx = int(m.group(1))
            queue = self.scripted.get(idx, [])
            text = queue.pop(0) if queue else self.sentence_texts.get(idx, "")
            return Transcript([Word(0.0, 1.0, w, -0.1) for w in text.split()], language, 1.0)
        return Transcript(list(self.voice_words), self.language, self.duration)


def words_from(spec: list[tuple[float, float, str]], score: float = -0.2) -> list[Word]:
    return [Word(a, b, t, score) for a, b, t in spec]
```

`engine/tests/test_voiceprep.py`:
```python
import numpy as np
import pytest
import soundfile as sf

from lq_tts_engine.asr import Word
from lq_tts_engine.voiceprep import NoCleanSpeech, prepare_voice, select_clip
from tests.fakes import FakeTranscriber


def steady_words(start, end, step=0.5, gap=0.1, score=-0.2, label="kata"):
    out, t = [], start
    while t + step - gap <= end + 1e-9:
        out.append(Word(round(t, 3), round(t + step - gap, 3), label, score))
        t += step
    return out


def test_picks_most_confident_window_between_10_and_20_s():
    noisy = steady_words(0.0, 15.0, score=-0.9, label="noisy")
    clean = steady_words(16.0, 31.0, score=-0.1, label="clean")
    clip = select_clip(noisy + clean, 40.0)
    assert clip is not None and 10.0 <= clip.end_s - clip.start_s <= 20.1
    assert clip.start_s >= 15.9 and set(clip.transcript.split()) == {"clean"}


def test_long_monologue_window_never_exceeds_20_s():
    clip = select_clip(steady_words(0.0, 300.0, gap=0.3), 300.0)
    assert clip is not None and clip.end_s - clip.start_s <= 20.1


def test_falls_back_to_8_s_when_no_10_s_run_exists():
    clip = select_clip(steady_words(0.0, 9.0), 9.5)
    assert clip is not None and 8.0 <= clip.end_s - clip.start_s < 10.0


def test_returns_none_without_8_s_of_continuous_speech():
    short_bursts = steady_words(0.0, 5.0) + steady_words(7.0, 12.0)  # 1.6 s+ gap splits runs
    assert select_clip(short_bursts, 13.0) is None
    assert select_clip([], 10.0) is None


def test_cuts_only_at_pauses_of_at_least_250_ms():
    words = steady_words(0.0, 30.0, gap=0.1)  # 100 ms gaps everywhere: only run edges are legal cuts
    assert select_clip(words, 30.0) is None


def _write_tone(path, seconds):
    t = np.arange(int(seconds * 48000)) / 48000
    sf.write(path, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000)


def test_prepare_voice_cuts_selected_clip(tmp_path):
    src, ref = tmp_path / "source.wav", tmp_path / "out" / "ref.wav"
    _write_tone(src, 30.0)
    fake = FakeTranscriber(voice_words=steady_words(2.0, 16.0, gap=0.3), language="id", duration=30.0)
    p = prepare_voice(src, ref, fake, user_transcript=None, language=None)
    info = sf.info(ref)
    assert (info.samplerate, info.channels) == (48000, 1)
    assert abs(info.duration - p.ref_seconds) < 0.02 and 10.0 <= p.ref_seconds <= 20.1
    assert p.language == "id" and p.clip_start_s >= 1.9
    assert fake.calls[0][2] is True  # VAD on for uploads


def test_prepare_voice_uses_caller_transcript_for_short_upload(tmp_path):
    src, ref = tmp_path / "source.wav", tmp_path / "ref.wav"
    _write_tone(src, 12.0)
    fake = FakeTranscriber(voice_words=steady_words(0.5, 11.5, gap=0.3), duration=12.0)
    p = prepare_voice(src, ref, fake, user_transcript="Ini transkrip asli.", language="id")
    assert (p.clip_start_s, p.clip_end_s, p.transcript) == (0.0, 12.0, "Ini transkrip asli.")


def test_prepare_voice_raises_without_clean_speech(tmp_path):
    src = tmp_path / "source.wav"
    _write_tone(src, 6.0)
    with pytest.raises(NoCleanSpeech):
        prepare_voice(src, tmp_path / "ref.wav", FakeTranscriber(voice_words=steady_words(0.0, 5.0), duration=6.0),
                      user_transcript=None, language=None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_voiceprep.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.asr'`.

- [ ] **Step 3: Implement asr, synth and voiceprep**

`engine/lq_tts_engine/asr.py`:
```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str
    score: float  # segment avg log-probability; higher is more confident


@dataclass(frozen=True)
class Transcript:
    words: list[Word]
    language: str | None
    duration: float


class Transcriber(Protocol):
    def transcribe(self, path: Path, language: str | None, vad: bool = False) -> Transcript: ...


class WhisperTranscriber:
    """faster-whisper on CPU (int8) so QA never competes with VoxCPM2 for the GPU."""

    def __init__(self, model_name: str = "small", cpu_threads: int = 8):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=cpu_threads)

    def transcribe(self, path: Path, language: str | None, vad: bool = False) -> Transcript:
        segments, info = self.model.transcribe(str(path), language=language, vad_filter=vad, word_timestamps=True)
        words = [Word(w.start, w.end, w.word.strip(), s.avg_logprob) for s in segments for w in (s.words or [])]
        return Transcript(words, info.language, info.duration)
```

`engine/lq_tts_engine/synth.py`:
```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np


@dataclass(frozen=True)
class VoiceRef:
    ref_audio_path: str
    ref_transcript: str


class Synthesizer(Protocol):
    sample_rate: int

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray: ...


class VoxSynth:
    """VoxCPM2 with prompt audio + transcript + reference audio (best cloning similarity)."""

    def __init__(self, device: str):
        from voxcpm import VoxCPM

        self.model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False, device=device)
        self.sample_rate = int(self.model.tts_model.sample_rate)

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray:
        prompt = f"({style}){text}" if style else text
        wav = self.model.generate(
            text=prompt,
            prompt_wav_path=voice.ref_audio_path,
            prompt_text=voice.ref_transcript,
            reference_wav_path=voice.ref_audio_path,
            cfg_value=2.0,
            inference_timesteps=10,
        )
        return np.asarray(wav, dtype=np.float32)
```

`engine/lq_tts_engine/voiceprep.py`:
```python
from __future__ import annotations

from bisect import bisect_left
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .asr import Transcriber, Word


class NoCleanSpeech(Exception):
    """No continuous clean speech of at least 8 s in the upload."""


@dataclass(frozen=True)
class Clip:
    start_s: float
    end_s: float
    transcript: str


@dataclass(frozen=True)
class PreparedVoice:
    ref_seconds: float
    clip_start_s: float
    clip_end_s: float
    transcript: str
    language: str | None


def select_clip(words: list[Word], duration: float, *, min_s: float = 10.0, max_s: float = 20.0,
                max_gap_s: float = 0.6, cut_gap_s: float = 0.25, min_ok_s: float = 8.0,
                pad_s: float = 0.05) -> Clip | None:
    if not words:
        return None
    runs: list[list[Word]] = []
    current = [words[0]]
    for prev, word in zip(words, words[1:]):
        if word.start - prev.end > max_gap_s:
            runs.append(current)
            current = [word]
        else:
            current.append(word)
    runs.append(current)

    best: list[Word] | None = None
    best_key: tuple | None = None
    for run in runs:
        n = len(run)
        starts = [i for i in range(n) if i == 0 or run[i].start - run[i - 1].end >= cut_gap_s]
        ends = [j for j in range(n) if j == n - 1 or run[j + 1].start - run[j].end >= cut_gap_s]
        for i in starts:
            for j in ends[bisect_left(ends, i):]:
                length = run[j].end - run[i].start
                if length > max_s:
                    break
                if length < min_ok_s:
                    continue
                window = run[i:j + 1]
                key = (length >= min_s, sum(w.score for w in window) / len(window), length)
                if best_key is None or key > best_key:
                    best, best_key = window, key
    if best is None:
        return None
    return Clip(max(0.0, best[0].start - pad_s), min(duration, best[-1].end + pad_s),
                " ".join(w.text for w in best).strip())


def prepare_voice(source: Path, ref_out: Path, transcriber: Transcriber, *, user_transcript: str | None,
                  language: str | None) -> PreparedVoice:
    with tempfile.TemporaryDirectory() as tmp:
        full = Path(tmp) / "full.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-ac", "1", "-ar", "48000",
                        "-c:a", "pcm_s16le", str(full)], check=True)
        transcript = transcriber.transcribe(full, language, vad=True)
        clip = select_clip(transcript.words, transcript.duration)
        if clip is None:
            raise NoCleanSpeech()
        if user_transcript and transcript.duration <= 20.0:
            clip = Clip(0.0, transcript.duration, user_transcript.strip())
        ref_out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(full),
                        "-ss", f"{clip.start_s:.3f}", "-to", f"{clip.end_s:.3f}",
                        "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse",
                        "-c:a", "pcm_s16le", str(ref_out)], check=True)
    return PreparedVoice(clip.end_s - clip.start_s, clip.start_s, clip.end_s, clip.transcript, transcript.language)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_voiceprep.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/asr.py lq_tts_engine/synth.py lq_tts_engine/voiceprep.py tests/fakes.py tests/test_voiceprep.py
git commit -m "engine: synth/asr interfaces and voice clip selection"
```

---

### Task 9: Pipeline — per-sentence generation with QA retakes, assembly, resume, regenerate

**Files:**
- Create: `engine/lq_tts_engine/pipeline.py`
- Test: `engine/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `ops` (Task 4), `finish`, `Cue/to_srt/to_vtt` (Task 5), `Repo` (Tasks 6–7), `Synthesizer/VoiceRef`, `Transcriber` (Task 8), `score/PASS_SCORE` and `guess_language` (Task 3), `JobSettings` (Task 1).
- Produces: `MAX_TAKES = 4`; `class Canceled(Exception)`; `class SynthesisFailed(Exception)`; `job_dir(data_dir: Path, job_id) -> Path`; `revision_dir(data_dir: Path, job_id, revision: int) -> Path`; `latest_revision(data_dir: Path, job_id) -> int | None`; `Deps(repo, synth, asr, data_dir, rtf_window: deque)` with `rolling_rtf() -> float | None`; `process_sentence(job: dict, sentence: dict, voice: dict, deps: Deps, should_stop: Callable[[], bool]) -> None`; `assemble_revision(job: dict, deps: Deps) -> float`; `run_job(job: dict, deps: Deps, *, should_stop: Callable[[], bool]) -> str` returning `"done" | "canceled" | "failed"`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_pipeline.py`:
```python
import pytest
import soundfile as sf

from lq_tts_engine.audio.finish import measure_lufs
from lq_tts_engine.pipeline import Deps, latest_revision, revision_dir, run_job
from lq_tts_engine.text.split import split_script
from tests.fakes import FakeTranscriber, ToneSynth

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang."


def setup(repo, voice, tmp_path, settings=None, scripted=None, synth=None):
    units = split_script(TEXT)
    repo.create_job(caller="lq-tts", voice_id=voice["id"], text=TEXT, settings=settings or {}, callback_url=None,
                    idempotency_key=None, units=units)
    deps = Deps(repo=repo, synth=synth or ToneSynth(),
                asr=FakeTranscriber(sentence_texts={u.idx: u.text for u in units}, scripted=scripted),
                data_dir=tmp_path / "data")
    return deps, repo.claim_job()


never = lambda: False  # noqa: E731


def test_happy_path_writes_all_formats_with_exact_pauses(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    assert run_job(job, deps, should_stop=never) == "done"
    out = revision_dir(deps.data_dir, job["id"], 1)
    assert {p.name for p in out.iterdir()} == {"final.mp3", "final.wav", "subs.srt", "subs.vtt"}
    s = repo.list_sentences(job["id"])
    assert [x["status"] for x in s] == ["done"] * 3 and [x["takes"] for x in s] == [1, 1, 1]
    assert s[1]["start_s"] - s[0]["end_s"] == pytest.approx(0.45, abs=1e-3)
    assert s[2]["start_s"] - s[1]["end_s"] == pytest.approx(0.80, abs=1e-3)
    assert (out / "subs.srt").read_text().count(" --> ") == 3
    assert abs(measure_lufs(out / "final.wav") + 14.0) <= 1.0
    job_row = repo.get_job_any(job["id"])
    assert job_row["status"] == "done"
    assert job_row["audio_seconds"] == pytest.approx(sf.info(out / "final.wav").duration, abs=0.01)


def test_failed_check_triggers_retake_and_keeps_passing_take(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, scripted={1: ["salah total", "salah lagi"]})
    run_job(job, deps, should_stop=never)
    s1 = repo.get_sentence(job["id"], 1)
    assert (s1["status"], s1["takes"], s1["score"]) == ("done", 3, pytest.approx(1.0))
    assert s1["audio_path"].endswith("s0001_r1_t3.wav")
    assert len(deps.synth.calls) == 5


def test_four_failed_takes_mark_needs_review_but_job_completes(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, scripted={0: ["a b c"] * 4})
    assert run_job(job, deps, should_stop=never) == "done"
    s0 = repo.get_sentence(job["id"], 0)
    assert (s0["status"], s0["takes"]) == ("needs_review", 4)


def test_silent_take_is_retaken(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, synth=ToneSynth(silent_takes=1))
    run_job(job, deps, should_stop=never)
    assert repo.get_sentence(job["id"], 0)["takes"] == 2


def test_cancel_then_resume_skips_finished_sentences(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    done_count = {"n": 0}

    def stop_after_first():
        done_count["n"] += 1
        return done_count["n"] > 2  # before take 1 of sentence 0, then between sentences

    assert run_job(job, deps, should_stop=stop_after_first) == "canceled"
    assert [x["status"] for x in repo.list_sentences(job["id"])] == ["done", "pending", "pending"]
    assert run_job(job, deps, should_stop=never) == "done"
    assert len(deps.synth.calls) == 3


def test_regenerate_builds_new_revision_and_keeps_old(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    run_job(job, deps, should_stop=never)
    assert repo.request_regenerate("lq-tts", job["id"], 1, "Kalimat kedua yang baru.", None) == 2
    deps.asr.sentence_texts[1] = "Kalimat kedua yang baru."
    job2 = repo.claim_job()
    assert run_job(job2, deps, should_stop=never) == "done"
    assert len(deps.synth.calls) == 4
    assert (revision_dir(deps.data_dir, job["id"], 1) / "final.wav").exists()
    assert (revision_dir(deps.data_dir, job["id"], 2) / "final.wav").exists()
    assert latest_revision(deps.data_dir, job["id"]) == 2
    assert repo.get_sentence(job["id"], 1)["audio_path"].endswith("s0001_r2_t1.wav")


def test_only_requested_formats_are_kept(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path, settings={"formats": ["mp3"]})
    run_job(job, deps, should_stop=never)
    assert {p.name for p in revision_dir(deps.data_dir, job["id"], 1).iterdir()} == {"final.mp3"}


def test_speed_setting_slows_sentences(repo, ready_voice, tmp_path):
    deps_fast, job_fast = setup(repo, ready_voice, tmp_path / "a", settings={"speed": 1.0})
    run_job(job_fast, deps_fast, should_stop=never)
    deps_slow, job_slow = setup(repo, ready_voice, tmp_path / "b", settings={"speed": 0.8})
    run_job(job_slow, deps_slow, should_stop=never)
    fast = repo.get_sentence(job_fast["id"], 0)["duration_s"]
    slow = repo.get_sentence(job_slow["id"], 0)["duration_s"]
    assert slow / fast == pytest.approx(1.25, rel=0.05)


def test_voice_not_ready_fails_job(repo, ready_voice, tmp_path):
    deps, job = setup(repo, ready_voice, tmp_path)
    repo.soft_delete_voice("lq-tts", ready_voice["id"])
    assert run_job(job, deps, should_stop=never) == "failed"
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "voice_not_ready")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_pipeline.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.pipeline'`.

- [ ] **Step 3: Implement the pipeline**

`engine/lq_tts_engine/pipeline.py`:
```python
from __future__ import annotations

import re
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import soundfile as sf

from .asr import Transcriber
from .audio import finish, ops
from .qa import PASS_SCORE, score
from .repo import Repo
from .settings import JobSettings
from .subs import Cue, to_srt, to_vtt
from .synth import Synthesizer, VoiceRef
from .text.lang import guess_language

MAX_TAKES = 4
_REV = re.compile(r"^r(\d+)$")


class Canceled(Exception):
    """Cancel was requested while the job was running."""


class SynthesisFailed(Exception):
    """Every take of a sentence was silent."""


def job_dir(data_dir: Path, job_id) -> Path:
    return data_dir / "jobs" / str(job_id)


def revision_dir(data_dir: Path, job_id, revision: int) -> Path:
    return job_dir(data_dir, job_id) / f"r{revision}"


def latest_revision(data_dir: Path, job_id) -> int | None:
    root = job_dir(data_dir, job_id)
    if not root.exists():
        return None
    revisions = [int(m.group(1)) for p in root.iterdir() if p.is_dir() and (m := _REV.match(p.name)) and any(p.iterdir())]
    return max(revisions) if revisions else None


@dataclass
class Deps:
    repo: Repo
    synth: Synthesizer
    asr: Transcriber
    data_dir: Path
    rtf_window: deque = field(default_factory=lambda: deque(maxlen=20))

    def rolling_rtf(self) -> float | None:
        return sum(self.rtf_window) / len(self.rtf_window) if self.rtf_window else None


def process_sentence(job: dict, sentence: dict, voice: dict, deps: Deps, should_stop: Callable[[], bool]) -> None:
    settings = JobSettings(**job["settings"])
    ref = VoiceRef(voice["ref_audio_path"], voice["ref_transcript"])
    language = guess_language(sentence["text"]) or voice.get("language")
    takes_dir = job_dir(deps.data_dir, job["id"]) / "takes"
    takes_dir.mkdir(parents=True, exist_ok=True)
    sr = deps.synth.sample_rate
    best: tuple[float, Path, str, float] | None = None
    take_no = 0
    for take_no in range(1, MAX_TAKES + 1):
        if should_stop():
            raise Canceled()
        started = time.monotonic()
        raw = deps.synth.generate(sentence["text"], ref, sentence["style"])
        if len(raw):
            deps.rtf_window.append((time.monotonic() - started) / (len(raw) / sr))
        try:
            audio = ops.fade(ops.tempo(ops.trim(raw, sr), sr, settings.speed), sr)
        except ops.SilentAudio:
            continue
        path = takes_dir / f"s{sentence['idx']:04d}_r{job['revision']}_t{take_no}.wav"
        sf.write(path, audio, sr, subtype="FLOAT")
        heard = " ".join(w.text for w in deps.asr.transcribe(path, language).words)
        take_score = score(sentence["text"], heard)
        if best is None or take_score > best[0]:
            best = (take_score, path, heard, len(audio) / sr)
        if take_score >= PASS_SCORE:
            break
    if best is None:
        raise SynthesisFailed(f"sentence {sentence['idx']}: every take was silent")
    take_score, path, heard, duration = best
    deps.repo.save_sentence(
        job["id"], sentence["idx"], status="done" if take_score >= PASS_SCORE else "needs_review",
        takes=take_no, score=take_score, asr_text=heard, audio_path=str(path), duration_s=duration,
    )


def assemble_revision(job: dict, deps: Deps) -> float:
    settings = JobSettings(**job["settings"])
    sentences = deps.repo.list_sentences(job["id"])
    sr = deps.synth.sample_rate
    segments, gaps = [], []
    for i, s in enumerate(sentences):
        audio, file_sr = sf.read(s["audio_path"], dtype="float32")
        if file_sr != sr:
            raise RuntimeError(f"take {s['audio_path']} is {file_sr} Hz, expected {sr}")
        segments.append(audio)
        if i < len(sentences) - 1:
            new_paragraph = sentences[i + 1]["paragraph_idx"] != s["paragraph_idx"]
            gaps.append(settings.pause_paragraph_s if new_paragraph else settings.pause_sentence_s)
    audio, times = ops.assemble(segments, gaps, sr)

    out = revision_dir(deps.data_dir, job["id"], job["revision"])
    out.mkdir(parents=True, exist_ok=True)
    raw = out / "raw.wav"
    sf.write(raw, audio, sr, subtype="FLOAT")
    final_wav = out / "final.wav"
    finish.loudnorm(raw, final_wav, settings.loudness_lufs, sr=sr)
    raw.unlink()
    if "mp3" in settings.formats:
        finish.encode_mp3(final_wav, out / "final.mp3", sr=sr)
    cues = [Cue(a, b, s["text"]) for s, (a, b) in zip(sentences, times)]
    if "srt" in settings.formats:
        (out / "subs.srt").write_text(to_srt(cues), encoding="utf-8")
    if "vtt" in settings.formats:
        (out / "subs.vtt").write_text(to_vtt(cues), encoding="utf-8")
    if "wav" not in settings.formats:
        final_wav.unlink()
    deps.repo.set_sentence_times(job["id"], [(s["idx"], a, b) for s, (a, b) in zip(sentences, times)])
    return len(audio) / sr


def run_job(job: dict, deps: Deps, *, should_stop: Callable[[], bool]) -> str:
    voice = deps.repo.get_voice_any(job["voice_id"])
    if voice is None or voice["status"] != "ready" or voice["deleted_at"] is not None:
        deps.repo.fail_job(job["id"], "voice_not_ready")
        return "failed"
    try:
        while True:
            if should_stop():
                raise Canceled()
            sentence = deps.repo.next_pending_sentence(job["id"])
            if sentence is None:
                break
            deps.repo.mark_sentence_running(job["id"], sentence["idx"])
            try:
                process_sentence(job, sentence, voice, deps, should_stop)
            except Canceled:
                deps.repo.save_sentence(job["id"], sentence["idx"], status="pending", takes=0, score=None,
                                        asr_text=None, audio_path=sentence["audio_path"], duration_s=sentence["duration_s"])
                raise
    except Canceled:
        return "canceled"
    seconds = assemble_revision(job, deps)
    deps.repo.finish_job(job["id"], seconds)
    return "done"
```

Note for the implementer: in `test_cancel_then_resume_skips_finished_sentences`, `should_stop` is called once before the first sentence, once before take 1 of sentence 0, and returns `True` on the third call (before sentence 1), so exactly sentence 0 is done. `run_job` leaves the job row `running`; marking it `canceled` is the worker's job (Task 13).

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_pipeline.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/pipeline.py tests/test_pipeline.py
git commit -m "engine: per-sentence pipeline with QA retakes, assembly and revisions"
```

---

### Task 10: Signed callbacks and retention

**Files:**
- Create: `engine/lq_tts_engine/callbacks.py`, `engine/lq_tts_engine/retention.py`
- Test: `engine/tests/test_callbacks_retention.py`

**Interfaces:**
- Produces: `RETRY_DELAYS_S = (1, 5, 30, 120, 300)`; `sign(secret: str, timestamp: str, body: bytes) -> str` (`"sha256=<hex>"`); `verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool`; `CallbackSender(secrets: dict[str, str], *, delays=RETRY_DELAYS_S, client_factory=..., sleep=time.sleep)` with `send(caller, url, payload) -> threading.Thread` and `deliver(caller, url, payload) -> bool`; `purge_unreferenced_takes(data_dir: Path, referenced: set[str], *, older_than_s: float = 604800, now: float | None = None) -> int`; `free_gb(path: Path) -> float`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_callbacks_retention.py`:
```python
import json
import os
import time

import httpx

from lq_tts_engine.callbacks import CallbackSender, sign, verify
from lq_tts_engine.retention import free_gb, purge_unreferenced_takes


def test_signature_verifies_and_detects_tampering():
    body = b'{"job_id":"x","status":"done","revision":1}'
    sig = sign("s3cret", "1700000000", body)
    assert sig.startswith("sha256=") and verify("s3cret", "1700000000", body, sig)
    assert not verify("s3cret", "1700000001", body, sig)
    assert not verify("s3cret", "1700000000", body + b" ", sig)
    assert not verify("other", "1700000000", body, sig)


def make_sender(statuses):
    seen, sleeps = [], []

    def handler(request):
        seen.append(request)
        return httpx.Response(statuses[min(len(seen) - 1, len(statuses) - 1)])

    sender = CallbackSender({"lq-tts": "s3cret"}, client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
                            sleep=sleeps.append)
    return sender, seen, sleeps


def test_delivery_retries_until_success_with_valid_signature():
    sender, seen, sleeps = make_sender([500, 502, 200])
    assert sender.deliver("lq-tts", "http://app.local/cb", {"job_id": "j1", "status": "done", "revision": 2}) is True
    assert len(seen) == 3 and sleeps == [1, 5]
    req = seen[-1]
    assert json.loads(req.content) == {"job_id": "j1", "status": "done", "revision": 2}
    assert verify("s3cret", req.headers["X-LQ-Timestamp"], req.content, req.headers["X-LQ-Signature"])


def test_delivery_gives_up_after_five_retries():
    sender, seen, sleeps = make_sender([503])
    assert sender.deliver("lq-tts", "http://app.local/cb", {"job_id": "j1"}) is False
    assert len(seen) == 6 and sleeps == [1, 5, 30, 120, 300]


def test_purge_removes_only_old_unreferenced_takes(tmp_path):
    takes = tmp_path / "jobs" / "j1" / "takes"
    takes.mkdir(parents=True)
    old_unref, old_ref, new_unref = takes / "s0000_r1_t1.wav", takes / "s0000_r1_t2.wav", takes / "s0001_r1_t1.wav"
    for p in (old_unref, old_ref, new_unref):
        p.write_bytes(b"x")
    eight_days_ago = time.time() - 8 * 86400
    for p in (old_unref, old_ref):
        os.utime(p, (eight_days_ago, eight_days_ago))
    final = tmp_path / "jobs" / "j1" / "r1" / "final.wav"
    final.parent.mkdir()
    final.write_bytes(b"x")
    os.utime(final, (eight_days_ago, eight_days_ago))
    assert purge_unreferenced_takes(tmp_path, {str(old_ref)}) == 1
    assert not old_unref.exists() and old_ref.exists() and new_unref.exists() and final.exists()


def test_free_gb_is_positive(tmp_path):
    assert free_gb(tmp_path) > 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_callbacks_retention.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.callbacks'`.

- [ ] **Step 3: Implement callbacks and retention**

`engine/lq_tts_engine/callbacks.py`:
```python
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from collections.abc import Callable

import httpx

RETRY_DELAYS_S = (1, 5, 30, 120, 300)
log = logging.getLogger("lq_tts_engine.callbacks")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign(secret, timestamp, body), signature)


class CallbackSender:
    def __init__(self, secrets: dict[str, str], *, delays: tuple[int, ...] = RETRY_DELAYS_S,
                 client_factory: Callable[[], httpx.Client] = lambda: httpx.Client(timeout=10),
                 sleep: Callable[[float], None] = time.sleep):
        self.secrets = secrets
        self.delays = delays
        self.client_factory = client_factory
        self.sleep = sleep

    def send(self, caller: str, url: str, payload: dict) -> threading.Thread:
        thread = threading.Thread(target=self.deliver, args=(caller, url, payload), daemon=True)
        thread.start()
        return thread

    def deliver(self, caller: str, url: str, payload: dict) -> bool:
        body = json.dumps(payload, separators=(",", ":")).encode()
        for delay in (0, *self.delays):
            if delay:
                self.sleep(delay)
            timestamp = str(int(time.time()))
            headers = {"Content-Type": "application/json", "X-LQ-Timestamp": timestamp,
                       "X-LQ-Signature": sign(self.secrets[caller], timestamp, body)}
            try:
                with self.client_factory() as client:
                    response = client.post(url, content=body, headers=headers)
                if 200 <= response.status_code < 300:
                    return True
            except httpx.HTTPError:
                pass
        log.warning("callback dropped after retries", extra={"ctx": {"url": url, "payload": payload}})
        return False
```

`engine/lq_tts_engine/retention.py`:
```python
from __future__ import annotations

import shutil
import time
from pathlib import Path

SEVEN_DAYS_S = 7 * 24 * 3600


def purge_unreferenced_takes(data_dir: Path, referenced: set[str], *, older_than_s: float = SEVEN_DAYS_S,
                             now: float | None = None) -> int:
    now = time.time() if now is None else now
    removed = 0
    for path in (data_dir / "jobs").glob("*/takes/*.wav"):
        if str(path) in referenced or now - path.stat().st_mtime < older_than_s:
            continue
        path.unlink()
        removed += 1
    return removed


def free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1e9
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_callbacks_retention.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/callbacks.py lq_tts_engine/retention.py tests/test_callbacks_retention.py
git commit -m "engine: signed callbacks with retries, take retention"
```

---

### Task 11: API — app factory, auth, errors, voices, health

**Files:**
- Create: `engine/lq_tts_engine/api/app.py`
- Test: `engine/tests/test_api_voices.py`

**Interfaces:**
- Consumes: `Config` (Task 1), `Repo` (Tasks 6–7), `free_gb` (Task 10), `job_dir/revision_dir/latest_revision` (Task 9).
- Produces: `create_app(cfg: Config, repo: Repo, *, sse_poll_s: float = 1.0) -> FastAPI`; `app_from_env() -> FastAPI`; module constants `MAX_TEXT_CHARS = 20_000`, `MAX_UPLOAD_BYTES = 200 * 1024 * 1024`; error body `{"error": {"code", "message"}}`. Test helper fixture `client` (TestClient) and `cfg`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_api_voices.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_voices.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.api.app'`.

- [ ] **Step 3: Implement the API foundation and voice endpoints**

`engine/lq_tts_engine/api/app.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_voices.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/api/app.py tests/test_api_voices.py
git commit -m "engine: API foundation, auth, errors, voice endpoints, health"
```

---

### Task 12: API — jobs, sentences, files, live events, regenerate, cancel, delete

**Files:**
- Modify: `engine/lq_tts_engine/api/app.py` (replace the `register_job_routes` stub)
- Test: `engine/tests/test_api_jobs.py`

**Interfaces:**
- Consumes: Task 11 app internals (`ApiError`, `JobIn`, `RegenerateIn`, `_sse`, `FILE_TYPES`, constants), `split_script`, `is_single_sentence`, `JobSettings`, `run_job`/`Deps` (tests only).
- Produces: routes `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/sentences`, `GET /v1/jobs/{id}/sentences/{idx}/audio.wav`, `GET /v1/jobs/{id}/events`, `POST /v1/jobs/{id}/sentences/{idx}/regenerate`, `POST /v1/jobs/{id}/cancel`, `DELETE /v1/jobs/{id}`, `GET /v1/jobs/{id}/files/{name}`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_api_jobs.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_jobs.py -q`
Expected: FAIL — e.g. `assert 404 == 202` on `POST /v1/jobs` (routes not registered yet).

- [ ] **Step 3: Replace the `register_job_routes` stub in `engine/lq_tts_engine/api/app.py`**

```python
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

    @app.post("/v1/jobs", status_code=202)
    def create_job(body: JobIn, who: Caller, idempotency_key: Annotated[str | None, Header()] = None) -> dict:
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
        voice = own_voice(who, body.voice_id)
        if voice["status"] != "ready":
            raise ApiError(409, "voice_not_ready", f"voice is {voice['status']}")
        units = split_script(text)
        if not units:
            raise ApiError(400, "invalid_text", "no sentences found")
        job, _ = repo.create_job(caller=who, voice_id=body.voice_id, text=text, settings=settings.model_dump(),
                                 callback_url=body.callback_url, idempotency_key=idempotency_key, units=units)
        return {"id": str(job["id"]), "sentences_total": len(repo.list_sentences(job["id"])),
                "estimated_seconds": estimate_seconds(job)}

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_jobs.py tests/test_api_voices.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/api/app.py tests/test_api_jobs.py
git commit -m "engine: job endpoints, files, live events, regenerate, cancel, delete"
```

---

### Task 13: Worker process and pm2 config

**Files:**
- Create: `engine/lq_tts_engine/worker.py`, `engine/ecosystem.config.cjs`
- Test: `engine/tests/test_worker.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `LEASE_S = 60`, `RENEW_S = 15`; `handle_voice(voice: dict, deps: Deps) -> None`; `handle_job(job: dict, deps: Deps, callbacks: CallbackSender, *, device: str) -> None` (exits the process with code 3 on GPU/MPS errors); `main() -> None`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/test_worker.py`:
```python
import uuid

import numpy as np
import pytest
import soundfile as sf

from lq_tts_engine.pipeline import Deps, job_dir
from lq_tts_engine.text.split import split_script
from lq_tts_engine.worker import handle_job, handle_voice
from tests.fakes import FakeTranscriber, ToneSynth
from tests.test_voiceprep import steady_words

TEXT = "Kalimat pertama di sini. Kalimat kedua di sini."


class Recorder:
    def __init__(self):
        self.sent = []

    def send(self, caller, url, payload):
        self.sent.append((caller, url, payload))


def make(repo, voice, tmp_path, synth=None, callback_url="http://app.local/cb"):
    units = split_script(TEXT)
    repo.create_job(caller="lq-tts", voice_id=voice["id"], text=TEXT, settings={}, callback_url=callback_url,
                    idempotency_key=None, units=units)
    deps = Deps(repo=repo, synth=synth or ToneSynth(),
                asr=FakeTranscriber(sentence_texts={u.idx: u.text for u in units}), data_dir=tmp_path / "data")
    return deps, repo.claim_job()


def test_done_job_sends_callback(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path)
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    assert rec.sent == [("lq-tts", "http://app.local/cb", {"job_id": str(job["id"]), "status": "done", "revision": 1})]


def test_unexpected_error_fails_job_and_reports(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=ValueError("boom")))
    rec = Recorder()
    handle_job(job, deps, rec, device="cpu")
    j = repo.get_job_any(job["id"])
    assert (j["status"], j["error_code"]) == ("failed", "internal_error")
    assert rec.sent[0][2]["status"] == "failed"


def test_silent_synthesis_fails_job_as_synthesis_failed(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(silent_takes=99))
    handle_job(job, deps, Recorder(), device="cpu")
    assert repo.get_job_any(job["id"])["error_code"] == "synthesis_failed"


def test_device_error_exits_for_pm2_restart_and_leaves_job_for_recovery(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path, synth=ToneSynth(fail_with=RuntimeError("MPS backend out of memory")))
    with pytest.raises(SystemExit) as exc:
        handle_job(job, deps, Recorder(), device="mps")
    assert exc.value.code == 3
    assert repo.get_job_any(job["id"])["status"] == "running"


def test_cancel_marks_canceled_and_delete_purges_files(repo, ready_voice, tmp_path):
    deps, job = make(repo, ready_voice, tmp_path)
    repo.request_cancel("lq-tts", job["id"])
    handle_job(job, deps, Recorder(), device="cpu")
    assert repo.get_job_any(job["id"])["status"] == "canceled"

    deps2, job2 = make(repo, ready_voice, tmp_path)
    job_dir(deps2.data_dir, job2["id"]).mkdir(parents=True)
    repo.delete_job("lq-tts", job2["id"])
    rec = Recorder()
    handle_job(job2, deps2, rec, device="cpu")
    assert repo.get_job_any(job2["id"]) is None and not job_dir(deps2.data_dir, job2["id"]).exists()
    assert rec.sent == []


def _voice(repo, tmp_path, seconds, words):
    src = tmp_path / f"src-{uuid.uuid4().hex}.wav"
    t = np.arange(int(seconds * 48000)) / 48000
    sf.write(src, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000)
    vid = uuid.uuid4()
    repo.create_voice(vid, "lq-tts", "u", "Pandji", None, str(src), None)
    deps = Deps(repo=repo, synth=ToneSynth(), asr=FakeTranscriber(voice_words=words, duration=seconds),
                data_dir=tmp_path / "data")
    return vid, deps


def test_handle_voice_ready_and_failed(repo, tmp_path):
    vid, deps = _voice(repo, tmp_path, 30.0, steady_words(2.0, 16.0, gap=0.3))
    handle_voice(repo.get_voice_any(vid), deps)
    v = repo.get_voice_any(vid)
    assert v["status"] == "ready" and (deps.data_dir / "voices" / str(vid) / "ref.wav").exists()

    vid2, deps2 = _voice(repo, tmp_path, 6.0, steady_words(0.0, 5.0))
    handle_voice(repo.get_voice_any(vid2), deps2)
    v2 = repo.get_voice_any(vid2)
    assert (v2["status"], v2["error_code"]) == ("failed", "no_clean_speech")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_worker.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lq_tts_engine.worker'`.

- [ ] **Step 3: Implement the worker and pm2 config**

`engine/lq_tts_engine/worker.py`:
```python
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from .callbacks import CallbackSender
from .config import load_config
from .db import make_pool, migrate
from .pipeline import Deps, SynthesisFailed, job_dir, run_job
from .repo import Repo
from .retention import purge_unreferenced_takes
from .voiceprep import NoCleanSpeech, prepare_voice

LEASE_S, RENEW_S, PURGE_EVERY_S, IDLE_SLEEP_S = 60, 15, 3600, 1.0
log = logging.getLogger("lq_tts_engine.worker")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {"ts": round(record.created, 3), "level": record.levelname, "logger": record.name,
                   "msg": record.getMessage(), **getattr(record, "ctx", {})}
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def _is_device_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in text for marker in ("mps", "metal", "out of memory"))


class LeaseKeeper:
    """Renews the job lease and the worker heartbeat every RENEW_S seconds while a job runs."""

    def __init__(self, deps: Deps, job_id, device: str):
        self.deps, self.job_id, self.device = deps, job_id, device
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(RENEW_S):
            self.deps.repo.renew_lease(self.job_id, LEASE_S)
            self.deps.repo.heartbeat(model_loaded=True, device=self.device, rtf=self.deps.rolling_rtf())

    def __enter__(self) -> "LeaseKeeper":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()


def handle_voice(voice: dict, deps: Deps) -> None:
    ref = deps.data_dir / "voices" / str(voice["id"]) / "ref.wav"
    hint = voice["language"] if voice["language"] not in (None, "", "auto") else None
    ctx = {"ctx": {"voice": str(voice["id"])}}
    try:
        prepared = prepare_voice(Path(voice["source_path"]), ref, deps.asr,
                                 user_transcript=voice["user_transcript"], language=hint)
    except NoCleanSpeech:
        deps.repo.voice_failed(voice["id"], "no_clean_speech")
        log.info("voice failed: no clean speech", extra=ctx)
        return
    except subprocess.CalledProcessError:
        deps.repo.voice_failed(voice["id"], "unsupported_audio")
        log.info("voice failed: unreadable audio", extra=ctx)
        return
    deps.repo.voice_ready(voice["id"], ref_audio_path=str(ref), ref_transcript=prepared.transcript,
                          ref_seconds=prepared.ref_seconds, clip_start_s=prepared.clip_start_s,
                          clip_end_s=prepared.clip_end_s, language=prepared.language)
    log.info("voice ready", extra={"ctx": {**ctx["ctx"], "clip": [prepared.clip_start_s, prepared.clip_end_s]}})


def handle_job(job: dict, deps: Deps, callbacks: CallbackSender, *, device: str) -> None:
    repo = deps.repo
    ctx = {"ctx": {"job": str(job["id"]), "revision": job["revision"]}}
    log.info("job started", extra=ctx)
    try:
        with LeaseKeeper(deps, job["id"], device):
            outcome = run_job(job, deps, should_stop=lambda: repo.cancel_requested(job["id"]))
    except Exception as exc:  # noqa: BLE001 - classify and record every failure
        if _is_device_error(exc):
            log.exception("device error; exiting so pm2 restarts the worker", extra=ctx)
            sys.exit(3)
        log.exception("job failed", extra=ctx)
        repo.fail_job(job["id"], "synthesis_failed" if isinstance(exc, SynthesisFailed) else "internal_error")
        outcome = "failed"
    if outcome == "canceled":
        repo.mark_canceled(job["id"])
        fresh = repo.get_job_any(job["id"])
        if fresh is not None and fresh["deleted_at"] is not None:
            shutil.rmtree(job_dir(deps.data_dir, job["id"]), ignore_errors=True)
            repo.purge_job(job["id"])
            log.info("job deleted while running; purged", extra=ctx)
            return
    fresh = repo.get_job_any(job["id"])
    log.info("job finished", extra={"ctx": {**ctx["ctx"], "status": fresh["status"]}})
    if fresh["callback_url"]:
        callbacks.send(fresh["caller"], fresh["callback_url"],
                       {"job_id": str(fresh["id"]), "status": fresh["status"], "revision": fresh["revision"]})


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    cfg = load_config()
    migrate(cfg.database_url, cfg.schema)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    repo = Repo(make_pool(cfg.database_url, cfg.schema, max_size=4))
    repo.heartbeat(model_loaded=False, device=cfg.device, rtf=None)

    from .asr import WhisperTranscriber
    from .synth import VoxSynth

    log.info("loading models", extra={"ctx": {"device": cfg.device}})
    deps = Deps(repo=repo, synth=VoxSynth(cfg.device), asr=WhisperTranscriber(cfg.whisper_model),
                data_dir=cfg.data_dir)
    callbacks = CallbackSender(cfg.callback_secrets)
    log.info("worker ready")
    last_purge = 0.0
    while True:
        repo.heartbeat(model_loaded=True, device=cfg.device, rtf=deps.rolling_rtf())
        for row in repo.requeue_expired():
            log.warning("lease expired", extra={"ctx": {"job": str(row["id"]), "status": row["status"]}})
        if time.monotonic() - last_purge > PURGE_EVERY_S:
            removed = purge_unreferenced_takes(cfg.data_dir, repo.referenced_take_paths())
            log.info("purged takes", extra={"ctx": {"removed": removed}})
            last_purge = time.monotonic()
        voice = repo.next_voice_to_prepare()
        if voice is not None:
            handle_voice(voice, deps)
            continue
        job = repo.claim_job(LEASE_S)
        if job is not None:
            handle_job(job, deps, callbacks, device=cfg.device)
            continue
        time.sleep(IDLE_SLEEP_S)


if __name__ == "__main__":
    main()
```

`engine/ecosystem.config.cjs`:
```js
const path = require("path");

const dir = __dirname;
const python = path.join(dir, ".venv/bin/python");

module.exports = {
  apps: [
    {
      name: "lq-tts-engine-api",
      cwd: dir,
      script: python,
      args: "-m uvicorn lq_tts_engine.api.app:app_from_env --factory --host 127.0.0.1 --port 8740",
      interpreter: "none",
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      env: { PYTHONUNBUFFERED: "1" },
    },
    {
      name: "lq-tts-engine-worker",
      cwd: dir,
      script: python,
      args: "-m lq_tts_engine.worker",
      interpreter: "none",
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 30000,
      env: { PYTHONUNBUFFERED: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1" },
    },
  ],
};
```

- [ ] **Step 4: Run tests to verify they pass, then the whole fast suite**

Run: `uv run pytest tests/test_worker.py -q && uv run pytest -q`
Expected: all PASS; full fast suite green.

- [ ] **Step 5: Commit**

```bash
git add lq_tts_engine/worker.py ecosystem.config.cjs tests/test_worker.py
git commit -m "engine: worker loop with lease renewal, recovery, callbacks; pm2 config"
```

---

### Task 14: Real-model slow tests, pm2 start, end-to-end smoke

**Files:**
- Create: `engine/tests/test_slow_real.py`, `engine/scripts/e2e_smoke.py`
- Data (not committed): `~/Developer/LQ-TTS/data/fixtures/pandji/{ref.wav,ref.txt,VO-Sample-Pandji.mp3,script_1min.txt}`

**Interfaces:**
- Consumes: `VoxSynth`, `WhisperTranscriber`, `Deps`, `run_job`, `measure_lufs`, the running pm2 service.

- [ ] **Step 1: Copy the Pandji fixtures onto mac-studio** (run on lq-server, which can reach both the macbook and mac-studio over SSH)

```bash
mkdir -p /tmp/pandji-fx && cd /tmp/pandji-fx
scp -q macbook:Downloads/TTS-NextGen/reference-voice/Pandji/Pandji_ref.wav ref.wav
scp -q macbook:Downloads/TTS-NextGen/reference-voice/Pandji/Pandji_ref_transcript.txt ref.txt
scp -q macbook:Downloads/VO-Sample-Pandji.mp3 VO-Sample-Pandji.mp3
scp -q macbook:Downloads/TTS-NextGen/VoxCPM2/Pandji/Pandji_1min_topic_script.txt topic.txt
sed -n '/^SCRIPT$/,$p' topic.txt | tail -n +2 > script_1min.txt
ssh mac-studio 'mkdir -p ~/Developer/LQ-TTS/data/fixtures/pandji'
scp -q ref.wav ref.txt VO-Sample-Pandji.mp3 script_1min.txt mac-studio:Developer/LQ-TTS/data/fixtures/pandji/
cd / && rm -rf /tmp/pandji-fx
```
Expected on mac-studio: `ls ~/Developer/LQ-TTS/data/fixtures/pandji` lists the 4 files.

- [ ] **Step 2: Write the slow test**

`engine/tests/test_slow_real.py`:
```python
from pathlib import Path

import pytest

from lq_tts_engine.asr import WhisperTranscriber
from lq_tts_engine.audio.finish import measure_lufs
from lq_tts_engine.pipeline import Deps, revision_dir, run_job
from lq_tts_engine.synth import VoxSynth
from lq_tts_engine.text.split import split_script

pytestmark = pytest.mark.slow
FIX = Path("~/Developer/LQ-TTS/data/fixtures/pandji").expanduser()
TEXT = (
    "Coba jujur deh, berapa kali lo ngecek HP hari ini? Tenang, lo nggak sendirian kok. "
    "Jalan dulu dua puluh menit, mikir belakangan.\n\n"
    "This is how you take back control of your focus."
)


@pytest.fixture(scope="module")
def models():
    return VoxSynth("mps"), WhisperTranscriber("small")


def test_real_voice_pipeline_meets_quality_bar(repo, models, tmp_path):
    import uuid

    synth, asr = models
    vid = uuid.uuid4()
    repo.create_voice(vid, "lq-tts", "slow", "Pandji", "id", str(FIX / "ref.wav"), None)
    repo.voice_ready(vid, ref_audio_path=str(FIX / "ref.wav"), ref_transcript=(FIX / "ref.txt").read_text().strip(),
                     ref_seconds=14.25, clip_start_s=0.0, clip_end_s=14.25, language="id")
    units = split_script(TEXT)
    assert len(units) == 4
    repo.create_job(caller="lq-tts", voice_id=vid, text=TEXT, settings={}, callback_url=None, idempotency_key=None,
                    units=units)
    deps = Deps(repo=repo, synth=synth, asr=asr, data_dir=tmp_path / "data")
    job = repo.claim_job()
    assert run_job(job, deps, should_stop=lambda: False) == "done"
    sentences = repo.list_sentences(job["id"])
    assert all(s["score"] >= 0.85 for s in sentences), [(s["text"], s["asr_text"], s["score"]) for s in sentences]
    out = revision_dir(deps.data_dir, job["id"], 1)
    assert abs(measure_lufs(out / "final.wav") + 14.0) <= 1.0
    assert (out / "subs.srt").read_text().count(" --> ") == len(sentences)
```

- [ ] **Step 3: Run the slow test on the real model**

Run: `uv run pytest -m slow -q -s`
Expected: PASS (first run downloads Whisper `small`; total a few minutes). If a sentence scores < 0.85, the assertion message shows text vs transcript — investigate with superpowers:systematic-debugging before changing thresholds.

- [ ] **Step 4: Write the end-to-end smoke script**

`engine/scripts/e2e_smoke.py`:
```python
"""End-to-end check against the running pm2 service.

Usage: uv run python scripts/e2e_smoke.py --audio <file> --script <file> --out <dir>
Reads the lq-tts token from engine/.env.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

from lq_tts_engine.config import load_config

BASE = "http://127.0.0.1:8740"


def wait(client: httpx.Client, url: str, done: set[str], timeout_s: float) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(url).raise_for_status().json()
        if body["status"] in done:
            return body
        time.sleep(2)
    raise TimeoutError(url)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", type=Path, required=True)
    ap.add_argument("--script", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    token = next(t for t, caller in load_config().tokens.items() if caller == "lq-tts")
    args.out.mkdir(parents=True, exist_ok=True)

    with httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=120) as c:
        print("health:", c.get("/v1/health").json())
        with args.audio.open("rb") as fh:
            voice = c.post("/v1/voices", data={"name": "Pandji", "owner_ref": "e2e", "language": "id"},
                           files={"audio": (args.audio.name, fh, "audio/mpeg")}).raise_for_status().json()
        voice = wait(c, f"/v1/voices/{voice['id']}", {"ready", "failed"}, 900)
        print("voice:", json.dumps({k: voice[k] for k in ("status", "clip_start_s", "clip_end_s", "ref_transcript")},
                                   ensure_ascii=False))
        assert voice["status"] == "ready"

        job = c.post("/v1/jobs", json={"voice_id": voice["id"], "text": args.script.read_text()}).raise_for_status().json()
        print("job:", job)
        t0 = time.monotonic()
        final = wait(c, f"/v1/jobs/{job['id']}", {"done", "failed", "canceled"}, 1800)
        print(f"job done in {time.monotonic() - t0:.0f}s:", {k: final[k] for k in ("status", "revision", "audio_seconds", "needs_review")})
        assert final["status"] == "done"
        for name, url in final["files"].items():
            (args.out / f"r1-{name}").write_bytes(c.get(url).raise_for_status().content)

        regen = c.post(f"/v1/jobs/{job['id']}/sentences/9/regenerate", json={}).raise_for_status().json()
        assert regen == {"revision": 2}, regen
        final2 = wait(c, f"/v1/jobs/{job['id']}", {"done", "failed"}, 600)
        assert final2["status"] == "done" and final2["revision"] == 2
        (args.out / "r2-final.mp3").write_bytes(c.get(final2["files"]["final.mp3"]).raise_for_status().content)
        print("files:", sorted(p.name for p in args.out.iterdir()))


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Start the service under pm2 and check health**

```bash
pm2 start ecosystem.config.cjs && pm2 save
sleep 120
curl -s http://127.0.0.1:8740/v1/health
pm2 logs lq-tts-engine-worker --lines 20 --nostream
```
Expected: health JSON with `"model_loaded": true`, `"device": "mps"`; worker log shows `worker ready`. Only the two `lq-tts-engine-*` apps were added (`pm2 jlist` count +2, all other apps unchanged).

- [ ] **Step 6: Run the end-to-end smoke**

```bash
uv run python scripts/e2e_smoke.py --audio ../data/fixtures/pandji/VO-Sample-Pandji.mp3 \
  --script ../data/fixtures/pandji/script_1min.txt --out ../data/e2e
```
Expected: voice `ready` with a 10–20 s clip; job `done` with `audio_seconds` ≈ 70–80; files `r1-final.mp3`, `r1-final.wav`, `r1-subs.srt`, `r1-subs.vtt`, `r2-final.mp3`.

- [ ] **Step 7: Verify the output like on 2026-10-02 (Whisper transcript + join check)**

```bash
uv run python - <<'EOF'
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
from lq_tts_engine.qa import score
script = open("../data/fixtures/pandji/script_1min.txt").read()
m = WhisperModel("small", device="cpu", compute_type="int8")
segs, _ = m.transcribe("../data/e2e/r1-final.wav", language="id")
heard = " ".join(s.text.strip() for s in segs)
print("whole-script score:", round(score(script, heard), 3))
x, sr = sf.read("../data/e2e/r1-final.wav", dtype="float32")
hop = sr // 100
db = 20 * np.log10(np.sqrt((x[: len(x) // hop * hop].reshape(-1, hop) ** 2).mean(1)) + 1e-9)
gaps, run = [], 0
for v in db < -60:
    if v: run += 1
    elif run: gaps.append(run / 100); run = 0
print("silent gaps >= 0.3 s:", [g for g in gaps if g >= 0.3])
EOF
ffmpeg -loglevel error -y -ss 0 -to 8 -i ../data/e2e/r1-final.wav -lavfi "showspectrumpic=s=1100x260:legend=1:scale=log:stop=8000" ../data/e2e/joins.png
```
Expected: whole-script score ≥ 0.85; silent gaps cluster at ~0.45 s and ~0.80 s (loudnorm keeps digital silence silent). Open `joins.png`: each gap is clean black with speech fading in/out — no slivers.

- [ ] **Step 8: Commit**

```bash
git add tests/test_slow_real.py scripts/e2e_smoke.py
git commit -m "engine: real-model slow test and end-to-end smoke script"
```

---

## Self-Review (done while writing)

- **Spec coverage:** §2.1 steps 1–9 → Tasks 2, 3, 4, 5, 9 · §2.2 settings → Task 1 · §2.3 voice prep → Tasks 8, 13 · §3 data model → Tasks 6–7 · §4 endpoints, limits, estimate, idempotency, callback, errors → Tasks 10–12 · §5 recovery items 1–9 → Tasks 7, 9, 10, 13 · §6 testing levels 1–6 → Tasks 1–14 (regressions in Tasks 3 and 4; slow + e2e in Task 14).
- **Placeholders:** none; every code step has full code.
- **Type consistency:** `Repo` method names/signatures in Tasks 6–7 match their use in Tasks 9, 11–13; `Deps(repo, synth, asr, data_dir)` identical everywhere; take file pattern `s{idx:04d}_r{rev}_t{take}.wav` matches `FakeTranscriber`'s regex; `handle_job(job, deps, callbacks, *, device)` matches tests.
