"""The placement margin: is it the gap it claims to be, and does the rule read it as advertised?

THE SHAPE OF THE PROOF. `margin.placement_margins` is a vectorised forward/backward pass over the CTC
trellis, and the one thing that can go wrong invisibly is the trellis: a skip allowed where CTC forbids it,
an end state missed, a shifted buffer. So the margin is asserted against a REFERENCE built the other way
round — one exhaustive DP per frame, forcing the queried state onto that frame, which is the definition of a
max-marginal — and the reference's own unconstrained total is asserted equal to the frame scores of
`ctc_fixture.ctc_viterbi`, the decoder `test_ml_contract` holds frame-for-frame equal to torchaudio's
kernel. Three independent implementations agreeing about the same path is what makes the nats meaningful.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np
import pytest

from encore_worker.domain.lyrics import margin
from encore_worker.domain.lyrics.generate import char_targets
from tests.ctc_fixture import FRAME_SEC, ctc_viterbi, sung_matrix

DICTIONARY = {"-": 0, "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "l": 6, "n": 7, "o": 8, "r": 9, "w": 10}

_NEG = -1e18


class _Emissions:
    """The duck type `char_targets` reads: a matrix, its grid and its vocabulary."""

    def __init__(self, log_probs: np.ndarray, frame_sec: float = FRAME_SEC) -> None:
        self.log_probs = log_probs
        self.frame_sec = frame_sec
        self.dictionary = DICTIONARY
        self.blank_id = 0

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0])


def _extended(targets: Sequence[int], blank: int) -> list[int]:
    out = [blank]
    for token in targets:
        out += [token, blank]
    return out


def _best_total(
    matrix: np.ndarray, targets: Sequence[int], blank: int, *, pinned: tuple[int, int] | None = None
) -> float:
    """The best CTC path score, by an explicit DP. `pinned` is `(state, frame)`: the path MUST occupy that
    state at that frame, which is what makes the answer a max-marginal rather than a total."""
    extended = _extended(targets, blank)
    states = len(extended)
    frames = matrix.shape[0]
    alpha = [_NEG] * states
    alpha[0] = float(matrix[0][blank])
    alpha[1] = float(matrix[0][extended[1]])
    if pinned is not None and pinned[1] == 0:
        alpha = [score if s == pinned[0] else _NEG for s, score in enumerate(alpha)]
    for frame in range(1, frames):
        nxt = [_NEG] * states
        for state in range(states):
            best = alpha[state]
            if state >= 1:
                best = max(best, alpha[state - 1])
            if state >= 2 and extended[state] != blank and extended[state] != extended[state - 2]:
                best = max(best, alpha[state - 2])
            if best > _NEG / 2:
                nxt[state] = best + float(matrix[frame][extended[state]])
        if pinned is not None and pinned[1] == frame:
            nxt = [score if s == pinned[0] else _NEG for s, score in enumerate(nxt)]
        alpha = nxt
    return max(alpha[states - 1], alpha[states - 2])


def _reference_margin(
    matrix: np.ndarray, targets: Sequence[int], blank: int, first_target: int, reach: int
) -> float:
    """§3.7's definition, computed the slow honest way: the max-marginal curve of the line's first
    character, one pinned DP per frame, then the best value `reach` frames outside the chosen plateau."""
    state = 2 * first_target + 1
    curve = [_best_total(matrix, targets, blank, pinned=(state, f)) for f in range(matrix.shape[0])]
    peak = max(curve)
    top = curve.index(peak)
    near = [value >= peak - 1e-6 for value in curve]
    first = top
    while first > 0 and near[first - 1]:
        first -= 1
    last = top
    while last + 1 < len(curve) and near[last + 1]:
        last += 1
    outside = [
        value
        for frame, value in enumerate(curve)
        if (frame < first - reach or frame > last + reach) and value > _NEG / 2
    ]
    return math.inf if not outside else peak - max(outside)


def _song(phrases: Sequence[tuple[str, float, float]], duration_sec: float) -> tuple[_Emissions, np.ndarray]:
    matrix = sung_matrix(phrases, DICTIONARY, duration_sec)
    return _Emissions(matrix), matrix


def test_the_reference_total_is_the_shipped_decoders() -> None:
    """The DP the margin is checked against decodes the same path as the kernel's stand-in.

    Without this the reference could be wrong in the same way as the subject and both would agree.
    """
    emissions, matrix = _song([("one", 0.2, 0.6), ("all", 1.0, 1.5)], 2.0)
    flat = char_targets(["one", "all"], emissions)
    _labels, scores = ctc_viterbi(matrix, flat.targets, 0)
    assert _best_total(matrix, flat.targets, 0) == pytest.approx(sum(scores), abs=1e-3)


def test_the_margin_is_the_gap_the_reference_measures() -> None:
    """Every line of a song with a repeated phrase, against the per-frame pinned DP."""
    emissions, matrix = _song([("na na", 0.2, 0.8), ("na na", 1.6, 2.2), ("wonder", 3.0, 3.6)], 4.2)
    texts = ["na na", "na na", "wonder"]
    flat = char_targets(texts, emissions)
    reach = 25  # 0.5 s at the 20 ms grid
    got = margin.placement_margins(
        matrix,
        flat.targets,
        flat.first_char_target,
        frame_sec=FRAME_SEC,
        window_sec=reach * FRAME_SEC,
    )
    assert sorted(got) == [0, 1, 2]
    for index, first in flat.first_char_target.items():
        want = _reference_margin(matrix, flat.targets, 0, first, reach)
        assert got[index] == pytest.approx(want, abs=1e-3), f"line {index}"


def test_a_repeated_line_is_ambiguous_and_a_unique_one_is_not() -> None:
    """The statistic's whole claim: the gap is small exactly where the song offers another placement.

    Three sung copies of one phrase and TWO lines asking for it: either of the first two copies can be
    line 0 (and either of the last two line 1), so moving a line costs NOTHING AT ALL — the margin is
    exactly zero, which is what a perfectly ambiguous placement should read. The unique line has nowhere
    else to go, and the trellis has to give up its letters to move it.

    THE THRESHOLD IS LOCAL, not `MIN_MARGIN_NATS`: this matrix puts 0.9 on the sung label and spreads 0.1
    over the other 10 (`ctc_fixture.HIT`), so a frame of evidence is worth ~5.5 nats where a real model's
    is worth far more. The shipped constant is calibrated on real emissions and means nothing here; what
    the fixture can prove is the SEPARATION and the zero.

    THE WINDOW MATTERS, and the same numbers say why: the copies are 1.4 s apart, so at `window_sec=1.5`
    the second copy is INSIDE the window — the same placement, as far as the statistic is concerned — and
    the repeated lines read 76 and 81 nats instead of 0. `WINDOW_SEC` is a real choice, not a formality.
    """
    emissions, matrix = _song(
        [("na na", 0.2, 0.8), ("na na", 1.6, 2.2), ("na na", 3.0, 3.6), ("wonderland", 4.4, 5.2)], 6.0
    )
    texts = ["na na", "na na", "wonderland"]
    flat = char_targets(texts, emissions)
    got = margin.placement_margins(
        matrix, flat.targets, flat.first_char_target, frame_sec=FRAME_SEC, window_sec=0.7
    )
    assert got[0] == 0.0
    assert got[1] == 0.0
    assert got[2] > 4.0
    assert margin.low_lines(got, {0: -0.1, 1: -0.1, 2: -0.1, 3: -0.1}, min_margin_nats=2.0) == frozenset(
        {0, 1}
    )
    wider = margin.placement_margins(
        matrix, flat.targets, flat.first_char_target, frame_sec=FRAME_SEC, window_sec=1.5
    )
    assert min(wider.values()) > 8.0, "a copy inside the window is the same placement"


def test_a_line_with_nowhere_else_to_go_has_an_infinite_margin() -> None:
    """A song that is exactly its one line: there is no alternative path at all, not merely a worse one."""
    emissions, matrix = _song([("one", 0.1, 0.9)], 1.0)
    flat = char_targets(["one"], emissions)
    got = margin.placement_margins(
        matrix, flat.targets, flat.first_char_target, frame_sec=FRAME_SEC, window_sec=3.0
    )
    assert got == {0: math.inf}
    assert margin.low_lines(got, {0: -0.1}) == frozenset()


def test_a_held_character_is_not_its_own_competitor() -> None:
    """The plateau rule. A path that holds the line's first character one frame longer is the SAME
    placement; masking only the argmax frame would score it as an alternative and read a long note as
    ambiguous. Pinned by a window of one frame, where only the plateau rule stands between the two."""
    emissions, matrix = _song([("ooo", 0.2, 1.4), ("bell", 2.0, 2.4)], 3.0)
    flat = char_targets(["ooo", "bell"], emissions)
    got = margin.placement_margins(
        matrix, flat.targets, flat.first_char_target, frame_sec=FRAME_SEC, window_sec=FRAME_SEC
    )
    assert got[0] > 0.0, "the line's own held frames must not count as a competing placement"


def test_an_unreadable_matrix_measures_nothing_rather_than_doubting_everything() -> None:
    """`{}` is "not measured", and the rule must not turn that into evidence of ambiguity."""
    emissions, matrix = _song([("one", 0.2, 0.6)], 1.0)
    flat = char_targets(["one"], emissions)
    empty: dict[int, int] = {}
    assert margin.placement_margins(matrix, (), empty, frame_sec=FRAME_SEC) == {}, (
        "no targets, nothing to place"
    )
    assert margin.placement_margins(matrix, flat.targets, empty, frame_sec=FRAME_SEC) == {}
    assert margin.placement_margins(matrix, flat.targets, flat.first_char_target, frame_sec=0.0) == {}
    assert margin.placement_margins(matrix[:0], flat.targets, flat.first_char_target, frame_sec=1.0) == {}
    assert (
        margin.placement_margins(matrix, flat.targets, flat.first_char_target, frame_sec=1.0, blank=99) == {}
    )
    assert margin.placement_margins(matrix, (99, 1), {0: 0}, frame_sec=1.0) == {}, (
        "a target outside the vocabulary"
    )
    assert margin.placement_margins(matrix[:2], flat.targets, flat.first_char_target, frame_sec=1.0) == {}
    assert margin.low_lines({}, {0: -0.1, 1: -0.1, 2: -9.9, 3: -0.1}) == frozenset({2}), (
        "the score half still applies when the margin could not be measured"
    )


def test_the_rule_is_two_thresholds_and_abstains_on_a_tiny_song() -> None:
    margins = {0: 40.0, 1: 4.0, 2: 40.0}
    scores = {0: -1.0, 1: -1.0, 2: -3.0, 3: -1.0, 4: -1.0}
    assert margin.low_lines(margins, scores) == frozenset({1, 2})
    assert margin.low_lines(margins, scores, min_margin_nats=0.0) == frozenset({2})
    assert margin.low_lines(margins, scores, score_drop_nats=10.0) == frozenset({1})
    # Three lines cannot establish a median, exactly as the never-sung rule holds.
    assert margin.low_lines({}, {0: -1.0, 1: -1.0, 2: -9.0}) == frozenset()
    assert margin.low_lines({}, {}) == frozenset()


def test_fuzzy_repeats_finds_the_near_miss_an_exact_match_does_not() -> None:
    """Review §3.7's optional half (`conf-fuzzy-repeats`): the same chorus line with one word changed."""
    texts = {
        0: "and I never wanna hear you say",
        1: "'cause I never wanna hear you say",
        2: "a completely different closing line",
        3: "AND  I never wanna   hear you say",
    }
    assert margin.fuzzy_repeats(texts) == frozenset({0, 1, 3})
    assert margin.fuzzy_repeats(texts, ratio=1.0) == frozenset({0, 3}), "case and spacing fold"
    assert margin.fuzzy_repeats({0: "", 1: "   "}) == frozenset()


