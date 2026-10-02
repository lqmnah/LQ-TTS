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
