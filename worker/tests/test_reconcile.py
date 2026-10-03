"""Reconciliation: each diagnosis class synthesized, and the abstentions that keep it honest.

The classes matter because each drives a DIFFERENT stage-4 action: AGREE/OFFSET/DRIFT boost confidence
wholesale, STRUCTURAL boosts some lines and cuts others, UNRELATED confers nothing and sends the caller to
envelope arbitration. A misclassification is not a wrong label — it is the wrong action.

The last section is review M4's statistics, run as tests over SEEDED random series, because that is the form
the finding took: not "this case is wrong" but "1993 of 2000 random 3-pair series come out STRUCTURAL". A
taxonomy is only as good as its behaviour on noise, and noise is cheap to draw.
"""

from __future__ import annotations

import random
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
    """A speed-adjusted master: claims run 2% slow (the bench's tempo mode). Every line agrees once the
    bounded Theil-Sen scale is fitted, and the scale is the one `claimmap` would move the claims by."""
    got = rc.reconcile(OURS, claims(OURS, scale=1.02))
    assert got.verdict == rc.DRIFT
    assert got.corroborates
    assert abs(got.scale - 1.02) < 0.001
    assert got.agreement == 1.0 and got.disputed == ()


def test_a_tempo_beyond_the_band_is_graded_coarse_rather_than_fitted() -> None:
    """|scale - 1| past `MAX_SCALE_DRIFT` is dropped, not clamped (`theil_sen`), so a sheet 5% out is no
    longer DRIFT: with scale 1 its residuals ramp 0.6 -> 2.0 s and it reads as what it is to a caller — one
    performance, loosely aligned, nothing to repair. Two masters differ by 2-5%; a bigger ratio is far more
    often a wrong pairing, and W2 lets `claimmap` and the verdict share the one band so a sheet this module
    calls a drift is a sheet that module would move (review M4, §3.11)."""
    got = rc.reconcile(OURS, claims(OURS, scale=1.05))
    assert got.verdict == rc.COARSE
    assert got.corroborates and got.scale == 1.0
    assert got.disputed == (), "a 2 s ramp is inside the phrase band: graded, not repaired"


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
    for theirs in (claims(OURS), claims(OURS, offset=1.2), claims(OURS, scale=1.02), {}):
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


def test_coarse_disputes_only_the_grossly_displaced_line() -> None:
    """COARSE grades the jitter but the CALLER still repairs grossly-displaced lines (Avercage: 6 lines
    seconds off inside an otherwise loosely-timed sheet). `disputed` is what it repairs, and on a sheet this
    loose the band opens to the phrase tolerance `COARSE_TOLERANCE_SEC` — a FIXED 1.0 s, which is exactly the
    rule the caller applied by hand before W2, moved into `Reconciliation.disputed`. NOT derived from the
    sheet's own spread: that version was built (4 robust sigmas) and reverted for costing Kinematic 3 of 14
    lines within ±500 ms, and `reconcile`'s WHAT THE SPREAD IS NOT paragraph keeps the reason."""
    # A smooth spread of jitter (no cluster a fitted offset can rescue): only a few land within the fine
    # tolerance, so the sheet agrees at phrase scale — COARSE — while one claim sits seconds off.
    jitter = [-0.8, -0.57, -0.34, -0.11, 0.12, 0.35, 0.58, 0.81]
    theirs = {line.index: line.start - j for line, j in zip(OURS, jitter, strict=True)}
    theirs[7] += 6.0  # one grossly displaced claim inside the coarse majority
    got = rc.reconcile(OURS, theirs)
    assert got.verdict == rc.COARSE
    assert got.disputed == (7,), "only the seconds-off line is a repair candidate; the jitter is graded as-is"


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
        rc.DRIFT: claims(OURS, scale=1.02),
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


# ── review M4: the statistics the finding was made of, as tests over seeded noise ─────────────────


def noise(rng: random.Random, pairs: int, span: float = 200.0) -> tuple[list[L], dict[int, float]]:
    """Two independent ascending series over the same span: a claim sheet for a DIFFERENT song, and the
    shape the old taxonomy read as STRUCTURAL. Sorted because real timings ascend; that is what made both
    endpoints of an unbounded span-ratio fit land exactly."""
    ours = sorted(rng.uniform(0.0, span) for _ in range(pairs))
    theirs = sorted(rng.uniform(0.0, span) for _ in range(pairs))
    return [L(index=i, start=o) for i, o in enumerate(ours)], dict(enumerate(theirs))


