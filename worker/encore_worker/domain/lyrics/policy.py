"""The decision: given a measured alignment, accept it, retry it differently, or move on.

THE WHOLE POINT OF THE REWRITE LIVES HERE, and it is a pure function. The old worker computed every
signal in `report.py` and could act on none of them, because its plan was a flat list with an `Outcome`
of `{CONTINUE, STOP}` — nothing could go back and change a parameter. `decide()` is what a workflow
loop consults to know whether to try again and with what.

Pure and side-effect free on purpose: every rule below is a table-driven unit test needing no audio, no
model, no event loop and no DBOS.

TWO RULES THAT ARE EASY TO GET BACKWARDS, both learned from the old worker:

  1. ACCEPT IF NOTHING BETTER IS AVAILABLE. A defect only justifies another attempt when a knob exists
     that could plausibly fix it. Thin coverage with no untried knob is ACCEPTED, because the old
     worker's reasoning still holds: if a transcription covered only the first third, the timing for
     that third is correct, and refusing publishes nothing at all. A policy that rejects on every
     imperfection is how a song ends up with no lyrics.
  2. ASR IS A TIER, NOT A LAST RESORT. See `Tier` and `order_pool`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from encore_worker.domain.lyrics.report import TimingReport


class Tier(StrEnum):
    """Why a text is in the pool, and therefore when it may publish.

    `CANDIDATE` is a CLAIM about what the words are — LRCLIB, or the upload's authored caption track.
    `ASR` is a MEASUREMENT of what is audible in this specific recording. `MACHINE` is YouTube's
    automatic track: also a measurement, but a materially worse one.

    The ordering is not a quality ranking of the text, it is a ranking of *authority*. An ASR transcript
    is less likely to have the right words than a real lyrics sheet, but it can never be the wrong song
    and it can never be misplaced in time, because it was derived from this audio.
    """

    CANDIDATE = "candidate"
    ASR = "asr"
    MACHINE = "machine"


class Knob(StrEnum):
    """A parameter to change before trying the same text again.

    Ordered by cost-to-benefit: `RESHIFT` is arithmetic on numbers already in hand, `ALIGN_ON_MIX` and
    `DROP_WINDOWS` each cost one more alignment pass, and `LINE_SYNC` abandons word timing entirely.
    """

    #: Re-estimate the LRC's offset/scale against the ALIGNED output rather than the pre-align baseline.
    #: Cheapest and highest-yield for "the lyrics are out of sync": the aligned doc is a better ruler
    #: than the baseline was, so a residual measured against it places the text more accurately.
    RESHIFT = "reshift"
    #: Align against the full mix instead of the isolated vocals stem. A stem with bleed, or one whose
    #: vocals were over-suppressed, is a known cause of coverage collapsing — the words are simply not
    #: audible in it. The mix smears word boundaries where the band is loud, so this is a trade, not a
    #: strict improvement, and it is why coverage has to be bad before it is worth taking.
    ALIGN_ON_MIX = "align-on-mix"
    #: Search the text's own segments instead of presplit's narrower per-row windows. A window derived
    #: from a mis-placed LRC confines the aligner's search to the wrong span, which produces confident
    #: early word times — exactly the shape of the out-of-sync complaint.
    DROP_WINDOWS = "drop-windows"
    #: Give up on word timing and publish the text's own line timings. Terminal for this text: there is
    #: no knob after it, because there is nothing left to vary.
    LINE_SYNC = "line-sync"


@dataclass(frozen=True, slots=True)
class Attempt:
    """What has been tried for the current text, and what is still possible.

    Separate from the report because the report describes the AUDIO and this describes the SEARCH. A
    knob is only offered when it is both untried and applicable — proposing `ALIGN_ON_MIX` for a text
    already aligned on the mix would spend a pass to produce the identical result.
    """

    tried: frozenset[Knob] = frozenset()
    #: False once `ALIGN_ON_MIX` has been taken, or when no vocals stem exists to have used.
    aligned_on_stem: bool = True
    #: Presplit produced per-row search windows for this text, so dropping them is meaningful.
    has_windows: bool = False
    #: The text carries its own line timings, so line sync is a real fallback.
    has_line_timings: bool = False
    #: The text brought its own timings from elsewhere (an LRC), so placement — and re-placement — apply.
    has_own_line_timings: bool = False

    def can(self, knob: Knob) -> bool:
        """Is this knob untried AND applicable to this text?"""
        if knob in self.tried:
            return False
        match knob:
            case Knob.RESHIFT:
                return self.has_own_line_timings
            case Knob.ALIGN_ON_MIX:
                return self.aligned_on_stem
            case Knob.DROP_WINDOWS:
                return self.has_windows
            case Knob.LINE_SYNC:
                return self.has_line_timings

    def with_tried(self, knob: Knob) -> Attempt:
        """The same attempt state with `knob` recorded as spent."""
        return Attempt(
            tried=self.tried | {knob},
            aligned_on_stem=self.aligned_on_stem and knob is not Knob.ALIGN_ON_MIX,
            has_windows=self.has_windows and knob is not Knob.DROP_WINDOWS,
            has_line_timings=self.has_line_timings,
            has_own_line_timings=self.has_own_line_timings,
        )


@dataclass(frozen=True, slots=True)
class Accept:
    """Publish this. `why` reaches the `job:state` frame, so it must say more than "ok"."""

    why: str


@dataclass(frozen=True, slots=True)
class Retime:
    """Run the same text again with `knob` changed."""

    knob: Knob
    why: str


@dataclass(frozen=True, slots=True)
class NextText:
    """This text has nothing honest left to offer; move to the next in the pool."""

    why: str


Verdict = Accept | Retime | NextText


def decide(report: TimingReport, attempt: Attempt) -> Verdict:
    """Accept, retry differently, or give up on this text.

    Ordered by severity, and each branch offers only a knob that `Attempt.can` allows:

      1. NOT USABLE — word order is incoherent. Word timing cannot ship. Degrade to line sync if the
         text has its own, else move on. This is the only branch that can reject a text outright.
      2. MISPLACED — a residual past `SUSPECT_RESIDUAL_SEC` says this text was written for a different
         master. Re-place it against the aligned output.
      3. OVERSHOOTS — the text describes a longer recording than the audio. Widen the search first
         (`DROP_WINDOWS`), because a narrow window derived from a bad placement is the usual cause; then
         try re-placing.
      4. THIN COVERAGE — the words may simply not be audible in the stem. Try the mix.
      5. Otherwise accept.

    Every branch falls through to `Accept` when no knob applies, NOT to `NextText`. That is rule 1 in
    the module docstring, and inverting it is how a correct-but-imperfect alignment becomes no lyrics.
    """
    if not report.usable:
        if attempt.can(Knob.LINE_SYNC):
            return Retime(
                Knob.LINE_SYNC,
                f"word timing is incoherent ({report.out_of_order} out of order) — "
                "degrading to the text's own line timings",
            )
        return NextText(
            f"word timing is incoherent ({report.out_of_order} out of order) and the text carries no "
            "line timings to fall back to"
        )

    residual = report.residual_sec
    if report.misplaced and residual is not None and attempt.can(Knob.RESHIFT):
        # `residual is not None` is redundant with `misplaced` but narrows the type without an `assert`,
        # which would be stripped under `python -O` and leave the f-string formatting None.
        return Retime(
            Knob.RESHIFT,
            f"residual {residual:+.2f}s after placement — the text was probably written "
            "for a different master; re-placing against the aligned output",
        )

    if report.overshoots:
        over = report.overshoot_sec
        if attempt.can(Knob.DROP_WINDOWS):
            return Retime(
                Knob.DROP_WINDOWS,
                f"timings run +{over:.0f}s past the end of the audio — widening the search, since a "
                "window from a mis-placed text confines the aligner to the wrong span",
            )
        if attempt.can(Knob.RESHIFT):
            return Retime(Knob.RESHIFT, f"timings run +{over:.0f}s past the end of the audio — re-placing")

    if report.thin_coverage and attempt.can(Knob.ALIGN_ON_MIX):
        return Retime(
            Knob.ALIGN_ON_MIX,
            f"coverage {report.coverage:.0%} against the vocals stem — retrying on the full mix, "
            "since an over-suppressed stem can leave the words inaudible",
        )

    return Accept(_accepted_because(report, attempt))


def _accepted_because(report: TimingReport, attempt: Attempt) -> str:
    """Why this was accepted — stating plainly when it was accepted DESPITE a defect.

    A silent accept and an accept-with-nothing-better look identical in a log, and the second is the one
    an operator investigating bad lyrics needs to see.
    """
    defects: list[str] = []
    if report.thin_coverage:
        defects.append(f"coverage {report.coverage:.0%}")
    if report.overshoots:
        defects.append(f"overshoot +{report.overshoot_sec:.0f}s")
    if report.misplaced and report.residual_sec is not None:
        defects.append(f"residual {report.residual_sec:+.2f}s")
    if not defects:
        return report.summary()
    spent = ", ".join(sorted(k.value for k in attempt.tried)) or "none applicable"
    return (
        f"accepted DESPITE {', '.join(defects)} — no untried knob addresses it (spent: {spent}). "
        f"{report.summary()}"
    )


def order_pool(tiers: list[Tier]) -> list[int]:
    """Indices of `tiers`, in the order they should be attempted.

    Stable within a tier, so the caller's own ranking (grading's argmax over candidates) survives; the
    tiers themselves go CANDIDATE, then ASR, then MACHINE.

    WHY ASR SITS BEFORE MACHINE AND BOTH SIT AFTER CANDIDATES: a real lyrics sheet is the best answer
    when it is right, so it is tried first. But an ASR transcript cannot be the wrong song and cannot be
    misplaced in time, which makes it the RELIABLE fallback rather than the desperate one. YouTube's
    automatic track is the same kind of evidence, measured worse, so it comes last.
    """
    order = {Tier.CANDIDATE: 0, Tier.ASR: 1, Tier.MACHINE: 2}
    return sorted(range(len(tiers)), key=lambda i: (order[tiers[i]], i))


def asr_is_mandatory(tiers: list[Tier]) -> bool:
    """Has an ASR tier been offered at all?

    The invariant behind "no lyrics is the absolute worst case": a pool with no ASR entry has not
    earned the right to conclude the song has no words, because the one source that is always
    applicable — transcribing the audio in hand — was never consulted. The workflow uses this to decide
    between running ASR on demand and terminating.

    `NEEDS_AUDIO` is the only requirement ASR-on-the-mix has, and every job past acquisition satisfies
    it, so an absent ASR tier means the transcriber failed or was never built — a defect to recover
    from, not evidence about the song.
    """
    return Tier.ASR in tiers
