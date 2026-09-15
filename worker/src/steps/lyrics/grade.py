"""Choosing WHICH words: presplit over-long lines, then grade each candidate against what is audible.

Extracted from `steps/lyrics.py`, which held all six lyrics steps in 1029 lines — 55% of every step
in the worker, where no other step file holds more than four.
"""

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
    # timings run past the end of the audio. `runtime/plan.py` fails plan validation for a key nothing
    # produces, so this must be declared, not read implicitly.
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
        # Report overshoot in the same operator log that already carries timing defects (piece 2),
        # so a candidate timed past audio-end is visible in the process log rather than only on the TV.
        #
        # report from the candidates as they were BEFORE selection, not from `sel.publish`. A
        # candidate DEMOTED for overshoot (grading.py overshoot_penalized) is not among the survivors, so
        # iterating `sel.publish` fired the note exactly when the demotion changed nothing and stayed
        # SILENT exactly when it changed the outcome — the one case an earlier change piece 2 exists for. Walk
        # every
        # pre-selection candidate (each source's own text plus its alternates); `select_by_baselines`
        # does not mutate its input (it rebinds via `replace`), so `ctx.lyrics.texts` still carries them.
        # Published-vs-demoted is decided by identity against `sel.publish` on (text_source, variant),
        # which survive the winner's `replace(..., alternates=[])`.
        if duration_sec and duration_sec > 0:
            published_keys = {(p.text_source, p.variant) for p in sel.publish}
            winner_label = (sel.publish[0].variant or sel.publish[0].text_source) if sel.publish else "none"
            # walk the pool ONCE into a deduped list before wording any verdict, because two of
            # the three verdicts below are facts about the POOL, not about the candidate being reported.
            # `is_published` is the only pool fact the old ladder had, and two of its arms wrote claims
            # that fact does not carry. Acquisition order, so the labels read in the order the sources
            # were fetched.
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
            # timings at all: `candidate_last_end` returns None for a text-only source, which cannot be
            # said to run past audio-end and is force-aligned to THIS recording after selection. Same
            # boundary `overshoot_penalized` demotes on, so "fits" here means exactly "the demotion has
            # no quarrel with it".
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
                    # A small, tolerated overshoot the demotion did not act on — still worth seeing,
                    # but an earlier change F2: say WHOSE. This is the only arm that can fire for a candidate
                    # the
                    # operator has no other way to place — `sel.choices` names a winner only when one
                    # source offered several versions — so worded bare it read as an overshoot on the
                    # SHIPPED lyrics when it was on a rejected rival, a false alarm about a process whose
                    # published text does not run past the audio at all. `is_published` is already in
                    # scope and both sibling arms state it; state it here too.
                    verdict = (
                        "within tolerance"
                        if is_published
                        else f"within tolerance — NOT published, {winner_label} was"
                    )
                elif is_published:
                    # Over the limit and it WON: an earlier change's own stated cost (owner ruling B fixes
                    # some
                    # cases, not all). an earlier change F1: whether a fitting candidate existed is decided
                    # from the
                    # POOL, never from `is_published`, which says only that THIS text is in
                    # `sel.publish`. `overshoot_penalized` (lyrics/grading.py) subtracts the overshoot
                    # FRACTION from the composite score — a COMPARATIVE penalty — so an overshooter
                    # leading a fitting rival by more than that fraction publishes with the fitting
                    # rival in the pool the whole time. Claiming "no candidate that fits the audio"
                    # from `is_published` was false on every such process, and false in the direction that
                    # ends the investigation: told nothing fit, the operator hunts a new lyrics source
                    # instead of inspecting the text that was fetched, graded, and narrowly lost.
                    verdict = "past the OVERSHOOT limit — PUBLISHED anyway"
                    verdict += (
                        f", over {', '.join(fits_audio)} which fits the audio"
                        if fits_audio
                        else ", no candidate that fits the audio"
                    )
                else:
                    # Over the limit and NOT published — the case an earlier change piece 2 was written to
                    # surface.
                    # an earlier change F2: this is the third arm of the ladder an earlier change corrected
                    # the other two of, and
                    # it repeated their exact defect. `is_published` False means only that THIS text is
                    # not in `sel.publish`; it does NOT mean the overshoot penalty is why. The wrong-song
                    # case loses on AGREEMENT by a margin the comparative `overshoot_penalized` never came
                    # near — the winner is identical with the penalty switched off — so "DEMOTED" here
                    # asserted a causation the step cannot see, and did so on the one line an operator
                    # reads to decide whether an earlier change's demotion did anything. Word it from the fact
                    # the step
                    # actually has, mirroring the `PUBLISHED anyway` / `within tolerance` sibling arms.
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
            # Report the number the JUDGEMENT actually used — baseline coverage — and carry the ranking
            # score beside it. Naming only the composite would print a number that did not decide this
            #: the two axes disagree by design on a partial baseline, which is exactly the case a
            # reader of this line is trying to tell apart from a real wrong-song pick.
            ctx.note(
                f"best lyrics are missing most of what was heard (baseline coverage "
                f"{sel.winner_coverage:.2f} < {SUSPECT_COVERAGE}, ranking composite "
                f"{sel.winner_score:.2f}) — probably the WRONG SONG; demoting it and publishing what "
                "was actually heard alongside"
            )
            # Demote via replace rather than `sel.publish[0].text_confidence = "low"`: that reached from
            # the step layer straight into a domain LyricsText, mutating a caller-owned object in place
            # (the same cross-object write an earlier change fixes in grading.py). Rebinding the list
            # slot to a copy keeps the demotion local to the published list — see presplit.py's
            # replace() note.
            sel.publish[0] = replace(sel.publish[0], text_confidence="low")
        ctx.lyrics.selection = sel
        # Preserve the BASELINES before narrowing `texts` to what publishes. `sel.publish` is normally the
        # single winning candidate, so a baseline survives this assignment only on the suspect/fallback
        # paths — which meant TimeTexts, whose LRC-placement series comes from baselines, had no input on
        # any ordinary job and silently skipped the placement. Read from `ctx.lyrics.texts` while it is
        # still the PRE-selection pool: `select_by_baselines` does not mutate its input (it rebinds via
        # `replace`), and the narrowing happens on the very next line.
        ctx.lyrics.baselines = baselines_of(ctx.lyrics.texts)
        ctx.lyrics.texts = sel.publish
        return
        yield  # pragma: no cover - makes this an async generator
