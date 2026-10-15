"""The vendored decoder: the plain topology bit for bit, and the three arcs the fixed kernel cannot express.

`tests/ctc_fixture.py`'s `ctc_viterbi` is held frame-for-frame against the REAL kernel in
`test_ml_contract.py`, so holding the vendored module against it here is a torch-free leg of the same claim;
`test_ml_contract.py` closes the loop against `torchaudio.functional.forced_align` itself (XA-18).
"""

from __future__ import annotations

import random
from typing import Any

import numpy as np
import pytest

from encore_worker.domain.lyrics import viterbi
from encore_worker.domain.lyrics.generate import char_targets, line_blocks
from tests.ctc_fixture import FRAME_SEC, alignable, ctc_viterbi, sung_matrix

DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}

SUNG = (("come and fly away", 0.5, 2.5), ("with me tonight", 3.0, 5.0), ("carry me home", 6.0, 8.0))
DURATION = 9.0


class Emitted:
    """`adapters.ml.Emissions`' duck type, so `char_targets` can read a synthetic matrix."""

    def __init__(self, log_probs: Any, specials: dict[str, int] | None = None) -> None:
        self.log_probs = log_probs
        self.frame_sec = FRAME_SEC
        self.dictionary = DIC
        self.blank_id = 0
        self.specials = specials or {}

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0])


