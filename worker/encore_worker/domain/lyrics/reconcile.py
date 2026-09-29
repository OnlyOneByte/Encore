"""Reconciling CLAIMED timings against the timings we generated ourselves — stage 3 of alignment v2.

THE ROLE REVERSAL (docs/PLAN-alignment-v2.md). Claimed timings — an LRC's line stamps, another aligner's
words — used to be the search space, so their errors passed straight through. `generate` now produces our
own timings from text alone, and the claims become EVIDENCE: compared against ours, they either corroborate
(two independent measurements agreeing is the strongest signal available) or they diagnose which of several
known failure shapes this sheet has.

THE DIAGNOSIS CLASSES, each with a distinct residual pattern and a distinct action:

    AGREE        residuals ~0 line by line. Corroborated lines can be published at word confidence even
                 where the decode's own score is middling — agreement is the better evidence (F3: the path
                 score alone grades weakly).
    OFFSET       residuals constant and non-zero: an LRC cut for another master. Our timings are already
                 correct; the offset is a fact about the CLAIM, recorded for the trail.
    DRIFT        residuals grow linearly: a different tempo or a speed-adjusted master. Same action.
    STRUCTURAL   most lines agree, a contiguous minority disagree: an extra chorus, a variant verse, an
                 ad-lib block. The agreeing lines gain confidence; the disagreeing ones LOSE it — on a
                 repeated-chorus text those are exactly the lines the global decode may have misassigned
                 (F2), and the claim is the only occurrence-anchor available.
    COARSE       the whole sheet is loosely timed: nothing like line-for-line agreement, but every line
                 within a phrase of its claim. Same performance, sloppy timing on one side — GRADE it,
                 never repair it (a re-decode against jitter is regression fuel; measured on Numb).
    UNRELATED    no structure at all, on enough pairs to be sure of that. Either the claim is for a different
                 song or our decode is garbage; this module cannot tell WHICH, so it says so and the caller
                 arbitrates with the activity envelope (`domain/audio/activity.py`) — the one gate measured to
                 separate right from wrong text (path scores cannot; measured, F5 in the plan).
    TOO_FEW_     three or four pairs that do not agree: the same residual pattern as UNRELATED with none of
    PAIRS        its evidence. Its own verdict since W2 (review r1), because UNRELATED is not a neutral
                 fallthrough — it ARMS the caller's most sweeping repair (R1 re-decodes EVERY claimed line
                 inside its claim window and may adopt the claim span wholesale), and arming that on three
                 points is the opposite of what `MIN_FITTED_PAIRS` was raised for. This verdict confers
                 nothing, disputes nothing and triggers nothing: the sheet keeps its timings, no line is
                 re-decoded, and `lines` is empty so no line is corroborated either.
                 IT DOES LOWER CONFIDENCE, and the r1 wording that stopped at "triggers nothing" read as
                 though it did not (W2 review r2). It is in `DISAGREE`, so the caller's `claims_disagree`
                 grades every line `low` — including lines sitting ON their own claims, which this verdict
                 cannot see because it returns no judgements. That is the one direction an unresolved
                 disagreement may move a grade, and the cliff it makes is real: a TWO-pair sheet is
                 `NO_CLAIMS` and grades those same lines `high`. The trade is in the caller's own test
                 (`test_too_few_pairs_grades_every_line_low_and_that_is_a_cliff`): at three or four pairs
                 nothing can tell a mostly-right sheet from a different song's, and a wrong sheet's unique
                 lines graded `high` seconds off the vocal is the worse failure.

THE VERDICT IS READ OFF THE RESIDUAL DISTRIBUTION, not off exact agreement (review M4; W2). Until W2 the
ladder asked `agreement == 1.0`, so ONE stray line out of fifty made a sheet STRUCTURAL and OFFSET was
effectively unreachable: a +/-1.5 s LRC with 150 ms jitter read STRUCTURAL about 98% of the time, and the
caller's R2 then re-decoded every jitter-disputed line — the exact repair Numb measured as harmful. The fit
was fragile the same way: an UNBOUNDED endpoint span ratio (`MAX_SCALE_DRIFT` was defined and never
applied) through as few as MIN_PAIRS=3 pairs, where both endpoints fit by construction, so 1993/2000 random
3-pair series came out STRUCTURAL. What replaced them:

    the fit          a BOUNDED Theil-Sen tempo ratio (`theil_sen`, shared with `claimmap` — ONE
                     implementation, and `claimmap`'s measured band is the shared one), adopted only where
                     it explains strictly more lines than scale 1.
    the classes      `INLIER_SHARE` of the lines inside `AGREE_TOLERANCE_SEC` of the FITTED model is "one
                     affine map describes this sheet" (AGREE / OFFSET / DRIFT); below that, STRUCTURAL needs a
                     minority that disagrees by more than a PHRASE and COARSE needs `COARSE_FLOOR` of them
                     within one. Both need `MIN_FITTED_PAIRS` pairs: at three, a fitted verdict is describing
                     its own noise — and below that floor the answer is `TOO_FEW_PAIRS`, not UNRELATED.
                     The inlier share is THE WHOLE TEST, deliberately: review M4 asked for ">= 90% inliers and
                     a small MAD" and the MAD half cannot ever bind, so it is not written here as though it
                     did (W2 review r1, proof under `spread_sec`).
    the disputes     `Reconciliation.disputed` — the lines a caller may re-decode — moved here from the call
                     site, one rule per class (see the property). The COARSE rule the caller had was
                     |raw residual - offset| > 1 s, which IGNORED the fitted scale and so flagged 38/50 lines
                     gross on a 2% tempo sheet (the review's repro s9; 0/50 now), and no class but STRUCTURAL
                     and COARSE disputed anything, so a stray line in an otherwise perfect sheet lost its
                     repair as soon as the sheet stopped being labelled STRUCTURAL.
    the residuals    `LineJudgement` carries both: `residual_sec` raw, for the trail (an operator wants the
                     sheet's actual displacement), and `model_residual_sec` against the fitted model, which
                     is the only one a caller may threshold.

WHAT THE SPREAD IS NOT. `spread_sec` is the JOINT precision of the two measurements, and nothing here can say
which side is the loose one. So it gates NOTHING — it is a reading on the trail, and both attempts to give it
teeth failed: as a REPAIR band ("wide spread, so do not repair") it cost Kinematic 3 of 14 lines within
+/-500 ms on the W2 probe, because a sheet whose residuals wander because OUR decode wandered still wants its
lines re-decoded against it; as a LABEL band beside the inlier share it could never fire at all (the proof is
under `spread_sec`, and W2 review r1 caught the docstrings still claiming it did).

NO CLAIM IS "CORRECTED" HERE. Reconcile never moves a timing: it grades ours and describes theirs. The
sheet-shifting that `activity.fit_sheet_to_audio` does for the windowed path has no role in v2's main line,
because generated timings never depended on the claims to begin with. A sheet is put on our clock ONCE, and
elsewhere — `claimmap.consensus`, before the first reconcile — so by the time a verdict is taken, an offset
it reports is what remains after that vote, not the sheet's raw lag.

PAIRED BY LINE INDEX, and only where both sides have one. `generate` drops unalignable lines but carries
`Line.index` (F1); a claim series may be shorter or longer than the text. Pairing by index — not order of
survivors, not content — is what keeps one dropped decorative line from shearing every comparison after it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import combinations
from statistics import median

#: |generated - claimed| below which a line CORROBORATES. Matches the benchmark's "a syllable at singing
#: tempo" band: the aligner's own jitter against truth is ~100 ms MAD, and a claim within 250 ms of an
#: independent measurement is agreement, not coincidence.
AGREE_TOLERANCE_SEC = 0.25

#: Fraction of paired lines that must agree (after removing any common offset/drift) for the claim to be
#: treated as structurally the same rendition. Below this, the disagreement is not "a few odd lines". Not
#: sufficient on its own since W2: STRUCTURAL also needs a line more than `COARSE_TOLERANCE_SEC` out, or the
#: sheet is merely loosely timed and its disagreements must not be repaired (review M4).
STRUCTURAL_FLOOR = 0.5

#: An offset smaller than this is not a finding — it is the two measurements' combined jitter.
OFFSET_NOISE_SEC = 0.35

#: The coarse band: when the sheet is not one affine map and not STRUCTURAL either, but at least COARSE_FLOOR
#: of its lines agree within COARSE_TOLERANCE_SEC of the fit, the claim describes THE SAME PERFORMANCE with
#: sloppy timing on one side. Measured need (Numb): a decent-but-noisy decode against jittery captions
#: read as UNRELATED, and the caller's re-anchoring repair then made the timings WORSE — the coarse
#: verdict exists so that case grades instead of repairs. The tolerance is also the phrase band every
#: corroborating class disputes a line by (`Reconciliation.disputed`): a line further out than this is
#: misbound whatever the sheet's label, and a line inside it is nothing a re-decode should chase.
COARSE_TOLERANCE_SEC = 1.0
COARSE_FLOOR = 0.7

#: Minimum paired lines for any verdict stronger than NO_CLAIMS. Mirrors `place.MIN_PAIRS` and for the same
#: reason: a fit through two points always fits.
MIN_PAIRS = 3

#: Minimum paired lines before STRUCTURAL or COARSE — the two verdicts that claim to have seen SHAPE in the
#: residuals (review M4: "require >= 5 pairs"). At three pairs a fitted line passes through all of them
#: often enough that 1993/2000 random 3-pair series came out STRUCTURAL, and the caller then re-decoded
#: lines inside claim windows on the strength of it. AGREE / OFFSET / DRIFT stay reachable at `MIN_PAIRS`:
#: they require near-total agreement, which random series do not supply. Same number as `claimmap.MIN_PAIRS`
#: for the same reason (a fit that ACTS needs more than a fit that only labels), kept separate because that
#: one gates MOVING the claims and this one gates a label.
MIN_FITTED_PAIRS = 5

#: Share of paired lines that must land within `AGREE_TOLERANCE_SEC` of the FITTED model for "one affine map
#: describes this sheet" — the AGREE / OFFSET / DRIFT band (review M4: ">= 90% inliers and a small MAD").
#: 0.9 leaves one line in ten for the stray stamp every hand-timed sheet carries; the strays still lose their
#: own corroboration, and the caller still re-decodes the ones `disputed` picks out.
INLIER_SHARE = 0.9

#: |scale - 1| beyond this and the tempo fit is DROPPED rather than clamped (dropping it leaves the median
#: offset, which is the same fit with scale 1). Two masters of one song differ by a few percent at most — the
#: review's band is 2-5%, and the bench's tempo modes are +/-2%, so 5% admits them without sitting on the
#: boundary. Tighter than `place.MAX_SCALE_DRIFT` (0.15) because that one only points a search, while this
#: one decides which lines the caller re-decodes and, through `claimmap`, which window it decodes them in.
MAX_SCALE_DRIFT = 0.05

#: Pairs closer together than this contribute no slope. Theil-Sen's slopes are differences over differences,
#: so jitter at the ends divides by the separation: +/-0.25 s on each end of a 20 s gap is already 2.5%, the
#: whole width of `MAX_SCALE_DRIFT`, and closer pairs are worse. The median over the surviving pairs is what
#: tames the rest.
MIN_SPAN_SEC = 20.0

AGREE = "agree"
OFFSET = "offset"
DRIFT = "drift"
STRUCTURAL = "structural"
COARSE = "coarse"
UNRELATED = "unrelated"
TOO_FEW_PAIRS = "too-few-pairs"
NO_CLAIMS = "no-claims"

#: The verdicts that say "these claims do not describe our timings": the caller grades on its own decode alone
#: under either (`align_steps`' `claims_disagree`), and only UNRELATED — the one with the pairs to mean it —
#: also arms R1. Named here so the two are not spelled out as a literal pair at a call site that will one day
#: gain a third.
DISAGREE = (UNRELATED, TOO_FEW_PAIRS)


def theil_sen(pairs: Sequence[tuple[float, float]]) -> float | None:
    """The tempo ratio ours/claimed as the median of pairwise slopes, or None when it is unmeasurable or out
    of band (`MAX_SCALE_DRIFT`, `MIN_SPAN_SEC`). `pairs` is `(claimed, ours)`, in any order.

    THE ONE implementation of this fit: `reconcile` classifies DRIFT with it and `claimmap` builds its tempo
    candidate with it (review M4's "share the estimator"). It lives here because `claimmap` already imports
    this module's corroboration band, so the dependency has to run this way to stay acyclic.

    Hand-rolled, O(n^2) over the paired lines: `domain/` must import with no scipy (it is in the `ml` extra),
    and 100 lines is 5k slopes — microseconds. Pairwise slopes (Sen 1968) rather than a least-squares fit for
    the reason `place._scale_of` gives for its span ratio, except that this one does not depend on the two END
    lines being the sound ones: a median over all wide-enough pairs survives an outlier anywhere. The gap test
    is on |difference|, so an unsorted series is fitted identically to a sorted one.
    """
    slopes = [
        (ours_b - ours_a) / (theirs_b - theirs_a)
        for (theirs_a, ours_a), (theirs_b, ours_b) in combinations(pairs, 2)
        if abs(theirs_b - theirs_a) >= MIN_SPAN_SEC
    ]
    if not slopes:
        return None
    scale = float(median(slopes))
    return None if abs(scale - 1.0) > MAX_SCALE_DRIFT else scale


@dataclass(frozen=True, slots=True)
class LineJudgement:
    """One line's corroboration state, consumed by stage 4's grading."""

    index: int
    #: True when the claim lands within tolerance of our timing AFTER the fitted offset/scale is removed —
    #: so a sheet that is uniformly late still corroborates line-for-line.
    corroborated: bool
    #: generated minus claimed, in seconds, raw (offset NOT removed): the trail-facing number.
    residual_sec: float
    #: generated minus the claim ON THE FITTED MODEL (claimed x scale + offset). THE one a caller may
    #: threshold (review M4): the raw residual carries the whole sheet's offset and drift, so subtracting a
    #: constant from it leaves a 2% tempo sheet's linear ramp intact and 38 of 50 lines read "gross".
    model_residual_sec: float = 0.0


@dataclass(frozen=True, slots=True)
class Reconciliation:
    """The verdict on a claim series, with the evidence stage 4 and the trail need."""

    verdict: str
    #: Per paired line, in `Line.index` order. Empty for NO_CLAIMS and UNRELATED.
    lines: tuple[LineJudgement, ...] = ()
    #: The constant part of the disagreement (claimed + offset ≈ generated). A fact about the claim.
    offset_sec: float = 0.0
    #: The fitted tempo ratio (`theil_sen`): 1.0 unless a bounded slope explained strictly more lines than
    #: scale 1. Usually 1.0 outside DRIFT, but a fit small enough to be a better model and too small to be a
    #: FINDING is kept here and labelled OFFSET / AGREE — the model a caller thresholds against is this one.
    scale: float = 1.0
    #: Fraction of paired lines corroborating, after offset/scale removal.
    agreement: float = 0.0
    pairs: int = 0
    #: MAD of the lines' residuals about the fitted model: the JOINT precision of the two measurements. Small
    #: means one offset (or one tempo) describes the pair; large means one of the two is loosely timed — and
    #: which one is not knowable from here, which is why it gates NOTHING and only reaches the trail.
    #:
    #: IT CANNOT GATE THE LABEL EITHER, which is why the AGREE / OFFSET / DRIFT test is the inlier share alone
    #: (W2 review r1; review M4's ">= 90% inliers AND a small MAD" was written as a conjunction here until the
    #: second half was proved dead). `offset_used` is `median(ours - scale x claimed)` and the residuals are
    #: taken against it, so the median residual is 0 BY CONSTRUCTION and this MAD is exactly
    #: `median(|residual|)`. Once `INLIER_SHARE` (0.9) of the residuals are inside `AGREE_TOLERANCE_SEC`
    #: (0.25), their median absolute value is at most 0.25 — under any band worth writing, and under the 0.4
    #: the conjunct used to carry. Measured: 200 000 seeded series produced 0 in which the band could have
    #: refused a branch the share admitted, and mutating that 0.4 to 4.0 left the whole suite green. The
    #: implication is pinned as a property test (`test_reconcile`) so that a future tolerance or share that
    #: broke it would have to say so out loud.
    spread_sec: float = 0.0
    why: str = ""

    @property
    def corroborates(self) -> bool:
        """May stage 4 treat agreement as evidence? UNRELATED, TOO_FEW_PAIRS and NO_CLAIMS confer nothing."""
        return self.verdict in (AGREE, OFFSET, DRIFT, STRUCTURAL, COARSE) and self.pairs >= MIN_PAIRS

    @property
    def disputed(self) -> tuple[int, ...]:
        """The lines whose timing this sheet contradicts, in `Line.index` order: the caller's repair
        candidates (`align_steps` R2), and nothing else it may re-decode on a verdict's word.

        ONE RULE PER CLASS, because what a disagreement MEANS differs by class (review M4; the caller used to
        spell this out at the call site and got the COARSE half wrong):

            STRUCTURAL        every line the fit does not explain. The sheet as a whole is tight — a majority
                              inside the corroboration band, a minority seconds out — so a 300 ms
                              disagreement is real disagreement, and on repeated text the claim is the only
                              occurrence-anchor there is (F2).
            AGREE / OFFSET /  only the lines beyond the PHRASE band on the fitted model. A sheet one affine
            DRIFT / COARSE    map explains, or a loosely-timed one, disputes nothing at sub-second scale:
                              re-decoding jitter inside a jittered claim window measured WORSE (Numb, MAD
                              312 -> 563 ms). A line seconds out is misbound whatever the sheet's label
                              (Avercage's 6), and the residual is taken against the MODEL, so a tempo sheet's
                              linear ramp is not mistaken for 38 misbound lines (the review's s9).
            UNRELATED /       nothing. None of them confers standing. On UNRELATED the caller arbitrates with
            TOO_FEW_PAIRS /   the activity envelope instead (R1) rather than repairing line by line; on the
            NO_CLAIMS         other two it does not even do that, since there are too few pairs to have
                              measured a disagreement worth acting on.
        """
        if self.verdict == STRUCTURAL:
            return tuple(line.index for line in self.lines if not line.corroborated)
        if self.verdict in (AGREE, OFFSET, DRIFT, COARSE):
            return tuple(
                line.index for line in self.lines if abs(line.model_residual_sec) > COARSE_TOLERANCE_SEC
            )
        return ()

    def agrees(self, ours: float, claimed: float) -> bool:
        """Would a line at `ours` corroborate its claim at `claimed` on THIS verdict's fitted clock?

        The same test `reconcile` applied to every line it judged (claimed x scale + offset within
        AGREE_TOLERANCE_SEC), so it reproduces each `LineJudgement.corroborated` exactly. It exists for a
        line whose timing CHANGED after the verdict was taken: grading asks whether a repaired line still
        sits where the blind decode and the claim agreed it is sung (review H4), and a verdict that
        confers nothing (`corroborates` false) vouches for no position at all.
        """
        expected = claimed * self.scale + self.offset_sec
        return self.corroborates and abs(ours - expected) <= AGREE_TOLERANCE_SEC


def reconcile(
    generated: Sequence[Mapping[str, object] | object],
    claimed_starts: Mapping[int, float],
) -> Reconciliation:
    """Compare generated lines against claimed line starts, keyed by ORIGINAL line index.

    `generated` is `generate.Generated.lines` (duck-typed: `.index`, `.start`). `claimed_starts` maps the
    input text's line index to the claimed onset — a mapping rather than a list so the caller states
    explicitly which lines the claim covers, instead of this module guessing at an offset-by-one.
    """
    pairs: list[tuple[int, float, float]] = []  # (index, ours, theirs)
    for line in generated:
        index = int(getattr(line, "index", -1))
        claimed = claimed_starts.get(index)
        if claimed is None:
            continue
        pairs.append((index, float(getattr(line, "start", 0.0)), float(claimed)))

    if len(pairs) < MIN_PAIRS:
        return Reconciliation(
            verdict=NO_CLAIMS,
            pairs=len(pairs),
            why=f"{len(pairs)} paired line(s); {MIN_PAIRS} needed for any verdict",
        )

    ours: list[float] = [o for _i, o, _t in pairs]
    theirs: list[float] = [t for _i, _o, t in pairs]

    def offset_for(scale_used: float) -> float:
        """median(ours - scale x claimed): the constant part that goes with a scale. The MEDIAN for `place`'s
        reason — an LRC commonly carries one or two wildly wrong lines and a mean follows them."""
        return float(median(o - scale_used * t for o, t in zip(ours, theirs, strict=True)))

    def residuals_for(scale_used: float) -> list[float]:
        offset_used = offset_for(scale_used)
        return [o - (t * scale_used + offset_used) for o, t in zip(ours, theirs, strict=True)]

    def within(residuals: Sequence[float], tolerance: float) -> int:
        return sum(1 for r in residuals if abs(r) <= tolerance)

    # ── the fit: a constant part always, a BOUNDED tempo ratio only where it earns its place ──
    # Judged with the constant offset alone first; the scale is adopted only if it explains strictly more
    # lines. Adopting one by default would let two unrelated series look related whenever their spans
    # happen to differ — which is exactly what the unbounded endpoint span ratio did before W2 (review M4).
    flat = residuals_for(1.0)
    fitted = theil_sen([(t, o) for o, t in zip(ours, theirs, strict=True)])
    scaled = residuals_for(fitted) if fitted is not None else flat
    use_scale = fitted is not None and within(scaled, AGREE_TOLERANCE_SEC) > within(flat, AGREE_TOLERANCE_SEC)
    scale_used = fitted if use_scale and fitted is not None else 1.0
    offset_used = offset_for(scale_used)
    model = scaled if use_scale else flat

    # ── the residual DISTRIBUTION: how many lines the model explains within the corroboration band, how many
    # within a phrase, and how tight the residuals are about the fit (see `Reconciliation.disputed`).
    agreement = within(model, AGREE_TOLERANCE_SEC) / len(model)
    near = within(model, COARSE_TOLERANCE_SEC) / len(model)
    centre = median(model)
    spread = float(median(abs(r - centre) for r in model))
    gross = len(model) - within(model, COARSE_TOLERANCE_SEC)

    judged = tuple(
        LineJudgement(
            index=index,
            corroborated=abs(residual) <= AGREE_TOLERANCE_SEC,
            residual_sec=o - t,
            model_residual_sec=residual,
        )
        for (index, o, t), residual in zip(pairs, model, strict=True)
    )
    shape = f"offset {offset_used:+.2f}s scale {scale_used:.4f}, spread {spread:.2f}s"

    def graded(verdict: str, why: str) -> Reconciliation:
        return Reconciliation(
            verdict=verdict,
            lines=judged,
            offset_sec=offset_used,
            scale=scale_used,
            agreement=agreement,
            pairs=len(pairs),
            spread_sec=spread,
            why=why,
        )

    # ── ONE affine map explains the sheet: the strays lose their own corroboration, the sheet keeps its
    # standing, and which of the three labels it gets is a description of the CLAIM, not of our timings.
    if agreement >= INLIER_SHARE:
        # A tempo that moves the far end of the sheet by less than the corroboration band is a better fit,
        # not a finding: on jittered claims `theil_sen` lands within 0.2% of 1.0 often enough to explain one
        # extra line (measured: 420 of 2000 seeded +1.5 s series, |scale-1| at most 0.0018, which moves the
        # last claim 0.29 s), and reporting those as DRIFT would put a tempo story on the trail of a sheet
        # that is simply late. The fitted model is kept either way.
        if use_scale and abs(scale_used - 1.0) * (max(theirs) - min(theirs)) > AGREE_TOLERANCE_SEC:
            return graded(
                DRIFT,
                f"claims drift at scale {scale_used:.4f} with offset {offset_used:+.2f}s; "
                f"{agreement:.0%} of {len(pairs)} lines agree once fitted (spread {spread:.2f}s)",
            )
        if abs(offset_used) > OFFSET_NOISE_SEC:
            return graded(
                OFFSET,
                f"claims are uniformly {abs(offset_used):.2f}s "
                f"{'early' if offset_used > 0 else 'late'}; coherent ({agreement:.0%} of {len(pairs)} "
                f"lines agree once fitted, spread {spread:.2f}s)",
            )
        return graded(
            AGREE,
            f"{agreement:.0%} of {len(pairs)} paired lines agree within {AGREE_TOLERANCE_SEC}s "
            f"(offset {offset_used:+.2f}s is noise, spread {spread:.2f}s)",
        )

    # ── shape, not one map. Both remaining classes are claims about STRUCTURE in the residuals, so both
    # need enough pairs to have seen any (`MIN_FITTED_PAIRS`; review M4).
    if len(pairs) >= MIN_FITTED_PAIRS:
        # STRUCTURAL needs a minority that disagrees GROSSLY — a line beyond a phrase of the fit. Without
        # that test a merely JITTERY sheet (most lines inside the band, the rest a few hundred ms out) took
        # this branch, and the caller re-decoded every one of those inside its claim window: the repair Numb
        # measured as making timings worse. Measured over 2000 seeded +1.5 s / 150 ms-jitter sheets, the
        # branch now takes 0 of them; before W2's taxonomy it took about 98%.
        if agreement >= STRUCTURAL_FLOOR and gross:
            return graded(
                STRUCTURAL,
                f"{within(model, AGREE_TOLERANCE_SEC)}/{len(pairs)} lines corroborate ({shape}) and "
                f"{gross} sit more than {COARSE_TOLERANCE_SEC}s from the fit; the disputed lines are where "
                "the decode and the claim tell different stories — on repeated text, trust the claim's "
                "occurrence",
            )
        if near >= COARSE_FLOOR:
            # Do the series agree at PHRASE scale? Same performance, sloppy timing on one side — grade it,
            # never repair it (a repair against jitter is regression fuel), bar any line `disputed` picks.
            return graded(
                COARSE,
                f"only {agreement:.0%} of {len(pairs)} lines agree within {AGREE_TOLERANCE_SEC}s, but "
                f"{near:.0%} agree within {COARSE_TOLERANCE_SEC}s ({shape}): same performance, loosely "
                f"timed — grade, not repair, bar {gross} line(s) more than "
                f"{COARSE_TOLERANCE_SEC}s out",
            )

    # TOO FEW PAIRS TO SAY ANYTHING (review M4's floor, given its own verdict in W2 — review r1). Three or
    # four pairs that disagree look exactly like a different song and exactly like our own decode having
    # misbound one line, and UNRELATED is NOT the neutral way to say so: it arms the caller's R1, which
    # re-decodes every claimed line inside its claim window and may adopt the claim span over a good blind
    # timing. That is the sweeping action, taken on the evidence the floor exists to distrust — so this
    # abstains instead, and the caller's envelope arbitration stays for the sheets with pairs behind them.
    if len(pairs) < MIN_FITTED_PAIRS:
        return Reconciliation(
            verdict=TOO_FEW_PAIRS,
            pairs=len(pairs),
            agreement=agreement,
            spread_sec=spread,
            why=(
                f"only {agreement:.0%} of {len(pairs)} lines agree even after fitting {shape}, and "
                f"{MIN_FITTED_PAIRS} pairs are needed to tell a variant section from a different song: this "
                "sheet is neither corroborated nor contradicted, and nothing is repaired on its word"
            ),
        )

    # Not enough lines agree under ANY offset/scale. WHICH side is wrong is not knowable here: the caller
    # arbitrates with the activity envelope.
    return Reconciliation(
        verdict=UNRELATED,
        pairs=len(pairs),
        agreement=agreement,
        spread_sec=spread,
        why=(
            f"only {agreement:.0%} of {len(pairs)} lines agree even after fitting {shape}"
            "; the claim does not describe these timings — arbitrate with the activity envelope before "
            "believing either side"
        ),
    )


@dataclass(frozen=True, slots=True)
class AsClaimed:
    """How a claim series sits against our decode AS CLAIMED: no offset or scale removed (`as_claimed`)."""

    #: The share of paired lines whose claimed start is within `tolerance_sec` of the decode's.
    near: float
    pairs: int
    tolerance_sec: float
    #: median(ours − claimed): the lag the decode reads in the claims, for the trail (it is NOT removed).
    offset_sec: float

    def why(self) -> str:
        return (
            f"the text's own blind decode starts {self.near:.0%} of {self.pairs} lines within "
            f"{self.tolerance_sec:.1f} s of their claims (median lag {self.offset_sec:+.2f} s)"
        )


def as_claimed(
    generated: Sequence[Mapping[str, object] | object],
    claimed_starts: Mapping[int, float],
    *,
    tolerance_sec: float = COARSE_TOLERANCE_SEC,
) -> AsClaimed | None:
    """Do the claimed starts THEMSELVES sit where our decode puts each line? None under `MIN_PAIRS` pairs.

    `reconcile` removes the claims' common offset (and a tempo scale) before judging a line, because there
    OUR timings are what publishes and a sheet for another master still vouches for them. Where the CLAIMS
    publish — the LINE_SYNC rung's line document, the text's own timings — an offset is exactly the error
    the room would see, so nothing is removed here: a sheet 1.5 s late reads as 1.5 s late. Paired by line
    index, as `reconcile` pairs (`Line.index`; duck-typed `.index`, `.start`).
    """
    pairs: list[tuple[float, float]] = []
    for line in generated:
        claimed = claimed_starts.get(int(getattr(line, "index", -1)))
        if claimed is not None:
            pairs.append((float(getattr(line, "start", 0.0)), float(claimed)))
    if len(pairs) < MIN_PAIRS:
        return None
    residuals = [ours - theirs for ours, theirs in pairs]
    return AsClaimed(
        near=sum(abs(r) <= tolerance_sec for r in residuals) / len(residuals),
        pairs=len(pairs),
        tolerance_sec=tolerance_sec,
        offset_sec=float(median(residuals)),
    )
