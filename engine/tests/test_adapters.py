import pytest

from lq_tts_engine.synth import AdapterLoadFailed, AdapterSwitch

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


def test_voice_without_adapter_runs_on_the_base_model():
    model = FakeLoraModel()
    AdapterSwitch(model).use(None)
    assert model.enabled is False


def test_adapter_stays_loaded_across_its_jobs_and_base_jobs_in_between():
    model = FakeLoraModel()
    sw = AdapterSwitch(model)
    for path, enabled in (("/a", True), ("/a", True), (None, False), ("/a", True)):
        sw.use(path)
        assert model.enabled is enabled
    assert model.loads == ["/a"]


def test_switching_to_an_adapter_with_fewer_tensors_keeps_none_of_the_old_ones():
    model = FakeLoraModel(adapters={"/b": {"lm.q", "lm.v"}})
    sw = AdapterSwitch(model)
    sw.use("/a")
    sw.use("/b")
    assert model.tensors == {"lm.q": "/b", "lm.v": "/b"}  # the DiT tensors must not keep /a's values
    assert model.enabled is True and sw.active == "/b"


def test_failed_load_resets_to_base_and_is_retried_next_time():
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
