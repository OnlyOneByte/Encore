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

AND ONE THAT IS EASY TO FORGET, learned from the v2 review (H2): a knob is offered only to an ENGINE
THAT READS IT (`TimingReport.engine`, `_READS`). A knob the engine ignores re-runs the same question, and
the one that did not — ALIGN_ON_MIX under the global decode — answered it worse and overwrote the answer.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import StrEnum

from encore_worker.domain.lyrics.report import Engine, TimingReport


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

    @property
    def text_confidence(self) -> str:
        """Core's `textConfidence` for a text of this tier: is it a CLAIM about the words, or a guess?

        THE AXIS CORE'S AUTHORITY RESTS ON (`isAuthoritativeText`: not ASR, and not `low`), so it is the
        text's provenance and nothing else — the old worker's values, source for source. A claim (a
        provider sheet, an authored caption track, a person's paste) is `high`. A MEASUREMENT of what is
        audible is `low` whatever it scored: a transcript, and YouTube's machine track, which is ASR
        wearing a caption's clothes and would otherwise outrank a correct sheet as "Captions". Review M3:
        the timing grade was sent here, so a well-timed machine-caption word doc ranked authoritative and
        every line-sync doc (graded `low`) was demoted below any word doc, however bad its words.

        A RE-PICK KEEPS ITS TEXT'S TIER (`steps.records.tier_of_label`), and this property stays the
        tier's; but the align completion sends a PIN's `textConfidence` as `high` whatever its tier
        (`__main__._lyrics_artifacts`, W3: the orchestrator's decision to restore the old worker's "a human
        chose this text"). W1 had sent a re-timed machine caption `low` here, arguing that core's override
        already honours the choice and that `high` strips the TV's "not verified" mark from machine words;
        that cost is now accepted for a pin, and only for a pin.
        """
        return "high" if self is Tier.CANDIDATE else "low"


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
    #: strict improvement, and it is why coverage has to be bad before it is worth taking. WINDOWED
    #: ENGINE ONLY (`_READS`): the global decode already asks the mix, per stem-silent line (R4).
    ALIGN_ON_MIX = "align-on-mix"
    #: Search the text's own segments instead of presplit's narrower per-row windows. A window derived
    #: from a mis-placed LRC confines the aligner's search to the wrong span, which produces confident
    #: early word times — exactly the shape of the out-of-sync complaint.
    DROP_WINDOWS = "drop-windows"
    #: Give up on word timing and publish the text's own line timings. Terminal for this text: there is
    #: no knob after it, because there is nothing left to vary. Never offered after a GATE refusal
    #: (`TimingReport.refused`), and its own document must pass the lexical gate AND a timing check — its
    #: claims where its own blind decode hears its lines (W3), else the sheet-span envelope gate
    #: (`align_steps._time_line_sync`): with no gate it would publish any timed wrong text, and with a timing
    #: gate alone any caption track of the same video, whatever its words (a translation).
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
    #: Knobs SPENT on a retry that did not beat the attempt it retried (`improves`): never offered again,
    #: and NOT applied, because the search went back to that attempt (`Search`, best-so-far) and tries its
    #: next knob from there. `tried` stays what the attempt APPLIES — `TimeRequest.knobs`, and the ref.
    lost: frozenset[Knob] = frozenset()

    def can(self, knob: Knob) -> bool:
        """Is this knob untried AND applicable to this text?"""
        if knob in self.tried or knob in self.lost:
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
            lost=self.lost,
        )

    def with_lost(self, *knobs: Knob) -> Attempt:
        """This attempt state with `knobs` spent on retries that lost to it: not applied, never re-offered."""
        return replace(self, lost=self.lost | frozenset(knobs))


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

