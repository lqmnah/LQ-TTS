from __future__ import annotations

import shutil
import time
from pathlib import Path

SEVEN_DAYS_S = 7 * 24 * 3600


def purge_unreferenced_takes(data_dir: Path, referenced: set[str], *, older_than_s: float = SEVEN_DAYS_S,
                             now: float | None = None) -> int:
    now = time.time() if now is None else now
    removed = 0
    for path in (data_dir / "jobs").glob("*/takes/*.wav"):
        if str(path) in referenced or now - path.stat().st_mtime < older_than_s:
            continue
        path.unlink()
        removed += 1
    return removed


def free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1e9

