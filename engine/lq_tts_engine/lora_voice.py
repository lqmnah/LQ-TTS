"""Attach a trained LoRA adapter to a ready voice.

    python -m lq_tts_engine.lora_voice VOICE_ID CHECKPOINT_DIR

CHECKPOINT_DIR is a VoxCPM training checkpoint (lora_weights.safetensors + lora_config.json) trained with
config.LORA_SHAPE. The adapter is copied to data/voices/<id>/lora-<sha256[:12]>/ and voices.adapter_path points there;
new weights always get a new path, so the worker's adapter cache picks them up without a restart. The voice itself is
created the usual way (web route: engine /v1/voices + consent row) before its adapter is attached."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

from .config import LORA_SHAPE, load_config
from .db import make_pool
from .repo import Repo

WEIGHTS, SHAPE = "lora_weights.safetensors", "lora_config.json"


class AdapterRejected(Exception):
    """The checkpoint cannot be attached; the message says why."""


def check_checkpoint(ckpt: Path) -> None:
    missing = [name for name in (WEIGHTS, SHAPE) if not (ckpt / name).is_file()]
    if missing:
        raise AdapterRejected(f"{ckpt}: missing {', '.join(missing)}")
    shape = json.loads((ckpt / SHAPE).read_text())["lora_config"]
    wrong = {key: shape.get(key) for key, want in LORA_SHAPE.items() if _canonical(shape.get(key)) != _canonical(want)}
    if wrong:
        raise AdapterRejected(f"{ckpt}: LoRA shape {wrong} differs from the engine's {LORA_SHAPE}")


def _canonical(value):
    return sorted(value) if isinstance(value, list) else value  # target-module lists are sets: order means nothing


def attach(repo: Repo, data_dir: Path, voice_id, ckpt: Path) -> Path:
    check_checkpoint(ckpt)
    voice = repo.get_voice_any(voice_id)
    if voice is None or voice["status"] != "ready" or voice["deleted_at"] is not None:
        raise AdapterRejected(f"voice {voice_id} is not a ready, live voice")
    vdir = data_dir / "voices" / str(voice["id"])  # canonical id: the dir that voice deletion removes
    vdir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".lora-", dir=vdir))
    try:
        for name in (WEIGHTS, SHAPE):
            shutil.copyfile(ckpt / name, staging / name)
        dest = vdir / f"lora-{hashlib.sha256((staging / WEIGHTS).read_bytes()).hexdigest()[:12]}"
        if not dest.exists():  # same bytes attached before stay untouched: the worker may be reading them
            os.replace(staging, dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if not repo.set_voice_adapter(voice["id"], str(dest)):
        shutil.rmtree(vdir, ignore_errors=True)  # deleted meanwhile: its files go with it
        raise AdapterRejected(f"voice {voice_id} was deleted while attaching")
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m lq_tts_engine.lora_voice", description=__doc__.splitlines()[0])
    parser.add_argument("voice_id", type=uuid.UUID)
    parser.add_argument("checkpoint", type=Path)
    args = parser.parse_args(argv)
    cfg = load_config()
    repo = Repo(make_pool(cfg.database_url, cfg.schema, max_size=1))
    try:
        print(attach(repo, cfg.data_dir, args.voice_id, args.checkpoint.expanduser().resolve()))
    except AdapterRejected as exc:
        print(f"rejected: {exc}", file=sys.stderr)
        return 2
    finally:
        repo.pool.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
