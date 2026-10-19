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

import inspect
import math
from collections.abc import Sequence

import numpy as np
import pytest

from encore_worker.domain.lyrics import lexical, margin
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

    Three sung copies of one phrase and TWO lines asking for it, so either of the first two copies can be
    line 0 and moving a line costs NOTHING — the margin is exactly zero, which is what a perfectly
    ambiguous placement should read, while the unique line has nowhere else to go. The threshold here is
    LOCAL, not the shipped `lexical.Bands.margin_floor_nats`: this matrix is worth ~5.5 nats a frame where a
    real model's is worth far more, so what the fixture can prove is the SEPARATION and the zero. The window
    matters too — at `window_sec=1.5` the copy 1.4 s away is inside it and the lines read 76 and 81 nats."""
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
    assert margin.low_lines(got, {0: -0.1}, min_margin_nats=10.0) == frozenset()


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
    assert margin.low_lines({}, {0: -0.1, 1: -0.1, 2: -9.9, 3: -0.1}, min_margin_nats=10.0) == frozenset(
        {2}
    ), (
        "an EMPTY mapping is one line-less song, not a fault: the score half still applies. The fault path "
        "does not come through here at all — `align_claims._placement_margins` answers None and its caller "
        "never calls this (W6 review r1-correctness-2), which is the divergence this assertion used to hide"
    )


def test_the_rule_is_two_thresholds_and_abstains_on_a_tiny_song() -> None:
    margins = {0: 40.0, 1: 4.0, 2: 40.0}
    scores = {0: -1.0, 1: -1.0, 2: -3.0, 3: -1.0, 4: -1.0}
    floor = lexical.BANDS.margin_floor_nats
    assert floor is not None, "the shipped row carries the measured floor"
    assert margin.low_lines(margins, scores, min_margin_nats=floor) == frozenset({1, 2})
    assert margin.low_lines(margins, scores, min_margin_nats=0.0) == frozenset({2})
    assert margin.low_lines(margins, scores, min_margin_nats=floor, score_drop_nats=10.0) == frozenset({1})
    # Three lines cannot establish a median, exactly as the never-sung rule holds.
    assert margin.low_lines({}, {0: -1.0, 1: -1.0, 2: -9.0}, min_margin_nats=floor) == frozenset()
    assert margin.low_lines({}, {}, min_margin_nats=floor) == frozenset()


def test_the_margin_floor_is_required_and_comes_off_the_bundles_own_row() -> None:
    """The margin floor is required and comes off the bundle's own calibration row.

    A margin is a SUM OF LOG-PROBABILITIES, so its floor is the most emission-scale threshold in this
    worker, and `lexical`'s rule puts every emission-scale threshold of one model in that model's row. It
    sat here as `MIN_MARGIN_NATS = 10.0`, outside `CALIBRATED`, so `ENCORE_ALIGN_MODEL=HUBERT_ASR_XLARGE` —
    a name `is_calibrated` passes — would have read the base bundle's nats on a bundle nobody has decoded.
    The SIGNATURE is the assertion: no runtime behaviour can tell "no default" from one nobody reached."""
    parameter = inspect.signature(margin.low_lines).parameters["min_margin_nats"]
    assert parameter.default is inspect.Parameter.empty, "a default floor is a cross-bundle threshold borrow"
    assert not hasattr(margin, "MIN_MARGIN_NATS"), "the floor lives in `lexical.Bands.margin_floor_nats`"
    assert {key: row.margin_floor_nats for key, row in lexical.CALIBRATED.items()} == {
        ("WAV2VEC2_ASR_BASE_960H", "en"): 10.0,
        ("HUBERT_ASR_LARGE", "en"): 10.0,
        # Measured on none of these three bundles' trellises, so the rule abstains instead of borrowing (each
        # row's own comment). The two non-Latin rows W10 fitted are nats on an unread scale too.
        ("HUBERT_ASR_XLARGE", "en"): None,
        ("MMS_FA", "zh"): None,
        ("jonatasgrosman/wav2vec2-large-xlsr-53-japanese", "ja"): None,
    }


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
    """The property, over shapes no fixture covers: doubled letters, a sequence that only just fits its
    frames, flat evidence, a line at either end.

    Seeded and small, the reference running one pinned DP per frame, because a vectorised forward/backward
    pass is where an off-by-one in a shifted buffer gives plausible numbers on fixtures and wrong ones here.
    `(["deal", "a"], 18)` is there for the buffer re-floor: deleting `window.fill(-np.inf)` left 450 tests
    green, the contamination reaching `beta[states - 2]` first, so it reads 12.10 nats against the
    reference's 13.01 at reach 7, across the 10-nat floor. One `default_rng` per case, or a re-order draws."""
    vocab = max(DICTIONARY.values()) + 1
    cases = [
        (["abba", "cab"], 24, 7),
        (["aa", "aa", "aa"], 22, 11),
        (["deal", "led"], 18, 13),
        (["one", "no", "eon"], 40, 17),
        (["lace", "call"], 21, 19),
        (["deal", "a"], 18, 3),
        (["a"], 6, 23),
    ]
    for texts, frames, seed in cases:
        rng = np.random.default_rng(seed)
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
