"""Measurement and placement, on hand-built documents.

These two modules are where a bad alignment becomes a NUMBER, so the policy's rules are only as good as
these are. Malformed input gets as much attention as well-formed: the aligner is a third-party model
wrapper, and a measurement that raises would turn a recoverable bad alignment into a failed job.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.measure import backwards_lines, line_spans, measure, timed_words
from encore_worker.domain.lyrics.place import (
    MIN_SHIFT_SEC,
    apply_shift,
    estimate_shift,
    residual_against,
)
from encore_worker.domain.lyrics.report import Engine


def doc(*lines: list[tuple[str, float, float]]) -> dict[str, object]:
    """A document from (word, start, end) triples per line."""
    return {
        "language": "en",
        "lines": [
            {
                "text": " ".join(w for w, _s, _e in line),
                "words": [{"word": w, "start": s, "end": e} for w, s, e in line],
            }
            for line in lines
        ],
    }


def seg(*spans: tuple[float, float]) -> list[dict[str, object]]:
    return [{"start": s, "end": e, "text": f"line at {s}"} for s, e in spans]


# ── measure ──────────────────────────────────────────────────────────────────────────────────────


def test_counts_words_and_spans_coverage() -> None:
    report = measure(doc([("a", 0.0, 0.4), ("b", 0.5, 0.9)], [("c", 1.0, 1.4)]), duration_sec=2.0)
    assert report.words == 3
    assert report.coverage == 0.7  # last end 1.4 over a 2.0s recording
    assert report.usable


def test_coverage_is_clamped_and_overshoot_carries_the_excess() -> None:
    """The clamp is why overshoot is a separate number: without it a text timed for a longer master
    reports a flawless 1.0 and the signal is lost."""
    report = measure(doc([("a", 0.0, 0.5), ("b", 240.0, 250.0)]), duration_sec=200.0)
    assert report.coverage == 1.0
    assert report.overshoot_sec == 50.0
    assert report.overshoots is True


def test_unknown_duration_reports_no_coverage_rather_than_guessing() -> None:
    """A duration of zero means nobody measured the recording. Reporting a defect would retry on a
    measurement that was never made."""
    report = measure(doc([("a", 0.0, 1.0)]), duration_sec=0.0)
    assert report.coverage == 0.0
    assert report.overshoot_sec == 0.0
    assert report.overshoots is False


def test_out_of_order_counts_backwards_starts_only() -> None:
    """An overlapping END is ordinary — a held note, a slur. A backwards START makes the highlight jump."""
    overlapping = measure(doc([("a", 0.0, 1.5), ("b", 1.0, 2.0)]), duration_sec=3.0)
    assert overlapping.out_of_order == 0
    assert overlapping.usable

    backwards = measure(doc([("a", 5.0, 5.5), ("b", 1.0, 1.5)]), duration_sec=10.0)
    assert backwards.out_of_order == 1
    assert not backwards.usable


def test_backwards_lines_locates_every_backwards_start_by_line() -> None:
    """`out_of_order`, located: one entry per backwards start, naming the line of the LATER word, so the
    count on the report and the lines on the trail cannot disagree. An untimed word is skipped, not
    compared, exactly as `measure` skips it."""
    inverted = doc(
        [("a", 1.0, 1.5), ("b", 2.0, 2.5)],
        [("c", 1.8, 2.2), ("d", 1.9, 2.4)],  # c starts before b: 1 backwards start, in line 1
        [("e", 3.0, 3.5)],
        [("f", 2.9, 3.1), ("g", 2.8, 3.0)],  # f before e, g before f: 2, both in line 3
    )
    inverted["lines"][2]["words"].append({"word": "untimed", "start": None})  # type: ignore[index]
    assert backwards_lines(inverted) == (1, 3, 3)
    assert len(backwards_lines(inverted)) == measure(inverted, duration_sec=5.0).out_of_order
    assert backwards_lines(doc([("a", 0.0, 1.5), ("b", 1.0, 2.0)])) == (), "an overlapping END is not one"


def test_gaps_smears_and_flashes() -> None:
    report = measure(
        doc([("held", 0.0, 6.0), ("flash", 20.0, 20.01), ("tail", 20.5, 21.0)]),
        duration_sec=30.0,
    )
    assert report.long_gaps == ((6.0, 20.0),)
    assert report.smeared[0][0] == "held"
    assert report.flashed[0][0] == "flash"
    assert report.usable, "defects are not disqualifications"


def test_smears_are_worst_first_so_the_summary_names_the_worst() -> None:
    report = measure(doc([("mild", 0.0, 3.5), ("awful", 4.0, 20.0)]), duration_sec=30.0)
    assert report.smeared[0][0] == "awful"
    assert "awful" in report.summary()


def test_an_overlap_is_not_counted_as_a_gap() -> None:
    """Measured end-to-start and forward only; a negative interval is an overlap."""
    report = measure(doc([("a", 0.0, 30.0), ("b", 1.0, 2.0)]), duration_sec=40.0)
    assert report.long_gaps == ()


# ── measure: a line-synced document (review M1) ──────────────────────────────────────────────────


def lines_doc(*spans: tuple[float, float | None]) -> dict[str, object]:
    """A LINE_SYNC document (`align_lines._line_doc`'s shape): timed lines, no words."""
    return {
        "language": "en",
        "lines": [{"text": f"line {i}", "start": s, "end": e} for i, (s, e) in enumerate(spans)],
    }


def test_a_line_document_is_measured_on_its_lines() -> None:
    """No words, so measured on words it read as nothing timed and could never commit (review M1)."""
    report = measure(
        lines_doc((1.0, 3.0), (4.0, 6.0), (7.0, 9.5)), duration_sec=10.0, engine=Engine.LINE_SYNC
    )

    assert (report.lines, report.words, report.out_of_order) == (3, 0, 0)
    assert report.coverage == pytest.approx(0.95), "the last line's end over the duration"
    assert report.overshoot_sec == 0.0
    assert report.engine is Engine.LINE_SYNC and report.usable


def test_a_line_that_starts_before_the_one_ahead_makes_the_document_incoherent() -> None:
    """A row that jumps backwards is as incoherent as a word that does: `usable` reads the line order.
    A caption track or an LRC whose cues are out of document order must not commit as line sync."""
    report = measure(
        lines_doc((1.0, 3.0), (6.0, 8.0), (4.0, 5.0)), duration_sec=10.0, engine=Engine.LINE_SYNC
    )

    assert report.out_of_order == 1
    assert not report.usable


def test_a_line_document_with_no_timed_line_is_not_usable() -> None:
    report = measure(
        {"lines": [{"text": "a"}, {"text": "b", "start": None}]}, duration_sec=10.0, engine=Engine.LINE_SYNC
    )

    assert report.lines == 0 and report.coverage == 0.0
    assert not report.usable


def test_a_line_document_reports_overshoot_and_long_gaps_but_no_word_defects() -> None:
    """Overshoot and silences keep their meaning one level up; smears and flashes are WORD defects, so a
    4-second line is not smeared and a line with no end is not a flash."""
    report = measure(
        lines_doc((0.0, 4.0), (20.0, 23.0), (23.0, None)), duration_sec=20.0, engine=Engine.LINE_SYNC
    )

    assert report.coverage == 1.0 and report.overshoot_sec == pytest.approx(3.0)
    assert report.long_gaps == ((4.0, 20.0),)
    assert report.smeared == () and report.flashed == ()


# ── measure: malformed input ──────────────────────────────────────────────────────────────────────


def test_an_empty_document_is_measured_not_rejected() -> None:
    report = measure({"lines": []}, duration_sec=100.0)
    assert report.words == 0
    assert not report.usable, "zero words cannot be published as word timing"


def test_survives_every_malformed_shape() -> None:
    """Each of these has been produced by a real aligner wrapper at some point. None may raise."""
    malformed: tuple[dict[str, object], ...] = (
        {},
        {"lines": None},
        {"lines": "nope"},
        {"lines": [None, 7, "x"]},
        {"lines": [{}]},
        {"lines": [{"words": None}]},
        {"lines": [{"words": [{"word": "a"}]}]},  # no timings
        {"lines": [{"words": [{"word": "a", "start": None, "end": 1.0}]}]},
        {"lines": [{"words": [{"word": "a", "start": True, "end": 1.0}]}]},  # bool, not a time
        {"lines": [{"words": [{"word": "a", "start": float("nan"), "end": 1.0}]}]},
        {"lines": [{"words": [{"word": "a", "start": float("inf")}]}]},
    )
    for bad in malformed:
        report = measure(bad, duration_sec=10.0)
        assert report.words == 0, f"{bad} should yield no timed words"


def test_an_end_before_its_start_is_clamped_not_dropped() -> None:
    """The token was still sung. Dropping it understates coverage; clamping shows it as a flash, which
    is what it looks like on screen."""
    words = timed_words({"lines": [{"words": [{"word": "a", "start": 5.0, "end": 1.0}]}]})
    assert words == [("a", 5.0, 5.0)]
    report = measure({"lines": [{"words": [{"word": "a", "start": 5.0, "end": 1.0}]}]}, duration_sec=10.0)
    assert report.words == 1
    assert report.flashed[0][0] == "a"


def test_a_word_with_no_end_takes_its_start() -> None:
    assert timed_words({"lines": [{"words": [{"word": "a", "start": 2.0}]}]}) == [("a", 2.0, 2.0)]


def test_text_key_is_accepted_as_well_as_word() -> None:
    """Aligner wrappers disagree about which key holds the token."""
    assert timed_words({"lines": [{"words": [{"text": "hi", "start": 0.0, "end": 1.0}]}]}) == [
        ("hi", 0.0, 1.0)
    ]


def test_line_spans_skips_untimed_segments() -> None:
    assert line_spans([{"start": 1.0, "end": 2.0}, {"text": "no timing"}, {"start": 3.0}]) == [
        (1.0, 2.0),
        (3.0, 3.0),
    ]


# ── placement ────────────────────────────────────────────────────────────────────────────────────


def test_estimates_a_constant_offset() -> None:
    """The sheet's master starts 5s earlier than this upload."""
    text = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0), (30.0, 31.0))
    reference = seg((5.0, 6.0), (15.0, 16.0), (25.0, 26.0), (35.0, 36.0))
    shift = estimate_shift(text, reference)
    assert shift.applied
    assert shift.offset_sec == 5.0
    assert shift.scale == 1.0
    assert shift.pairs == 4


