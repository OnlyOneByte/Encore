"""Putting the words on THIS recording's clock: force alignment, validation, repair, publish shape.

Extracted from `steps/lyrics.py`, which held all six lyrics steps in 1029 lines — 55% of every step
in the worker, where no other step file holds more than four.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator
from typing import Any

from ...lyrics import (
    TIMING_LINE,
    TIMING_WORD,
    baselines_of,
    candidate_key,
    is_line_synced,
    is_valid_lyrics,
    line_synced_lyrics,
    lrc_fit_notes,
    normalize_lyrics,
    repair_word_spans,
    validate_timing,
)
from ...lyrics.validate import LrcShift, _opening_window_indices, estimate_lrc_shift, shift_segments
from ...processor import ProgressEvent
from ...runtime.ctx import Ctx
from ...runtime.runner import run_blocking
from ...runtime.step import Step, StepResult
from ...vocabulary import Stage, SyncMode
from .pinned import _pinned_ref


def _opens_for(text: Any) -> list[int]:
    """Opening-window index per human segment for the version fit.

    Prefer the `align_window_opens` presplit EMITTED beside the windows: it knew the
    segment->window map when it built them, so it is EXACT. Only fall back to re-deriving by
    start-equality (`_opening_window_indices`) for a hand-built text (a test) that set `align_windows`
    without the opens map — a fallback that strands every line after one start that fails to match to
    1e-6, which is the very fragility the emitted map removes.
    """
    opens: list[int] | None = getattr(text, "align_window_opens", None)
    if opens is not None:
        # The emitter's invariant (one open per human segment). Assert it here so a future producer that
        # emits a mismatched map fails LOUD rather than as a silent index mismatch downstream.
        if len(opens) == len(text.segments):
            return opens
    return _opening_window_indices(text.align_windows, text.segments)


class TimeTexts(Step):
    """Force-align each selected text, degrading to its own line sync when word timing is not usable."""

    name = "time-texts"
    stage = Stage.ALIGNING
    reads = frozenset(
        {
            "job",
            "engines",
            "lyrics.texts",
            "lyrics.baselines",
            "lyrics.selection",
            "audio.path",
            "audio.vocals_path",
        }
    )
    writes = frozenset({"out"})

    def __init__(self, aligner: Any = None) -> None:
        self._aligner = aligner

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        yield ProgressEvent(stage=self.stage, pct=0)
        language = str(ctx.params.get("language") or "en").strip() or "en"

        # THE AUDIO THE ALIGNER GETS. Prefer the isolated vocals stem; fall back to the mix only when no
        # stem exists. Measured across six real artifacts, aligning on the mix produced one word smeared
        # to 5.7s, 3-15 words per song collapsed under 30ms, and gaps up to 63s where the aligner lost the
        # vocal under the band. The stem is already separated and already retained.
        align_audio = ctx.audio.vocals_path or ctx.audio.path or ""
        if ctx.audio.vocals_path is None:
            ctx.note(
                "no vocals stem — aligning against the MIX, which is materially less accurate. "
                "Re-process to get a stem."
            )

        sel = ctx.lyrics.selection
        baseline_lines = _baseline_line_series(ctx)

        candidates: list[dict[str, Any]] = []
        for text in ctx.lyrics.texts:
            built = None
            shift = _shift_for_text(ctx, text, baseline_lines)

            def _run(t: Any = text, s: LrcShift | None = shift) -> Any:
                return _time_one(self._aligner, ctx, t, align_audio, language, s)

            async for kind, val in run_blocking(_run, self.stage, 50):
                if kind == "progress":
                    yield val
                else:
                    built = val
            if built is None:
                continue
            doc, timing, timing_confidence = built

            judged = _judge_word_timing(ctx, text, doc, timing, timing_confidence, shift, language)
            if judged is None:
                continue  # nothing honest left to publish for this source
            doc, timing, timing_confidence = judged

            _note_lrc_fit(ctx, text, doc, timing, shift)

            candidates.append(_write_candidate(ctx, text, doc, timing, timing_confidence, sel, language))
        if not candidates:
            raise RuntimeError("text was acquired but nothing could be timed (no word or line sync)")
        ctx.out.artifacts["lyrics"] = {"candidates": candidates}
        # Persist WHY this lyric won, not just which one. `sel.choices` already carries every rejected
        # label with its score, `decided_by` and the baseline vote count; those reach the process log via
        # summary() above but the log rotates and is per-container. Crossing them to durable state here
        # is the whole of an earlier change — the audit trail can then say which of an earlier change's arms
        # fired for a mis-pick.
        if sel is not None:
            ctx.out.selection = sel.to_record()
        yield ProgressEvent(stage=self.stage, pct=100)


def _default_aligner(ctx: Ctx) -> Any:
    from ...lyrics import aligner_for

    return aligner_for(ctx.engines.device or "cpu")


def _attach_romanizations(doc: dict[str, Any], source_segments: list[dict[str, Any]]) -> None:
    """Copy each source segment's ``romanization`` onto the matching doc line, IN PLACE, by position.

    Only touches ``doc`` when the line counts agree, so a mismatch (the aligner split or merged lines)
    leaves the word-timed doc single-script rather than pairing a romanization with the wrong line.
    Never adds an empty/absent romanization — dual script stays strictly if-available."""
    lines = doc.get("lines")
    if not isinstance(lines, list) or len(lines) != len(source_segments):
        return
    for line, seg in zip(lines, source_segments, strict=True):
        if not isinstance(line, dict) or not isinstance(seg, dict):
            continue
        romanization = seg.get("romanization")
        if isinstance(romanization, str) and romanization.strip():
            line["romanization"] = romanization.strip()


def _time_one(
    aligner: Any, ctx: Ctx, text: Any, audio: str, language: str, shift: LrcShift | None = None
) -> tuple[dict, str, str] | None:
    """Turn one acquired text into (doc, timing, timingConfidence), or None if unusable.

    `audio` MUST be the isolated vocals stem when one exists — see the caller. Forced alignment is a
    wav2vec2 speech model, so aligning against a full mix smears word boundaries wherever the band is
    loud, measurable in the output as long words stretched across passages the aligner lost and short
    function words collapsed to ~20ms.

    ORDER MATTERS, and all three branches are load-bearing:

      1. A source that ALREADY has word timings (ASR) keeps them. This comes FIRST, before the sync-mode
         check, because "do not RUN the aligner" is not "throw away timings that already exist" —
         discarding them would be strictly worse output for no saving, since no alignment pass is
         involved either way.
      2. `lines` mode then skips forced alignment entirely rather than failing it: one fewer ML pass per
         process, at the cost of the bouncing ball. It takes the SAME path the aligner's failure fallback
         takes, so there is one line-sync implementation rather than two that can drift.
      3. Otherwise force-align, and on ANY aligner failure fall back to the source's own line timings.

    A source with neither word nor line timings is dropped rather than shipped as an unsynced wall of
    text — the floor is line-level sync.

    `high` confidence on a line-synced doc is deliberate: those are the source's own timings, unmodified.
    Whether they are RIGHT for this recording is a different question — an LRC written for another upload
    of the song is confidently wrong, which is why `forced` remains the default.
    """
    lang = text.language or language

    if text.timing == TIMING_WORD:
        doc = normalize_lyrics({"language": lang, "segments": text.segments})
        if is_valid_lyrics(doc):
            return doc, TIMING_WORD, "medium"

    # place the LRC on THIS audio's timeline before its numbers are used for anything. `shift`
    # is measured by the caller from the Whisper baselines (a series the LRC did not bound) and is a
    # no-op (`applied == False`) unless the song's vocal sits confidently later/earlier than the LRC
    # master. It moves BOTH the aligner's search windows AND the line-sync fallbacks, because those
    # publish `text.segments` verbatim at `high` — the same wrong number the aligner would inherit.
    def _placed(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return shift_segments(segments, shift) if shift is not None else segments

    if ctx.engines.sync_mode is SyncMode.LINES:
        if text.timing != TIMING_LINE:
            return None  # nothing to sync against, and this mode will not go and find timings
        doc = line_synced_lyrics(_placed(text.segments), language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None

    try:
        al = aligner if aligner is not None else _default_aligner(ctx)
        # Search the length-bounded per-row windows when presplit produced them (authoritative text
        # whose human lines overflow a row): a tighter window is a better alignment anchor, and the
        # aligner re-times every word inside it. `segments` stays the source's OWN line timings for
        # the line-sync fallbacks below, so those still publish the human timestamps unmodified.
        # Both are `_placed` first: the aligner must search the span the LRC actually occupies
        # on this audio, not the master's, or `whisperx.align`'s per-segment crop confines it to the
        # wrong window and it publishes confident early word times.
        base_search = text.align_windows if getattr(text, "align_windows", None) else text.segments
        search = _placed(base_search)
        aligned = al.align(search, audio, lang)
        doc = normalize_lyrics(aligned)
        if not is_valid_lyrics(doc):
            raise RuntimeError("aligner returned no word-timed lyrics")
        # The aligner re-times the ORIGINAL script and drops the per-line romanization the source
        # shipped; re-attach it to the word-timed doc by source-line position. Best-effort:
        # when the aligner has split/merged lines so the counts no longer match, the word-timed doc
        # simply shows single script — the romanization still rides the line-sync fallbacks.
        _attach_romanizations(doc, text.segments)
        return doc, TIMING_WORD, "high"
    except Exception:  # noqa: BLE001 — degrade, never fail the whole job
        if text.timing != TIMING_LINE:
            return None  # nothing real to sync against
        doc = line_synced_lyrics(_placed(text.segments), language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None


def _baseline_line_series(ctx: Ctx) -> list[dict[str, Any]]:
    """The baseline line series Whisper measured on THIS audio, flattened."""
    # the baseline line series, measured by Whisper on THIS audio, is the same for every
    # candidate — compute it ONCE. A synced LRC's windows are then placed onto this recording
    # against it before alignment (see `_shift_for`). Baselines carry line starts only
    # (whisper's `transcribe()` returns segment bounds, not word bounds), which is exactly what the
    # fit needs.
    #
    # READ FROM `lyrics.baselines`, not from `lyrics.texts`. This used to be
    # `baselines_of(ctx.lyrics.texts)`, and its comment claimed the series was "empty when no baseline
    # spoke" — but GradeAndSelect narrows `texts` to `sel.publish` one step earlier, which is normally
    # the single winning candidate. So the series was empty on every ORDINARY job, not just a silent
    # one, and the placement below could never run however badly an LRC needed placing. The dedicated
    # slot carries the evidence past that narrowing.
    #
    # The `or` fallback covers the pinned re-time, where `GradeAndSelect.applies()` is False and so
    # nothing populates the slot; there `texts` is a single hand-built text and both sides are empty,
    # which is the same no-op as before.
    baseline_lines: list[dict[str, Any]] = []
    for b in ctx.lyrics.baselines or baselines_of(ctx.lyrics.texts):
        baseline_lines.extend(b.segments)
    return baseline_lines


def _shift_for_text(ctx: Ctx, t: Any, baseline_lines: list[dict[str, Any]]) -> LrcShift | None:
    """Place a source's OWN line timings onto this recording, when that is even meaningful."""
    # Only a source that brought its OWN line timings (a synced LRCLIB record) can be
    # mis-placed against this audio; an ASR/word source is already measured on it. No
    # baseline -> the estimator abstains (`applied == False`), so this is a no-op then too.
    if t.timing != TIMING_LINE or not baseline_lines:
        return None
    sh = estimate_lrc_shift(t.segments, baseline_lines)
    if sh.applied:
        ctx.note(
            f"{t.text_source}: LRC placed onto this audio before aligning "
            f"(shift {sh.offset_sec:+.2f}s, scale {sh.scale:.3f} over {sh.pairs} baseline lines) "
            "— its master starts earlier/later than this upload"
        )
    return sh


