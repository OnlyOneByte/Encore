"""The claim clock: every shape of sheet defect the vote must fix, and every one it must refuse.

PURE AND HERMETIC by construction — `claimmap` takes two mappings of seconds and one number, so a case
here is a series, not a song. The step-level wiring (which consumers read the mapped claims, what reaches
the trail) is pinned in `test_align_provenance.py`; the corpus numbers are the wave's bench row.

THE ASYMMETRY EVERY CASE IS WRITTEN AGAINST (review H1, §3.2): refusing a good map costs the raw clock the
worker had before W2, while applying a bad one moves a sheet that was already right. So the refusals below
— too few pairs, a scattered sheet, a misordered one, a tempo out of band, a gain under the margin — carry
as much weight as the fixes.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from encore_worker.domain.lyrics import claimmap as cm
from encore_worker.domain.lyrics import reconcile as rc

#: A 45-line song at roughly singing pace, which is what every case below perturbs. Long enough for
#: `MIN_SPAN_SEC` to admit slopes and for the 5% share of the margin to bite (int(0.05 x 45) = 2).
OURS = {index: 12.0 + 4.3 * index for index in range(45)}


def claims(offset: float = 0.0, scale: float = 1.0) -> dict[int, float]:
    """The claims a sheet would carry if our decode were right and the sheet were `offset`/`scale` out —
    i.e. the inverse of the map `consensus` should find."""
    return {index: (start - offset) / scale for index, start in OURS.items()}


def jittered(source: dict[int, float], spread: float, *, seed: int) -> dict[int, float]:
    """`source` with a bounded per-line wobble. SEEDED here, never in the module under test."""
    rng = random.Random(seed)
    return {index: start + rng.uniform(-spread, spread) for index, start in source.items()}


@dataclass(frozen=True)
class _Line:
    """What `reconcile` duck-types a generated line as (`.index`, `.start`)."""

    index: int
    start: float


# ── the fixes ────────────────────────────────────────────────────────────────────────────────────


def test_a_constant_offset_is_mapped_away() -> None:
    """The headline case (repro s8: claims 1.5 s late published every line 1.5 s late)."""
    got = cm.consensus(OURS, claims(offset=1.5))
    assert got.applied
    assert got.candidate == cm.DECODE_MEDIAN, "no envelope lag offered: the median is the only fit left"
    assert got.inliers == 45 and got.baseline == 0
    assert abs(got.at(claims(offset=1.5)[0]) - OURS[0]) < 0.01


def test_the_mapped_claims_are_the_ones_reconcile_will_corroborate() -> None:
    """WHY the tolerance is `reconcile.AGREE_TOLERANCE_SEC` and not a number of its own: "explained" here
    means exactly "a line reconcile calls corroborated", so a mapped sheet must come out AGREE."""
    lines = [_Line(index, start) for index, start in OURS.items()]
    late = claims(offset=1.5)
    assert rc.reconcile(lines, late).verdict == rc.OFFSET
    got = cm.consensus(OURS, late)
    assert rc.reconcile(lines, got.starts(late)).verdict == rc.AGREE


def test_an_offset_with_jitter_is_still_mapped() -> None:
    """A real sheet is offset PLUS jitter, not a pure offset: the median is robust to the wobble.

    Lines outside the tolerance simply do not vote. The winner here is the SLOPE candidate, on a hairline
    0.05% it reads out of the noise, which is `reconcile`'s own rule — adopt the scale only if it explains
    strictly more lines — kept so one wave cannot make the map and the verdict disagree about a drift.
    `reconcile.MAX_SCALE_DRIFT` bounds such a fit at 5%, where it either wins the vote or loses it."""
    given = jittered(claims(offset=1.5), 0.3, seed=7)
    got = cm.consensus(OURS, given)
    assert got.applied and got.baseline == 0
    assert got.inliers >= 38, f"most of 45 lines explained, not all: {got.why}"
    assert abs(got.pieces[0].scale - 1.0) <= rc.MAX_SCALE_DRIFT
    mapped = got.starts(given)
    assert all(abs(mapped[index] - OURS[index]) < 0.4 for index in mapped), "within the jitter drawn"


def test_two_wild_stamps_do_not_move_the_fit() -> None:
    """The estimator is a MEDIAN, and that is load-bearing (W2 review r1). A 40-line sheet 1.5 s late with two
    stamps 60 s wrong is the ordinary LRC defect (`parse_lrc`'s stacked timestamps, a trailing credit cue,
    review L4): the median offset is +1.50 and explains 38 of the 40 lines, while the MEAN of the same
    residuals is +4.50 and explains none of them — so a mean would lose the vote and leave the sheet 1.5 s
    late, which is repro s8, the defect this module exists for. Without this case the swap passes the suite.
    """
    ours = {index: 12.0 + 4.3 * index for index in range(40)}
    late = {index: start - 1.5 for index, start in ours.items()}
    late[7] -= 60.0
    late[31] -= 60.0
    got = cm.consensus(ours, late)
    assert got.applied and got.candidate == cm.DECODE_MEDIAN, got.why
    assert abs(got.pieces[0].offset_sec - 1.5) < 0.01, "the wild stamps do not drag the offset"
    assert got.inliers == 38 and got.baseline == 0
    mean_offset = sum(ours[i] - late[i] for i in ours) / len(ours)
    assert abs(mean_offset - 4.5) < 0.01, "what a mean would have fitted"
    pairs = sorted((late[i], ours[i]) for i in ours)
    assert cm._inliers(pairs, mean_offset, 1.0, rc.AGREE_TOLERANCE_SEC) == 0, "and it explains nothing"


def test_a_two_percent_tempo_is_mapped_by_the_bounded_slope() -> None:
    """The DRIFT case, and the one an offset alone cannot fix: at 2% over a 190 s song the ends are 3.8 s
    apart, so a single offset explains the middle and loses both ends."""
    drifted = claims(scale=1.02)
    offset_only = cm.consensus(OURS, drifted, tolerance_sec=rc.AGREE_TOLERANCE_SEC)
    assert offset_only.candidate == cm.TEMPO, "the slope must win the vote outright here"
    assert offset_only.applied and offset_only.inliers == 45
    assert abs(offset_only.pieces[0].scale - 1.02) < 0.002
    # What the offset-only candidates could manage, for the record the docstring's claim rests on.
    median_only = cm.consensus(OURS, drifted, envelope_lag=None, piecewise=False)
    assert median_only.candidate == cm.TEMPO


def test_a_partial_sheet_maps_every_claim_from_the_lines_it_covers() -> None:
    """A sheet timing only half its lines (a rolling caption track, an LRC with untimed verses): the fit is
    measured on the covered lines and applied to every claim, including the lines our decode dropped."""
    late = claims(offset=1.5)
    covered = {index: start for index, start in late.items() if index % 2 == 0}
    got = cm.consensus(OURS, covered)
    assert got.applied and got.pairs == 23
    mapped = got.starts(late)  # every claim, not just the paired ones
    assert len(mapped) == 45
    assert all(abs(mapped[index] - OURS[index]) < 0.05 for index in mapped)


def test_the_envelope_lag_wins_a_tie_with_the_decode_median() -> None:
    """The preference order, which is the review's objection answered: where the audio's own measurement
    and the fit against our decode explain the same lines, the one that does not read our decode applies."""
    late = claims(offset=1.5)
    got = cm.consensus(OURS, late, envelope_lag=1.5)
    assert got.applied and got.candidate == cm.ENVELOPE_LAG
    assert got.pieces[0].offset_sec == 1.5, "the audio's number, not the median's"


def test_a_worse_envelope_lag_loses_to_the_median() -> None:
    """Preferred on a TIE, not trusted blindly: a lag 1 s out explains nothing and the median still wins."""
    got = cm.consensus(OURS, claims(offset=1.5), envelope_lag=0.5)
    assert got.applied and got.candidate == cm.DECODE_MEDIAN


# ── the refusals ─────────────────────────────────────────────────────────────────────────────────


def test_a_sheet_already_on_our_clock_is_left_alone() -> None:
    """The margin. Truth claims with singing-scale jitter: no candidate can explain more lines than
    no-shift, so nothing moves and `at` is the identity."""
    given = jittered(claims(), 0.1, seed=3)
    got = cm.consensus(OURS, given, envelope_lag=0.02)
    assert not got.applied and got.candidate == cm.NO_SHIFT
    assert got.pieces == ()
    assert got.at(given[0]) == given[0]
    assert got.starts(given) == given
    assert "under the 2-line margin" in got.why


def test_a_gain_under_the_margin_is_refused() -> None:
    """Exactly the margin's job: a map that explains one more line than no-shift is noise, not a clock. One
    line 0.4 s out of an otherwise perfect sheet moves the median by a hair and buys one line."""
    given = dict(claims())
    given[9] += 0.4
    got = cm.consensus(OURS, given)
    assert not got.applied, got.why
    assert got.inliers - got.baseline < got.margin


def test_too_few_pairs_abstains_and_says_how_many() -> None:
    """A fit through four points that moves every window is `place.MIN_PAIRS`' hazard with teeth. The trail
    gets the count, because "the map did nothing" and "the map could not run" are different bugs."""
    few = {index: start for index, start in claims(offset=1.5).items() if index < 4}
    got = cm.consensus(OURS, few)
    assert not got.applied and got.pairs == 4
    assert "4 paired line(s), 5 needed to map" in got.why
    assert cm.consensus({}, {}).pairs == 0


def test_claims_for_lines_we_never_decoded_do_not_pair() -> None:
    """Paired by line index, never by order (`reconcile`'s rule): a claim for a line the decode dropped is
    ignored rather than shifted against its neighbour."""
    got = cm.consensus({0: 1.0, 1: 2.0, 2: 3.0}, {7: 90.0, 8: 91.0, 9: 92.0, 10: 93.0, 11: 94.0})
    assert not got.applied and got.pairs == 0


def test_a_scattered_sheet_is_refused() -> None:
    """All outliers: another song's sheet, or a decode that went to pieces. No offset and no bounded slope
    explains it, so the claims stay where they are and `reconcile` is left to call it UNRELATED."""
    rng = random.Random(11)
    scattered = {index: rng.uniform(0.0, 200.0) for index in OURS}
    got = cm.consensus(OURS, scattered, envelope_lag=3.0)
    assert not got.applied, got.why


def test_a_misordered_sheet_is_refused() -> None:
    """A sheet whose claims run BACKWARDS against the line order (a mis-parsed LRC, stacked timestamps read
    in reverse). Every affine map of it disagrees with our decode on all but a couple of lines."""
    reversed_claims = {index: OURS[len(OURS) - 1 - index] for index in OURS}
    got = cm.consensus(OURS, reversed_claims)
    assert not got.applied, got.why


def test_a_tempo_further_out_than_the_band_is_dropped() -> None:
    """|scale - 1| beyond `reconcile.MAX_SCALE_DRIFT` is a wrong pairing, not a faster master: the slope
    candidate is dropped (leaving the median, which cannot explain a drift) rather than clamped onto the
    boundary. The estimator is `reconcile.theil_sen` — ONE implementation, shared with the verdict (M4)."""
    assert rc.theil_sen([(t, 1.3 * t) for t in (10.0, 40.0, 70.0, 100.0, 130.0)]) is None
    got = cm.consensus(OURS, claims(scale=1.3))
    assert not got.applied, got.why


def test_a_map_that_moves_nothing_is_not_applied() -> None:
    """`MOVE_FLOOR_SEC`: a 10 ms shift is under the envelope's own frame, so no claim is rebound for it.

    Driven through `consensus` rather than the helper, because the guard that matters is the `and
    _moves(...)` in `applied`: a test calling `_moves` directly pinned the arithmetic and left the wiring
    free, and deleting the conjunct left the whole suite green. The band is tightened here so the 10 ms
    shift wins the vote outright (45 lines against no-shift's 0) and only the move floor can refuse it."""
    got = cm.consensus(OURS, claims(offset=0.01), tolerance_sec=0.005)
    assert got.inliers == 45 and got.baseline == 0, "the vote is won outright: nothing else may refuse it"
    assert not got.applied and got.candidate == cm.NO_SHIFT
    assert f"moves no paired claim by {cm.MOVE_FLOOR_SEC:.2f}s" in got.why
    assert got.at(claims(offset=0.01)[0]) == claims(offset=0.01)[0], "the identity, so nothing is rebound"
    tiny = cm.ClaimMap(pieces=(cm.Piece(from_sec=0.0, offset_sec=0.01),), applied=True)
    assert not cm._moves(tiny.pieces, [(start, start) for start in OURS.values()])


def test_the_best_of_several_poor_candidates_is_not_a_clock() -> None:
    """`MIN_INLIER_SHARE`, the absolute-quality floor the margin cannot supply.

    A sheet a human timed CORRECTLY against a blind decode that is poor and systematically late, which is
    never-be-alone's measured shape. Every candidate explains almost nothing, so no-shift explains nothing
    either and the margin, being a DIFFERENCE, is cleared by any candidate that finds two lines: the winner
    would have moved a correct sheet by +1.96 s on 9 of 47 paired lines (0.191, under the floor), and
    `reconcile` re-fits its own median so the verdict stays UNRELATED either way. It also bounds the MODE
    candidates, whose luckiest 0.5 s slice holds 16 of the 47; `_densest_offset`'s isolation test refuses."""
    truth = {index: 12.0 + 4.3 * index for index in range(47)}
    rng = random.Random(0)  # the decode, 0.4-3.0 s late line by line: a median exists, it explains nothing
    ours = {index: start + rng.uniform(0.4, 3.0) for index, start in truth.items()}
    pairs = sorted((truth[index], ours[index]) for index in truth)
    margin = max(cm.MIN_GAIN_LINES, int(cm.MIN_GAIN_SHARE * len(pairs)))
    assert cm._densest_offset(pairs, rc.AGREE_TOLERANCE_SEC, margin) is None, "no mode here, only a spread"
    got = cm.consensus(ours, truth)
    assert got.inliers >= got.baseline + got.margin, "the MARGIN would have accepted this map"
    assert got.inliers / got.pairs < cm.MIN_INLIER_SHARE
    assert not got.applied and got.candidate == cm.NO_SHIFT and got.pieces == ()
    assert f"under the {cm.MIN_INLIER_SHARE:.0%} floor" in got.why
    assert got.starts(truth) == truth, "a correct sheet keeps every one of its own timings"


def test_a_bimodal_decode_is_mapped_by_its_mode_where_the_median_lands_in_the_gap() -> None:
    """W4 review r1's regression, as the vote sees it: `never-be-alone` off3's own 44 differences.

    THE SHAPE, measured (the module docstring's WHY THE MODE): a song whose lines repeat, so the global decode
    smears 20 of them 4-9 s away, three lines land absurdly late, and 17 sit exactly on the sheet's +3 s
    displacement. The MEDIAN of that lands at -3.73 s — in the gap between the two modes — and explains 4 of
    44, under `MIN_INLIER_SHARE`, so the vote abstained and every window repair after it worked 3 s off the
    singing (44 gross lines, where W4-start's clock had 0). The densest window reads -3.07 s and explains 17.
    """
    deltas = [
        -8.87, -8.63, -8.43, -8.01, -7.59, -7.49, -7.43, -6.75, -6.71, -6.67, -6.65, -6.61, -6.57, -6.47,
        -6.29, -6.14, -5.63, -5.37, -4.73, -4.31, -3.98, -3.77, -3.69, -3.59, -3.23, -3.20, -3.17, -3.13,
        -3.11, -3.11, -3.07, -3.07, -3.07, -3.01, -3.01, -2.99, -2.93, -2.92, -2.89, -2.89, -2.83,
        8.23, 10.69, 20.07,
    ]  # fmt: skip
    claimed = {index: 20.0 + 4.0 * index for index in range(len(deltas))}
    ours = {index: claimed[index] + delta for index, delta in enumerate(deltas)}
    pairs = sorted((claimed[index], ours[index]) for index in claimed)
    assert cm._offset_for(pairs, 1.0) == pytest.approx(-3.73, abs=0.01), "the median is in the gap"
    # 3 rather than the measured 4: these differences are the trail's two-decimal print, and one of the four
    # sits exactly `AGREE_TOLERANCE_SEC` from the median, so the rounding decides it. The gap is the point.
    assert cm._inliers(pairs, cm._offset_for(pairs, 1.0), 1.0, rc.AGREE_TOLERANCE_SEC) == 3

    got = cm.consensus(ours, claimed)
    assert got.applied and got.candidate == cm.DECODE_MODE
    assert got.inliers == 17 and got.pairs == 44
    assert got.pieces[0].offset_sec == pytest.approx(-3.07, abs=0.01)
    assert f"mapped onto our clock by {cm.DECODE_MODE}" in got.why


def test_a_two_line_cluster_on_a_short_sheet_is_not_a_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """The mode candidates' own floor: a window is a FIT, so it needs `MIN_PAIRS` lines inside it.

    The shape is the common one rather than a corner: a SHORT sheet — six cues, a verse and a chorus —
    whose blind decode agrees with none of them, so no-shift explains 0 and any two lines landing the same
    distance out clear the 2-line margin. `MIN_INLIER_SHARE` cannot catch it either, a fifth of six pairs
    being 1.2 lines. Before this floor the vote APPLIED a +2.77 s shift off two lines and moved four correct
    cues with them, caught end to end by two hermetic exhibits (+2.77 s over 6 lines, -13.28 s over 8); over
    the 1088-case corpus run no applied mode map holds fewer than 7 lines, so the floor is inert there."""
    deltas = [2.65, 2.89, 6.4, 11.2, 15.9, 20.1]  # two lines 2.7 s out, the rest scattered
    claimed = {index: 10.0 + 10.0 * index for index in range(len(deltas))}
    ours = {index: claimed[index] + delta for index, delta in enumerate(deltas)}
    pairs = sorted((claimed[index], ours[index]) for index in claimed)
    margin = max(cm.MIN_GAIN_LINES, int(cm.MIN_GAIN_SHARE * len(pairs)))
    window = cm._inliers(pairs, 2.77, 1.0, rc.AGREE_TOLERANCE_SEC)
    assert window == 2 and window / len(pairs) >= cm.MIN_INLIER_SHARE, "the share floor would have passed it"
    assert window - cm._inliers(pairs, 0.0, 1.0, rc.AGREE_TOLERANCE_SEC) >= margin, "so would the margin"
    assert cm._densest_offset(pairs, rc.AGREE_TOLERANCE_SEC, margin) is None, "two lines are not a mode"

    got = cm.consensus(ours, claimed)
    assert not got.applied and got.candidate == cm.NO_SHIFT
    assert got.starts(claimed) == claimed, "a six-cue sheet keeps its own timings"

    # AND THE FLOOR IS `MIN_PAIRS` ITSELF, not a second 5: raising the number a fit may be believed on raises
    # this window's, which is the whole reason it is spelled as that literal.
    monkeypatch.setattr(cm, "MIN_PAIRS", 2)
    assert cm._densest_offset(pairs, rc.AGREE_TOLERANCE_SEC, margin) == pytest.approx(2.77, abs=0.01)


def test_the_share_of_the_margin_binds_from_sixty_pairs() -> None:
    """The other half of `MIN_GAIN_SHARE`'s comment, measured (W2 review r1): `int(0.05 x pairs)` passes the
    2-line floor at exactly 60 pairs, and 311 of the corpus's 1056 committed cases are that big.

    ONE SERIES, TWO LENGTHS. Two lines sit 0.44 s out and the rest exactly on our clock, with an envelope lag
    of 0.24 s offered: that candidate keeps the bulk (0.24 s, inside the band) AND picks up the two strays
    (0.20 s away), so it explains exactly 2 more lines than no-shift whatever the length. At 59 pairs the
    margin is 2 and the map applies; at 60 it is 3 and the same gain is refused.
    """

    def sheet(lines: int) -> tuple[dict[int, float], dict[int, float]]:
        ours = {index: 12.0 + 4.3 * index for index in range(lines)}
        return ours, {index: start - (0.44 if index in (5, 25) else 0.0) for index, start in ours.items()}

    at59 = cm.consensus(*sheet(59), envelope_lag=0.24)
    assert at59.applied and at59.margin == cm.MIN_GAIN_LINES
    assert at59.inliers - at59.baseline == 2, at59.why
    at60 = cm.consensus(*sheet(60), envelope_lag=0.24)
    assert at60.margin == int(cm.MIN_GAIN_SHARE * 60) == 3
    assert at60.inliers - at60.baseline == 2 and not at60.applied, at60.why
    assert "under the 3-line margin" in at60.why


# ── the mapping itself ───────────────────────────────────────────────────────────────────────────


def test_windows_map_with_their_starts_and_never_invert() -> None:
    got = cm.consensus(OURS, claims(offset=1.5))
    windows = {index: (start, start + 2.0) for index, start in claims(offset=1.5).items()}
    mapped = got.windows(windows)
    assert all(end >= start for start, end in mapped.values())
    assert abs(mapped[0][0] - OURS[0]) < 0.01 and abs(mapped[0][1] - (OURS[0] + 2.0)) < 0.01


def test_a_map_that_would_send_a_claim_before_zero_clamps_there() -> None:
    """A map that would send a claim before zero clamps there, as `place.apply_shift` does.

    A negative timestamp is not representable on a playhead and a window starting before the file cannot be
    decoded. Only an UNPAIRED claim can reach it: the paired claims are past the fitted offset by
    construction — the earliest is 52.0 s against an offset of -40 s — so the old version of this case never
    reached the clamp. `starts`/`windows` map EVERY claim, so a header our decode dropped, stamped inside
    the offset, is the reachable path: at 5.0 s it would publish -35 s."""
    early = {index: start + 40.0 for index, start in OURS.items()}
    got = cm.consensus(OURS, early)
    assert got.applied and abs(got.pieces[0].offset_sec + 40.0) < 0.01
    assert got.at(early[0]) == OURS[0], "no paired claim of THIS sheet reaches the clamp"
    assert got.pieces[0].at(5.0) == -35.0, "what the leg alone would say"
    assert got.at(5.0) == 0.0, "what the map says"
    with_header = {**early, 99: 5.0}
    assert got.starts(with_header)[99] == 0.0
    assert min(got.starts(with_header).values()) == 0.0
    assert got.windows({99: (5.0, 7.0)}) == {99: (0.0, 0.0)}, "a window before the file is a point at zero"


def test_the_scoring_clamp_counts_a_claim_the_leg_would_send_before_zero() -> None:
    """`_inliers`' OWN clamp, which is a different clamp from `ClaimMap.at`'s and was pinned by nothing.

    The shape that reaches it is a sheet otherwise late whose FIRST cue is stamped at 0.00 — the
    `[00:00.00]` an LRC commonly opens with — over a song that starts singing at once. The leg's arithmetic
    sends that cue to -5.0 s, where nothing can publish; clamped it is 0.0 s, within the band of the 0.1 s
    our decode measured. Scoring the unclamped value would count the line a MISS for a map that will in
    fact place it correctly, which is why this function clamps rather than reading `Piece.at`."""
    assert cm._inliers([(0.0, 0.1)], -5.0, 1.0, rc.AGREE_TOLERANCE_SEC) == 1, "clamped to 0.0, within 0.25"
    unclamped = sum(
        1 for theirs, ours in [(0.0, 0.1)] if abs(ours - (theirs - 5.0)) <= rc.AGREE_TOLERANCE_SEC
    )
    assert unclamped == 0, "and the leg's own value is 5.1 s away, so the clamp is what counts it"

    ours = {**OURS, 0: 0.1}
    opening = {index: start + 5.0 for index, start in OURS.items()} | {0: 0.0}
    got = cm.consensus(ours, opening)
    assert got.applied and got.candidate == cm.DECODE_MEDIAN
    assert got.pieces[0].at(0.0) == -5.0, "what the leg alone says about the opening stamp"
    assert got.at(0.0) == 0.0, "what the map will publish"
    assert got.inliers == 45, "all 45, because the opening stamp is scored where it will land"


def test_the_identity_map_is_a_no_op_on_everything() -> None:
    assert cm.IDENTITY.at(12.5) == 12.5
    assert cm.IDENTITY.starts({3: 9.0}) == {3: 9.0}
    assert cm.IDENTITY.windows({3: (9.0, 11.0)}) == {3: (9.0, 11.0)}


def test_the_vote_is_deterministic_and_reads_no_clock() -> None:
    """DBOS replays a step and the bench re-runs it: both must map identically. Nothing here is drawn or
    timed, and the only ordering the module takes is the claims' own, so insertion order cannot matter."""
    late = claims(offset=1.5)
    forwards = cm.consensus(OURS, late, envelope_lag=1.48)
    backwards = cm.consensus(
        dict(reversed(list(OURS.items()))),
        dict(reversed(list(late.items()))),
        envelope_lag=1.48,
    )
    assert forwards == backwards
    assert cm.consensus(OURS, late) == cm.consensus(OURS, late)


# ── the piecewise arm (default OFF: `Config.align_experiments`, `claimmap-piecewise`) ─────────────


def step_claims(step_at: int, first: float, second: float) -> dict[int, float]:
    """Claims offset by `first` up to line `step_at` and by `second` from it: an inserted section, or a
    sheet re-lineated mid-song."""
    return {index: start - (first if index < step_at else second) for index, start in OURS.items()}


def test_a_step_in_the_middle_is_left_alone_by_the_single_map() -> None:
    """The default answer to an inserted section: the LARGER half is already on our clock, so no single
    affine map beats no-shift and nothing moves — `reconcile` calls it STRUCTURAL and R2 repairs the
    disputed lines one at a time, inside claim windows that are still where the sheet put them."""
    got = cm.consensus(OURS, step_claims(25, 0.0, 3.0))
    assert not got.applied and got.baseline == 25, got.why
    assert got.inliers == got.baseline, "no candidate can explain both halves with one offset"


def test_the_piecewise_arm_finds_the_change_point() -> None:
    got = cm.consensus(OURS, step_claims(25, 0.0, 3.0), piecewise=True)
    assert got.applied and got.candidate == cm.PIECEWISE
    assert len(got.pieces) == 2 and got.inliers == 45, got.why
    assert abs(got.pieces[0].offset_sec) < 0.01 and abs(got.pieces[1].offset_sec - 3.0) < 0.01
    mapped = got.starts(step_claims(25, 0.0, 3.0))
    assert all(abs(mapped[index] - OURS[index]) < 0.05 for index in mapped)


def test_the_piecewise_arm_does_not_split_a_sheet_with_one_clock() -> None:
    """The critics' measurement, as a property: on an unperturbed sheet the arm must find nothing to split,
    so switching it on cannot move a song whose sheet is simply offset."""
    late = claims(offset=1.5)
    assert cm.consensus(OURS, late, piecewise=True) == cm.consensus(OURS, late, piecewise=False)


def _stepped(bounds: Sequence[int], offsets: Sequence[float]) -> dict[int, float]:
    """Claims stepped by `offsets`, changing at each of `bounds`: a sheet re-lineated more than once."""
    return {
        index: start - offsets[sum(1 for edge in bounds if index >= edge)] for index, start in OURS.items()
    }


def test_the_piecewise_budget_costs_a_four_step_sheet_one_of_its_steps() -> None:
    """`MAX_PIECES` as what it actually does: a four-step sheet pays one of its steps.

    The old assertion held for any budget of 3 or more — lowering `MAX_PIECES` from 4 to 2 left the suite
    green — and claimed the fixture produced `MAX_PIECES` legs. It produces THREE, explaining 36 of 45
    lines, and the reason is the recursion rather than the data: `_split` halves the budget at each level,
    so a budget of 4 buys one cut and then one further cut in ONE half. The 2.0 s group is the one never
    cut, and those nine lines are exactly the ones left outside the tolerance; at a budget of 8 the same
    sheet reaches 4 legs and 44 of 45."""
    stepped = _stepped((9, 18, 27), (0.0, 2.0, 4.0, 6.0))
    got = cm.consensus(OURS, stepped, piecewise=True)
    assert got.applied and got.candidate == cm.PIECEWISE
    assert len(got.pieces) == 3, got.why
    assert got.inliers == 36 and got.baseline == 9, got.why
    assert [round(piece.offset_sec, 2) for piece in got.pieces] == [0.0, 4.0, 6.0], got.why
    mapped = got.starts(stepped)
    outside = sorted(i for i in mapped if abs(mapped[i] - OURS[i]) > rc.AGREE_TOLERANCE_SEC)
    assert outside == list(range(9, 18)), "the 2.0 s group is the step the halved budget never cuts"


def test_the_piecewise_budget_is_a_ceiling_a_sheet_can_actually_reach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half: a sheet whose steps the recursion CAN cut reaches exactly `MAX_PIECES` legs and stops
    there, and the budget is what stops it (W2 review r2 — nothing pinned the constant's value).

    Four steps 4.0 s apart at lines 11/22/33, so each half of the recursion has a cut worth making: 4 legs
    and 44 of 45 lines explained. Raising the budget to 8 changes nothing — the sheet has four legs and no
    more — while lowering it to 2 collapses the map to two legs explaining 23 of 45, less than the sheet's
    own halves. So the ceiling is reached, is not exceeded, and is not inert.
    """
    stepped = _stepped((11, 22, 33), (0.0, 4.0, 8.0, 12.0))
    got = cm.consensus(OURS, stepped, piecewise=True)
    assert got.applied and len(got.pieces) == cm.MAX_PIECES == 4, got.why
    assert got.inliers == 44, got.why
    assert [round(piece.offset_sec, 2) for piece in got.pieces] == [0.0, 4.0, 8.0, 12.0], got.why

    monkeypatch.setattr(cm, "MAX_PIECES", 8)
    generous = cm.consensus(OURS, stepped, piecewise=True)
    assert generous.pieces == got.pieces, "four legs is the sheet's own shape, not the budget's"

    monkeypatch.setattr(cm, "MAX_PIECES", 2)
    mean = cm.consensus(OURS, stepped, piecewise=True)
    assert len(mean.pieces) == 2 and mean.inliers == 23, mean.why


def test_a_piecewise_map_that_would_reorder_the_claims_is_refused() -> None:
    """A step DOWN big enough to send a later claim before an earlier one would hand two repair windows to
    the wrong lines. `_monotonic` refuses it; a single leg can never trip it."""
    down = (cm.Piece(from_sec=0.0, offset_sec=0.0), cm.Piece(from_sec=100.0, offset_sec=-60.0))
    assert not cm._monotonic(down)
    assert cm._monotonic((cm.Piece(from_sec=0.0, offset_sec=-60.0),))


def test_a_step_down_is_refused_on_the_boundary_not_on_a_sample_of_the_pairs() -> None:
    """The order test is about EVERY claim, and the unpaired ones are where a step down bites.

    Legs `[+5.0s from 0, 0.0s from 30]` keep the paired claims at 10/30/60 in order, so a sampled test
    admitted them — while an unpaired claim at 29.0 mapped to 34.0, past the paired 30.0 that stayed put:
    two repair windows handed to the wrong lines. Pinned through the arm too, on an ordinary sheet 3 s late
    for its first 25 lines: the split explains all 45 against the single map's 25, so the margin admits it
    and its legs step DOWN by 3 s, and the boundary test is what sends the arm back to the single map."""
    down = (cm.Piece(from_sec=0.0, offset_sec=5.0), cm.Piece(from_sec=30.0, offset_sec=0.0))
    assert not cm._monotonic(down)
    would_map = cm.ClaimMap(pieces=down, applied=True)
    assert would_map.at(29.0) == 34.0 > would_map.at(30.0) == 30.0, "the swap the boundary test prevents"
    stepped = step_claims(25, 3.0, 0.0)
    got = cm.consensus(OURS, stepped, piecewise=True)
    assert got.applied and got.candidate == cm.DECODE_MEDIAN and len(got.pieces) == 1, got.why
    assert cm.consensus(OURS, stepped, piecewise=True) == cm.consensus(OURS, stepped, piecewise=False)