def test_offset_uses_the_median_so_one_wild_line_cannot_drag_it() -> None:
    """An LRC commonly carries a stray chorus marker or trailing credit. A mean would follow it."""
    text = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0), (30.0, 31.0), (40.0, 41.0))
    reference = seg((2.0, 3.0), (12.0, 13.0), (22.0, 23.0), (32.0, 33.0), (999.0, 1000.0))
    shift = estimate_shift(text, reference)
    assert shift.applied
    assert abs(shift.offset_sec - 2.0) < 0.6, f"median should hold near 2.0, got {shift.offset_sec}"


def test_abstains_with_too_few_comparable_lines() -> None:
    """A wrong shift is worse than none: it moves a text that was already right."""
    shift = estimate_shift(seg((0.0, 1.0), (10.0, 11.0)), seg((5.0, 6.0), (15.0, 16.0)))
    assert not shift.applied
    assert "need 3" in shift.why


def test_a_shift_within_noise_is_not_applied() -> None:
    text = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0))
    nearly = seg((0.1, 1.1), (10.1, 11.1), (20.1, 21.1))
    shift = estimate_shift(text, nearly)
    assert not shift.applied
    assert abs(shift.offset_sec) < MIN_SHIFT_SEC
    assert "within noise" in shift.why


def test_an_implausible_scale_falls_back_to_offset_only() -> None:
    """Two masters differ by a few percent at most. A larger factor means the pairing is wrong, and an
    offset alone is still usually right."""
    text = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0), (30.0, 31.0))
    stretched = seg((0.0, 1.0), (40.0, 41.0), (80.0, 81.0), (120.0, 121.0))
    shift = estimate_shift(text, stretched)
    assert shift.scale == 1.0


