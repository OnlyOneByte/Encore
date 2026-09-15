"""The LRC format: parsing a timestamped lyric file and shaping it into segments.

Split out of `lrclib.py`, which held two jobs — this, and the HTTP client that fetches LRC text from
LRCLIB. The format is not LRCLIB's: a `.lrc` file is a format an upload can carry, a caption track can
resemble, and a future provider will also serve. Keeping the parser beside one provider's client made the
file 583 lines and implied the two were one concern.

Nothing here does I/O. `parse_lrc` takes a string, and everything else takes what it returns.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# A line-level LRC timestamp: [mm:ss], [mm:ss.xx], [mm:ss.xxx], or the [mm:ss:xx] colon variant.
# Anchored per-scan so we can peel MULTIPLE leading stamps off one line ([00:12][00:47]repeat).
_LRC_STAMP_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


_LRC_OFFSET_RE = re.compile(r"\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)


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
    #: A second-script rendering of the SAME line, when the LRC interleaves one (a Chinese record
    #: that ships both the characters and the pinyin). None for a single-script line — dual script is
    #: strictly IF-AVAILABLE, never fabricated. Set by ``fold_romanization_entries``.
    romanization: str | None = None


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


# ── pure: fold an interleaved second script into the line it romanizes ──
#
# A Chinese record on LRCLIB (e.g. "Yi Jian Mei") does not carry a romanization FIELD — LRCLIB's API
# has no such field — it ships the pinyin INTERLEAVED in the same syncedLyrics, as a second line under
# the SAME [mm:ss] stamp as the characters it romanizes:
#
#     [00:27.00]真情像草原广阔
#     [00:27.00]zhēn qíng xiàng cǎo yuán guǎng kuò
#
# `parse_lrc` yields these as two entries with an equal `start` (its sort is stable, so the file's own
# order — original first — is preserved). Left alone they become a real line plus a zero-span twin that
# reads as a duplicate. This folds each such same-stamp pair into ONE entry: the CJK/non-Latin member
# stays `text`, its Latin-script twin becomes `romanization`. Deliberately NOT a per-language parser
# (owner ruling): the ONLY discriminator is script (does the line carry non-Latin letters),
# which needs no language table and covers any romanized script, not just Mandarin.
def _is_romanization_of(original: str, other: str) -> bool:
    """`other` reads as a romanization of `original`: `original` carries a non-Latin letter (the script
    being romanized) and `other` is written in the Latin script (letters, but none of them non-Latin).
    Symmetric-stamp pairs that are the SAME script (two Latin lines, two CJK lines) are NOT folded —
    those are repeats or a chorus stamp, not a transliteration, so both stay as their own lines."""
    return _has_non_latin_letter(original) and _is_latin_script(other)


def _has_non_latin_letter(text: str) -> bool:
    """Any cased/letter character outside the Basic-Latin + Latin-1 letter range — i.e. a Han glyph,
    Hangul, Kana, Cyrillic, Greek, Arabic … the script a romanization would transliterate."""
    for ch in text:
        if ch.isalpha() and not _is_latin_char(ch):
            return True
    return False


def _is_latin_script(text: str) -> bool:
    """At least one letter, and EVERY letter is Latin — the shape a romanization has. A line with no
    letters at all (pure punctuation / a stamp echo) is not a romanization."""
    saw_letter = False
    for ch in text:
        if ch.isalpha():
            saw_letter = True
            if not _is_latin_char(ch):
                return False
    return saw_letter


def _is_latin_char(ch: str) -> bool:
    # Basic Latin + Latin-1 Supplement + Latin Extended-A/B cover ASCII and accented pinyin (ā í ǎ ò …).
    return (
        "a" <= ch.lower() <= "z"
        or "\u00c0" <= ch <= "\u024f"  # Latin-1 Supplement + Latin Extended-A/B (accents, tone marks)
    )


def fold_romanization_entries(entries: list[LrcEntry]) -> list[LrcEntry]:
    """Collapse each run of same-stamp entries into one line carrying its romanization, if any.

    Only a CJK/non-Latin line paired with a Latin twin at the identical `start` is folded (see
    `_is_romanization_of`); anything else passes through untouched, so a single-script record — the
    common case — is returned unchanged and no romanization is ever invented. Order-preserving: the
    original member keeps its position in the returned list."""
    out: list[LrcEntry] = []
    i = 0
    n = len(entries)
    while i < n:
        cur = entries[i]
        nxt = entries[i + 1] if i + 1 < n else None
        pairable = (
            nxt is not None
            and nxt.start == cur.start
            and cur.romanization is None
            and nxt.romanization is None
        )
        if pairable and nxt is not None:
            if _is_romanization_of(cur.text, nxt.text):
                out.append(LrcEntry(start=cur.start, text=cur.text, romanization=nxt.text))
                i += 2
                continue
            if _is_romanization_of(nxt.text, cur.text):
                # File shipped romanization FIRST — keep the original as `text`, its position aside.
                out.append(LrcEntry(start=nxt.start, text=nxt.text, romanization=cur.text))
                i += 2
                continue
        out.append(cur)
        i += 1
    return out


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
        seg: dict[str, Any] = {"start": round(e.start, 3), "end": round(end, 3), "text": e.text}
        if e.romanization:
            seg["romanization"] = e.romanization
        segs.append(seg)
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
    lines: list[dict[str, Any]] = []
    for seg in segments:
        line: dict[str, Any] = {"start": seg["start"], "end": seg["end"], "text": seg["text"], "words": []}
        if seg.get("romanization"):
            line["romanization"] = seg["romanization"]
        lines.append(line)
    return {"language": language, "lines": lines, "words": []}
