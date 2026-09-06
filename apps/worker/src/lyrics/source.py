"""LRCLIB lyrics source. Fetch KNOWN, human-authored lyrics from LRCLIB (a free,
no-auth synced-lyrics DB built for self-hosted players) so WhisperX only has to ALIGN correct text
to audio — never transcribe sung vocals from scratch (the unreliable ASR path). One fetch yields:
  • syncedLyrics (LRC)  → line-timed lyrics (ships as-is if the aligner is unavailable)
  • the LRC/plain line texts → the segments fed to WhisperX forced-alignment (Stage 3)

PURE parse/shape logic (no network, no ML) is unit-tested with LRC fixtures. The I/O half
(LrclibClient) takes an INJECTABLE fetcher so tests need no network — the real fetch is deferred to
the deploy box (this corp box DNS-sinkholes lrclib.net). Output mirrors whisperx.normalize_lyrics'
artifact shape: {language, lines:[{start,end,text,words:[]}], words:[]} (words empty until aligned).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

LRCLIB_BASE = "https://lrclib.net"
# LRCLIB asks non-browser clients to identify themselves + a contact/link (their docs).
USER_AGENT = "Encore/0.2 (+https://github.com/OnlyOneByte/Encore)"

# A line-level LRC timestamp: [mm:ss], [mm:ss.xx], [mm:ss.xxx], or the [mm:ss:xx] colon variant.
# Anchored per-scan so we can peel MULTIPLE leading stamps off one line ([00:12][00:47]repeat).
_LRC_STAMP_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
_LRC_OFFSET_RE = re.compile(r"\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)


class LyricsFetchError(RuntimeError):
    """A non-404 HTTP failure talking to LRCLIB (transient → caller may retry / fall back)."""


# ── pure: LRC timestamp + parse ────────────────────────────────────────────────────
def _stamp_to_sec(mm: str, ss: str, frac: str | None) -> float:
    """[mm:ss.frac] → seconds. `frac` is read as a decimal fraction of a second, so '5'→0.5,
    '50'→0.50, '500'→0.500 all resolve correctly (no centi-vs-milli ambiguity)."""
    total: float = int(mm) * 60 + int(ss)
    if frac:
        total += float(f"0.{frac}")
    return round(total, 3)


@dataclass
class LrcEntry:
    start: float
    text: str


def parse_lrc(lrc_text: str) -> list[LrcEntry]:
    """Parse LRC text into time-sorted (start, text) entries. Handles multi-timestamp lines,
    the [offset:±ms] tag (spec convention: +ms shifts lyrics EARLIER → subtract; clamped ≥0),
    and skips metadata tags ([ar:], [ti:], [length:], …) and untimed lines. Blank-text stamps are
    kept (they mark a musical gap / line end) — the caller decides whether to drop them."""
    offset_ms = 0
    entries: list[LrcEntry] = []
    for raw in (lrc_text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        off = _LRC_OFFSET_RE.match(line)
        if off:
            try:
                offset_ms = int(off.group(1))
            except ValueError:
                offset_ms = 0
            continue
        # peel every leading [..] timestamp; a metadata tag ([ar:X]) won't match → stamps stays empty
        stamps: list[tuple[str, str, str | None]] = []
        pos = 0
        while (m := _LRC_STAMP_RE.match(line, pos)) is not None:
            stamps.append((m.group(1), m.group(2), m.group(3)))
            pos = m.end()
        if not stamps:
            continue  # metadata tag or plain untimed line → not a synced entry
        text = line[pos:].strip()
        for mm, ss, frac in stamps:
            start = _stamp_to_sec(mm, ss, frac) - offset_ms / 1000.0
            entries.append(LrcEntry(start=round(max(0.0, start), 3), text=text))
    entries.sort(key=lambda e: e.start)
    return entries


# ── pure: entries → alignment segments + line-synced artifact ────────────────────────
def entries_to_segments(
    entries: list[LrcEntry], total_duration: float | None = None, min_line_sec: float = 0.5
) -> list[dict[str, Any]]:
    """Line entries → [{start, end, text}] with each line's end = the NEXT line's start (the last
    line runs to total_duration, or +min_line_sec if unknown). Blank-text entries are dropped but
    still bound the previous line's end. This is the transcript shape WhisperX align() consumes."""
    segs: list[dict[str, Any]] = []
    for i, e in enumerate(entries):
        nxt = entries[i + 1].start if i + 1 < len(entries) else None
        if not e.text:
            continue  # a gap marker — no text to show/align, but it capped the prior line already
        if nxt is not None and nxt > e.start:
            end = nxt
        elif total_duration is not None and total_duration > e.start:
            end = total_duration
        else:
            end = e.start + min_line_sec
        segs.append({"start": round(e.start, 3), "end": round(end, 3), "text": e.text})
    return segs


