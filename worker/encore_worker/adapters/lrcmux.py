"""LRCmux: a multiplexer that fans one lookup out across several lyrics providers.

WHY THIS IS THE PRIMARY PROVIDER NOW: it queries many sources and is the only one that can return WORD-LEVEL
timings. MILLISECONDS, NOT SECONDS — `start`/`end` are integer milliseconds throughout the native response
(`43004`, not `43.004`), so the conversion happens HERE, once, at the boundary. STATUS CODES, MEASURED AGAINST
THE LIVE API rather than read off the spec (which declares only `200` and a default):

    404  {"detail": "no lyrics found"}                          -> a MISS. Ordinary.
    400  {"detail": "provide either ISRC or both artist..."}     -> OUR bug. Never retried.
    anything else                                               -> provider trouble. Retryable.
What each costs when it is got wrong: `docs/arch/05-worker.md` §6.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass

from encore_worker.adapters.ratelimit import RateLimiter
from encore_worker.domain.document import TIMING_LINE, TIMING_WORD, Segment
from encore_worker.domain.lyrics.clean import clean_segments

BASE_URL = "https://api.lrcmux.dev"

USER_AGENT = "encore-worker (karaoke lyrics alignment)"

#: Seconds before a lookup is abandoned, longer than a single provider's because a multiplexer fans out
#: internally (docs/arch/05-worker.md §6.2).
TIMEOUT_SEC = 12.0


#: ONE gate for this service, shared by every client in this process, the budget being per SOURCE IP
#: (docs/arch/05-worker.md §6.2).
_GATE = RateLimiter()


class ProviderUnreachable(RuntimeError):
    """LRCmux could not be reached, or answered in a way that is not about this song. Retryable, and raised
    rather than returned empty so "the provider is down" cannot look like "this song has no lyrics"."""

    retryable = True


class BadRequest(ValueError):
    """We asked for something malformed — a 400 from the API, and not retryable. Should be unreachable:
    `fetch` requires both artist and title, so reaching it means a caller bypassed that check."""

    retryable = False


@dataclass(frozen=True, slots=True)
class Result:
    """A parsed LRCmux answer: the words, how precisely they are timed, and who supplied them."""

    segments: tuple[Segment, ...]
    #: `word`, `line`, or None when nothing is usable. Decides `TextRef.timing`, and so which retry knobs
    #: the search can offer for this text.
    timing: str | None
    #: The upstream provider LRCmux got this from, recorded on the completion facts so a systematically bad
    #: source is identifiable rather than anonymous.
    source: str | None = None
    instrumental: bool = False


class LrcmuxClient:
    """`LyricsProvider` over LRCmux's native endpoint."""

    name = "lrcmux"

    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        timeout_sec: float = TIMEOUT_SEC,
        proxy: str | None = None,
        sources: str | None = None,
        opener: urllib.request.OpenerDirector | None = None,
        gate: RateLimiter | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        # The SHARED module gate by default; injected only by tests, to stay hermetic.
        self._gate = gate or _GATE
        self._timeout = timeout_sec
        self._sources = sources
        # Injectable, and a genuine seam rather than a test hook: a custom SSL context, a client
        # certificate or an auth handler would go here too.
        self._opener = opener if opener is not None else build_opener(proxy)
        #: The last answer's upstream source, for the caller to record; not part of the port.
        self.last_source: str | None = None

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        """Lyrics for this song, or empty when no provider has it."""
        result = self.lookup(artist=artist, track=track, duration_sec=duration_sec)
        self.last_source = result.source
        return result.segments

    def lookup(self, *, artist: str, track: str, duration_sec: float | None) -> Result:
        """The full answer, including the sync level and the upstream source — separate from `fetch` because
        the port promises only segments, and a caller wanting those should not re-parse the payload."""
        if not artist or not track:
            raise BadRequest("lrcmux needs both artist and title")
        body = self._get(
            build_url(
                self._base, artist=artist, track=track, duration_sec=duration_sec, sources=self._sources
            )
        )
        if body is None:
            return Result(segments=(), timing=None)
        return parse_response(body)

    def _get(self, url: str) -> str | None:
        """The response body, None for a 404, or an exception for anything else.

        PACED through the service's shared gate, which also retries a 429/503; the status ladder stays HERE
        because only this module knows a 404 is an ordinary miss (docs/arch/05-worker.md §6.2).
        """
        status, body = self._gate.run(lambda: self._fetch(url))
        if status == 404:
            return None  # "no lyrics found" — an ordinary miss, and the common case
        if status == 400:
            raise BadRequest(f"lrcmux rejected the request: {body}")
        if status != 200:
            raise ProviderUnreachable(f"lrcmux answered {status}: {body}")
        return body

    def _fetch(self, url: str) -> tuple[int, str]:
        """One HTTP attempt as `(status, body)`, so the gate can see a retryable status; a transport failure
        still raises (docs/arch/05-worker.md §6.2)."""
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - https
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                raw: bytes = response.read()
        except urllib.error.HTTPError as failed:
            return failed.code, _detail(failed)
        except (urllib.error.URLError, TimeoutError, OSError) as unreachable:
            raise ProviderUnreachable(f"lrcmux unreachable: {unreachable}") from unreachable
        return 200, raw.decode("utf-8", errors="replace")


