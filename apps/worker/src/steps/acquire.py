"""Steps that get a job's bytes onto disk.

`AcquireAudio` is the step three processors used to each implement for themselves. `fetch.py`'s docstring
already claimed `resolve_source_audio` was "the one place that answers 'where are this job's bytes, and do
I have to go and get them'" — it was true of exactly one of its four callers. Now there is one step, and
the enforcement test in `tests/test_worker_layers.py` keeps it that way.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

from ..acquisition.fetch import job_fetcher, local_source_path
from ..processor import ProgressEvent, source_audio_path
from ..runtime.ctx import Ctx
from ..runtime.step import Step, StepResult
from ..separation.demucs import download_argv, parse_ytdlp_progress
from ..vocabulary import Fetcher, Stage


class AcquireAudio(Step):
    """Put the retained original on disk, downloading only if it is not already there.

    Two skips, both of which used to be inline `if`s in three separate processors:

      * a DECLARED-local source is already a path under the media volume — nothing to fetch. Declared by
        the core rather than inferred from the URI's shape, because inference sent every unrecognised
        scheme down the local path to die inside ffmpeg with "No such file" several stages later.
      * the file already exists, because a stems job fetched it. An align job for a cooked song then
        costs no network at all, which is the whole reason the raw original is a retained artifact.
    """

    name = "acquire-audio"
    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "runner"})
    writes = frozenset({"audio.path", "audio.is_local", "audio.duration_sec", "audio.vocals_path"})

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

        path = source_audio_path(job.media_dir, job.media_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        ctx.audio.path = path
        if os.path.exists(path):
            ctx.note("audio: retained original already on disk, no fetch")
            yield ProgressEvent(stage=self.stage, pct=100)
            return

        argv = download_argv(job.source_uri, path, _ytdlp_bin(ctx))
        yield ProgressEvent(stage=self.stage, pct=0)
        last = -1
        async for line in ctx.runner(argv):
            pct = parse_ytdlp_progress(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=self.stage, pct=pct)
        if last < 100:
            yield ProgressEvent(stage=self.stage, pct=100)


def _existing_vocals(ctx: Ctx) -> str | None:
    """The isolated vocals stem, if a stems job already published one.

    Returned only when it EXISTS. The ASR baseline reads this, and a path to a missing file would make it
    fail rather than decline — and a declining baseline is a real, honest outcome (stems not cooked yet),
    while a failing one looks like a broken worker.
    """
    from ..processor import vocals_path

    path = vocals_path(ctx.job.media_dir, ctx.job.media_id)
    return path if os.path.exists(path) else None


def _ytdlp_bin(ctx: Ctx) -> str:
    return str(ctx.params.get("ytdlpBin") or "yt-dlp")