def plain_lyrics_to_segments(plain_text: str, total_duration: float | None) -> list[dict[str, Any]]:
    """Un-timed plain lyrics → segments with bounds EVENLY distributed across the track, so the
    aligner still has a per-line window to refine. Falls back to 1s/line when duration is unknown."""
    lines = [ln.strip() for ln in (plain_text or "").splitlines() if ln.strip()]
    if not lines:
        return []
    dur = total_duration if (total_duration and total_duration > 0) else float(len(lines))
    step = dur / len(lines)
    return [
        {"start": round(i * step, 3), "end": round((i + 1) * step, 3), "text": t} for i, t in enumerate(lines)
    ]


def line_synced_lyrics(segments: list[dict[str, Any]], language: str | None = None) -> dict[str, Any]:
    """Wrap alignment segments into the artifact shape with EMPTY word arrays — the line-synced
    fallback the TV can render as a whole-line highlight when word-level alignment isn't available."""
    lines = [{"start": s["start"], "end": s["end"], "text": s["text"], "words": []} for s in segments]
    return {"language": language, "lines": lines, "words": []}


def is_line_synced(doc: dict[str, Any]) -> bool:
    """A usable line-synced artifact: ≥1 line with a numeric start + text (word timings NOT required —
    that's the distinction from whisperx.is_valid_lyrics, which demands timed words)."""
    lines = doc.get("lines")
    if not isinstance(lines, list):
        return False
    return any(
        isinstance(ln, dict) and isinstance(ln.get("start"), (int, float)) and bool(ln.get("text"))
        for ln in lines
    )


# ── I/O: LRCLIB client (injectable fetcher; real network deferred to the deploy box) ──
@dataclass
class LrclibResult:
    id: int | None
    instrumental: bool
    synced_lyrics: str | None
    plain_lyrics: str | None
    #: The record's OWN metadata, as LRCLIB has it. Absent from an /api/get response we already know
    #: the query for, but load-bearing for /api/search: with several records under one artist+track
    #: these fields are the only thing distinguishing "Telephone" from "Telephone (feat. Beyoncé)".
    track_name: str | None = None
    artist_name: str | None = None
    album_name: str | None = None
    duration: float | None = None

    @property
    def has_synced(self) -> bool:
        return bool(self.synced_lyrics and self.synced_lyrics.strip())

    @property
    def has_plain(self) -> bool:
        return bool(self.plain_lyrics and self.plain_lyrics.strip())

    @property
    def label(self) -> str:
        """Short human label for logs — which VERSION of the song this record is. The whole point of
        searching a pool is being able to say which one won and which one lost."""
        who = self.artist_name or "?"
        what = self.track_name or "?"
        bits = [f"{who} — {what}"]
        if self.album_name:
            bits.append(self.album_name)
        if self.duration:
            bits.append(f"{int(round(self.duration))}s")
        if self.id is not None:
            bits.append(f"#{self.id}")
        return f"{bits[0]} ({', '.join(bits[1:])})" if len(bits) > 1 else bits[0]


# fetcher: (url, headers) -> (status_code, body_text). Injected so tests need no network.
Fetcher = Callable[[str, dict[str, str]], "tuple[int, str]"]


def lrclib_get_url(
    base: str, artist: str, track: str, duration: float | None = None, album: str | None = None
) -> str:
    from urllib.parse import urlencode

    q: dict[str, str] = {"artist_name": artist, "track_name": track}
    if album:
        q["album_name"] = album
    if duration is not None:
        q["duration"] = str(int(round(duration)))  # LRCLIB matches on integer seconds (±2s tolerance)
    return f"{base}/api/get?{urlencode(q)}"