#: The knobs each engine READS. Offering one it ignores spends a pass on an identical attempt — or, as
#: ALIGN_ON_MIX under the global decode did, on a different and worse one that then replaced the first
#: (review H2: Pure_Mids 0 -> 13 gross lines in 12 of 15 bench claim modes; Kinematic to NO LYRICS in 9).
#:
#: GLOBAL reads LINE_SYNC alone. It never places the text (so RESHIFT has nothing to re-place — its
#: report carries no residual for exactly that reason), never searches presplit windows (DROP_WINDOWS),
#: and its thin coverage is a long instrumental outro far more often than an inaudible stem: the mix is
#: already consulted per line where the stem is silent (R4, the mix witness), so a whole-mix re-decode
#: answers that question worse — the band smears every OTHER line. Coverage stays TELEMETRY there.
#: WINDOWED is the capability path the ladder was written for, and reads every knob. A LINE_SYNC
#: document reads none: it is the terminal rung.
_READS: Mapping[Engine, frozenset[Knob]] = {
    Engine.GLOBAL: frozenset({Knob.LINE_SYNC}),
    Engine.WINDOWED: frozenset(Knob),
    Engine.LINE_SYNC: frozenset(),
}


def offers(report: TimingReport, attempt: Attempt, knob: Knob) -> bool:
    """May `knob` be spent on this report? Untried, applicable to the text, AND read by the engine."""
    return knob in _READS[report.engine] and attempt.can(knob)


def decide(report: TimingReport, attempt: Attempt) -> Verdict:
    """Accept, retry differently, or give up on this text.

    Ordered by severity, and each branch offers only a knob that `offers` allows — untried, applicable
    to the text, and read by the engine that produced the report:

      0. REFUSED — a gate measured that this text does not describe this audio. Terminal for the text:
         NextText, never LINE_SYNC, because line sync would publish the same wrong words on the text's
         own clock. (W0 measured it: 168 of 320 bench wrong texts were refused by the envelope gate and
         then retried LINE_SYNC; only M1's bug — a LINE_SYNC document could never commit — kept them
         off the TV.)
      1. NOT USABLE — word order is incoherent, or nothing was timed. Word timing cannot ship. Degrade
         to line sync if the text has its own, else move on.
      2. LINE-SYNCED — the terminal rung. A usable line document is accepted; nothing is left to vary.
      3. MISPLACED — a residual past `SUSPECT_RESIDUAL_SEC` says this text was written for a different
         master. Re-place it against the aligned output.
      4. OVERSHOOTS — the text describes a longer recording than the audio. Widen the search first
         (`DROP_WINDOWS`), because a narrow window derived from a bad placement is the usual cause; then
         try re-placing.
      5. THIN COVERAGE — the words may simply not be audible in the stem. Try the mix (windowed only).
      6. Otherwise accept.

    Every usable branch falls through to `Accept` when no knob applies, NOT to `NextText`. That is rule
    1 in the module docstring, and inverting it is how a correct-but-imperfect alignment becomes no
    lyrics.
    """
    if report.refused is not None:
        if report.engine is Engine.LINE_SYNC:
            return NextText(
                f"line sync refused: {report.refused} — the text's own line timings do not describe "
                "this audio either, and nothing is left to vary"
            )
        return NextText(
            f"{report.refused} — terminal for this text: line sync would publish the same words on "
            "their own clock, past no gate at all"
        )

    if not report.usable:
        if offers(report, attempt, Knob.LINE_SYNC):
            return Retime(Knob.LINE_SYNC, f"{_unusable(report)} — degrading to the text's own line timings")
        if report.engine is Engine.LINE_SYNC or Knob.LINE_SYNC in attempt.tried:
            # The old message ("carries no line timings") was wrong here: the text HAS them, and they
            # were just tried (review W0 note). A line-sync step that returned nothing reports no engine.
            what = (
                _unusable(report)
                if report.engine is Engine.LINE_SYNC
                else "the line-sync attempt produced no document"
            )
            return NextText(f"{what} — and line sync, already spent, is the last rung for this text")
        return NextText(f"{_unusable(report)} and the text carries no line timings to fall back to")

    if report.engine is Engine.LINE_SYNC:
        return Accept(_accepted_because(report, attempt))

    residual = report.residual_sec
    if report.misplaced and residual is not None and offers(report, attempt, Knob.RESHIFT):
        # `residual is not None` is redundant with `misplaced` but narrows the type without an `assert`,
        # which would be stripped under `python -O` and leave the f-string formatting None.
        return Retime(
            Knob.RESHIFT,
            f"residual {residual:+.2f}s after placement — the text was probably written "
            "for a different master; re-placing against the aligned output",
        )

    if report.overshoots:
        over = report.overshoot_sec
        if offers(report, attempt, Knob.DROP_WINDOWS):
            return Retime(
                Knob.DROP_WINDOWS,
                f"timings run +{over:.0f}s past the end of the audio — widening the search, since a "
                "window from a mis-placed text confines the aligner to the wrong span",
            )
        if offers(report, attempt, Knob.RESHIFT):
            return Retime(Knob.RESHIFT, f"timings run +{over:.0f}s past the end of the audio — re-placing")

    if report.thin_coverage and offers(report, attempt, Knob.ALIGN_ON_MIX):
        return Retime(
            Knob.ALIGN_ON_MIX,
            f"coverage {report.coverage:.0%} against the vocals stem — retrying on the full mix, "
            "since an over-suppressed stem can leave the words inaudible",
        )

    return Accept(_accepted_because(report, attempt))


