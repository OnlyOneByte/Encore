"""Pure attribution tests: diarization segments → a `part` label on each lyric line.

Every test here reds without `src/diarize/attribution.py`. The module's whole job is the owner's
"multiple layers of checks to see if it is [a duet]" ruling (2026-09-07): a confident duet gets
abstract `part` letters on its lines; everything else — solo, sparse, lopsided, over-segmented —
falls back to NO attribution, which the render layer reads as one colour. These pin both directions.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.diarize import attribute_parts  # noqa: E402
from src.diarize.attribution import MAX_PARTS, MIN_LINE_COVERAGE, MIN_MINORITY_SHARE  # noqa: E402


def _doc(n: int, dur: float = 1.0, gap: float = 0.0) -> dict:
    """A word-timed doc of `n` back-to-back lines, each `dur` long with `gap` between them."""
    lines = []
    t = 0.0
    for i in range(n):
        start, end = t, t + dur
        lines.append(
            {
                "start": start,
                "end": end,
                "text": f"line {i}",
                "words": [{"word": f"w{i}", "start": start, "end": end}],
            }
        )
        t = end + gap
    return {"language": "en", "lines": lines, "words": [w for ln in lines for w in ln["words"]]}


def _seg(start: float, end: float, speaker: str) -> dict:
    return {"start": start, "end": end, "speaker": speaker}


def test_confident_duet_gets_abstract_part_letters():
    """The load-bearing positive case: two speakers, alternating cleanly across the whole reel, gets
    stable `A`/`B` parts by first appearance."""
    doc = _doc(4)  # lines at [0,1] [1,2] [2,3] [3,4]
    diar = [
        _seg(0.0, 1.0, "SPEAKER_01"),
        _seg(1.0, 2.0, "SPEAKER_00"),
        _seg(2.0, 3.0, "SPEAKER_01"),
        _seg(3.0, 4.0, "SPEAKER_00"),
    ]
    out = attribute_parts(doc, diar)
    parts = [ln.get("part") for ln in out["lines"]]
    # Abstract letters assigned by FIRST appearance (SPEAKER_01 first → "A"), not by the diarizer's
    # own numbering, so the label set is {A,B} and a re-cook is stable.
    assert parts == ["A", "B", "A", "B"]
    # Pure: the input is not mutated.
    assert "part" not in doc["lines"][0]


def test_single_speaker_falls_back_to_one_colour():
    """Layer 1: one voice → no parts, i.e. exactly today's single-colour behaviour."""
    doc = _doc(4)
    diar = [_seg(0.0, 4.0, "SPEAKER_00")]
    out = attribute_parts(doc, diar)
    assert all("part" not in ln for ln in out["lines"])


def test_no_diarization_leaves_the_doc_untouched():
    """The undiarized path (empty / None): the doc comes back byte-identical, no `part` anywhere."""
    doc = _doc(3)
    assert all("part" not in ln for ln in attribute_parts(doc, [])["lines"])
    assert all("part" not in ln for ln in attribute_parts(doc, None)["lines"])


def test_sparse_coverage_falls_back_to_one_colour():
    """Layer 2: two speakers exist but they only overlap a MINORITY of lines — not trustworthy enough
    to colour the reel, so single colour."""
    doc = _doc(10, gap=5.0)  # lines every 6s: [0,1],[6,7],[12,13],...
    # Only the first two lines are covered by diarization (2/10 < MIN_LINE_COVERAGE).
    diar = [_seg(0.0, 1.0, "SPEAKER_00"), _seg(6.0, 7.0, "SPEAKER_01")]
    assert MIN_LINE_COVERAGE > 0.2  # guard the premise of this test
    out = attribute_parts(doc, diar)
    assert all("part" not in ln for ln in out["lines"])


def test_over_segmentation_into_three_voices_falls_back():
    """Layer 3: overlapping sung vocals routinely over-segment into 3+ phantom speakers; more than
    MAX_PARTS is treated as not-confident and takes the single-colour fallback, not a rainbow."""
    assert MAX_PARTS == 2
    doc = _doc(3)
    diar = [_seg(0.0, 1.0, "S0"), _seg(1.0, 2.0, "S1"), _seg(2.0, 3.0, "S2")]
    out = attribute_parts(doc, diar)
    assert all("part" not in ln for ln in out["lines"])


def test_lopsided_split_is_treated_as_a_solo():
    """Layer 4: two speakers, but the minority owns only one line out of many — a solo with one stray
    mislabelled segment must NOT light up as a duet (the 'never a half-coloured reel' ruling)."""
    doc = _doc(10)  # 10 covered lines
    diar = [_seg(0.0, 9.0, "S0"), _seg(9.0, 10.0, "S1")]  # S1 owns 1/10 < MIN_MINORITY_SHARE
    assert MIN_MINORITY_SHARE > 0.1
    out = attribute_parts(doc, diar)
    assert all("part" not in ln for ln in out["lines"])


def test_untrusted_diarization_rows_are_dropped_not_raised():
    """Model output is untrusted, like every seam in this worker: malformed rows are dropped, and if
    what remains is a clean two-speaker split the attribution still succeeds."""
    doc = _doc(4)
    diar = [
        {"start": "nope", "end": 1.0, "speaker": "S0"},  # non-finite start → dropped
        _seg(2.0, 1.0, "S0"),  # end <= start → dropped
        {"start": 0.0, "end": 1.0},  # no speaker → dropped
        _seg(0.0, 2.0, "S0"),
        _seg(2.0, 4.0, "S1"),
    ]
    parts = [ln.get("part") for ln in attribute_parts(doc, diar)["lines"]]
    assert parts == ["A", "A", "B", "B"]


def test_a_line_no_segment_overlaps_carries_no_part_inside_a_duet():
    """Inside a confident duet, a line diarization did not cover carries NO part (not a guess); the
    render layer holds the previous colour, which reads better than a wrong one."""
    doc = _doc(5)  # lines [0,1]..[4,5]
    # Middle line [2,3] falls in a diarization gap; the other four alternate cleanly.
    diar = [
        _seg(0.0, 1.0, "S0"),
        _seg(1.0, 2.0, "S1"),
        _seg(3.0, 4.0, "S0"),
        _seg(4.0, 5.0, "S1"),
    ]
    parts = [ln.get("part") for ln in attribute_parts(doc, diar)["lines"]]
    assert parts == ["A", "B", None, "A", "B"]


def test_empty_lines_doc_is_returned_unchanged():
    assert attribute_parts({"lines": []}, [_seg(0, 1, "a"), _seg(1, 2, "b")]) == {"lines": []}