def test_apply_shift_copies_and_clamps() -> None:
    """Copies because a TextRef is checkpointed: mutating would compound the offset on every replay."""
    original = seg((10.0, 11.0), (20.0, 21.0))
    moved = apply_shift(original, estimate_shift(original, seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0))))
    assert original[0]["start"] == 10.0, "the input must not be mutated"
    starts = [m["start"] for m in moved]
    assert all(isinstance(v, float) and v >= 0.0 for v in starts), "a negative playhead is not representable"


def test_apply_shift_is_identity_when_not_applied() -> None:
    from encore_worker.domain.lyrics.place import Shift

    original = seg((1.0, 2.0))
    assert apply_shift(original, Shift()) == tuple(original)


# ── residual ─────────────────────────────────────────────────────────────────────────────────────


def test_residual_measures_the_sheet_against_the_aligned_output() -> None:
    """The number that makes `Knob.RESHIFT` worth spending."""
    aligned = doc(
        [("a", 5.0, 5.5)],
        [("b", 15.0, 15.5)],
        [("c", 25.0, 25.5)],
        [("d", 35.0, 35.5)],
    )
    own = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0), (30.0, 31.0))
    assert residual_against(aligned, own) == 5.0


def test_residual_is_signed_so_early_and_late_are_distinguishable() -> None:
    aligned = doc([("a", 0.0, 0.5)], [("b", 10.0, 10.5)], [("c", 20.0, 20.5)])
    late_sheet = seg((5.0, 6.0), (15.0, 16.0), (25.0, 26.0))
    residual = residual_against(aligned, late_sheet)
    assert residual is not None and residual < 0


def test_residual_is_none_when_unanswerable() -> None:
    """ "Cannot tell" must not read as "misplaced", or every ASR text would spend a retry."""
    assert residual_against({"lines": []}, seg((0.0, 1.0), (1.0, 2.0), (2.0, 3.0))) is None
    assert residual_against(doc([("a", 0.0, 1.0)]), seg((0.0, 1.0))) is None


