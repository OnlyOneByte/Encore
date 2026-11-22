"""The syllabifier's truth table, including the failures each tier is KNOWN to have.

The musically audible property is the COUNT — a karaoke ball bounces once per sung syllable — so the
assertions pin counts hard and split points softly. The naive tier's known-wrong cases are asserted AS
known-wrong (marked by which tier fixes them), so nobody mistakes a documented limitation for a regression.
"""

from __future__ import annotations

import importlib.resources
import lzma
from pathlib import Path

import pytest

from encore_worker.domain.lyrics import syllabify
from encore_worker.domain.lyrics.syllabify import _vowel_groups, syllables

cmu_installed = syllabify._cmu_entries() is not None
needs_cmu = pytest.mark.skipif(not cmu_installed, reason="cmudict not installed")


# ── the invariant every tier must hold ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "word",
    ["come", "away", "fly", "tonight", "beautiful", "don't", "rhythm", "a", "strengths", "yeah"],
)
def test_fragments_concatenate_to_exactly_the_input(word: str) -> None:
    """The invariant that lets char spans be regrouped without re-alignment. If it breaks, syllable
    timings index the wrong chars — silently."""
    assert "".join(syllables(word)) == word


@pytest.mark.parametrize("word", ["come", "away", "beautiful", "x", "don't"])
def test_no_fragment_is_ever_empty(word: str) -> None:
    """An empty fragment would produce a zero-width span that reads as a defect downstream."""
    assert all(syllables(word))


def test_pure_punctuation_and_empty_input_do_not_crash() -> None:
    assert syllables("") == []
    assert syllables("...") == ["..."]
    assert syllables("♪") == ["♪"]


def test_surrounding_punctuation_survives_on_the_outer_fragments() -> None:
    got = syllables("(tonight)")
    assert "".join(got) == "(tonight)"
    assert got[0].startswith("(") and got[-1].endswith(")")


# ── the counts, which are the musically audible property ────────────────────────────────────────


@needs_cmu
@pytest.mark.parametrize(
    ("word", "count"),
    [
        ("come", 1),  # silent e — orthography says 2, phonetics says 1; the case the CMU tier exists for
        ("away", 2),
        ("fly", 1),
        ("tonight", 2),
        ("beautiful", 3),
        ("rhythm", 2),  # no orthographic vowel in the second syllable at all
        ("fire", 2),  # CMUdict says F-AY1-ER0 — two sung syllables, which is how it is sung
    ],
)
def test_english_syllable_counts_are_phonetic_not_orthographic(word: str, count: int) -> None:
    assert len(syllables(word)) == count


@needs_cmu
def test_an_unknown_word_still_answers_via_the_lower_tiers() -> None:
    """A made-up word (a vocalisation, a name) must not fail — the ladder's whole point."""
    got = syllables("floofalorp")
    assert got and "".join(got) == "floofalorp"


# ── the naive tier's KNOWN failures, asserted as known ───────────────────────────────────────────


def test_naive_tier_gets_silent_e_wrong_and_that_is_expected() -> None:
    """`com|e` is the measured failure of vowel-grouping — recorded so a future reader sees a documented
    limitation of the LAST-RESORT tier, not a bug. The CMU tier corrects it (asserted above)."""
    assert _vowel_groups("come") == ["com", "e"]


def test_naive_tier_never_returns_empty_pieces_either() -> None:
    for word in ("come", "away", "strengths", "eye"):
        pieces = _vowel_groups(word)
        assert pieces and all(pieces) and "".join(pieces) == word


# ── edge punctuation, internal hyphens, and the Moby tier ────────────────────────────────────────

moby_installed = bool(syllabify._moby())
needs_moby = pytest.mark.skipif(not moby_installed, reason="the shipped Moby data did not load")


@needs_cmu
@pytest.mark.parametrize(
    ("word", "count"),
    [
        # The four measured words. Each was looked up WITH its punctuation, so CMUdict missed it and
        # pyphen declined to split: `everything,` came out as ONE syllable and `baby,` as one.
        ("everything,", 3),
        ("baby,", 2),
        ("everybody,", 4),
        ("tonight!", 2),
        ('"hello"', 2),
        ("(tonight)", 2),
        ("'cause", 1),
    ],
)
def test_edge_punctuation_no_longer_bypasses_the_dictionary(word: str, count: int) -> None:
    """Measured over the 32 bench songs' cleaned texts (10 590 tokens): 4.3% carry edge punctuation and
    0.9% of ALL tokens got a different syllable COUNT because of it — the audible half."""
    assert len(syllables(word)) == count


@pytest.mark.parametrize(
    ("word", "pieces"),
    [
        # The measured vocable: it used to come out `la-l|a-l|a`, with fragments straddling the hyphen.
        ("la-la-la", ["la-", "la-", "la"]),
        ("oh-oh-oh", ["oh-", "oh-", "oh"]),
        ("na--na", ["na--", "na"]),
    ],
)
def test_internal_hyphens_split_and_the_separator_rides_the_fragment_before_it(
    word: str, pieces: list[str]
) -> None:
    assert syllables(word) == pieces


@needs_moby
@pytest.mark.parametrize(
    ("word", "pieces"),
    [
        # The two splits measured as wrong, plus the two whose COUNT pyphen also lost.
        ("about", ["a", "bout"]),
        ("maybe", ["may", "be"]),
        ("baby", ["ba", "by"]),
        ("everything", ["eve", "ry", "thing"]),
    ],
)
def test_the_moby_tier_splits_where_pyphen_abstains(word: str, pieces: list[str]) -> None:
    """pyphen returns these words UNSPLIT — 44.8% of the corpus's multi-syllable occurrences, reproduced
    exactly off the measured figure — and `_force_count` then bisected them against CMUdict's count, which
    puts the boundary at the middle of the string (`everything` -> `ever|yth|ing`)."""
    assert syllables(word) == pieces
    assert syllabify._pyphen_split(word, "en", unsplit_abstains=True) is None, (
        "if pyphen learns these, re-read the ladder's order"
    )


