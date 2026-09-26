"""Attaching singers to lines: which voice sang which lyric.

Pure, so the interesting part — deciding a line's singer from overlapping speaker turns — is testable
without pyannote, a model, or audio. The step's only job is to run the diarizer and hand the turns here.

WHAT THIS IS FOR. A duet shown in one colour is a duet nobody can follow. With attribution the TV can
colour a line by singer, which is the difference between a karaoke screen and a transcript.

ATTRIBUTION IS BEST-EFFORT AND SAYS SO. `None` for a line means "unknown", never "the first speaker" —
guessing would colour a line confidently wrong, which is worse than leaving it neutral. A song the
diarizer could not segment comes back entirely unattributed, and the renderer treats that as one voice.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from encore_worker.domain.document import Doc, Segment

#: A line must overlap a turn by at least this fraction of its own duration to be attributed to it.
#: Below it the overlap is incidental — a held note bleeding past a handover, or a breath — and claiming
#: the line for that speaker would flip the colour mid-phrase.
MIN_OVERLAP_FRACTION = 0.5

#: Fewer distinct speakers than this and attribution buys nothing: a solo song labelled "SPEAKER_00"
#: everywhere is noise on the wire and a pointless colour lookup on the TV.
MIN_SPEAKERS = 2


def attribute(doc: Doc, turns: Sequence[Segment]) -> Doc:
    """Return `doc` with a `speaker` on every line the turns can account for.

    Returns the doc UNCHANGED when there is nothing useful to add — one speaker, no turns, or no timed
    lines. Unchanged rather than annotated-with-nulls so a consumer can tell "not attributed" from
    "attributed as unknown", and so a solo song carries no extra bytes.
    """
    speakers = {str(t.get("speaker")) for t in turns if t.get("speaker") is not None}
    if len(speakers) < MIN_SPEAKERS:
        return doc

    lines = doc.get("lines")
    if not isinstance(lines, list):
        return doc

    attributed: list[Segment] = []
    changed = False
    for line in lines:
        if not isinstance(line, Mapping):
            attributed.append(line)
            continue
        span = _line_span(line)
        singer = speaker_for(span, turns) if span is not None else None
        if singer is None:
            attributed.append(dict(line))
            continue
        attributed.append({**dict(line), "speaker": singer})
        changed = True

    if not changed:
        return doc
    return {**dict(doc), "lines": attributed}


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
    """How many distinct voices the diarizer found. Recorded on the completion facts."""
    return len({str(t.get("speaker")) for t in turns if t.get("speaker") is not None})
