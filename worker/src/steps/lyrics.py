"""The align action, as steps.

This file is the 257-line `WhisperXProcessor.process()` broken along the seams it already had. The six
inline numbered stages became eight named steps; nothing about what the worker does changed.

The one behavioural difference is where engine resolution lives. It used to mutate the shared processor
instance, so with ENCORE_WORKER_CONCURRENCY > 1 two align jobs with different `asrModel` raced. It is now
resolved per job into `ctx.engines` before the first step runs.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

from ..lyrics import (
    OVERSHOOT_FRACTION_MAX,
    SOURCE_MANUAL,
    SUSPECT_COVERAGE,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LrclibClient,
    LyricsRequest,
    LyricsText,
    acquire_with_notes,
    baselines_of,
    build_sources,
    candidate_key,
    candidate_last_end,
    candidates_of,
    caption_argv,
    is_line_synced,
    is_valid_lyrics,
    line_synced_lyrics,
    lrc_fit_notes,
    lrclib_to_segments,
    normalize_lyrics,
    presplit_texts,
    read_captions,
    repair_word_spans,
    select_by_baselines,
    validate_timing)
from ..lyrics.captions import find_caption_file

# _opening_window_indices moved to lyrics/validate.py; re-imported so `_opens_for`'s
# fallback works and the an earlier change guard tests can still do `from src.steps.lyrics import
# _opening_window_indices`.
from ..lyrics.validate import LrcShift, _opening_window_indices, estimate_lrc_shift, shift_segments
from ..processor import ProgressEvent, raw_caption_path
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking, run_stage
from ..runtime.step import Outcome, Step, StepResult
from ..vocabulary import Stage, SyncMode, TextSource

#: Which caption track a FetchCaptions instance asks for. The two have opposite roles, and they are
#: fetched separately into separate directories so the distinction cannot come down to a filename guess.
AUTHORED = "captions"
MACHINE = "auto-captions"

#: Whether to retain the RAW caption track for post-process diagnosis. The raw `.vtt`/`.srt` is
#: otherwise written into per-job scratch (`ctx.work`) and destroyed with it, so a caption-parsing
#: defect (earlier changes-class) can never be re-examined from the source bytes after a process, and
#: re-fetching needs the network and a still-live upload. When on, the winning raw track is copied to
#: `derived/captions/<kind>/` before teardown -- the same storage class as the other retained
#: artifacts, with the authored/machine split kept structural by directory.
#:
#: RESOLVED AT THE CONFIG BOUNDARY, not here. `ENCORE_KEEP_RAW_CAPTIONS` is parsed once in
#: `config.WorkerConfig.from_env` with the same false-spelling set every operator boolean uses and
#: threaded in as `keep_raw`. Off unless the operator opts in -- and crucially off for every spelling
#: of false (`0`/`false`/`no`/`off`), which a bare `os.environ.get()` truthiness check got wrong:
#: `ENCORE_KEEP_RAW_CAPTIONS=0` is a non-empty string, so it used to turn retention ON.


class FetchCaptions(Step):
    """Fetch ONE kind of caption track for this upload.

    Authored text is a CANDIDATE for the song's words; a machine track is a BASELINE — evidence of what
    is audible, barred from being the answer while a candidate is trustworthy. One class, two plan slots.

    Never fatal: yt-dlp exits non-zero when a video simply has no track of the kind asked for, which is
    the common case. Skipped entirely for a declared-local source, which has no upload to ask.
    """

    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "runner", "work", "audio.is_local"})

    def __init__(self, kind: str, *, ytdlp_bin: str = "yt-dlp", keep_raw: bool = False) -> None:
        self.kind = kind
        self.auto = kind == MACHINE
        # The worker's configured yt-dlp binary (ENCORE_YTDLP_BIN), threaded from the align plan. Without
        # it every caption fetch shelled out to a bare "yt-dlp" from PATH and silently missed.
        self.ytdlp_bin = ytdlp_bin
        # Whether to retain the raw caption track. A RESOLVED bool threaded from config via the
        # align plan -- the step no longer reads the environment, so ENCORE_KEEP_RAW_CAPTIONS=0 is off
        # like every other worker boolean rather than a truthy non-empty string.
        self.keep_raw = keep_raw
        self.name = f"fetch-captions:{'machine' if self.auto else 'authored'}"
        self.writes = frozenset({"lyrics.machine_cues" if self.auto else "lyrics.authored_cues"})

    def applies(self, ctx: Ctx) -> bool:
        return bool(ctx.job.source_uri) and not ctx.audio.is_local

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        out_dir = os.path.join(ctx.work, self.kind)
        os.makedirs(out_dir, exist_ok=True)
        argv = caption_argv(
            ctx.job.source_uri,
            os.path.join(out_dir, "captions.%(ext)s"),
            str(ctx.params.get("ytdlpBin") or self.ytdlp_bin),
            auto=self.auto)
        try:
            # yt-dlp caption fetch emits no parseable progress, so the parser is constant-None: the
            # shared run_stage then brackets the drain with pct=0 and a single pct=100 — exactly the
            # bracket this step emitted by hand before it shared one implementation with the others.
            async for ev in run_stage(ctx.runner, self.stage, argv, lambda _line: None):
                yield ev
        except Exception as exc:  # noqa: BLE001 — no track / no yt-dlp / no network: all the same miss
            ctx.note(f"{self.name}: none ({exc})")

        # Persist the raw track before the scratch it lives in is torn down. Off unless the
        # operator opted in; done here rather than at teardown because this step is the only place
        # that knows which directory the track landed in and which tier it belongs to.
        if self.keep_raw:
            self._retain_raw(ctx, out_dir)

        cues = read_captions(out_dir)
        if self.auto:
            ctx.lyrics.machine_cues = cues
        else:
            ctx.lyrics.authored_cues = cues
        if cues:
            role = "a BASELINE for grading" if self.auto else "an authoritative CANDIDATE"
            ctx.note(f"{self.name}: {len(cues)} lines — using as {role}")

    def _retain_raw(self, ctx: Ctx, out_dir: str) -> None:
        """Copy the RAW caption track out of scratch into the durable `derived/` store.

        Copies the SAME file the parser chose (`find_caption_file`), so the retained bytes are
        exactly what produced this process's cues — the point is to diagnose the parser, so any other
        candidate in the directory would be the wrong evidence. `self.kind` is the storage tier, so
        the authored/machine split stays structural (a directory), never a filename heuristic.

        Best-effort: a copy failure must never fail an align job, exactly as the fetch miss above
        does not. The extension is preserved from the winning file (`.vtt`/`.srt`) so the durable
        artifact is byte-identical to the source.
        """
        raw = find_caption_file(out_dir)
        if raw is None:
            return
        ext = os.path.splitext(raw)[1].lstrip(".") or "vtt"
        dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, self.kind, ext)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(raw, dest)
            ctx.note(f"{self.name}: retained raw track → {dest}")
        except OSError as exc:
            ctx.note(f"{self.name}: raw retain failed ({exc})")


class AcquireTexts(Step):
    """Run every source and collect what it yielded.

    Independently, not first-hit: a candidate and the baselines that grade it are complements, and a dead
    LRCLIB must degrade the RESULT rather than fail the job.

    This is the one step that can STOP the plan. "This song has no words" is a RESULT — a genuine
    instrumental has none by nature — and it used to be an early `return` inside the god-method. Raising
    would be worse than wrong: readiness waits on align, so a raise would leave an instrumental stuck
    processing forever on a step that is working correctly.
    """

    name = "acquire-texts"
    stage = Stage.ALIGNING
    reads = frozenset(
        {
            "job",
            "audio.path",
            "audio.vocals_path",
            "audio.duration_sec",
            "lyrics.authored_cues",
            "lyrics.machine_cues",
        }
    )
    writes = frozenset({"lyrics.texts"})

    def __init__(
        self, sources: list[Any] | None = None, lyrics_client: Any = None, transcriber: Any = None
    ) -> None:
        self._sources = sources
        self._client = lyrics_client
        self._transcriber = transcriber

    def _build_sources(self, ctx: Ctx, req: LyricsRequest) -> list[Any]:
        """The sources that can run for this request, from the declared registry.

        Two candidates and three baselines, the latter with independent failure modes — the stem gives the
        cleanest words, the mix is the only one that still speaks when separation produced silence (2 of 9
        stems on this library did), and YouTube's machine track is a weak third opinion that abstains when
        too thin to judge with.

        Goes through `lyrics/registry.py` rather than a hardcoded list so a source that CANNOT run says
        which input was missing. That is the gap behind the LRCLIB sinkhole: the provider had been failing
        100% for a month and it looked exactly like songs without lyrics, because a bare `return None` and
        "this song is an instrumental" are the same observation.
        """
        if self._sources is not None:
            return self._sources
        sources, notes = build_sources(
            req,
            client=self._client or LrclibClient(),
            to_segments=lrclib_to_segments,
            transcriber=self._transcriber or _default_transcriber(ctx),
            normalize=normalize_lyrics)
        for note in notes:
            ctx.note(note)
        return sources

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        # an operator RE-PICK short-circuits acquisition entirely. The core names the candidate to
        # re-time (`pinnedRef`), optionally with pasted words (`pinnedText`). Re-running the providers
        # could only produce a different answer than the one the human just chose — and grading it would
        # discard the pin outright (see GradeAndSelect.applies).
        #
        # THE BRANCH LIVES IN GUARDS, not in a step of its own. (1) not acquiring and (2) not grading are
        # REFUSALS, and `applies()`/an early return are where this worker puts refusals; only (3) timing
        # under a caller-chosen ref is new work, and TimeTexts stays the single place that times and emits
        # (E8: one writer per artifact kind). A front-of-plan step would be a second producer of
        # `lyrics.texts` and would still not spare TimeTexts the ref override.
        asked = str(ctx.params.get("pinnedRef") or "").strip()
        pinned_ref = _pinned_ref(ctx)
        if asked and pinned_ref is None:
            yield StepResult(
                outcome=Outcome.STOP,
                reason=f"REFUSING pinned ref {asked!r}: it leaves the media directory. Completing with "
                "no lyrics rather than reading or writing outside the store")
            return
        if pinned_ref:
            pinned = _pinned_lyrics_text(ctx, pinned_ref)
            if pinned is None:
                yield StepResult(
                    outcome=Outcome.STOP,
                    reason=f"pinned lyrics {pinned_ref} carry no readable text — leaving the stored "
                    "candidate exactly as it is rather than re-picking behind the operator")
                return
            ctx.lyrics.texts = [pinned]
            ctx.note(
                f"lyrics PINNED — re-timing {pinned_ref} as {pinned.text_source} "
                f"({len(pinned.segments)} line(s)); acquisition and comparative grading skipped"
            )
            return
        req = LyricsRequest(
            media_id=ctx.job.media_id,
            artist=str(ctx.params.get("artist") or "").strip() or None,
            track=str(ctx.params.get("track") or "").strip() or None,
            artist_credit=str(ctx.params.get("artistCredit") or "").strip() or None,
            duration=ctx.audio.duration_sec,
            audio_path=ctx.audio.path or "",
            vocals_path=ctx.audio.vocals_path,
            caption_segments=ctx.lyrics.authored_cues,
            auto_caption_segments=ctx.lyrics.machine_cues)
        sources = self._build_sources(ctx, req)
        texts: list[LyricsText] = []
        run_notes: list[str] = []
        async for kind, val in run_blocking(lambda: acquire_with_notes(sources, req), self.stage, 0):
            if kind == "progress":
                yield val
            else:
                texts, run_notes = val
        # A source that ran and did not deliver now leaves a trace — a provider transport failure (incl.
        # the LRCLIB DNS sinkhole) says so loudly instead of looking like a song without lyrics.
        for note in run_notes:
            ctx.note(note)
        ctx.lyrics.texts = texts
        if not texts:
            yield StepResult(
                outcome=Outcome.STOP,
                reason="no text from any source (instrumental, or every tier missed) "
                "— completing with no lyrics")


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
    writes = frozenset({"lyrics.selection", "lyrics.texts"})

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
        # candidate DEMOTED for overshoot (chain.py overshoot_penalized) is not among the survivors, so
        # iterating `sel.publish` fired the note exactly when the demotion changed nothing and stayed
        # SILENT exactly when it changed the outcome — the one case an earlier change piece 2 exists for. Walk every
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
                    # but an earlier change F2: say WHOSE. This is the only arm that can fire for a candidate the
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
                    # Over the limit and it WON: an earlier change's own stated cost (owner ruling B fixes some
                    # cases, not all). an earlier change F1: whether a fitting candidate existed is decided from the
                    # POOL, never from `is_published`, which says only that THIS text is in
                    # `sel.publish`. `overshoot_penalized` (lyrics/chain.py) subtracts the overshoot
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
                    # Over the limit and NOT published — the case an earlier change piece 2 was written to surface.
                    # an earlier change F2: this is the third arm of the ladder an earlier change corrected the other two of, and
                    # it repeated their exact defect. `is_published` False means only that THIS text is
                    # not in `sel.publish`; it does NOT mean the overshoot penalty is why. The wrong-song
                    # case loses on AGREEMENT by a margin the comparative `overshoot_penalized` never came
                    # near — the winner is identical with the penalty switched off — so "DEMOTED" here
                    # asserted a causation the step cannot see, and did so on the one line an operator
                    # reads to decide whether an earlier change's demotion did anything. Word it from the fact the step
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
            # (the same cross-object write an earlier change fixes in chain.py). Rebinding the list slot to a copy keeps
            # the demotion local to the published list — see presplit.py's replace() note.
            sel.publish[0] = replace(sel.publish[0], text_confidence="low")
        ctx.lyrics.selection = sel
        ctx.lyrics.texts = sel.publish
        return
        yield  # pragma: no cover - makes this an async generator


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
        {"job", "engines", "lyrics.texts", "lyrics.selection", "audio.path", "audio.vocals_path"}
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
        # the baseline line series, measured by Whisper on THIS audio, is the same for every
        # candidate — compute it ONCE. A synced LRC's windows are then placed onto this recording
        # against it before alignment (see `_shift_for`). Baselines carry line starts only
        # (whisper's `transcribe()` returns segment bounds, not word bounds), which is exactly what the
        # fit needs. Empty when no baseline spoke, which makes every shift a no-op.
        baseline_lines: list[dict[str, Any]] = []
        for b in baselines_of(ctx.lyrics.texts):
            baseline_lines.extend(b.segments)

        def _shift_for(t: Any) -> LrcShift | None:
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

        candidates: list[dict[str, Any]] = []
        for text in ctx.lyrics.texts:
            built = None
            _shift = _shift_for(text)

            def _run(t: Any = text, s: LrcShift | None = _shift) -> Any:
                return _time_one(self._aligner, ctx, t, align_audio, language, s)

            async for kind, val in run_blocking(_run, self.stage, 50):
                if kind == "progress":
                    yield val
                else:
                    built = val
            if built is None:
                continue
            doc, timing, timing_confidence = built

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
                        f"REFUSING word timing ({rep.out_of_order} out-of-order word(s)) "
                        "— degrading to line sync"
                    )
                    if text.timing != TIMING_LINE:
                        continue  # nothing honest left to publish for this source
                    # this degrade path publishes the source's OWN line timings, so it is the
                    # SAME wrong-number risk the line-sync fallbacks in `_time_one` carry — an LRC whose
                    # master starts before this upload would re-introduce the early-highlighting symptom
                    # here even though the aligner was placed. Place the segments with the same measured
                    # shift before line-syncing. A no-op shift (`applied == False`) leaves them verbatim.
                    placed = shift_segments(text.segments, _shift) if _shift is not None else text.segments
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
                # to lyrics/validate.lrc_fit_notes (an earlier change moved the ~45-line decision + its two pairing
                # helpers into the domain package; this step now owns only the windows/opens the
                # decision needs). `_opens_for` prefers presplit's EMITTED opens map over re-deriving by
                # float-equality — that preference is pinned HERE, in the step layer, by an earlier change, which is
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
                if _shift is not None and _shift.applied:
                    windows = shift_segments(windows, _shift)
                for note in lrc_fit_notes(text.text_source, windows, opens, doc):
                    ctx.note(note)

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
                    # this one" (see SUSPECT_COVERAGE in lyrics/chain.py). Publishing only the ranking
                    # score left the TV thresholding a number that decided nothing, which convicted
                    # correct lyrics graded against a partial baseline as ANOTHER SONG.
                    **(
                        {"coverage": sel.winner_coverage}
                        if (sel is not None and text is sel.publish[0] and sel.winner_coverage is not None)
                        else {}
                    ),
                }
            )
        if not candidates:
            raise RuntimeError("text was acquired but nothing could be timed (no word or line sync)")
        ctx.out.artifacts["lyrics"] = {"candidates": candidates}
        # Persist WHY this lyric won, not just which one. `sel.choices` already carries every rejected
        # label with its score, `decided_by` and the baseline vote count; those reach the process log via
        # summary() above but the log rotates and is per-container. Crossing them to durable state here
        # is the whole of an earlier change — the audit trail can then say which of an earlier change's arms fired for a mis-pick.
        if sel is not None:
            ctx.out.selection = sel.to_record()
        yield ProgressEvent(stage=self.stage, pct=100)


class PublishLyrics(Step):
    """Point the CompleteResult at an artifact and report the resolved engines.

    `uri` is the FIRST candidate, not the best. Ranking lives in exactly one place — pickBestLyrics in
    src/lib/contract/lyrics/lyrics.ts — and the core re-picks from `candidates` on every write and restore.
    A second ranking here would drift silently.
    """

    name = "publish-lyrics"
    stage = Stage.ALIGNING
    reads = frozenset({"job", "engines", "out"})
    writes = frozenset({"out"})

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        lyrics = ctx.out.artifacts.get("lyrics")
        if not lyrics or not lyrics.get("candidates"):
            return
        first = lyrics["candidates"][0]
        uri = os.path.join(ctx.job.media_dir, first["ref"])
        lyrics["uri"] = uri
        ctx.out.media_uri = uri
        # Device is deliberately absent — it belongs to the transcriber/aligner, not here, and a guess
        # would be worse than a null.
        ctx.out.facts["asrModel"] = ctx.engines.asr_model
        ctx.out.facts["syncMode"] = ctx.engines.sync_mode.value
        return
        yield  # pragma: no cover - makes this an async generator


# ── helpers the steps share ────────────────────────────────────────────────────────


def _default_transcriber(ctx: Ctx) -> Any:
    """The real transcriber for this job's resolved engines.

    Goes through the module-level cache in lyrics/asr.py, NOT a fresh instance: a new one per job would
    re-read multi-GB weights on every align job. The cache is keyed by (device, model), so two concurrent
    jobs on the same checkpoint share it and two on different checkpoints cannot evict each other.
    """
    from ..lyrics import transcriber_for

    return transcriber_for(ctx.engines.device or "cpu", ctx.engines.asr_model)


def _default_aligner(ctx: Ctx) -> Any:
    from ..lyrics import aligner_for

    return aligner_for(ctx.engines.device or "cpu")


def _pinned_ref(ctx: Ctx) -> str | None:
    """The MediaStore key of a candidate the operator pinned for re-timing, or None.

    REFUSES an absolute path and any key that climbs out of the media directory. This value is joined
    with `ctx.job.media_dir` to both READ a stored doc and WRITE the re-timed one, so an escaping key
    would point the align step at a file outside the store. The core's own `safeMediaPath` rejects the
    same shapes; the worker does not take that on trust, because the worker is the side holding the file
    handle. A refused key is never silently downgraded to a normal process — AcquireTexts STOPs and says so.
    """
    ref = str(ctx.params.get("pinnedRef") or "").strip()
    if not ref or os.path.isabs(ref) or ".." in ref.replace("\\", "/").split("/"):
        return None
    return ref


def _pinned_source_from_ref(ref: str, media_id: str) -> str | None:
    """The `textSource` a stored candidate's own artifact KEY encodes, or None if it does not parse.

    A lyrics doc on disk carries `language`/`lines`/`words` and NOT its provenance, so re-timing an
    already-stored candidate can only recover the tier from the key `candidate_key` built:
    `derived/lyrics/<media>-<source>[-<tag>]-<timing>.json`. Validated against the wire vocabulary, so
    an unrecognised shape DECLINES rather than inventing a tier.
    """
    stem = os.path.splitext(os.path.basename(ref))[0]
    prefix = f"{media_id}-"
    if not stem.startswith(prefix):
        return None
    parts = stem[len(prefix) :].split("-")
    if len(parts) < 2:
        return None
    return parts[0] if parts[0] in {s.value for s in TextSource} else None


def _stored_line_texts(path: str) -> list[str]:
    """The plain line texts of a stored lyrics artifact, in order. Empty when it cannot be read.

    Reads back the shape `TimeTexts` wrote (`lyrics/artifact.py`'s `lines[].text`) and keeps only the
    words: a re-time exists precisely because the stored TIMINGS were wrong for this recording.
    """
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(doc, dict):
        return []
    out: list[str] = []
    for line in doc.get("lines") or []:
        if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip():
            out.append(line["text"].strip())
    return out


def _pinned_lyrics_text(ctx: Ctx, ref: str) -> LyricsText | None:
    """The ONE text a pinned align job must time, or None when the pin cannot be honoured.

    Two shapes, one per way an operator re-picks:

      * `pinnedText` — pasted words, used verbatim. The FIRST producer of SOURCE_MANUAL, which
        `chain.py` has held reserved with no producer since the two-tier split.
      * `pinnedRef` alone — re-time the candidate already on disk, keeping its own `textSource`, which
        by then survives only in its artifact key.

    TIMING_NONE either way, deliberately: re-timing is the whole point, so the stored line bounds must
    not become a line-sync fallback that republishes the timings the operator just rejected. The cost is
    real and accepted — `_time_one` drops a text with neither word nor line timings when the aligner
    fails, so a failed re-time publishes nothing and leaves the stored doc untouched, which is the honest
    outcome rather than shipping back the timings that prompted the re-pick.

    `text_confidence` is `high` because a human chose this text; that outranks any scored guess. `role`
    stays ROLE_UNSPECIFIED on purpose — nothing on this path reads it (grading is skipped), and stamping
    a tier here would put a second decider of tiers outside `lyrics/registry.py` (E9).
    """
    pasted = str(ctx.params.get("pinnedText") or "").strip()
    if pasted:
        lines, source = [ln.strip() for ln in pasted.splitlines() if ln.strip()], SOURCE_MANUAL
    else:
        lines = _stored_line_texts(os.path.join(ctx.job.media_dir, ref))
        source = _pinned_source_from_ref(ref, ctx.job.media_id) or SOURCE_MANUAL
    if not lines:
        return None
    segments: list[dict[str, Any]] = [{"text": ln} for ln in lines]
    return LyricsText(text_source=source, segments=segments, timing=TIMING_NONE, text_confidence="high")


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