def _judge_word_timing(
    ctx: Ctx,
    text: Any,
    doc: dict[str, Any],
    timing: str,
    timing_confidence: str,
    shift: LrcShift | None,
    language: str,
) -> tuple[dict[str, Any], str, str] | None:
    """Validate, repair or degrade one timed doc. None means this source has nothing honest to publish.

    Returns the possibly-rewritten `(doc, timing, timingConfidence)`; the caller `continue`s on None.
    """
    # VALIDATE before publishing. `is_valid_lyrics` only asks whether SOME word has a timestamp,
    # which six real artifacts satisfied while containing a 63-second hole, a word smeared across
    # 5.7s, and function words at 20ms.
    if timing == TIMING_WORD:
        rep = validate_timing(doc, ctx.audio.duration_sec)
        ctx.note(f"timing — {rep.summary()}")
        if rep.thin_coverage:
            # Deliberately does NOT blame ASR. A shortfall is usually CORRECT: an instrumental
            # break genuinely has no words. On Take On Me the vocals stem sits 18-28 dB below the
            # instrumental through its synth break, and two independent Whisper models given only
            # that clip both transcribe nothing. Coverage is a prompt to look, not a diagnosis.
            ctx.note(
                f"timing covers {rep.coverage:.0%} of the song. Usually an instrumental break or "
                "outro; occasionally a media/duration mismatch."
            )
        if not rep.usable:
            ctx.note(
                f"REFUSING word timing ({rep.out_of_order} out-of-order word(s)) — degrading to line sync"
            )
            if text.timing != TIMING_LINE:
                return None  # nothing honest left to publish for this source
            # this degrade path publishes the source's OWN line timings, so it is the
            # SAME wrong-number risk the line-sync fallbacks in `_time_one` carry — an LRC whose
            # master starts before this upload would re-introduce the early-highlighting symptom
            # here even though the aligner was placed. Place the segments with the same measured
            # shift before line-syncing. A no-op shift (`applied == False`) leaves them verbatim.
            placed = shift_segments(text.segments, shift) if shift is not None else text.segments
            doc = line_synced_lyrics(placed, language=text.language or language)
            timing, timing_confidence = TIMING_LINE, "low"
        else:
            # ACT on the smears/flashes rep just diagnosed (item an earlier change). validate_timing
            # reports them; this REPAIRS them in the doc that publishes, provably order-preserving
            # so it can never turn a defect into the one disqualifier (an out-of-order word). Only
            # on a usable word doc — a degraded line-sync doc has no per-word spans to repair.
            fixed = repair_word_spans(doc)
            if fixed.changed:
                # `changed` is the honest predicate for "the repair ACTED" (validate.py):
                # it is true exactly when a clamp or extend branch was taken and wrote a span.
                # It is not a claim that the written value differs from the one it replaced —
                # at the float boundary a word of exactly MIN_WORD_SEC computes `dur < 0.03`
                # and is rewritten to the value it already had, which over-reports. That is
                # pre-existing in `repair_word_spans`, out of scope here, and reported
                # separately. When declined flashes are also present, `summary()` already
                # names them, so nothing is lost by gating on this alone.
                ctx.note(f"timing repaired — {fixed.summary()}")
            elif fixed.flashed_uncorrectable:
                # `flashed_uncorrectable` is BY CONSTRUCTION the branch that wrote
                # NOTHING, so ORing it into the line above claimed a repair on a
                # byte-identical doc — the ordinary shape, since back-to-back aligner words
                # leave every flash with no room. The operator still needs to know, so it
                # gets its own line instead of borrowing the past tense of a repair that
                # did not happen.
                ctx.note(
                    f"timing NOT repairable — {len(fixed.flashed_uncorrectable)} flash(es) "
                    "left: no room before the next word"
                )
    return doc, timing, timing_confidence


