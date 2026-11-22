"""LRCLIB: the primary source of real, human-written lyrics.

EMPTY AND RAISING MEAN DIFFERENT THINGS (an ordinary miss against an unreachable provider), there is no
third-party HTTP client, and the base URL is configurable because LRCLIB is self-hostable. The tier this
fills and the provider manners every client here follows: `docs/arch/05-worker.md` §6 and §6.2, which is also
where the LRC parser's four fixes live.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence

from encore_worker.adapters.ratelimit import RateLimiter
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.clean import clean_segments

BASE_URL = "https://lrclib.net/api/get"

#: LRCLIB asks for a descriptive User-Agent and rate-limits anonymous traffic harder
#: (docs/arch/05-worker.md §6.2).
USER_AGENT = "encore-worker (https://github.com/encore; karaoke lyrics alignment)"

#: Seconds before a lookup is abandoned: the ladder behind it makes waiting worse than moving on to ASR.
TIMEOUT_SEC = 8.0

#: `[mm:ss.xx]` — one LRC stamp, matched REPEATEDLY from the start of a line because a stamp may be STACKED
#: (docs/arch/05-worker.md §6.2, fix 2).
_LRC_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")

#: An A2 ("enhanced LRC") per-word stamp: `[00:12.00] <00:12.10> hold <00:12.44> me`. The tag PRECEDES the
#: word it times, in angle brackets so it cannot collide with a line stamp.
_LRC_WORD = re.compile(r"<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>")

#: One A2 run: the onset a `<mm:ss.xx>` tag gave it and the tokens that share it. A run with NO tokens is a
#: line's trailing tag, which is the previous run's bound (docs/arch/05-worker.md §6.2).
_Run = tuple[float, tuple[str, ...]]

#: An ID3-style metadata tag: `[ar:Adele]`, `[offset:+500]`. The LETTER key distinguishes it from a stamp.
_LRC_TAG = re.compile(r"^\[([a-zA-Z]+)\s*:\s*([^\]]*)\]$")


#: ONE gate for this service, shared by every client in this process, the budget being per SOURCE IP
#: (docs/arch/05-worker.md §6.2).
_GATE = RateLimiter()


class ProviderUnreachable(RuntimeError):
    """LRCLIB could not be reached or answered unusably. Retryable, and a DIFFERENT event from "no lyrics
    for this song", which is the whole point of raising rather than returning empty."""

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
        gate: RateLimiter | None = None,
    ) -> None:
        self._base = base_url
        self._timeout = timeout_sec
        # The SHARED module gate; injected only by tests, to stay hermetic.
        self._gate = gate or _GATE
        self._opener = opener if opener is not None else _build_opener(proxy)

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        """Synced lyrics for this song, or empty when LRCLIB does not have it.

        `duration` is sent when known, and A DURATION MISS IS RETRIED WITHOUT IT — once, and only on a 404.
        The trade is deliberate and asymmetric: docs/arch/05-worker.md §6.2, priced in LOG.md, "W7: the
        provider pool is real now".
        """
        body = self._get(build_url(self._base, artist=artist, track=track, duration_sec=duration_sec))
        if body is None and duration_sec is not None and duration_sec > 0:
            body = self._get(build_url(self._base, artist=artist, track=track, duration_sec=None))
        if body is None:
            return ()
        return parse_response(body)

    def _get(self, url: str) -> str | None:
        """The response body, None for a 404 — the ONLY status treated as a miss — and `ProviderUnreachable`
        for anything else (docs/arch/05-worker.md §6.2)."""
        status, body = self._gate.run(lambda: self._fetch(url))
        if status == 404:
            return None
        if status != 200:
            raise ProviderUnreachable(f"lrclib answered {status}")
        return body

    def _fetch(self, url: str) -> tuple[int, str]:
        """One HTTP attempt as `(status, body)`, so the gate can see a retryable status; a transport failure
        still raises (docs/arch/05-worker.md §6.2)."""
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - https
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                raw: bytes = response.read()
        except urllib.error.HTTPError as failed:
            return failed.code, ""
        except (urllib.error.URLError, TimeoutError, OSError) as unreachable:
            raise ProviderUnreachable(f"lrclib unreachable: {unreachable}") from unreachable
        return 200, raw.decode("utf-8", errors="replace")


