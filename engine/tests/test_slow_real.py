import os
from pathlib import Path

import pytest
import soundfile as sf

from lq_tts_engine.asr import WhisperTranscriber
from lq_tts_engine.audio.finish import measure_lufs
from lq_tts_engine.config import LORA_SHAPE
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


LORA = os.environ.get("LQTTS_SLOW_LORA")  # a VoxCPM LoRA checkpoint dir trained with config.LORA_SHAPE


def lora_scalings(synth) -> set[float]:
    """The scaling every LoRA layer of the real model applies right now (alpha/r when enabled, 0 when disabled)."""
    return {float(m.scaling) for m in synth.model.tts_model.modules() if hasattr(m, "set_enabled")}


@pytest.mark.skipif(not LORA, reason="set LQTTS_SLOW_LORA to a LoRA checkpoint dir")
def test_adapter_voice_and_base_voice_share_one_model(repo, models, tmp_path):
    import uuid

    import torch
    from safetensors.torch import load_file

    synth, asr = models
    ref = FIX / "ref.wav"
    ref_seconds = sf.info(str(ref)).duration
    deps = Deps(repo=repo, synth=synth, asr=asr, data_dir=tmp_path / "data")
    text = "Jawaban singkatnya: ya. Dan putusan pengadilan menegaskannya dua kali."
    for adapter in (LORA, None, LORA):
        vid = uuid.uuid4()
        repo.create_voice(vid, "lq-tts", "slow", FIX.name, "id", str(ref), None)
        repo.voice_ready(vid, ref_audio_path=str(ref), ref_transcript=(FIX / "ref.txt").read_text().strip(),
                         ref_seconds=ref_seconds, clip_start_s=0.0, clip_end_s=ref_seconds, language="id")
        if adapter:
            assert repo.set_voice_adapter(vid, adapter)
        repo.create_job(caller="lq-tts", voice_id=vid, text=text, settings={}, callback_url=None,
                        idempotency_key=None, units=split_script(text))
        job = repo.claim_job()
        assert run_job(job, deps, should_stop=lambda: False) == "done"
        sentences = repo.list_sentences(job["id"])
        assert all(s["score"] >= 0.85 for s in sentences), [(s["text"], s["asr_text"], s["score"]) for s in sentences]
        assert synth.adapters.active == LORA  # a base-voice job only disables the adapter; it stays loaded
        assert lora_scalings(synth) == ({LORA_SHAPE["alpha"] / LORA_SHAPE["r"]} if adapter else {0.0})
    want = load_file(str(Path(LORA) / "lora_weights.safetensors"))
    got = synth.model.get_lora_state_dict()
    assert set(got) == set(want)  # the adapter covers every LoRA layer: none keeps another adapter's values
    assert all(torch.equal(got[k], want[k].to(got[k].device, got[k].dtype)) for k in want)
