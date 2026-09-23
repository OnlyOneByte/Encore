"""Turn diarization speaker segments into a `part` label on each lyric line — PURE.

A `part` is a stable, ABSTRACT label ("A", "B", …) for which voice sings a line — abstract because the
plays table stays `singer_id`-free and the render half only needs "same part → same colour". Rides a
line like `romanization` does (`lyrics.ts:LyricLine.part?`): display-only, absent when not a confident
duet.

THE FALLBACK IS THE DESIGN: when diarization is not confident, the song falls back to a single colour
for the whole song, visually identical to today — never a half-coloured reel. So the default answer is
NO ATTRIBUTION: lines come back untouched (no `part` key) unless every check below passes.

INPUT is UNTRUSTED like every model output here: a diarizer returns `[{start, end, speaker}]` floats
and a string label; this coerces, drops malformed rows, and never raises. The lyrics doc is
`normalize_lyrics`' shape: `{lines: [{start, end, text, words: [...]}]}`.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

#: Minimum share of sung time diarization must cover to trust it as a duet. Deliberately conservative:
#: a missed duet is one colour (today's behaviour), a false duet is a visibly wrong reel.
MIN_LINE_COVERAGE = 0.6
#: Minimum fraction of attributed lines the minority part must own — well below an even split, so a
#: genuine lead/backing duet passes but a solo with a few misattributed lines does not.
MIN_MINORITY_SHARE = 0.15
#: Required part count for a confident duet — an EXACT count, not a ceiling (checked via `!=`).
#: Diarization on overlapping sung vocals routinely over-segments into 3-5 phantom speakers; anything
#: other than two takes the single-colour fallback rather than painting a rainbow.
EXACT_PARTS = 2


def _clean_segments(raw: Any) -> list[tuple[float, float, str]]:
    """Coerce untrusted diarization output to sorted `(start, end, speaker)` tuples, dropping junk.

    Drops a row missing finite bounds, with end ≤ start, or with a non-string speaker — the same
    defensive posture `normalize_lyrics` takes on aligner output. Sorted by start so the overlap walk
    below is linear."""
    out: list[tuple[float, float, str]] = []
    for row in raw or []:
        if not isinstance(row, dict):
            continue
        start, end = _finite(row.get("start")), _finite(row.get("end"))
        speaker = row.get("speaker")
        if start is None or end is None or end <= start or not isinstance(speaker, str) or not speaker:
            continue
        out.append((start, end, speaker))
    out.sort(key=lambda s: s[0])
    return out


def _finite(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def _line_bounds(line: dict[str, Any]) -> tuple[float, float] | None:
    """A line's [start, end] — its own bounds, else derived from its words. None when unknowable."""
    start, end = _finite(line.get("start")), _finite(line.get("end"))
    words = [w for w in line.get("words") or [] if isinstance(w, dict)]
    if start is None and words:
        start = _finite(words[0].get("start"))
    if end is None and words:
        end = _finite(words[-1].get("end"))
    if start is None or end is None or end <= start:
        return None
    return start, end


def _dominant_speaker(segments: list[tuple[float, float, str]], lo: float, hi: float) -> str | None:
    """Which speaker holds the most OVERLAP with [lo, hi]. None when nothing overlaps.

    Overlap-duration weighted, not segment-count: a line that a diarization segment mostly covers is
    attributed to that speaker even if a second speaker clips its edge, which is the ordinary shape of
    turn-taking around a line boundary."""
    by_speaker: dict[str, float] = {}
    for s_start, s_end, speaker in segments:
        if s_start >= hi:
            break  # segments are sorted; nothing later can overlap
        overlap = min(hi, s_end) - max(lo, s_start)
        if overlap > 0:
            by_speaker[speaker] = by_speaker.get(speaker, 0.0) + overlap
    if not by_speaker:
        return None
    return max(by_speaker, key=lambda k: by_speaker[k])


def attribute_parts(doc: dict[str, Any], diarization: Any) -> dict[str, Any]:
    """Return `doc` with a `part` label added to each line IFF the song is a confident duet. Does not
    mutate the input. Four layers of checks (speaker count, coverage, exact-2 parts, minority share —
    see the inline `# layer N` comments below); any failing returns the doc unchanged, which the render
    layer reads as one colour, the fallback reached by absence.
    """
    lines = doc.get("lines")
    if not isinstance(lines, list) or not lines:
        return doc

    segments = _clean_segments(diarization)
    if len({sp for _s, _e, sp in segments}) < 2:
        return doc  # layer 1: one (or zero) voice — nothing to attribute

    # Map each line to its dominant speaker (or None when no segment overlaps it).
    raw_labels: list[str | None] = []
    for line in lines:
        if not isinstance(line, dict):
            raw_labels.append(None)
            continue
        bounds = _line_bounds(line)
        raw_labels.append(_dominant_speaker(segments, *bounds) if bounds else None)

    attributed = [s for s in raw_labels if s is not None]
    if len(attributed) < MIN_LINE_COVERAGE * len(lines):
        return doc  # layer 2: too little of the reel is covered to trust

    counts = Counter(attributed)
    if len(counts) != EXACT_PARTS:
        return doc  # layer 3: not exactly two voices — fall back to one colour

    minority = min(counts.values())
    if minority < MIN_MINORITY_SHARE * len(attributed):
        return doc  # layer 4: lopsided — a near-solo, not a duet

    # Confident duet. Assign each speaker a stable ABSTRACT part letter by first appearance, so the
    # label set is {"A", "B"} regardless of the diarizer's internal speaker strings, and re-processing the
    # same song yields the same letters.
    order: list[str] = []
    for speaker in attributed:
        if speaker not in order:
            order.append(speaker)
    part_of = {speaker: chr(ord("A") + i) for i, speaker in enumerate(order)}

    new_lines: list[dict[str, Any]] = []
    for line, label in zip(lines, raw_labels, strict=True):
        if isinstance(line, dict) and label is not None:
            new_lines.append({**line, "part": part_of[label]})
        else:
            # An unattributed line inside a confident duet carries NO part rather than a guess; the
            # render layer holds the previous colour, which reads better than a wrong one.
            new_lines.append(line)
    return {**doc, "lines": new_lines}
