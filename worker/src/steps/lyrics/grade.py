"""Choosing WHICH words: presplit over-long lines, then grade each candidate against what is audible."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

from ...lyrics import (
    SUSPECT_COVERAGE,
    baselines_of,
    candidate_last_end,
    candidates_of,
    fits_audio,
    presplit_texts,
    select_by_baselines,
)
from ...lyrics.grading import Selection
from ...processor import ProgressEvent
from ...runtime.ctx import Ctx
from ...runtime.step import Step, StepResult
from ...vocabulary import Stage
from .pinned import _pinned_ref


class PresplitTexts(Step):
    """Re-lineate the auto-transcribed texts only.

    A whisper segment is a ~30s VAD blob of several lyric lines; authored tiers already arrive
    line-broken. Runs BEFORE grading on purpose: the demotion later sets a suspect winner to `low`, which
    would flip it non-authoritative and hand human-authored lines to a splitter that can only damage them.
    Grading itself compares token SETS, which splitting cannot change.
    """

    name = "presplit-texts"
    stage = Stage.ALIGNING
    reads = frozenset({"lyrics.texts"})
    writes = frozenset({"lyrics.texts"})

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        ctx.lyrics.texts = presplit_texts(ctx.lyrics.texts)
        return
        yield  # pragma: no cover - makes this an async generator


class GradeAndSelect(Step):
    """Grade every candidate against every baseline, then decide what to publish.

    The two-tier decision, made BEFORE anything is aligned — grading five candidates against three
    baselines costs fifteen token-set intersections and no alignment at all. Only what this selects gets
    timed, which is why the common run still costs exactly one alignment.

    Two mechanisms, both running, answering different questions. Selection is COMPARATIVE (argmax, no
    threshold — which is why it separates two versions of one song that both score far above the
    wrong-song cutoff). The demotion is ABSOLUTE: is even the winner about this song at all.
    """

    name = "grade-and-select"
    stage = Stage.ALIGNING
    # Declared because the overshoot demotion reads it: `runtime/plan.py` fails validation otherwise.
    reads = frozenset({"lyrics.texts", "audio.duration_sec"})
    writes = frozenset({"lyrics.selection", "lyrics.texts", "lyrics.baselines"})

    def applies(self, ctx: Ctx) -> bool:
        """Skip comparative selection on a pinned re-time.

        Not an optimisation. A pinned text is hand-built, so it is ROLE_UNSPECIFIED (fail-closed, see
        LyricsText.role): `select_by_baselines` puts it in neither `candidates_of` nor `baselines_of`,
        `sel.publish` comes back EMPTY, and TimeTexts then raises `nothing could be timed` on a job whose
        text was never in doubt. The operator has already decided WHICH text publishes; an argmax over a
        pool of one is not a decision this step gets to make.
        """
        return _pinned_ref(ctx) is None

    def _overshoot_pool(self, ctx: Ctx) -> list[tuple[tuple[str, str | None], str, float | None]]:
        """Every DISTINCT candidate and alternate as (key, label, its own last end time).

        Built from the PRE-selection candidates, not `sel.publish`: a candidate demoted for overshoot is
        not among the survivors, so iterating `sel.publish` stays silent exactly when the demotion changed
        the outcome. `select_by_baselines` rebinds via `replace`, so `texts` is still the whole pool.
        """
        pool: list[tuple[tuple[str, str | None], str, float | None]] = []
        seen_keys: set[tuple[str, str | None]] = set()
        for candidate in candidates_of(ctx.lyrics.texts):
            for text in (candidate, *candidate.alternates):
                key = (text.text_source, text.variant)
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                pool.append((key, text.variant or text.text_source, candidate_last_end(text)))
        return pool

    def _note_overshoots(self, ctx: Ctx, sel: Selection, duration_sec: float) -> None:
        """One operator note per text whose OWN timings run past the end of the audio.

        Separate from `run` because it decides nothing — every judgement was already made by
        `select_by_baselines`; this only explains, in the operator's terms, what the pool looked like when
        it did. Reads the same `fits_audio` boundary the demotion does, so the note and the decision cannot
        disagree.
        """
        published_keys = {(p.text_source, p.variant) for p in sel.publish}
        winner_label = (sel.publish[0].variant or sel.publish[0].text_source) if sel.publish else "none"
        # Walked once, because the verdict below needs POOL facts, not just this text's fate.
        pool = self._overshoot_pool(ctx)
        fitting_labels = [label for _k, label, end in pool if fits_audio(end, duration_sec)]
        for key, label, last_end in pool:
            if last_end is None:
                continue
            over = max(0.0, last_end - duration_sec)
            if over <= 0:
                continue
            is_published = key in published_keys
            if fits_audio(last_end, duration_sec):
                # State whether it published: `sel.choices` names a winner only when one source
                # offered several versions, so a bare note reads as an overshoot on the SHIPPED
                # lyrics even when it was on a rejected rival.
                verdict = (
                    "within tolerance"
                    if is_published
                    else f"within tolerance — NOT published, {winner_label} was"
                )
            elif is_published:
                # Over the limit and it WON: the penalty is COMPARATIVE, so an overshooter leading a
                # fitting rival by more than the overshoot fraction still publishes. Whether a
                # fitting candidate existed is a POOL fact, undecidable from `is_published`.
                verdict = "past the OVERSHOOT limit — PUBLISHED anyway"
                verdict += (
                    f", over {', '.join(fitting_labels)} which fits the audio"
                    if fitting_labels
                    else ", no candidate that fits the audio"
                )
            else:
                # `is_published` False only means it is absent from `sel.publish`, never that the
                # penalty is WHY — a wrong-song candidate can lose purely on agreement. Worded from
                # the fact the step has, not an unproven causation.
                verdict = f"past the OVERSHOOT limit — NOT published, {winner_label} was"
            ctx.note(
                f"lyrics overshoot — {label} runs "
                f"+{over:.0f}s past audio-end ({over / duration_sec:.0%} of {duration_sec:.0f}s) "
                f"— {verdict}"
            )

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        duration_sec = ctx.audio.duration_sec
        sel = select_by_baselines(ctx.lyrics.texts, duration_sec)
        if duration_sec and duration_sec > 0:
            self._note_overshoots(ctx, sel, duration_sec)
        for note in sel.baseline_notes:
            ctx.note(f"baseline — {note}")
        for choice in sel.choices:
            ctx.note(f"lyrics version — {choice.summary()}")
        if sel.baseline_fallback:
            best = sel.publish[0].variant if sel.publish else "none"
            ctx.note(f"NO authored lyrics candidate — falling back to the best baseline ({best})")
        if sel.winner_suspect:
            # Coverage (what the JUDGEMENT used) beside the ranking composite: the two axes disagree by
            # design on a partial baseline, which is what a reader of this line is trying to tell apart.
            ctx.note(
                f"best lyrics are missing most of what was heard (baseline coverage "
                f"{sel.winner_coverage:.2f} < {SUSPECT_COVERAGE}, ranking composite "
                f"{sel.winner_score:.2f}) — probably the WRONG SONG; demoting it and publishing what "
                "was actually heard alongside"
            )
            # replace(), not in-place: mutating would reach a caller-owned LyricsText.
            sel.publish[0] = replace(sel.publish[0], text_confidence="low")
        ctx.lyrics.selection = sel
        # Preserve the BASELINES before narrowing `texts` to what publishes, or TimeTexts' LRC-placement
        # series has no input on any ordinary job. Read while `texts` is still the pre-selection pool.
        ctx.lyrics.baselines = baselines_of(ctx.lyrics.texts)
        ctx.lyrics.texts = sel.publish
        return
        yield  # pragma: no cover - makes this an async generator
