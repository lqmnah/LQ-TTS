from __future__ import annotations

import re

_UNITS = {
    "nol": 0, "satu": 1, "dua": 2, "tiga": 3, "empat": 4, "lima": 5, "enam": 6, "tujuh": 7,
    "delapan": 8, "sembilan": 9,
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_FIXED = {"sepuluh": 10, "sebelas": 11, "seratus": 100,
          "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
          "eighty": 80, "ninety": 90}
_GROUP_MULT = {"puluh": 10, "ratus": 100, "hundred": 100}
_SCALES = {"ribu": 1_000, "juta": 1_000_000, "thousand": 1_000, "million": 1_000_000}
_FIXED_SCALES = {"seribu": 1_000, "sejuta": 1_000_000}
_SLANG = {"nggak": "gak", "enggak": "gak", "ngga": "gak", "ga": "gak", "gk": "gak",
          "lu": "lo", "loe": "lo", "gua": "gue", "gw": "gue", "hape": "hp"}
_TOKEN = re.compile(r"[^\W_]+|[^\w\s]")


def _numbers_to_digits(tokens: list[str]) -> list[str]:
    out: list[str] = []
    total = group = last = 0
    active = last_was_unit = False

    def flush() -> None:
        nonlocal total, group, last, active, last_was_unit
        if active:
            out.append(str(total + group))
        total = group = last = 0
        active = last_was_unit = False

    for tok in tokens:
        if tok in _UNITS:
            if last_was_unit:
                flush()
            group += _UNITS[tok]
            last, active, last_was_unit = _UNITS[tok], True, True
        elif tok in _FIXED:
            if last_was_unit:
                flush()
            group += _FIXED[tok]
            last, active, last_was_unit = _FIXED[tok], True, False
        elif tok == "belas" and last_was_unit:
            group += 10
            last, last_was_unit = last + 10, False
        elif tok in _GROUP_MULT and last_was_unit:
            group += last * (_GROUP_MULT[tok] - 1)
            last, last_was_unit = last * _GROUP_MULT[tok], False
        elif tok in _SCALES and active:
            total += group * _SCALES[tok]
            group = last = 0
            last_was_unit = False
        elif tok in _FIXED_SCALES:
            if last_was_unit:
                flush()
            total += _FIXED_SCALES[tok]
            active, last_was_unit = True, False
        else:
            flush()
            out.append(tok)
    flush()
    return out


def normalize_for_match(text: str) -> str:
    tokens = [_SLANG.get(t, t) for t in _TOKEN.findall(text.lower())]
    return " ".join(t for t in _numbers_to_digits(tokens) if t.isalnum())
