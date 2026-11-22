"""Re-lineation and singer attribution. Both pure, both about what a room actually sees.

Presplit exists because the ASR fallback is useless without it: whisper emits ~30-second VAD blobs, so an
unsplit transcript shows a paragraph that scrolls past before anyone can sing it. Attribution exists
because a duet in one colour is a duet nobody can follow.
"""

from __future__ import annotations

from encore_worker.domain.lyrics.attribute import (
    EXACT_PARTS,
    MIN_LINE_COVERAGE,
    MIN_MINORITY_SHARE,
    MIN_OVERLAP_FRACTION,
    attribute,
    speaker_count,
    speaker_for,
)
from encore_worker.domain.lyrics.presplit import (
    MAX_LINE_CHARS,
    MIN_LINE_CHARS,
    presplit_text,
    split_segment,
)

# ── presplit ─────────────────────────────────────────────────────────────────────────────────────


def seg(text: str, start: float = 0.0, end: float = 30.0) -> dict[str, object]:
    return {"start": start, "end": end, "text": text}


def test_a_short_line_is_left_alone() -> None:
    """A provider's sheet is already human-broken; splitting can only damage it."""
    original = seg("Hello darkness my old friend")
    assert split_segment(original) == [original]


def test_an_over_long_blob_is_split() -> None:
    blob = "I've come to talk with you again. Because a vision softly creeping."
    pieces = split_segment(seg(blob))
    assert len(pieces) > 1
    assert all(len(str(p["text"])) <= MAX_LINE_CHARS for p in pieces)


def test_it_breaks_at_a_full_stop_before_a_comma() -> None:
    """A full stop is a better line break than a comma, which beats a conjunction, which beats a space."""
    pieces = split_segment(seg("First sentence here, with a clause. Second sentence follows on."))
    assert str(pieces[0]["text"]).endswith(".")


def test_it_breaks_at_a_conjunction_when_there_is_no_punctuation() -> None:
    pieces = split_segment(seg("I walked the streets alone and then the morning came around"))
    assert len(pieces) == 2
    assert str(pieces[1]["text"]).lower().startswith("and then"), (
        "adjacent conjunctions each match the boundary, so 'and' would be split off as a 3-char scrap; "
        "merging it forward keeps it attached to the clause it introduces"
    )


def test_adjacent_conjunctions_do_not_produce_a_scrap() -> None:
    """The general form of the bug above: any piece too short to be a line folds into the next one."""
    for text in (
        "I walked the streets alone and then the morning came around",
        "She said nothing at all but then she turned and walked away",
        "Nothing was left of it so then we packed the whole thing up",
    ):
        pieces = split_segment(seg(text))
        assert all(len(str(p["text"])) >= MIN_LINE_CHARS for p in pieces), (
            f"{text!r} split into {[p['text'] for p in pieces]}"
        )


def test_timings_are_apportioned_by_character_share_not_evenly() -> None:
    """Splitting "yeah, and the whole chorus comes back" evenly would give the short piece half the span.
    By character share it gets the fraction its text actually occupies."""
    pieces = split_segment(seg("Yeah alright, the whole chorus comes round again now", 0.0, 10.0))
    assert len(pieces) == 2, f"expected one clean break, got {[p['text'] for p in pieces]}"
    first = float(pieces[0]["end"]) - float(pieces[0]["start"])  # type: ignore[arg-type]
    second = float(pieces[1]["end"]) - float(pieces[1]["start"])  # type: ignore[arg-type]
    assert second > first, "the longer text must get the longer span"
    assert abs((first + second) - 10.0) < 1e-9, "the pieces must tile the original span"


def test_the_pieces_tile_the_original_span_exactly() -> None:
    """No gap and no overlap: a gap shows as a dead moment on screen, an overlap as a double highlight."""
    pieces = split_segment(seg("One sentence ends here. Another begins right afterwards.", 5.0, 15.0))
    assert float(pieces[0]["start"]) == 5.0  # type: ignore[arg-type]
    assert float(pieces[-1]["end"]) == 15.0  # type: ignore[arg-type]
    for earlier, later in zip(pieces, pieces[1:], strict=False):
        assert earlier["end"] == later["start"], "pieces must abut exactly"


def test_a_long_line_with_nowhere_to_break_is_published_intact() -> None:
    """Better an over-long line than one cut mid-word."""
    unbreakable = "a" * 80
    assert split_segment(seg(unbreakable)) == [seg(unbreakable)]