def _build_opener(proxy: str | None) -> urllib.request.OpenerDirector:
    """An opener that honours a proxy, explicit or from the environment.

    `ProxyHandler(None)` falls back to `getproxies()`, and constructing the handler EXPLICITLY is the point
    (docs/arch/05-worker.md §6.2).
    """
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy} if proxy else None)
    return urllib.request.build_opener(handler)


def build_url(base: str, *, artist: str, track: str, duration_sec: float | None = None) -> str:
    """The lookup URL. Pure, so the exact query is assertable without a network."""
    params: dict[str, str] = {"artist_name": artist, "track_name": track}
    if duration_sec is not None and duration_sec > 0:
        # Integer seconds: LRCLIB matches within a tolerance, so a fraction is noise.
        params["duration"] = str(int(round(duration_sec)))
    return f"{base}?{urllib.parse.urlencode(params)}"


def parse_response(body: str) -> tuple[Segment, ...]:
    """Segments from an LRCLIB payload: PREFERS `syncedLyrics` OVER `plainLyrics` and falls back rather than
    failing (docs/arch/05-worker.md §6.2)."""
    try:
        payload = json.loads(body)
    except ValueError:
        return ()
    if not isinstance(payload, dict):
        return ()

    # `instrumental: true` is better evidence than an empty field, and still "no text" to the caller.
    if payload.get("instrumental") is True:
        return ()

    synced = payload.get("syncedLyrics")
    if isinstance(synced, str) and synced.strip():
        parsed = parse_lrc(synced)
        if parsed:
            return parsed

    plain = payload.get("plainLyrics")
    if isinstance(plain, str) and plain.strip():
        return clean_segments([{"text": line} for line in plain.splitlines() if line.strip()])
    return ()


def parse_lrc(text: str) -> tuple[Segment, ...]:
    """Timed lines from LRC-format lyrics, SORTED, with four parser defects fixed.

    An LRC carries STARTS only, so an end is interpolated from the next event and the last line gets none;
    a line with no timestamp is dropped as metadata. The four fixes and the sort: docs/arch/05-worker.md §6.2.
    """
    offset_sec = 0.0
    #: `(time, body or None, its A2 runs)` — None is a boundary (fix 1), and the runs stay unresolved until
    #: the sort because a run's end is the NEXT event's start.
    events: list[tuple[float, str | None, tuple[_Run, ...]]] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        tag = _LRC_TAG.match(line)
        if tag is not None:
            if tag.group(1).lower() == "offset":
                offset_sec = _offset_seconds(tag.group(2)) or offset_sec
            continue
        stamps: list[float] = []
        at = 0
        while (found := _LRC_STAMP.match(line, at)) is not None:
            stamps.append(_seconds(*found.groups()))
            at = found.end()
        if not stamps:
            continue
        body = line[at:].strip()
        if not body:
            for start in stamps:
                events.append((start, None, ()))  # fix 1: a boundary, not a lyric
            continue
        # THE A2 TAGS BELONG TO THE FIRST STAMP ONLY, `<mm:ss.xx>` being an ABSOLUTE time; the later stamps
        # stay LINE-timed (docs/arch/05-worker.md §6.2).
        line_text, line_runs = _a2_words(body, stamps[0])
        for position, start in enumerate(stamps):
            events.append((start, line_text, line_runs if position == 0 else ()))

    events.sort(key=lambda event: event[0])
    out: list[Segment] = []
    for index, (start, spelled, runs) in enumerate(events):
        if spelled is None:
            continue
        opens = max(0.0, start - offset_sec)
        segment: dict[str, object] = {"start": opens, "text": spelled}
        if index + 1 < len(events):
            segment["end"] = max(opens, events[index + 1][0] - offset_sec)
        if runs:
            # THE OFFSET MOVES EVERY EDGE, so the runs resolve HERE in the pre-offset coordinate, where the
            # LINE's own end is known (docs/arch/05-worker.md §6.2).
            closes = events[index + 1][0] if index + 1 < len(events) else None
            words = _claims(runs, closes)
            if words:
                segment["words"] = tuple(_shifted(word, offset_sec) for word in words)
        out.append(segment)
    # An LRC body carries the same decorations a caption does, cleaned here so every provider matches.
    return clean_segments(out)


