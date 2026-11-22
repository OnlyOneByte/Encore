"""The decision: given a measured alignment, accept it, retry it differently, or move on.

PURE and side-effect free, so every rule here is a table-driven unit test needing no audio, no model and no
DBOS. Four rules that are easy to get backwards — accept if nothing better is available, ASR is a tier rather
than a last resort, a knob is offered only to an engine that reads it, and a word document and the LINE_SYNC
document of one text are two answers to one question — are each argued in docs/arch/04-alignment.md §3.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum

from encore_worker.domain.lyrics.report import Engine, TimingReport

#: A word for the purposes of comparing two texts: letters or digits, any script.
_WORDS = re.compile(r"[^\W_]+", re.UNICODE)


class Tier(StrEnum):
    """Why a text is in the pool, and therefore when it may publish: a CLAIM about the words, a MEASUREMENT
    of what is audible, or YouTube's worse measurement.

    The ordering ranks AUTHORITY and not quality (docs/arch/04-alignment.md §3).
    """

    CANDIDATE = "candidate"
    ASR = "asr"
    MACHINE = "machine"

    @property
    def text_confidence(self) -> str:
        """Core's `textConfidence` for a text of this tier: is it a CLAIM about the words, or a guess?

        THE AXIS CORE'S AUTHORITY RESTS ON, so it is the text's PROVENANCE and nothing else — sending the
        TIMING grade here instead ranked a well-timed machine caption authoritative. A PIN is sent `high`
        whatever its tier, which is the orchestrator's decision (docs/arch/04-alignment.md §11).
        """
        return "high" if self is Tier.CANDIDATE else "low"


class Knob(StrEnum):
    """A parameter to change before trying the same text again, ordered by cost-to-benefit: arithmetic, then
    one more alignment pass, then abandoning word timing entirely."""

    #: Re-estimate the LRC's offset/scale against the ALIGNED output rather than the pre-align baseline.
    #: Cheapest and highest-yield for "the lyrics are out of sync": the aligned doc is a better ruler
    #: than the baseline was, so a residual measured against it places the text more accurately.
    RESHIFT = "reshift"
    #: Align against the full mix instead of the isolated vocals stem — a trade and not a strict improvement,
    #: so coverage has to be bad first. WINDOWED ENGINE ONLY (`_READS`).
    ALIGN_ON_MIX = "align-on-mix"
    #: Search the text's own segments instead of presplit's narrower per-row windows. A window derived
    #: from a mis-placed LRC confines the aligner's search to the wrong span, which produces confident
    #: early word times — exactly the shape of the out-of-sync complaint.
    DROP_WINDOWS = "drop-windows"
    #: Give up on word timing and publish the text's own line timings. Terminal, never offered after a GATE
    #: refusal, and its own document must pass two gates of its own. SPENT ON TWO DEFECTS: word timing that
    #: cannot ship, and word timing nothing related to the claims (docs/arch/04-alignment.md §3, §5.3).
    LINE_SYNC = "line-sync"


@dataclass(frozen=True, slots=True)
class Attempt:
    """What has been tried for the current text, and what is still possible — separate from the report, which
    describes the AUDIO where this describes the SEARCH."""

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

#: The knobs each engine READS. GLOBAL reads LINE_SYNC alone, WINDOWED reads every knob, and a LINE_SYNC
#: document reads none, being terminal. Why offering one an engine ignores is a measured regression:
#: docs/arch/04-alignment.md §3, priced in LOG.md, "The W2 corpus row".
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

    Eight rules in severity order, each offering only a knob `offers` allows. Every usable branch falls
    through to `Accept` when no knob applies, NOT to `NextText` (docs/arch/04-alignment.md §3; XA-05).
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
            # were just tried. A line-sync step that returned nothing reports no engine.
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

    if report.claims_related is False and offers(report, attempt, Knob.LINE_SYNC):
        return Retime(
            Knob.LINE_SYNC,
            "nothing relates these timings to the text's own claimed line starts (no offset, no bounded "
            "tempo, no structural story) — asking what the text's own timings score, since where the two "
            "witnesses cannot be reconciled it is our decode that is unvouched for; they publish only if "
            "they pass their own gate and beat this document",
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
    """Why this was accepted — stating plainly when it was accepted DESPITE a defect, which is what an
    operator investigating bad lyrics needs. Thin coverage is a defect only for the windowed engine."""
    defects: list[str] = []
    if report.thin_coverage and Knob.ALIGN_ON_MIX in _READS[report.engine]:
        defects.append(f"coverage {report.coverage:.0%}")
    if report.overshoots:
        defects.append(f"overshoot +{report.overshoot_sec:.0f}s")
    if report.misplaced and report.residual_sec is not None:
        defects.append(f"residual {report.residual_sec:+.2f}s")
    if report.claims_related is False and Knob.LINE_SYNC in _READS[report.engine]:
        # The cross-kind defect: named here too, because "accepted DESPITE claims unrelated (spent:
        # line-sync)" is how an operator reads that the text's own timings were asked and lost — a
        # document published on an unresolved disagreement, which is exactly the shape to investigate.
        defects.append("claims unrelated to these timings")
    if not defects:
        return report.summary()
    spent = ", ".join(sorted(k.value for k in attempt.tried | attempt.lost)) or "none applicable"
    return (
        f"accepted DESPITE {', '.join(defects)} — no untried knob the {report.engine.value} engine reads "
        f"addresses it (spent: {spent}). {report.summary()}"
    )


def improves(before: TimingReport, after: TimingReport, knob: Knob) -> bool:
    """Did the retry that spent `knob` beat the attempt it retried? The best-so-far rule.

    A retry is a HYPOTHESIS, judged strictly on the defect the knob was spent on, so a tie keeps the earlier
    attempt. An unusable or refused `after` never improves, a LINE_SYNC retry its own gate refused included —
    which is NOT a verdict on the text. ACROSS KINDS the line document wins by surviving its own gate, with
    ONE real comparison as a guard: it must time at least as many lines (docs/arch/04-alignment.md §3).
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
            return before.claims_related is False and after.lines >= before.lines


