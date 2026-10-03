"""How AMBIGUOUS a line's placement was, and the grading rule that reads it.

A second question of the decode's own trellis: how much WORSE is the best path that puts this line's first
character at least `WINDOW_SEC` away? That max-marginal margin is near zero exactly when the audio holds
another place the line fits as well, and NOT A PATH SCORE, which is what makes it new.
The rule, why the floor lives in `lexical.Bands` and the cost shape: `docs/arch/04-alignment.md` §6 and §14;
README, "The confidence rule".
"""

from __future__ import annotations

import difflib
import math
from collections.abc import Mapping, Sequence
from statistics import median

import numpy as np

#: Seconds a competing placement must be from the chosen one to count as a DIFFERENT placement — MEASURED
#: over four reaches, and it decided the whole rule (README, "`WINDOW_SEC` = 1.0 s, and it is a measured
#: choice rather than the review's 3 s").
WINDOW_SEC = 1.0

#: Nats per frame below the song's own MEDIAN line score at which a line's raw score is doubted — the same
#: shape as the never-sung and adoption gaps, and it catches what the margin cannot: a line the model heard
#: badly everywhere, where no placement is good and the gap between the best two is small.
SCORE_DROP_NATS = 1.0

#: Two lines whose texts are this similar are "the same line" to `fuzzy_repeats`. `difflib`'s ratio, on the
#: normalised text: 0.8 is the review's figure.
REPEAT_RATIO = 0.8

#: Score difference below which two frames of a max-marginal curve are the SAME placement: the chosen
#: character's whole span sits at the maximum, so a frame to its right is the same path holding the character
#: longer. Exact arithmetic would make the plateau equal; this is float64 slack.
_TIE_NATS = 1e-6


def placement_margins(
    log_probs: np.ndarray,
    targets: Sequence[int],
    first_targets: Mapping[int, int],
    *,
    blank: int = 0,
    frame_sec: float,
    window_sec: float = WINDOW_SEC,
) -> dict[int, float]:
    """`{line index: nats the best path gives up to move that line at least `window_sec`}`.

    `targets` is `generate.char_targets().targets`, separators included, because the trellis is over that
    exact sequence. THE TRELLIS IS CTC's OWN, and it must be, or the margin would describe a different decode
    than the one that produced the timings (docs/arch/04-alignment.md §6). EMPTY `{}` when there is nothing to
    measure, which the caller treats as NOT MEASURED, and `math.inf` for a line with no competing placement.
    """
    matrix = np.asarray(log_probs, dtype=np.float64)
    count = len(targets)
    if matrix.ndim != 2 or count == 0 or matrix.shape[0] == 0 or frame_sec <= 0:
        return {}
    frames, vocab = matrix.shape
    if not 0 <= blank < vocab:
        return {}
    encoded = np.asarray(targets, dtype=np.intp)
    if encoded.min() < 0 or encoded.max() >= vocab:
        return {}
    queried = {index: position for index, position in first_targets.items() if 0 <= position < count}
    if not queried:
        return {}

    states = 2 * count + 1
    #: Which vocabulary column each trellis state emits (even = blank, odd = that target).
    labels = np.empty(states, dtype=np.intp)
    labels[0::2] = blank
    labels[1::2] = encoded
    #: May a path reach state s from s-2, skipping the blank between two targets? Only between DIFFERENT
    #: targets: CTC needs a blank to separate a repeat, or the two would merge into one span.
    skip_into = np.zeros(states, dtype=bool)
    if count > 1:
        skip_into[3::2] = encoded[1:] != encoded[:-1]
    #: The mirror for the backward pass: may a path leave s for s+2?
    skip_from = np.zeros(states, dtype=bool)
    skip_from[: states - 2] = skip_into[2:]

    columns = np.array([2 * queried[index] + 1 for index in sorted(queried)], dtype=np.intp)
    ahead = np.empty((frames, len(columns)), dtype=np.float64)
    behind = np.empty((frames, len(columns)), dtype=np.float64)
    #: One scratch buffer, `-inf` at both ends, so a shift by one or two states is a SLICE rather than a
    #: per-frame concatenate: `window[2:]` is `previous[s]`, `window[1:-1]` is `previous[s-1]`.
    window = np.full(states + 2, -np.inf, dtype=np.float64)

    # ── forward: the best score of any path over frames 0..f that has state s at frame f ──
    alpha = np.full(states, -np.inf, dtype=np.float64)
    alpha[0] = matrix[0, blank]
    alpha[1] = matrix[0, labels[1]]
    ahead[0] = alpha[columns]
    for frame in range(1, frames):
        window[2:] = alpha
        best = np.maximum(window[2:], window[1:-1])
        np.maximum(best, window[:-2], out=best, where=skip_into)
        alpha = best + matrix[frame, labels]
        ahead[frame] = alpha[columns]
    if not math.isfinite(max(alpha[states - 1], alpha[states - 2])):
        return {}  # the targets do not fit these frames: there is no chosen path to compare against

    # ── backward: the best score of any path over frames f..F-1 that has state s at frame f ──
    # The buffer is re-floored first: the forward pass wrote its last two states where the backward pass
    # reads `-inf` for "there is no state s+1 / s+2", and a stale alpha there would let every path leave
    # the sequence's end.
    window.fill(-np.inf)
    beta = np.full(states, -np.inf, dtype=np.float64)
    beta[states - 1] = matrix[frames - 1, labels[states - 1]]
    beta[states - 2] = matrix[frames - 1, labels[states - 2]]
    behind[frames - 1] = beta[columns]
    for frame in range(frames - 2, -1, -1):
        window[:states] = beta
        best = np.maximum(window[:-2], window[1:-1])
        np.maximum(best, window[2:], out=best, where=skip_from)
        beta = best + matrix[frame, labels]
        behind[frame] = beta[columns]

    # The max-marginal: alpha and beta both charge frame f's emission, so one copy comes back off.
    curves = ahead + behind - matrix[:, labels[columns]]
    reach = max(1, round(window_sec / frame_sec))
    out: dict[int, float] = {}
    for position, index in enumerate(sorted(queried)):
        out[index] = _gap(curves[:, position], reach)
    return out