def test_random_series_are_unrelated_not_structural() -> None:
    """THE M4 HEADLINE: 1993 of 2000 random 3-pair series used to come out STRUCTURAL — two endpoints always
    fit an unbounded span ratio — and the caller then re-decoded lines inside claim windows on that verdict.

    Measured on this tree, 2000 seeded draws per width: 3 and 4 pairs 2000/2000 `TOO_FEW_PAIRS` with 0 lines
    disputed; 5 pairs 1997 UNRELATED / 2 STRUCTURAL / 1 COARSE, 4 disputed over 10 000 lines; 8 pairs 1999
    UNRELATED / 1 STRUCTURAL, 4 disputed over 16 000; 20 pairs 2000/2000 UNRELATED. The handful at 5 and 8 is
    the honest residue of a floor at 5. Below the floor the verdict is its OWN rather than UNRELATED, which
    is what arms R1 — the caller's widest repair — so a random 3-pair series must reach no repair at all."""
    for pairs, floor in ((3, 2000), (4, 2000), (5, 1997), (8, 1999), (20, 2000)):
        rng = random.Random(20260928)
        got = [rc.reconcile(*noise(rng, pairs)) for _ in range(2000)]
        verdicts = [judged.verdict for judged in got]
        if pairs < rc.MIN_FITTED_PAIRS:
            assert verdicts.count(rc.TOO_FEW_PAIRS) == 2000, f"{pairs} pairs cannot support a fitted verdict"
            assert verdicts.count(rc.UNRELATED) == 0, f"{pairs} pairs must not arm the caller's R1"
            assert not any(judged.corroborates or judged.disputed for judged in got)
        else:
            unrelated = verdicts.count(rc.UNRELATED)
            assert unrelated >= floor, f"{pairs} pairs: only {unrelated}/2000 unrelated"


def test_an_offset_sheet_with_jitter_is_an_offset_and_disputes_nothing() -> None:
    """The second M4 statistic, and the one with teeth: a +/-1.5 s LRC with 150 ms jitter read STRUCTURAL
    about 98% of the time, so the caller's R2 re-decoded every line the jitter pushed past 250 ms — the
    repair Numb measured as harmful (MAD 312 -> 563 ms). Measured on this tree over 2000 seeded 40-line
    draws: 1463 OFFSET, 535 COARSE, 2 DRIFT, NO STRUCTURAL, and 0 disputed lines out of 80 000 against
    roughly one line in ten before. Mean residual MAD 0.099 s, the jitter drawn. Every draw still
    CORROBORATES — the sheet is good evidence, it is just late — so nothing is lost but the repairs.
    """
    rng = random.Random(7)
    verdicts: list[str] = []
    disputed = 0
    for _ in range(2000):
        truth = [10.0 + 4.0 * i for i in range(40)]
        ours = [L(index=i, start=t + rng.gauss(0.0, 0.15)) for i, t in enumerate(truth)]
        got = rc.reconcile(ours, {i: t - 1.5 for i, t in enumerate(truth)})
        verdicts.append(got.verdict)
        disputed += len(got.disputed)
        assert got.corroborates, got.why
    assert verdicts.count(rc.STRUCTURAL) == 0, f"{verdicts.count(rc.STRUCTURAL)}/2000 structural"
    assert verdicts.count(rc.OFFSET) >= 1400, f"{verdicts.count(rc.OFFSET)}/2000 offset"
    assert disputed == 0, f"{disputed} jitter-disputed lines would be re-decoded inside claim windows"


def test_a_two_percent_tempo_sheet_flags_no_line_gross() -> None:
    """Review's repro s9, kept as its script wrote it (seed 3, 50 lines 4 s apart, +/-0.55 s of loose
    timing on our side). The caller's pre-W2 gross test read the RAW residual against the fitted offset, so
    a tempo sheet's linear ramp made 38/50 lines look grossly displaced and R2 re-decoded them all. With the
    scale fitted and the residual taken against the MODEL, `disputed` is empty at 1.02 and at 1.0417, while
    the old formula on this tree would flag 37 and 46."""
    theirs = {i: 10.0 + 4.0 * i for i in range(50)}
    rng = random.Random(3)
    for scale, old_rule in ((1.0, 0), (1.02, 37), (1.0417, 46)):
        ours = [L(index=i, start=t * scale + rng.uniform(-0.55, 0.55)) for i, t in theirs.items()]
        got = rc.reconcile(ours, theirs)
        assert got.verdict == rc.COARSE and got.corroborates
        assert got.disputed == (), f"scale {scale}: {len(got.disputed)} lines would be re-decoded"
        flagged = [
            j.index for j in got.lines if abs(j.residual_sec - got.offset_sec) > rc.COARSE_TOLERANCE_SEC
        ]
        assert len(flagged) == old_rule, f"scale {scale}: the raw-residual rule flags {len(flagged)}"


