"""MusicBrainz ANNOTATION: identify what a downloaded song actually is.

WHAT THIS IS FOR. A YouTube title is not metadata. "a-ha - Take On Me (Official Video) [4K Remaster]"
has to become artist "a-ha" and track "Take On Me" before an LRCLIB lookup can match on
`artist_name` + `track_name`, and before library browse can group by anything a human recognises.
The core's normalizer already guesses this from the title; MusicBrainz is how a guess becomes a
citation, with an MBID and a confidence attached.

NOT a catalog. Search stays yt-dlp: this runs AFTER a download, when the real title and exact duration
are known, and it only ever ANNOTATES a media that already exists. Nothing here decides what a singer
can find or queue.

WHY IT REFUSES. A wrong artist is worse than a missing one: it silently poisons the lyrics query that
consumes it, and afterwards it is indistinguishable from a correct one. So a weak match writes nothing
and says so, leaving the normalizer's values in place -- the same rule the separator backends and
`artistCanonical` already follow.

MEASURED against the real service (2026-09-03), which shaped three decisions:

  * A query for a-ha / "Take On Me" returns 97 recordings, the top THREE all scoring 100, with lengths
    229186ms, 217906ms and 119773ms. MusicBrainz's own `score` is lexical and cannot separate a single
    from an album cut from a 2-minute edit, so DURATION is the discriminator, not score.
  * The artist came back as "a\u2010ha" -- a UNICODE HYPHEN (U+2010), not ASCII "-". Comparing raw
    strings would have missed the correct match on the most famous song in the test set. Hence
    `normalize_for_match`.
  * `length` is MILLISECONDS; a media's durationSec is seconds. Getting that wrong makes every match
    fail the tolerance and look like "MusicBrainz never matches anything".

PURE/IO SPLIT as elsewhere in this worker: query building, normalisation, scoring and picking are pure
and unit-tested against captured responses; only the client touches the network, through an injected
fetcher.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

MB_BASE = "https://musicbrainz.org/ws/2"

#: MusicBrainz asks every client to identify itself in the documented form
#: `Application name/<version> ( contact-url )`, and classifies a missing or generic header as
#: "anonymous". That matters more than politeness: `Python-urllib` -- the header stdlib urllib sends by
#: DEFAULT -- is named on their anonymous list and throttled far harder than an identified client. Every
#: request must therefore set this explicitly.
USER_AGENT = "Encore/0.2 ( https://github.com/OnlyOneByte/Encore )"

#: Their documented limit is one request per second PER SOURCE IP, averaged.
#:
#: Overshooting is not a partial penalty. Quoting the docs: "if your requests are coming in at 4
#: requests per second, we don't honour 25% of them and decline the other 75% - we decline 100% of
#: them, until the rate drops to 1 per second or lower." So a burst does not cost one lookup, it costs
#: every lookup until the box goes quiet -- which is why pacing is global and serialised rather than
#: best-effort per client.
MIN_INTERVAL_SEC = 1.0

#: A 503 is how MusicBrainz says "you are over the limit" (also "we are busy"). Retrying with backoff
#: recovers the annotation instead of silently losing it for that song; bounded so a genuinely blocked
#: box degrades to declining rather than hammering the service it is already annoying.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SEC = 1.0

#: D9. A recording whose length is within this many seconds is a `high` match; within the wider bound
#: it is `medium`; beyond it, nothing is written.
#:
#: 2s is not arbitrary: it is the tolerance LRCLIB itself matches on, so a `high` annotation is by
#: construction good enough for the lookup that consumes it.
HIGH_TOLERANCE_SEC = 2.0
MEDIUM_TOLERANCE_SEC = 5.0

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"


class AnnotationFetchError(RuntimeError):
    """A non-404 HTTP failure talking to MusicBrainz (transient -> the caller declines, never fails)."""


# ── pure: normalisation ───────────────────────────────────────────────────────────
#: Unicode dashes MusicBrainz uses in artist names, all of which a human types as "-".
_DASHES = dict.fromkeys(map(ord, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"), "-")
_STRIP_PUNCT = re.compile(r"[^\w\s-]", re.UNICODE)
_COLLAPSE = re.compile(r"\s+")


def normalize_for_match(value: str | None) -> str:
    """Fold a name to a comparable form: unicode-normalised, dashes unified, punctuation dropped.

    Exists because of a real miss: MusicBrainz returned "a\u2010ha" (U+2010) where the YouTube title
    said "a-ha", so a raw comparison rejected the correct recording. Compares CONTENT, not typography.
    """
    if not value:
        return ""
    folded = unicodedata.normalize("NFKC", value).translate(_DASHES).casefold()
    return _COLLAPSE.sub(" ", _STRIP_PUNCT.sub(" ", folded)).strip()


# ── pure: query building ──────────────────────────────────────────────────────────
#: Lucene reserves these; an unescaped one turns a title like "Where Is My Mind?" into a syntax error.
_LUCENE_SPECIAL = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')


def escape_lucene(value: str) -> str:
    return _LUCENE_SPECIAL.sub(r"\\\1", value)


def build_query(artist: str, track: str) -> str:
    """A field-scoped Lucene query. Quoted so a multi-word title is one phrase, not loose terms."""
    return f'artist:"{escape_lucene(artist)}" AND recording:"{escape_lucene(track)}"'


def search_url(base: str, artist: str, track: str, limit: int = 10) -> str:
    from urllib.parse import urlencode

    qs = urlencode({"query": build_query(artist, track), "fmt": "json", "limit": str(limit)})
    return f"{base}/recording?{qs}"


# ── pure: parsing + matching ──────────────────────────────────────────────────────
@dataclass
class Recording:
    mbid: str
    title: str
    artist: str
    duration_sec: float | None
    score: int
    album: str | None = None
    year: int | None = None
    #: The FIRST credited artist on its own ("League of Legends" out of "League of Legends feat.
    #: Against the Current"). Kept beside the joined credit because they are used for different jobs:
    #: the joined string is what gets PUBLISHED and read on the TV, the primary is what a caller's
    #: normalizer-derived guess can actually be compared against — see pick_best.
    artist_primary: str = ""


def _artist_credit(rec: dict[str, Any]) -> str:
    """Join a credit list into one display artist ("Queen feat. David Bowie")."""
    parts: list[str] = []
    for credit in rec.get("artist-credit") or []:
        if not isinstance(credit, dict):
            continue
        name = credit.get("name") or (credit.get("artist") or {}).get("name")
        if name:
            parts.append(str(name))
        if credit.get("joinphrase"):
            parts.append(str(credit["joinphrase"]))
    return "".join(parts).strip() or ""


def _primary_credit(rec: dict[str, Any]) -> str:
    """The first credited artist alone, with no join phrase and no guests."""
    for credit in rec.get("artist-credit") or []:
        if not isinstance(credit, dict):
            continue
        name = credit.get("name") or (credit.get("artist") or {}).get("name")
        if name:
            return str(name).strip()
    return ""


def _best_release(rec: dict[str, Any]) -> tuple[str | None, int | None]:
    """Pick the EARLIEST dated release, not the first one listed.

    MusicBrainz does not order `releases` meaningfully, and taking [0] produced visibly silly albums for
    real songs: "Take On Me" came back on a 1989 live-tour compilation and "Bohemian Rhapsody" on
    "Artist Karaoke Series: Queen". The earliest date is a decent proxy for the original release, which
    is what a singer recognises and what library browse should group under.

    Undated releases sort last rather than being discarded: an undated original still beats no album.
    """
    dated: list[tuple[int, str | None]] = []
    undated: list[str | None] = []
    for rel in rec.get("releases") or []:
        if not isinstance(rel, dict):
            continue
        title = str(rel["title"]) if rel.get("title") else None
        date = str(rel.get("date") or "")
        if date[:4].isdigit():
            dated.append((int(date[:4]), title))
        else:
            undated.append(title)
    if dated:
        dated.sort(key=lambda t: t[0])
        return (dated[0][1], dated[0][0])
    if undated:
        return (undated[0], None)
    return (None, None)


def parse_recordings(body: str | dict[str, Any]) -> list[Recording]:
    """MusicBrainz search JSON -> Recordings. Tolerates missing fields; skips entries with no id."""
    doc = json.loads(body) if isinstance(body, str) else body
    out: list[Recording] = []
    for rec in doc.get("recordings") or []:
        if not isinstance(rec, dict) or not rec.get("id"):
            continue
        length = rec.get("length")
        album, year = _best_release(rec)
        out.append(
            Recording(
                mbid=str(rec["id"]),
                title=str(rec.get("title") or ""),
                artist=_artist_credit(rec),
                # `length` is MILLISECONDS. Treating it as seconds makes every match fail the
                # tolerance, which looks like "MusicBrainz never matches" rather than a unit bug.
                duration_sec=(float(length) / 1000.0) if isinstance(length, (int, float)) else None,
                score=int(rec.get("score") or 0),
                album=album,
                year=year,
                artist_primary=_primary_credit(rec),
            )
        )
    return out


def confidence_for(expected_sec: float | None, candidate_sec: float | None) -> str | None:
    """Confidence from the duration agreement alone, or None when the gap is too wide.

    Duration carries this because MusicBrainz's own `score` is lexical: measured on a real query, the
    top three recordings all scored 100 while their lengths differed by 110 seconds. Score cannot tell
    a single from an album cut; length can.

    An unknown duration on either side yields `medium`, never `high`: the identification may well be
    right, but nothing has corroborated it, and `high` is the tier that gets treated as fact.
    """
    if expected_sec is None or candidate_sec is None:
        return CONFIDENCE_MEDIUM
    delta = abs(expected_sec - candidate_sec)
    if delta <= HIGH_TOLERANCE_SEC:
        return CONFIDENCE_HIGH
    if delta <= MEDIUM_TOLERANCE_SEC:
        return CONFIDENCE_MEDIUM
    return None


@dataclass
class Annotation:
    mbid: str
    artist: str
    title: str
    confidence: str
    album: str | None = None
    year: int | None = None

    def as_artifact(self) -> dict[str, Any]:
        """The shape the worker reports on completion, mirroring artifacts.separator's provenance.

        ALBUM AND YEAR ARE DELIBERATELY EXCLUDED. They are parsed and used for recording selection, but
        not published, because measured against the real service they are wrong often enough to be
        harmful: "Take On Me" resolved to a 1991 hits compilation and "Bohemian Rhapsody" to an undated
        Newcastle bootleg. The cause is structural rather than a tuning problem — `releases` on a search
        hit is a partial list, and the recording is chosen by duration, so a live cut or a compilation
        that happens to match the file's length brings its own release along with it.

        Getting a trustworthy album needs a second lookup against release-groups filtered to primary
        albums. Until that exists, D4 applies: a wrong album is worse than a missing one, and library
        browse groups by artist anyway. artist/title/mbid are the payoff and those ARE reliable.
        """
        return {
            "source": "musicbrainz",
            "mbid": self.mbid,
            "artist": self.artist,
            "title": self.title,
            "confidence": self.confidence,
        }


def pick_best(
    candidates: list[Recording], artist: str, track: str, duration_sec: float | None
) -> Annotation | None:
    """Best recording that AGREES on artist and title, preferring the closest duration.

    Name agreement is required rather than scored: MusicBrainz will happily return a different song by
    the same artist with a high lexical score, and writing that as fact is the failure this refuses.

    ARTIST AGREEMENT MEANS THE PRIMARY, NOT THE WHOLE BILLING. MusicBrainz publishes a collaboration as
    one joined credit ("League of Legends feat. Against the Current") while the caller's key is a single
    primary artist, so comparing the joined string rejected EVERY song with a guest on it — measured
    live, "Legends Never Die" came back score 100 with the duration matching to the millisecond and was
    still discarded. A full-credit agreement is stronger evidence, so it still WINS the sort; it is just
    no longer the price of admission.

    Among genuine agreements the sort is: exact-credit before primary-only, then closest duration, then
    EARLIEST release, then MusicBrainz's own score. The year tie-break is not cosmetic — measured on real
    queries, duration alone left several recordings tied and picked a 1989 live-tour cut for "Take On
    Me" and an "Artist Karaoke Series" compilation for "Bohemian Rhapsody". Both are legitimate
    recordings of the right song, but the earliest release is the one a singer recognises and the one
    library browse should group under.

    What gets PUBLISHED is always the full credit, whichever way the match was made: "League of Legends
    feat. Against the Current" is what a singer wants to read, and it is the strictly more informative
    of the two.
    """
    want_artist, want_track = normalize_for_match(artist), normalize_for_match(track)
    if not want_artist or not want_track:
        return None  # nothing confident to match against; the caller keeps the normalizer's values

    scored: list[tuple[int, float, int, int, Recording, str]] = []
    for rec in candidates:
        exact_credit = normalize_for_match(rec.artist) == want_artist
        # Fall back to the primary only. `artist_primary` is empty for a recording with no credit list,
        # and normalize_for_match("") is "", so this cannot accidentally agree with a real name.
        primary_credit = bool(rec.artist_primary) and normalize_for_match(rec.artist_primary) == want_artist
        if not exact_credit and not primary_credit:
            continue
        if normalize_for_match(rec.title) != want_track:
            continue
        conf = confidence_for(duration_sec, rec.duration_sec)
        if conf is None:
            continue
        gap = (
            abs(duration_sec - rec.duration_sec)
            if duration_sec is not None and rec.duration_sec is not None
            else float("inf")
        )
        # Round the gap so near-identical lengths genuinely tie and the year can decide, rather than a
        # 40ms difference silently outranking "this is the original release".
        scored.append((0 if exact_credit else 1, round(gap, 1), rec.year or 9999, -rec.score, rec, conf))

    if not scored:
        return None
    scored.sort(key=lambda t: (t[0], t[1], t[2], t[3]))
    *_, best, conf = scored[0]
    return Annotation(
        mbid=best.mbid,
        artist=best.artist,
        title=best.title,
        confidence=conf,
        album=best.album,
        year=best.year,
    )


# ── the rate gate: process-global, serialised ─────────────────────────────────────
class RateLimiter:
    """One gate every MusicBrainz call passes through, one at a time.

    WHY GLOBAL AND SERIALISED, rather than a per-client interval check:

      * The limit is per SOURCE IP, so it is a property of the process, not of a client object. Two
        client instances pacing themselves independently still send two requests in the same second.
      * `ENCORE_WORKER_CONCURRENCY` > 1 means two fetch jobs can reach this concurrently. An unlocked
        "has enough time passed?" check lets both read the same timestamp, both decide yes, and both
        fire -- which is precisely the burst that gets an IP blocked outright.
      * The penalty for overshooting is total (see MIN_INTERVAL_SEC), so the safe default is to queue
        rather than to risk it. At one request per second and one call per download, the cost of
        serialising is invisible.

    The lock is held across the REQUEST as well as the wait. That is deliberate: two requests in flight
    simultaneously is the thing being prevented, so releasing before the call would defeat the point.

    Counters exist because a paced call is indistinguishable from a slow one from the outside, and the
    operator needs to be able to tell "MusicBrainz is throttling us" from "the network is slow".
    """

    def __init__(
        self,
        min_interval: float = MIN_INTERVAL_SEC,
        *,
        now: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        import threading
        import time as _time

        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._now = now or _time.monotonic
        self._sleep = sleep or _time.sleep
        # None, not 0.0: "never called" must be distinguishable from "called at t=0", and 0.0 is falsy.
        # With a real monotonic clock t=0 is merely unlikely rather than impossible, so a truthiness
        # check here would work by luck and skip the very first pacing interval.
        self._last_call: float | None = None
        self.calls = 0
        self.retries = 0
        self.throttled = 0
        self.waited_sec = 0.0

    def _pace(self) -> None:
        if self._last_call is not None:
            elapsed = self._now() - self._last_call
            if elapsed < self._min_interval:
                wait = self._min_interval - elapsed
                self.waited_sec += wait
                self._sleep(wait)
        self._last_call = self._now()

    def run(self, call: Callable[[], tuple[int, str]]) -> tuple[int, str]:
        """Execute one paced request under the gate, retrying a 503 with backoff.

        Retries happen INSIDE the lock so a throttled box does not have every other queued caller pile
        on top of the request that is already being refused.
        """
        with self._lock:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                self._pace()
                self.calls += 1
                status, body = call()
                if status != 503:
                    return status, body
                # 503 = over the limit, or the service is busy. Same remedy either way: wait longer.
                self.throttled += 1
                if attempt == MAX_ATTEMPTS:
                    return status, body
                self.retries += 1
                backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                self.waited_sec += backoff
                self._sleep(backoff)
            return status, body  # unreachable, kept for the type checker's benefit

    def stats(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "retries": self.retries,
            "throttled": self.throttled,
            "waited_sec": round(self.waited_sec, 2),
        }


#: The process-wide gate. Every client shares it by default, which is the whole point -- a per-instance
#: limiter would let two clients in one process burst past a per-IP limit.
_LIMITER = RateLimiter()


def limiter() -> RateLimiter:
    """The shared gate, for a worker that wants to log how much it has been throttled."""
    return _LIMITER


# ── I/O: the client (injectable fetcher; the real network only runs on a worker) ───
Fetcher = Callable[[str, dict[str, str]], "tuple[int, str]"]


class MusicBrainzClient:
    """Thin recording-search client. Declines (None) on a miss; raises only on a real transport fault.

    Every request goes through the process-global RateLimiter, so concurrent fetch jobs queue behind
    each other rather than racing to be blocked. The limiter is injectable purely so tests are
    hermetic -- production always shares one.
    """

    def __init__(
        self,
        fetcher: Fetcher | None = None,
        base_url: str = MB_BASE,
        *,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self._fetch = fetcher or _urllib_fetch
        self._base = base_url
        self._limiter = rate_limiter or _LIMITER

    def search(self, artist: str, track: str, limit: int = 10) -> list[Recording]:
        url = search_url(self._base, artist, track, limit)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        status, body = self._limiter.run(lambda: self._fetch(url, headers))
        if status == 404:
            return []
        if status == 503:
            # Exhausted the retries: the IP is being refused. Declining (via annotate) is right --
            # hammering an endpoint that is already saying no makes the block last longer.
            raise AnnotationFetchError(f"musicbrainz throttled us (503) after {MAX_ATTEMPTS} attempts")
        if status != 200:
            raise AnnotationFetchError(f"musicbrainz returned {status} for {artist} - {track}")
        try:
            return parse_recordings(body)
        except (ValueError, TypeError) as exc:
            raise AnnotationFetchError(f"musicbrainz returned unparseable body: {exc}") from exc


def _limiter_of(client: Any) -> RateLimiter:
    """The gate a client paces through, so a decline can read how much it was throttled.

    A MusicBrainzClient carries its own limiter (`_limiter`); a hand-rolled test double may not, in
    which case the process-global gate is the only one it could have used. Either way this is the
    reader `limiter()`/`RateLimiter.stats()` were written for: the counters at :371-403 record whether a
    silent decline was a throttle or a genuine miss, and nothing read them until here.
    """
    lim = getattr(client, "_limiter", None)
    return lim if isinstance(lim, RateLimiter) else limiter()


def annotate_or_reason(
    client: Any, artist: str | None, track: str | None, duration_sec: float | None
) -> tuple[Annotation | None, str | None]:
    """Identify a song, or decline WITH A REASON. NEVER raises for an ordinary failure.

    Returns `(annotation, None)` on a match and `(None, reason)` on every decline. The reason is the
    point of this function over `annotate()`: an IP-level MusicBrainz block and "nothing agreed on the
    names" are the same observable event -- `annotate()` returns `None` for both -- so the caller cannot
    tell a throttled box (self-sustaining, every lookup declines until the box goes quiet) from a
    healthy per-song miss. This separates them by CATCHING `AnnotationFetchError` distinctly and reading
    the throttle counters the gate already keeps.

    Reasons:
      * no confident artist/title to search with -> "no artist/title to look up"
      * the service is unreachable / throttled / a 5xx (an `AnnotationFetchError`) -> the error text,
        annotated with the gate's `stats()` so "throttled us (503)" carries the observed counters
      * nothing agrees on the names or the closest match is too far off in length -> "no confident match"

    Declining is still never a job failure -- the caller keeps the normalizer's values -- but now the
    decline is legible instead of silent.
    """
    if not artist or not track:
        return None, "no artist/title to look up"
    try:
        candidates = client.search(artist, track)
    except AnnotationFetchError as exc:
        # A transport fault, not a miss: unreachable, a 5xx, or -- the case this issue is about -- an
        # IP-level throttle. Read the gate so an operator can tell throttling from a slow network.
        stats = _limiter_of(client).stats()
        return None, f"lookup failed: {exc} [rate gate: {stats}]"
    except Exception as exc:  # noqa: BLE001 - any other client fault is still a decline, never a failure
        return None, f"lookup failed: {exc}"
    got = pick_best(candidates, artist, track, duration_sec)
    if got is None:
        return None, "no confident match"
    return got, None


def annotate(
    client: Any, artist: str | None, track: str | None, duration_sec: float | None
) -> Annotation | None:
    """Identify a song, or decline. NEVER raises for an ordinary failure.

    Declines when: the caller has no confident artist/title to search with, the service is unreachable,
    nothing agrees on the names, or the closest agreement is too far off in length. Every one of those
    means "keep the normalizer's values", not "fail the job" -- annotation is an enrichment, and a cook
    that failed because a metadata lookup was down would be absurd.

    Kept as the value-only shape for callers that do not need the reason; `annotate_or_reason` is the
    one that also explains a decline.
    """
    got, _reason = annotate_or_reason(client, artist, track, duration_sec)
    return got


def _urllib_fetch(url: str, headers: dict[str, str]) -> tuple[int, str]:
    """Default real fetcher (stdlib urllib -- no new dependency), mirroring the LRCLIB client."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 (fixed https base)
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
