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
MAX_UNIT_CHARS = 400  # one synthesis call; a 20,000-character unit without punctuation would exhaust memory
_SOFT_BREAK = re.compile(r"[,;:]\s")


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


def _tiny(tail: str, limit: int) -> bool:
    return len(tail) < limit // 4 or _words(tail) < 3  # a pure-punctuation tail has no words


def _balanced_cut(rest: str, limit: int) -> int:
    """Cut for the last two pieces near the middle, both within limit: soft break, else space, else hard."""
    lo, target = max(len(rest) - limit, 1), len(rest) // 2
    soft = [m.end() for m in _SOFT_BREAK.finditer(rest, lo, target + 1) if m.end() <= target]
    if soft:
        return soft[-1]
    space = rest.rfind(" ", lo, target)
    return space + 1 if space >= lo else target


def _cap(sentence: str, limit: int = MAX_UNIT_CHARS) -> list[str]:
    """Cuts a unit longer than limit after its last comma/semicolon/colon, else at its last space, else hard."""
    pieces: list[str] = []
    rest = sentence
    while len(rest) > limit:
        window = rest[: limit + 1]
        cut = max((m.end() for m in _SOFT_BREAK.finditer(window)), default=0)
        if cut < limit // 2:
            space = window.rfind(" ")
            cut = space + 1 if space > 0 else limit
        if len(rest) - cut <= limit and _tiny(rest[cut:].strip(), limit):
            cut = _balanced_cut(rest, limit)
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return pieces


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

        def flush(fragment: str, fragment_style: str | None) -> None:
            if merged and merged[-1][1] == fragment_style:
                merged[-1] = (f"{merged[-1][0]} {fragment}", fragment_style)
            else:
                merged.append((fragment, fragment_style))

        buf, buf_style = "", None
        for sentence, style in raw:
            if buf and style != buf_style:
                flush(buf, buf_style)
                buf = ""
            buf = f"{buf} {sentence}".strip()
            buf_style = style
            if _words(buf) >= 3:
                merged.append((buf, buf_style))
                buf, buf_style = "", None
        if buf:
            flush(buf, buf_style)

        capped = [(piece, style) for sentence, style in merged for piece in _cap(sentence)]
        for n, (sentence, style) in enumerate(capped):
            units.append(Unit(len(units), p_idx, sentence, style, n == len(capped) - 1))
    return units


def is_single_sentence(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and not _PARA.search(stripped) and len(split_script(stripped)) == 1
