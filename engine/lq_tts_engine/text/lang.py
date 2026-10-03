from __future__ import annotations

import re

_ID = frozenset(
    "yang dan di ini itu dengan untuk tidak gak nggak lo gue aja kita ada dari ke akan sudah "
    "udah juga kalau jadi bisa harus buat lagi kayak".split()
)
_EN = frozenset("the and is are to of you this that with for it was be have not your what can will".split())
_WORDS = re.compile(r"[^\W\d_]+")


def guess_language(text: str) -> str | None:
    words = _WORDS.findall(text.lower())
    id_hits = sum(w in _ID for w in words)
    en_hits = sum(w in _EN for w in words)
    if en_hits > id_hits:
        return "en"
    if id_hits > 0:
        return "id"
    return None
