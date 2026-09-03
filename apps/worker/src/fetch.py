"""Source-audio ACQUISITION, separated from what is done with the audio afterwards.

WHY ITS OWN MODULE. Acquisition used to be a stage buried inside separation, and *which* acquisition to
perform was inferred from the URI's shape in two places on opposite sides of the wire: the core emitted
either a watch URL or a bare file key, and both DemucsProcessor and WhisperXProcessor recovered the
intent by testing for an `http(s)` prefix. Any other scheme was silently classified as a local path and
died several stages later inside ffmpeg with "No such file", which reports the symptom and hides the
cause.

The core now DECLARES the fetcher in job params and this module parses it at the boundary, so an
unrecognised fetcher fails before a byte moves. `resolve_source_audio` is the one place that answers
"where are this job's bytes, and do I have to go and get them", and both separation and alignment call
it instead of re-deriving the answer.

FetchProcessor makes acquisition a JOB rather than a stage. That is what lets a box which can download
and a box which can separate be different machines: a fetch routes on `fetch:<fetcher>` while a cook
routes on `stems`, so neither capability implies the other.

PURE/IO SPLIT as elsewhere in this worker: the argv builder and the fetcher parsing are pure and unit
tested; only FetchProcessor touches the network, through the same injectable runner the other
processors use.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

from .processor import CompleteResult, JobSpec, ProgressEvent, source_audio_path
from .vocabulary import Fetcher, Stage, parse_fetcher


def job_fetcher(job: JobSpec) -> Fetcher:
    """The fetcher this job declared. Unknown values raise — see parse_fetcher."""
    return parse_fetcher((job.params or {}).get("fetcher"))


def local_source_path(job: JobSpec) -> str:
    """Resolve a LOCAL job's `source_uri` against the media volume.

    Absolute paths are honoured as-is so a library mounted outside MEDIA_DIR still works; everything
    else is a key relative to the volume, which is how the core stores library refs.
    """
    return job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)


async def resolve_source_audio(job: JobSpec, download) -> AsyncIterator[ProgressEvent | str]:
    """Yield progress while ensuring this job's source audio is on disk, then yield its path LAST.

    One implementation for every consumer, so separation and alignment cannot disagree about where the
    bytes live or when a download is needed. `download` is an injected async generator taking
    (source_uri, out_path) so this stays testable without a network or a subprocess.

    A LOCAL job never downloads: its bytes are already on the volume by definition.
    """
    if job_fetcher(job) is Fetcher.LOCAL:
        yield local_source_path(job)
        return

    audio = source_audio_path(job.media_dir, job.media_id)
    os.makedirs(os.path.dirname(audio), exist_ok=True)
    if os.path.exists(audio):
        # Retained from an earlier job for this media, so a cooked song's later align/score costs no
        # network at all. This reuse is why acquisition is worth being its own job rather than a step
        # repeated by every consumer.
        yield ProgressEvent(stage=Stage.DOWNLOADING, pct=100)
        yield audio
        return

    async for ev in download(job.source_uri, audio):
        yield ev
    yield audio


class FetchProcessor:
    """Acquire a media's source audio and stop. The `fetch` action.

    Deliberately does no decode and no separation: its whole job is to put the one asset that cannot be
    regenerated into the `audio/` storage class, so a later `stems` finds it already there. It reports
    the retained original as its media_uri, which is NOT a playable artifact — nothing singable has been
    produced yet, and the core does not flip a media to ready off the back of a fetch.

    Takes the same injectable runner the other processors take, so the whole flow tests with a fake
    subprocess and the real yt-dlp only runs on a worker box.
    """

    def __init__(self, runner=None, ytdlp_bin: str = "yt-dlp") -> None:
        from .demucs import subprocess_runner

        self._runner = runner or subprocess_runner
        self._ytdlp_bin = ytdlp_bin

    async def _download(self, source_uri: str, out_path: str) -> AsyncIterator[ProgressEvent]:
        from .demucs import download_argv, parse_ytdlp_progress

        yield ProgressEvent(stage=Stage.DOWNLOADING, pct=0)
        last = -1
        async for line in self._runner(download_argv(source_uri, out_path, self._ytdlp_bin)):
            pct = parse_ytdlp_progress(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=Stage.DOWNLOADING, pct=pct)
        if last < 100:
            yield ProgressEvent(stage=Stage.DOWNLOADING, pct=100)

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        path: str | None = None
        async for item in resolve_source_audio(job, self._download):
            if isinstance(item, ProgressEvent):
                yield item
            else:
                path = item
        if path is None or not os.path.exists(path):
            raise RuntimeError(f"fetch produced no audio for {job.media_id}")
        yield CompleteResult(media_uri=path, artifacts={"source": {"audio": path}})
