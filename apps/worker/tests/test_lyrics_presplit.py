"""Pre-splitting auto-transcribed blob text into lyric-sized lines, before the length bounder runs.

PURE: the upstream length-bounder is injected, so every case here runs with no karaoke-lyrics-processor
installed and no network. One test exercises the real package when it IS present, and skips otherwise.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.lyrics import presplit as lp  # noqa: E402
from src.lyrics.chain import (  # noqa: E402
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_WORD,
    LyricsText,
    is_authoritative_text,
)

# A synthetic one-line blob, shaped like what whisper `transcribe()` returns: several lyric lines run
# together. Original text, not a real song.
BLOB = (
    "I walked the empty harbour road, until the morning came around, and every light behind me "
    "faded out. So tell me where the river goes, when all the bridges burn."
)


def passthrough(lines, max_chars):
    """A bounder that bounds nothing — isolates OUR boundary logic from upstream's."""
    return lines


# ── the gate: only auto-transcribed text is touched ──────────────────────────────────
def test_is_authoritative_text_mirrors_the_ts_predicate():
    assert is_authoritative_text(SOURCE_LRCLIB, "high")
    assert is_authoritative_text(SOURCE_CAPTIONS, "medium")  # a real human caption track
    assert not is_authoritative_text(SOURCE_ASR, "high")  # ASR is never authoritative, however sure
    assert not is_authoritative_text(SOURCE_CAPTIONS, "low")  # auto-captions: ASR wearing a caption hat


def test_presplit_leaves_authoritative_text_completely_alone():
    # LRCLIB arrives line-broken by a human; a splitter can only damage it. Same object, not a copy.
    seg = [{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}]
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=seg, timing=TIMING_LINE, text_confidence="high")
    out = lp.presplit_texts([lrclib], bounder=passthrough)
    assert out[0] is lrclib


def test_presplit_splits_asr_and_low_confidence_captions():
    seg = [{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}]
    asr = LyricsText(text_source=SOURCE_ASR, segments=list(seg), timing=TIMING_LINE, text_confidence="low")
    auto_caps = LyricsText(
        text_source=SOURCE_CAPTIONS, segments=list(seg), timing=TIMING_LINE, text_confidence="low"
    )
    out = lp.presplit_texts([asr, auto_caps], bounder=passthrough)
    assert len(out[0].segments) > 1
    assert len(out[1].segments) > 1


# ── boundary_split: the half upstream measurably gets wrong ──────────────────────────
def test_splits_on_a_sentence_boundary():
    # upstream never does this at all — it produced "never made a sound. So tell me"
    assert lp.boundary_split("faded out. So tell me where it goes.") == [
        "faded out.",
        "So tell me where it goes.",
    ]


def test_breaks_BEFORE_a_conjunction_keeping_the_comma_behind():
    # THE upstream defect: it split after the comma, gluing "and" onto the previous line's tail.
    assert lp.boundary_split("until the morning came around, and every light faded") == [
        "until the morning came around,",
        "and every light faded",
    ]


@pytest.mark.parametrize("conj", ["and", "but", "so", "then", "or", "because", "'cause", "And", "BUT"])
def test_the_conjunction_set_is_case_insensitive(conj):
    assert lp.boundary_split(f"the bridges burn down tonight, {conj} I will wait for you") == [
        "the bridges burn down tonight,",
        f"{conj} I will wait for you",
    ]


def test_a_BARE_comma_is_SPENT_ONLY_on_a_line_that_does_not_fit():
    # A comma is weaker evidence than a sentence end or an opener, so it buys a break only where there
    # is a problem to solve. MEASURED on 171 real over-long ASR lines: using it took the share fully
    # resolved with no bisection from 3% to 47%. Whisper puts commas at breath boundaries in sung
    # vocals, so on real transcripts it usually IS the lyric line break.
    fits = "I walked the harbour road, alone"
    assert lp.boundary_split(fits) == [fits]  # 32 chars — one row, leave it whole
    assert lp.boundary_split("I walked the empty harbour road, until the morning came around again") == [
        "I walked the empty harbour road,",
        "until the morning came around again",
    ]