def test_a_split_never_produces_a_scrap() -> None:
    """A two-character tail reads as a mistake rather than a lyric, so the longer line is kept."""
    for pieces in (
        split_segment(seg("This is a reasonably long line of lyrics ok")),
        split_segment(seg("Something quite long here and then no")),
    ):
        for piece in pieces:
            if len(pieces) > 1:
                assert len(str(piece["text"])) >= MIN_LINE_CHARS


def test_a_segment_with_no_usable_span_still_splits_the_text() -> None:
    """The pieces carry the original timing rather than a fabricated one — they still read better."""
    pieces = split_segment({"text": "One sentence ends here. Another begins right afterwards."})
    assert len(pieces) > 1
    assert all("start" not in p for p in pieces)


def test_presplit_text_processes_every_segment() -> None:
    out = presplit_text([seg("short one"), seg("One sentence ends here. Another begins afterwards.")])
    assert len(out) == 3


def test_presplit_preserves_other_keys() -> None:
    """A segment may carry fields this splitter knows nothing about; they must survive."""
    out = split_segment({**seg("One sentence ends here. Another begins afterwards."), "romanization": "x"})
    assert all(p.get("romanization") == "x" for p in out)


# ── attribution ──────────────────────────────────────────────────────────────────────────────────


def turn(speaker: str, start: float, end: float) -> dict[str, object]:
    return {"speaker": speaker, "start": start, "end": end}


def line(text: str, start: float, end: float) -> dict[str, object]:
    return {"text": text, "words": [{"word": text, "start": start, "end": end}]}


def test_a_line_is_attributed_to_whoever_sang_most_of_it() -> None:
    """Greatest overlap, not whoever started first: a line beginning just before a handover belongs to
    the voice that sang the rest of it, not the one that caught its first syllable."""
    turns = [turn("A", 0.0, 2.2), turn("B", 2.2, 10.0)]
    assert speaker_for((2.0, 8.0), turns) == "B"


def test_incidental_overlap_does_not_attribute() -> None:
    """A held note bleeding past a handover would otherwise flip the colour mid-phrase."""
    turns = [turn("A", 0.0, 5.2), turn("B", 5.2, 6.0)]
    assert speaker_for((5.0, 10.0), turns) is None


def test_the_overlap_threshold_is_a_majority() -> None:
    assert MIN_OVERLAP_FRACTION >= 0.5, "a line should belong to whoever sang most of it"


def test_a_line_no_turn_covers_is_left_unknown() -> None:
    """None means unknown, never "the first speaker" — a confidently wrong colour is worse than neutral."""
    assert speaker_for((100.0, 110.0), [turn("A", 0.0, 5.0)]) is None


def test_a_zero_length_line_is_unknown_not_attributed() -> None:
    assert speaker_for((5.0, 5.0), [turn("A", 0.0, 10.0)]) is None


def test_a_solo_song_is_returned_unchanged() -> None:
    """One speaker everywhere is noise on the wire and a pointless colour lookup on the TV."""
    doc = {"language": "en", "lines": [line("hello", 0.0, 1.0)]}
    assert attribute(doc, [turn("SPEAKER_00", 0.0, 10.0)]) is doc


def test_no_turns_at_all_returns_the_document_unchanged() -> None:
    doc = {"language": "en", "lines": [line("hello", 0.0, 1.0)]}
    assert attribute(doc, []) is doc


def test_a_duet_gets_an_abstract_part_per_line() -> None:
    """The TV reads `part`, never `speaker`, so this is the field that reaches a screen. The
    diarizer's own strings stay off the wire: parts are lettered by FIRST APPEARANCE."""
    doc = {
        "language": "en",
        "lines": [line("mine", 0.0, 2.0), line("yours", 6.0, 8.0), line("ours", 100.0, 101.0)],
    }
    out = attribute(doc, [turn("SPEAKER_01", 0.0, 4.0), turn("SPEAKER_00", 5.0, 9.0)])
    lines = out["lines"]
    assert isinstance(lines, list)
    assert [ln.get("part") for ln in lines] == ["A", "B", None], "a line no turn covers stays unattributed"
    assert not any("speaker" in ln for ln in lines), "the diarizer's label is not the wire's"


