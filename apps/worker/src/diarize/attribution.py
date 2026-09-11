"""Turn diarization speaker segments into a `part` label on each lyric line — PURE, and the whole of
the "many layers of checks" the owner asked for (ruling 2026-09-07 20:51Z).

WHAT A `part` IS. A stable, ABSTRACT label — `"A"`, `"B"`, … — for which voice sings a line. Abstract
on purpose: #632's ROADMAP/ARCHITECTURE note keeps the plays table `singer_id`-free, and the render
half only needs "same part → same colour", never a name. It rides a line exactly as
`romanization` does (`lyrics.ts:LyricLine.part?`): display-only, absent when the song is not a
confident duet, and it drives no ball.

THE FALLBACK IS THE DESIGN, NOT AN ERROR PATH. The owner ruled that when diarization is not confident
the song "falls back to a single colour for the whole song — visually identical to today, never a
half-coloured reel". So this module's default answer is NO ATTRIBUTION: it returns the doc's lines
untouched (no `part` key on any line) unless every check below passes. A song with one singer, a song
diarization could not split cleanly, and a song where the parts do not line up with the words all take
the same exit as an undiarized song — one colour, by the absence of the field.

INPUT is UNTRUSTED, like every model output in this worker. A diarizer returns
`[{start, end, speaker}]` floats and a string label; this coerces, drops malformed rows, and never
raises. The lyrics doc is `normalize_lyrics`' shape: `{lines: [{start, end, text, words: [...]}]}`.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

#: A song is only a "duet" worth colouring when at least this share of its sung time is covered by
#: diarization AND the minority part carries at least this share of the attributed lines. Both guard
#: the same failure from opposite ends: a mostly-solo song with one stray mislabelled segment must NOT
#: light up as a duet (that is the "never a half-coloured reel" ruling), and a song diarization split
#: into two speakers that are really one voice must not either. Deliberately conservative — a missed
#: duet is one colour (today's behaviour), a false duet is a visibly wrong reel.
MIN_LINE_COVERAGE = 0.6
#: The minority part must own at least this fraction of the attributed lines. 0.15 ≈ "more than a
#: stray line or two", well below an even split, so a genuine lead/backing duet passes while a solo
#: with a handful of misattributed lines does not.
MIN_MINORITY_SHARE = 0.15
#: Ceiling on how many parts we will colour. Diarization on overlapping sung vocals routinely
#: over-segments into 3–5 phantom speakers; a real duet is two. More than this is treated as "not
#: confident" and takes the single-colour fallback rather than painting a rainbow.
MAX_PARTS = 2


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
    """Return `doc` with a `part` label added to each line IFF the song is a confident duet.

    Does not mutate the input. On any check failing — too few speakers, too little coverage, a lopsided
    split, no usable lines — returns the doc unchanged (no `part` on any line), which the render layer
    reads as one colour: the owner's fallback, reached by absence.

    THE LAYERS OF CHECKS (owner: "multiple layers of checks to see if it is [a duet]"):
      1. Diarization produced ≥ 2 distinct, usable speakers over the vocals — else one voice, no parts.
      2. Attribution covers ≥ MIN_LINE_COVERAGE of the lines — a sparse diarization that only labels a
         few lines is not trustworthy enough to colour the reel.
      3. Exactly 2 parts survive after mapping (MAX_PARTS) — over-segmentation on overlapping sung
         vocals collapses to the fallback rather than a rainbow.
      4. The minority part owns ≥ MIN_MINORITY_SHARE of attributed lines — one stray mislabelled line
         on a solo does not make a duet.
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
    if len(counts) != MAX_PARTS:
        return doc  # layer 3: not exactly two voices — fall back to one colour

    minority = min(counts.values())
    if minority < MIN_MINORITY_SHARE * len(attributed):
        return doc  # layer 4: lopsided — a near-solo, not a duet

    # Confident duet. Assign each speaker a stable ABSTRACT part letter by first appearance, so the
    # label set is {"A", "B"} regardless of the diarizer's internal speaker strings, and re-cooking the
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
