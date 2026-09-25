"""Measuring an aligned document against the audio it claims to describe.

This is what turns an alignment into a `TimingReport`, and therefore what every retry decision is
actually based on. Pure: a document in, a measurement out, no audio touched — the durations come from
the timings themselves and the one number that must come from elsewhere is `duration_sec`.

THE DOCUMENT SHAPE is the core's contract, not ours:

    {"language": "en",
     "lines": [{"text": "hello world",
                "start": 0.0, "end": 1.2,
                "words": [{"word": "hello", "start": 0.0, "end": 0.5}, ...]}]}

Read defensively throughout. The aligner is a third-party model wrapper, so a line with no `words`, a
word with a null `start`, or an `end` before its `start` are all things that have to be survivable — a
measurement that raises on malformed input would turn a recoverable bad alignment into a failed job.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from encore_worker.domain.document import Doc, Segment
from encore_worker.domain.lyrics.report import (
    LONG_GAP_SEC,
    MAX_WORD_SEC,
    MIN_WORD_SEC,
    TimingReport,
)


def _num(value: object) -> float | None:
    """A finite float, or None. `bool` is excluded: `True` would read as 1.0 seconds."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    got = float(value)
    # NaN and infinity both survive float() and then poison every comparison downstream.
    if got != got or got in (float("inf"), float("-inf")):
        return None
    return got


def timed_words(doc: Doc) -> list[tuple[str, float, float]]:
    """Every word with a usable span, in document order, as (word, start, end).

    Skips a word with no timing, and CLAMPS an end that precedes its start to the start rather than
    dropping the word: the token was still sung, and dropping it would understate coverage and hide the
    defect. A zero-length span then shows up as a flash, which is what it looks like on screen.
    """
    out: list[tuple[str, float, float]] = []
    for line in _lines(doc):
        for word in _words(line):
            start = _num(word.get("start"))
            end = _num(word.get("end"))
            if start is None:
                continue
            text = word.get("word") or word.get("text") or ""
            out.append((str(text), start, max(start, end if end is not None else start)))
    return out


def _lines(doc: Doc) -> Iterable[Segment]:
    lines = doc.get("lines")
    if not isinstance(lines, Sequence) or isinstance(lines, (str, bytes)):
        return ()
    return [line for line in lines if isinstance(line, Mapping)]


def _words(line: Segment) -> Iterable[Segment]:
    words = line.get("words")
    if not isinstance(words, Sequence) or isinstance(words, (str, bytes)):
        return ()
    return [word for word in words if isinstance(word, Mapping)]


def line_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """(start, end) for each segment that has a usable start. For line-timed texts and references."""
    spans: list[tuple[float, float]] = []
    for segment in segments:
        start = _num(segment.get("start"))
        if start is None:
            continue
        end = _num(segment.get("end"))
        spans.append((start, max(start, end if end is not None else start)))
    return spans


def measure(doc: Doc, *, duration_sec: float, residual_sec: float | None = None) -> TimingReport:
    """Measure one aligned document.

    `duration_sec` comes from the audio, and every fraction is relative to it. A non-positive duration
    means we do not know how long the recording is: coverage and overshoot are then unanswerable, so
    they are reported as 0 rather than guessed, and `TimingReport.overshoots` returns False by
    construction. Reporting an unknown as a defect would retry on a measurement nobody made.

    `residual_sec` is passed in rather than computed here: it is a comparison between this document and
    a reference series, which is `place.residual_against`'s job.
    """
    words = timed_words(doc)
    if not words:
        return TimingReport(
            words=0, coverage=0.0, duration_sec=max(0.0, duration_sec), residual_sec=residual_sec
        )

    starts = [start for _w, start, _e in words]
    last_end = max(end for _w, _s, end in words)

    # ORDER is judged on starts alone. An overlapping end is ordinary — singers slur, and the aligner
    # emits overlapping spans for a held note — whereas a start that moves backwards makes the highlight
    # jump, which is the one defect that cannot be shown to a room.
    out_of_order = sum(1 for prev, nxt in zip(starts, starts[1:], strict=False) if nxt < prev)

    coverage = 0.0
    overshoot = 0.0
    if duration_sec > 0:
        coverage = min(1.0, max(0.0, last_end / duration_sec))
        overshoot = max(0.0, last_end - duration_sec)

    return TimingReport(
        words=len(words),
        coverage=coverage,
        overshoot_sec=overshoot,
        out_of_order=out_of_order,
        residual_sec=residual_sec,
        long_gaps=tuple(_gaps(words)),
        smeared=tuple(_smeared(words)),
        flashed=tuple(_flashed(words)),
        duration_sec=max(0.0, duration_sec),
    )


def _gaps(words: Sequence[tuple[str, float, float]]) -> list[tuple[float, float]]:
    """Silences between consecutive words longer than `LONG_GAP_SEC`.

    Measured from one word's END to the next word's START, and only forward: a negative interval is an
    overlap, not a gap, and counting its magnitude would report a slurred pair as a long silence.
    """
    found: list[tuple[float, float]] = []
    for (_w, _s, end), (_w2, start, _e2) in zip(words, words[1:], strict=False):
        if start - end > LONG_GAP_SEC:
            found.append((end, start))
    return found


def _smeared(words: Sequence[tuple[str, float, float]]) -> list[tuple[str, float]]:
    """Words held longer than `MAX_WORD_SEC`, worst first, so `summary()` can name the worst one."""
    over = [(word, end - start) for word, start, end in words if end - start > MAX_WORD_SEC]
    return sorted(over, key=lambda pair: pair[1], reverse=True)


def _flashed(words: Sequence[tuple[str, float, float]]) -> list[tuple[str, float]]:
    """Words shown for less than `MIN_WORD_SEC` — on screen too briefly to read."""
    return [(word, end - start) for word, start, end in words if end - start < MIN_WORD_SEC]