def _unusable(report: TimingReport) -> str:
    """What made a report unpublishable, in the unit it was judged on."""
    if report.engine is Engine.LINE_SYNC:
        if report.out_of_order:
            return f"line timing is incoherent ({report.out_of_order} lines start before the previous one)"
        return "the line-synced document carries no timed line"
    if report.out_of_order:
        return f"word timing is incoherent ({report.out_of_order} out of order)"
    return "the attempt timed no word"


def _accepted_because(report: TimingReport, attempt: Attempt) -> str:
    """Why this was accepted — stating plainly when it was accepted DESPITE a defect.

    A silent accept and an accept-with-nothing-better look identical in a log, and the second is the one
    an operator investigating bad lyrics needs to see.

    Thin coverage is a defect only for an engine that reads the knob answering it. For the global
    decode it is telemetry (a long outro), which `summary()` still prints.
    """
    defects: list[str] = []
    if report.thin_coverage and Knob.ALIGN_ON_MIX in _READS[report.engine]:
        defects.append(f"coverage {report.coverage:.0%}")
    if report.overshoots:
        defects.append(f"overshoot +{report.overshoot_sec:.0f}s")
    if report.misplaced and report.residual_sec is not None:
        defects.append(f"residual {report.residual_sec:+.2f}s")
    if not defects:
        return report.summary()
    spent = ", ".join(sorted(k.value for k in attempt.tried | attempt.lost)) or "none applicable"
    return (
        f"accepted DESPITE {', '.join(defects)} — no untried knob the {report.engine.value} engine reads "
        f"addresses it (spent: {spent}). {report.summary()}"
    )


def improves(before: TimingReport, after: TimingReport, knob: Knob) -> bool:
    """Did the retry that spent `knob` beat the attempt it retried? The best-so-far rule.

    A retry is a HYPOTHESIS that the knob fixes a defect, not a promise, so its result must earn the
    right to replace what it retried. Judged on the defect the knob was spent on, strictly: a tie keeps
    the earlier attempt, which ran on the better evidence (the stem, the text's own placement, the
    narrower windows). Without this the last attempt always won — review H2 measured the cost, a 0-gross
    stem document overwritten by a 13-gross mix one — and a retry that produced NOTHING dropped a usable
    document for the text's line timings, or for the next text.

    An unusable or refused `after` never improves. LINE_SYNC never improves on a usable word document:
    word timing with a defect still beats no word timing (the "accept if nothing better" rule).
    """
    if not after.usable:
        return False
    match knob:
        case Knob.ALIGN_ON_MIX:
            return after.coverage > before.coverage
        case Knob.DROP_WINDOWS:
            return after.overshoot_sec < before.overshoot_sec
        case Knob.RESHIFT:
            if before.misplaced and before.residual_sec is not None:
                return after.residual_sec is not None and abs(after.residual_sec) < abs(before.residual_sec)
            return after.overshoot_sec < before.overshoot_sec
        case Knob.LINE_SYNC:
            return False


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
