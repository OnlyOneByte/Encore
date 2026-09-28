"""Reconciliation: each diagnosis class synthesized, and the abstentions that keep it honest.

The classes matter because each drives a DIFFERENT stage-4 action: AGREE/OFFSET/DRIFT boost confidence
wholesale, STRUCTURAL boosts some lines and cuts others, UNRELATED confers nothing and sends the caller to
envelope arbitration. A misclassification is not a wrong label — it is the wrong action.
"""

from __future__ import annotations

from dataclasses import dataclass

from encore_worker.domain.lyrics import reconcile as rc


@dataclass(frozen=True)
class L:
    index: int
    start: float


def series(*starts: float, first_index: int = 0) -> list[L]:
    return [L(index=first_index + i, start=s) for i, s in enumerate(starts)]


def claims(lines: list[L], offset: float = 0.0, scale: float = 1.0) -> dict[int, float]:
    """Claims derived from our own series — the controlled way to synthesize each residual pattern."""
    return {line.index: (line.start - offset) / scale for line in lines}


OURS = series(13.2, 16.5, 19.7, 24.0, 28.3, 33.1, 37.9, 42.2)


# ── the classes ──────────────────────────────────────────────────────────────────────────────────


def test_agreement_is_agree_and_every_line_corroborates() -> None:
    got = rc.reconcile(OURS, claims(OURS, offset=0.05))
    assert got.verdict == rc.AGREE
    assert got.corroborates
    assert all(line.corroborated for line in got.lines)


def test_a_constant_offset_is_offset_and_still_corroborates_line_for_line() -> None:
    """An LRC for another master: uniformly 1.2 s off. The lines still corroborate — the OFFSET is a fact
    about the claim, not a defect in our timings — and the trail gets the number."""
    got = rc.reconcile(OURS, claims(OURS, offset=1.2))
    assert got.verdict == rc.OFFSET
    assert got.corroborates
    assert abs(got.offset_sec - 1.2) < 0.05
    assert all(line.corroborated for line in got.lines)
    assert "1.2" in got.why


def test_a_tempo_difference_is_drift() -> None:
    """A speed-adjusted master: claims run 5% slow. Every line agrees once the scale is fitted."""
    got = rc.reconcile(OURS, claims(OURS, scale=1.05))
    assert got.verdict == rc.DRIFT
    assert got.corroborates
    assert abs(got.scale - 1.05) < 0.01


def test_a_variant_section_is_structural_and_flags_exactly_the_disagreeing_lines() -> None:
    """An extra chorus: five lines agree, three sit seconds away. THE CLASS F2 NEEDS — on repeated text the
    disagreeing lines are where the decode may have bound a repeat to the wrong occurrence, and the claim
    is the only occurrence-anchor available."""
    theirs = claims(OURS)
    for index in (5, 6, 7):
        theirs[index] += 8.0
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.STRUCTURAL
    assert got.corroborates
    corroborated = {line.index for line in got.lines if line.corroborated}
    assert corroborated == {0, 1, 2, 3, 4}


def test_no_structure_at_all_is_unrelated_and_confers_nothing() -> None:
    """A different song's LRC. Crucially the verdict does NOT say which side is wrong — this module cannot
    know, and its `why` sends the caller to envelope arbitration rather than pretending."""
    theirs = {i: v for i, v in enumerate([3.0, 91.0, 7.5, 55.0, 120.0, 12.0, 88.0, 30.0])}
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.UNRELATED
    assert not got.corroborates
    assert got.lines == ()
    assert "envelope" in got.why


# ── abstentions ──────────────────────────────────────────────────────────────────────────────────


def test_too_few_pairs_is_no_claims() -> None:
    """Two points always fit. Mirrors `place.MIN_PAIRS`."""
    got = rc.reconcile(OURS[:2], claims(OURS[:2]))
    assert got.verdict == rc.NO_CLAIMS
    assert not got.corroborates


def test_an_empty_claim_mapping_is_no_claims() -> None:
    assert rc.reconcile(OURS, {}).verdict == rc.NO_CLAIMS


def test_a_small_offset_is_agreement_not_a_finding() -> None:
    """0.2 s is inside the two measurements' combined jitter; reporting it as OFFSET would send an operator
    chasing a number that is noise."""
    got = rc.reconcile(OURS, claims(OURS, offset=0.2))
    assert got.verdict == rc.AGREE


