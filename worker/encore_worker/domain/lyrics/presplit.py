"""Re-lineating a transcription into lines a room can read.

Whisper emits ~30-second VAD segments, so one "line" of an ASR transcript is four or five lyric lines run
together, and published unsplit the TV shows a paragraph that scrolls past before anyone can sing it. ONLY
AUTO-TRANSCRIBED TEXT IS SPLIT, and SPLIT BEFORE ALIGNING rather than after: docs/arch/04-alignment.md §8.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from encore_worker.domain.document import Segment

#: Above this many characters a line is too long to read on a TV at singing distance. Not a hard cap —
#: `split_segment` only splits where it can do so at a sensible boundary, and a long line with nowhere to
#: break is published intact rather than cut mid-word.
MAX_LINE_CHARS = 42

#: Below this, a fragment is not worth being its own line: a two-word tail reads as a mistake rather than
#: a lyric. A split that would produce one is abandoned in favour of the longer line.
MIN_LINE_CHARS = 8

#: Sentence-ish boundaries, best first. Punctuation beats a conjunction, which beats a bare space.
_STRONG = re.compile(r"(?<=[.!?])\s+")
_MEDIUM = re.compile(r"(?<=[,;:])\s+")
#: Conjunctions a line may break before. Adjacent ones each match, and `_merge_scraps` folds the scrap
#: forward rather than this list enumerating every phrase.
_CONJUNCTIONS = ("because", "cause", "while", "when", "but", "and", "or", "so", "then", "if")
_WEAK = re.compile(r"\s+(?=(?:" + "|".join(_CONJUNCTIONS) + r")\b)", re.IGNORECASE)


def presplit_text(segments: Sequence[Segment]) -> tuple[Segment, ...]:
    """Split every over-long segment, interpolating timings across the pieces.

    Timings are apportioned by CHARACTER COUNT rather than evenly. A segment reading "yeah ... and then
    the whole chorus comes back around" split evenly would give the single word half the duration; by
    character share it gets the fraction of the span its text actually occupies, which is much closer to
    how it was sung.
    """
    out: list[Segment] = []
    for segment in segments:
        out.extend(split_segment(segment))
    return tuple(out)


def split_segment(segment: Segment) -> list[Segment]:
    """One segment into one or more. Returns `[segment]` unchanged when it should not be split."""
    text = str(segment.get("text") or "").strip()
    if len(text) <= MAX_LINE_CHARS:
        return [dict(segment)]

    pieces = _break(text)
    if len(pieces) < 2:
        # Nothing sensible to break on. A long line published intact beats one cut mid-word.
        return [dict(segment)]

    start = _num(segment.get("start"))
    end = _num(segment.get("end"))
    if start is None or end is None or end <= start:
        # No usable span to apportion, so the pieces carry the original's timing unchanged rather than a
        # fabricated one. They still read better than the unsplit blob.
        return [{**dict(segment), "text": piece} for piece in pieces]

    total = sum(len(piece) for piece in pieces) or 1
    span = end - start
    out: list[Segment] = []
    at = start
    for index, piece in enumerate(pieces):
        share = span * (len(piece) / total)
        # The last piece takes the remainder, so rounding cannot leave a gap before the segment's end.
        piece_end = end if index == len(pieces) - 1 else at + share
        out.append({**dict(segment), "text": piece, "start": at, "end": piece_end})
        at = piece_end
    return out


def _break(text: str) -> list[str]:
    """Split `text` at the best available boundary, recursing while pieces remain too long.

    Tried strongest first: a full stop is a better line break than a comma, which is better than a
    conjunction, which is better than a bare space. Stopping at the first level that works keeps a line
    broken where a human would break it rather than wherever the character count ran out.
    """
    for pattern in (_STRONG, _MEDIUM, _WEAK):
        pieces = _merge_scraps([piece.strip() for piece in pattern.split(text) if piece.strip()])
        if len(pieces) > 1 and all(len(piece) >= MIN_LINE_CHARS for piece in pieces):
            return _refine(pieces)
    halves = _split_on_space(text)
    return _refine(halves) if len(halves) > 1 else [text]


def _merge_scraps(pieces: Sequence[str]) -> list[str]:
    """Fold any piece too short to be a line into the FOLLOWING one.

    Merging forward rather than backward keeps a conjunction attached to the clause it introduces, which is
    where a singer would breathe; the LAST piece merges backward, having nothing after it.
    """
    if len(pieces) < 2:
        return list(pieces)
    out: list[str] = []
    carry = ""
    for piece in pieces:
        candidate = f"{carry} {piece}".strip() if carry else piece
        if len(candidate) < MIN_LINE_CHARS:
            carry = candidate
            continue
        out.append(candidate)
        carry = ""
    if carry:
        if out:
            out[-1] = f"{out[-1]} {carry}".strip()
        else:
            out.append(carry)
    return out


def _refine(pieces: Sequence[str]) -> list[str]:
    """Re-split any piece that is still too long, once. Bounded depth, so no runaway recursion."""
    out: list[str] = []
    for piece in pieces:
        if len(piece) <= MAX_LINE_CHARS:
            out.append(piece)
            continue
        halves = _split_on_space(piece)
        out.extend(halves if len(halves) > 1 else [piece])
    return out


def _split_on_space(text: str) -> list[str]:
    """Break at the space nearest the middle, so neither half is a scrap.

    Nearest-the-middle rather than at `MAX_LINE_CHARS`: breaking at the limit leaves a full line and a
    short tail, and the tail reads as a mistake. A balanced pair reads as two lines.
    """
    words = text.split()
    if len(words) < 2:
        return [text]
    target = len(text) / 2
    best_at, best_gap = 1, float("inf")
    running = 0
    for index, word in enumerate(words[:-1]):
        running += len(word) + 1
        gap = abs(running - target)
        if gap < best_gap:
            best_at, best_gap = index + 1, gap
    left = " ".join(words[:best_at]).strip()
    right = " ".join(words[best_at:]).strip()
    if len(left) < MIN_LINE_CHARS or len(right) < MIN_LINE_CHARS:
        return [text]
    return [left, right]


def _num(value: object) -> float | None:
    """A finite float, or None. `bool` excluded: `True` would read as 1.0 seconds."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    got = float(value)
    if got != got or got in (float("inf"), float("-inf")):
        return None
    return got
