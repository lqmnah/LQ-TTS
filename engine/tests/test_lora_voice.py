import json
import uuid

import pytest

from lq_tts_engine.config import LORA_SHAPE
from lq_tts_engine.lora_voice import AdapterRejected, attach
from tests.conftest import sql


def checkpoint(tmp_path, weights=b"w1", **shape):
    ck = tmp_path / f"ckpt-{uuid.uuid4().hex[:6]}"
    ck.mkdir()
    (ck / "lora_weights.safetensors").write_bytes(weights)
    cfg = {**LORA_SHAPE, "dropout": 0.0, **shape}
    (ck / "lora_config.json").write_text(json.dumps({"base_model": "openbmb/VoxCPM2", "lora_config": cfg}))
    return ck


def test_attach_copies_the_adapter_and_points_the_voice_at_it(repo, ready_voice, tmp_path):
    dest = attach(repo, tmp_path / "data", ready_voice["id"], checkpoint(tmp_path))
    assert dest.parent == tmp_path / "data" / "voices" / str(ready_voice["id"])
    assert (dest / "lora_weights.safetensors").read_bytes() == b"w1"
    assert repo.get_voice_any(ready_voice["id"])["adapter_path"] == str(dest)


def test_new_weights_get_a_new_path(repo, ready_voice, tmp_path):
    first = attach(repo, tmp_path / "data", ready_voice["id"], checkpoint(tmp_path, b"w1"))
    second = attach(repo, tmp_path / "data", ready_voice["id"], checkpoint(tmp_path, b"w2"))
    assert first != second  # the worker caches adapters by path: new weights under an old path would never load
    assert repo.get_voice_any(ready_voice["id"])["adapter_path"] == str(second)


@pytest.mark.parametrize("shape", [{"r": 16}, {"alpha": 64}, {"enable_proj": True}, {"enable_dit": False}])
def test_adapter_with_another_lora_shape_is_rejected(repo, ready_voice, tmp_path, shape):
    with pytest.raises(AdapterRejected, match="LoRA shape"):
        attach(repo, tmp_path / "data", ready_voice["id"], checkpoint(tmp_path, **shape))
    assert repo.get_voice_any(ready_voice["id"])["adapter_path"] is None


def test_checkpoint_without_weights_is_rejected(repo, ready_voice, tmp_path):
    ck = checkpoint(tmp_path)
    (ck / "lora_weights.safetensors").unlink()
    with pytest.raises(AdapterRejected, match="missing lora_weights.safetensors"):
        attach(repo, tmp_path / "data", ready_voice["id"], ck)


def test_deleted_voice_is_rejected_and_nothing_is_copied(repo, ready_voice, tmp_path):
    sql(repo, "UPDATE voices SET deleted_at=now() WHERE id=%s", (ready_voice["id"],))
    with pytest.raises(AdapterRejected, match="not a ready, live voice"):
        attach(repo, tmp_path / "data", ready_voice["id"], checkpoint(tmp_path))
    assert not (tmp_path / "data" / "voices").exists()
