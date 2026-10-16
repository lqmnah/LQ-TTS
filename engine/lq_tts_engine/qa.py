from __future__ import annotations

from .text.numbers import normalize_for_match

PASS_SCORE = 0.85
# Letter names the text normalizers (LQ-Studio normalizeIndonesianText, the LQ Journal dictionary) spell acronyms with:
# "KTP" → "ka te pe". Whisper writes the same speech as letters, so QA compares the two forms through this table.
LETTER_NAMES = {"a": "a", "be": "b", "ce": "c", "de": "d", "e": "e", "ef": "f", "ge": "g", "ha": "h", "i": "i",
                "je": "j", "ka": "k", "el": "l", "em": "m", "en": "n", "o": "o", "pe": "p", "ki": "q", "er": "r",
                "es": "s", "te": "t", "u": "u", "ve": "v", "fe": "v", "we": "w", "eks": "x", "ye": "y", "zet": "z"}
SUFFIXES = ("nya", "lah", "kah", "pun")  # Whisper glues these onto an acronym: "KTPnya"
# Runs made only of these are interjections ("ha ha", "e e"), not acronyms; they keep the plain comparison.
INTERJECTION_NAMES = frozenset({"a", "e", "i", "o", "u", "ha"})
# A take whose transcript lost a spelled acronym never passes, but failing takes keep their order by similarity.
MISSING_ACRONYM_FACTOR = 0.84


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _spelled_runs(tokens: list[str]) -> list[list[str]]:
    """Runs of two or more letter names: acronyms the text normalizer spelled out."""
    runs, i = [], 0
    while i < len(tokens):
        j = i
        while j < len(tokens) and tokens[j] in LETTER_NAMES:
            j += 1
        if j - i >= 2 and not set(tokens[i:j]) <= INTERJECTION_NAMES:
            runs.append(tokens[i:j])
        i = max(j, i + 1)
    return runs


def _find(tokens: list[str], seq: list[str]) -> int | None:
    return next((k for k in range(len(tokens) - len(seq) + 1) if tokens[k:k + len(seq)] == seq), None)


def _spell_heard(runs: list[list[str]], heard: list[str]) -> tuple[list[str], bool]:
    """Rewrite each spelled acronym Whisper wrote as letters (KTP, KTPnya, K.T.P.) into the spelling of the text, so a
    correct take compares equal. Returns the rewritten tokens and whether any acronym was not heard at all."""
    out, missing = list(heard), False
    for run in runs:
        letters = "".join(LETTER_NAMES[t] for t in run)
        if _find(out, run) is not None:
            continue
        k = next((k for k, t in enumerate(out)
                  if t == letters or (t.startswith(letters) and t[len(letters):] in SUFFIXES)), None)
        if k is not None:
            rest = out[k][len(letters):]
            out[k:k + 1] = run + ([rest] if rest else [])
            continue
        k = _find(out, list(letters))
        if k is not None:
            out[k:k + len(letters)] = run
            continue
        missing = True
    return out, missing


def score(expected: str, heard: str) -> float:
    a, b = normalize_for_match(expected), normalize_for_match(heard)
    if not a and not b:
        return 1.0
    runs = _spelled_runs(a.split())
    missing = False
    if runs:
        tokens, missing = _spell_heard(runs, b.split())
        b = " ".join(tokens)
    s = max(0.0, 1.0 - levenshtein(a, b) / max(len(a), len(b)))
    return s * MISSING_ACRONYM_FACTOR if missing else s
