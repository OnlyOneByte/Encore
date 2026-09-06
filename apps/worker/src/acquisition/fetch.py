"""Source-audio ACQUISITION, separated from what is done with the audio afterwards.

WHY ITS OWN MODULE. Acquisition used to be a stage buried inside separation, and *which* acquisition to
perform was inferred from the URI's shape in two places on opposite sides of the wire: the core emitted
either a watch URL or a bare file key, and both DemucsProcessor and WhisperXProcessor recovered the
intent by testing for an `http(s)` prefix. Any other scheme was silently classified as a local path and
died several stages later inside ffmpeg with "No such file", which reports the symptom and hides the
cause.

The core now DECLARES the fetcher in job params and this module parses it at the boundary, so an
unrecognised fetcher fails before a byte moves.

ONE ANSWER, finally. `resolve_source_audio` used to claim in this very docstring that it was the single
place answering "where are this job's bytes, and do I have to go and get them" — while only
`FetchProcessor` called it and three other processors re-derived the branch inline. That was the more
expensive kind of wrong: a reader had no reason to check. S3 resolved it by DELETING the function rather
than fixing its callers, because the surviving copy was also the wrong one (it assumed a `.wav` extension
yt-dlp never wrote). The step `AcquireAudio` is now the only answer, for all four actions, and
`tests/test_worker_layers.py` E6 fails if a second one appears —
the enforcement tests in `docs/ARCHITECTURE.md` §7.1.

Acquisition is a JOB rather than a stage. That is what lets a box which can download and a box which can
separate be different machines: a fetch routes on `fetch:<fetcher>` while a cook routes on `stems`, so
neither capability implies the other.

PURE/IO SPLIT as elsewhere in this worker: the argv builder and the fetcher parsing are pure and unit
tested: the argv builders below are pure, and the only thing that touches the network is the runner
`AcquireAudio` injects, which the tests replace with a fake.

`download_argv` and `parse_ytdlp_progress` live HERE, not in `separation/demucs.py` where they were born.
They were part of the pre-S0 monolith, and left where they were, the acquisition step had to reach into
the separation domain to download a file — the one thing E6 says acquisition owns.
"""

from __future__ import annotations

import os
import re

from ..processor import JobSpec
from ..vocabulary import Fetcher, parse_fetcher
from .stream_quality import FORMAT_SELECTOR


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

    Returns None if nothing landed. Skips yt-dlp's in-progress leftovers so an interrupted download is
    never mistaken for a finished one: the `.part` stream file AND its fragment payloads
    `<id>.<ext>.part-Frag<N>` (both carry `.part`), the `.ytdl` fragment index, and the postprocessor
    temp `<id>.temp.<ext>` (a `.temp.` infix). A finished output is `<id>.<ext>`, which carries none
    of these markers, so this cannot reject a genuine download.
    """
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    for name in names:
        if (
            name.startswith(f"{media_id}.")
            and ".part" not in name
            and not name.endswith(".ytdl")
            and ".temp." not in name
        ):
            return os.path.join(directory, name)
    return None


def download_argv(source_uri: str, out_template: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """yt-dlp argv: fetch the best audio-only stream in its NATIVE container -- no transcode.

    Passing `-x --audio-format wav` inflated a ~5 MB lossy YouTube stream (Opus 135k / AAC 129k --
    measured) into ~59 MB of WAV: a ~12x cost for ZERO fidelity gain, since you cannot restore
    information YouTube already discarded, so the WAV was a lossless copy of lossy audio. The native
    stream is both smaller and higher fidelity than any re-encode.

    `out_template` must carry `%(ext)s` -- the extension is whatever YouTube served (m4a or webm), so
    the caller discovers the real filename with `find_downloaded` rather than assuming one.

    The selector is `stream_quality.FORMAT_SELECTOR`, not a bare `bestaudio`. yt-dlp's own
    ranking is bitrate-led, so an old upload carrying BOTH a modern Opus stream and a legacy AAC one
    can return the AAC purely because its nominal bitrate is higher. Everything downstream inherits
    that choice -- separator, FLAC instrumental, ASR lyrics -- and no later encode can undo it. Its
    final branch is a bare `best` rather than a bare `bestaudio`, because every `bestaudio` branch
    requires an audio-only stream to exist and a muxed-only video would otherwise fail at download;
    with `best` the selector only reorders preferences and never makes a video undownloadable.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        "--newline",  # emit progress as discrete lines (not \r) so the parser sees each update
        "-f",
        FORMAT_SELECTOR,  # audio-only, native container, codec-ranked
        "-o",
        out_template,
        source_uri,
    ]


#: yt-dlp reports download progress as `[download]  45.2% of 5.34MiB at ...`. Compiled once at import
#: because it is matched against every line a download emits.
_YTDLP_PCT = re.compile(r"\[download\]\s+([\d.]+)%")


def parse_ytdlp_progress(line: str) -> int | None:
    """Extract the download percentage from a yt-dlp `[download] 45.2% of ...` line, else None."""
    m = _YTDLP_PCT.search(line)
    return int(float(m.group(1))) if m else None