def order_pool(tiers: list[Tier], corroborated: list[bool] | None = None) -> list[int]:
    """Indices of `tiers`, in the order they should be attempted.

    CANDIDATE, then ASR, then MACHINE, with a CORROBORATED text first within a tier and everything else
    stable, so the caller's own ranking survives. Why ASR is the reliable fallback rather than the desperate
    one, and why corroboration breaks the tie instead of arrival order: docs/arch/04-alignment.md §3.
    WHAT IT DOES NOT DO: separate two texts that both look right — a lift needs an emission matrix, so that
    ranking is a per-attempt GATE instead (LOG.md, "W7: the provider pool is real now").
    """
    order = {Tier.CANDIDATE: 0, Tier.ASR: 1, Tier.MACHINE: 2}
    backed = corroborated or [False] * len(tiers)
    return sorted(range(len(tiers)), key=lambda i: (order[tiers[i]], not backed[i], i))


#: Share of one text's distinct words the other must also hold before the two count as CORROBORATING each
#: other. Deliberately coarse, two sheets of DIFFERENT songs sharing only the function words.
CORROBORATION_SHARE = 0.75


def normalised_words(lines: Sequence[str]) -> str:
    """A text's words, lowercased, punctuation-free and space-joined: the form two texts are compared in.

    PURELY FOR IDENTITY AND OVERLAP, never for display. Digits are kept, being sung, and `don't` and `dont`
    do NOT normalise together — merging them would call two different transcriptions one text.
    """
    return " ".join(_WORDS.findall(" ".join(lines).lower()))


#: What `witness_of` calls every provider sheet, because they are one witness: `fetch_provider_lyrics` asks
#: each provider the SAME `artist`/`track`, and LRCLIB is one of the upstreams lrcmux itself queries.
PROVIDER_WITNESS = "providers"


def witness_of(label: str) -> str:
    """Which INDEPENDENT witness a text's label stands for — `corroboration`'s unit of evidence.

    EVERY PROVIDER SHEET IS ONE WITNESS, because the realistic way two sheets agree and are both wrong is a
    metadata mismatch on the upload, and every provider was asked the same question. A caption track and an
    ASR transcript keep their own identity (docs/arch/04-alignment.md §3).
    """
    return label if label.split(":", 1)[0] in ("captions", "asr", "manual") else PROVIDER_WITNESS


def corroboration(texts: Sequence[Sequence[str]], labels: Sequence[str]) -> list[bool]:
    """For each text, whether a text from a DIFFERENT WITNESS agrees with it on the words.

    Measured on DISTINCT words rather than the line sequence, as a share of the SMALLER vocabulary, so a sheet
    that omits a verse still corroborates the one that has it. `labels` is read through `witness_of`, because
    AGREEMENT INSIDE ONE WITNESS IS NOT EVIDENCE.
    """
    if len(texts) != len(labels):  # pragma: no cover - a caller bug, not an input
        raise ValueError("texts and labels must be parallel")
    vocab = [frozenset(normalised_words(lines).split()) for lines in texts]
    witnesses = [witness_of(label) for label in labels]
    out: list[bool] = []
    for index, words in enumerate(vocab):
        agrees = False
        for other_index, other in enumerate(vocab):
            if other_index == index or not words or not other:
                continue
            if witnesses[other_index] == witnesses[index]:
                continue
            smaller = min(len(words), len(other))
            if len(words & other) >= CORROBORATION_SHARE * smaller:
                agrees = True
                break
        out.append(agrees)
    return out


def asr_is_mandatory(tiers: list[Tier]) -> bool:
    """Has an ASR tier been offered at all? A pool without one has not earned the right to conclude the song
    has no words, an absent tier being a defect to recover from rather than evidence about the song."""
    return Tier.ASR in tiers
