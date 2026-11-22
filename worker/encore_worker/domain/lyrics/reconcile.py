"""Reconciling CLAIMED timings against the timings we generated ourselves.

THE ROLE REVERSAL: the claims are EVIDENCE rather than a search space, so they either corroborate ours or
diagnose which known failure shape this sheet has. NO CLAIM IS "CORRECTED" HERE (XA-04). The classes, their
residual patterns, which lines each lets a repair touch and why `Reconciliation.spread_sec` gates nothing:
`docs/arch/04-alignment.md` §7; LOG.md, "Reconcile robustness: the fit, the classes, and which lines a repair
may touch".

`AsClaimed.spread_sec` is the OTHER spread and it DOES gate: with `together` it separates one coherent
displacement from lopsided scatter in `off_sheet`, which demotes a whole document
(`docs/arch/04-alignment.md` §6.1).
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

#: Fraction of paired lines that must agree, after any common offset or drift, for the claim to be the same
#: rendition. Not sufficient alone: STRUCTURAL also needs a line grossly out, or a merely loosely timed sheet
#: would be repaired (docs/arch/04-alignment.md §7).
STRUCTURAL_FLOOR = 0.5

#: An offset smaller than this is not a finding — it is the two measurements' combined jitter.
OFFSET_NOISE_SEC = 0.35

#: The coarse band: neither one affine map nor STRUCTURAL, but enough lines agree loosely that the claim
#: describes THE SAME PERFORMANCE sloppily timed — so that case grades instead of repairs. The tolerance is
#: also the PHRASE band every corroborating class disputes a line by (docs/arch/04-alignment.md §7).
COARSE_TOLERANCE_SEC = 1.0
COARSE_FLOOR = 0.7

#: Minimum paired lines for any verdict stronger than NO_CLAIMS. Mirrors `place.MIN_PAIRS` and for the same
#: reason: a fit through two points always fits.
MIN_PAIRS = 3

#: Minimum paired lines before STRUCTURAL or COARSE, the two verdicts claiming to have seen SHAPE: at three
#: pairs 1993 of 2000 random series came out STRUCTURAL. AGREE / OFFSET / DRIFT stay reachable lower, needing
#: near-total agreement. Kept separate from `claimmap.MIN_PAIRS`, which gates MOVING the claims.
MIN_FITTED_PAIRS = 5

#: Share of paired lines that must land within `AGREE_TOLERANCE_SEC` of the FITTED model for "one affine map
#: describes this sheet", leaving one line in ten for the stray stamp every hand-timed sheet carries.
INLIER_SHARE = 0.9

#: Share of paired lines that must sit within `AGREE_TOLERANCE_SEC` of the MEDIAN LAG before `off_sheet` may
#: call that lag ONE displacement rather than lopsided scatter a MAD cannot see. Measured on the corpus's own
#: coherent readings: LOG.md, "W8a: the share a coherent lag has to carry".
MIN_COHERENT_SHARE = 0.7

#: |scale - 1| beyond this and the tempo fit is DROPPED rather than clamped, which leaves the median offset.
#: Two masters of one song differ by a few percent at most. Tighter than `place.MAX_SCALE_DRIFT`, which only
#: points a search where this decides which lines are re-decoded and in which window.
MAX_SCALE_DRIFT = 0.05

#: Seconds apart a pair must be to contribute a slope: Theil-Sen divides jitter by the separation, so a
#: quarter-second at each end of a 20 s gap is already the whole width of `MAX_SCALE_DRIFT`.
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
#: under either, and only UNRELATED — the one with the pairs to mean it — also arms R1.
DISAGREE = (UNRELATED, TOO_FEW_PAIRS)


def theil_sen(pairs: Sequence[tuple[float, float]]) -> float | None:
    """The tempo ratio ours/claimed as the median of pairwise slopes, or None when unmeasurable or out of
    band. `pairs` is `(claimed, ours)`, in any order.

    THE ONE implementation of this fit, shared by `reconcile`'s DRIFT class and `claimmap`'s tempo candidate,
    and here because the dependency has to run this way to stay acyclic. Hand-rolled and O(n^2), `domain/`
    importing with no scipy; pairwise slopes survive an outlier anywhere, unlike a span ratio.
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
    #: MAD of the lines' residuals about the fitted model: the JOINT precision of the two measurements, which
    #: gates NOTHING — which one is loose is not knowable here, and the inlier share implies the label
    #: (docs/arch/04-alignment.md §7).
    spread_sec: float = 0.0
    why: str = ""

    @property
    def corroborates(self) -> bool:
        """May stage 4 treat agreement as evidence? UNRELATED, TOO_FEW_PAIRS and NO_CLAIMS confer nothing."""
        return self.verdict in (AGREE, OFFSET, DRIFT, STRUCTURAL, COARSE) and self.pairs >= MIN_PAIRS

    @property
    def disputed(self) -> tuple[int, ...]:
        """The lines whose timing this sheet contradicts, in `Line.index` order: the caller's R2 candidates,
        and nothing else it may re-decode on a verdict's word.

        ONE RULE PER CLASS, here rather than at the call site, because what a disagreement MEANS differs by
        class (docs/arch/04-alignment.md §7).
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

        The same test `reconcile` applied to every line it judged, for a line whose timing CHANGED after the
        verdict was taken; a verdict that confers nothing vouches for no position at all (XA-03).
        """
        expected = claimed * self.scale + self.offset_sec
        return self.corroborates and abs(ours - expected) <= AGREE_TOLERANCE_SEC


