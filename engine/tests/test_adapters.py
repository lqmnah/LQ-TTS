import pytest

from lq_tts_engine.synth import AdapterLoadFailed, AdapterSwitch


class FakeLoraModel:
    """Records what AdapterSwitch does to the model. Paths in `bad` raise on load; paths in `partial` come back with
    skipped tensors, the way voxcpm reports an adapter whose keys do not fit instead of raising."""

    def __init__(self, bad=(), partial=()):
        self.calls = []
        self.bad, self.partial = set(bad), set(partial)

    def load_lora(self, path):
        self.calls.append(("load", path))
        if path in self.bad:
            raise FileNotFoundError(path)
        return (["a"], ["b"]) if path in self.partial else (["a", "b"], [])

    def unload_lora(self):
        self.calls.append(("unload",))

    def set_lora_enabled(self, enabled):
        self.calls.append(("enabled", enabled))


def switch(**kw):
    model = FakeLoraModel(**kw)
    sw = AdapterSwitch(model)
    model.calls.clear()
    return sw, model


def loads(model):
    return [c[1] for c in model.calls if c[0] == "load"]


def test_voice_without_adapter_runs_on_the_base_model():
    sw, model = switch()
    sw.use(None)
    assert model.calls == [("enabled", False)]


def test_adapter_stays_loaded_across_its_jobs_and_base_jobs_in_between():
    sw, model = switch()
    for path in ("/a", "/a", None, "/a"):
        sw.use(path)
    assert loads(model) == ["/a"]
    assert [c[1] for c in model.calls if c[0] == "enabled"] == [True, True, False, True]


def test_another_adapter_replaces_the_active_one():
    sw, model = switch()
    sw.use("/a")
    sw.use("/b")
    assert loads(model) == ["/a", "/b"] and sw.active == "/b"


def test_failed_load_resets_to_base_and_is_retried_next_time():
    sw, model = switch(bad={"/a"})
    with pytest.raises(AdapterLoadFailed, match="/a"):
        sw.use("/a")
    assert model.calls == [("load", "/a"), ("unload",), ("enabled", False)]
    model.bad.clear()
    sw.use("/a")
    assert model.calls[-2:] == [("load", "/a"), ("enabled", True)]


def test_adapter_whose_tensors_do_not_fit_is_never_enabled():
    sw, model = switch(partial={"/a"})
    with pytest.raises(AdapterLoadFailed, match="1 do not fit"):
        sw.use("/a")
    assert ("enabled", True) not in model.calls
    assert model.calls[-2:] == [("unload",), ("enabled", False)]


def test_failure_while_switching_away_forgets_the_old_adapter():
    sw, model = switch(bad={"/b"})
    sw.use("/a")
    with pytest.raises(AdapterLoadFailed):
        sw.use("/b")
    sw.use("/a")  # /b's failed load reset the weights, so /a must be loaded again, not trusted from the cache
    assert loads(model) == ["/a", "/b", "/a"]
