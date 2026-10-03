from __future__ import annotations

from .text.numbers import normalize_for_match

PASS_SCORE = 0.85


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


def score(expected: str, heard: str) -> float:
    a, b = normalize_for_match(expected), normalize_for_match(heard)
    if not a and not b:
        return 1.0
    return max(0.0, 1.0 - levenshtein(a, b) / max(len(a), len(b)))