def reconcile(
    generated: Sequence[Mapping[str, object] | object],
    claimed_starts: Mapping[int, float],
) -> Reconciliation:
    """Compare generated lines against claimed line starts, keyed by ORIGINAL line index.

    `claimed_starts` is a mapping rather than a list, so the caller states which lines the claim covers
    instead of this module guessing at an offset-by-one.
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
    # The scale is adopted only if it explains strictly more lines: by default it would let two unrelated
    # series look related whenever their spans happen to differ.
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
        # A tempo that moves the far end of the sheet by less than the corroboration band is a better fit and
        # not a finding — 420 of 2000 seeded late sheets explain one extra line that way — so reporting them
        # as DRIFT would put a tempo story on a sheet that is simply late. The fitted model is kept.
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
        # STRUCTURAL needs a minority that disagrees GROSSLY, a line beyond a phrase of the fit: without it a
        # merely JITTERY sheet took this branch and had every out-of-band line re-decoded, which measured as
        # making timings worse. It now takes 0 of 2000 seeded jittery sheets, against about 98% before.
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

    # TOO FEW PAIRS TO SAY ANYTHING, with a verdict of its own: three or four pairs that disagree look
    # exactly like a different song and exactly like one misbound line, and UNRELATED is not the neutral way
    # to say so — it arms R1, the sweeping repair, on the evidence this floor exists to distrust.
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
    #: MAD of the residuals about `offset_sec`: one shift when small, lopsided scatter when not. UNDEFAULTED,
    #: with `together`: a constructor that forgot either would hand `off_sheet` perfect coherence.
    spread_sec: float
    #: Share of residuals within `tolerance_sec` of `offset_sec`: the conjunct a MAD cannot supply, reading
    #: 0.00 as it does on a half-and-half population (`MIN_COHERENT_SHARE`).
    together: float

    def why(self) -> str:
        return (
            f"the text's own blind decode starts {self.near:.0%} of {self.pairs} lines within "
            f"{self.tolerance_sec:.1f} s of their claims (median lag {self.offset_sec:+.2f} s, spread "
            f"{self.spread_sec:.2f} s)"
        )


def as_claimed(
    generated: Sequence[Mapping[str, object] | object],
    claimed_starts: Mapping[int, float],
    *,
    tolerance_sec: float = COARSE_TOLERANCE_SEC,
) -> AsClaimed | None:
    """Do the claimed starts THEMSELVES sit where our decode puts each line? None under `MIN_PAIRS` pairs.

    `reconcile` removes the claims' common offset before judging a line, because there OUR timings publish.
    Where the CLAIMS publish an offset is exactly the error the room would see, so nothing is removed here
    (docs/arch/04-alignment.md §5.3).
    """
    pairs: list[tuple[float, float]] = []
    for line in generated:
        claimed = claimed_starts.get(int(getattr(line, "index", -1)))
        if claimed is not None:
            pairs.append((float(getattr(line, "start", 0.0)), float(claimed)))
    if len(pairs) < MIN_PAIRS:
        return None
    residuals = [ours - theirs for ours, theirs in pairs]
    offset = float(median(residuals))
    return AsClaimed(
        near=sum(abs(r) <= tolerance_sec for r in residuals) / len(residuals),
        pairs=len(pairs),
        tolerance_sec=tolerance_sec,
        offset_sec=offset,
        spread_sec=float(median(abs(r - offset) for r in residuals)),
        together=sum(abs(r - offset) <= tolerance_sec for r in residuals) / len(residuals),
    )


@dataclass(frozen=True, slots=True)
class OffSheet:
    """One lag BOTH of a published document's own witnesses confirm: it is off its sheet, and it is us."""

    #: median(published − claimed): how far the room sees every line move, in the room's own direction.
    lag_sec: float
    #: MAD of those residuals. Small by construction — `off_sheet` refuses an incoherent reading.
    spread_sec: float
    #: Share of them within `AGREE_TOLERANCE_SEC` of `lag_sec`, at or above `MIN_COHERENT_SHARE`.
    together: float
    pairs: int
    #: The envelope's reading of the SERVED claim windows against the audio. Near zero: the singing is where
    #: the sheet says, so the sheet is not what moved.
    envelope_lag_sec: float
    #: Do the CLAIMS add a witness of their own? False when this whole lag is the claim clock's own map, which
    #: makes the first reading a restatement of a decision this pipeline made and the envelope the only
    #: independent witness left. Measured per mode: LOG.md, "W8a: when the claims restate the clock".
    claims_independent: bool = True

    def why(self) -> str:
        witnesses = (
            "both witnesses place this document away from where it published"
            if self.claims_independent
            else "this lag IS the claim clock's own map, so the claims add no second witness and the "
            "envelope alone convicts"
        )
        return (
            f"OFF ITS SHEET by {self.lag_sec:+.2f} s coherently ({self.together:.0%} of {self.pairs} paired "
            f"lines within {AGREE_TOLERANCE_SEC:.2f} s of it, spread {self.spread_sec:.2f} s) while the "
            f"audio puts the singing {self.envelope_lag_sec:+.2f} s from those same claims: {witnesses}"
        )


