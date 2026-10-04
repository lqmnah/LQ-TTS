from __future__ import annotations

import shutil
import time
from pathlib import Path

SEVEN_DAYS_S = 7 * 24 * 3600


def _entries(folder: Path) -> list[Path]:
    try:
        return list(folder.iterdir())
    except (FileNotFoundError, NotADirectoryError):  # removed by a DELETE mid-pass, or not a folder
        return []


def purge_unreferenced_takes(data_dir: Path, referenced: set[str], *, older_than_s: float = SEVEN_DAYS_S,
                             now: float | None = None) -> int:
    now = time.time() if now is None else now
    removed = 0
    for job in _entries(data_dir / "jobs"):
        for path in _entries(job / "takes"):
            if path.suffix != ".wav":
                continue
            try:
                if str(path) in referenced or now - path.stat().st_mtime < older_than_s:
                    continue
                path.unlink()
            except FileNotFoundError:  # its job was deleted while this pass ran
                continue
            removed += 1
    return removed


def free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1e9