def _shifted(word: Segment, offset_sec: float) -> Segment:
    """One word claim with every time edge moved by the sheet's `[offset:]`, clamped at zero."""
    out = dict(word)
    for key in ("start", "end"):
        at = out.get(key)
        if isinstance(at, (int, float)):
            out[key] = max(0.0, float(at) - offset_sec)
    return out


def _a2_words(body: str, start: float) -> tuple[str, tuple[_Run, ...]]:
    """`(the line's words, its A2 runs)` — fix 3. No runs when the line carries no word tags.

    Runs and not claims, because A TAG TIMES A RUN and the room it shares is only known once the NEXT onset
    is; a line's TRAILING TAG is carried as a run with no tokens, which makes it the next run's bound rather
    than a special case (docs/arch/05-worker.md §6.2).
    """
    if _LRC_WORD.search(body) is None:
        return body, ()
    pieces: list[tuple[float | None, str]] = []
    at: float | None = None
    pos = 0
    for found in _LRC_WORD.finditer(body):
        pieces.append((at, body[pos : found.start()]))
        at = _seconds(*found.groups())
        pos = found.end()
    pieces.append((at, body[pos:]))
    runs: list[_Run] = []
    spelled: list[str] = []
    for opens, piece in pieces:
        tokens = tuple(piece.split())
        if not tokens:
            if opens is not None and runs:
                runs.append((opens, ()))  # the trailing tag: a bound and nothing else
            continue
        spelled.extend(tokens)
        # The untagged HEAD run takes the line's own stamp: the author timed the line, not its first word.
        runs.append((opens if opens is not None else start, tokens))
    return " ".join(spelled), tuple(runs)


def _claims(runs: Sequence[_Run], line_end: float | None) -> tuple[Segment, ...]:
    """The runs as word claims, each APPORTIONED across `[its onset, the next onset)` by CHARACTER COUNT and
    never stacked on the onset; THE LAST RUN CLOSES AT THE LINE'S END (docs/arch/05-worker.md §6.2)."""
    out: list[Segment] = []
    for index, (opens, tokens) in enumerate(runs):
        if not tokens:
            continue
        closes = runs[index + 1][0] if index + 1 < len(runs) else line_end
        out.extend(_apportioned(tokens, opens, closes))
    return tuple(out)


def _apportioned(tokens: Sequence[str], low: float, high: float | None) -> list[Segment]:
    """`tokens` across `[low, high]` BY CHARACTER COUNT — one claim each, and no zero-width span unless the
    room itself is zero.

    `high` is None only for the sheet's LAST line without a trailing tag, where there is no room to
    apportion and the line itself carries no end either.
    """
    if high is None:
        return [{"word": token, "start": low} for token in tokens]
    room = max(0.0, high - low)
    total = sum(len(token) for token in tokens) or 1
    out: list[Segment] = []
    at = low
    for position, token in enumerate(tokens):
        closes = high if position == len(tokens) - 1 else at + room * (len(token) / total)
        out.append({"word": token, "start": at, "end": max(at, closes)})
        at = max(at, closes)
    return out


def _offset_seconds(value: str) -> float:
    """`[offset:+500]` in milliseconds as seconds, or 0.0 for anything unparseable."""
    try:
        return int(value.strip().lstrip("+")) / 1000.0
    except ValueError:
        return 0.0


def _seconds(minutes: str, seconds: str, fraction: str | None) -> float:
    """`mm`, `ss`, and an optional fraction of a second, whose DIGIT COUNT sets its scale
    (docs/arch/05-worker.md §6.2)."""
    total = int(minutes) * 60 + int(seconds)
    if not fraction:
        return float(total)
    scaled: float = total + int(fraction) / (10 ** len(fraction))
    return scaled


def build_provider(
    *, enabled: bool = True, base_url: str = BASE_URL, proxy: str | None = None
) -> LrclibClient | None:
    """The provider, or None when disabled — one place for the composition root to turn this off, so an
    offline deployment does not spend the lookup timeout per song.

    A network that cannot reach the public instance has two better options: a self-hosted `base_url`, or a
    proxy the network permits.
    """
    return LrclibClient(base_url=base_url, proxy=proxy) if enabled else None