# ── capitalisation as a boundary (whisper marks phrase starts with case) ─────────────
def test_a_capitalised_OPENER_breaks_a_line_that_has_no_punctuation_at_all():
    # Real corpus shape: whisper omitted every comma but still capitalised each phrase start.
    assert lp.boundary_split("Don't you know I still believe That you will be here") == [
        "Don't you know",
        "I still believe",
        "That you will be here",
    ]


def test_a_capitalised_PROPER_NOUN_is_not_a_boundary():
    # Why `_LINE_OPENERS` is a closed set: splitting every lowercase->Capital transition would break
    # these two real-corpus lines mid-phrase. Neither "Africa" nor "London" opens a lyric line.
    assert lp.boundary_split("I bless the rains down in Africa tonight") == [
        "I bless the rains down in Africa tonight"
    ]
    assert lp.boundary_split("look me first rest to my fancy house in London town") == [
        "look me first rest to my fancy house in London town"
    ]


# ── coalescing fragments too short to hold a row ─────────────────────────────────────
def test_a_STRANDED_fragment_is_folded_into_the_phrase_it_opens():
    # Two individually-reasonable rules firing in sequence (", but" then a capital "I") stranded
    # "but still" on a 9-char row of its own, with "I lose my mind" beneath it.
    assert lp.boundary_split("I must confess, but still I lose my mind") == [
        "I must confess,",
        "but still I lose my mind",
    ]


def test_coalescing_never_reaches_across_a_full_STOP():
    # "faded out." is short but it is a real lyric line; gluing it to the next sentence because the pair
    # happens to fit would be a worse read, so coalescing is scoped per sentence.
    assert lp.boundary_split("faded out. So tell me where it goes.") == [
        "faded out.",
        "So tell me where it goes.",
    ]


def test_a_fragment_with_nowhere_to_fit_is_KEPT_not_dropped():
    # Neither neighbour can absorb it without blowing the row budget. Keeping a short row beats
    # deleting words from the screen.
    out = lp.boundary_split("I need to know right now this very moment. Oh. Tell me all about it please")
    assert "Oh." in out


def test_conservative_when_there_is_nothing_unambiguous_to_split_on():
    # Exactly the unpunctuated shape whisper returns. We add nothing; length bounding is upstream's job.
    line = "i walked the empty harbour road until the morning came around"
    assert lp.boundary_split(line) == [line]


def test_a_decimal_point_is_not_a_sentence_end():
    assert lp.boundary_split("we waited 3.5 hours") == ["we waited 3.5 hours"]


def test_empty_and_whitespace_yield_nothing():
    assert lp.boundary_split("") == []
    assert lp.boundary_split("   \n  ") == []


def test_the_full_blob_lands_on_its_real_lyric_lines():
    # Every break here is a true lyric boundary, and every line fits a row without upstream bisecting
    # anything — which is the whole point of doing the semantic pass BEFORE the length bounder.
    out = lp.boundary_split(BLOB)
    assert out == [
        "I walked the empty harbour road,",
        "until the morning came around,",
        "and every light behind me faded out.",
        "So tell me where the river goes,",
        "when all the bridges burn.",
    ]
    assert all(len(l) <= lp.MAX_LINE_CHARS for l in out)


# ── timing subdivision ───────────────────────────────────────────────────────────────
def test_subdivided_bounds_are_ordered_and_span_exactly_the_original_window():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 10.0, "end": 20.0, "text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    segs = lp.split_blob_text(asr, bounder=passthrough).segments
    assert len(segs) == 5
    assert segs[0]["start"] == 10.0
    assert segs[-1]["end"] == 20.0  # no drift: the pieces tile the original window
    for a, b in zip(segs, segs[1:]):
        assert a["end"] <= b["start"]  # contiguous and monotonic
        assert a["start"] < a["end"]


def test_a_segment_with_no_numeric_bounds_keeps_its_missing_bounds():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    segs = lp.split_blob_text(asr, bounder=passthrough).segments
    assert len(segs) == 5
    assert all(s["start"] is None and s["end"] is None for s in segs)


