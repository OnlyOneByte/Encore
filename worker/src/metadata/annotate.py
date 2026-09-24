"""MusicBrainz ANNOTATION: identify what a downloaded song actually is.

A YouTube title is not metadata: "a-ha - Take On Me (Official Video) [4K Remaster]" has to become
artist "a-ha" and track "Take On Me" before an LRCLIB lookup can match on `artist_name`+`track_name`.
The core's normalizer already guesses this from the title; MusicBrainz is how a guess becomes a
citation, with an MBID and a confidence attached.

NOT a catalog: this runs AFTER a download, when the real title and exact duration are known, and only
ever ANNOTATES a media that already exists.

WHY IT REFUSES. A wrong artist is worse than a missing one: it silently poisons the lyrics query that
consumes it and afterwards is indistinguishable from a correct one. A weak match writes nothing and
says so, leaving the normalizer's values in place.

Three measured facts against the real service shape the logic below: MusicBrainz's own `score` is
lexical and cannot separate a single from an album cut from a 2-minute edit (top matches routinely tie
at 100 with lengths differing by minutes), so DURATION is the discriminator, not score; artist names
can come back with a UNICODE HYPHEN (U+2010) rather than ASCII "-" (hence `normalize_for_match`); and
`length` is MILLISECONDS while a media's durationSec is seconds.

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
from typing import Any, NamedTuple

# The gate and its retry ladder live at the root (src/ratelimit.py) because LRCLIB needs the same one.
# Both names below are USED here: the interval configures this service's gate, and the attempt cap is
# quoted in the exhausted-retries message so the number an operator reads is the one that was enforced.
from ..ratelimit import MAX_ATTEMPTS, MIN_INTERVAL_SEC, RateLimiter

MB_BASE = "https://musicbrainz.org/ws/2"

#: MusicBrainz throttles an "anonymous" User-Agent harder, and stdlib's `Python-urllib` is on that list,
#: so every request sets this in the documented `Application name/<version> ( contact-url )` form.
USER_AGENT = "Encore/0.2 ( https://github.com/OnlyOneByte/Encore )"

#: Within this many seconds is `high`, within the wider bound `medium`, beyond it nothing is written. 2s
#: is LRCLIB's own tolerance, so a `high` annotation is by construction good enough for the lookup.
HIGH_TOLERANCE_SEC = 2.0
MEDIUM_TOLERANCE_SEC = 5.0

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"


class AnnotationFetchError(RuntimeError):
    """A non-404 HTTP failure talking to MusicBrainz (transient -> the caller declines, never fails)."""


#: Unicode dashes MusicBrainz uses in artist names, all of which a human types as "-".
_DASHES = dict.fromkeys(map(ord, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"), "-")
_STRIP_PUNCT = re.compile(r"[^\w\s-]", re.UNICODE)
_COLLAPSE = re.compile(r"\s+")


def normalize_for_match(value: str | None) -> str:
    """Fold a name to a comparable form: unicode-normalised, dashes unified, punctuation dropped.
    Compares CONTENT, not typography (a raw comparison would reject a correct match differing only
    in a unicode hyphen)."""
    if not value:
        return ""
    folded = unicodedata.normalize("NFKC", value).translate(_DASHES).casefold()
    return _COLLAPSE.sub(" ", _STRIP_PUNCT.sub(" ", folded)).strip()


#: Lucene RESERVES these: an unescaped one turns "Where Is My Mind?" into a syntax error.
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


@dataclass
class Recording:
    mbid: str
    title: str
    artist: str
    duration_sec: float | None
    score: int
    album: str | None = None
    year: int | None = None
    #: The FIRST credited artist alone. Kept beside the joined credit because they do different jobs: the
    #: joined string is PUBLISHED, the primary is what a caller's normalizer guess can be compared against.
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
    """Pick the EARLIEST dated release, not the first one listed: MusicBrainz does not order
    `releases` meaningfully, and taking [0] can produce a live-tour or karaoke-series compilation
    instead of the original. The earliest date is a decent proxy for what a singer recognises.

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
                # MILLISECONDS: treating it as seconds fails every match's tolerance.
                duration_sec=(float(length) / 1000.0) if isinstance(length, (int, float)) else None,
                score=int(rec.get("score") or 0),
                album=album,
                year=year,
                artist_primary=_primary_credit(rec),
            )
        )
    return out


def confidence_for(expected_sec: float | None, candidate_sec: float | None) -> str | None:
    """Confidence from the duration agreement alone, or None when the gap is too wide: MusicBrainz's
    own `score` is lexical and cannot tell a single from an album cut, but length can.

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

        ALBUM AND YEAR ARE DELIBERATELY EXCLUDED: they are parsed and used for recording selection but
        not published, since `releases` on a search hit is a partial list and the recording is chosen
        by duration, so a compilation that happens to match the file's length brings its wrong release
        along with it. A wrong album is worse than a missing one; artist/title/mbid are the payoff and
        those ARE reliable.
        """
        return {
            "source": "musicbrainz",
            "mbid": self.mbid,
            "artist": self.artist,
            "title": self.title,
            "confidence": self.confidence,
        }


class _Ranked(NamedTuple):
    """One recording that AGREED, carrying the four numbers `pick_best` orders on.

    Named rather than a bare tuple indexed t[0]..t[3] at the sort: every field below is a different
    tie-break and the order between them is the whole ranking policy.
    """

    #: 0 when the full credit agreed, 1 when only the primary artist did — exact evidence wins.
    credit_rank: int
    #: Rounded, so near-identical lengths TIE and the year decides.
    duration_gap: float
    #: Earliest release first; `_UNDATED_YEAR` sorts an undated release last.
    year: int
    #: NEGATED, because MusicBrainz's own score is better-when-higher and this sorts ascending.
    neg_score: int
    recording: Recording
    confidence: str


