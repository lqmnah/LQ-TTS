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
