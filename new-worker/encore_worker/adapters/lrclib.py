"""LRCLIB: the primary source of real, human-written lyrics.

THE TIER THIS FILLS. Without it the candidate tier holds only the upload's authored caption track, which
most uploads do not have — so nearly every song fell through to the ASR fallback. ASR is a good floor and
a bad ceiling: it hears "hold me closer, Tony Danza" and publishes it with total confidence.

EMPTY AND RAISING MEAN DIFFERENT THINGS, and the distinction is the whole reason this is not a bare
`try: ... except: return ()`. Empty is "this provider does not have this song" — an ordinary miss for an
obscure track. Raising is "this provider could not be reached", which must be visible: the old worker had
LRCLIB fail for a month and it was indistinguishable from a library of instrumentals, because both
produced no text.

NO THIRD-PARTY HTTP CLIENT. `urllib` is in the stdlib and this is one GET with query parameters. Adding
`httpx` or `requests` to a worker whose other dependencies are multi-gigabyte ML wheels buys nothing.

BUT IT BUILDS ITS OWN OPENER, and that is not ceremony. `urllib.request.urlopen` uses a module-level
opener cached on first use, and `build_opener` OMITS `ProxyHandler` entirely when no proxy environment
variable is set at that moment — measured, not assumed. In a resident worker that means a proxy configured
after the first request is silently ignored for the life of the process. A dedicated opener reads the
proxy configuration when the client is built, which is what makes `ENCORE_HTTPS_PROXY` work on a network
that mandates one.

AND THE BASE URL IS CONFIGURABLE, because LRCLIB is open source and self-hostable. A network that cannot
reach the public instance can run its own and point `ENCORE_LRCLIB_URL` at it — which is the clean answer
to an unreachable provider, and better than the fallback ladder having to cover for it on every song.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence

from encore_worker.domain.document import Segment

BASE_URL = "https://lrclib.net/api/get"

#: LRCLIB asks for a descriptive User-Agent and rate-limits anonymous traffic harder. Identifying the
#: client is both polite and in this worker's interest.
USER_AGENT = "encore-worker (https://github.com/encore; karaoke lyrics alignment)"

#: A lookup that has not answered in this long is not going to. The align flow has a fallback ladder
#: behind it, so waiting is strictly worse than moving on to ASR.
TIMEOUT_SEC = 8.0

#: `[mm:ss.xx] lyric text` — the LRC line format. Hundredths are optional; some sheets use thousandths.
_LRC_LINE = re.compile(r"^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$")


class ProviderUnreachable(RuntimeError):
    """LRCLIB could not be reached or answered unusably.

    `retryable = True`: a transient network failure is the common case, and the whole point of raising
    rather than returning empty is that this is a DIFFERENT event from "no lyrics for this song".
    """

    retryable = True


class LrclibClient:
    """`LyricsProvider` over LRCLIB's public API."""

    name = "lrclib"

    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        timeout_sec: float = TIMEOUT_SEC,
        proxy: str | None = None,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        self._base = base_url
        self._timeout = timeout_sec
        # Injectable — see the same note in `adapters/lrcmux.LrcmuxClient.__init__`.
        self._opener = opener if opener is not None else _build_opener(proxy)

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        """Synced lyrics for this song, or empty when LRCLIB does not have it.

        `duration` is sent when known: LRCLIB uses it to disambiguate between a single edit and an album
        version, which is exactly the "right song, wrong master" case that produces confidently misplaced
        lyrics downstream. Sending it is how the provider avoids handing us a sheet for a different cut.
        """
        body = self._get(build_url(self._base, artist=artist, track=track, duration_sec=duration_sec))
        if body is None:
            return ()
        return parse_response(body)

    def _get(self, url: str) -> str | None:
        """The response body, None for a 404, or `ProviderUnreachable` for anything else.

        404 is the ONLY status treated as a miss. A 500 or a timeout is a provider problem and must not
        be silently indistinguishable from a song LRCLIB has never heard of.
        """
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - https
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                raw: bytes = response.read()
        except urllib.error.HTTPError as failed:
            if failed.code == 404:
                return None
            raise ProviderUnreachable(f"lrclib answered {failed.code}") from failed
        except (urllib.error.URLError, TimeoutError, OSError) as unreachable:
            raise ProviderUnreachable(f"lrclib unreachable: {unreachable}") from unreachable
        decoded: str = raw.decode("utf-8", errors="replace")
        return decoded