def cases() -> list[tuple[Any, list[int]]]:
    """The comparison set `test_ml_contract.py` uses: real windows, flat evidence and random log-softmax."""
    rng = random.Random(7)
    sung = sung_matrix(SUNG, DIC, DURATION)
    out: list[tuple[Any, list[int]]] = []
    for _ in range(40):
        first = rng.randrange(0, len(sung) - 60)
        window = sung[first : rng.randrange(first + 60, len(sung) + 1)]
        text = rng.choice(("come and fly away", "with me tonight", "carry me home", "me"))
        out.append((window, alignable(text, DIC)))
    for trial in range(40):
        frames = rng.randrange(10, 200)
        targets = [rng.randrange(1, 28) for _ in range(rng.randrange(1, max(2, frames // 3)))]
        if trial % 2:
            out.append((np.full((frames, 28), -3.3, dtype=np.float32), targets))
        else:
            raw = np.random.default_rng(trial).normal(size=(frames, 28))
            out.append(((raw - np.log(np.exp(raw).sum(1, keepdims=True))).astype(np.float32), targets))
    return out


def test_an_empty_graph_is_the_fixture_kernel_frame_for_frame() -> None:
    """The whole point of vendoring: swapping the decoder may not move one published frame (XA-18)."""
    compared = 0
    for matrix, targets in cases():
        try:
            want = ctc_viterbi(matrix, targets)
        except ValueError:
            with pytest.raises(ValueError):
                viterbi.align(matrix, targets)
            continue
        got = viterbi.align(matrix, targets)
        assert list(got.labels) == want[0], f"labels differ on {len(matrix)} frames, {len(targets)} targets"
        assert list(got.scores) == pytest.approx(want[1])
        assert got.skipped == frozenset()
        compared += 1
    assert compared >= 60, "the comparison must not be vacuous"


def test_the_decoder_closure_is_the_generate_decoder_shape() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    targets = alignable("come and fly away", DIC)
    labels, scores = viterbi.decoder()(matrix, targets, 0)
    assert isinstance(labels, list) and isinstance(scores, list)
    assert (labels, scores) == tuple(list(v) for v in ctc_viterbi(matrix, targets))


def test_no_targets_is_the_blank_column_and_a_bad_shape_raises() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    empty = viterbi.align(matrix, [])
    assert set(empty.labels) == {0} and len(empty.labels) == len(matrix)
    assert empty.scores == pytest.approx([float(v) for v in matrix[:, 0]])
    with pytest.raises(ValueError, match="frames, vocab"):
        viterbi.align(np.zeros((3, 4, 5), dtype=np.float32), [1])
    with pytest.raises(ValueError, match="equals the blank id"):
        viterbi.align(matrix, [1, 0, 2])
    with pytest.raises(ValueError, match="cannot hold"):
        viterbi.align(matrix[:3], alignable("come and fly away", DIC))


# ── phase B: the frame-relative star, optional in the graph ──────────────────────────────────────


def starred_targets(texts: list[str]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """`(targets, star positions)` for `texts` over a matrix that names a star column."""
    width = max(DIC.values()) + 1
    flat = char_targets(texts, Emitted(np.zeros((1, width + 1)), {"<star>": width}), stars=True)
    return flat.targets, tuple(i for i, token in enumerate(flat.targets) if token == width)


def with_star_column(matrix: np.ndarray, penalty: float) -> np.ndarray:
    return np.concatenate((matrix, (matrix.max(axis=1) - penalty)[:, None]), axis=1).astype(matrix.dtype)


def test_a_huge_star_penalty_reproduces_the_plain_decode() -> None:
    """The superset property, as a test: every plain path exists in the starred graph at the same score, so
    a star nothing can afford leaves the decode exactly where it was."""
    texts = [text for text, _s, _e in SUNG]
    matrix = with_star_column(sung_matrix(SUNG, DIC, DURATION), 1.0)
    targets, stars = starred_targets(texts)
    assert len(stars) == len(texts)
    plain = ctc_viterbi(matrix, [t for i, t in enumerate(targets) if i not in set(stars)])
    graph = viterbi.Graph(stars=stars, star_penalty=1e6)
    got = viterbi.align(matrix, targets, graph=graph)
    assert list(got.labels) == plain[0]


#: A song whose first character lands on FRAME 0 — the one place the superset property used to fail, target
#: position 0 always being a star and trellis state 1 therefore being it (`_Arcs.entry`; review W9
#: r1-correctness-3).
FROM_FRAME_ZERO = (("come and fly away", 0.0, 2.0), ("carry me home", 2.5, 4.0))


def test_the_starred_graph_holds_the_plain_path_that_sings_from_frame_zero() -> None:
    """The superset property where it used to break: a matrix whose frame 0 is a character, not silence."""
    matrix = with_star_column(sung_matrix(FROM_FRAME_ZERO, DIC, 5.0), 1.0)
    targets, stars = starred_targets([text for text, _s, _e in FROM_FRAME_ZERO])
    assert stars[0] == 0, "the first star has to sit before the first character for this to bite"
    plain = ctc_viterbi(matrix, [t for i, t in enumerate(targets) if i not in set(stars)])
    assert plain[0][0] != 0, "the fixture must really sing on frame 0"
    got = viterbi.align(matrix, targets, graph=viterbi.Graph(stars=stars, star_penalty=1e6))
    assert list(got.labels) == plain[0]
    assert sum(got.scores) == pytest.approx(sum(plain[1]), abs=1e-3)


def test_the_star_only_ever_helps_the_path_and_absorbs_what_the_text_omits() -> None:
    """A verse the text does not mention: the star takes those frames instead of smearing a letter over
    them, and no penalty can make the starred graph score below the plain one."""
    heard = (*SUNG, ("unsung words nobody wrote down", 8.2, 8.9))
    matrix = with_star_column(sung_matrix(heard, DIC, DURATION), 0.3)
    texts = [text for text, _s, _e in SUNG]
    targets, stars = starred_targets(texts)
    plain_targets = [t for i, t in enumerate(targets) if i not in set(stars)]
    plain = sum(ctc_viterbi(matrix, plain_targets)[1])
    for penalty in (0.1, 0.3, 1.0, 4.0):
        got = viterbi.align(matrix, targets, graph=viterbi.Graph(stars=stars, star_penalty=penalty))
        assert sum(got.scores) >= plain - 1e-3, f"P={penalty} scored below the plain decode"
    cheap = viterbi.align(matrix, targets, graph=viterbi.Graph(stars=stars, star_penalty=0.1))
    assert sum(cheap.scores) > plain, "a cheap star must find the frames the text does not cover"


def test_the_graphs_star_is_the_appended_columns_own_value() -> None:
    """Phase A's column and phase B's state are the same number at the same P, which is what lets the two
    arms share one fitted penalty — and why phase B needs no matrix surgery of its own."""
    matrix = with_star_column(sung_matrix(SUNG, DIC, DURATION), 0.3)
    width = matrix.shape[1] - 1
    assert matrix[:, width] == pytest.approx(matrix[:, :width].max(axis=1) - 0.3)
    assert matrix.max(axis=1) == pytest.approx(matrix[:, :width].max(axis=1))


def one_frame_each(columns: list[int], width: int, hit: float = 0.99) -> np.ndarray:
    """One frame per column named, that column confident and the rest sharing the remainder."""
    matrix = np.full((len(columns), width), float(np.log((1.0 - hit) / (width - 1))), dtype=np.float32)
    matrix[np.arange(len(columns)), columns] = float(np.log(hit))
    return matrix


def test_a_star_bypass_between_identical_boundary_letters_keeps_the_blank_between_them() -> None:
    """The star's SECOND bypass (character before -> character after) is an illegal CTC transition where the
    two characters are the same label, and `_compile`'s `ids[position - 1] != ids[position + 1]` is the one
    line that withholds it. Relaxing that to `if position:` left 93 tests green (review W9 r2-tests-13).

    Here the first line ends on the letter the second begins with, and the matrix holds exactly the frames
    the legal path needs: with the arc withheld the decode is that path, and with it granted the two
    letters merge into ONE span, which is a span count `generate` would reject (XA-11).
    """
    targets, stars = starred_targets(["ab", "ba"])
    a, b = DIC["a"], DIC["b"]
    assert stars == (0, 3) and (targets[2], targets[4]) == (b, b), (
        f"the fixture's line boundary must repeat a letter: {targets}"
    )
    width = max(DIC.values()) + 2  # the star's own id is one past the dictionary's
    graph = viterbi.Graph(stars=stars, star_penalty=0.3)

    legal = viterbi.align(one_frame_each([a, b, 0, b, a], width), targets, graph=graph)
    assert list(legal.labels) == [a, b, 0, b, a], "the blank between the repeated letter has to be spent"

    # FOUR FRAMES hold the four characters only by merging the pair, so the arc granted is the difference
    # between a decode and a refusal — and a refusal is what `generate` can act on.
    with pytest.raises(ValueError, match="no CTC path"):
        viterbi.align(one_frame_each([a, b, b, a], width), targets, graph=graph)


def test_a_star_with_no_line_after_it_is_refused() -> None:
    matrix = with_star_column(sung_matrix(SUNG, DIC, DURATION), 0.3)
    targets, _stars = starred_targets([text for text, _s, _e in SUNG])
    with pytest.raises(ValueError, match="no line after it"):
        viterbi.align(matrix, targets, graph=viterbi.Graph(stars=(len(targets) - 1,), star_penalty=0.3))


# ── roadmap item 15: skip arcs over an optional line ─────────────────────────────────────────────


def blocks_of(texts: list[str]) -> dict[int, tuple[int, int]]:
    width = max(DIC.values()) + 1
    return line_blocks(char_targets(texts, Emitted(np.zeros((1, width)))))


#: The fixture's wrong frame costs 5.6 nats against a real matrix's tens, so the arc is priced for THIS
#: evidence; the shipped pair's arithmetic is pinned in `test_the_arc_price_is_the_fixed_cost_plus_one...`.
FIXTURE_LINE_NATS, FIXTURE_CHAR_NATS = 2.0, 1.0


def test_a_line_the_audio_never_sings_is_the_one_the_arc_bypasses() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    texts = [SUNG[0][0], "a line that was never recorded", SUNG[1][0], SUNG[2][0]]
    flat = char_targets(texts, Emitted(matrix))
    indexes, arcs = viterbi.line_skips(
        line_blocks(flat), line_nats=FIXTURE_LINE_NATS, char_nats=FIXTURE_CHAR_NATS
    )
    assert indexes == (0, 1, 2, 3)
    got = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(skips=arcs))
    assert {indexes[i] for i in got.skipped} == {1}


def test_an_exempt_line_gets_no_arc_and_a_dear_enough_arc_is_never_taken() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    texts = [SUNG[0][0], "a line that was never recorded", SUNG[1][0], SUNG[2][0]]
    flat = char_targets(texts, Emitted(matrix))
    blocks = line_blocks(flat)
    exempt_indexes, exempt_arcs = viterbi.line_skips(
        blocks, frozenset({1}), line_nats=FIXTURE_LINE_NATS, char_nats=FIXTURE_CHAR_NATS
    )
    assert exempt_indexes == (0, 2, 3)
    nothing = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(skips=exempt_arcs))
    assert nothing.skipped == frozenset(), "the exempted line was the only one worth bypassing"
    dear = viterbi.line_skips(blocks, line_nats=10_000.0, char_nats=0.0)[1]
    assert viterbi.align(matrix, flat.targets, graph=viterbi.Graph(skips=dear)).skipped == frozenset()


def test_the_arc_price_is_the_fixed_cost_plus_one_per_character() -> None:
    blocks = blocks_of([SUNG[0][0], SUNG[1][0]])
    _indexes, arcs = viterbi.line_skips(blocks, line_nats=30.0, char_nats=6.0)
    for arc, (first, last) in zip(arcs, [blocks[0], blocks[1]], strict=True):
        assert arc.penalty == pytest.approx(30.0 + 6.0 * (last - first))
    assert viterbi.SKIP_LINE_NATS == 30.0 and viterbi.SKIP_CHAR_NATS == 6.0


def test_a_bypassed_run_still_leaves_a_blank_between_its_neighbours() -> None:
    """A skip arc runs blank to blank, so two character runs either side of a dropped line cannot merge into
    one span — which would make `generate`'s span count disagree with its targets (XA-11)."""
    matrix = sung_matrix((("aa", 0.1, 0.4), ("aa", 1.0, 1.4)), DIC, 1.8)
    flat = char_targets(["aa", "aa aa", "aa"], Emitted(matrix))
    indexes, arcs = viterbi.line_skips(line_blocks(flat), line_nats=0.0, char_nats=0.0)
    got = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(skips=arcs))
    assert {indexes[i] for i in got.skipped} == {1}, "the free arc must bypass the unsung middle line"
    runs = [
        label
        for position, label in enumerate(got.labels)
        if position == 0 or label != got.labels[position - 1]
    ]
    assert 0 in runs, "the path must spend blank frames where a line was bypassed"
    assert sum(1 for label in runs if label != 0) == 4, "one span per surviving character, none merged"


def test_a_sheet_too_long_for_the_recording_is_not_refused_on_frames_an_arc_can_bypass() -> None:
    """The precheck counted every target as mandatory, so the detector's whole input class — a sheet LONGER
    than the recording — was refused on frame counts its own arcs could have fitted."""
    matrix = sung_matrix((("aa", 0.0, 0.1),), DIC, 0.14)
    flat = char_targets(["aa", "a line that was never recorded"], Emitted(matrix))
    indexes, arcs = viterbi.line_skips(line_blocks(flat), line_nats=0.0, char_nats=0.0)
    with pytest.raises(ValueError, match="cannot hold"):
        viterbi.align(matrix, flat.targets)
    got = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(skips=arcs))
    assert {indexes[i] for i in got.skipped} == {1}, "the long line is the one the frames cannot hold"


def test_a_skip_that_is_not_a_run_of_these_targets_is_refused() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    targets = alignable(SUNG[0][0], DIC)
    for bad in (viterbi.Skip(0, 0, 1.0), viterbi.Skip(2, 1, 1.0), viterbi.Skip(0, len(targets) + 1, 1.0)):
        with pytest.raises(ValueError, match="not a run of these targets"):
            viterbi.align(matrix, targets, graph=viterbi.Graph(skips=(bad,)))


def test_a_backpointer_naming_an_arc_the_graph_never_compiled_is_refused() -> None:
    """A backpointer at or above `_FIRST_ARC_CODE` is only written where arcs exist, so the traceback can
    never meet one without them — and the fallback it used to carry (keep the state, call the tag -1) would
    turn that broken invariant into a silently wrong path rather than a refusal (review W9 r2-tests-16).

    Read through `_traceback` because that is the only way to forge the state `align` cannot produce.
    """
    forged = np.zeros((3, 5), dtype=np.int8)
    forged[1, 2] = 3  # `_FIRST_ARC_CODE`: slot 0 of an arc landing on state 2
    with pytest.raises(ValueError, match="compiled no arcs"):
        viterbi._traceback(forged, 2, None)

    plain = np.zeros((3, 5), dtype=np.int8)
    path, skipped = viterbi._traceback(plain, 4, None)
    assert list(path) == [4, 4, 4] and skipped == frozenset(), "a plain traceback is unchanged"


# ── roadmap item 14: the onset prior, and the fusion ─────────────────────────────────────────────


def first_run(labels: tuple[int, ...]) -> tuple[int, int]:
    """`(first frame, length)` of the first non-blank run: where the line's first character landed."""
    start = next(frame for frame, label in enumerate(labels) if label != 0)
    end = next((frame for frame in range(start, len(labels)) if labels[frame] != labels[start]), len(labels))
    return start, end - start


def test_the_onset_prior_decides_a_placement_the_evidence_is_indifferent_about() -> None:
    """A flat matrix is the exactly-ambiguous case: every path scores the same, so the prior is the only
    thing in the graph that can choose, and what it chooses is the claim."""
    from encore_worker.domain.lyrics import prior

    flat_matrix = np.full((400, 28), -float(np.log(28)), dtype=np.float32)
    flat = char_targets(["carry me home"], Emitted(flat_matrix))
    bare, _length = first_run(viterbi.align(flat_matrix, flat.targets).labels)
    assert bare == 0, "with no evidence the plain decode starts the line at the first frame"
    for claim in (2.0, 5.0):
        bonus = prior.onset_bonus(
            flat.first_char_target, {0: claim}, frames=len(flat_matrix), frame_sec=FRAME_SEC
        )
        got = viterbi.align(flat_matrix, flat.targets, graph=viterbi.Graph(bonus=bonus))
        placed = first_run(got.labels)[0] * FRAME_SEC
        assert placed == pytest.approx(claim, abs=0.02), f"a claim at {claim}s left the line at {placed}s"


def test_a_claim_outside_the_priors_reach_cannot_move_a_placement_the_audio_decided() -> None:
    from encore_worker.domain.lyrics import prior

    matrix = sung_matrix(SUNG, DIC, DURATION)
    flat = char_targets([text for text, _s, _e in SUNG], Emitted(matrix))
    without = viterbi.align(matrix, flat.targets)
    bonus = prior.onset_bonus(
        flat.first_char_target,
        {0: 0.5, 1: 3.0, 2: 6.0},
        frames=len(matrix),
        frame_sec=FRAME_SEC,
        peak=100.0,
    )
    far = prior.onset_bonus(
        {index: position for index, position in flat.first_char_target.items()},
        {0: 8.5, 1: 0.2, 2: 0.4},
        frames=len(matrix),
        frame_sec=FRAME_SEC,
        peak=100.0,
    )
    assert viterbi.align(matrix, flat.targets, graph=viterbi.Graph(bonus=far)).labels == without.labels
    assert viterbi.align(matrix, flat.targets, graph=viterbi.Graph(bonus=bonus)).labels == without.labels


def test_the_prior_is_paid_once_on_entry_and_not_per_frame_of_dwelling() -> None:
    """Measured on the emission instead, a 20-nat peak parked the first character ON the prior's own peak
    and paid 600 nats of evidence for the privilege. A boundary bonus is paid at the boundary."""
    from encore_worker.domain.lyrics import prior

    matrix = sung_matrix(SUNG, DIC, DURATION)
    flat = char_targets([text for text, _s, _e in SUNG], Emitted(matrix))
    plain = viterbi.align(matrix, flat.targets)
    _start, length = first_run(plain.labels)
    for peak in (4.0, 100.0, 1000.0):
        bonus = prior.onset_bonus(
            flat.first_char_target,
            {0: _start * FRAME_SEC},
            frames=len(matrix),
            frame_sec=FRAME_SEC,
            peak=peak,
        )
        got = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(bonus=bonus))
        assert first_run(got.labels) == (_start, length), f"peak {peak} bought dwelling"
        assert sum(got.scores) == pytest.approx(sum(plain.scores), abs=1e-3)


