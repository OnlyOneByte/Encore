"""Source-audio ACQUISITION, separated from what is done with the audio afterwards.

WHY ITS OWN MODULE. Acquisition used to be a stage buried inside separation, and *which* acquisition to
perform was inferred from the URI's shape in two places on opposite sides of the wire: the core emitted
either a watch URL or a bare file key, and both DemucsProcessor and WhisperXProcessor recovered the
intent by testing for an `http(s)` prefix. Any other scheme was silently classified as a local path and
died several stages later inside ffmpeg with "No such file", which reports the symptom and hides the
cause.

The core now DECLARES the fetcher in job params and this module parses it at the boundary, so an
unrecognised fetcher fails before a byte moves. `resolve_source_audio` is MEANT to be the one place that
answers "where are this job's bytes, and do I have to go and get them".

It is not, yet. Only FetchProcessor calls it: DemucsProcessor, RoformerProcessor and WhisperXProcessor
each import `job_fetcher` + `local_source_path` and re-derive the branch inline — three copies of the
answer this function exists to centralise. An earlier version of this docstring asserted they all called
it, which was the more expensive kind of wrong: a reader had no reason to check. Consolidating them is
`docs/specs/SPEC-worker-pipeline.md` §7 E6.

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

from ..processor import CompleteResult, JobSpec, ProgressEvent, source_audio_path
from ..vocabulary import Fetcher, Stage, parse_fetcher


def job_fetcher(job: JobSpec) -> Fetcher:
    """The fetcher this job declared. Unknown values raise — see parse_fetcher."""
    return parse_fetcher((job.params or {}).get("fetcher"))


def local_source_path(job: JobSpec) -> str:
    """Resolve a LOCAL job's `source_uri` against the media volume.

    Absolute paths are honoured as-is so a library mounted outside MEDIA_DIR still works; everything
    else is a key relative to the volume, which is how the core stores library refs.
    """
    return job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)


def find_downloaded(directory: str, media_id: str) -> str | None:
    """The file yt-dlp actually produced for this media id, whatever extension it chose.

    Returns None if nothing landed. Ignores yt-dlp's `.part` fragments so an interrupted download is
    never mistaken for a finished one.
    """
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    for name in names:
        if name.startswith(f"{media_id}.") and not name.endswith((".part", ".ytdl", ".temp")):
            return os.path.join(directory, name)
    return None


async def resolve_source_audio(job: JobSpec, download) -> AsyncIterator[ProgressEvent | str]:
    """Yield progress while ensuring this job's source audio is on disk, then yield its path LAST.

    `download` is an injected async generator taking (source_uri, out_template) so this stays testable
    without a network or a subprocess. A LOCAL job never downloads: its bytes are already on the volume.

    DISCOVERS the filename rather than assuming one, and that is a fix. This used to pass
    `source_audio_path(...)` — a literal `audio/<id>.wav` — straight to yt-dlp, while `download_argv`'s
    own docstring says the template "must carry `%(ext)s` … so the caller discovers the real filename with
    `find_downloaded` rather than assuming one". Given a literal name yt-dlp writes the m4a or webm bytes
    into a file called `.wav`. Nothing broke, because ffmpeg sniffs content and ignores the extension, so
    the mislabelling stayed invisible until something trusted the name — and meanwhile the two separation
    engines did it correctly, which is a large part of why they never adopted this function.

    Backward compatible: `find_downloaded` globs `<id>.*`, so it still finds the legacy mislabelled `.wav`
    files already sitting on a live volume as well as correctly-named new downloads.
    """
    if job_fetcher(job) is Fetcher.LOCAL:
        yield local_source_path(job)
        return

    audio_dir = os.path.dirname(source_audio_path(job.media_dir, job.media_id))
    os.makedirs(audio_dir, exist_ok=True)

    found = find_downloaded(audio_dir, job.media_id)
    if found is not None:
        # Retained from an earlier job for this media, so a cooked song's later align costs no network at
        # all. This reuse is why acquisition is worth being its own job rather than a step repeated by
        # every consumer.
        yield ProgressEvent(stage=Stage.DOWNLOADING, pct=100)
        yield found
        return

    async for ev in download(job.source_uri, os.path.join(audio_dir, f"{job.media_id}.%(ext)s")):
        yield ev
    landed = find_downloaded(audio_dir, job.media_id)
    if landed is not None:
        yield landed


class FetchProcessor:
    """Acquire a media's source audio and stop. The `fetch` action.

    Deliberately does no decode and no separation: its whole job is to put the one asset that cannot be
    regenerated into the `audio/` storage class, so a later `stems` finds it already there. It reports
    the retained original as its media_uri, which is NOT a playable artifact — nothing singable has been
    produced yet, and the core does not flip a media to ready off the back of a fetch.

    ANNOTATION is the final step rather than its own job, because it needs exactly what a download
    produces and nothing a separate job would add: the real title and the exact duration. It is
    best-effort by construction -- a declined identification, or an unreachable MusicBrainz, leaves the
    core's normalizer values in place and never fails the cook. A karaoke night must not stop because a
    metadata service is down.

    Takes the same injectable runner the other processors take, so the whole flow tests with a fake
    subprocess and the real yt-dlp only runs on a worker box.
    """

    def __init__(self, runner=None, ytdlp_bin: str = "yt-dlp", annotator=None) -> None:
        from ..separation.demucs import subprocess_runner

        self._runner = runner or subprocess_runner
        self._ytdlp_bin = ytdlp_bin
        # None disables identification entirely (ENCORE_ANNOTATE=0) -- a legitimate choice for a box with
        # no outbound network, not something to work around.
        self._annotator = annotator

    async def _download(self, source_uri: str, out_path: str) -> AsyncIterator[ProgressEvent]:
        from ..separation.demucs import download_argv, parse_ytdlp_progress

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

        artifacts: dict = {"source": {"audio": path}}
        note = await self._annotate(job)
        if note is not None:
            artifacts["annotation"] = note
        yield CompleteResult(media_uri=path, artifacts=artifacts)

    async def _annotate(self, job: JobSpec) -> dict | None:
        """Identify the song, or return None. Swallows everything: a cook must not fail over metadata.

        Run OFF the event loop. The MusicBrainz gate serialises calls and sleeps to hold one request per
        second, and a blocking sleep here would stall the whole worker — with concurrency > 1 that means
        the OTHER job's progress events stop arriving and the core's progress lease starts expiring.
        Waiting on metadata must not look like a hung separation.
        """
        if self._annotator is None:
            return None
        import asyncio

        from ..metadata.annotate import annotate

        params = job.params or {}

        def _call():
            return annotate(self._annotator, params.get("artist"), params.get("track"), params.get("durationSec"))

        try:
            got = await asyncio.to_thread(_call)
        except Exception:  # noqa: BLE001 - annotation is an enrichment; never a job failure
            return None
        return got.as_artifact() if got is not None else None
