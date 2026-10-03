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
