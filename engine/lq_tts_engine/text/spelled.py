"""Acronyms the text normalizers spell out with Indonesian letter names ("KTP" → "ka te pe": LQ-Studio
normalizeIndonesianText, the LQ Journal dictionary). Shared by QA (qa.score) and the language guess (text.lang)."""
from __future__ import annotations

LETTER_NAMES = {"a": "a", "be": "b", "ce": "c", "de": "d", "e": "e", "ef": "f", "ge": "g", "ha": "h", "i": "i",
                "je": "j", "ka": "k", "el": "l", "em": "m", "en": "n", "o": "o", "pe": "p", "ki": "q", "er": "r",
                "es": "s", "te": "t", "u": "u", "ve": "v", "fe": "v", "we": "w", "eks": "x", "ye": "y", "zet": "z"}
# Runs made only of these are interjections ("ha ha", "e e"), not acronyms.
INTERJECTION_NAMES = frozenset({"a", "e", "i", "o", "u", "ha"})
# Runs far more likely to be English words than an acronym, whatever the sentence language ("berani be a leader").
ENGLISH_RUNS = frozenset({("be", "a")})


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
