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

    def prepare(self, voice: VoiceRef) -> None:
        """Set the model up for this voice (lazy LoRA build, adapter load) before any take is timed."""

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray: ...


class AdapterLoadFailed(Exception):
    """A voice's LoRA adapter could not be loaded. The LoRA model is back on base weights; other voices still work."""


class AdapterSwitch:
    """Holds at most one LoRA adapter in the LoRA model: a voice's adapter is loaded only when it is not active."""

    def __init__(self, model):
        self.model = model
        self.active: str | None = None

    def use(self, adapter_path: str) -> None:
        if adapter_path == self.active:
            return
        self.active = None
        # load_lora copies only the tensors the checkpoint has: without a reset, any tensor the new adapter lacks would
        # keep the previous adapter's values.
        self.model.unload_lora()
        try:
            loaded, skipped = self.model.load_lora(adapter_path)
        except Exception as exc:  # noqa: BLE001 - a failed load may leave half-copied weights behind
            self._reset()
            raise AdapterLoadFailed(f"{adapter_path}: {type(exc).__name__}: {exc}") from exc
        if skipped or not loaded:
            # voxcpm skips tensors whose names the model lacks instead of raising; never use a partial adapter.
            self._reset()
            raise AdapterLoadFailed(f"{adapter_path}: {len(loaded)} tensors loaded, {len(skipped)} do not fit")
        self.model.set_lora_enabled(True)
        self.active = adapter_path

    def _reset(self) -> None:
        self.model.unload_lora()
        self.model.set_lora_enabled(False)


def load_voxcpm(device: str, lora: bool):
    from voxcpm import VoxCPM
    from voxcpm.model.voxcpm2 import LoRAConfig

    # The LoRA instance is built mid-job from the snapshot the plain model was loaded from: no download, same weights.
    extra = {"lora_config": LoRAConfig(**LORA_SHAPE, dropout=0.0), "local_files_only": True} if lora else {}
    return VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False, device=device, **extra)


class VoxSynth:
    """VoxCPM2 with prompt audio + transcript + reference audio (best cloning similarity).

    Voices without an adapter run on the plain model, exactly as before adapters existed. LoRA layers compute their
    branch even at scale 0, which cost every voice ~25 % speed on MPS (16 Oct regression), so voices with an adapter
    run on a second instance built with config.LORA_SHAPE on the first adapter job."""

    def __init__(self, device: str, load=load_voxcpm):
        self._load = lambda lora: load(device, lora)
        self.model = self._load(False)
        self.sample_rate = int(self.model.tts_model.sample_rate)
        self.adapters: AdapterSwitch | None = None

    def _model_for(self, voice: VoiceRef):
        if voice.adapter_path is None:
            return self.model
        if self.adapters is None:
            self.adapters = AdapterSwitch(self._load(True))
        self.adapters.use(voice.adapter_path)
        return self.adapters.model

    def prepare(self, voice: VoiceRef) -> None:
        self._model_for(voice)

    def generate(self, text: str, voice: VoiceRef, style: str | None) -> np.ndarray:
        model = self._model_for(voice)
        prompt = f"({style}){text}" if style else text
        wav = model.generate(
            text=prompt,
            prompt_wav_path=voice.ref_audio_path,
            prompt_text=voice.ref_transcript,
            reference_wav_path=voice.ref_audio_path,
            cfg_value=2.0,
            inference_timesteps=10,
        )
        return np.asarray(wav, dtype=np.float32)
