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
    UNRELATED    no structure at all. Either the claim is for a different song or our decode is garbage;
                 this module cannot tell WHICH, so it says so and the caller arbitrates with the activity
                 envelope (`domain/audio/activity.py`) — the one gate measured to separate right from
                 wrong text (path scores cannot; measured, F5 in the plan).

NO CLAIM IS "CORRECTED" HERE. Reconcile never moves a timing: it grades ours and describes theirs. The
sheet-shifting that `activity.fit_sheet_to_audio` does for the windowed path has no role in v2's main line,
because generated timings never depended on the claims to begin with.

PAIRED BY LINE INDEX, and only where both sides have one. `generate` drops unalignable lines but carries
`Line.index` (F1); a claim series may be shorter or longer than the text. Pairing by index — not order of
survivors, not content — is what keeps one dropped decorative line from shearing every comparison after it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median

#: |generated - claimed| below which a line CORROBORATES. Matches the benchmark's "a syllable at singing
#: tempo" band: the aligner's own jitter against truth is ~100 ms MAD, and a claim within 250 ms of an
#: independent measurement is agreement, not coincidence.
AGREE_TOLERANCE_SEC = 0.25

#: Fraction of paired lines that must agree (after removing any common offset/drift) for the claim to be
#: treated as structurally the same rendition. Below this, the disagreement is not "a few odd lines".
STRUCTURAL_FLOOR = 0.5

#: An offset smaller than this is not a finding — it is the two measurements' combined jitter.
OFFSET_NOISE_SEC = 0.35

#: Residual spread (MAD about the median) below which "one constant offset" is an adequate description.
#: Above it, the residuals have shape — drift or structure — and calling them an offset would mislead.
OFFSET_COHERENCE_SEC = 0.4

#: The coarse band: when under STRUCTURAL_FLOOR of lines agree finely, but at least COARSE_FLOOR agree
#: within COARSE_TOLERANCE_SEC (offset/scale removed), the claim describes THE SAME PERFORMANCE with
#: sloppy timing on one side. Measured need (Numb): a decent-but-noisy decode against jittery captions
#: read as UNRELATED, and the caller's re-anchoring repair then made the timings WORSE — the coarse
#: verdict exists so that case grades instead of repairs.
COARSE_TOLERANCE_SEC = 1.0
COARSE_FLOOR = 0.7

#: Minimum paired lines for any verdict stronger than NO_CLAIMS. Mirrors `place.MIN_PAIRS` and for the same
#: reason: a fit through two points always fits.
MIN_PAIRS = 3

AGREE = "agree"
OFFSET = "offset"
DRIFT = "drift"
STRUCTURAL = "structural"
COARSE = "coarse"
UNRELATED = "unrelated"
NO_CLAIMS = "no-claims"


@dataclass(frozen=True, slots=True)
class LineJudgement:
    """One line's corroboration state, consumed by stage 4's grading."""

    index: int
    #: True when the claim lands within tolerance of our timing AFTER the fitted offset/scale is removed —
    #: so a sheet that is uniformly late still corroborates line-for-line.
    corroborated: bool
    #: generated minus claimed, in seconds, raw (offset NOT removed): the trail-facing number.
    residual_sec: float


