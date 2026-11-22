"""Global timing generation: the grouping logic, hermetic — no torch, no audio.

The DECODER IS INJECTED (`generate(..., decoder=...)`), so these tests drive the char→syllable→word→line
regrouping with hand-built frame labels and assert the structural invariant that has no ground truth to
score against: syllables nest within their word's span, words within their line's, all ordered. Real-audio
accuracy lives in docs/benchmarks/forced-alignment; these tests exist so a refactor that breaks
construction is caught by the property, not by a benchmark regression.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import pytest

from encore_worker.domain.lyrics.generate import Decoder, Generated, Line, generate

#: A toy dictionary: a=1 b=2 ... (0 is CTC blank, deliberately unassigned).
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}


@dataclass(frozen=True)
class FakeEmissions:
    log_probs: object
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)  # type: ignore[arg-type]


#: `generate.Decoder`'s shape, as the fakes implement it — `blank` included, so a fake cannot pass a
#: test that exists to prove the caller reads the matrix's blank column.
Decode = Decoder


def scripted_decoder(placements: dict[int, tuple[int, int]], total_frames: int) -> Decode:
    """A decoder that puts each target index at scripted frames: target i occupies placements[i]."""

    def decode(_log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        labels = [blank] * total_frames
        scores = [0.0] * total_frames
        for i, token in enumerate(targets):
            start, end = placements[i]
            for f in range(start, end):
                labels[f] = token
                scores[f] = -0.5
        return labels, scores

    return decode


def evenly(targets_count: int, frames_per: int = 3, gap: int = 2) -> dict[int, tuple[int, int]]:
    out = {}
    cursor = 0
    for i in range(targets_count):
        out[i] = (cursor, cursor + frames_per)
        cursor += frames_per + gap
    return out


def gen(
    lines: list[str],
    placements: dict[int, tuple[int, int]] | None = None,
    frames: int = 4000,
    syllabifier: Callable[[str, str], list[str]] | None = None,
) -> Generated:
    count = sum(1 for line in lines for w in line.split() for c in w.lower() if DIC.get(c))
    placements = placements or evenly(count)
    em = FakeEmissions(log_probs=[0.0] * frames, frame_sec=0.02, dictionary=DIC)
    return generate(
        lines,
        em,
        decoder=scripted_decoder(placements, frames),
        syllabifier=syllabifier or (lambda w, _l: [w]),
    )


# ── the structural invariant ─────────────────────────────────────────────────────────────────────


def test_syllables_nest_in_words_nest_in_lines_all_ordered() -> None:
    """THE invariant. No syllable ground truth exists anywhere (caption tracks are line-level), so nesting
    and order are what MAKE syllable output trustworthy: every level groups the same char spans."""

    def two_way(word: str, _lang: str) -> list[str]:
        mid = max(1, len(word) // 2)
        return [word[:mid], word[mid:]] if len(word) > 2 else [word]

    doc = gen(["come and fly away", "with me tonight"], syllabifier=two_way)
    assert len(doc.lines) == 2
    previous_line_end = -1.0
    for line in doc.lines:
        assert line.start >= previous_line_end
        previous_line_end = line.end
        previous_word_end = None
        for word in line.words:
            assert line.start <= word.start <= word.end <= line.end
            if previous_word_end is not None:
                assert word.start >= previous_word_end
            previous_word_end = word.end
            previous_syl_end = None
            for syl in word.syllables:
                assert word.start <= syl.start <= syl.end <= word.end
                if previous_syl_end is not None:
                    assert syl.start >= previous_syl_end
                previous_syl_end = syl.end


def test_syllable_texts_concatenate_to_the_word() -> None:
    doc = gen(["away"], syllabifier=lambda w, _l: [w[:1], w[1:]])
    word = doc.lines[0].words[0]
    assert "".join(s.text for s in word.syllables) == "away"


def test_a_single_syllable_word_carries_no_syllable_list() -> None:
    """One syllable adds no information over the word span, and the doc convention is to OMIT rather than
    repeat — the same reason an optional wire field is omitted, not null."""
    doc = gen(["fly"])
    assert doc.lines[0].words[0].syllables == ()


# ── line identity survives drops ─────────────────────────────────────────────────────────────────


def test_a_line_with_no_alignable_chars_is_dropped_but_identity_survives() -> None:
    """MEASURED FAILURE, not hypothetical: tfr-chosen's first authored caption is '♪' — zero alignable
    chars — and matching output to input BY POSITION after the drop scored every later line against the
    wrong truth row, reading as bias +5140 ms. The line's `index` is how a caller maps back."""
    doc = gen(["♪", "come and fly", "☆彡"])
    assert [line.index for line in doc.lines] == [1]
    assert doc.lines[0].text == "come and fly"


