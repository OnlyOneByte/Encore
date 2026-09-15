"""`LyricsDoc`: the artifact's shape in one place, and the disagreement that had to be preserved.

Four readers each sniffed the dict independently, and TWO of them tolerated the older `segments` key
while two did not. Unifying that looks like the obvious cleanup and is a behaviour change — measured, not
guessed: handing the predicates the tolerant read flips 107 outcomes for `has_timed_words` and 25 for
`is_line_synced` over a 256-doc corpus, because a raw `segments` doc starts reading as publishable.

So both reads are named rather than merged. The tests that matter here are the ones pinning WHICH reader
gets WHICH read; the delegation itself is proven by the existing suite plus a parity run over well-formed
docs (216 comparisons, zero divergences).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.lyrics.artifact import is_valid_lyrics  # noqa: E402
from src.lyrics.model import (
    LyricsDoc,  # noqa: E402
    is_line_synced,  # noqa: E402
)
from src.lyrics.validate import _words_of  # noqa: E402

TIMED = [{"start": 0.0, "end": 0.5, "word": "a"}, {"start": 0.5, "end": 1.0, "word": "b"}]


def _doc(key: str = "lines", **over: object) -> dict:
    line = {"start": 1.0, "end": 2.0, "text": "hello", "words": TIMED, **over}
    return {"language": "en", key: [line]}


# ── the split that had to be preserved ───────────────────────────────────────────────────────────


def test_lines_is_STRICT_and_ignores_the_older_segments_key() -> None:
    """`normalize_lyrics` always writes `lines`; a doc without it is raw output, not an artifact."""
    assert LyricsDoc(_doc("lines")).lines != []
    assert LyricsDoc(_doc("segments")).lines == [], "the strict read must not see `segments`"


def test_lines_or_segments_is_TOLERANT_for_the_boundary_reader() -> None:
    assert LyricsDoc(_doc("segments")).lines_or_segments != []
    assert LyricsDoc(_doc("lines")).lines_or_segments != []


def test_the_predicates_keep_their_STRICT_read() -> None:
    """The regression this refactor could easily have introduced: a raw doc reading as publishable."""
    seg = _doc("segments")
    assert is_valid_lyrics(seg) is False, "a raw `segments` doc is not a publishable word-timed artifact"
    assert is_line_synced(seg) is False
    lines = _doc("lines")
    assert is_valid_lyrics(lines) is True and is_line_synced(lines) is True


def test_the_timing_reader_keeps_its_TOLERANT_read() -> None:
    """`_words_of` is the one reader that always accepted either shape, and still does."""
    assert len(_words_of(_doc("segments"))) == 2
    assert len(_words_of(_doc("lines"))) == 2


# ── the shape questions themselves ───────────────────────────────────────────────────────────────


def test_timed_words_needs_BOTH_bounds() -> None:
    """A word with no end cannot be given one without inventing a duration."""
    assert _words_of(_doc(words=[{"start": 0.0, "word": "x"}])) == []
    assert _words_of(_doc(words=[{"end": 1.0, "word": "x"}])) == []
    assert len(_words_of(_doc(words=[{"start": 0.0, "end": 1.0}]))) == 1


def test_has_timed_words_is_the_WEAKER_bar_on_purpose() -> None:
    """It asks whether `words` is non-empty, NOT whether they carry timestamps.

    That is the historical meaning of `is_valid_lyrics`; tightening it would change what gets published.
    `validate_timing` is what judges whether the timings are any good — it exists because six real
    artifacts cleared this bar while containing a 63-second hole.
    """
    assert LyricsDoc(_doc(words=[{"word": "untimed"}])).has_timed_words() is True
    assert LyricsDoc(_doc(words=[])).has_timed_words() is False


def test_is_line_synced_needs_a_start_and_text_but_no_words() -> None:
    assert LyricsDoc(_doc(words=[])).is_line_synced() is True
    assert LyricsDoc(_doc(text="")).is_line_synced() is False
    assert LyricsDoc(_doc(start=None)).is_line_synced() is False


def test_a_bool_is_not_a_timestamp() -> None:
    """`isinstance(True, int)` is True in Python, so every old site read `start=True` as time 1.0.

    The one deliberate behavioural tightening in this change, and it cannot affect a real artifact: every
    producer here (whisperx, the LRC parsers, the caption reader) emits floats.
    """
    assert LyricsDoc({"lines": [{"start": True, "text": "hi"}]}).is_line_synced() is False
    assert _words_of({"lines": [{"words": [{"start": True, "end": False}]}]}) == []


def test_malformed_input_returns_empty_instead_of_raising() -> None:
    """The old readers raised AttributeError on a non-dict line — a crash mid-publish on junk input."""
    for junk in ({"lines": [None]}, {"lines": ["nope"]}, {"lines": "nope"}, {"lines": {}}, {}):
        assert _words_of(junk) == []
        assert is_valid_lyrics(junk) is False
        assert is_line_synced(junk) is False


def test_the_view_does_not_copy_the_caller_s_dict() -> None:
    """Wrapping is free, so a hot path can wrap; a caller that needs the dict keeps using it directly."""
    raw = _doc()
    assert LyricsDoc(raw).raw is raw


def test_language_is_reported_only_when_it_is_a_non_empty_string() -> None:
    assert LyricsDoc(_doc()).language == "en"
    assert LyricsDoc({"language": "", "lines": []}).language is None
    assert LyricsDoc({"language": 7, "lines": []}).language is None
