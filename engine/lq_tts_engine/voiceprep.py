from __future__ import annotations

from bisect import bisect_left
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .asr import Transcriber, Word


class NoCleanSpeech(Exception):
    """No continuous clean speech of at least 8 s in the upload."""


@dataclass(frozen=True)
class Clip:
    start_s: float
    end_s: float
    transcript: str
    prev_word_end_s: float | None = None
    next_word_start_s: float | None = None


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
    runs: list[tuple[int, list[Word]]] = []  # (index of the run's first word in `words`, run)
    current, offset = [words[0]], 0
    for k, (prev, word) in enumerate(zip(words, words[1:]), start=1):
        if word.start - prev.end > max_gap_s:
            runs.append((offset, current))
            current, offset = [word], k
        else:
            current.append(word)
    runs.append((offset, current))

    best: tuple[int, int] | None = None  # inclusive indices into `words`
    best_key: tuple | None = None
    for offset, run in runs:
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
                    best, best_key = (offset + i, offset + j), key
    if best is None:
        if cut_gap_s > 0:
            return select_clip(words, duration, min_s=min_s, max_s=max_s, max_gap_s=max_gap_s, cut_gap_s=0.0,
                               min_ok_s=min_ok_s, pad_s=pad_s)
        return None
    first, last = best
    return Clip(max(0.0, words[first].start - pad_s), min(duration, words[last].end + pad_s),
                " ".join(w.text for w in words[first:last + 1]).strip(),
                prev_word_end_s=words[first - 1].end if first > 0 else None,
                next_word_start_s=words[last + 1].start if last + 1 < len(words) else None)


def snap_to_silence(x: np.ndarray, sr: int, start_s: float, end_s: float, *, search_before_s: float,
                    search_after_s: float, quiet_db: float = -45.0, min_quiet_s: float = 0.05,
                    rel_db: float = 20.0) -> tuple[float, float]:
    """Move clip edges into the nearest real pause.

    A pause is a run of sliding `min_quiet_s` windows (10 ms step) whose RMS is at most the clip's median
    speech level minus `rel_db` (uploads often carry a music/room bed) or below the absolute floor `quiet_db`.
    Median speech level = median of the clip's 10 ms frame levels above their own 30th percentile.
    The end moves forward to the middle of the first such run within `search_after_s`; the start moves
    backward to the middle of the nearest run within `search_before_s`. No run found: edge kept.
    """
    if x.ndim > 1:
        x = x.mean(axis=1)
    hop = sr // 100
    n = len(x) // hop
    power = (x[:n * hop].reshape(n, hop).astype(np.float64) ** 2).mean(axis=1)
    need = max(1, round(min_quiet_s * 100))
    if n < need:
        return start_s, end_s

    def frame(t: float) -> int:
        return min(n, max(0, int(t * 100 + 1e-6)))

    clip_db = 10 * np.log10(power[frame(start_s):frame(end_s)] + 1e-18)
    if clip_db.size:
        speech = clip_db[clip_db > np.percentile(clip_db, 30)]
        relative = float(np.median(speech if speech.size else clip_db)) - rel_db
    else:
        relative = -np.inf
    window_db = 10 * np.log10(np.convolve(power, np.ones(need) / need, "valid") + 1e-18)
    quiet = (window_db <= relative) | (window_db < quiet_db)  # quiet[k]: window over frames k .. k+need-1

    def first_run(ks: range) -> tuple[int, int] | None:
        """First contiguous run of quiet windows in scan order, as a frame span [lo, hi)."""
        found: list[int] = []
        for k in ks:
            if quiet[k]:
                found.append(k)
            elif found:
                break
        return (min(found), max(found) + need) if found else None

    a, b = frame(end_s), frame(end_s + max(0.0, search_after_s))
    after = first_run(range(a, b - need + 1))
    a, b = frame(start_s - max(0.0, search_before_s)), frame(start_s)
    before = first_run(range(b - need, a - 1, -1))
    new_end = (after[0] + after[1]) / 200 if after else end_s
    new_start = (before[0] + before[1]) / 200 if before else start_s
    return new_start, new_end


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
        if transcript.duration <= 20.0:
            text = (user_transcript or "").strip() or " ".join(w.text for w in transcript.words).strip()
            clip = Clip(0.0, transcript.duration, text)
        else:
            x, sr = sf.read(full, dtype="float32")
            next_start = clip.next_word_start_s if clip.next_word_start_s is not None else transcript.duration
            prev_end = clip.prev_word_end_s if clip.prev_word_end_s is not None else 0.0
            start_s, end_s = snap_to_silence(x, sr, clip.start_s, clip.end_s,
                                             search_before_s=max(0.0, min(1.0, clip.start_s - prev_end)),
                                             search_after_s=max(0.0, min(1.0, next_start - clip.end_s)))
            clip = Clip(start_s, end_s, clip.transcript)
        ref_out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(full),
                        "-ss", f"{clip.start_s:.3f}", "-to", f"{clip.end_s:.3f}",
                        "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse",
                        "-c:a", "pcm_s16le", str(ref_out)], check=True)
    return PreparedVoice(clip.end_s - clip.start_s, clip.start_s, clip.end_s, clip.transcript, transcript.language)