# ── OOV handling ─────────────────────────────────────────────────────────────────────────────────


def test_an_oov_word_is_interpolated_between_its_neighbours_and_flagged() -> None:
    """A run of digits or a non-Latin token degrades ONE word rather than failing the line — and it says
    so, because an interpolated span presented as an aligned one would be a silent lie."""
    doc = gen(["come 999 fly"])
    words = doc.lines[0].words
    assert [w.word for w in words] == ["come", "999", "fly"]
    oov = words[1]
    assert oov.provenance == "low"
    assert words[0].end <= oov.start <= oov.end <= words[2].start


def test_a_wholly_unalignable_line_produces_nothing_rather_than_an_invented_span() -> None:
    doc = gen(["12345 678"])
    assert doc.lines == ()


# ── the decode contract ──────────────────────────────────────────────────────────────────────────


def test_blank_id_characters_are_excluded_from_targets() -> None:
    """The English dictionary maps `-` to id 0, which is ALSO CTC's blank, and forced_align refuses a
    target list containing it. Measured on the real model; pinned here with a dictionary that does the
    same."""
    dic = dict(DIC)
    dic["-"] = 0
    em = FakeEmissions(log_probs=[0.0] * 100, frame_sec=0.02, dictionary=dic)
    seen: list[list[int]] = []

    def spy(_lp: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        seen.append(list(targets))
        labels, scores = scripted_decoder(evenly(len(targets)), 100)(_lp, targets, blank)
        return list(labels), list(scores)

    generate(["fly-away"], em, decoder=spy, syllabifier=lambda w, _l: [w])
    assert seen and 0 not in seen[0]


def test_a_span_count_mismatch_is_an_error_not_a_degradation() -> None:
    """One span per target is forced_align's contract; anything else means the matrix and the encoding
    disagree, and grouping on top of that would misattribute every following char."""

    def broken(_lp: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        return [blank] * 10, [0.0] * 10  # no spans at all for non-empty targets

    em = FakeEmissions(log_probs=[0.0] * 10, frame_sec=0.02, dictionary=DIC)
    with pytest.raises(ValueError, match="token spans"):
        generate(["fly"], em, decoder=broken, syllabifier=lambda w, _l: [w])


def test_empty_text_or_empty_audio_yield_an_empty_document() -> None:
    em = FakeEmissions(log_probs=[], frame_sec=0.0, dictionary=DIC)
    assert generate(["fly"], em, decoder=lambda *_: ([], []), syllabifier=lambda w, _l: [w]).lines == ()
    em2 = FakeEmissions(log_probs=[0.0] * 10, frame_sec=0.02, dictionary=DIC)
    assert generate([], em2, decoder=lambda *_: ([], []), syllabifier=lambda w, _l: [w]).lines == ()


# ── the wire shape ───────────────────────────────────────────────────────────────────────────────


def test_the_doc_shape_matches_the_core_contract_with_optional_syllables() -> None:
    doc = gen(["fly away"], syllabifier=lambda w, _l: [w[:2], w[2:]] if len(w) > 3 else [w]).as_doc()
    assert set(doc) == {"language", "lines"}
    line = doc["lines"][0]
    assert set(line) == {"text", "start", "end", "words"}
    with_syl = [w for w in line["words"] if "syllables" in w]
    without = [w for w in line["words"] if "syllables" not in w]
    assert with_syl and without, "syllables must be optional per word, not all-or-nothing"
    assert all(set(s) == {"text", "start", "end"} for w in with_syl for s in w["syllables"])


# ── windowed repair (`regenerate`) ───────────────────────────────────────────────────────────────


def slice_decoder(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
    """Places targets from the START of whatever slice it is given — how a window re-decode behaves."""
    labels = [blank] * len(log_probs)  # type: ignore[arg-type]
    scores = [-0.5] * len(labels)
    for i, token in enumerate(targets):
        for f in range(i * 3, min(i * 3 + 2, len(labels))):
            labels[f] = token
    return labels, scores


def test_regenerate_decodes_inside_the_window_and_shifts_back_to_song_time() -> None:
    """The repair primitive: a line re-decoded in a 2–8 s window must come back ON THE SONG'S CLOCK, with
    its identity (`index`) intact — a repair that returned slice-relative times would corrupt every
    consumer downstream."""
    from encore_worker.domain.lyrics.generate import regenerate

    doc = gen(["fly away"])
    em = FakeEmissions(log_probs=[0.0] * 4000, frame_sec=0.02, dictionary=DIC)
    repaired = regenerate([(doc.lines, (2.0, 8.0))], em, decoder=slice_decoder, syllabifier=lambda w, _l: [w])
    assert set(repaired) == {0}
    line = repaired[0]
    assert line.index == 0
    assert abs(line.start - 2.0) < 0.1, "slice-relative times must be shifted by the window start"
    assert 2.0 <= line.start <= line.end <= 8.0
    for word in line.words:
        assert 2.0 <= word.start <= word.end <= 8.0


def test_a_window_too_tight_for_the_text_is_skipped_not_forced() -> None:
    """CTC needs frames to put chars in; forcing seven chars into five frames is a smear, not a repair."""
    from encore_worker.domain.lyrics.generate import regenerate

    doc = gen(["fly away"])
    em = FakeEmissions(log_probs=[0.0] * 4000, frame_sec=0.02, dictionary=DIC)
    assert regenerate([(doc.lines, (0.0, 0.1))], em, decoder=slice_decoder) == {}


def test_a_failing_window_decode_keeps_the_original() -> None:
    """A repair that can throw away a working timing is worse than no repair."""
    from encore_worker.domain.lyrics.generate import regenerate

    def broken(_lp: object, _targets: Sequence[int], _blank: int = 0) -> tuple[list[int], list[float]]:
        raise RuntimeError("window decode fault")

    doc = gen(["fly away"])
    em = FakeEmissions(log_probs=[0.0] * 4000, frame_sec=0.02, dictionary=DIC)
    assert regenerate([(doc.lines, (2.0, 8.0))], em, decoder=broken) == {}


def test_a_raising_window_decode_is_reported_while_the_other_runs_still_repair() -> None:
    """Kept originals, but COUNTED: a swallowed exception looked exactly like a repair nobody needed.
    A window that is merely too tight is a skip, not a fault, and is not reported."""
    from encore_worker.domain.lyrics.generate import regenerate

    doc = gen(["fly away", "come home", "stay"])
    fly, home, stay = doc.lines

    def fails_on_fly(
        log_probs: object, targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        if len(targets) == len("flyaway"):
            raise RuntimeError("window decode fault")
        return slice_decoder(log_probs, targets, blank)

    em = FakeEmissions(log_probs=[0.0] * 4000, frame_sec=0.02, dictionary=DIC)
    faults: list[str] = []
    repaired = regenerate(
        [((fly,), (2.0, 8.0)), ((home,), (10.0, 16.0)), ((stay,), (20.0, 20.1))],
        em,
        decoder=fails_on_fly,
        faults=faults,
    )
    assert set(repaired) == {home.index}, "the faulting and the too-tight runs keep their originals"
    assert faults == ["RuntimeError: window decode fault"]


# ── the onset lead ───────────────────────────────────────────────────────────────────────────────


def test_lead_pulls_starts_back_but_never_past_the_previous_span() -> None:
    """MEASURED on 5693 hand-timed words: the decode starts +41 ms late everywhere while ends run early,
    so starts are pulled back (toward the true onset) and clamped at the previous span's end — the clamp
    is what preserves the non-overlap invariant every grouping level inherits."""
    from encore_worker.domain.lyrics.generate import _lead_starts

    spans = [(1.00, 1.20, -0.5), (1.22, 1.40, -0.5), (2.00, 2.30, -0.5)]
    led = _lead_starts(spans, 0.04)
    assert led[0] == (0.96, 1.20, -0.5), "a free onset moves the full lead"
    assert led[1] == (1.20, 1.40, -0.5), "an interior span clamps at its predecessor's end"
    assert led[2] == (1.96, 2.30, -0.5), "a span after a gap moves the full lead"
    for (_s0, e0, _sc0), (s1, _e1, _sc1) in zip(led, led[1:], strict=False):
        assert s1 >= e0 - 1e-9, "no overlaps introduced"


def test_lead_never_produces_a_negative_or_inverted_span() -> None:
    from encore_worker.domain.lyrics.generate import _lead_starts

    led = _lead_starts([(0.01, 0.05, -0.5)], 0.04)
    assert led[0][0] == 0.0
    led2 = _lead_starts([(1.0, 1.01, -0.5), (1.01, 1.02, -0.5)], 0.04)
    assert all(s <= e for s, e, _sc in led2)


# ── `trimmed`: the one geometric operation the bounded clamp needs (`align_geometry._pulled_end`) ──


def a_line(*words: tuple[str, float, float], start: float, end: float) -> Line:
    from encore_worker.domain.lyrics.generate import Word

    return Line(
        text=" ".join(w for w, _s, _e in words),
        start=start,
        end=end,
        words=tuple(Word(word=w, start=s, end=e, score=-0.5) for w, s, e in words),
        score=-0.5,
        index=3,
    )


def test_trimmed_keeps_every_onset_before_the_boundary_and_re_fits_only_the_tail() -> None:
    """The property `remapped` does not have, and the reason `trimmed` exists beside it: the onsets the
    decode measured before the new end were measurements and survive, so a trimmed neighbour costs the word
    metrics nothing where it was right (20 Jamendo songs at truth: word ±100 83.52 against an affine
    re-fit's 83.12 and the prior row's 83.25; see the docstring for the rest)."""
    from encore_worker.domain.lyrics.generate import remapped, trimmed

    line = a_line(("a", 1.0, 2.0), ("b", 2.0, 3.0), ("c", 3.0, 5.0), start=1.0, end=5.0)
    got = trimmed(line, 2.5, frame_sec=0.02)
    assert got is not None
    assert (got.start, got.end) == (1.0, 2.5)
    assert (got.text, got.index, got.score) == (line.text, line.index, line.score)
    # The ANCHOR is 'b', the last word starting before 2.5. 'a' and 'b' keep their onsets; the sub-series
    # after the anchor — 'b's end and 'c' — is re-fitted into [2.0, 2.5].
    assert [w.start for w in got.words] == pytest.approx([1.0, 2.0, 2.1666667]), "'a' and 'b' do not move"
    assert got.words[-1].end == pytest.approx(2.5), "the tail ends where the line now does"
    affine = remapped(line, line.start, 2.5)
    assert [w.start for w in affine.words] == pytest.approx([1.0, 1.375, 1.75]), "what this replaces"


def test_trimmed_never_moves_the_first_onset_so_it_cannot_invert_against_its_predecessor() -> None:
    """`align_geometry._pulled_end` carried an order guard against exactly this while it used `remapped`
    (measured at 0 firings on the corpus); `trimmed` makes it unreachable. Leading silence is the shape:
    affine pulls the first word back toward the line's start, this does not move it at all."""
    from encore_worker.domain.lyrics.generate import remapped, trimmed

    line = a_line(("a", 4.0, 6.0), ("b", 6.0, 9.0), start=3.0, end=9.0)
    got = trimmed(line, 4.5, frame_sec=0.02)
    assert got is not None and got.words[0].start == 4.0
    assert min(w.start for w in got.words) == 4.0
    assert got.words[1].start == pytest.approx(4.2), "the tail moves, as trimming must"
    assert remapped(line, line.start, 4.5).words[0].start == pytest.approx(3.25), "affine moves it earlier"
    assert all(b.start >= a.start for a, b in zip(got.words, got.words[1:], strict=False)), (
        "and the map is monotone, so internal order survives"
    )


def test_trimmed_refuses_a_line_no_word_of_which_starts_before_the_boundary() -> None:
    """None, not a degenerate line: a line whose every word starts after the new end was not sung before
    it, so there is nothing to keep. The caller falls back to its own rule."""
    from encore_worker.domain.lyrics.generate import trimmed

    line = a_line(("a", 5.0, 7.0), ("b", 7.0, 9.0), start=1.0, end=9.0)
    assert trimmed(line, 4.0, frame_sec=0.02) is None
    assert trimmed(line, 5.0, frame_sec=0.02) is None, (
        "a word starting exactly AT the boundary is not before it"
    )
    assert trimmed(line, 5.5, frame_sec=0.02) is not None
    assert trimmed(a_line(start=1.0, end=9.0), 4.0, frame_sec=0.02) is None, (
        "and a wordless line has nothing to keep"
    )


def test_trimmed_walks_the_anchor_back_rather_than_collapsing_the_tail_into_a_millisecond() -> None:
    """The boundary a hair past a word start is the shape: with 19.999 as the anchor the
    three words after it were published at 19.99920 / 19.99945 / 19.99980, four words inside 0.8 ms — none of
    them liftable by the TV (`start <= pos < end`) and none within a decoder frame of a measurement. The
    anchor walks back to the last word whose tail can hold one frame per word still to be placed, which here
    is the first word, and the two documented properties survive it exactly."""
    from encore_worker.domain.lyrics.generate import trimmed

    line = a_line(
        ("a", 10.0, 19.999),
        ("b", 19.999, 20.4),
        ("c", 20.4, 20.9),
        ("d", 20.9, 21.6),
        ("e", 21.6, 22.0),
        start=10.0,
        end=22.0,
    )
    got = trimmed(line, 20.0, frame_sec=0.02)
    assert got is not None and got.end == 20.0
    starts = [w.start for w in got.words]
    assert starts[0] == 10.0, "the FIRST onset never moves, whichever word the anchor is"
    assert all(b >= a for a, b in zip(starts, starts[1:], strict=False)), "and the map stays monotone"
    assert all(b - a >= 0.02 for a, b in zip(starts, starts[1:], strict=False)), (
        f"every word the walk re-fits keeps a decoder frame: {starts}"
    )
    assert starts == pytest.approx([10.0, 18.3325, 18.6666667, 19.0833333, 19.6666667])
    # The walk stops as soon as the tail has room, so a boundary with room keeps the deeper anchor: here 'c'
    # is the last word starting before 20.5, and two words in 0.1 s clears 2 x 20 ms.
    deep = trimmed(line, 20.5, frame_sec=0.02)
    assert deep is not None and [w.start for w in deep.words][:3] == pytest.approx([10.0, 19.999, 20.4])


def test_trimmed_carries_syllables_with_their_words() -> None:
    from encore_worker.domain.lyrics.generate import Line, Syllable, Word, trimmed

    line = Line(
        text="hello there",
        start=1.0,
        end=5.0,
        words=(
            Word(
                word="hello",
                start=1.0,
                end=2.0,
                score=-0.5,
                syllables=(Syllable(text="hel", start=1.0, end=1.5), Syllable(text="lo", start=1.5, end=2.0)),
            ),
            Word(word="there", start=3.0, end=5.0, score=-0.5),
        ),
        score=-0.5,
        index=0,
    )
    got = trimmed(line, 2.5, frame_sec=0.02)
    assert got is not None
    # 'hello' IS the anchor here (the only word starting before 2.5), so its own onset is pinned and
    # everything after it — its syllable boundaries included — is re-fitted by the same map as the tail.
    assert [(x.text, x.start) for x in got.words[0].syllables] == [("hel", 1.0), ("lo", 1.1875)]
    assert got.words[1].start == pytest.approx(1.0 + (3.0 - 1.0) * ((2.5 - 1.0) / (5.0 - 1.0)))
    assert [x.text for w in got.words for x in w.syllables] == ["hel", "lo"], "text is never touched"
