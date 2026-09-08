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
    SUSPECT_AGREEMENT,
    TIMING_LINE,
    TIMING_WORD,
    LrclibClient,
    LyricsRequest,
    LyricsText,
    acquire_with_notes,
    build_sources,
    candidate_key,
    candidate_last_end,
    caption_argv,
    is_line_synced,
    is_valid_lyrics,
    line_synced_lyrics,
    lrc_fit_notes,
    lrclib_to_segments,
    normalize_lyrics,
    presplit_texts,
    read_captions,
    select_by_baselines,
    validate_timing,
)
from ..lyrics.captions import find_caption_file

# _opening_window_indices moved to lyrics/validate.py (#456); re-imported so `_opens_for`'s
# fallback works and the #459 guard tests can still do `from src.steps.lyrics import
# _opening_window_indices`.
from ..lyrics.validate import _opening_window_indices
from ..processor import ProgressEvent, raw_caption_path
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking, run_stage
from ..runtime.step import Outcome, Step, StepResult
from ..vocabulary import Stage, SyncMode

#: Which caption track a FetchCaptions instance asks for. The two have opposite roles, and they are
#: fetched separately into separate directories so the distinction cannot come down to a filename guess.
AUTHORED = "captions"
MACHINE = "auto-captions"

#: Whether to retain the RAW caption track for post-cook diagnosis (#670). The raw `.vtt`/`.srt` is
#: otherwise written into per-job scratch (`ctx.work`) and destroyed with it, so a caption-parsing
#: defect (#539/#542-class) can never be re-examined from the source bytes after a cook, and
#: re-fetching needs the network and a still-live upload. When on, the winning raw track is copied to
#: `derived/captions/<kind>/` before teardown -- the same storage class as the other retained
#: artifacts, with the authored/machine split kept structural by directory.
#:
#: RESOLVED AT THE CONFIG BOUNDARY, not here (#709). `ENCORE_KEEP_RAW_CAPTIONS` is parsed once in
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
        # Whether to retain the raw caption track (#670). A RESOLVED bool threaded from config via the
        # align plan -- the step no longer reads the environment, so ENCORE_KEEP_RAW_CAPTIONS=0 is off
        # like every other worker boolean rather than a truthy non-empty string (#709).
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
            auto=self.auto,
        )
        try:
            # yt-dlp caption fetch emits no parseable progress, so the parser is constant-None: the
            # shared run_stage then brackets the drain with pct=0 and a single pct=100 — exactly the
            # bracket this step emitted by hand before it shared one implementation with the others.
            async for ev in run_stage(ctx.runner, self.stage, argv, lambda _line: None):
                yield ev
        except Exception as exc:  # noqa: BLE001 — no track / no yt-dlp / no network: all the same miss
            ctx.note(f"{self.name}: none ({exc})")

        # Persist the raw track before the scratch it lives in is torn down (#670). Off unless the
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
        """Copy the RAW caption track out of scratch into the durable `derived/` store (#670).

        Copies the SAME file the parser chose (`find_caption_file`), so the retained bytes are
        exactly what produced this cook's cues — the point is to diagnose the parser, so any other
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
    cooking forever on a step that is working correctly.
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
            normalize=normalize_lyrics,
        )
        for note in notes:
            ctx.note(note)
        return sources

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        req = LyricsRequest(
            media_id=ctx.job.media_id,
            artist=str(ctx.params.get("artist") or "").strip() or None,
            track=str(ctx.params.get("track") or "").strip() or None,
            artist_credit=str(ctx.params.get("artistCredit") or "").strip() or None,
            duration=ctx.audio.duration_sec,
            audio_path=ctx.audio.path or "",
            vocals_path=ctx.audio.vocals_path,
            caption_segments=ctx.lyrics.authored_cues,
            auto_caption_segments=ctx.lyrics.machine_cues,
        )
        sources = self._build_sources(ctx, req)
        texts: list[LyricsText] = []
        run_notes: list[str] = []
        async for kind, val in run_blocking(lambda: acquire_with_notes(sources, req), self.stage, 0):
            if kind == "progress":
                yield val
            else:
                texts, run_notes = val
        # A source that ran and did not deliver now leaves a trace — a provider transport failure (incl.
        # the LRCLIB DNS sinkhole, #444) says so loudly instead of looking like a song without lyrics.
        for note in run_notes:
            ctx.note(note)
        ctx.lyrics.texts = texts
        if not texts:
            yield StepResult(
                outcome=Outcome.STOP,
                reason="no text from any source (instrumental, or every tier missed) "
                "— completing with no lyrics",
            )


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
    # audio.duration_sec is read so the overshoot demotion (#667) can measure how far a candidate's own
    # timings run past the end of the audio. `runtime/plan.py` fails plan validation for a key nothing
    # produces, so this must be declared, not read implicitly.
    reads = frozenset({"lyrics.texts", "audio.duration_sec"})
    writes = frozenset({"lyrics.selection", "lyrics.texts"})

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        duration_sec = ctx.audio.duration_sec
        sel = select_by_baselines(ctx.lyrics.texts, duration_sec)
        # Report overshoot in the same operator log that already carries timing defects (#667 piece 2),
        # so a candidate timed past audio-end is visible in the cook log rather than only on the TV. The
        # note is emitted for whatever was published, whether or not the overshoot was large enough to
        # change the pick — a small, tolerated overshoot is still worth seeing.
        if duration_sec and duration_sec > 0:
            for published in sel.publish:
                last_end = candidate_last_end(published)
                if last_end is None:
                    continue
                over = max(0.0, last_end - duration_sec)
                if over > 0:
                    verdict = (
                        "past the OVERSHOOT limit — a wrong-version pick, demoted in selection"
                        if over / duration_sec > OVERSHOOT_FRACTION_MAX
                        else "within tolerance"
                    )
                    ctx.note(
                        f"lyrics overshoot — {published.variant or published.text_source} runs "
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
            ctx.note(
                f"best lyrics disagree with every baseline (composite {sel.winner_score:.2f} < "
                f"{SUSPECT_AGREEMENT}) — probably the WRONG SONG; demoting it and publishing what was "
                "actually heard alongside"
            )
            # Demote via replace rather than `sel.publish[0].text_confidence = "low"`: that reached from
            # the step layer straight into a domain LyricsText, mutating a caller-owned object in place
            # (the same cross-object write #605 fixes in chain.py). Rebinding the list slot to a copy keeps
            # the demotion local to the published list — see presplit.py's replace() note.
            sel.publish[0] = replace(sel.publish[0], text_confidence="low")
        ctx.lyrics.selection = sel
        ctx.lyrics.texts = sel.publish
        return
        yield  # pragma: no cover - makes this an async generator


def _opens_for(text: Any) -> list[int]:
    """Opening-window index per human segment for the version fit.

    Prefer the `align_window_opens` presplit EMITTED beside the windows (issue #459): it knew the
    segment->window map when it built them, so it is EXACT. Only fall back to re-deriving by
    start-equality (`_opening_window_indices`) for a hand-built text (a test) that set `align_windows`
    without the opens map — a fallback that strands every line after one start that fails to match to
    1e-6, which is the very fragility the emitted map removes.
    """
    opens: list[int] | None = getattr(text, "align_window_opens", None)
    if opens is not None:
        # The emitter's invariant (one open per human segment). Assert it here so a future producer that
        # emits a mismatched map fails LOUD rather than as a silent index mismatch downstream (#459).
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
                "Re-cook to get a stem."
            )

        sel = ctx.lyrics.selection
        candidates: list[dict[str, Any]] = []
        for text in ctx.lyrics.texts:
            built = None

            def _run(t: Any = text) -> Any:
                return _time_one(self._aligner, ctx, t, align_audio, language)

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
                    doc = line_synced_lyrics(text.segments, language=text.language or language)
                    timing, timing_confidence = TIMING_LINE, "low"

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
                # to lyrics/validate.lrc_fit_notes (#456 moved the ~45-line decision + its two pairing
                # helpers into the domain package; this step now owns only the windows/opens the
                # decision needs). `_opens_for` prefers presplit's EMITTED opens map over re-deriving by
                # float-equality — that preference is pinned HERE, in the step layer, by #459, which is
                # why the call site stays in TimeTexts.run and is not folded into the domain function.
                # When presplit set `align_windows`, only each line's OPENING window carries a real
                # source start; when it did not, the segments ARE the windows and every index opens one.
                windows = getattr(text, "align_windows", None)
                if windows:
                    opens = _opens_for(text)
                else:
                    windows, opens = text.segments, list(range(len(text.segments)))
                for note in lrc_fit_notes(text.text_source, windows, opens, doc):
                    ctx.note(note)

            ref = candidate_key(ctx.job.media_id, text.text_source, timing, text.tag)
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
                }
            )
        if not candidates:
            raise RuntimeError("text was acquired but nothing could be timed (no word or line sync)")
        ctx.out.artifacts["lyrics"] = {"candidates": candidates}
        # Persist WHY this lyric won, not just which one. `sel.choices` already carries every rejected
        # label with its score, `decided_by` and the baseline vote count; those reach the cook log via
        # summary() above but the log rotates and is per-container. Crossing them to durable state here
        # is the whole of #669 — the audit trail can then say which of #542's arms fired for a mis-pick.
        if sel is not None:
            ctx.out.selection = sel.to_record()
        yield ProgressEvent(stage=self.stage, pct=100)


class PublishLyrics(Step):
    """Point the CompleteResult at an artifact and report the resolved engines.

    `uri` is the FIRST candidate, not the best. Ranking lives in exactly one place — pickBestLyrics in
    packages/shared/src/lyrics.ts — and the core re-picks from `candidates` on every write and restore.
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


def _attach_romanizations(doc: dict[str, Any], source_segments: list[dict[str, Any]]) -> None:
    """Copy each source segment's ``romanization`` onto the matching doc line, IN PLACE, by position.

    Only touches ``doc`` when the line counts agree, so a mismatch (the aligner split or merged lines)
    leaves the word-timed doc single-script rather than pairing a romanization with the wrong line.
    Never adds an empty/absent romanization — dual script stays strictly if-available (issue #431)."""
    lines = doc.get("lines")
    if not isinstance(lines, list) or len(lines) != len(source_segments):
        return
    for line, seg in zip(lines, source_segments, strict=True):
        if not isinstance(line, dict) or not isinstance(seg, dict):
            continue
        romanization = seg.get("romanization")
        if isinstance(romanization, str) and romanization.strip():
            line["romanization"] = romanization.strip()


def _time_one(aligner: Any, ctx: Ctx, text: Any, audio: str, language: str) -> tuple[dict, str, str] | None:
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
         cook, at the cost of the bouncing ball. It takes the SAME path the aligner's failure fallback
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

    if ctx.engines.sync_mode is SyncMode.LINES:
        if text.timing != TIMING_LINE:
            return None  # nothing to sync against, and this mode will not go and find timings
        doc = line_synced_lyrics(text.segments, language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None

    try:
        al = aligner if aligner is not None else _default_aligner(ctx)
        # Search the length-bounded per-row windows when presplit produced them (authoritative text
        # whose human lines overflow a row): a tighter window is a better alignment anchor, and the
        # aligner re-times every word inside it. `segments` stays the source's OWN line timings for
        # the line-sync fallbacks below, so those still publish the human timestamps unmodified.
        search = text.align_windows if getattr(text, "align_windows", None) else text.segments
        aligned = al.align(search, audio, lang)
        doc = normalize_lyrics(aligned)
        if not is_valid_lyrics(doc):
            raise RuntimeError("aligner returned no word-timed lyrics")
        # The aligner re-times the ORIGINAL script and drops the per-line romanization the source
        # shipped; re-attach it to the word-timed doc by source-line position (issue #431). Best-effort:
        # when the aligner has split/merged lines so the counts no longer match, the word-timed doc
        # simply shows single script — the romanization still rides the line-sync fallbacks.
        _attach_romanizations(doc, text.segments)
        return doc, TIMING_WORD, "high"
    except Exception:  # noqa: BLE001 — degrade, never fail the whole job
        if text.timing != TIMING_LINE:
            return None  # nothing real to sync against
        doc = line_synced_lyrics(text.segments, language=lang)
        return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None
