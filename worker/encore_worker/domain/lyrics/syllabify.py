"""Splitting a word into syllables, so char-level alignment can be regrouped for a karaoke ball.

TEXT-SIDE ONLY. The alignment already times every CHARACTER (the CTC decode's native output), so syllable
timing is not an audio problem at all — it is deciding which chars belong together. That split is a pure
function, which is why this module imports no audio and can be tested with a truth table.

A LADDER, best evidence first, because no single source covers everything:

  1. CMUdict (via `cmudict`)       phoneme-based, so it is RIGHT about English in the ways orthography is
                                   wrong: "come" is one syllable (the e is silent), "away" splits a|way.
                                   English-only, and only for words it knows. Gives a COUNT, not points.
  2. Moby Hyphenator (shipped)     a 152 085-word hyphenation dictionary, public domain (Grady Ward's Moby
                                   Project, Gutenberg ebook 3204, `files/3204/files/mhyph.txt`). English.
  3. pyphen                        hyphenation dictionaries for ~70 languages. Hyphenation is not exactly
                                   syllabification, but its split points are close enough to group chars.
  4. vowel groups                  the naive fallback that always answers. Known wrong in measured ways —
                                   `come -> com|e`, `away -> aw|ay` — recorded in the tests as EXPECTED
                                   failures of this tier so nobody mistakes them for bugs in the ladder.

WHY MOBY SITS AHEAD OF PYPHEN (review L3), measured on the bench corpus's 20 JamendoLyrics songs, counting
OCCURRENCES of tokens CMUdict calls multi-syllable (901 of them): **pyphen abstains on 44.8%** — it returns
the whole word, no split — and Moby knows **82.9%** of them, including **83.9% of the ones pyphen abstains
on**. THE LADDER WITHOUT THIS TIER differed from Moby on **39.0%** of the occurrences Moby knows (re-read
at 39.8% through an emulation of the old lookup, which is the same disagreement): `about` and `maybe` and
`baby` and `everything` all come out of pyphen unsplit, and `_force_count` then has to BISECT them against
CMUdict's count, which puts the boundary wherever the middle of the string happens to be (`everything` ->
`ever|yth|ing`) instead of where Moby says (`eve|ry|thing`). WITH the tier in front the shipped ladder
differs from Moby on **1.3%**, every one of them `_force_count` honouring CMUdict's count over the
dictionary's break — which is the tier order working, not a disagreement left in it. The review's figures were
44.8% / 86.6% / 31.0%; the abstention rate reproduces exactly and the other two move with the counting rule.

THE DATA IS SHIPPED COMPACTLY, as `data/mhyph.xz` (456 KB): Moby's `mhyph.txt` is 2.6 MB of latin-1 with
U+00A5 between syllables, and what is kept is every entry that is PURELY LOWERCASE LETTERS once joined and
that has at least one break — multi-word entries ("a cap¥pel¥la"), apostrophes and hyphenated compounds are
dropped, because `syllables` splits on edge punctuation and internal hyphens itself and looks each piece up
separately. The result is one `word-with-hyphens` per line, LZMA'd. It is loaded lazily and once.

THE TWO BUGS L3 NAMED, both in how a token was handed to the ladder rather than in any tier:

  * EDGE PUNCTUATION bypassed CMUdict. `core = word.strip()` strips whitespace and nothing else, so
    `everything,` was looked up with the comma attached: CMUdict missed it, pyphen declined to split it, and
    the word came out as ONE syllable (`baby,` the same, `everybody,` 2 instead of 4). Measured over the 32
    bench songs' cleaned texts, 10 590 tokens: **4.3% carry edge punctuation** and **0.9% of all tokens get
    a different syllable COUNT because of it** — the audible half of the 4.3%.
  * INTERNAL HYPHENS were never split, so the vocable `la-la-la` came out `la-l|a-l|a` — fragments that
    straddle the hyphen and put the ball's bounce inside the previous syllable. 0.3% of tokens.

Every tier returns contiguous, non-empty fragments whose concatenation is exactly the input word — the
invariant that lets char spans be regrouped without re-alignment. CMUdict gives a syllable COUNT (phoneme
stress markers), so tier 1 still needs orthographic split POINTS; it takes tiers 2–4's candidate points and
keeps the count honest.

WHY COUNT-CORRECTION MATTERS FOR SINGING: a karaoke ball bounces once per sung syllable. One split too many
("com|e") puts a bounce on silence; one too few merges two sung notes into one bounce. The count is the
musically audible property; the exact split point inside the word is not — which is why a better split
POINT still matters: `_force_count` can only move a boundary it was given.
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

    AN UNSPLIT ANSWER IS AN ABSTENTION WHERE A LATER TIER CAN BE CORRECTED, and a RESULT where it cannot
    (review L3, then W5 review r1-correctness-6). pyphen returns the whole word for 44.8% of the corpus's
    multi-syllable occurrences, and treating that as "one syllable" is how `baby,` lost its bounce — so for
    ENGLISH the None falls through to the vowel grouper, whose over-splits `_force_count` then undoes
    against CMUdict. OFF ENGLISH THERE IS NO COUNT SOURCE to undo anything, and the vowel grouper's known
    failure is the silent final `e` (`com|e`, the module docstring's own example): measured on `fr`, four
    monosyllables pyphen declines to split came out as two fragments each, the second one a silent vowel,
    where before they came out whole. One sung syllable rendered as two is the audible defect this ladder
    exists to prevent, so a language with no counter keeps pyphen's single fragment.

    THE FLAG IS THE LANGUAGE'S AND NOT THE TOKEN'S, which is a deliberate approximation: an English token
    CMUdict has never heard of has no counter either, so its abstention reaches the vowel grouper
    uncorrected (W5 review r2-tests-15). `_split_core`'s comment carries the corpus measurement that says
    leaving it that way loses fewer real syllables than the per-token reading would.

    `"".join(parts) != word` is a MANGLED answer rather than an abstention, and abstains either way.
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

    OFFSETS RATHER THAN FRAGMENTS so the table is cheap: 152 085 small int tuples instead of 152 085 lists
    of strings, and the fragments are sliced out of the caller's own token, which keeps the original casing
    without a second copy of every word.
    """
    table: dict[str, tuple[int, ...]] = {}
    try:
        raw = (importlib.resources.files(__package__) / "data" / _MOBY_DATA).read_bytes()
        # THE DECOMPRESS IS INSIDE THE GUARD (W5 review r1-tests-21). `pyproject.toml` and
        # `tests/test_packaging.py` both state this tier's contract as "its ABSENCE is a silent degradation
        # rather than an ImportError", and a half-written or corrupted `data/mhyph.xz` — an interrupted
        # checkout, a bad image layer — is an absence of the same kind: `lzma.LZMAError` and
        # `UnicodeDecodeError` were raised out of a PURE domain function on the first `syllables()` of a job,
        # failing the align instead of falling back to pyphen.
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
    # `unsplit_abstains=english`: only English has a tier after this one that can correct an over-split
    # (`_force_count` against CMUdict, below) — see `_pyphen_split`, W5 review r1-correctness-6.
    # AND FOR AN ENGLISH TOKEN CMUdict DOES NOT KNOW, THAT TIER IS NOT THERE: the abstention falls through to
    # `_vowel_groups` with nothing to correct it, where before W5 the token kept pyphen's single fragment
    # (W5 review r2-tests-15, which is right about the mechanism). MEASURED BEFORE LEAVING IT AS IT IS, on the
    # bench corpus's own 32 truth texts (10 711 hyphen-free tokens): 59 occurrences / 38 distinct tokens reach
    # here with every counter abstaining, and in 22 of the 59 the vowel grouper also answers ONE, so 37
    # occurrences differ from the pre-W5 answer — 21 at 2 pieces, 2 at 3, 7 at 4 and 7 at 5. THE 14 AT 4-5
    # PIECES ARE 8- AND 10-LETTER REPEATED-VOWEL VOCALISE TOKENS, which really are sung as that many
    # syllables, and only 3 of the 37 ask for more pieces than the token has letter PAIRS (the one shape that
    # cannot be right). So making the abstention conditional on a count existing would hand back more real
    # ball bounces than false ones on the only population anybody has measured, and the conservative-looking
    # fix is the lossy one. Reading the count here first would be free (`_cmu_syllable_count` is cached) and
    # is the change to make if a fitted measurement ever says so; `test_syllabify` pins today's answer.
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
