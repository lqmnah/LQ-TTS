from __future__ import annotations

import re
from dataclasses import dataclass

ABBREVIATIONS = frozenset({
    "dr", "drs", "dra", "no", "rp", "dll", "dsb", "dkk", "mr", "mrs", "ms", "prof", "st",
    "jl", "tn", "ny", "sdr", "pt", "cv", "hlm", "vs", "etc", "jr", "sr", "bpk",
})
_STYLE = re.compile(r"\{\{\s*style\s*:\s*(.*?)\s*\}\}", re.IGNORECASE | re.DOTALL)
_END = re.compile(r"[.?!]+[\"'”’)\]]*(?=\s|$)")
_WORD = re.compile(r"\w+")
_PARA = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Unit:
    idx: int
    paragraph_idx: int
    text: str
    style: str | None
    paragraph_end: bool


def _words(text: str) -> int:
    return len(_WORD.findall(text))


def _sentences_in(chunk: str) -> list[str]:
    out: list[str] = []
    start = 0
    for match in _END.finditer(chunk):
        punct = match.group().rstrip("\"'”’)]")
        if punct == ".":
            before = _WORD.findall(chunk[start:match.start()])
            if before and before[-1].lower() in ABBREVIATIONS:
                continue
        sentence = " ".join(chunk[start:match.end()].split())
        if sentence:
            out.append(sentence)
        start = match.end()
    tail = " ".join(chunk[start:].split())
    if tail:
        out.append(tail)
    return out


def split_script(text: str) -> list[Unit]:
    units: list[Unit] = []
    paragraphs = [p for p in _PARA.split(text.replace("\r\n", "\n")) if p.strip()]
    for p_idx, paragraph in enumerate(paragraphs):
        raw: list[tuple[str, str | None]] = []
        pending_style: str | None = None
        for k, part in enumerate(_STYLE.split(paragraph)):
            if k % 2 == 1:
                pending_style = part.strip() or None
                continue
            for sentence in _sentences_in(part):
                raw.append((sentence, pending_style))
                pending_style = None

        merged: list[tuple[str, str | None]] = []
        buf, buf_style = "", None
        for sentence, style in raw:
            buf = f"{buf} {sentence}".strip()
            buf_style = buf_style or style
            if _words(buf) >= 3:
                merged.append((buf, buf_style))
                buf, buf_style = "", None
        if buf:
            if merged:
                last_text, last_style = merged[-1]
                merged[-1] = (f"{last_text} {buf}", last_style or buf_style)
            else:
                merged.append((buf, buf_style))

        for n, (sentence, style) in enumerate(merged):
            units.append(Unit(len(units), p_idx, sentence, style, n == len(merged) - 1))
    return units


def is_single_sentence(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and not _PARA.search(stripped) and len(split_script(stripped)) == 1