def lrclib_search_url(base: str, artist: str, track: str) -> str:
    """URL for the SEARCH endpoint, which returns an ARRAY of records rather than /api/get's single
    best guess.

    Deliberately NO duration filter. /api/get takes one and applies a ±2s tolerance, which is exactly
    what hides the problem this function exists to solve: a song with two popular versions has two
    records minutes apart in length, and duration-filtering the query picks one of them by fiat before
    anything has looked at the words. Ranking on duration happens locally, in
    `rank_lrclib_candidates`, where a near-miss can still be considered instead of never being seen.
    """
    from urllib.parse import urlencode

    return f"{base}/api/search?{urlencode({'artist_name': artist, 'track_name': track})}"


def parse_lrclib_response(d: dict[str, Any]) -> LrclibResult:
    dur = d.get("duration")
    return LrclibResult(
        id=d.get("id") if isinstance(d.get("id"), int) else None,
        instrumental=bool(d.get("instrumental")),
        synced_lyrics=d.get("syncedLyrics") if isinstance(d.get("syncedLyrics"), str) else None,
        plain_lyrics=d.get("plainLyrics") if isinstance(d.get("plainLyrics"), str) else None,
        track_name=d.get("trackName") if isinstance(d.get("trackName"), str) else None,
        artist_name=d.get("artistName") if isinstance(d.get("artistName"), str) else None,
        album_name=d.get("albumName") if isinstance(d.get("albumName"), str) else None,
        duration=float(dur) if isinstance(dur, (int, float)) else None,
    )


# ── pure: ranking a pool of candidate versions ────────────────────────────────────
#
# This orders the pool CHEAPLY, before any model runs. It does not attempt to identify the right
# version — it cannot, because the only evidence that settles it is the words actually being sung, and
# that lives in the ASR transcript (see select_by_baselines in lyrics/chain.py). What this buys is a
# sensible order for the case where the transcript cannot decide: ties, an instrumental that
# transcribes to nothing, or a box with no ASR tier at all.

#: How many records from a search are worth carrying forward. Each one costs a token-set comparison,
#: not an alignment, so the cap is about bounding response size and log noise rather than compute.
MAX_VARIANTS = 5

#: A duration gap beyond this is strong evidence of a different recording, but NOT a disqualification:
#: a padded lyric-video upload legitimately runs long, and refusing those is how the correct record
#: gets dropped. It only ever pushes a candidate down the order.
DURATION_TOLERANCE_SEC = 10.0


def _credit_tokens(s: str | None) -> set[str]:
    return {t for t in re.split(r"[^\w']+", (s or "").lower()) if t}


def candidate_sort_key(
    res: LrclibResult, duration: float | None = None, credit: str | None = None
) -> tuple[float, float, float]:
    """Sort key for one candidate — LOWER is better (so it drops straight into `sorted`).

    Three axes, most decisive first:

    1. **Has real lyrics at all.** A record flagged instrumental, or holding neither synced nor plain
       text, is useless regardless of how well its metadata matches.
    2. **Duration proximity** to the audio we actually downloaded. The strongest metadata signal for
       the two-versions case: a guest verse typically adds 10-40 seconds, so the feat. and non-feat
       records are usually far apart in length. Unknown duration on either side scores as the
       tolerance rather than as a mismatch — "cannot tell" must not rank below "known to differ".
    3. **Credit overlap** — how much of the record's own artist string is accounted for by the credit
       we parsed from the upload. This is what lets "Lady Gaga feat. Beyoncé" outrank plain
       "Lady Gaga" when the upload named both. Zero when we have no credit to compare, which leaves
       the earlier axes to decide.
    """
    usable = 0.0 if (not res.instrumental and (res.has_synced or res.has_plain)) else 1.0

    if duration is None or res.duration is None:
        gap = DURATION_TOLERANCE_SEC
    else:
        gap = abs(res.duration - duration)

    want = _credit_tokens(credit)
    overlap = 0.0
    if want:
        have = _credit_tokens(res.artist_name)
        if have:
            overlap = len(want & have) / len(want)

    return (usable, gap, -overlap)


