"""Acronyms the text normalizers spell out with Indonesian letter names ("KTP" → "ka te pe": LQ-Studio
normalizeIndonesianText, the LQ Journal dictionary). Shared by QA (qa.score), the language guess (text.lang) and the
accented reading some voices get (pipeline, voices.accent_letters)."""
from __future__ import annotations

import re

LETTER_NAMES = {"a": "a", "be": "b", "ce": "c", "de": "d", "e": "e", "ef": "f", "ge": "g", "ha": "h", "i": "i",
                "je": "j", "ka": "k", "el": "l", "em": "m", "en": "n", "o": "o", "pe": "p", "ki": "q", "er": "r",
                "es": "s", "te": "t", "u": "u", "ve": "v", "fe": "v", "we": "w", "eks": "x", "ye": "y", "zet": "z"}
# Runs made only of these are interjections ("ha ha", "e e"), not acronyms.
INTERJECTION_NAMES = frozenset({"a", "e", "i", "o", "u", "ha"})
# Runs far more likely to be English words than an acronym, whatever the sentence language ("berani be a leader").
ENGLISH_RUNS = frozenset({("be", "a")})
# The tokens normalize_for_match works on, with punctuation kept: a comma ends a run ("Ka Pe Ka, o je ka" = KPK, OJK).
WORDS_AND_MARKS = re.compile(r"[^\W_]+|[^\w\s]")


def spelled_spans(tokens: list[str]) -> list[tuple[int, int]]:
    """(start, end) of each run of two or more letter names in lowercase `tokens`; any other token, punctuation
    included, ends a run. Interjections and English runs are left out."""
    spans, start = [], None
    for i, token in enumerate([*tokens, ""]):
        if token in LETTER_NAMES:
            start = i if start is None else start
            continue
        if start is not None:
            run = tuple(tokens[start:i])
            if len(run) >= 2 and not set(run) <= INTERJECTION_NAMES and run not in ENGLISH_RUNS:
                spans.append((start, i))
            start = None
    return spans


def accent_spelled(text: str) -> str:
    """`text` with each spelled acronym written as one hyphenated word whose letter names mark their e-taling with é:
    "ka te pe-nya" → "ka-té-pé-nya". For voices that read plain letter names with e-pepet and run them into one word
    ("kapepe"); lqmnah picked this form by ear, 16 Oct 2026. Everything else stays as written."""
    tokens = list(WORDS_AND_MARKS.finditer(text))
    out, done_to = [], 0
    for start, end in spelled_spans([t.group().lower() for t in tokens]):
        out += [text[done_to:tokens[start].start()], "-".join(_accented(t.group()) for t in tokens[start:end])]
        done_to = tokens[end - 1].end()
    return "".join(out) + text[done_to:]


def _accented(name: str) -> str:
    """A letter name with its e written é, in the case it had: "pe" → "pé", "PE" → "PÉ", "ka" stays."""
    i = name.lower().find("e")
    return name if i < 0 else name[:i] + ("É" if name[i] == "E" else "é") + name[i + 1:]
