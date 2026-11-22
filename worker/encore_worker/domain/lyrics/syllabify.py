"""Splitting a word into syllables, so char-level alignment can be regrouped for a karaoke ball.

TEXT-SIDE ONLY, which makes it a pure function testable from a truth table. Four tiers, best evidence first —
CMUdict's COUNT, Moby, pyphen, vowel groups — every one returning contiguous fragments that concatenate to
exactly the input word. The ladder, the Moby packaging and the two bugs in how a token REACHED it:
`docs/arch/04-alignment.md` §8; LOG.md, "Syllables: the tokens the hyphen rule reaches".
"""

from __future__ import annotations

import functools
import importlib.resources
import lzma
import re
from typing import Any

#: Vowels for the naive tier. `y` included: excluding it loses "rhy|thm", including it over-splits "away"
#: less than the alternatives — and this tier is the last resort, not the standard.
_VOWELS = frozenset("aeiouyàáâäæãåāèéêëēėęîïíīįìôöòóœøōõûüùúūÿ")

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

#: The hyphen-like characters a token may be joined by. Splitting on them is safe for the concatenation
#: invariant because each separator is re-attached to the fragment before it, verbatim.
_HYPHENS = "-‐‑–—"

#: A run of hyphens, with the pieces either side. A LEADING or TRAILING run is NOT a separator — it is edge
#: punctuation, which `_edges` has already taken off before this is consulted.
_HYPHEN_RUN = re.compile(rf"[{_HYPHENS}]+")

#: Moby's shipped form: one entry per line, syllables joined by `-`.
_MOBY_DATA = "mhyph.xz"


def _vowel_groups(word: str) -> list[str]:
    """Tier 4: split before each vowel group after the first. Always answers, wrong in known ways."""
    lowered = word.lower()
    pieces: list[str] = []
    current = ""
    previous_vowel = False
    for index, ch in enumerate(lowered):
        vowel = ch in _VOWELS
        if vowel and not previous_vowel and current and any(c in _VOWELS for c in current):
            pieces.append(word[index - len(current) : index])
            current = ""
        current += ch
        previous_vowel = vowel
    if current:
        start = len(word) - len(current)
        tail = word[start:]
        # A trailing consonant cluster is not a syllable; glue it to the previous piece.
        if pieces and not any(c in _VOWELS for c in current):
            pieces[-1] += tail
        else:
            pieces.append(tail)
    return pieces or [word]


@functools.cache
def _pyphen_dic(language: str) -> Any:  # the pyphen type only exists when the extra is installed
    try:
        import pyphen  # noqa: PLC0415 - optional extra
    except ImportError:
        return None
    try:
        return pyphen.Pyphen(lang=language)
    except Exception:  # noqa: BLE001 - an unknown language code degrades, never raises
        return None


def _pyphen_split(word: str, language: str, *, unsplit_abstains: bool) -> list[str] | None:
    """Tier 3, or None when pyphen or the language is absent, or when pyphen declines to split.

    AN UNSPLIT ANSWER IS AN ABSTENTION WHERE A LATER TIER CAN BE CORRECTED, and a RESULT where it cannot:
    off English there is no count source to undo an over-split, so a language with no counter keeps pyphen's
    single fragment. THE FLAG IS THE LANGUAGE'S AND NOT THE TOKEN'S, which `_split_core`'s comment measures.
    A MANGLED answer abstains too (docs/arch/04-alignment.md §8; LOG.md, "Syllables").
    """
    dic = _pyphen_dic(language)
    if dic is None:
        return None
    parts = [piece for piece in dic.inserted(word).split("-") if piece]
    if "".join(parts) != word:
        return None
    if len(parts) < 2:
        return None if unsplit_abstains else [word]
    return parts


@functools.cache
def _moby() -> dict[str, tuple[int, ...]]:
    """Tier 2's table: `{word: (split offset, ...)}` from the shipped Moby data, read once.

    OFFSETS RATHER THAN FRAGMENTS so the table is cheap, and the fragments are sliced out of the caller's own
    token, which keeps its casing without a second copy of every word.
    """
    table: dict[str, tuple[int, ...]] = {}
    try:
        raw = (importlib.resources.files(__package__) / "data" / _MOBY_DATA).read_bytes()
        # THE DECOMPRESS IS INSIDE THE GUARD: this tier's contract is "its ABSENCE is a silent degradation
        # rather than an ImportError", and a corrupted `data/mhyph.xz` is an absence of the same kind — it
        # raised out of a PURE domain function on the first `syllables()` of a job.
        text = lzma.decompress(raw).decode("ascii")
    except (
        FileNotFoundError,
        OSError,
        ModuleNotFoundError,
        lzma.LZMAError,
        UnicodeDecodeError,
    ):  # pragma: no cover - a broken install
        return table
    for line in text.split("\n"):
        if not line:
            continue
        pieces = line.split("-")
        if len(pieces) < 2:
            continue
        offsets: list[int] = []
        at = 0
        for piece in pieces[:-1]:
            at += len(piece)
            offsets.append(at)
        table["".join(pieces)] = tuple(offsets)
    return table


def _moby_split(word: str) -> list[str] | None:
    """Tier 2, or None when Moby does not know the word. English only (its caller gates on language)."""
    offsets = _moby().get(word.lower())
    if not offsets:
        return None
    bounds = [0, *offsets, len(word)]
    pieces = [word[a:b] for a, b in zip(bounds, bounds[1:], strict=False)]
    # An entry whose offsets do not fit THIS token (a different inflection reaching the same key cannot
    # happen, but a corrupt data file could) is refused rather than returned short.
    if any(not piece for piece in pieces) or "".join(pieces) != word:  # pragma: no cover - data integrity
        return None
    return pieces


