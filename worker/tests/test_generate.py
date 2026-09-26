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

from encore_worker.domain.lyrics.generate import Generated, generate

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


Decode = Callable[[object, "Sequence[int]"], tuple[list[int], list[float]]]


def scripted_decoder(placements: dict[int, tuple[int, int]], total_frames: int) -> Decode:
    """A decoder that puts each target index at scripted frames: target i occupies placements[i]."""

    def decode(_log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        labels = [0] * total_frames
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

    def spy(_lp: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        seen.append(list(targets))
        return scripted_decoder(evenly(len(targets)), 100)(_lp, targets)

    generate(["fly-away"], em, decoder=spy, syllabifier=lambda w, _l: [w])
    assert seen and 0 not in seen[0]


def test_a_span_count_mismatch_is_an_error_not_a_degradation() -> None:
    """One span per target is forced_align's contract; anything else means the matrix and the encoding
    disagree, and grouping on top of that would misattribute every following char."""

    def broken(_lp: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        return [0] * 10, [0.0] * 10  # no spans at all for non-empty targets

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


def slice_decoder(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
    """Places targets from the START of whatever slice it is given — how a window re-decode behaves."""
    labels = [0] * len(log_probs)  # type: ignore[arg-type]
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
    repaired = regenerate(
        [(doc.lines, (2.0, 8.0))], em, decoder=slice_decoder, syllabifier=lambda w, _l: [w]
    )
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

    def broken(_lp: object, _targets: Sequence[int]) -> tuple[list[int], list[float]]:
        raise RuntimeError("window decode fault")

    doc = gen(["fly away"])
    em = FakeEmissions(log_probs=[0.0] * 4000, frame_sec=0.02, dictionary=DIC)
    assert regenerate([(doc.lines, (2.0, 8.0))], em, decoder=broken) == {}