def test_a_WORD_TIMED_segment_is_passed_through_whole():
    # Splitting the text would orphan the word timings from the words they belong to. Measured: whisper
    # transcribe() returns no word timings, so this is a guard against a case that shouldn't arise.
    seg = {"start": 0.0, "end": 8.0, "text": BLOB, "words": [{"word": "I", "start": 0.0, "end": 0.2}]}
    asr = LyricsText(text_source=SOURCE_ASR, segments=[seg], timing=TIMING_WORD, text_confidence="low")
    assert lp.split_blob_text(asr, bounder=passthrough).segments == [seg]


def test_an_unsplittable_segment_is_left_as_the_SAME_object():
    seg = {"start": 0.0, "end": 4.0, "text": "i walked the empty harbour road", "words": []}
    asr = LyricsText(text_source=SOURCE_ASR, segments=[seg], timing=TIMING_LINE, text_confidence="low")
    assert lp.split_blob_text(asr, bounder=passthrough).segments == [seg]


def test_split_does_not_mutate_its_input_and_preserves_provenance():
    seg = [{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}]
    asr = LyricsText(
        text_source=SOURCE_ASR, segments=seg, timing=TIMING_LINE, text_confidence="low", language="en"
    )
    out = lp.split_blob_text(asr, bounder=passthrough)
    assert len(asr.segments) == 1  # input untouched
    assert (out.text_source, out.timing, out.text_confidence, out.language) == (
        SOURCE_ASR,
        TIMING_LINE,  # subdividing line-timed segments yields line-timed segments — still true
        "low",
        "en",
    )


# ── the upstream seam ────────────────────────────────────────────────────────────────
def test_the_bounder_receives_the_boundary_split_pieces_and_the_char_budget():
    seen = {}

    def spy(lines, max_chars):
        seen["lines"], seen["max_chars"] = lines, max_chars
        return lines

    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    lp.split_blob_text(asr, max_chars=42, bounder=spy)
    assert seen["max_chars"] == 42
    assert seen["lines"] == lp.boundary_split(BLOB)


def test_a_bounder_that_splits_further_is_honoured():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 0.0, "end": 6.0, "text": "one. two.", "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    out = lp.split_blob_text(asr, bounder=lambda lines, _m: [w for l in lines for w in l.split()])
    assert [s["text"] for s in out.segments] == ["one.", "two."]


def test_bound_lines_is_a_NO_OP_when_upstream_is_absent(monkeypatch):
    # The dependency is genuinely optional: the boundary split still ran, and the TV's LINE_MAX_CHARS
    # fallback still bounds a row. A missing package must not cost us the lineation we can do ourselves.
    monkeypatch.setattr(lp, "_KLP", None)
    lines = ["a line that upstream would otherwise have to bound because it is rather long indeed"]
    assert lp.bound_lines(lines) == lines


def test_a_raising_upstream_degrades_to_the_unbounded_lines(monkeypatch):
    class Exploding:
        def __init__(self, **_kw):
            raise RuntimeError("upstream changed its constructor")

    monkeypatch.setattr(lp, "_KLP", Exploding)
    assert lp.bound_lines(["some text"]) == ["some text"]


def test_max_line_chars_mirrors_the_tv_row_width():
    # LINE_MAX_CHARS in apps/core/src/lib/tv/lyrics.ts. Explicitly NOT upstream's default of 36.
    assert lp.MAX_LINE_CHARS == 42


# ── the real package, when installed ─────────────────────────────────────────────────
def test_real_upstream_bounds_an_over_long_line_and_isolates_parentheses():
    if lp._load_klp() is None:
        pytest.skip("karaoke-lyrics-processor is not installed (installed --no-deps in the image)")
    lines = lp.bound_lines(["and I will wait right here for you at seventeen (ooh, ooh)"], 42)
    assert all(len(l) <= 42 for l in lines)
    assert "(ooh, ooh)" in lines  # nested-paren isolation is the half upstream does well
    # and the handler it attaches to its module logger does not accumulate across calls
    import logging

    lp.bound_lines(["another line"], 42)
    assert len(logging.getLogger("karaoke_lyrics_processor.karaoke_lyrics_processor").handlers) == 0
