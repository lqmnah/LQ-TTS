from types import SimpleNamespace

import numpy as np
import pytest

from lq_tts_engine.synth import AdapterLoadFailed, AdapterSwitch, VoiceRef, VoxSynth

MODULES = {"lm.q", "lm.v", "dit.q", "dit.v"}  # LoRA tensors the fake model has


class FakeLoraModel:
    """Holds LoRA tensors the way voxcpm does: load_lora copies only the tensors a checkpoint has (skipping names the
    model lacks instead of raising), unload_lora resets every tensor, set_lora_enabled toggles their scaling.
    `adapters` maps a path to its tensors; paths in `bad` raise on load."""

    def __init__(self, adapters=None, bad=()):
        self.adapters = adapters or {}
        self.bad = set(bad)
        self.tensors: dict[str, str] = {}  # module -> name of the adapter whose values it holds; absent = reset
        self.enabled = None
        self.loads: list[str] = []

    def load_lora(self, path):
        self.loads.append(path)
        if path in self.bad:
            raise FileNotFoundError(path)
        names = self.adapters.get(path, MODULES)
        loaded = [n for n in names if n in MODULES]
        for n in loaded:
            self.tensors[n] = path
        return loaded, [n for n in names if n not in MODULES]

    def unload_lora(self):
        self.tensors = {}

    def set_lora_enabled(self, enabled):
        self.enabled = enabled


class FakeVox(FakeLoraModel):
    """A loaded VoxCPM2 instance: counts generate() calls."""

    tts_model = SimpleNamespace(sample_rate=48000)

    def __init__(self):
        super().__init__()
        self.generated = 0

    def generate(self, **kw):
        self.generated += 1
        return np.zeros(480, dtype=np.float32)


def synth_with_fake_loader():
    built = []

    def load(device, lora):
        built.append(lora)
        return FakeVox()

    return VoxSynth("cpu", load=load), built


def test_voices_without_adapter_never_build_the_lora_instance():
    synth, built = synth_with_fake_loader()
    synth.generate("halo", VoiceRef("/ref.wav", "halo"), None)
    assert built == [False] and synth.model.generated == 1


def test_adapter_voices_share_one_lora_instance_and_base_voices_keep_the_plain_model():
    synth, built = synth_with_fake_loader()
    with_adapter, plain = VoiceRef("/ref.wav", "halo", "/a"), VoiceRef("/ref.wav", "halo")
    for voice in (with_adapter, plain, with_adapter):
        synth.generate("halo", voice, None)
    assert built == [False, True]  # the LoRA instance is built once, on the first adapter job
    assert synth.model.generated == 1  # the base voice ran on the plain model: no LoRA cost for it
    assert (synth.adapters.model.generated, synth.adapters.model.loads) == (2, ["/a"])


def test_lora_instance_that_fails_to_build_is_retried_on_the_next_adapter_job():
    built = []

    def load(device, lora):
        built.append(lora)
        if lora and built.count(True) == 1:
            raise RuntimeError("build failed")
        return FakeVox()

    synth = VoxSynth("cpu", load=load)
    voice = VoiceRef("/ref.wav", "halo", "/a")
    with pytest.raises(RuntimeError, match="build failed"):
        synth.prepare(voice)
    synth.generate("halo", voice, None)
    assert built == [False, True, True] and synth.adapters.model.generated == 1


def test_adapter_stays_loaded_across_its_jobs():
    model = FakeLoraModel()
    sw = AdapterSwitch(model)
    for _ in range(3):
        sw.use("/a")
    assert model.loads == ["/a"] and model.enabled is True


def test_switching_to_an_adapter_with_fewer_tensors_keeps_none_of_the_old_ones():
    model = FakeLoraModel(adapters={"/b": {"lm.q", "lm.v"}})
    sw = AdapterSwitch(model)
    sw.use("/a")
    sw.use("/b")
    assert model.tensors == {"lm.q": "/b", "lm.v": "/b"}  # the DiT tensors must not keep /a's values
    assert model.enabled is True and sw.active == "/b"


def test_failed_load_resets_the_tensors_and_is_retried_next_time():
    model = FakeLoraModel(bad={"/a"})
    sw = AdapterSwitch(model)
    with pytest.raises(AdapterLoadFailed, match="/a"):
        sw.use("/a")
    assert (model.tensors, model.enabled) == ({}, False)
    model.bad.clear()
    sw.use("/a")
    assert model.loads == ["/a", "/a"] and model.enabled is True


def test_adapter_whose_tensors_do_not_fit_is_never_enabled():
    model = FakeLoraModel(adapters={"/a": {"lm.q", "lm.k"}})
    sw = AdapterSwitch(model)
    with pytest.raises(AdapterLoadFailed, match="1 do not fit"):
        sw.use("/a")
    assert (model.tensors, model.enabled) == ({}, False)


def test_failure_while_switching_away_forgets_the_old_adapter():
    model = FakeLoraModel(bad={"/b"})
    sw = AdapterSwitch(model)
    sw.use("/a")
    with pytest.raises(AdapterLoadFailed):
        sw.use("/b")
    sw.use("/a")  # /b's failed load reset the tensors, so /a must be loaded again, not trusted from the cache
    assert model.loads == ["/a", "/b", "/a"] and model.tensors == dict.fromkeys(MODULES, "/a")