def _gap(curve: np.ndarray, reach: int) -> float:
    """`peak - (the best value at least `reach` frames outside the peak's own plateau)`, in nats.

    THE PLATEAU, not the single argmax frame, or a held vowel would read as ambiguous. The run is taken around
    the argmax, so a SECOND plateau elsewhere is outside the mask and yields zero, which is honest.
    """
    peak = float(curve.max())
    if not math.isfinite(peak):
        return math.inf
    near = curve >= peak - _TIE_NATS
    top = int(np.argmax(curve))
    before = np.flatnonzero(~near[:top])
    after = np.flatnonzero(~near[top + 1 :])
    first = int(before[-1]) + 1 if before.size else 0
    last = int(after[0]) + top if after.size else len(curve) - 1
    low = max(0, first - reach)
    high = min(len(curve) - 1, last + reach)
    outside = [curve[:low], curve[high + 1 :]]
    best = max((float(part.max()) for part in outside if part.size), default=-math.inf)
    return math.inf if not math.isfinite(best) else peak - best


def low_lines(
    margins: Mapping[int, float],
    scores: Mapping[int, float],
    *,
    min_margin_nats: float,
    score_drop_nats: float = SCORE_DROP_NATS,
) -> frozenset[int]:
    """The line indexes THIS rule doubts: `margin < min_margin_nats` OR the raw score more than
    `score_drop_nats` below the song's median (the two-signal rule, docs/arch/04-alignment.md §6).

    `min_margin_nats` IS REQUIRED, for `lexical.band`'s reason (XA-06), and `scores` is every line's,
    so the reference is the song's own level. A LINE WITH NO MARGIN IS NOT DOUBTED by the margin half, and
    under four lines the SCORE half abstains, a median over three describing nothing.
    """
    if not margins and not scores:
        return frozenset()
    doubted = {index for index, gap in margins.items() if gap < min_margin_nats}
    if len(scores) >= 4:
        floor = median(scores.values()) - score_drop_nats
        doubted |= {index for index, score in scores.items() if score < floor}
    return frozenset(doubted)


def fuzzy_repeats(line_texts: Mapping[int, str], *, ratio: float = REPEAT_RATIO) -> frozenset[int]:
    """Line indexes whose text nearly repeats another line's (`difflib` ratio >= `ratio`).

    A FEATURE, NOT A DEFAULT: the `conf-fuzzy-repeats` arm, measured and left off (README, "The optional half:
    near-repeat detection"). QUADRATIC deliberately — a sheet is under 200 lines, and a shingle index would be
    a second definition of "nearly the same line".
    """
    normalized = {index: " ".join(text.lower().split()) for index, text in line_texts.items()}
    order = [index for index in sorted(normalized) if normalized[index]]
    out: set[int] = set()
    for position, index in enumerate(order):
        for other in order[position + 1 :]:
            matcher = difflib.SequenceMatcher(None, normalized[index], normalized[other])
            if (
                matcher.real_quick_ratio() >= ratio
                and matcher.quick_ratio() >= ratio
                and matcher.ratio() >= ratio
            ):
                out.add(index)
                out.add(other)
    return frozenset(out)
