"""Source-audio stream quality policy. PURE -- no network, no subprocess, no yt-dlp import.

WHY THIS EXISTS. This module decides which audio the whole cook pipeline consumes, and that decision
is unrecoverable: the separator, the lossless FLAC instrumental, and the ASR lyrics tier all inherit
whatever arrives here. Encoding the instrumental as FLAC cannot restore fidelity that was discarded at
download time, so this is the upstream-most quality lever Encore has.

`-f bestaudio` alone was not enough. yt-dlp's default ranking is bitrate-led, so an OLD upload that
carries both a modern Opus stream and a legacy AAC stream can hand back the AAC one purely because its
nominal bitrate is higher. Opus is a materially better codec at equal or lower bitrate, and it is also
what YouTube serves for anything recent -- so codec GENERATION, not bitrate, is the axis worth ranking
on.

The approach is borrowed from nomadkaraoke/flacfetch (MIT), which ranks YouTube candidates by codec
and by whether an upload looks official instead of trusting the platform's own ordering. Two pieces of
its idea are adopted, and one trap is deliberately avoided -- see `rank_search_candidates`.
"""
from __future__ import annotations

from typing import Any, Iterable

#: yt-dlp format selector: ordered alternatives, FIRST match wins.
#:
#: Preference is expressed by POSITION rather than by bitrate, which is the whole point -- a bitrate
#: comparison is what picks legacy AAC over modern Opus. The final bare `bestaudio` is a required
#: safety net: a video with neither codec must still download rather than failing the cook, so this
#: can only ever REORDER what yt-dlp would have taken, never reduce what is downloadable.
#:
#: Still audio-only and still native-container: no `bestvideo`, no `-x`, no `--audio-format`.
FORMAT_SELECTOR = "bestaudio[acodec=opus]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio"

#: Substrings that mark an upload as coming from the artist or label rather than a re-uploader.
#: YouTube's auto-generated artist channels are literally suffixed "- Topic"; VEVO is a label network;
#: "official audio"/"official video" are the conventional self-labels.
_OFFICIAL_MARKERS = ("- topic", "vevo", "official audio", "official video", "official music video")

#: Codec generation score. Higher is better. Opus > AAC > anything else we recognise.
#: Keyed on prefixes because yt-dlp reports full codec strings (`mp4a.40.2`, not `aac`).
_CODEC_RANK = (
    ("opus", 3),
    ("mp4a", 2),
    ("aac", 2),
    ("vorbis", 1),
    ("mp3", 1),
)


def _text(value: Any) -> str:
    """Lowercased text for matching; tolerates None and non-str metadata."""
    return value.lower() if isinstance(value, str) else ""


def officiality_score(candidate: dict[str, Any]) -> int:
    """How strongly this upload claims to be the artist's own, from uploader + title markers.

    Deliberately coarse (0, 1 or 2): it is a TIE-BREAKER, not a quality measurement. A re-upload can
    be bit-identical to the official one, so this may only ever nudge ordering.
    """
    uploader = _text(candidate.get("uploader"))
    title = _text(candidate.get("title"))
    score = 0
    if any(marker in uploader for marker in _OFFICIAL_MARKERS):
        score += 2
    if any(marker in title for marker in _OFFICIAL_MARKERS):
        score += 1
    return score


def codec_score(candidate: dict[str, Any]) -> int:
    """Codec-generation score; 0 means unrecognised or absent (treated as unusable)."""
    acodec = _text(candidate.get("acodec"))
    if not acodec or acodec == "none":
        return 0
    for prefix, score in _CODEC_RANK:
        if acodec.startswith(prefix) or prefix in acodec:
            return score
    return 0


def is_usable(candidate: dict[str, Any]) -> bool:
    """A candidate with no recognisable audio codec cannot be cooked, so it is DROPPED.

    Dropping rather than deprioritising is deliberate: a video-only or codec-less entry that reached
    the front of the list would fail at the decode step with a confusing ffmpeg error, long after the
    point where the real cause (no audio stream) was visible.
    """
    return codec_score(candidate) > 0


def rank_search_candidates(candidates: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Best-first ordering over recorded candidate metadata. PURE and STABLE.

    Sort keys, in order of authority:

    1. **Codec generation** -- the axis that survives into the instrumental. This is FIRST on purpose,
       and it is the trap in flacfetch's heuristic that we deliberately avoid: an "official" upload
       carrying legacy AAC must NOT outrank a modern Opus stream, because officiality is a provenance
       signal while codec is an actual fidelity difference the singer can hear.
    2. **Officiality** -- breaks ties between comparable codecs, preferring the artist's own upload
       over a lyrics-channel re-upload (which also tends to carry cleaner metadata for the
       normaliser and therefore better LRCLIB hit rates).
    3. **Bitrate** -- only meaningful WITHIN one codec, which is exactly where it is applied.

    Python's sort is stable, so candidates equal on all three keys keep their input order rather than
    reordering between runs.
    """
    usable = [c for c in candidates if is_usable(c)]
    return sorted(
        usable,
        key=lambda c: (
            -codec_score(c),
            -officiality_score(c),
            -(c.get("abr") or 0),
        ),
    )