def off_sheet(
    reading: AsClaimed | None, *, envelope_lag_sec: float | None, clock_lag_sec: float = 0.0
) -> OffSheet | None:
    """Is the PUBLISHED document coherently off the claims it was GIVEN, with the audio siding against it?

    BOTH witnesses must say so: the claims that every line moved together — a small MAD AND a lag
    `MIN_COHERENT_SHARE` of the lines carry — and the envelope that the singing is where those claims put it.
    `None` abstains and never demotes. `clock_lag_sec` is what the claim clock already applied to this sheet;
    a lag that IS that map restates it instead of witnessing. docs/arch/04-alignment.md §6.1.
    """
    if reading is None or envelope_lag_sec is None:
        return None
    if abs(reading.offset_sec) <= AGREE_TOLERANCE_SEC or reading.spread_sec > AGREE_TOLERANCE_SEC:
        return None
    if reading.together < MIN_COHERENT_SHARE:
        return None
    if abs(envelope_lag_sec) > AGREE_TOLERANCE_SEC:
        return None
    return OffSheet(
        lag_sec=reading.offset_sec,
        spread_sec=reading.spread_sec,
        together=reading.together,
        pairs=reading.pairs,
        envelope_lag_sec=envelope_lag_sec,
        claims_independent=abs(reading.offset_sec - clock_lag_sec) > AGREE_TOLERANCE_SEC,
    )
