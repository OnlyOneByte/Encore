"""Placing a text that brought its own timings onto THIS recording's clock.

An LRC written for another master of the same song is *confidently wrong*: its line timings are real,
internally consistent, and offset from the recording in hand. That is the single most direct explanation
for "the lyrics are out of sync", and a forced aligner handed such a text searches the wrong spans and
produces early highlighting that looks deliberate.

TWO THINGS LIVE HERE, and they are not the same:

  * `estimate_shift` — fit an offset (and a gentle scale) from a text's own line starts onto a REFERENCE
    series measured on this audio. Used BEFORE aligning, to point the search at the right place.
  * `residual_against` — after aligning, how far is the text's placed series from where the alignment
    actually put the words? That number is `TimingReport.residual_sec`, and a large one is what makes
    `Knob.RESHIFT` worth spending: the aligned output is a better ruler than the pre-align reference was.

The second is the one the old worker never fed back into a decision.
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
    """An affine placement: `t' = offset + scale * t`.

    `applied` is False for the identity, which is what an abstention and a measured no-op both produce.
    Callers check it before noting anything to an operator, so "we did not move it" and "we could not
    tell" read the same downstream — deliberately, because neither justifies a retry on its own.
    """

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

    Takes starts rather than segments so a caller holding only the previous ALIGNMENT's line starts can
    use it — which is what `Knob.RESHIFT` needs. The aligned output is a better ruler than any
    pre-alignment reference, because it was measured on this recording by the same model that will be
    asked to align again.

    Pairs by ORDER, not by content. Matching lines by their words is tempting and wrong here: the
    reference's wording differs from the sheet's even when both describe the same performance, so a
    content match would drop exactly the lines a shift is measured from. Order is the property two
    renderings of one song genuinely share.

    Offset is the MEDIAN of per-pair differences rather than the mean, because an LRC commonly has one
    or two wildly wrong lines (a chorus marker, a trailing credit) and a mean follows them.
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
    """Tempo ratio between the two series, from their spans.

    Span-based rather than a least-squares fit, because with a handful of noisy points a regression's
    slope is dominated by whichever end has the outlier. A degenerate span (every line at one instant)
    yields 1.0 — there is no tempo to measure.
    """
    own_span = text_starts[-1] - text_starts[0]
    ref_span = ref_starts[-1] - ref_starts[0]
    if own_span <= 0 or ref_span <= 0:
        return 1.0
    return ref_span / own_span


def apply_shift(segments: Sequence[Segment], shift: Shift) -> tuple[Segment, ...]:
    """Re-place every segment's `start`/`end`. Returns copies; the input is never mutated.

    Copies because a `TextRef` is checkpointed and may be replayed: mutating in place would make a
    resumed attempt read timings that were already shifted once, compounding the offset each recovery.
    Clamped at zero — a negative timestamp is not representable on a playhead.
    """
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

    `None` when the question is unanswerable — no timed words, or too few comparable lines — which is
    what `TimingReport.residual_sec = None` means, and why `misplaced` is then False rather than True.
    Treating "cannot tell" as "misplaced" would spend a retry on every ASR text, which has no own
    timings to be misplaced in the first place.

    The MEDIAN again, and signed: the sign tells an operator whether the sheet runs early or late, which
    is the difference between a master with a longer intro and one with a shorter one.
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
    """The start of each line in the aligned document, taken from its FIRST TIMED WORD.

    The line's own `start` field is not trusted here: some aligners copy the input's start through
    unchanged even when they moved the words inside it, which would make the residual read as zero for
    exactly the misplacement this is trying to detect.
    """
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

    WHY THIS IS NEEDED AT ALL. whisperx CROPS THE AUDIO PER SEGMENT, so every segment handed to it must
    carry `start` and `end` — an untimed one raises `KeyError: 'start'` inside the aligner. A plain lyrics
    sheet (LRCLIB's `plainLyrics`, LRCmux at `level=none`) has no timings by definition, so without this
    every plain candidate failed to align, was swallowed by the step's broad `except`, and fell through to
    ASR — silently discarding a real human-written sheet.

    The spans are a PRIOR, not a claim. Alignment refines within each crop, and if the prior is poor the
    resulting coverage says so and the retry knobs act on it. Apportioning by character share rather than
    evenly is the better prior for sung text: a six-word line occupies more of the song than a two-word one.

    Returns the input unchanged when the duration is unknown — inventing spans against a duration nobody
    measured would be worse than letting the aligner refuse.
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
    """Does ANY segment lack a usable start? Then the whole series needs provisional spans.

    All-or-nothing on purpose: whisperx crops per segment, so one untimed segment in an otherwise timed
    series is enough to raise — and mixing measured spans with invented ones would produce a document
    whose timings mean two different things.
    """
    return len(line_spans(segments)) != len(segments)
