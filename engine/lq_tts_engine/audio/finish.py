from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

_JSON = re.compile(r"\{[^{}]*\}")


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True)


def _loudness_stats(path: Path, extra: str = "") -> dict:
    out = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                "-af", f"loudnorm={extra}print_format=json", "-f", "null", "-"])
    return json.loads(_JSON.findall(out.stderr)[-1])


def loudnorm(src: Path, dst: Path, lufs: float, true_peak: float = -1.0, sr: int = 48000) -> None:
    target = f"I={lufs}:TP={true_peak}:LRA=11"
    m = _loudness_stats(src, f"{target}:")
    second = (f"loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
              f"offset={m['target_offset']}:linear=true")
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-af", second,
          "-ar", str(sr), "-ac", "1", "-c:a", "pcm_s16le", str(dst)])


def measure_lufs(path: Path) -> float:
    return float(_loudness_stats(path)["input_i"])


def encode_mp3(src: Path, dst: Path, sr: int = 48000) -> None:
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
          "-ar", str(sr), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "192k", str(dst)])
