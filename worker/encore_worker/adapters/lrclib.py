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

from encore_worker.adapters.ratelimit import RateLimiter
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.clean import clean_segments

BASE_URL = "https://lrclib.net/api/get"

#: LRCLIB asks for a descriptive User-Agent and rate-limits anonymous traffic harder. Identifying the
#: client is both polite and in this worker's interest.
USER_AGENT = "encore-worker (https://github.com/encore; karaoke lyrics alignment)"

#: A lookup that has not answered in this long is not going to. The align flow has a fallback ladder
#: behind it, so waiting is strictly worse than moving on to ASR.
TIMEOUT_SEC = 8.0

#: `[mm:ss.xx]` — one LRC stamp. Hundredths are optional; some sheets use thousandths. Matched REPEATEDLY
#: from the start of a line, because a stamp may be STACKED (review L4): `[00:12.00][01:05.00] same words`
#: is how a sheet says a chorus recurs, and a pattern that took only the first one published the second as
#: the line's opening word.
_LRC_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")

#: An A2 ("enhanced LRC") per-word stamp: `[00:12.00] <00:12.10> hold <00:12.44> me`. The tag PRECEDES the
#: word it times. Angle brackets, so it cannot collide with a line stamp.
_LRC_WORD = re.compile(r"<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>")

#: One A2 run: the onset a `<mm:ss.xx>` tag gave it and the tokens that share it (`_a2_words`). A tag often
#: times a PHRASE rather than a word, and a run with no tokens is a line's trailing tag — the previous run's
#: bound and nothing else. Resolved into claims by `_claims`, once the next onset (or the line's end) is in.
_Run = tuple[float, tuple[str, ...]]

#: An ID3-style metadata tag: `[ar:Adele]`, `[by:someone]`, `[offset:+500]`. A LETTER key, which is what
#: distinguishes it from a stamp (`[01:05.00]` starts with a digit) without a second pass.
_LRC_TAG = re.compile(r"^\[([a-zA-Z]+)\s*:\s*([^\]]*)\]$")


#: ONE gate for this service, shared by every client in this process. Module-level because the budget is
#: per SOURCE IP — a per-client instance would let two clients each pace themselves and still burst
#: together, which is exactly what gets an IP blocked.
_GATE = RateLimiter()


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
        gate: RateLimiter | None = None,
    ) -> None:
        self._base = base_url
        self._timeout = timeout_sec
        # The SHARED module gate: the budget is per source IP, so a per-client gate would let two clients
        # each pace themselves and still burst together. Injected only by tests, to stay hermetic.
        self._gate = gate or _GATE
        # Injectable — see the same note in `adapters/lrcmux.LrcmuxClient.__init__`.
        self._opener = opener if opener is not None else _build_opener(proxy)

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        """Synced lyrics for this song, or empty when LRCLIB does not have it.

        `duration` is sent when known: LRCLIB uses it to disambiguate between a single edit and an album
        version, which is exactly the "right song, wrong master" case that produces confidently misplaced
        lyrics downstream. Sending it is how the provider avoids handing us a sheet for a different cut.

        BUT A DURATION MISS IS RETRIED WITHOUT IT (review L5). LRCLIB matches within ±2 s, and the duration
        this worker measures is the UPLOAD's, not the recording's: a music video with an intro, an outro or
        a spoken skit is minutes longer than the track, so the qualified lookup 404s and the song falls
        through to ASR with a perfectly good human sheet sitting one request away. lrcmux is
        duration-lenient, so this only bites when lrcmux missed too — which is exactly the restricted-network
        case the second provider exists for.

        THE TRADE IS DELIBERATE AND ASYMMETRIC: the unqualified lookup may answer with another cut's sheet,
        whose LINE TIMINGS are then wrong — and wrong line timings are what the claim clock maps, the
        LINE_SYNC gate judges and the lexical lift refuses, i.e. a hazard three shipped gates already read.
        A 404 is no text at all, which no gate can recover. One retry, and only on a 404.
        """
        body = self._get(build_url(self._base, artist=artist, track=track, duration_sec=duration_sec))
        if body is None and duration_sec is not None and duration_sec > 0:
            body = self._get(build_url(self._base, artist=artist, track=track, duration_sec=None))
        if body is None:
            return ()
        return parse_response(body)

    def _get(self, url: str) -> str | None:
        """The response body, None for a 404, or `ProviderUnreachable` for anything else.

        404 is the ONLY status treated as a miss. A 500 or a timeout is a provider problem and must not
        be silently indistinguishable from a song LRCLIB has never heard of.
        """
        status, body = self._gate.run(lambda: self._fetch(url))
        if status == 404:
            return None
        if status != 200:
            raise ProviderUnreachable(f"lrclib answered {status}")
        return body

    def _fetch(self, url: str) -> tuple[int, str]:
        """One HTTP attempt as `(status, body)`, so the gate can see a retryable status.

        An HTTP error is RETURNED rather than raised: the gate decides whether 429/503 deserves another
        attempt, and it cannot decide on an exception. A transport failure still raises — that is not a
        status, and no amount of backoff turns it into one.
        """
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
        return clean_segments([{"text": line} for line in plain.splitlines() if line.strip()])
    return ()