def test_the_fitted_scale_is_bounded_and_the_model_residual_carries_it() -> None:
    """`residual_sec` stays RAW for the trail and `model_residual_sec` is the fitted one — the two are the
    same number only on a sheet with no offset and no drift. A caller that thresholds the raw residual is
    reading the whole sheet's displacement, which is how s9 happened."""
    got = rc.reconcile(OURS, claims(OURS, offset=1.2, scale=1.02))
    assert got.verdict == rc.DRIFT and abs(got.scale - 1.02) < 0.001
    assert all(abs(j.model_residual_sec) < 1e-6 for j in got.lines), "the fit explains every line"
    assert all(abs(j.residual_sec) > 0.5 for j in got.lines), "the raw residual still carries offset+drift"
    assert got.spread_sec < 1e-6 and got.disputed == ()


def test_a_fitted_verdict_needs_five_pairs() -> None:
    """Four pairs, three agreeing and one 8 s out: the shape of a variant section, and not enough evidence
    to call it one (M4 asked for >= 5 pairs before STRUCTURAL or COARSE).

    And the fallthrough is an ABSTENTION, not UNRELATED, which this case used to read while its docstring
    called that "a measurement". UNRELATED is the ONE verdict that arms R1, which re-decodes every claimed
    line inside its claim window and may adopt a claim span over a good blind timing — the sweeping action,
    armed by the very floor that exists to distrust four points. `TOO_FEW_PAIRS` confers, disputes and arms
    nothing; the same series with five agreeing lines IS structural."""
    four = series(13.2, 16.5, 19.7, 24.0)
    theirs = claims(four)
    theirs[3] += 8.0
    got = rc.reconcile(four, theirs)
    assert got.verdict == rc.TOO_FEW_PAIRS and got.verdict != rc.UNRELATED
    assert not got.corroborates and got.disputed == ()
    assert f"{rc.MIN_FITTED_PAIRS} pairs are needed" in got.why
    six = series(13.2, 16.5, 19.7, 24.0, 28.3, 33.1)
    wider = claims(six)
    wider[5] += 8.0
    assert rc.reconcile(six, wider).verdict == rc.STRUCTURAL


def test_the_inlier_share_alone_decides_a_fitted_verdict() -> None:
    """Why there is no MAD band in the AGREE / OFFSET / DRIFT test, as a property.

    M4 asked for ">= 90% inliers AND a small MAD" and reconcile shipped a conjunction whose second half can
    never be False when the first is True: the model is centred on `median(ours - scale x claimed)`, so
    `median(residual) == 0` identically and `spread_sec == median(|residual|)`, and once nine residuals in
    ten are inside `AGREE_TOLERANCE_SEC` their median absolute value cannot exceed it. The conjunct was dead
    code claiming to be a safeguard. This case is the guard on its deletion, measured over seeded series of
    every shape the ladder sees, so a changed `INLIER_SHARE` fails here rather than re-opening it."""
    rng = random.Random(4041)
    fitted = 0
    for _ in range(4000):
        pairs = rng.randint(rc.MIN_PAIRS, 40)
        offset, scale = rng.uniform(-3.0, 3.0), rng.uniform(0.97, 1.03)
        jitter = rng.uniform(0.02, 0.35)
        ours = sorted(rng.uniform(0.0, 220.0) for _ in range(pairs))
        lines = [L(index=index, start=start) for index, start in enumerate(ours)]
        theirs = {
            index: (start - offset) / scale + rng.gauss(0.0, jitter) for index, start in enumerate(ours)
        }
        for index in range(pairs):  # the wild stamps every hand-timed sheet carries
            if rng.random() < 0.05:
                theirs[index] += rng.uniform(-60.0, 60.0)
        got = rc.reconcile(lines, theirs)
        if got.verdict in (rc.AGREE, rc.OFFSET, rc.DRIFT):
            fitted += 1
            assert got.spread_sec <= rc.AGREE_TOLERANCE_SEC, (
                f"a fitted verdict whose MAD a band could have refused: {got.why}"
            )
    assert fitted > 1000, f"only {fitted} fitted verdicts drawn: the property was barely exercised"


def test_a_stray_stamp_in_a_tight_sheet_is_disputed_not_a_verdict() -> None:
    """One misbound line in twenty (F2's shape: a repeated chorus the decode bound to the wrong occurrence).
    The sheet keeps its OFFSET verdict — one stray in twenty is not a variant section — while the stray is
    both uncorroborated AND disputed, which is what sends the caller to re-decode it inside its claim
    window. Before W2 the same input was STRUCTURAL: the label changed, the action did not."""
    ours = series(*[10.0 + 4.0 * i for i in range(20)])
    theirs = claims(ours, offset=1.4)
    theirs[11] -= 5.0
    got = rc.reconcile(ours, theirs)
    assert got.verdict == rc.OFFSET and got.corroborates
    assert got.disputed == (11,)
    assert {j.index for j in got.lines if not j.corroborated} == {11}
