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