@needs_moby
def test_the_moby_table_is_the_size_the_docstring_claims() -> None:
    """The one assertion that the shipped `data/mhyph.xz` is the artefact it is documented as, rather than
    a truncated or re-derived file: 152 085 entries, every one lowercase letters with at least one break."""
    table = syllabify._moby()
    assert len(table) == 152085
    assert all(word.isalpha() and word.islower() for word in list(table)[:2000])
    assert all(offsets and all(o > 0 for o in offsets) for offsets in list(table.values())[:2000])


@needs_moby
def test_an_unsplit_pyphen_answer_is_an_abstention_not_a_result() -> None:
    """Treating "the whole word" as one syllable is how `baby` lost its bounce. Returning None lets the
    next tier answer — and for a word no tier knows, the vowel grouper still does."""
    assert syllabify._pyphen_split("baby", "en", unsplit_abstains=True) is None
    assert syllabify._pyphen_split("a", "en", unsplit_abstains=True) is None


# ── an abstention needs a tier that can be corrected ──────────────────────────────────────────────

needs_pyphen_fr = pytest.mark.skipif(
    syllabify._pyphen_dic("fr") is None, reason="pyphen (or its fr dictionary) not installed"
)


@needs_pyphen_fr
@pytest.mark.parametrize("word", ["une", "aime", "aile", "heure"])
def test_off_english_pyphens_single_fragment_is_kept_instead_of_vowel_grouped(word: str) -> None:
    """Ordinary `fr` vocabulary, each a ONE-syllable word pyphen declines to split. For English the
    abstention is right because `_force_count` undoes the vowel grouper's over-splits against CMUdict; off
    English there is no count source, so falling through cut every such monosyllable in two with the second
    fragment on a silent final vowel — the `com|e` failure the module docstring records as that tier's
    known one, and one sung syllable rendered as two bounces."""
    assert syllabify._pyphen_split(word, "fr", unsplit_abstains=False) == [word]
    assert syllables(word, "fr") == [word]
    assert len(_vowel_groups(word)) == 2, "the tier this must NOT fall through to, pinned as the reason"


@pytest.mark.parametrize("english", ["en", "en-GB"])
def test_english_still_falls_through_to_the_grouper_and_its_counter(english: str) -> None:
    """The other half of the same decision: in English the abstention must still reach a tier that answers
    (`baby` has two bounces, and pyphen returns it whole)."""
    assert syllabify._pyphen_split("baby", english, unsplit_abstains=True) is None
    assert len(syllables("baby", english)) == 2


def test_an_english_token_no_counter_knows_keeps_the_groupers_answer() -> None:
    """Pinned as the DECISION it is. The abstention is justified by a tier that can
    correct an over-split, and for a token CMUdict has never heard of that tier is not there — so this answer
    is the vowel grouper's, uncorrected. Kept because the corpus says so: of the 37 occurrences where the
    old single fragment and today's answer differ, 14 are long repeated-vowel vocalise tokens really sung
    as 4-5 syllables and only 3 ask for an impossible count (`_split_core` carries the measurement). A
    repeated-syllable vocalise stands in for them here: one fragment would be one ball bounce for a token
    sung three times over."""
    assert syllabify._moby_split("nanana") is None, "Moby has no entry"
    assert syllabify._pyphen_split("nanana", "en", unsplit_abstains=False) == ["nanana"], "pyphen declines"
    assert syllabify._cmu_syllable_count("nanana") is None, "and no count exists to correct anything"
    assert syllables("nanana") == ["nan", "an", "a"], "so the grouper's three bounces stand"


# ── a damaged data file degrades, as the packaging contract says ──────────────────────────────────


@pytest.mark.parametrize(
    ("payload", "why"),
    [
        (lzma.compress(b"aa-bb\n")[:16], "a truncated or partially written file: lzma.LZMAError"),
        (lzma.compress(b"\xff\xfe-\xff\n"), "bytes that are not ASCII: UnicodeDecodeError"),
    ],
)
def test_a_corrupt_moby_file_degrades_to_an_empty_table(
    payload: bytes, why: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`pyproject.toml` and `tests/test_packaging.py` both state this tier's contract as "its ABSENCE is a
    silent degradation rather than an ImportError", and an interrupted checkout or a corrupted image layer
    is an absence of the same kind. The decompress used to sit OUTSIDE the guard, so it raised out of a pure
    domain function on the first `syllables()` of a job and failed the align."""
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / syllabify._MOBY_DATA).write_bytes(payload)
    monkeypatch.setattr(importlib.resources, "files", lambda _package: tmp_path)
    syllabify._moby.cache_clear()
    try:
        assert syllabify._moby() == {}, why
        assert syllables("baby") == ["ba", "by"] or len(syllables("baby")) == 2, "the ladder still answers"
    finally:
        syllabify._moby.cache_clear()  # the table is module-wide and every other test reads the real one


@pytest.mark.parametrize(
    "word",
    ["everything,", "la-la-la", "(tonight)", '"hello"', "don't", "'cause", "mid-night", "na--na", "..."],
)
def test_the_concatenation_invariant_survives_punctuation_and_hyphens(word: str) -> None:
    got = syllables(word)
    assert "".join(got) == word
    assert all(got)