#: Sorts after every real year, so an undated release loses the year tie-break without being dropped.
_UNDATED_YEAR = 9999


def pick_best(
    candidates: list[Recording], artist: str, track: str, duration_sec: float | None
) -> Annotation | None:
    """Best recording that AGREES on artist and title, preferring the closest duration.

    Name agreement is required rather than scored: MusicBrainz will happily return a different song by
    the same artist with a high lexical score, and writing that as fact is the failure this refuses.

    ARTIST AGREEMENT MEANS THE PRIMARY, NOT THE WHOLE BILLING: MusicBrainz publishes a collaboration
    as one joined credit ("League of Legends feat. Against the Current") while the caller's key is a
    single primary artist, so comparing only the joined string would reject every song with a guest on
    it. A full-credit agreement is stronger evidence, so it still WINS the sort; it is just no longer
    the price of admission.

    Among genuine agreements the sort is: exact-credit before primary-only, then closest duration,
    then EARLIEST release, then MusicBrainz's own score — the year tie-break exists because duration
    alone can leave several recordings tied and pick a live-tour or karaoke-compilation cut over the
    original.

    What gets PUBLISHED is always the full credit, whichever way the match was made: it is what a
    singer wants to read, and it is the strictly more informative of the two.
    """
    want_artist, want_track = normalize_for_match(artist), normalize_for_match(track)
    if not want_artist or not want_track:
        return None  # nothing confident to match against; the caller keeps the normalizer's values

    agreed: list[_Ranked] = []
    for rec in candidates:
        exact_credit = normalize_for_match(rec.artist) == want_artist
        # Empty for a recording with no credit list, and normalize_for_match("") is "", so no false agree.
        primary_credit = bool(rec.artist_primary) and normalize_for_match(rec.artist_primary) == want_artist
        if not exact_credit and not primary_credit:
            continue
        if normalize_for_match(rec.title) != want_track:
            continue
        confidence = confidence_for(duration_sec, rec.duration_sec)
        if confidence is None:
            continue
        gap = (
            abs(duration_sec - rec.duration_sec)
            if duration_sec is not None and rec.duration_sec is not None
            else float("inf")
        )
        agreed.append(
            _Ranked(
                credit_rank=0 if exact_credit else 1,
                duration_gap=round(gap, 1),
                year=rec.year or _UNDATED_YEAR,
                neg_score=-rec.score,
                recording=rec,
                confidence=confidence,
            )
        )

    if not agreed:
        return None
    # Keyed on the four numbers alone: a Recording is not orderable, and `sort` is stable so an
    # all-four tie keeps the order MusicBrainz returned.
    agreed.sort(key=lambda r: (r.credit_rank, r.duration_gap, r.year, r.neg_score))
    best = agreed[0]
    return Annotation(
        mbid=best.recording.mbid,
        artist=best.recording.artist,
        title=best.recording.title,
        confidence=best.confidence,
        album=best.recording.album,
        year=best.recording.year,
    )


#: MusicBrainz's OWN rate-limit signal, narrower than the gate's generic set: its docs name 503 and
#: nothing else, so a 429 stays a hard `AnnotationFetchError` on the first attempt rather than costing
#: three paced attempts to reach the same decline.
MB_RETRY_STATUSES = frozenset({503})

#: Shared by default: a per-instance limiter lets two clients in one process burst past a per-IP limit.
#: MusicBrainz's own gate, separate from LRCLIB's — the two budgets are independent.
_LIMITER = RateLimiter(MIN_INTERVAL_SEC, retry_statuses=MB_RETRY_STATUSES)


def limiter() -> RateLimiter:
    """The shared gate, for a worker that wants to log how much it has been throttled."""
    return _LIMITER


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
            # Retries exhausted, so the IP is being refused: hammering only lengthens the block.
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
    which case the process-global gate is the only one it could have used.
    """
    lim = getattr(client, "_limiter", None)
    return lim if isinstance(lim, RateLimiter) else limiter()


def annotate_or_reason(
    client: Any, artist: str | None, track: str | None, duration_sec: float | None
) -> tuple[Annotation | None, str | None]:
    """Identify a song, or decline WITH A REASON. NEVER raises for an ordinary failure.

    Returns `(annotation, None)` on a match and `(None, reason)` on every decline. The reason is the
    point of this function over `annotate()`: an IP-level MusicBrainz block and "nothing agreed on the
    names" are the same observable event under `annotate()` (both return None), so the caller cannot
    tell a throttled box from a healthy per-song miss. This separates them by catching
    `AnnotationFetchError` distinctly and reading the throttle counters the gate already keeps.
    """
    if not artist or not track:
        return None, "no artist/title to look up"
    try:
        candidates = client.search(artist, track)
    except AnnotationFetchError as exc:
        # A transport FAULT, not a miss: read the gate so throttling is distinguishable from a slow network.
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
    """Identify a song, or decline. NEVER raises for an ordinary failure: annotation is an enrichment,
    and a process failing because a metadata lookup was down would be absurd.

    NO production caller — `steps/metadata.py` wants the decline reason and so calls
    `annotate_or_reason`. This is the value-only shape the annotation tests drive.
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
