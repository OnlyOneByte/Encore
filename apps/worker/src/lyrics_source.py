"""LRCLIB lyrics source (M7-C8 hybrid). Fetch KNOWN, human-authored lyrics from LRCLIB (a free,
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
from dataclasses import dataclass
from typing import Any, Callable

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
    total = int(mm) * 60 + int(ss)
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
    lines = [l.strip() for l in (plain_text or "").splitlines() if l.strip()]
    if not lines:
        return []
    dur = total_duration if (total_duration and total_duration > 0) else float(len(lines))
    step = dur / len(lines)
    return [{"start": round(i * step, 3), "end": round((i + 1) * step, 3), "text": t} for i, t in enumerate(lines)]


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
        isinstance(l, dict) and isinstance(l.get("start"), (int, float)) and bool(l.get("text")) for l in lines
    )


# ── I/O: LRCLIB client (injectable fetcher; real network deferred to the deploy box) ──
@dataclass
class LrclibResult:
    id: int | None
    instrumental: bool
    synced_lyrics: str | None
    plain_lyrics: str | None

    @property
    def has_synced(self) -> bool:
        return bool(self.synced_lyrics and self.synced_lyrics.strip())

    @property
    def has_plain(self) -> bool:
        return bool(self.plain_lyrics and self.plain_lyrics.strip())


# fetcher: (url, headers) -> (status_code, body_text). Injected so tests need no network.
Fetcher = Callable[[str, dict[str, str]], "tuple[int, str]"]


def lrclib_get_url(base: str, artist: str, track: str, duration: float | None = None, album: str | None = None) -> str:
    from urllib.parse import urlencode

    q: dict[str, str] = {"artist_name": artist, "track_name": track}
    if album:
        q["album_name"] = album
    if duration is not None:
        q["duration"] = str(int(round(duration)))  # LRCLIB matches on integer seconds (±2s tolerance)
    return f"{base}/api/get?{urlencode(q)}"


def parse_lrclib_response(d: dict[str, Any]) -> LrclibResult:
    return LrclibResult(
        id=d.get("id") if isinstance(d.get("id"), int) else None,
        instrumental=bool(d.get("instrumental")),
        synced_lyrics=d.get("syncedLyrics") if isinstance(d.get("syncedLyrics"), str) else None,
        plain_lyrics=d.get("plainLyrics") if isinstance(d.get("plainLyrics"), str) else None,
    )


class LrclibClient:
    """Thin LRCLIB /api/get client. get() returns None on a 404 (no match — caller falls back to ASR
    or ships instrumental), raises LyricsFetchError on other non-200s. Decoupled from the network via
    an injected fetcher, so the whole client unit-tests with canned JSON."""

    def __init__(self, fetcher: Fetcher | None = None, base_url: str = LRCLIB_BASE) -> None:
        self._fetch = fetcher or _urllib_fetch
        self._base = base_url

    def get(self, artist: str, track: str, duration: float | None = None, album: str | None = None) -> LrclibResult | None:
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
        return e.code, ""