def test_the_parts_do_not_depend_on_the_diarizers_strings() -> None:
    """A re-run whose diarizer numbers the voices the other way round still colours the song the same."""
    doc = {"lines": [line("mine", 0.0, 2.0), line("yours", 6.0, 8.0)]}
    one = attribute(doc, [turn("SPEAKER_00", 0.0, 4.0), turn("SPEAKER_01", 5.0, 9.0)])
    other = attribute(doc, [turn("SPEAKER_01", 0.0, 4.0), turn("SPEAKER_00", 5.0, 9.0)])
    assert one == other
    assert one is not doc


def _reel(owners: str) -> tuple[dict[str, object], list[dict[str, object]]]:
    """A song of one-second lines ten seconds apart, and turns in which `owners[i]` sings line i (`.` for a
    line no turn covers)."""
    lines = [line(f"l{i}", 10.0 * i, 10.0 * i + 1.0) for i in range(len(owners))]
    turns = [turn(who, 10.0 * i, 10.0 * i + 1.0) for i, who in enumerate(owners) if who != "."]
    return {"lines": lines}, turns


def test_an_over_segmented_solo_is_left_one_colour() -> None:
    """Not exactly two parts among the attributed lines is not a duet: pyannote on sung vocals
    over-segments one singer into phantom voices, and the TV would paint each its own colour."""
    doc, turns = _reel("AABBCCAABB")
    assert attribute(doc, turns) is doc


def test_a_lopsided_song_is_a_solo_with_stray_lines() -> None:
    """The minority part must own at least `MIN_MINORITY_SHARE` of the attributed lines."""
    doc, turns = _reel("AAAAAAAAAB")  # 1 of 10 < 0.15
    assert attribute(doc, turns) is doc
    real_second_voice, second_turns = _reel("AAAAAAAABB")  # 2 of 10
    assert attribute(real_second_voice, second_turns) is not real_second_voice
    assert MIN_MINORITY_SHARE < 0.5, "well below an even split, so a lead with a backing voice passes"


def test_a_thinly_covered_song_is_not_attributed_at_all() -> None:
    """Below `MIN_LINE_COVERAGE` of the lines the diarizer has not heard enough of the song to trust it
    about the rest, and a half-coloured reel is the one outcome the fallback exists to prevent."""
    doc, turns = _reel("AB........")
    assert attribute(doc, turns) is doc
    covered, covered_turns = _reel("ABABAB....")  # 6 of 10 = MIN_LINE_COVERAGE
    assert attribute(covered, covered_turns) is not covered
    assert MIN_LINE_COVERAGE == 0.6
    assert EXACT_PARTS == 2


def test_attribution_does_not_mutate_the_input() -> None:
    """The doc may be a checkpointed value; mutating it would survive nothing."""
    first, second = line("mine", 0.0, 2.0), line("yours", 6.0, 8.0)
    doc = {"language": "en", "lines": [first, second]}
    out = attribute(doc, [turn("A", 0.0, 4.0), turn("B", 5.0, 9.0)])
    assert out is not doc, "attributed, so the check below is about the input and not a no-op"
    assert "part" not in first and "part" not in second


def test_it_reads_word_spans_over_the_lines_own_bounds() -> None:
    """Some aligners copy the input's line bounds through unchanged, so trusting those would attribute
    against the pre-alignment timing."""
    doc = {
        "lines": [
            {"start": 0.0, "end": 1.0, "words": [{"word": "late", "start": 6.0, "end": 8.0}]},
            {"start": 0.0, "end": 1.0, "words": [{"word": "early", "start": 0.5, "end": 2.0}]},
            {"start": 0.0, "end": 1.0, "words": [{"word": "later", "start": 6.5, "end": 8.5}]},
        ]
    }
    out = attribute(doc, [turn("A", 0.0, 4.0), turn("B", 5.0, 9.0)])
    lines = out["lines"]
    assert isinstance(lines, list)
    # Read from the WORDS: lines 0 and 2 sit in B's turn, line 1 in A's. By their own (copied) bounds all
    # three would be A's, one voice, and the song would not be attributed at all.
    assert [ln["part"] for ln in lines] == ["A", "B", "A"]


def test_a_malformed_document_is_survived() -> None:
    for bad in ({}, {"lines": None}, {"lines": "nope"}, {"lines": [None, 7]}):
        attribute(bad, [turn("A", 0.0, 1.0), turn("B", 1.0, 2.0)])  # must not raise


def test_speaker_count_ignores_unlabelled_turns() -> None:
    assert speaker_count([turn("A", 0, 1), turn("B", 1, 2), {"start": 2, "end": 3}]) == 2
