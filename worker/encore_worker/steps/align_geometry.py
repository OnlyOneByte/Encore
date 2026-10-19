"""The repair ladder's geometry: clamping a repaired line against its neighbours.

Pure interval arithmetic over decoded lines — no adapters, no config — so the ladder's order can be tested
without a decode. Design: docs/arch/04-alignment.md §4.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from encore_worker.domain.lyrics.generate import Generated, Line


#: Seconds a repaired line is widened to WHEN IT IS RE-FITTED, and not a floor on the PUBLISHED width: a
#: later `_pulled_end` can pull this line's end back, and the pull wins. What DOES bound the published width
#: is `_pulled_end`'s own rule, one decoder frame per letter (docs/arch/04-alignment.md §4).
_REPAIRED_MIN_SEC = 0.2


def _with_lines(generated: Generated, repaired: Mapping[int, Line]) -> Generated:
    """`generated` with repaired lines swapped in by index, and any it lacks INSERTED in index order —
    which is the never-sung rule's spared lines coming back."""
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    present = {line.index for line in generated.lines}
    added = [line for index, line in repaired.items() if index not in present]
    lines = [repaired.get(line.index, line) for line in generated.lines]
    return Generated(
        lines=tuple(sorted([*lines, *added], key=lambda line: line.index)) if added else tuple(lines),
        language=generated.language,
    )


def _clamped(
    generated: Generated, repaired: set[int], *, blind: Generated, frame_sec: float, ordered: bool
) -> tuple[Generated, frozenset[int], dict[int, float]]:
    """Repaired lines clipped to their neighbours; with `ordered`, fitted IN ORDER or refused to `blind`.

    Returns `(clamped, reverted, pulled)` — the refusals (the arm only) and `{index: seconds of overrun
    removed}` for each preceding line whose END the default pulled back, both being decisions no metric on
    the report can show. DEFAULT is `_clamped_v2`, which never refuses; `ordered` IS THE `m2-order-clamp` ARM
    (XA-07). README, "The order-clamp arm's own table", has what the arm bought and the gates it failed.
    """
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    if not ordered:
        clamped, pulled = _clamped_v2(generated, repaired, frame_sec=frame_sec)
        return clamped, frozenset(), pulled
    lines = list(generated.lines)
    # A repaired index is a blind line, except a never-sung line spared back in, which has no
    # blind original: a refused run simply goes without it, which is what the never-sung rule did to it.
    original = {line.index: line for line in blind.lines}
    out: list[Line] = []
    reverted: set[int] = set()
    position = 0
    while position < len(lines):
        if lines[position].index not in repaired:
            out.append(lines[position])
            position += 1
            continue
        stop = position
        while stop < len(lines) and lines[stop].index in repaired:
            stop += 1
        run = lines[position:stop]
        ceiling = lines[stop].start if stop < len(lines) else math.inf
        fitted = _fitted_run(run, out[-1] if out else None, ceiling, frame_sec)
        if fitted is None:
            fitted = [original[line.index] for line in run if line.index in original]
            reverted.update(line.index for line in run)
        out.extend(fitted)
        position = stop
    # The arm moves no trusted end at all (it refuses the run instead), so it reports no pulls.
    return Generated(lines=tuple(out), language=generated.language), frozenset(reverted), {}


def _clamped_v2(
    generated: Generated, repaired: set[int], *, frame_sec: float
) -> tuple[Generated, dict[int, float]]:
    """The shipped default: the v2 clamp with a BOUNDED left floor (`_clamped` without `ordered`).

    `(clamped, {index: seconds of overrun removed})`, the second half naming every PRECEDING line whose end
    this pulled back — a published timing changed on a line the ladder did not repair. It never refuses, so a
    repair landing past its successor still publishes backwards word starts (XA-07;
    docs/arch/04-alignment.md §4; README, "The fix: resolve the overlap at the neighbour's END").
    """
    from encore_worker.domain.lyrics.generate import Generated, remapped  # noqa: PLC0415

    lines = list(generated.lines)
    out: list[Line] = []
    pulls: dict[int, float] = {}
    for position, line in enumerate(lines):
        if line.index in repaired:
            previous = out[position - 1] if position else None
            previous_end = previous.end if previous is not None else 0.0
            if previous is not None and previous_end > line.start:
                pulled = _pulled_end(previous, line.start, frame_sec=frame_sec)
                if pulled is not None:
                    out[position - 1] = pulled
                    pulls[previous.index] = previous_end - pulled.end
                    previous_end = pulled.end
            low = max(line.start, previous_end)
            high = line.end
            if position + 1 < len(lines) and lines[position + 1].index not in repaired:
                high = min(high, lines[position + 1].start)
            high = max(high, low + _REPAIRED_MIN_SEC)
            if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
                line = remapped(line, low, high)
        out.append(line)
    return Generated(lines=tuple(out), language=generated.language), pulls


