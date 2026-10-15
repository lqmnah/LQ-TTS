from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np


@dataclass(frozen=True)
class VoiceRef:
    ref_audio_path: str
    ref_transcript: str


class Synthesizer(Protocol):
    sample_rate: int

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray: ...


class VoxSynth:
    """VoxCPM2 with prompt audio + transcript + reference audio (best cloning similarity)."""

    def __init__(self, device: str):
        from voxcpm import VoxCPM

        self.model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False, device=device)
        self.sample_rate = int(self.model.tts_model.sample_rate)

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray:
        prompt = f"({style}){text}" if style else text
        wav = self.model.generate(
            text=prompt,
            prompt_wav_path=voice.ref_audio_path,
            prompt_text=voice.ref_transcript,
            reference_wav_path=voice.ref_audio_path,
            cfg_value=2.0,
            inference_timesteps=10,
        )
        return np.asarray(wav, dtype=np.float32)
