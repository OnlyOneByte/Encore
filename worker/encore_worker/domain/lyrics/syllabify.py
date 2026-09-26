"""Splitting a word into syllables, so char-level alignment can be regrouped for a karaoke ball.

TEXT-SIDE ONLY. The alignment already times every CHARACTER (the CTC decode's native output), so syllable
timing is not an audio problem at all — it is deciding which chars belong together. That split is a pure
function, which is why this module imports no audio and can be tested with a truth table.

A LADDER, best evidence first, because no single source covers everything:

  1. CMUdict (via `cmudict`)       phoneme-based, so it is RIGHT about English in the ways orthography is
                                   wrong: "come" is one syllable (the e is silent), "away" splits a|way.
                                   English-only, and only for words it knows.
  2. pyphen                        hyphenation dictionaries for ~70 languages. Hyphenation is not exactly
                                   syllabification, but its split points are close enough to group chars.
  3. vowel groups                  the naive fallback that always answers. Known wrong in measured ways —
                                   `come -> com|e`, `away -> aw|ay` — recorded in the tests as EXPECTED
                                   failures of this tier so nobody mistakes them for bugs in the ladder.

Every tier returns contiguous, non-empty fragments whose concatenation is exactly the input word — the
invariant that lets char spans be regrouped without re-alignment. CMUdict gives a syllable COUNT (phoneme
stress markers), so tier 1 still needs orthographic split POINTS; it takes tier 2/3's candidate points and
keeps the count honest.

WHY COUNT-CORRECTION MATTERS FOR SINGING: a karaoke ball bounces once per sung syllable. One split too many
("com|e") puts a bounce on silence; one too few merges two sung notes into one bounce. The count is the
musically audible property; the exact split point inside the word is not.
"""

from __future__ import annotations

import functools
import re
from typing import Any

#: Vowels for the naive tier. `y` included: excluding it loses "rhy|thm", including it over-splits "away"
#: less than the alternatives — and this tier is the last resort, not the standard.
_VOWELS = frozenset("aeiouyàáâäæãåāèéêëēėęîïíīįìôöòóœøōõûüùúūÿ")

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _vowel_groups(word: str) -> list[str]:
    """Tier 3: split before each vowel group after the first. Always answers, wrong in known ways."""
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


def _pyphen_split(word: str, language: str) -> list[str] | None:
    """Tier 2, or None when pyphen or the language is absent."""
    dic = _pyphen_dic(language)
    if dic is None:
        return None
    parts = dic.inserted(word).split("-")
    parts = [p for p in parts if p]
    return parts if parts and "".join(parts) == word else None


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
    """Tier 1's contribution: the PHONETIC syllable count, or None when CMUdict does not know the word.

    Counts stress markers on the first pronunciation — the standard trick: every vowel phoneme in ARPAbet
    carries a 0/1/2 stress digit, and sung syllables track vowel phonemes.
    """
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
    groups than there are sung syllables, which is rare in practice.
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


def syllables(word: str, language: str = "en") -> list[str]:
    """The word's syllables as contiguous fragments; their concatenation is exactly the input.

    Never returns an empty list and never an empty fragment — a caller regrouping char spans indexes by
    cumulative length, and an empty fragment would produce a zero-width span that reads as a defect.
    """
    core = word.strip()
    if not core or not _WORD_RE.search(core):
        return [word] if word else []

    pieces = _pyphen_split(core, language) or _vowel_groups(core)
    if language.startswith("en"):
        count = _cmu_syllable_count(core)
        if count is not None:
            pieces = _force_count(pieces, count)
    # Restore any surrounding punctuation the caller left on the word: it belongs to the outer fragments,
    # and the concatenation invariant must survive it.
    if core != word:
        head = word[: word.index(core)]
        tail = word[word.index(core) + len(core) :]
        pieces = [head + pieces[0], *pieces[1:]] if head else list(pieces)
        pieces = [*pieces[:-1], pieces[-1] + tail] if tail else pieces
    return pieces