def _note_lrc_fit(ctx: Ctx, text: Any, doc: dict[str, Any], timing: str, shift: LrcShift | None) -> None:
    """Is this LRC even for this recording? A cheap second opinion on the TIMING."""
    # IS THIS LRC EVEN FOR THIS RECORDING? Only askable here, and only for a source that brought
    # its OWN line timings (a synced LRCLIB record) and then got force-aligned: that gives two
    # independent time series over the same lines, which is exactly what the fit needs. A source
    # with no timings of its own has nothing to compare, and in `lines` mode no alignment ran.
    #
    # `_time_one` names the failure: "an LRC written for another upload of the song is
    # confidently wrong". The two-tier baseline grading is the primary defence — it scores the
    # WORDS against what is audible — and this is a cheap independent second opinion on the
    # TIMING, which catches the case where a different master shifts or stretches every line.
    if timing == TIMING_WORD and text.timing == TIMING_LINE:
        # Compute the OPENING-window index of each human line, then hand the fit decision
        # to lyrics/validate.lrc_fit_notes (an earlier change moved the ~45-line decision + its two
        # pairing
        # helpers into the domain package; this step now owns only the windows/opens the
        # decision needs). `_opens_for` prefers presplit's EMITTED opens map over re-deriving by
        # float-equality — that preference is pinned HERE, in the step layer, which is
        # why the call site stays in TimeTexts.run and is not folded into the domain function.
        # When presplit set `align_windows`, only each line's OPENING window carries a real
        # source start; when it did not, the segments ARE the windows and every index opens one.
        windows = getattr(text, "align_windows", None)
        if windows:
            opens = _opens_for(text)
        else:
            windows, opens = text.segments, list(range(len(text.segments)))
        # when the LRC was PLACED onto this audio before aligning, the aligner searched
        # the shifted windows, so the post-align fit must compare against those SAME placed
        # starts — feeding it the LRC master's unshifted starts would report the shift itself
        # as a residual and mislabel a matching recording "different version". A no-op shift
        # (`applied == False`) returns identical copies, so this is inert on the ordinary song.
        if shift is not None and shift.applied:
            windows = shift_segments(windows, shift)
        for note in lrc_fit_notes(text.text_source, windows, opens, doc):
            ctx.note(note)