def test_residual_ignores_a_copied_through_line_start() -> None:
    """Some aligners copy the input's line `start` unchanged while moving the words inside it. Reading
    that field would make the residual read zero for exactly the misplacement being detected."""
    aligned = {
        "lines": [
            {"start": 0.0, "words": [{"word": "a", "start": 5.0, "end": 5.5}]},
            {"start": 10.0, "words": [{"word": "b", "start": 15.0, "end": 15.5}]},
            {"start": 20.0, "words": [{"word": "c", "start": 25.0, "end": 25.5}]},
        ]
    }
    own = seg((0.0, 1.0), (10.0, 11.0), (20.0, 21.0))
    assert residual_against(aligned, own) == 5.0, "must read the first TIMED WORD, not the line field"


# ── provisional spans for untimed text ────────────────────────────────────────────────────────────
#
# These cover a bug found only by running the real aligner: whisperx CROPS THE AUDIO PER SEGMENT, so an
# untimed segment raises `KeyError: 'start'` inside it. A plain lyrics sheet has no timings by definition, so
# before the fix every plain candidate was swallowed by the step's broad `except` and the song fell through
# to ASR, discarding a real human-written sheet. They are in the FAST suite because the functions are pure.


def test_needs_spans_detects_any_untimed_segment() -> None:
    """All-or-nothing: one untimed segment in an otherwise timed series is enough for whisperx to raise,
    and mixing measured spans with invented ones would make the document's timings mean two things."""
    from encore_worker.domain.lyrics.place import needs_spans

    assert needs_spans(({"text": "a"}, {"text": "b"})) is True
    assert needs_spans(({"start": 0.0, "text": "a"}, {"text": "b"})) is True, "one is enough"
    assert needs_spans(({"start": 0.0, "text": "a"}, {"start": 1.0, "text": "b"})) is False
    assert needs_spans(()) is False, "an empty series needs nothing"


def test_spread_over_covers_the_whole_duration() -> None:
    from encore_worker.domain.lyrics.place import spread_over

    spans = spread_over(({"text": "one"}, {"text": "two"}, {"text": "three"}), 30.0)
    assert float(spans[0]["start"]) == 0.0  # type: ignore[arg-type]
    assert float(spans[-1]["end"]) == 30.0, "the tail of the song must not be left uncovered"  # type: ignore[arg-type]


def test_spread_over_spans_abut_exactly() -> None:
    """A gap leaves a dead moment the aligner cannot search; an overlap double-crops the same audio."""
    from encore_worker.domain.lyrics.place import spread_over

    spans = spread_over(({"text": "aaa"}, {"text": "bbbbbb"}, {"text": "c"}), 12.0)
    for earlier, later in zip(spans, spans[1:], strict=False):
        assert earlier["end"] == later["start"]


def test_spread_over_apportions_by_character_share_not_evenly() -> None:
    """A six-word line occupies more of a song than a two-word one, so an even split is a worse prior."""
    from encore_worker.domain.lyrics.place import spread_over

    short, long = spread_over(({"text": "hi"}, {"text": "a considerably longer line of lyrics"}), 10.0)
    short_span = float(short["end"]) - float(short["start"])  # type: ignore[arg-type]
    long_span = float(long["end"]) - float(long["start"])  # type: ignore[arg-type]
    assert long_span > short_span


def test_spread_over_refuses_to_invent_against_an_unknown_duration() -> None:
    """Spans measured against a duration nobody knows would be worse than letting the aligner refuse."""
    from encore_worker.domain.lyrics.place import spread_over

    untimed = ({"text": "one"}, {"text": "two"})
    for unknown in (0.0, -5.0):
        assert spread_over(untimed, unknown) == untimed


def test_spread_over_preserves_other_keys_and_does_not_mutate() -> None:
    """The segments may be part of a checkpointed record, so mutating them would survive nothing."""
    from encore_worker.domain.lyrics.place import spread_over

    original = [{"text": "one", "romanization": "x"}, {"text": "two"}]
    spans = spread_over(original, 10.0)
    assert spans[0]["romanization"] == "x"
    assert "start" not in original[0], "the input must not be mutated"


def test_spread_over_handles_an_empty_line_without_dividing_by_zero() -> None:
    """A caption cue with a timestamp and no words reaches here occasionally."""
    from encore_worker.domain.lyrics.place import spread_over

    spans = spread_over(({"text": ""}, {"text": "real words"}), 10.0)
    assert len(spans) == 2
    assert float(spans[-1]["end"]) == 10.0  # type: ignore[arg-type]
