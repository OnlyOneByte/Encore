"""Identifying a song against MusicBrainz — the PURE half: query building, parsing and ranking.

The HTTP half lives in `adapters/musicbrainz`; everything here is a pure function over a JSON document, so
the ranking policy that took real tuning is testable without a network. WHY NAME AGREEMENT IS REQUIRED RATHER
THAN SCORED: MusicBrainz's `score` is LEXICAL and will return a different song by the same artist with a high
one, where length is corroborating evidence (docs/arch/05-worker.md §6).
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, NamedTuple
from urllib.parse import urlencode

MB_BASE = "https://musicbrainz.org/ws/2"

#: Within this many seconds is `high`, within the wider bound `medium`, beyond it nothing is written. 2s is
#: LRCLIB's own tolerance, so a `high` annotation is by construction good enough for the lookup it feeds.
HIGH_TOLERANCE_SEC = 2.0
MEDIUM_TOLERANCE_SEC = 5.0

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"

#: Unicode dashes MusicBrainz uses in artist names, all of which a human types as "-".
_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
_STRIP_PUNCT = re.compile(r"[^\w\s-]", re.UNICODE)
_COLLAPSE = re.compile(r"\s+")

#: Lucene RESERVES these: an unescaped one turns "Where Is My Mind?" into a syntax error.
_LUCENE_SPECIAL = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')

#: Sorts after every real year, so an undated release loses the year tie-break without being dropped.
_UNDATED_YEAR = 9999


def normalize_for_match(value: str | None) -> str:
    """Fold a name to a comparable form: unicode-normalised, dashes unified, punctuation dropped.

    Compares CONTENT, not typography — a raw comparison would reject a correct match differing only in a
    unicode hyphen.
    """
    if not value:
        return ""
    folded = unicodedata.normalize("NFKC", value).translate(_DASHES).casefold()
    return _COLLAPSE.sub(" ", _STRIP_PUNCT.sub(" ", folded)).strip()


def escape_lucene(value: str) -> str:
    return _LUCENE_SPECIAL.sub(r"\\\1", value)


def build_query(artist: str, track: str) -> str:
    """A field-scoped Lucene query. Quoted so a multi-word title is one phrase, not loose terms."""
    return f'artist:"{escape_lucene(artist)}" AND recording:"{escape_lucene(track)}"'


def search_url(base: str, artist: str, track: str, limit: int = 10) -> str:
    qs = urlencode({"query": build_query(artist, track), "fmt": "json", "limit": str(limit)})
    return f"{base}/recording?{qs}"


@dataclass(frozen=True, slots=True)
class Recording:
    """One search hit, reduced to the fields the ranking reads."""

    mbid: str
    title: str
    artist: str
    duration_sec: float | None
    score: int
    album: str | None = None
    year: int | None = None
    #: The FIRST credited artist alone. Kept beside the joined credit because they do different jobs: the
    #: joined string is PUBLISHED, the primary is what a caller's title-parse guess can be compared against.
    artist_primary: str = ""


@dataclass(frozen=True, slots=True)
class Annotation:
    """A match, good enough to publish."""

    mbid: str
    artist: str
    title: str
    confidence: str
    album: str | None = None
    year: int | None = None

    def as_artifact(self) -> dict[str, Any]:
        """The shape core's `applyAnnotation` accepts.

        ALBUM AND YEAR ARE DELIBERATELY EXCLUDED: they are parsed and used for recording selection but not
        published, since `releases` on a search hit is a partial list and the recording is chosen by
        duration — so a compilation that happens to match the file's length brings its wrong release along.
        A wrong album is worse than a missing one; artist/title/mbid are the payoff and those ARE reliable.
        """
        return {
            "source": "musicbrainz",
            "mbid": self.mbid,
            "artist": self.artist,
            "title": self.title,
            "confidence": self.confidence,
        }


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
    """The EARLIEST dated release, not the first one listed: MusicBrainz does not order `releases`
    meaningfully, and taking [0] can produce a live-tour or karaoke-series compilation instead of the
    original. The earliest date is a decent proxy for what a singer recognises.

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
    """MusicBrainz search JSON to `Recording`s. Tolerates missing fields; skips entries with no id."""
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
    """Confidence from the duration agreement alone, or None when the gap is too wide.

    MusicBrainz's own `score` is lexical and cannot tell a single from an album cut; length can.

    An unknown duration on either side yields `medium`, never `high`: the identification may well be right,
    but nothing has corroborated it, and `high` is the tier that gets treated as fact.
    """
    if expected_sec is None or candidate_sec is None:
        return CONFIDENCE_MEDIUM
    delta = abs(expected_sec - candidate_sec)
    if delta <= HIGH_TOLERANCE_SEC:
        return CONFIDENCE_HIGH
    if delta <= MEDIUM_TOLERANCE_SEC:
        return CONFIDENCE_MEDIUM
    return None


class _Ranked(NamedTuple):
    """One recording that AGREED, carrying the four numbers `pick_best` orders on.

    Named rather than a bare tuple indexed t[0]..t[3] at the sort: every field is a different tie-break and
    the order between them is the whole ranking policy.
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


def pick_best(
    candidates: list[Recording], artist: str, track: str, duration_sec: float | None
) -> Annotation | None:
    """Best recording that AGREES on artist and title, preferring the closest duration.

    ARTIST AGREEMENT MEANS THE PRIMARY, NOT THE WHOLE BILLING, or every song with a guest on it would be
    rejected; a full-credit agreement still WINS the sort. Then closest duration, then EARLIEST release — a
    tie on duration otherwise picks a karaoke-compilation cut — then MusicBrainz's own score. What gets
    PUBLISHED is always the full credit, being the more informative of the two.
    """
    want_artist, want_track = normalize_for_match(artist), normalize_for_match(track)
    if not want_artist or not want_track:
        return None  # nothing confident to match against; the caller keeps its title-parse values

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
    # Keyed on the four numbers alone: a Recording is not orderable, and `sort` is stable so an all-four tie
    # keeps the order MusicBrainz returned.
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
