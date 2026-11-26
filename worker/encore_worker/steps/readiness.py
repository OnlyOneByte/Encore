"""What this box knows is broken or off, for the host's Ready for tonight page (proposal 39).

The boot notes are the lines `__main__` already prints, now also sent to core in `Hello.warnings`. The lyrics
check is one lookup of a fixed public song through the same providers, opener and proxy every song uses. It
runs once at boot and when core asks (`Recheck`), never on a timer, and it carries no guest data.
"""

from __future__ import annotations

import socket
import ssl
import urllib.error
from collections.abc import Sequence

from encore_worker.adapters.ports import LyricsProvider
from encore_worker.protocol.frames import Note

#: The fixed public song the lyrics check asks for. Any well-known title works: a miss (404) still proves the
#: service answered, which is all the check claims.
PROBE_ARTIST = "Queen"
PROBE_TRACK = "Bohemian Rhapsody"

LYRICS_UNREACHABLE = (
    "Can't reach the lyrics service, so songs will use heard words, which are less accurate and slower."
)


def boot_notes(
    *,
    capabilities: frozenset[str],
    diarize_off: str | None,
    lyrics_off: str | None,
    youtube_gap: str | None,
) -> tuple[Note, ...]:
    """The boot warnings, one `Note` per line `__main__` prints, in the order it prints them."""
    notes: list[Note] = []
    if diarize_off:
        notes.append(Note("diarize-off", f"diarize off: {diarize_off}"))
    if lyrics_off:
        notes.append(Note("auto-lyrics-off", f"auto lyrics off: {lyrics_off}; a pasted sheet still aligns"))
    if youtube_gap:
        notes.append(Note("youtube-gap", f"YouTube downloads will fail without {youtube_gap}"))
    if not capabilities:
        notes.append(Note("no-capabilities", "no capabilities proven, so the core will route nothing here"))
    return tuple(notes)


def failure_class(exc: BaseException) -> str:
    """DNS, TLS, timeout or an HTTP status: the one fact a host needs to tell a network fault from a dead
    service. Read down the cause chain, because the providers wrap the transport error they caught."""
    seen: BaseException | None = exc
    while seen is not None:
        if isinstance(seen, socket.gaierror):
            return "DNS"
        if isinstance(seen, ssl.SSLError):
            return "TLS"
        if isinstance(seen, TimeoutError):
            return "timeout"
        if isinstance(seen, urllib.error.HTTPError):
            return f"HTTP {seen.code}"
        if isinstance(seen, urllib.error.URLError) and isinstance(seen.reason, BaseException):
            seen = seen.reason
            continue
        seen = seen.__cause__
    text = str(exc)
    if "answered " in text:
        return "HTTP " + text.split("answered ", 1)[1].split(":", 1)[0].strip()
    return type(exc).__name__


def lyrics_check(providers: Sequence[LyricsProvider]) -> Note | None:
    """None when a provider answered the probe song (a miss counts: the service is there), else the note.

    Any provider answering is enough, because the chain falls back the same way for every song.
    """
    if not providers:
        return Note("lyrics-unreachable", LYRICS_UNREACHABLE, "lyrics lookups are off (ENCORE_OFFLINE)")
    failures: list[str] = []
    for provider in providers:
        try:
            provider.fetch(artist=PROBE_ARTIST, track=PROBE_TRACK, duration_sec=None)
        except Exception as exc:  # noqa: BLE001 - any failure is the answer this check exists to give
            failures.append(f"{provider.name}: {failure_class(exc)}")
            continue
        return None
    return Note("lyrics-unreachable", LYRICS_UNREACHABLE, "; ".join(failures))
