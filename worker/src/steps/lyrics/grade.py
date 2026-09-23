"""Choosing WHICH words: presplit over-long lines, then grade each candidate against what is audible."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

from ...lyrics import (
    OVERSHOOT_FRACTION_MAX,
    SUSPECT_COVERAGE,
    baselines_of,
    candidate_last_end,
    candidates_of,
    presplit_texts,
    select_by_baselines,
)
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
    # audio.duration_sec is read so the overshoot demotion can measure how far a candidate's own
    # timings run past the end of the audio; `runtime/plan.py` fails plan validation for an
    # undeclared read.
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

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        duration_sec = ctx.audio.duration_sec
        sel = select_by_baselines(ctx.lyrics.texts, duration_sec)
        # Report overshoot from the candidates as they were BEFORE selection, not from `sel.publish`:
        # a candidate DEMOTED for overshoot is not among the survivors, so iterating `sel.publish`
        # would stay silent exactly when the demotion changed the outcome.
        # `select_by_baselines` does not mutate its input (it rebinds via `replace`), so
        # `ctx.lyrics.texts` still carries every pre-selection candidate plus its alternates.
        if duration_sec and duration_sec > 0:
            published_keys = {(p.text_source, p.variant) for p in sel.publish}
            winner_label = (sel.publish[0].variant or sel.publish[0].text_source) if sel.publish else "none"
            # Deduped pool walked once, since the verdict below needs POOL facts (e.g. whether any
            # candidate fits the audio), not just whether THIS text is published.
            pool: list[tuple[tuple[str, str | None], str, float | None]] = []
            seen_keys: set[tuple[str, str | None]] = set()
            for candidate in candidates_of(ctx.lyrics.texts):
                for text in (candidate, *candidate.alternates):
                    key = (text.text_source, text.variant)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    pool.append((key, text.variant or text.text_source, candidate_last_end(text)))
            # A candidate FITS the audio when its own timings stay inside it, or when it carries no
            # timings at all (`candidate_last_end` returns None for a text-only source, which is
            # force-aligned to THIS recording after selection). Same boundary `overshoot_penalized`
            # demotes on.
            fits_audio = [
                label
                for _k, label, end in pool
                if end is None or max(0.0, end - duration_sec) / duration_sec <= OVERSHOOT_FRACTION_MAX
            ]
            for key, label, last_end in pool:
                if last_end is None:
                    continue
                over = max(0.0, last_end - duration_sec)
                if over <= 0:
                    continue
                is_published = key in published_keys
                if over / duration_sec <= OVERSHOOT_FRACTION_MAX:
                    # Small, tolerated overshoot: state whether it was published or not, since
                    # `sel.choices` only names a winner when one source offered several versions, and
                    # a bare note would otherwise read as an overshoot on the SHIPPED lyrics even when
                    # it was on a rejected rival.
                    verdict = (
                        "within tolerance"
                        if is_published
                        else f"within tolerance — NOT published, {winner_label} was"
                    )
                elif is_published:
                    # Over the limit and it WON anyway: `overshoot_penalized` is a COMPARATIVE penalty
                    # (subtracts the overshoot fraction from the composite score), so an overshooter
                    # leading a fitting rival by more than that fraction still publishes. Whether a
                    # fitting candidate existed is a POOL fact, not decidable from `is_published` alone.
                    verdict = "past the OVERSHOOT limit — PUBLISHED anyway"
                    verdict += (
                        f", over {', '.join(fits_audio)} which fits the audio"
                        if fits_audio
                        else ", no candidate that fits the audio"
                    )
                else:
                    # Over the limit and NOT published: `is_published` False only means this text is
                    # not in `sel.publish`, not that the overshoot penalty is why — a wrong-song
                    # candidate can lose purely on agreement, with the penalty making no difference.
                    # Worded from the fact the step actually has, not an unproven "DEMOTED" causation.
                    verdict = f"past the OVERSHOOT limit — NOT published, {winner_label} was"
                ctx.note(
                    f"lyrics overshoot — {label} runs "
                    f"+{over:.0f}s past audio-end ({over / duration_sec:.0%} of {duration_sec:.0f}s) "
                    f"— {verdict}"
                )
        for note in sel.baseline_notes:
            ctx.note(f"baseline — {note}")
        for choice in sel.choices:
            ctx.note(f"lyrics version — {choice.summary()}")
        if sel.baseline_fallback:
            best = sel.publish[0].variant if sel.publish else "none"
            ctx.note(f"NO authored lyrics candidate — falling back to the best baseline ({best})")
        if sel.winner_suspect:
            # Report baseline coverage (the number the JUDGEMENT actually used) with the ranking
            # composite beside it: the two axes disagree by design on a partial baseline, which is
            # exactly the case a reader of this line is trying to tell apart from a real wrong-song pick.
            ctx.note(
                f"best lyrics are missing most of what was heard (baseline coverage "
                f"{sel.winner_coverage:.2f} < {SUSPECT_COVERAGE}, ranking composite "
                f"{sel.winner_score:.2f}) — probably the WRONG SONG; demoting it and publishing what "
                "was actually heard alongside"
            )
            # Demote via replace rather than `sel.publish[0].text_confidence = "low"`, which would
            # mutate a caller-owned LyricsText in place. Rebinding the list slot to a copy keeps the
            # demotion local to the published list.
            sel.publish[0] = replace(sel.publish[0], text_confidence="low")
        ctx.lyrics.selection = sel
        # Preserve the BASELINES before narrowing `texts` to what publishes: `sel.publish` is normally
        # the single winning candidate, so without this, TimeTexts' LRC-placement series (which reads
        # baselines) would have no input on any ordinary job. Read while `ctx.lyrics.texts` is still
        # the PRE-selection pool — `select_by_baselines` does not mutate its input.
        ctx.lyrics.baselines = baselines_of(ctx.lyrics.texts)
        ctx.lyrics.texts = sel.publish
        return
        yield  # pragma: no cover - makes this an async generator