def test_the_margin_is_read_off_the_same_targets_the_decode_used() -> None:
    """`char_targets` is the ONE flatten (the reason it was extracted): the line whose first character the
    margin queries must be the line `generate` timed, separators and dropped rows included."""
    emissions, _matrix = _song([("one", 0.2, 0.6)], 2.0)
    flat = char_targets(["", "one", "♪", "all"], emissions)
    assert flat.first_char_target == {1: 0, 3: 3}, "a row with no alignable character owns no target"
    assert [flat.targets[p] for p in flat.first_char_target.values()] == [
        DICTIONARY["o"],
        DICTIONARY["a"],
    ]


def test_random_matrices_agree_with_the_reference_on_every_line() -> None:
    """The property, over shapes no hand-built fixture covers: doubled letters (whose blank CTC's topology
    requires), a target sequence that only just fits its frames, flat evidence, and a line at either end.

    Seeded, small and exhaustive on the other side: the reference runs one pinned DP per frame, so this is
    ~10^5 DP cells a case and it stays hermetic. A vectorised forward/backward pass is exactly the code where
    an off-by-one in a shifted buffer produces plausible numbers on the fixtures and wrong ones here.
    """
    rng = np.random.default_rng(7)
    vocab = max(DICTIONARY.values()) + 1
    cases = [
        (["abba", "cab"], 24),
        (["aa", "aa", "aa"], 22),
        (["deal", "led"], 18),
        (["one", "no", "eon"], 40),
        (["lace", "call"], 21),
    ]
    for texts, frames in cases:
        matrix = np.log(rng.dirichlet(np.ones(vocab) * 0.7, size=frames))
        emissions = _Emissions(matrix.astype(np.float32))
        flat = char_targets(texts, emissions)
        for reach in (1, 3, 7):
            got = margin.placement_margins(
                matrix,
                flat.targets,
                flat.first_char_target,
                frame_sec=1.0,
                window_sec=float(reach),
            )
            assert sorted(got) == sorted(flat.first_char_target), (texts, reach)
            for index, first in flat.first_char_target.items():
                want = _reference_margin(matrix, flat.targets, 0, first, reach)
                assert got[index] == pytest.approx(want, abs=1e-6), (texts, reach, index)
