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
