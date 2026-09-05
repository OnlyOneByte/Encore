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

