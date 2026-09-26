"""The syllabifier's truth table, including the failures each tier is KNOWN to have.

The musically audible property is the COUNT — a karaoke ball bounces once per sung syllable — so the
assertions pin counts hard and split points softly. The naive tier's known-wrong cases are asserted AS
known-wrong (marked by which tier fixes them), so nobody mistakes a documented limitation for a regression.
"""

from __future__ import annotations

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