def test_the_prior_is_truncated_so_a_far_claim_is_no_evidence_at_all() -> None:
    from encore_worker.domain.lyrics import prior

    bonus = prior.onset_bonus({0: 0}, {0: 3.0}, frames=400, frame_sec=FRAME_SEC)
    curve = bonus[0]
    assert curve[int(3.0 / FRAME_SEC)] == pytest.approx(prior.ONSET_BONUS_NATS)
    assert curve[int((3.0 + prior.ONSET_REACH_SEC + 0.1) / FRAME_SEC)] == 0.0
    assert curve[int((3.0 - prior.ONSET_REACH_SEC - 0.1) / FRAME_SEC)] == 0.0
    assert prior.onset_bonus({0: 0}, {}, frames=400, frame_sec=FRAME_SEC) == {}
    assert prior.onset_bonus({0: 0}, {0: 3.0}, frames=0, frame_sec=FRAME_SEC) == {}


def test_a_prior_is_never_added_to_a_reported_score() -> None:
    """The score is the word's confidence, and a bonus is not evidence: every returned score has to be a
    number the matrix itself holds."""
    from encore_worker.domain.lyrics import prior

    matrix = sung_matrix(SUNG, DIC, DURATION)
    flat = char_targets([text for text, _s, _e in SUNG], Emitted(matrix))
    bonus = prior.onset_bonus(
        flat.first_char_target, {0: 0.5, 1: 3.0, 2: 6.0}, frames=len(matrix), frame_sec=FRAME_SEC, peak=50.0
    )
    got = viterbi.align(matrix, flat.targets, graph=viterbi.Graph(bonus=bonus))
    for frame, (label, score) in enumerate(zip(got.labels, got.scores, strict=True)):
        assert score == pytest.approx(float(matrix[frame, label]))


