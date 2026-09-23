"""Steps that get a job's bytes onto disk.

`AcquireAudio` is the ONE acquisition path, shared by every job type; `tests/test_worker_layers.py`
enforces that no processor re-implements it.
"""

from __future__ import annotations

import glob
import os
from collections.abc import AsyncIterator

from ..acquisition.fetch import (
    download_argv,
    find_downloaded,
    info_json_path,
    job_fetcher,
    local_source_path,
    parse_ytdlp_progress,
    read_info_json,
    youtube_credit,
)
from ..processor import ProgressEvent, source_audio_path
from ..runtime.ctx import Ctx
from ..runtime.runner import run_stage
from ..runtime.step import Step, StepResult
from ..vocabulary import Fetcher, Stage


class AcquireAudio(Step):
    """Put the retained original on disk, downloading only if it is not already there.

    Downloads via `%(ext)s` and DISCOVERS the real filename with `find_downloaded` (globs `<id>.*`)
    rather than assuming one: the extension is whatever YouTube served (m4a or webm), and a literal
    `.wav` target would silently mislabel the bytes (invisible only because ffmpeg sniffs content
    rather than trusting the extension). This also finds legacy mislabelled files already on disk.

    Two skips:
      * a DECLARED-local source (from the core, never inferred from the URI's shape — inference would
        send an unrecognised scheme down the local path to die inside ffmpeg several stages later) is
        already a path under the media volume — nothing to fetch.
      * the file already exists because an earlier job fetched it, so an align job for a processed
        song costs no network at all — the whole reason the raw original is a retained artifact.
    """

    name = "acquire-audio"
    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "runner"})
    writes = frozenset(
        {"audio.path", "audio.is_local", "audio.duration_sec", "audio.vocals_path", "audio.youtube_credit"}
    )

    def __init__(self, *, ytdlp_bin: str = "yt-dlp") -> None:
        self.ytdlp_bin = ytdlp_bin  # ENCORE_YTDLP_BIN, threaded from the plan like ffmpeg_bin/demucs_bin

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        job = ctx.job
        ctx.audio.is_local = job_fetcher(job) is Fetcher.LOCAL
        duration = ctx.params.get("durationSec")
        ctx.audio.duration_sec = float(duration) if isinstance(duration, (int, float)) else None
        ctx.audio.vocals_path = _existing_vocals(ctx)

        if ctx.audio.is_local:
            ctx.audio.path = local_source_path(job)
            ctx.note("audio: declared local, no fetch")
            return

        audio_dir = os.path.dirname(source_audio_path(job.media_dir, job.media_id))
        os.makedirs(audio_dir, exist_ok=True)

        found = find_downloaded(audio_dir, job.media_id)
        if found is not None:
            ctx.audio.path = found
            self._capture_youtube_credit(ctx, audio_dir)
            ctx.note(f"audio: retained original already on disk ({os.path.basename(found)}), no fetch")
            yield ProgressEvent(stage=self.stage, pct=100)
            return

        template = os.path.join(audio_dir, f"{job.media_id}.%(ext)s")
        argv = download_argv(job.source_uri, template, _ytdlp_bin(ctx, self.ytdlp_bin))
        async for ev in run_stage(ctx.runner, self.stage, argv, parse_ytdlp_progress):
            yield ev

        ctx.audio.path = find_downloaded(audio_dir, job.media_id)
        if ctx.audio.path is None:
            # A hard failure, not a degrade: every later step needs these bytes. The usual cause is
            # yt-dlp resolving no audio-only format (a missing JS runtime for YouTube's player
            # challenge), which otherwise reads as a broken worker.
            raise RuntimeError(f"download produced no file for {job.media_id} in {audio_dir}")
        self._capture_youtube_credit(ctx, audio_dir)

    def _capture_youtube_credit(self, ctx: Ctx, audio_dir: str) -> None:
        """Read the download's `.info.json` and stash YouTube's OWN declared credit on the ctx.

        Best-effort and silent on absence: a legacy audio file that predates `--write-info-json` has no
        sidecar, and a video with no music-panel metadata has no `track`/`artist` — both leave
        `ctx.audio.youtube_credit` None, so the parser's values stand. `Annotate` reads this to prefer
        the citation over any parse and to use it as the MusicBrainz query key.
        """
        info = read_info_json(info_json_path(audio_dir, ctx.job.media_id))
        credit = youtube_credit(info) if info else None
        if credit:
            ctx.audio.youtube_credit = credit
            ctx.note(f"youtube: captured declared credit ({credit['artist']} — {credit['title']})")


def _existing_vocals(ctx: Ctx) -> str | None:
    """The isolated vocals stem, if a stems job already published one.

    Returned only when it EXISTS: a path to a missing file would make the ASR baseline fail rather
    than decline, and a declining baseline is a real, honest outcome (stems not processed yet).

    Extension-blind, exactly as `find_downloaded` is for the retained original above: the worker
    re-derives this path on every align job from the CURRENT `VOCALS_EXT` rather than a stored ref, so
    a song whose stem predates a `VOCALS_EXT` change has it on disk under an unexpected extension.
    Glob `<id>-vocals.*`, prefer the current extension when several exist, fall back to the legacy
    file otherwise. No transcode — align just has to LOOK.
    """
    from ..processor import VOCALS_EXT, vocals_path

    canonical = vocals_path(ctx.job.media_dir, ctx.job.media_id)
    if os.path.exists(canonical):
        return canonical

    stem_dir = os.path.dirname(canonical)
    # basename is "<id>-vocals.<VOCALS_EXT>"; strip the extension. glob.escape guards a media id
    # containing a glob metacharacter.
    prefix = os.path.basename(canonical)[: -(len(VOCALS_EXT) + 1)]
    matches = sorted(glob.glob(os.path.join(stem_dir, glob.escape(prefix) + "*")))
    return matches[0] if matches else None


def _ytdlp_bin(ctx: Ctx, configured: str = "yt-dlp") -> str:
    # A job param wins if the core ever sends one; otherwise the worker's configured binary runs.
    return str(ctx.params.get("ytdlpBin") or configured)
