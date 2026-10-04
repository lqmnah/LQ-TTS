from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Cue:
    start_s: float
    end_s: float
    text: str


def _ts(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _line(text: str) -> str:
    return " ".join(text.split())  # a blank line inside a cue would end the cue early


def _srt_text(text: str) -> str:
    # SRT has no escapes and players read <i>/<b>/<font>: swap angle brackets for look-alikes, which also defuses "-->".
    return _line(text).replace("<", "‹").replace(">", "›")


def _vtt_text(text: str) -> str:
    return _line(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_srt(cues: list[Cue]) -> str:
    return "".join(
        f"{i}\n{_ts(c.start_s, ',')} --> {_ts(c.end_s, ',')}\n{_srt_text(c.text)}\n\n" for i, c in enumerate(cues, 1)
    )


def to_vtt(cues: list[Cue]) -> str:
    return "WEBVTT\n\n" + "".join(
        f"{_ts(c.start_s, '.')} --> {_ts(c.end_s, '.')}\n{_vtt_text(c.text)}\n\n" for c in cues
    )
