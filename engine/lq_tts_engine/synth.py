from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .config import LORA_SHAPE


@dataclass(frozen=True)
class VoiceRef:
    ref_audio_path: str
    ref_transcript: str
    adapter_path: str | None = None


class Synthesizer(Protocol):
    sample_rate: int

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray: ...


class AdapterLoadFailed(Exception):
    """A voice's LoRA adapter could not be loaded. The model is back on its base weights, so other voices still work."""


class AdapterSwitch:
    """Holds at most one LoRA adapter in the model. A voice's adapter is loaded only when it is not the active one;
    a voice without an adapter runs on the base model (LoRA scaling 0) and leaves the active adapter loaded for the
    next job."""

    def __init__(self, model):
        self.model = model
        self.active: str | None = None
        model.set_lora_enabled(False)

    def use(self, adapter_path: str | None) -> None:
        if adapter_path is None:
            self.model.set_lora_enabled(False)
            return
        if adapter_path != self.active:
            self.active = None
            # load_lora copies only the tensors the checkpoint has: without a reset, any tensor the new adapter lacks
            # would keep the previous adapter's values.
            self.model.unload_lora()
            try:
                loaded, skipped = self.model.load_lora(adapter_path)
            except Exception as exc:  # noqa: BLE001 - a failed load may leave half-copied weights behind
                self._reset()
                raise AdapterLoadFailed(f"{adapter_path}: {type(exc).__name__}: {exc}") from exc
            if skipped or not loaded:
                # voxcpm skips tensors that do not fit instead of raising; a partial adapter must never be used.
                self._reset()
                raise AdapterLoadFailed(f"{adapter_path}: {len(loaded)} tensors loaded, {len(skipped)} do not fit")
            self.active = adapter_path
        self.model.set_lora_enabled(True)

    def _reset(self) -> None:
        self.model.unload_lora()
        self.model.set_lora_enabled(False)


class VoxSynth:
    """VoxCPM2 with prompt audio + transcript + reference audio (best cloning similarity), plus the voice's LoRA adapter
    when it has one. The model is built once with config.LORA_SHAPE, so every adapter must share that shape."""

    def __init__(self, device: str):
        from voxcpm import VoxCPM
        from voxcpm.model.voxcpm2 import LoRAConfig

        self.model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False, device=device,
                                            lora_config=LoRAConfig(**LORA_SHAPE, dropout=0.0))
        self.sample_rate = int(self.model.tts_model.sample_rate)
        self.adapters = AdapterSwitch(self.model)

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray:
        self.adapters.use(voice.adapter_path)
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
