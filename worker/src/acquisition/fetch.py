"""Source-audio ACQUISITION, separated from what is done with the audio afterwards.

The core DECLARES the fetcher in job params and this module parses it at the boundary, rather than
inferring it from the URI's shape, so an unrecognised fetcher fails before a byte moves instead of
dying several stages later inside ffmpeg with an opaque "No such file".

The step `AcquireAudio` is the ONLY place that resolves "where are this job's bytes, and do I have to
go and get them" for all four actions; `tests/test_worker_layers.py` E6 (docs/ARCHITECTURE.md §7.1)
fails if a second one appears.

Acquisition is a JOB, not a stage: a fetch routes on `fetch:<fetcher>` while a process routes on
`stems`, so a box that can download and a box that can separate can be different machines — neither
capability implies the other.

PURE/IO SPLIT as elsewhere in this worker: the argv builders below are pure; only the runner
`AcquireAudio` injects touches the network, and tests replace it with a fake.

`download_argv` and `parse_ytdlp_progress` live HERE, not in `separation/demucs.py`, so the
acquisition step never has to reach into the separation domain to download a file.
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
    temp `<id>.temp.<ext>` (a `.temp.` infix). Also skips the `--write-info-json` metadata sidecar
    `<id>.info.json`, which shares the `<id>.` prefix but is not audio. A finished output is
    `<id>.<ext>`, which carries none of these markers, so this cannot reject a genuine download.
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
            and not name.endswith(".info.json")  # the metadata sidecar, never the audio
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
        # Write the extraction metadata yt-dlp ALREADY produced to a sidecar `<id>.info.json`.
        # yt-dlp performs a full per-video extraction to evaluate the format selector, so `track`,
        # `artist`, `album` and `release_year` are already in hand — capturing them costs NO extra
        # network round trip. These are the uploader's OWN declared credits (a citation, not a guess),
        # which is the input the parser has to reverse-engineer from the title and gets wrong on 45% of
        # the real library. The info json is parsed by `youtube_credit` and cleaned up by the caller.
        "--write-info-json",
        "-f",
        FORMAT_SELECTOR,  # audio-only, native container, codec-ranked
        "-o",
        out_template,
        source_uri,
    ]


#: The fields yt-dlp exposes for a track's own metadata. `track`/`artist` are the pair we want; the
#: rest are read opportunistically. yt-dlp populates these from the video's structured metadata (the
#: "Music" panel / topic-channel data), NOT from the title string — which is exactly why they are a
#: citation rather than a re-parse of the same title the normalizer already has.
def youtube_credit(info: dict) -> dict | None:
    """Build a YouTube-sourced annotation artifact from a parsed `info.json`, or None.

    Returns the same artifact shape MusicBrainz emits (`source`/`artist`/`title`/`confidence`), so the
    core's `applyAnnotation` treats it uniformly. `source` is `"youtube"` and there is NO mbid: YouTube
    does not mint one, and `applyAnnotation` requires an mbid only for the `musicbrainz` source.

    Requires BOTH a track and an artist — a lone artist with no track is not an identification, and
    the title parser already owns the title. Confidence is `high`: this is the uploader's declared
    metadata, not a heuristic. Returns None (declines, never raises) on anything missing or non-string,
    so a video with no music panel simply leaves the parser's values standing — the same
    best-effort contract as the MusicBrainz annotator.
    """
    if not isinstance(info, dict):
        return None
    track = info.get("track")
    artist = info.get("artist")
    # `artist` can arrive as a list on some extractors; take the primary (first) entry.
    if isinstance(artist, (list, tuple)):
        artist = artist[0] if artist else None
    if not isinstance(track, str) or not isinstance(artist, str):
        return None
    track, artist = track.strip(), artist.strip()
    if not track or not artist:
        return None
    return {"source": "youtube", "artist": artist, "title": track, "confidence": "high"}


def read_info_json(path: str) -> dict | None:
    """Parse a yt-dlp `.info.json`, or None if it is absent/unreadable. Never raises.

    A missing or corrupt metadata sidecar must degrade to "no YouTube credit", never fail the process —
    the bytes are what matter, the credit is enrichment.
    """
    import json

    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def info_json_path(directory: str, media_id: str) -> str:
    """Where `--write-info-json` writes for a `<id>.%(ext)s` output template: `<id>.info.json`."""
    return os.path.join(directory, f"{media_id}.info.json")


#: yt-dlp reports download progress as `[download]  45.2% of 5.34MiB at ...`. Compiled once at import
#: because it is matched against every line a download emits.
_YTDLP_PCT = re.compile(r"\[download\]\s+([\d.]+)%")


def parse_ytdlp_progress(line: str) -> int | None:
    """Extract the download percentage from a yt-dlp `[download] 45.2% of ...` line, else None."""
    m = _YTDLP_PCT.search(line)
    return int(float(m.group(1))) if m else None