@functools.cache
def _cmu_entries() -> Any:
    """The CMU dictionary as `{word: [pronunciations]}`, loaded once, or None without the package."""
    try:
        import cmudict  # noqa: PLC0415 - optional extra
    except ImportError:
        return None
    return cmudict.dict()


@functools.cache
def _cmu_syllable_count(word: str) -> int | None:
    """Tier 1's contribution: the PHONETIC syllable count, or None when CMUdict does not know the word —
    stress markers on the first pronunciation, every ARPAbet vowel phoneme carrying one."""
    entries = _cmu_entries()
    if entries is None:
        return None
    phones = entries.get(word.lower())
    if not phones:
        return None
    # Stress digits ride on vowel phonemes ("K AH1 M"), and sung syllables track vowel phonemes.
    count = sum(1 for phone in phones[0] for ch in phone if ch.isdigit())
    return count or None


def _force_count(pieces: list[str], count: int) -> list[str]:
    """Adjust split POINTS so the piece count matches the phonetic count, merging or splitting minimally.

    Merging keeps the earliest boundaries (a late silent-e fragment is glued backward, which is exactly the
    `com|e` fix). Splitting bisects the longest piece — crude, but reached only when orthography found FEWER
    groups than there are sung syllables, which is rare in practice. Moby (tier 2) is what makes it rare:
    pyphen's abstentions used to arrive here as a single piece and get bisected blind.
    """
    pieces = list(pieces)
    while len(pieces) > count and len(pieces) >= 2:
        # Merge the shortest piece into its neighbour: fragments like "e" are the usual offenders.
        shortest = min(range(len(pieces)), key=lambda i: len(pieces[i]))
        if shortest == 0:
            pieces[0:2] = [pieces[0] + pieces[1]]
        else:
            pieces[shortest - 1 : shortest + 1] = [pieces[shortest - 1] + pieces[shortest]]
    while len(pieces) < count:
        longest = max(range(len(pieces)), key=lambda i: len(pieces[i]))
        piece = pieces[longest]
        if len(piece) < 2:
            break  # cannot split a single char; accept the shortfall rather than emit an empty fragment
        mid = len(piece) // 2
        pieces[longest : longest + 1] = [piece[:mid], piece[mid:]]
    return pieces


def _edges(word: str) -> tuple[str, str, str]:
    """`(head, core, tail)`: the leading and trailing NON-LETTER runs, and the letters between them.

    This is review L3's first bug. `str.strip()` removes whitespace alone, so `everything,` reached CMUdict
    with its comma and missed; `baby,` the same. The head and tail are re-attached to the outer fragments by
    `syllables`, so the concatenation invariant survives — and an all-punctuation token has an empty core,
    which the caller returns whole.
    """
    found = _WORD_RE.search(word)
    if found is None:
        return "", "", ""
    last = None
    for last in _WORD_RE.finditer(word):  # noqa: B007 - the last match is the point
        pass
    assert last is not None
    start, end = found.start(), last.end()
    return word[:start], word[start:end], word[end:]


def _split_core(core: str, language: str) -> list[str]:
    """The ladder over ONE hyphen-free run of letters: Moby, then pyphen, then vowel groups, CMU-counted."""
    english = language.startswith("en")
    # `unsplit_abstains=english`: only English has a tier after this one that can correct an over-split, and
    # for an English token CMUdict does not know, that tier is not there either. MEASURED BEFORE LEAVING IT AS
    # IT IS — making the abstention conditional on a count existing would hand back more real ball bounces
    # than false ones on the only population anybody has measured (LOG.md, "Syllables: the tokens the hyphen
    # rule reaches"); `test_syllabify` pins today's answer.
    pieces = (
        (_moby_split(core) if english else None)
        or _pyphen_split(core, language, unsplit_abstains=english)
        or _vowel_groups(core)
    )
    if english:
        count = _cmu_syllable_count(core)
        if count is not None:
            pieces = _force_count(pieces, count)
    return pieces


def syllables(word: str, language: str = "en") -> list[str]:
    """The word's syllables as contiguous fragments; their concatenation is exactly the input.

    Never returns an empty list and never an empty fragment — a caller regrouping char spans indexes by
    cumulative length, and an empty fragment would produce a zero-width span that reads as a defect.
    """
    head, core, tail = _edges(word)
    if not core:
        return [word] if word else []

    # INTERNAL HYPHENS SPLIT FIRST (review L3): `la-la-la` is three sung syllables, and handing the whole
    # token to a hyphenation dictionary produced `la-l|a-l|a` — fragments straddling the separator. Each
    # run of hyphens is re-attached to the fragment BEFORE it, so the concatenation invariant holds.
    pieces: list[str] = []
    at = 0
    for found in _HYPHEN_RUN.finditer(core):
        chunk = core[at : found.start()]
        separator = found.group()
        if chunk:
            chunk_pieces = _split_core(chunk, language)
            chunk_pieces[-1] += separator
            pieces.extend(chunk_pieces)
        elif pieces:
            pieces[-1] += separator
        else:
            # A core cannot START with a hyphen (`_edges` would have put it in the head), so this is only
            # reachable for a run following an empty chunk, i.e. never. Kept total rather than asserted.
            pieces.append(separator)  # pragma: no cover
        at = found.end()
    rest = core[at:]
    if rest:
        pieces.extend(_split_core(rest, language))
    if not pieces:  # pragma: no cover - a core with letters always yields at least one piece
        pieces = [core]

    # Restore the punctuation the caller left on the word: it belongs to the outer fragments, and the
    # concatenation invariant must survive it.
    if head:
        pieces = [head + pieces[0], *pieces[1:]]
    if tail:
        pieces = [*pieces[:-1], pieces[-1] + tail]
    return pieces