def _write_candidate(
    ctx: Ctx,
    text: Any,
    doc: dict[str, Any],
    timing: str,
    timing_confidence: str,
    sel: Any,
    language: str,
) -> dict[str, Any]:
    """Write the doc under the ref the core will merge on, and build its candidate record."""
    candidates: list[dict[str, Any]] = []
    # a pinned re-time writes under the ref the CORE chose, never a re-derived key. The core
    # merges on `ref` (mergeLyricsCandidate), so reusing the same key is exactly what makes this
    # OVERWRITE the pinned candidate with freshly-timed words instead of adding a rival beside it.
    # A derived key could not do that: `candidate_key` folds in the timing TIER, so re-timing a
    # line-synced candidate into word timings would land on a different key and leave the doc the
    # operator rejected in place. Guarded on a single text because that is the only shape the
    # pinned path produces (AcquireTexts supplies exactly one), so the override can never leak
    # onto a graded run's second candidate.
    pinned_ref = _pinned_ref(ctx)
    ref = (
        pinned_ref
        if pinned_ref is not None and len(ctx.lyrics.texts) == 1
        else candidate_key(ctx.job.media_id, text.text_source, timing, text.tag)
    )
    final = os.path.join(ctx.job.media_dir, ref)
    os.makedirs(os.path.dirname(final), exist_ok=True)
    with open(final, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    candidates.append(
        {
            "ref": ref,
            "textSource": text.text_source,
            "timing": timing,
            "textConfidence": text.text_confidence,
            "timingConfidence": timing_confidence,
            "language": doc.get("language") or text.language or language,
            "createdAt": int(time.time() * 1000),
            # The COMPOSITE score, and only on the graded candidate. A baseline carries none by
            # construction: it is the ruler, so scoring it would measure it against itself.
            **(
                {"agreement": sel.winner_score}
                if (sel is not None and text is sel.publish[0] and sel.winner_score is not None)
                else {}
            ),
            # BASELINE COVERAGE, on the same graded candidate. Both axes ship because the
            # consumers need DIFFERENT ones: `breaksTie` prefers on the ranking score above,
            # while `isLikelyWrongSong` thresholds coverage — and coverage is the only one of
            # the two that separates "a different song" from "the baseline heard only part of
            # this one" (see SUSPECT_COVERAGE in lyrics/grading.py). Publishing only the ranking
            # score left the TV thresholding a number that decided nothing, which convicted
            # correct lyrics graded against a partial baseline as ANOTHER SONG.
            **(
                {"coverage": sel.winner_coverage}
                if (sel is not None and text is sel.publish[0] and sel.winner_coverage is not None)
                else {}
            ),
        }
    )
    return candidates[0]