def parse_lrc(text: str) -> tuple[Segment, ...]:
    """Timed lines from LRC-format lyrics, with review L4's four fixes.

    Lines with no timestamp are DROPPED rather than kept untimed: an LRC's untimed lines are metadata
    tags (`[ar:]`, `[by:]`) and section markers, not lyrics, and mixing them in would put a credit line
    on screen mid-song.

    An `end` is interpolated from the NEXT EVENT, because LRC carries only starts. The final line gets no
    end at all rather than a guessed one — `measure` treats a missing end as equal to the start, which
    reads as a flash rather than as a fabricated duration.

    THE FOUR THINGS THIS USED TO GET WRONG (review L4), each of which corrupted the claims a whole wave of
    machinery then trusted:

      1. A TIMESTAMP-ONLY LINE IS THE "VOCALS STOP HERE" MARKER, and it was skipped. That is how a sheet
         writes the end of a verse before an instrumental break, so the previous line's interpolated end
         ran to the next SUNG line instead: measured, one claim window ran 14–40 s across a break and R1's
         claim-envelope correlation fell from 0.87 to 0.27 — the repair ladder's own evidence, poisoned by
         a parser. A boundary now closes the line before it and contributes no line of its own.
      2. STACKED STAMPS were half-read. `[00:12.00][01:05.00] same words` is one line claimed at two
         times; `_LRC_LINE` matched the first stamp and the body then STARTED with `[01:05.00]`, which was
         published as the line's first word. Each stamp now yields its own claim on the same words.
      3. A2 WORD TAGS were published as text. `[00:12.00] <00:12.10> hold <00:12.44> me` came out with the
         angle-bracket stamps inside the lyric; they are now WORD claims, which makes an enhanced sheet a
         word-timed candidate rather than a line-timed one with digits in it. A tag times a RUN of tokens
         (`_claims` apportions it; W5 review r2-correctness-5), and the tags belong to the FIRST of a stacked
         line's stamps alone (W5 review r2-tests-18) — both read below, where each run's bound is known.
      4. `[offset:]` WAS IGNORED. It exists because the sheet was timed against a different master, so
         ignoring it keeps a known, stated error. THE SIGN IS THE SPEC'S: a POSITIVE offset makes the
         lyrics appear SOONER, so it is SUBTRACTED, and the result is clamped at 0 rather than going
         negative (a negative claim start is a claim no clock can map).

    SORTED, because an LRC is a text file a human edited and its lines are not reliably in order — and
    stacked stamps GUARANTEE it is not: `[00:12.00][01:05.00]` emits a 65 s claim before the 13 s one that
    follows it in the file. An out-of-order series would be measured as `out_of_order` and refused as
    incoherent word timing.
    """
    offset_sec = 0.0
    #: `(time, body or None, its A2 runs)` — None is a boundary (fix 1), which closes the line before it and
    #: is not one. The runs stay unresolved until the sort, because a run's end is the NEXT event's start.
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
        # THE A2 TAGS BELONG TO THE FIRST STAMP ONLY (W5 review r2-tests-18). `<mm:ss.xx>` is an ABSOLUTE
        # time, written beside the stamp the author timed, so reading them once per stamp of a STACKED line
        # (fix 2's `[00:10.00][01:05.00] <same words>`) gave the 65 s occurrence the 10 s occurrence's word
        # claims verbatim: word times 55 s before their own line's start, a non-monotone claim stream, and an
        # `out_of_order` reading of the kind the sort above exists to prevent. The later stamps stay
        # LINE-timed, which is honest — nobody timed those words — and shifting the claims by the stamp delta
        # instead would be this parser inventing a tempo for a repeat it never measured.
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
            # THE OFFSET MOVES EVERY EDGE, start and end alike. Shifting only starts left a word ending
            # before the next one began — an `out_of_order` reading manufactured by the fix for fix 4.
            # The runs are resolved into claims HERE, where the LINE's own end is known (`_claims`), in the
            # sheet's pre-offset coordinate.
            closes = events[index + 1][0] if index + 1 < len(events) else None
            words = _claims(runs, closes)
            if words:
                segment["words"] = tuple(_shifted(word, offset_sec) for word in words)
        out.append(segment)
    # An LRC body carries the same decorations a caption does — `♪` filler lines, bracketed section
    # headers, the occasional escaped tag. Cleaned here so every provider publishes the same shape.
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

    A TAG TIMES A RUN, NOT ALWAYS ONE WORD, which is why this returns runs and not claims: `<00:10.10>aaa bbb
    ccc` is one onset for three tokens, and the room they share is only known once the NEXT onset is (see
    `_claims`, which the caller reaches with the line's own end in hand).

    THE LAST WORD IS CLOSED BY THE LINE'S TRAILING TAG when the sheet writes one (W5 review r1-spec-16): the
    standard enhanced-LRC shape ends a line with a final stamp that marks the last word's END —
    `[00:10.00]<00:10.10>w1 <00:10.50>w2 <00:11.00>w3<00:11.80>` — and dropping that run for holding no token
    threw the 11.80 away, leaving the last word of EVERY A2 line with a start and no end. `measure` reads a
    missing end as equal to the start, so each line's last word claim was a zero-width window;
    `cli._inline_words` closes its last word at the cue end for exactly this reason. That tag is carried here
    as a run with NO tokens, which is also what makes it the next run's bound rather than a special case. A
    tag with no word after it and no earlier word to close times nothing and is dropped with its stamp.
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
        # The untagged HEAD run is the line's own stamp — the author timed the line, not its first word.
        runs.append((opens if opens is not None else start, tokens))
    return " ".join(spelled), tuple(runs)


def _claims(runs: Sequence[_Run], line_end: float | None) -> tuple[Segment, ...]:
    """The runs as word claims, each run APPORTIONED across `[its onset, the next onset)`.

    APPORTIONED AND NOT STACKED ON THE ONSET (W5 review r2-correctness-5 / r2-spec-8). Every token after the
    first in a run used to be given the PREVIOUS token's start, and each word's end was the next token's
    start, so every token of a multi-token run but the last read `start == end`: `<00:10.10>aaa bbb ccc`
    published `aaa` and `bbb` 0.000 s wide, and an untagged head run of more than one token did the same from
    the line's stamp. THE TELEVISION LIGHTS THE WORD WITH `start <= pos < end` (`core/src/lib/tv/lyrics.ts`),
    which a zero-width span never satisfies, so those words were claims no consumer could ever use. This is
    the identical defect round 1 fixed in the sibling parser (`cli._inline_words`, W5 review r1-tests-19) and
    the rule is the same one: spread the run by CHARACTER COUNT, because an even split gives a one-letter
    token the same room as a six-letter one (`presplit`'s and `parts._spread`'s measured reason).

    THE LAST RUN CLOSES AT THE LINE'S END, which is the next event's start — the same bound the line itself
    takes, so an A2 line with no trailing tag publishes a last word that lasts until the next line instead of
    a zero-width one (W5 review r1-spec-16). On the sheet's FINAL line there is no next event, `line_end` is
    None and the end stays absent exactly as the line's does.
    """
    out: list[Segment] = []
    for index, (opens, tokens) in enumerate(runs):
        if not tokens:
            continue
        closes = runs[index + 1][0] if index + 1 < len(runs) else line_end
        out.extend(_apportioned(tokens, opens, closes))
    return tuple(out)


def _apportioned(tokens: Sequence[str], low: float, high: float | None) -> list[Segment]:
    """`tokens` across `[low, high]` BY CHARACTER COUNT — one claim each, no zero-width span unless the room
    itself is zero (two tags on the same centisecond, which no clock can separate either).

    `high` is None only for the sheet's LAST line when it ends without a trailing tag: there is no room to
    apportion, so every token of that one run takes the run's onset and carries no end, which is what the
    line itself does there too. `cli._inline_words` never meets this case because a cue always has an end.
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