def rank_lrclib_candidates(
    results: list[LrclibResult],
    duration: float | None = None,
    credit: str | None = None,
    limit: int = MAX_VARIANTS,
) -> list[LrclibResult]:
    """Best-first pool, capped at `limit`. Records with no usable lyrics body are dropped outright
    rather than merely ranked last — carrying an instrumental record forward would let it win a
    comparison against a transcript that is itself near-empty."""
    keep = [r for r in results if not r.instrumental and (r.has_synced or r.has_plain)]
    keep.sort(key=lambda r: candidate_sort_key(r, duration, credit))
    return keep[: max(0, limit)]


class LrclibClient:
    """Thin LRCLIB client over /api/get (one best-guess record) and /api/search (every record).

    `get()` returns None on a 404 and `search()` returns [] — a miss in either shape. Both raise
    LyricsFetchError on other non-200s. Decoupled from the network via an injected fetcher, so the
    whole client unit-tests with canned JSON.
    """

    def __init__(self, fetcher: Fetcher | None = None, base_url: str = LRCLIB_BASE) -> None:
        self._fetch = fetcher or _urllib_fetch
        self._base = base_url

    def get(
        self, artist: str, track: str, duration: float | None = None, album: str | None = None
    ) -> LrclibResult | None:
        url = lrclib_get_url(self._base, artist, track, duration, album)
        status, body = self._fetch(url, {"User-Agent": USER_AGENT, "Accept": "application/json"})
        if status == 404:
            return None
        if status != 200:
            raise LyricsFetchError(f"lrclib returned {status} for {artist} — {track}")
        try:
            return parse_lrclib_response(json.loads(body))
        except (ValueError, TypeError) as exc:
            raise LyricsFetchError(f"lrclib returned unparseable body: {exc}") from exc

    def search(self, artist: str, track: str) -> list[LrclibResult]:
        """Every record LRCLIB holds for this artist+track, unranked and unfiltered.

        Returns [] for a 404 or an empty array — both mean "nothing to choose from", and the caller
        falls back exactly as it would for a `get()` miss. A non-list body is treated the same way
        rather than raising: a shape we do not recognise is a miss, not a job failure.

        Raises only on a genuine transport/server error, matching `get()`, so `LrclibSource` can keep
        swallowing that one class in one place.
        """
        url = lrclib_search_url(self._base, artist, track)
        status, body = self._fetch(url, {"User-Agent": USER_AGENT, "Accept": "application/json"})
        if status == 404:
            return []
        if status != 200:
            raise LyricsFetchError(f"lrclib search returned {status} for {artist} — {track}")
        try:
            payload = json.loads(body)
        except (ValueError, TypeError) as exc:
            raise LyricsFetchError(f"lrclib search returned unparseable body: {exc}") from exc
        if not isinstance(payload, list):
            return []
        return [parse_lrclib_response(d) for d in payload if isinstance(d, dict)]


def _urllib_fetch(url: str, headers: dict[str, str]) -> tuple[int, str]:
    """Default real fetcher (stdlib urllib — no new dep). Only runs on the deploy box; this corp box
    DNS-sinkholes lrclib.net so it's never exercised here."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 (fixed https base, not user-controlled scheme)
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # An HTTP status is a legible answer — hand it back so the client's status ladder decides
        # (404 → miss, other non-200 → LyricsFetchError). A body is unavailable on an error response.
        return e.code, ""
    except urllib.error.URLError as e:
        # No HTTP status at all: DNS failure (the corp-box sinkhole this module was built to expose),
        # connection refused, TLS failure, timeout. Left uncaught this escapes to LyricsSource's bare
        # `except Exception` and becomes an ordinary miss — which is precisely how a month of 100%
        # LRCLIB failure masqueraded as "these songs just have no lyrics". Convert it to the one
        # explicit transport class the chain already understands, so it can surface as a note instead.
        raise LyricsFetchError(f"lrclib unreachable: {e.reason}") from e
