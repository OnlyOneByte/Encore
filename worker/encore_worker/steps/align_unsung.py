"""The never-sung rule's thresholds and the two acoustic reads that answer it.

A line the audio never sings is dropped on three thresholds at once; a SPARED one comes back only where the
blind decode's own speech mass vouches for it. `_skipped_lines` is the skip-arc arm's complementary read of
the same question, off the trellis. Design: docs/arch/04-alignment.md §4, §3.2; the floors' readings are in
docs/benchmarks/forced-alignment/README.md, "The never-sung floor".
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.lyrics import (
    units,
)

#: The never-sung rule's three thresholds, ALL required (the drop block in `_time_text_global`). ABSOLUTE on
#: a P95-normalised envelope, and INERT on the MIX — README, "The never-sung floor", has every reading.
_NEVER_SUNG_SCORE_GAP = 2.0


_NEVER_SUNG_ENV = 0.10


_NEVER_SUNG_RATE = 2.0


#: Fraction of the blind decode's own speech mass a SPARED never-sung line's claim window must carry before
#: the `m6-*` arms put it back, its decode not being stuck at the window's edge either. Neither the mix's
#: envelope nor the decode's score can answer this (README, "What brings a SPARED line back").
_SPOKEN_RATIO = 0.6


#: ...and only where the witness hears the voice AT ALL: a matrix whose median speech mass over the blind
#: decode's own lines is under this cannot vouch for one, the ratio above being a fraction of nothing there.
#: The two populations: docs/benchmarks/forced-alignment/README.md, "What brings a SPARED line back".
_SPOKEN_FLOOR = 0.06


def _speech_mass(matrix: Any, start: float, end: float) -> float | None:
    """Mean non-blank probability over `[start, end)`: how much the acoustic model hears SPEECH there, where
    an energy envelope hears anything loud. None for an empty span.

    THE BLANK COLUMN COMES FROM THE MATRIX (XA-10): a literal 0 would invert every spare this gates.
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics.generate import blank_of  # noqa: PLC0415

    log_probs = np.asarray(matrix.log_probs)
    frame_sec = float(matrix.frame_sec)
    if frame_sec <= 0 or log_probs.ndim != 2:
        return None
    blank = blank_of(matrix)
    if not 0 <= blank < log_probs.shape[1]:
        return None  # a matrix that names a column it does not have cannot testify
    first = max(0, int(start / frame_sec))
    last = min(len(log_probs), max(int(end / frame_sec), first + 1))
    if last <= first:
        return None
    return float(1.0 - np.exp(log_probs[first:last, blank]).mean())


def _star_positions(flat: Any, matrix: Any) -> tuple[int, ...]:
    """Which of `flat.targets` are `matrix`'s STAR token: the states phase B's graph bypasses for free.

    Read the same way for the publishing decode and for the skip-arc detector, which have to decode one
    topology (docs/arch/04-alignment.md §3.2).
    """
    from encore_worker.domain.lyrics.generate import star_of  # noqa: PLC0415

    named = star_of(matrix)
    return () if named is None else tuple(at for at, token in enumerate(flat.targets) if token == named)


def _skipped_lines(
    matrix: Any,
    line_texts: Sequence[str],
    *,
    separate_lines: bool = False,
    stars: bool = False,
    star_penalty: float | None = None,
    exempt: frozenset[int] = frozenset(),
    units: units.Rules | None = None,
) -> frozenset[int] | None:
    """Which lines roadmap item 15's skip arcs leave unsung on `matrix` — the never-sung rule's COMPLEMENT.

    A detector and not the publishing decode: the lines it names are blanked and the shipped decode runs
    again without them, exactly as the never-sung rule drops a line. None where nothing could be read, which
    the caller treats as no drop at all. `star_penalty` is phase B's, and makes the star targets bypassable
    here as they are in the decode that publishes (docs/arch/04-alignment.md §3.2).
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics import viterbi  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import blank_of, char_targets, line_blocks  # noqa: PLC0415

    flat = char_targets(line_texts, matrix, separate_lines=separate_lines, stars=stars, units=units)
    if not flat.targets:
        return None
    indexes, arcs = viterbi.line_skips(line_blocks(flat), exempt)
    if not arcs:
        return frozenset()
    try:
        got = viterbi.align(
            np.asarray(matrix.log_probs),
            flat.targets,
            blank_of(matrix),
            graph=viterbi.Graph(
                skips=arcs,
                stars=_star_positions(flat, matrix) if star_penalty is not None else (),
                star_penalty=float(star_penalty or 0.0),
            ),
        )
    except InfraFault:
        raise
    except Exception:  # noqa: BLE001 - a detector that cannot read the matrix detects nothing
        return None
    return frozenset(indexes[at] for at in got.skipped)
