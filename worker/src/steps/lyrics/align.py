"""Putting the words on THIS recording's clock: force alignment, validation, repair, publish shape."""

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

    Prefers the `align_window_opens` presplit EMITTED beside the windows (exact) over re-deriving by
    start-equality (`_opening_window_indices`), which strands every line after one start that misses
    by more than 1e-6 — only used as a fallback for a hand-built text that set `align_windows` without
    the opens map.
    """
    opens: list[int] | None = getattr(text, "align_window_opens", None)
    if opens is not None:
        # Assert the emitter's invariant (one open per human segment) so a future producer that
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

        # Prefer the isolated vocals stem; fall back to the mix only when no stem exists. Aligning on
        # the mix measurably smears word boundaries wherever the band is loud (words stretched to
        # seconds, gaps where the aligner loses the vocal under it).
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
        # Persist WHY this lyric won, not just which one: the process log rotates and is
        # per-container, but this reaches the durable job_attempts audit trail.
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

    `audio` MUST be the isolated vocals stem when one exists — see the caller.

    ORDER MATTERS, and all three branches are load-bearing:

      1. A source that ALREADY has word timings (ASR) keeps them, checked FIRST: "do not RUN the
         aligner" is not "throw away timings that already exist".
      2. `lines` mode then skips forced alignment entirely, taking the SAME path the aligner's
         failure fallback takes, so there is one line-sync implementation rather than two to drift.
      3. Otherwise force-align, and on ANY aligner failure fall back to the source's own line timings.

    A source with neither word nor line timings is dropped rather than shipped as an unsynced wall of
    text — the floor is line-level sync.

    `high` confidence on a line-synced doc is deliberate: those are the source's own timings,
    unmodified. Whether they are RIGHT for this recording is a different question — an LRC written
    for another upload of the song is confidently wrong, which is why `forced` remains the default.
    """
    lang = text.language or language

    if text.timing == TIMING_WORD:
        doc = normalize_lyrics({"language": lang, "segments": text.segments})
        if is_valid_lyrics(doc):
            return doc, TIMING_WORD, "medium"

    # Place the LRC on THIS audio's timeline before its numbers are used for anything. `shift` is
    # measured by the caller from the Whisper baselines and is a no-op unless the song's vocal sits
    # confidently later/earlier than the LRC master. Applied to BOTH the aligner's search windows AND
    # the line-sync fallbacks, since those publish `text.segments` verbatim at `high`.
    def _placed(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return shift_segments(segments, shift) if shift is not None else segments

    if ctx.engines.sync_mode is SyncMode.LINES:
        if text.timing != TIMING_LINE:
            return None  # nothing to sync against, and this mode will not go and find timings
        doc = line_synced_lyrics(_placed(text.segments), language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None

    try:
        al = aligner if aligner is not None else _default_aligner(ctx)
        # Search the length-bounded per-row windows when presplit produced them: a tighter window is
        # a better alignment anchor. `segments` stays the source's OWN line timings for the
        # line-sync fallbacks below. Both are `_placed` first: the aligner must search the span the
        # LRC actually occupies on this audio, or whisperx's per-segment crop confines it to the
        # wrong window and publishes confident early word times.
        base_search = text.align_windows if getattr(text, "align_windows", None) else text.segments
        search = _placed(base_search)
        aligned = al.align(search, audio, lang)
        doc = normalize_lyrics(aligned)
        if not is_valid_lyrics(doc):
            raise RuntimeError("aligner returned no word-timed lyrics")
        # The aligner re-times the ORIGINAL script and drops the source's per-line romanization;
        # re-attach it by source-line position. Best-effort: if the aligner split/merged lines the
        # word-timed doc shows single script (the romanization still rides the line-sync fallbacks).
        _attach_romanizations(doc, text.segments)
        return doc, TIMING_WORD, "high"
    except Exception:  # noqa: BLE001 — degrade, never fail the whole job
        if text.timing != TIMING_LINE:
            return None  # nothing real to sync against
        doc = line_synced_lyrics(_placed(text.segments), language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None


def _baseline_line_series(ctx: Ctx) -> list[dict[str, Any]]:
    """The baseline line series Whisper measured on THIS audio, flattened."""
    # Computed ONCE, shared by every candidate, and used to place a synced LRC's windows onto this
    # recording before alignment (see `_shift_for_text`).
    #
    # Read from `lyrics.baselines`, NOT `lyrics.texts`: GradeAndSelect narrows `texts` to
    # `sel.publish` (normally the single winning candidate) one step earlier, so deriving the series
    # from `texts` would leave it empty on every ordinary job, not just a silent one, and placement
    # could never run. The `or` fallback covers the pinned re-time path, where nothing populates the
    # dedicated slot and both sides are empty anyway (a no-op).
    baseline_lines: list[dict[str, Any]] = []
    for b in ctx.lyrics.baselines or baselines_of(ctx.lyrics.texts):
        baseline_lines.extend(b.segments)
    return baseline_lines


def _shift_for_text(ctx: Ctx, t: Any, baseline_lines: list[dict[str, Any]]) -> LrcShift | None:
    """Place a source's OWN line timings onto this recording, when that is even meaningful."""
    # Only a source that brought its OWN line timings (a synced LRCLIB record) can be mis-placed
    # against this audio; an ASR/word source is already measured on it. No baseline -> the estimator
    # abstains (`applied == False`), a no-op too.
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
    # VALIDATE before publishing: `is_valid_lyrics` only asks whether SOME word has a timestamp,
    # which is satisfied even by a doc containing a multi-second hole or a smeared/flashed word.
    if timing == TIMING_WORD:
        rep = validate_timing(doc, ctx.audio.duration_sec)
        ctx.note(f"timing — {rep.summary()}")
        if rep.thin_coverage:
            # Deliberately does NOT blame ASR: a shortfall is usually CORRECT (an instrumental break
            # genuinely has no words). Coverage is a prompt to look, not a diagnosis.
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
            # This degrade path publishes the source's OWN line timings — the same wrong-number
            # risk the line-sync fallbacks in `_time_one` carry — so place them with the same
            # measured shift first, or an LRC whose master starts earlier re-introduces
            # early-highlighting even though the aligner itself was placed.
            placed = shift_segments(text.segments, shift) if shift is not None else text.segments
            doc = line_synced_lyrics(placed, language=text.language or language)
            timing, timing_confidence = TIMING_LINE, "low"
        else:
            # ACT on the smears/flashes just diagnosed: repair_word_spans REPAIRS them in the doc
            # that publishes, provably order-preserving so it can never turn a defect into the one
            # disqualifier (an out-of-order word). Only reached on a usable word doc — a degraded
            # line-sync doc has no per-word spans to repair.
            fixed = repair_word_spans(doc)
            if fixed.changed:
                # `changed` is true exactly when a clamp/extend branch wrote a span — not a claim
                # the written value differs from what it replaced (a word at exactly MIN_WORD_SEC
                # can be rewritten to the value it already had).
                ctx.note(f"timing repaired — {fixed.summary()}")
            elif fixed.flashed_uncorrectable:
                # By construction this branch wrote NOTHING (a flash with no room before the next
                # word), so it gets its own note rather than borrowing the past tense of "repaired".
                ctx.note(
                    f"timing NOT repairable — {len(fixed.flashed_uncorrectable)} flash(es) "
                    "left: no room before the next word"
                )
    return doc, timing, timing_confidence


def _note_lrc_fit(ctx: Ctx, text: Any, doc: dict[str, Any], timing: str, shift: LrcShift | None) -> None:
    """Is this LRC even for this recording? A cheap second opinion on the TIMING."""
    # Only askable for a source that brought its OWN line timings (a synced LRCLIB record) and then
    # got force-aligned: that gives two independent time series over the same lines. The two-tier
    # baseline grading is the primary defence (scores the WORDS against what is audible); this
    # catches the complementary case where a different master shifts or stretches every line.
    if timing == TIMING_WORD and text.timing == TIMING_LINE:
        # `_opens_for` prefers presplit's EMITTED opens map over re-deriving by float-equality; when
        # presplit set no `align_windows`, the segments ARE the windows and every index opens one.
        windows = getattr(text, "align_windows", None)
        if windows:
            opens = _opens_for(text)
        else:
            windows, opens = text.segments, list(range(len(text.segments)))
        # When the LRC was PLACED onto this audio before aligning, the aligner searched the shifted
        # windows, so the post-align fit must compare against those SAME placed starts, or it
        # reports the shift itself as a residual and mislabels a matching recording as different.
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
    # A pinned re-time writes under the ref the CORE chose, never a re-derived key: the core merges
    # on `ref`, so reusing it OVERWRITES the pinned candidate instead of adding a rival beside it. A
    # derived key could not do that — `candidate_key` folds in the timing TIER, so re-timing a
    # line-synced candidate into word timings would land on a different key. Guarded on a single
    # text since that is the only shape the pinned path produces.
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
            # The COMPOSITE score, only on the graded candidate — a baseline carries none by
            # construction (it is the ruler, so scoring it would measure it against itself).
            **(
                {"agreement": sel.winner_score}
                if (sel is not None and text is sel.publish[0] and sel.winner_score is not None)
                else {}
            ),
            # BASELINE COVERAGE too: `breaksTie` reads the ranking score above, `isLikelyWrongSong`
            # thresholds coverage, and only coverage separates "a different song" from "the baseline
            # heard only part of this one" (see SUSPECT_COVERAGE in lyrics/grading.py).
            **(
                {"coverage": sel.winner_coverage}
                if (sel is not None and text is sel.publish[0] and sel.winner_coverage is not None)
                else {}
            ),
        }
    )
    return candidates[0]
