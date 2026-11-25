"""Attaching singers to lines: which voice sang which lyric.

Pure, so the interesting part — deciding a line's singer from overlapping speaker turns — is testable without
pyannote, a model, or audio. The step's only job is to run the diarizer and hand the turns here.

THE WIRE FIELD IS `part`, an abstract label ("A", "B") assigned by FIRST APPEARANCE, because that is what the
TV reads. ATTRIBUTION IS BEST-EFFORT AND ALL OR NOTHING PER SONG: `None` for a line means "unknown", never
"the first speaker", and a song is attributed only where four song-level checks call it a CONFIDENT DUET.

What the field is for, why the label carries no identity, what those checks stand between, and why pyannote's
phantom speakers are not re-measured here: `docs/arch/04-alignment.md` §11.1.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence

from encore_worker.domain.document import Doc, Segment

#: A line must overlap a turn by at least this fraction of its own duration to be attributed to it.
#: Below it the overlap is incidental — a held note bleeding past a handover, or a breath — and claiming
#: the line for that speaker would flip the colour mid-phrase.
MIN_OVERLAP_FRACTION = 0.5

#: Fewer distinct speakers than this and attribution buys nothing: a solo song labelled "SPEAKER_00"
#: everywhere is noise on the wire and a pointless colour lookup on the TV.
MIN_SPEAKERS = 2

#: The share of the song's lines that must be attributed before any is. Below it too little of the reel
#: is covered to trust the diarizer about the rest. The old worker's value, deliberately conservative: a
#: missed duet is one colour (what every song showed before M15), a false duet is a visibly wrong reel.
MIN_LINE_COVERAGE = 0.6

#: EXACTLY this many parts among the attributed lines, not at most: a third "voice" is far likelier to be
#: over-segmentation of one singer than a trio, and anything else takes the one-colour fallback.
EXACT_PARTS = 2

#: The fraction of the attributed lines the minority part must own. Well below an even split, so a lead
#: with a real second voice passes, but a solo with a few misattributed lines does not.
MIN_MINORITY_SHARE = 0.15


def attribute(doc: Doc, turns: Sequence[Segment]) -> Doc:
    """Return `doc` with a `part` on every line the turns can account for — IF the song is a duet.

    Returns the doc UNCHANGED (the same object) when there is nothing trustworthy to add: one speaker, no
    turns, no timed lines, or a song that fails the confident-duet checks below. Unchanged rather than
    annotated-with-nulls so a consumer can tell "not attributed" from "attributed as unknown", and so a
    solo song carries no extra bytes. Inside an attributed song a line no turn covers carries NO part;
    the TV holds the previous colour, which reads better than a guess.
    """
    speakers = {str(t.get("speaker")) for t in turns if t.get("speaker") is not None}
    if len(speakers) < MIN_SPEAKERS:
        return doc

    lines = doc.get("lines")
    if not isinstance(lines, list) or not lines:
        return doc

    singers: list[str | None] = []
    for line in lines:
        span = _line_span(line) if isinstance(line, Mapping) else None
        singers.append(speaker_for(span, turns) if span is not None else None)

    attributed = [singer for singer in singers if singer is not None]
    if len(attributed) < MIN_LINE_COVERAGE * len(lines):
        return doc  # too little of the reel covered to trust the rest
    counts = Counter(attributed)
    if len(counts) != EXACT_PARTS:
        return doc  # not a duet: one voice after all, or an over-segmented one
    if min(counts.values()) < MIN_MINORITY_SHARE * len(attributed):
        return doc  # lopsided: a near-solo with a few stray lines, not a second singer

    part_of: dict[str, str] = {}
    for singer in attributed:
        part_of.setdefault(singer, chr(ord("A") + len(part_of)))
    return {
        **dict(doc),
        "lines": [
            {**dict(line), "part": part_of[singer]}
            if isinstance(line, Mapping) and singer is not None
            else (dict(line) if isinstance(line, Mapping) else line)
            for line, singer in zip(lines, singers, strict=True)
        ],
    }


def speaker_for(span: tuple[float, float], turns: Sequence[Segment]) -> str | None:
    """The speaker who sang this span, or None when no turn covers enough of it.

    Chooses by GREATEST OVERLAP, not by whoever started first. A line beginning half a second before a
    handover belongs to whoever sang most of it — picking the earlier turn would attribute the whole
    phrase to the voice that only caught its first syllable.
    """
    start, end = span
    duration = end - start
    if duration <= 0:
        return None

    best: str | None = None
    best_overlap = 0.0
    for turn in turns:
        speaker = turn.get("speaker")
        if speaker is None:
            continue
        turn_span = _span_of(turn)
        if turn_span is None:
            continue
        overlap = min(end, turn_span[1]) - max(start, turn_span[0])
        if overlap > best_overlap:
            best, best_overlap = str(speaker), overlap

    if best is None or (best_overlap / duration) < MIN_OVERLAP_FRACTION:
        # Incidental overlap only — a held note across a handover, or a breath. Leaving it unknown beats
        # flipping the colour mid-phrase.
        return None
    return best


def _line_span(line: Segment) -> tuple[float, float] | None:
    """A line's span, preferring its WORDS over its own `start`/`end` fields.

    The words are what the aligner actually measured; some aligners copy the input's line bounds through
    unchanged, so trusting those would attribute against the pre-alignment timing.
    """
    words = line.get("words")
    if isinstance(words, list):
        spans = [s for s in (_span_of(w) for w in words if isinstance(w, Mapping)) if s is not None]
        if spans:
            return min(s for s, _e in spans), max(e for _s, e in spans)
    return _span_of(line)


def _span_of(item: Segment) -> tuple[float, float] | None:
    start = _num(item.get("start"))
    end = _num(item.get("end"))
    if start is None:
        return None
    return start, max(start, end if end is not None else start)


def _num(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    got = float(value)
    if got != got or got in (float("inf"), float("-inf")):
        return None
    return got


def speaker_count(turns: Sequence[Segment]) -> int:
    """How many distinct voices the diarizer found, recorded as `voices` on the align completion facts."""
    return len({str(t.get("speaker")) for t in turns if t.get("speaker") is not None})


def part_count(doc: Doc) -> int:
    """How many parts `attribute` wrote into `doc`, recorded as `voiceParts`: 0 is one colour."""
    lines = doc.get("lines")
    if not isinstance(lines, list):
        return 0
    return len({line.get("part") for line in lines if isinstance(line, Mapping)} - {None})
