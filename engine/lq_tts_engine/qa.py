from __future__ import annotations

from .text.numbers import normalize_for_match
from .text.spelled import LETTER_NAMES, WORDS_AND_MARKS, spelled_spans

PASS_SCORE = 0.85
SUFFIXES = ("nya", "lah", "kah", "pun")  # Whisper glues these onto an acronym: "KTPnya"
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


def _spelled_runs(text: str) -> list[tuple[list[str], str]]:
    """Each acronym the text normalizer spelled out (run of letter names, split at punctuation) with the word written
    just before it, normalized like the transcript ("" when there is none)."""
    tokens = WORDS_AND_MARKS.findall(text.lower())
    runs = []
    for start, end in spelled_spans(tokens):
        before = next((t for t in reversed(tokens[:start]) if t.isalnum()), "")
        runs.append((tokens[start:end], normalize_for_match(before)))
    return runs


def _letter_forms(run: list[str]) -> set[str]:
    """How the transcript can write the acronym: its letters, or their slang-normalized form (GW → "gue")."""
    letters = "".join(LETTER_NAMES[t] for t in run)
    return {letters, normalize_for_match(letters).replace(" ", "")}


def _heard_at(heard: list[str], start: int, run: list[str]) -> tuple[int, int, str] | None:
    """First place at or after `start` where the transcript says `run`: the letter names themselves, or a span of tokens
    joining to the acronym's letters (KTP, "KPK OJK", "PT PLN", K.T.P., GW heard through the slang map as "gue"),
    optionally with a suffix glued on (KTPnya). Returns (first token, end token, suffix)."""
    forms = _letter_forms(run)
    longest = max(map(len, forms)) + max(map(len, SUFFIXES))
    for k in range(start, len(heard)):
        if heard[k:k + len(run)] == run:
            return k, k + len(run), ""
        joined = ""
        for m in range(k, len(heard)):
            joined += heard[m]
            if len(joined) > longest:
                break
            for form in forms:
                if joined == form or (joined.startswith(form) and joined[len(form):] in SUFFIXES):
                    return k, m + 1, joined[len(form):]
    return None


def _spell_heard(runs: list[tuple[list[str], str]], heard: list[str]) -> tuple[list[str], bool]:
    """Rewrite each acronym Whisper wrote as letters into the spelling of the text, in order and each place once, so a
    correct take compares equal. When the word before an acronym looks like it ("di DI Yogyakarta"), the acronym is
    looked for after that word, so the preposition is not taken for DI. Returns the rewritten tokens and whether any
    acronym was not heard at all."""
    out, pos, missing = list(heard), 0, False
    for run, before in runs:
        start = pos
        if before in _letter_forms(run):
            start = next((k + 1 for k in range(pos, len(out)) if out[k] == before), pos)
        hit = _heard_at(out, start, run)
        if hit is None:
            missing = True
            continue
        k, end, suffix = hit
        out[k:end] = run + ([suffix] if suffix else [])
        pos = k + len(run) + (1 if suffix else 0)
    return out, missing


def score(expected: str, heard: str, language: str | None = None) -> float:
    a, b = normalize_for_match(expected), normalize_for_match(heard)
    if not a and not b:
        return 1.0
    # Spelled acronyms come from the Indonesian normalizers; in English, letter names are words ("to be a").
    runs = _spelled_runs(expected) if language != "en" else []
    missing = False
    if runs:
        tokens, missing = _spell_heard(runs, b.split())
        b = " ".join(tokens)
    s = max(0.0, 1.0 - levenshtein(a, b) / max(len(a), len(b)))
    return s * MISSING_ACRONYM_FACTOR if missing else s
