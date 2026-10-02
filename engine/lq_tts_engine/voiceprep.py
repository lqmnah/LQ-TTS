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
        if cut_gap_s > 0:
            return select_clip(words, duration, min_s=min_s, max_s=max_s, max_gap_s=max_gap_s, cut_gap_s=0.0,
                               min_ok_s=min_ok_s, pad_s=pad_s)
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
        if transcript.duration <= 20.0:
            text = (user_transcript or "").strip() or " ".join(w.text for w in transcript.words).strip()
            clip = Clip(0.0, transcript.duration, text)
        ref_out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(full),
                        "-ss", f"{clip.start_s:.3f}", "-to", f"{clip.end_s:.3f}",
                        "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse",
                        "-c:a", "pcm_s16le", str(ref_out)], check=True)
    return PreparedVoice(clip.end_s - clip.start_s, clip.start_s, clip.end_s, clip.transcript, transcript.language)
