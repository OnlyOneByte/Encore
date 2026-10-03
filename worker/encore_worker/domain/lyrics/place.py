"""Placing a text that brought its own timings onto THIS recording's clock.

An LRC written for another master is *confidently wrong*: real, internally consistent timings offset from the
recording in hand. TWO THINGS LIVE HERE: `estimate_shift` fits an offset and a gentle scale onto a REFERENCE
series measured on this audio, BEFORE aligning, and `residual_against` measures afterwards how far the placed
series sits from where the alignment put the words — which is what makes `Knob.RESHIFT` worth spending.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median

from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.measure import line_spans, timed_words

#: Below this, a shift is noise rather than a misplacement, and applying it would jitter a text that was
#: already correct. Also the floor for reporting one.
MIN_SHIFT_SEC = 0.35

#: Fewer paired lines than this and the fit is being drawn through too few points to trust. The
#: estimator ABSTAINS rather than guessing: a wrong shift is worse than none, because it moves a text
#: that was right.
MIN_PAIRS = 3

#: A scale further from 1.0 than this is refused. Two masters of one song differ by a few percent in
#: tempo at most; a larger factor means the pairing is wrong, not that the recording is faster.
MAX_SCALE_DRIFT = 0.15


@dataclass(frozen=True, slots=True)
class Shift:
    """An affine placement: `t' = offset + scale * t`. `applied` is False for the identity, which an
    abstention and a measured no-op both produce — neither justifies a retry on its own."""

    offset_sec: float = 0.0
    scale: float = 1.0
    pairs: int = 0
    applied: bool = False
    why: str = "identity"


def estimate_shift(segments: Sequence[Segment], reference: Sequence[Segment]) -> Shift:
    """Fit the text's own line starts onto a reference series of SEGMENTS measured on this audio."""
    return estimate_shift_from_starts(
        [start for start, _end in line_spans(segments)],
        [start for start, _end in line_spans(reference)],
    )


def estimate_shift_from_starts(text_starts: Sequence[float], ref_starts: Sequence[float]) -> Shift:
    """The core of placement, over two series of line START times.

    Takes starts rather than segments, so a caller holding only the previous ALIGNMENT's line starts can use
    it. Pairs by ORDER and not by content, the reference's wording differing from the sheet's even on one
    performance; the offset is the MEDIAN of per-pair differences, an LRC commonly having one wildly wrong
    line that a mean would follow.
    """
    pairs = min(len(text_starts), len(ref_starts))
    if pairs < MIN_PAIRS:
        return Shift(pairs=pairs, why=f"only {pairs} comparable line(s); need {MIN_PAIRS}")

    text_starts = list(text_starts[:pairs])
    ref_starts = list(ref_starts[:pairs])

    scale = _scale_of(text_starts, ref_starts)
    if abs(scale - 1.0) > MAX_SCALE_DRIFT:
        # A scale this far out means the pairing is wrong. Fall back to offset alone, which is still
        # usually right, rather than abandoning the placement entirely.
        scale = 1.0
    offset = median(ref - scale * own for own, ref in zip(text_starts, ref_starts, strict=True))

    if abs(offset) < MIN_SHIFT_SEC and scale == 1.0:
        return Shift(pairs=pairs, why=f"offset {offset:+.2f}s is within noise")
    return Shift(
        offset_sec=offset,
        scale=scale,
        pairs=pairs,
        applied=True,
        why=f"offset {offset:+.2f}s, scale {scale:.3f} over {pairs} reference line(s)",
    )


def _scale_of(text_starts: Sequence[float], ref_starts: Sequence[float]) -> float:
    """Tempo ratio between the two series, from their spans — not a least-squares fit, whose slope a handful
    of noisy points lets one end dominate. A degenerate span yields 1.0."""
    own_span = text_starts[-1] - text_starts[0]
    ref_span = ref_starts[-1] - ref_starts[0]
    if own_span <= 0 or ref_span <= 0:
        return 1.0
    return ref_span / own_span


def apply_shift(segments: Sequence[Segment], shift: Shift) -> tuple[Segment, ...]:
    """Re-place every segment's `start`/`end`. Returns copies, a `TextRef` being checkpointed: mutating in
    place would compound the offset on every recovery. Clamped at zero."""
    if not shift.applied:
        return tuple(segments)
    moved: list[Segment] = []
    for segment in segments:
        copy = dict(segment)
        for key in ("start", "end"):
            value = segment.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                copy[key] = max(0.0, shift.offset_sec + shift.scale * float(value))
        moved.append(copy)
    return tuple(moved)


def residual_against(doc: Mapping[str, object], segments: Sequence[Segment]) -> float | None:
    """How far the text's own line starts sit from where the alignment actually put the words.

    `None` when the question is unanswerable, which is why `misplaced` is then False: treating "cannot tell"
    as "misplaced" would spend a retry on every ASR text. The MEDIAN again, and SIGNED, so the sign says
    whether the sheet runs early or late.
    """
    aligned = timed_words(doc)
    own_starts = [start for start, _end in line_spans(segments)]
    if not aligned or len(own_starts) < MIN_PAIRS:
        return None

    # First word of the aligned document per line is the comparable anchor; `timed_words` flattens
    # lines, so walk the document's own line starts instead of re-deriving them from word spans.
    aligned_line_starts = _aligned_line_starts(doc)
    pairs = min(len(own_starts), len(aligned_line_starts))
    if pairs < MIN_PAIRS:
        return None
    return median(
        aligned - own for own, aligned in zip(own_starts[:pairs], aligned_line_starts[:pairs], strict=True)
    )


def _aligned_line_starts(doc: Mapping[str, object]) -> list[float]:
    """The start of each line in the aligned document, from its FIRST TIMED WORD: some aligners copy the
    input's start through unchanged, which would make the residual read zero for the very misplacement
    this detects."""
    starts: list[float] = []
    lines = doc.get("lines")
    if not isinstance(lines, Sequence) or isinstance(lines, (str, bytes)):
        return starts
    for line in lines:
        if not isinstance(line, Mapping):
            continue
        words = timed_words({"lines": [line]})
        if words:
            starts.append(min(start for _w, start, _e in words))
    return starts


def spread_over(segments: Sequence[Segment], duration_sec: float) -> tuple[Segment, ...]:
    """Give untimed segments provisional spans covering `duration_sec`, apportioned by character count.

    whisperx CROPS THE AUDIO PER SEGMENT, so an untimed segment raises inside the aligner — and a plain lyrics
    sheet has no timings by definition, so without this every plain candidate fell through to ASR. The spans
    are a PRIOR and not a claim, by character share rather than evenly because a six-word line occupies more
    of the song. Returns the input unchanged when the duration is unknown.
    """
    if duration_sec <= 0 or not segments:
        return tuple(segments)

    lengths = [max(1, len(str(segment.get("text") or "").strip())) for segment in segments]
    total = sum(lengths)
    out: list[Segment] = []
    at = 0.0
    for index, (segment, length) in enumerate(zip(segments, lengths, strict=True)):
        share = duration_sec * (length / total)
        # The last span takes the remainder, so rounding cannot leave the tail of the song uncovered.
        end = duration_sec if index == len(segments) - 1 else at + share
        out.append({**dict(segment), "start": at, "end": end})
        at = end
    return tuple(out)


def needs_spans(segments: Sequence[Segment]) -> bool:
    """Does ANY segment lack a usable start? Then the whole series needs provisional spans — all-or-nothing,
    since mixing measured spans with invented ones means two different things in one document."""
    return len(line_spans(segments)) != len(segments)