@dataclass(frozen=True, slots=True)
class Reconciliation:
    """The verdict on a claim series, with the evidence stage 4 and the trail need."""

    verdict: str
    #: Per paired line, in `Line.index` order. Empty for NO_CLAIMS and UNRELATED.
    lines: tuple[LineJudgement, ...] = ()
    #: The constant part of the disagreement (claimed + offset ≈ generated). A fact about the claim.
    offset_sec: float = 0.0
    #: The tempo ratio, 1.0 unless DRIFT.
    scale: float = 1.0
    #: Fraction of paired lines corroborating, after offset/scale removal.
    agreement: float = 0.0
    pairs: int = 0
    why: str = ""

    @property
    def corroborates(self) -> bool:
        """May stage 4 treat agreement as evidence? UNRELATED and NO_CLAIMS confer nothing."""
        return self.verdict in (AGREE, OFFSET, DRIFT, STRUCTURAL, COARSE) and self.pairs >= MIN_PAIRS


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

    # ── the constant part: median residual, robust to a few wild lines ──
    residuals = [o - t for o, t in zip(ours, theirs, strict=True)]
    offset = median(residuals)

    # ── the linear part: span ratio, same estimator as place._scale_of and for the same reason ──
    ours_span = ours[-1] - ours[0]
    theirs_span = theirs[-1] - theirs[0]
    scale = (ours_span / theirs_span) if (ours_span > 0 and theirs_span > 0) else 1.0

    # Judge agreement with the CONSTANT offset removed but scale untouched first; only adopt the scale if
    # it genuinely explains more lines. Adopting a scale by default would let two unrelated series look
    # related whenever their spans happen to differ.
    def agreement_with(
        offset_used: float, scale_used: float, tolerance: float = AGREE_TOLERANCE_SEC
    ) -> list[bool]:
        return [
            abs(o - (t * scale_used + offset_for(scale_used, offset_used))) <= tolerance
            for o, t in zip(ours, theirs, strict=True)
        ]

    def offset_for(scale_used: float, fallback: float) -> float:
        if scale_used == 1.0:
            return fallback
        return float(median(o - t * scale_used for o, t in zip(ours, theirs, strict=True)))

    flat = agreement_with(offset, 1.0)
    scaled = agreement_with(offset, scale) if abs(scale - 1.0) > 1e-9 else flat
    use_scale = sum(scaled) > sum(flat)
    matched = scaled if use_scale else flat
    scale_used = scale if use_scale else 1.0
    offset_used = offset_for(scale_used, offset)
    agreement = sum(matched) / len(matched)

    judged = tuple(
        LineJudgement(index=index, corroborated=ok, residual_sec=o - t)
        for (index, o, t), ok in zip(pairs, matched, strict=True)
    )

    if agreement < STRUCTURAL_FLOOR:
        # Before calling it unrelated: do the series agree at PHRASE scale? Same performance, sloppy
        # timing on one side — grade it, never repair it (a repair against jitter is regression fuel).
        coarse = agreement_with(offset_used, scale_used, COARSE_TOLERANCE_SEC)
        if sum(coarse) / len(coarse) >= COARSE_FLOOR:
            return Reconciliation(
                verdict=COARSE,
                lines=judged,
                offset_sec=offset_used,
                scale=scale_used,
                agreement=agreement,
                pairs=len(pairs),
                why=(
                    f"only {agreement:.0%} of {len(pairs)} lines agree within {AGREE_TOLERANCE_SEC}s, but "
                    f"{sum(coarse) / len(coarse):.0%} agree within {COARSE_TOLERANCE_SEC}s "
                    f"(offset {offset_used:+.2f}s): same performance, loosely timed — grade, not repair"
                ),
            )
        # Not enough lines agree under ANY offset/scale: this claim does not describe these timings. WHICH
        # side is wrong is not knowable here — the caller arbitrates with the activity envelope.
        return Reconciliation(
            verdict=UNRELATED,
            pairs=len(pairs),
            agreement=agreement,
            why=(
                f"only {agreement:.0%} of {len(pairs)} lines agree even after fitting "
                f"offset {offset_used:+.2f}s scale {scale_used:.3f}; the claim does not describe "
                "these timings — arbitrate with the activity envelope before believing either side"
            ),
        )

    spread = median(abs(r - offset) for r in residuals)
    if agreement < 1.0 - 1e-9:
        verdict = STRUCTURAL
        why = (
            f"{sum(matched)}/{len(matched)} lines corroborate (offset {offset_used:+.2f}s, "
            f"scale {scale_used:.3f}); the disagreeing lines are where the decode and the claim "
            "tell different stories — on repeated text, trust the claim's occurrence"
        )
    elif use_scale:
        verdict = DRIFT
        why = (
            f"claims drift at scale {scale_used:.3f} with offset {offset_used:+.2f}s; "
            "all lines agree once fitted"
        )
    elif abs(offset_used) > OFFSET_NOISE_SEC and spread <= OFFSET_COHERENCE_SEC:
        verdict = OFFSET
        why = (
            f"claims are uniformly {abs(offset_used):.2f}s {'early' if offset_used > 0 else 'late'}; "
            f"coherent (spread {spread:.2f}s)"
        )
    else:
        verdict = AGREE
        why = (
            f"all {len(matched)} paired lines agree within {AGREE_TOLERANCE_SEC}s "
            f"(offset {offset_used:+.2f}s is noise)"
        )

    return Reconciliation(
        verdict=verdict,
        lines=judged,
        offset_sec=offset_used,
        scale=scale_used,
        agreement=agreement,
        pairs=len(pairs),
        why=why,
    )
