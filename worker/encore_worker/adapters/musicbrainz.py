"""MusicBrainz recording search — the HTTP half. The ranking lives in `domain/metadata`.

DECLINES, NEVER FAILS. An annotation is an improvement on a title parse, so every ordinary failure — a miss,
a throttle, an unreachable service — leaves the parse standing. `annotate_or_reason` returns the reason
alongside, because "nothing agreed on the names" and "this IP is being refused" are the same observable
event otherwise, and an operator needs to tell a throttled box from a healthy per-song miss.

PACED THROUGH THE SHARED GATE. MusicBrainz asks for at most one request per second per IP and enforces it by
blocking. `adapters/ratelimit` already provides that gate for LRCLIB; this takes its own instance, because
the two budgets are independent and sharing one would make a lyrics lookup pay for an annotation.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from encore_worker.adapters.ratelimit import MAX_ATTEMPTS, MIN_INTERVAL_SEC, RateLimiter
from encore_worker.domain.metadata import (
    MB_BASE,
    Annotation,
    Recording,
    parse_recordings,
    pick_best,
    search_url,
)

#: MusicBrainz throttles an "anonymous" User-Agent harder, and stdlib's `Python-urllib` is on that list, so
#: every request sets this in the documented `Application name/<version> ( contact-url )` form.
USER_AGENT = "Encore/0.2 ( https://github.com/OnlyOneByte/Encore )"

#: MusicBrainz's OWN rate-limit signal, narrower than the gate's generic set: its docs name 503 and nothing
#: else, so a 429 stays a hard failure on the first attempt rather than costing three paced attempts to
#: reach the same decline.
MB_RETRY_STATUSES = frozenset({503})

#: MusicBrainz's own gate, separate from LRCLIB's. Module-level so concurrent fetch jobs queue behind each
#: other rather than racing to be blocked.
_GATE = RateLimiter(MIN_INTERVAL_SEC, retry_statuses=MB_RETRY_STATUSES)

Fetcher = Callable[[str, dict[str, str]], "tuple[int, str]"]


class AnnotationFetchError(RuntimeError):
    """A real transport fault talking to MusicBrainz. The caller declines; it never fails a job."""


def gate() -> RateLimiter:
    """The shared gate, so a decline can report how much it was throttled."""
    return _GATE


def _urllib_fetch(url: str, headers: dict[str, str]) -> tuple[int, str]:
    request = urllib.request.Request(url, headers=headers)  # noqa: S310 - https, constructed here
    try:
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        # A status is an ANSWER, not an exception: the caller's ladder decides what 404 and 503 mean.
        return int(exc.code), ""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AnnotationFetchError(f"musicbrainz unreachable: {exc}") from exc


class MusicBrainzClient:
    """Thin recording-search client. Empty list on a miss; raises only on a real transport fault."""

    def __init__(
        self,
        fetcher: Fetcher | None = None,
        base_url: str = MB_BASE,
        *,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self._fetch = fetcher or _urllib_fetch
        self._base = base_url
        self._limiter = rate_limiter or _GATE

    def search(self, artist: str, track: str, limit: int = 10) -> list[Recording]:
        url = search_url(self._base, artist, track, limit)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        status, body = self._limiter.run(lambda: self._fetch(url, headers))
        if status == 404:
            return []
        if status == 503:
            # Retries exhausted, so the IP is being refused: hammering only lengthens the block.
            raise AnnotationFetchError(f"musicbrainz throttled us (503) after {MAX_ATTEMPTS} attempts")
        if status != 200:
            raise AnnotationFetchError(f"musicbrainz returned {status} for {artist} - {track}")
        try:
            return parse_recordings(body)
        except (ValueError, TypeError) as exc:
            raise AnnotationFetchError(f"musicbrainz returned unparseable body: {exc}") from exc


def annotate_or_reason(
    client: Any, artist: str | None, track: str | None, duration_sec: float | None
) -> tuple[Annotation | None, str | None]:
    """Identify a song, or decline WITH A REASON. NEVER raises for an ordinary failure.

    `(annotation, None)` on a match, `(None, reason)` on every decline. The reason is the point: an IP-level
    block and a healthy per-song miss both return None otherwise, so a caller cannot tell a throttled box
    from a song MusicBrainz simply does not have.
    """
    if not artist or not track:
        return None, "no artist/title to look up"
    try:
        candidates = client.search(artist, track)
    except AnnotationFetchError as exc:
        return None, str(exc)
    if not candidates:
        return None, "musicbrainz returned no recordings"
    found = pick_best(candidates, artist, track, duration_sec)
    if found is None:
        return None, f"no recording agreed on artist and title among {len(candidates)} candidates"
    return found, None


def build_client() -> MusicBrainzClient | None:
    """The client, or None when annotation is switched off.

    Mirrors `build_transcriber`/`build_diarizer`: an absent adapter is None rather than a stub that fails
    later, and the annotate step degrades to its title parse.
    """
    import os  # noqa: PLC0415

    if os.environ.get("ENCORE_ANNOTATE", "1").strip() in ("0", "false", "no"):
        return None
    return MusicBrainzClient()
