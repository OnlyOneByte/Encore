"""Is a transcript words at all? Whisper can decode a song into runs of two letters (#1288).

The rule and the corpus it was measured on: docs/arch/04-alignment.md §5.6.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

#: Where a run ends: a space, or a hyphen, which sung chains like `la-la-la-la` are written with.
_BREAK = re.compile(r"[\s\-‐-―]+")
#: A run of at least this many letters, with no break in it...
RUN_LETTERS = 20
#: ...drawn from this few distinct letters, is babble or an unspaced chant (`啦啦啦…`, `Nooooo…`).
RUN_DISTINCT = 4
#: The share at which a transcript is withheld. Real songs stay under it; one dominated by chants is withheld
#: on purpose, and the host can still paste.
BABBLE_SHARE = 0.5


def babble_share(texts: Iterable[str]) -> float:
    """The share of the letters in `texts` that sit in long runs of very few distinct letters."""
    letters = babbled = 0
    for text in texts:
        for token in _BREAK.split(text):
            run = [ch.casefold() for ch in token if ch.isalpha()]
            letters += len(run)
            if len(run) >= RUN_LETTERS and len(set(run)) <= RUN_DISTINCT:
                babbled += len(run)
    return babbled / letters if letters else 0.0


def babble(texts: Iterable[str]) -> str | None:
    """Why `texts` is not lyrics, or None when it may be."""
    share = babble_share(texts)
    if share < BABBLE_SHARE:
        return None
    return (
        f"{share:.0%} of its letters are runs of {RUN_LETTERS}+ letters drawn from {RUN_DISTINCT} or fewer, "
        "so it is babble or a chant rather than lyrics"
    )
