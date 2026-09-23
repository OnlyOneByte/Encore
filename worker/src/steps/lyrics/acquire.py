"""Getting WORDS: the upload's own caption track, then every source the registry offers."""

from __future__ import annotations

import os
import shutil
from collections.abc import AsyncIterator
from typing import Any

from ...lyrics import (
    LrclibClient,
    LyricsRequest,
    LyricsText,
    acquire_with_notes,
    build_sources,
    caption_argv,
    lrclib_to_segments,
    normalize_lyrics,
    read_captions,
)
from ...lyrics.captions import find_caption_file
from ...processor import ProgressEvent, raw_caption_path
from ...runtime.ctx import Ctx
from ...runtime.runner import run_blocking, run_stage
from ...runtime.step import Outcome, Step, StepResult
from ...vocabulary import Stage
from .pinned import _pinned_lyrics_text, _pinned_ref

AUTHORED = "captions"

MACHINE = "auto-captions"


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
        # Threaded from the align plan (ENCORE_YTDLP_BIN); unset, every fetch shells out to a bare
        # "yt-dlp" off PATH and silently misses.
        self.ytdlp_bin = ytdlp_bin
        # Resolved bool threaded from config (ENCORE_KEEP_RAW_CAPTIONS), not read from env here.
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
            # yt-dlp caption fetch emits no parseable progress, so the parser is constant-None and
            # run_stage brackets the drain with pct=0 then a single pct=100.
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
    """Run every source and collect what it yielded, independently rather than first-hit: a candidate
    and the baselines that grade it are complements, and a dead LRCLIB must degrade the RESULT rather
    than fail the job.

    The one step that can STOP the plan: "this song has no words" is a RESULT, not an error — raising
    would leave an instrumental stuck processing forever, since readiness waits on align.
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

        Two candidates and three baselines with independent failure modes — the stem gives the cleanest
        words, the mix still speaks when separation produced silence (2 of 9 stems on this library
        did), and YouTube's machine track abstains when too thin to judge with.

        Goes through `lyrics/registry.py` rather than a hardcoded list so a source that CANNOT run says
        which input was missing — a bare `return None` and "this song is an instrumental" look
        identical otherwise, which is how a provider failing 100% for a month went undetected.
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
        # An operator RE-PICK (core's `pinnedRef`, optionally `pinnedText`) short-circuits acquisition
        # entirely — re-running providers could only override the human's choice, and grading would
        # discard the pin (see GradeAndSelect.applies).
        #
        # The branch lives in GUARDS, not a step of its own: not-acquiring and not-grading are REFUSALS,
        # which belong in `applies()`/early-return; TimeTexts stays the one place that times and emits
        # (E8: one writer per artifact kind).
        asked = str(ctx.params.get("pinnedRef") or "").strip()
        pinned_ref = _pinned_ref(ctx)
        if asked and pinned_ref is None:
            yield StepResult(
                outcome=Outcome.STOP,
                reason=f"REFUSING pinned ref {asked!r}: it leaves the media directory. Completing with "
                "no lyrics rather than reading or writing outside the store",
            )
            return
        if pinned_ref:
            pinned = _pinned_lyrics_text(ctx, pinned_ref)
            if pinned is None:
                yield StepResult(
                    outcome=Outcome.STOP,
                    reason=f"pinned lyrics {pinned_ref} carry no readable text — leaving the stored "
                    "candidate exactly as it is rather than re-picking behind the operator",
                )
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
        # the LRCLIB DNS sinkhole) says so loudly instead of looking like a song without lyrics.
        for note in run_notes:
            ctx.note(note)
        ctx.lyrics.texts = texts
        if not texts:
            yield StepResult(
                outcome=Outcome.STOP,
                reason="no text from any source (instrumental, or every tier missed) "
                "— completing with no lyrics",
            )


def _default_transcriber(ctx: Ctx) -> Any:
    """The real transcriber for this job's resolved engines.

    Goes through the module-level cache in lyrics/asr.py, NOT a fresh instance: a new one per job would
    re-read multi-GB weights on every align job. The cache is keyed by (device, model), so two concurrent
    jobs on the same checkpoint share it and two on different checkpoints cannot evict each other.
    """
    from ...lyrics import transcriber_for

    return transcriber_for(ctx.engines.device or "cpu", ctx.engines.asr_model)