# ── pairing by identity, the F1 lesson applied here ──────────────────────────────────────────────


def test_pairing_is_by_line_index_never_by_position() -> None:
    """`generate` drops unalignable lines (a decorative '♪') but keeps `index`. The claims here cover
    indexes 1..8 while our surviving lines are 1,2,4..8 — position-pairing would shear everything after
    the gap; index-pairing must not."""
    ours = [L(1, 16.5), L(2, 19.7), L(4, 28.3), L(5, 33.1), L(6, 37.9), L(7, 42.2)]
    theirs = {line.index: line.start - 1.0 for line in ours}
    theirs[3] = 999.0  # a claim for a line WE dropped: must simply not pair
    got = rc.reconcile(ours, theirs)
    assert got.verdict == rc.OFFSET
    assert got.pairs == 6
    assert abs(got.offset_sec - 1.0) < 0.05


def test_claims_for_lines_we_do_not_have_are_ignored_not_mismatched() -> None:
    theirs = claims(OURS)
    theirs[99] = 5.0
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.AGREE
    assert got.pairs == len(OURS)


# ── the evidence travels ─────────────────────────────────────────────────────────────────────────


def test_raw_residuals_are_carried_per_line_for_the_trail() -> None:
    """The trail-facing number is the RAW residual (offset not removed): an operator reading
    'residual +1.21 s' should see the sheet's actual displacement, not a post-fit zero."""
    got = rc.reconcile(OURS, claims(OURS, offset=1.2))
    assert all(abs(line.residual_sec - 1.2) < 0.05 for line in got.lines)


def test_every_verdict_carries_a_why_with_numbers() -> None:
    for theirs in (claims(OURS), claims(OURS, offset=1.2), claims(OURS, scale=1.05), {}):
        got = rc.reconcile(OURS, theirs)
        assert got.why and any(ch.isdigit() for ch in got.why)


# ── the coarse band, found on real material ──────────────────────────────────────────────────────


def test_loose_agreement_is_coarse_not_unrelated() -> None:
    """Numb, in miniature: fewer than half the lines agree finely, but nearly all agree at phrase scale.
    UNRELATED here would trigger the caller's re-anchoring repair — measured to make the timings WORSE
    (MAD 312 -> 563 ms) — so the verdict must say 'same performance, sloppy timing' and corroborate."""
    jitter = [0.3, -0.35, 0.45, -0.4, 0.5, -0.45, 0.35, -0.3]
    theirs = {line.index: line.start - j for line, j in zip(OURS, jitter, strict=True)}
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.COARSE
    assert got.corroborates
    assert "grade" in got.why


def test_truly_scattered_claims_are_still_unrelated() -> None:
    theirs = {i: v for i, v in enumerate([3.0, 91.0, 7.5, 55.0, 120.0, 12.0, 88.0, 30.0])}
    assert rc.reconcile(OURS, theirs).verdict == rc.UNRELATED


def test_coarse_carries_per_line_residuals_so_the_caller_can_repair_only_gross_lines() -> None:
    """COARSE grades the jitter but the CALLER still repairs grossly-displaced lines (Avercage: 6 lines
    seconds off inside an otherwise loosely-timed sheet). The verdict must therefore carry per-line
    residuals AND an offset, so the caller can pick out |residual - offset| > COARSE_TOLERANCE."""
    # A smooth spread of jitter (no cluster a fitted offset can rescue): only a few land within the fine
    # tolerance, so the sheet agrees at phrase scale — COARSE — while one claim sits seconds off.
    jitter = [-0.8, -0.57, -0.34, -0.11, 0.12, 0.35, 0.58, 0.81]
    theirs = {line.index: line.start - j for line, j in zip(OURS, jitter, strict=True)}
    theirs[7] += 6.0  # one grossly displaced claim inside the coarse majority
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.COARSE
    gross = [j.index for j in got.lines if abs(j.residual_sec - got.offset_sec) > rc.COARSE_TOLERANCE_SEC]
    assert gross == [7], "only the seconds-off line is a repair candidate; the jitter is graded as-is"


# ── agrees: the verdict's own test, for a line whose timing changed after it was taken ───────────────


#: A smooth spread of claim jitter: with one claim seconds off as well, COARSE (see the test above).
SMOOTH_JITTER = [-0.8, -0.57, -0.34, -0.11, 0.12, 0.35, 0.58, 0.81]


