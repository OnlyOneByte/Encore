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