def _pulled_end(line: Line, boundary: float, *, frame_sec: float) -> Line | None:
    """`line` ending at `boundary` instead of past it, or None where that would not be a decoded timing.

    The one end `_clamped_v2` moves, and the START never moves with it, so a PULLED LINE'S PROVENANCE AND
    GRADE DO NOT MOVE either — the trail owes the pull itself instead (`_pulls_why`). TWO REFUSALS, NEITHER A
    NEW THRESHOLD: one decoder frame per letter, and `trimmed`'s own None. `frame_sec` goes through to
    `trimmed` because the letter rule measures the WHOLE line (docs/arch/04-alignment.md §4; README, "The
    anchor walk").
    """
    from encore_worker.domain.lyrics.generate import trimmed  # noqa: PLC0415

    if boundary - line.start < max(1, sum(ch.isalpha() for ch in line.text)) * frame_sec:
        return None
    return trimmed(line, boundary, frame_sec=frame_sec)


def _fitted_run(
    run: Sequence[Line], previous: Line | None, ceiling: float, frame_sec: float
) -> list[Line] | None:
    """`run` clipped into the gap after `previous` and before `ceiling`, or None when it cannot keep order.

    The acceptance test is `measure`'s own: word STARTS never decrease, from `previous`'s last word through
    the run to `ceiling`. A line clipped below one frame per LETTER is refused as well — ordered, but no
    longer a timing anyone decoded: CTC gives every target at least a frame, and the targets are letters
    (a digit is out of vocabulary and interpolated, so counting it would refuse a tight but real decode).
    """
    from encore_worker.domain.lyrics.generate import remapped  # noqa: PLC0415

    floor = previous.end if previous is not None else 0.0
    last_start = (
        max((word.start for word in previous.words), default=previous.start)
        if previous is not None
        else -math.inf
    )
    fitted: list[Line] = []
    for line in run:
        low = max(line.start, floor)
        high = min(max(line.end, low + _REPAIRED_MIN_SEC), ceiling)
        if high - low < max(1, sum(ch.isalpha() for ch in line.text)) * frame_sec:
            return None
        if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
            line = remapped(line, low, high)
        for word in line.words:
            if word.start < last_start:
                return None
            last_start = word.start
        fitted.append(line)
        floor = line.end
    return fitted if last_start <= ceiling else None


def _anchored_runs(
    lines: Sequence[Line], needs_fix: set[int], duration_sec: float
) -> list[tuple[tuple[Line, ...], tuple[float, float]]]:
    """Contiguous runs of to-be-repaired lines, each windowed between its nearest KEPT neighbours.

    The kept lines are the anchors: a run's window opens where the previous trusted line ends and closes
    where the next one starts (track edges at the ends), so a re-decode cannot wander outside the region
    its anchors vouch for. Runs are decoded jointly to keep order within the run monotonic.
    """
    ordered = list(lines)
    runs: list[tuple[tuple[Line, ...], tuple[float, float]]] = []
    position = 0
    while position < len(ordered):
        if ordered[position].index not in needs_fix:
            position += 1
            continue
        stop = position
        while stop < len(ordered) and ordered[stop].index in needs_fix:
            stop += 1
        window_start = ordered[position - 1].end if position > 0 else 0.0
        window_end = ordered[stop].start if stop < len(ordered) else duration_sec
        runs.append((tuple(ordered[position:stop]), (window_start, window_end)))
        position = stop
    return runs
