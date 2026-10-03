import os
from pathlib import Path

import pytest
import soundfile as sf

from lq_tts_engine.asr import WhisperTranscriber
from lq_tts_engine.audio.finish import measure_lufs
from lq_tts_engine.pipeline import Deps, revision_dir, run_job
from lq_tts_engine.synth import VoxSynth
from lq_tts_engine.text.split import split_script

pytestmark = pytest.mark.slow
FIX = Path(os.environ.get("LQTTS_SLOW_FIXTURES", "~/Developer/LQ-TTS/data/fixtures/pandji")).expanduser()
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
    ref = FIX / "ref.wav"
    ref_seconds = sf.info(str(ref)).duration
    repo.create_voice(vid, "lq-tts", "slow", FIX.name, "id", str(ref), None)
    repo.voice_ready(vid, ref_audio_path=str(ref), ref_transcript=(FIX / "ref.txt").read_text().strip(),
                     ref_seconds=ref_seconds, clip_start_s=0.0, clip_end_s=ref_seconds, language="id")
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