def test_agrees_reproduces_every_line_judgement_on_the_verdicts_fitted_clock() -> None:
    """`Reconciliation.agrees` is what grading asks of a REPAIRED line (review H4): would it still
    corroborate on the blind verdict's clock? It must be the very test `reconcile` judged each line by —
    under an offset, a drift, a structural split and a coarse sheet — or grading and the verdict disagree."""
    split = claims(OURS)
    split[5] += 8.0
    split[6] += 8.0
    loose = {line.index: line.start - j for line, j in zip(OURS, SMOOTH_JITTER, strict=True)}
    loose[7] += 6.0
    cases = {
        rc.OFFSET: claims(OURS, offset=1.2),
        rc.DRIFT: claims(OURS, scale=1.05),
        rc.STRUCTURAL: split,
        rc.COARSE: loose,
    }
    for verdict, theirs in cases.items():
        got = rc.reconcile(OURS, theirs)
        assert got.verdict == verdict
        for judged in got.lines:
            start = OURS[judged.index].start
            assert got.agrees(start, theirs[judged.index]) == judged.corroborated, (verdict, judged)


def test_agrees_moves_with_the_line_not_the_claim() -> None:
    """The H4 exhibit in miniature: claims 2.5 s late, the verdict an OFFSET that corroborates every line.
    A repair that parks a line at the claim minus the 1 s pad no longer sits where the two witnesses
    agreed it is sung, so it no longer agrees; one within tolerance of its blind position still does."""
    theirs = claims(OURS, offset=-2.5)
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.OFFSET
    line = OURS[3]
    assert got.agrees(line.start + 0.2, theirs[line.index])
    assert not got.agrees(theirs[line.index] - 1.0, theirs[line.index])


def test_a_verdict_that_confers_nothing_agrees_with_nothing() -> None:
    scattered = {i: v for i, v in enumerate([3.0, 91.0, 7.5, 55.0, 120.0, 12.0, 88.0, 30.0])}
    unrelated = rc.reconcile(OURS, scattered)
    assert not unrelated.agrees(OURS[0].start, scattered[0])
    none = rc.reconcile(OURS[:2], claims(OURS[:2]))
    assert not none.agrees(OURS[0].start, OURS[0].start)


# ── as claimed: the LINE_SYNC rung's timing witness (W3) ─────────────────────────────────────────


def test_as_claimed_reads_an_offset_as_the_error_it_publishes() -> None:
    """Where the CLAIMS publish (a line document), an offset that `reconcile` rightly calls corroborating is
    every line late: nothing is removed, so a sheet 1.2 s off reads 0% near, its lag on the trail."""
    assert rc.reconcile(OURS, claims(OURS, offset=1.2)).corroborates
    late = rc.as_claimed(OURS, claims(OURS, offset=1.2))
    assert late is not None and late.near == 0.0 and late.pairs == len(OURS)
    assert abs(late.offset_sec - 1.2) < 1e-9 and "median lag +1.20 s" in late.why()
    close = rc.as_claimed(OURS, claims(OURS, offset=0.4))
    assert close is not None and close.near == 1.0, "within the coarse tolerance (1 s): the same place"
    assert rc.as_claimed(OURS, claims(OURS, offset=0.4), tolerance_sec=0.25) == rc.AsClaimed(
        near=0.0, pairs=len(OURS), tolerance_sec=0.25, offset_sec=close.offset_sec
    )


def test_as_claimed_pairs_by_line_index_and_abstains_under_three_pairs() -> None:
    """Paired by `Line.index` as `reconcile` pairs: a line the decode dropped, or a claim for a line it never
    had, is left out rather than shearing every comparison after it."""
    decoded = [L(0, 1.0), L(2, 5.0), L(3, 9.0), L(5, 14.0)]  # lines 1 and 4 not decoded
    got = rc.as_claimed(decoded, {0: 1.1, 1: 3.0, 2: 5.2, 3: 12.0, 4: 13.0, 5: 14.0})
    assert got is not None and got.pairs == 4 and got.near == 0.75
    assert rc.as_claimed(decoded, {0: 1.0, 2: 5.0}) is None, "two pairs: a fit through two points"
    assert rc.as_claimed([], {0: 1.0}) is None