def test_the_fuse_mask_is_the_claim_windows_the_stem_is_mute_in() -> None:
    from encore_worker.domain.lyrics import prior

    envelope = np.array([0.5, 0.5, 0.01, 0.01, 0.5, 0.01], dtype=np.float64)
    mask = prior.mute_in_window(envelope, [(0.2, 0.5)], frames=6, frame_sec=0.1, hop_sec=0.1, floor=0.1)
    assert [bool(v) for v in mask] == [False, False, True, True, False, False]
    assert not prior.mute_in_window(None, [(0.0, 1.0)], frames=6, frame_sec=0.1, hop_sec=0.1, floor=0.1).any()
    assert not prior.mute_in_window(envelope, [], frames=6, frame_sec=0.1, hop_sec=0.1, floor=0.1).any()


def test_fusion_replaces_only_the_masked_frames_and_refuses_a_mismatch() -> None:
    from encore_worker.domain.lyrics import prior

    stem = np.zeros((4, 3), dtype=np.float32)
    mix = np.ones((4, 3), dtype=np.float32)
    mask = np.array([False, True, False, True])
    got = prior.fused(stem, mix, mask)
    assert list(got[:, 0]) == [0.0, 1.0, 0.0, 1.0]
    assert list(stem[:, 0]) == [0.0, 0.0, 0.0, 0.0], "the stem matrix must not be mutated in place"
    short = prior.fused(stem, mix[:3], mask)
    assert list(short[:, 0]) == [0.0, 1.0, 0.0, 0.0], "a mix one frame short keeps the stem's tail"
    with pytest.raises(ValueError, match="one bundle's matrices"):
        prior.fused(stem, np.ones((4, 2), dtype=np.float32), mask)
    with pytest.raises(ValueError, match="one flag per"):
        prior.fused(stem, mix, mask[:2])