def _build_opener(proxy: str | None) -> urllib.request.OpenerDirector:
    """An opener that honours a proxy, explicit or from the environment.

    `ProxyHandler(None)` falls back to `getproxies()`, which reads `HTTPS_PROXY`/`https_proxy` and, on
    macOS, the system network settings. Constructing the handler EXPLICITLY is the point: the default
    opener drops it when no proxy is configured at build time, so a process that outlives a configuration
    change would never see the new one.
    """
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy} if proxy else None)
    return urllib.request.build_opener(handler)


def build_url(base: str, *, artist: str, track: str, duration_sec: float | None = None) -> str:
    """The lookup URL. Pure, so the exact query is assertable without a network."""
    params: dict[str, str] = {"artist_name": artist, "track_name": track}
    if duration_sec is not None and duration_sec > 0:
        # Integer seconds: LRCLIB matches within a tolerance, and a fractional value is noise.
        params["duration"] = str(int(round(duration_sec)))
    return f"{base}?{urllib.parse.urlencode(params)}"


def parse_response(body: str) -> tuple[Segment, ...]:
    """Segments from an LRCLIB payload.

    PREFERS `syncedLyrics` OVER `plainLyrics`, and falls back rather than failing. A synced sheet gives
    line timings, which make `Knob.LINE_SYNC` and `Knob.RESHIFT` available; a plain one is still a real
    set of words and force-alignment can time it from scratch. Returning nothing because only the plain
    form existed would throw away a perfectly good candidate.
    """
    try:
        payload = json.loads(body)
    except ValueError:
        return ()
    if not isinstance(payload, dict):
        return ()

    # `instrumental: true` is LRCLIB stating positively that this track has no words. That is a genuine
    # answer and better evidence than an empty lyrics field, but it is still "no text" to the caller —
    # and the ASR tier will confirm it by hearing nothing.
    if payload.get("instrumental") is True:
        return ()

    synced = payload.get("syncedLyrics")
    if isinstance(synced, str) and synced.strip():
        parsed = parse_lrc(synced)
        if parsed:
            return parsed

    plain = payload.get("plainLyrics")
    if isinstance(plain, str) and plain.strip():
        return tuple({"text": line.strip()} for line in plain.splitlines() if line.strip())
    return ()


def parse_lrc(text: str) -> tuple[Segment, ...]:
    """Timed lines from LRC-format lyrics.

    Lines with no timestamp are DROPPED rather than kept untimed: an LRC's untimed lines are metadata
    tags (`[ar:]`, `[by:]`) and section markers, not lyrics, and mixing them in would put a credit line
    on screen mid-song.

    An `end` is interpolated from the NEXT line's start, because LRC carries only starts. The final line
    gets no end at all rather than a guessed one — `measure` treats a missing end as equal to the start,
    which reads as a flash rather than as a fabricated duration.
    """
    timed: list[tuple[float, str]] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        found = _LRC_LINE.match(raw.strip())
        if found is None:
            continue
        minutes, seconds, fraction, body = found.groups()
        if not body.strip():
            continue  # a timestamp with no words: a section marker, not a lyric
        timed.append((_seconds(minutes, seconds, fraction), body.strip()))

    # SORTED, because an LRC is a text file a human edited and its lines are not reliably in order. An
    # out-of-order series would be measured as `out_of_order` and refused as incoherent word timing.
    timed.sort(key=lambda pair: pair[0])

    out: list[Segment] = []
    for index, (start, body) in enumerate(timed):
        segment: dict[str, object] = {"start": start, "text": body}
        if index + 1 < len(timed):
            segment["end"] = timed[index + 1][0]
        out.append(segment)
    return tuple(out)


def _seconds(minutes: str, seconds: str, fraction: str | None) -> float:
    """`mm`, `ss`, and an optional fraction of a second, whose DIGIT COUNT sets its scale.

    `[00:01.5]` is one and a half seconds; `[00:01.50]` is the same; `[00:01.500]` is also the same.
    Treating the digits as hundredths regardless would make a thousandths sheet run 10x fast.
    """
    total = int(minutes) * 60 + int(seconds)
    if not fraction:
        return float(total)
    scaled: float = total + int(fraction) / (10 ** len(fraction))
    return scaled


def build_provider(
    *, enabled: bool = True, base_url: str = BASE_URL, proxy: str | None = None
) -> LrclibClient | None:
    """The provider, or None when disabled.

    One place for the composition root to turn this off. An offline deployment should not spend the
    lookup timeout per song waiting for a host it cannot reach — and the ASR tier covers the gap, which
    is the fallback ladder doing its job rather than a workaround.

    A network that cannot reach the public instance has two better options than disabling it: point
    `base_url` at a self-hosted LRCLIB, or set a proxy that the network permits. Both are ordinary
    configuration; neither is this worker's business to arrange.
    """
    return LrclibClient(base_url=base_url, proxy=proxy) if enabled else None
