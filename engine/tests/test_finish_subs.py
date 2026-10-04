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


def test_cue_text_cannot_break_out_of_its_cue():
    cue = [Cue(0.0, 1.0, "a < b --> c & d\n\nnext")]
    assert to_srt(cue) == "1\n00:00:00,000 --> 00:00:01,000\na ‹ b --› c & d next\n\n"
    assert to_vtt(cue) == "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na &lt; b --&gt; c &amp; d next\n\n"