def build_opener(proxy: str | None) -> urllib.request.OpenerDirector:
    """An opener that honours a proxy, explicit or from the environment, CONSTRUCTED rather than relying on
    `urlopen`'s cached module-level default (docs/arch/05-worker.md §6.2)."""
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy} if proxy else None)
    return urllib.request.build_opener(handler)


def build_url(
    base: str,
    *,
    artist: str,
    track: str,
    duration_sec: float | None = None,
    sources: str | None = None,
    level: str = "word",
) -> str:
    """The lookup URL. Pure, so the exact query is assertable without a network.

    `level=word` asks for the most precise timing available and FALLS BACK on its own — `strict` is
    deliberately not set, because a line-timed hit is far better than no hit, and the search's own knobs
    handle a line-timed text perfectly well.
    """
    params: dict[str, str] = {"artist": artist, "title": track, "format": "json", "level": level}
    if duration_sec is not None and duration_sec > 0:
        # Integer seconds: the API's parameter is one, and a duration matcher works to a tolerance.
        params["duration"] = str(int(round(duration_sec)))
    if sources:
        params["sources"] = sources
    return f"{base}/get?{urllib.parse.urlencode(params)}"


def parse_response(body: str) -> Result:
    """Segments, sync level and source from a native LRCmux payload.

    Milliseconds become seconds here. A line whose `start` is missing keeps no timing rather than a
    fabricated zero, because a zero start is a real value — it would put the line at the top of the song.
    """
    try:
        payload = json.loads(body)
    except ValueError:
        return Result(segments=(), timing=None)
    if not isinstance(payload, dict):
        return Result(segments=(), timing=None)

    raw_meta = payload.get("meta")
    meta: dict[str, object] = raw_meta if isinstance(raw_meta, dict) else {}
    source = _source_name(meta)
    if meta.get("instrumental") is True:
        # A positive statement that the track has no words. Still "no text" to the caller, and the ASR
        # tier will confirm it by hearing nothing.
        return Result(segments=(), timing=None, source=source, instrumental=True)

    raw_lines = payload.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        return Result(segments=(), timing=None, source=source)

    segments: list[Segment] = []
    for line in raw_lines:
        if not isinstance(line, dict):
            continue
        text = str(line.get("text") or "").strip()
        if not text:
            continue
        segment: dict[str, object] = {"text": text}
        start = _sec(line.get("start"))
        end = _sec(line.get("end"))
        if start is not None:
            segment["start"] = start
        if end is not None:
            segment["end"] = end
        words = _words_of(line)
        if words:
            segment["words"] = words
        segments.append(segment)

    # CLEANED BEFORE THE SYNC LEVEL IS DECIDED, not after. `clean_segments` also filters the per-word
    # list — this is the one provider that supplies `words`, and `measure.timed_words` reads `word`
    # first, so a clean line over a dirty word stream would light a `♪` token on the ball while the
    # screen read the sentence. Cleaning after the `has_words` test would then claim word timing for a
    # line whose word list was nothing but decoration.
    cleaned = clean_segments(segments)

    if not cleaned:
        return Result(segments=(), timing=None, source=source)
    segments = list(cleaned)

    # The DECLARED level is not trusted over the payload: a response tagged `word` whose lines carry no
    # word spans cannot be word-timed, and believing the tag would offer knobs that have nothing to act on.
    declared = meta.get("level") if isinstance(meta.get("level"), str) else None
    has_words = any("words" in s for s in segments)
    has_starts = any("start" in s for s in segments)
    if has_words and declared != "none":
        timing = TIMING_WORD
    elif has_starts:
        timing = TIMING_LINE
    else:
        timing = None
    return Result(segments=tuple(segments), timing=timing, source=source)


def _words_of(line: dict[str, object]) -> tuple[Segment, ...]:
    """Word spans for one line, in the document shape, with times in seconds.

    The `text` key becomes `word`, which is what `measure.timed_words` reads first. Trailing whitespace
    is stripped: the provider uses it to encode word separation, and a span labelled `"Talking "` would
    show up in a smear report with a spurious space.
    """
    raw = line.get("words")
    if not isinstance(raw, list):
        return ()
    out: list[Segment] = []
    for word in raw:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text") or "").strip()
        start = _sec(word.get("start"))
        if not text or start is None:
            continue
        end = _sec(word.get("end"))
        out.append({"word": text, "start": start, "end": end if end is not None else start})
    return tuple(out)


def _sec(value: object) -> float | None:
    """Integer milliseconds to seconds. `bool` excluded — `True` would become 0.001s."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    got = float(value)
    if got != got or got in (float("inf"), float("-inf")):
        return None
    return got / 1000.0


def _source_name(meta: dict[str, object]) -> str | None:
    source = meta.get("source")
    if not isinstance(source, dict):
        return None
    name = source.get("name") or source.get("id")
    return str(name) if name else None


def _detail(failed: urllib.error.HTTPError) -> str:
    """The `detail` out of an RFC7807 problem document, for a message worth reading."""
    try:
        payload = json.loads(failed.read())
    except Exception:  # noqa: BLE001 - a diagnostic must not raise over a diagnostic
        return failed.reason if isinstance(failed.reason, str) else "no detail"
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str):
            return detail
    return "no detail"


def build_provider(
    *,
    enabled: bool = True,
    base_url: str = BASE_URL,
    proxy: str | None = None,
    sources: str | None = None,
) -> LrcmuxClient | None:
    """The provider, or None when disabled."""
    return LrcmuxClient(base_url=base_url, proxy=proxy, sources=sources) if enabled else None
