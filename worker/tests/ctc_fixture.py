"""A pure-numpy CTC forced aligner and the synthetic "sung" emission matrices it decodes.

WHY A REAL VITERBI AND NOT A SCRIPT. The alignment suite's first fake decoder returned the WHOLE SONG's char
spans whatever it was handed, so every windowed repair decode raised inside `generate` (its span-count
check) and `regenerate` swallowed it: R3 ran in no test, and deleting it left the suite green (review L8).
A decoder that aligns the frames it is GIVEN is slice-relative by construction. A repair window gets
spans relative to its own first frame, which is exactly what `regenerate` shifts back to song time. And a
window that holds the sung line finds it there, with no script needed.

WHAT IT MIRRORS. `adapters.ml.forced_align_decoder` (torchaudio's `forced_align`, blank = 0). It uses the
same topology: blank-interleaved targets, a skip allowed only between DIFFERENT labels, and an end in the
last label or the trailing blank. It returns the same two outputs: a label per frame and that frame's
log-prob of its label. `test_ml_contract.py` holds it frame-for-frame equal to the real kernel on these
matrices, so a test passing on the fake says something about the kernel.

WHAT IT IMPLIES FOR R3. An exact Viterbi has optimal substructure. Re-decoding a run between the global
path's own anchors, on the same matrix, therefore reproduces the global path. That is the measured R3
NO-OP in docs/benchmarks/forced-alignment/README.md, and `test_align_v2` pins it as a property. A test
that wants R3 to CHANGE something has to hand the global pass different evidence than the windows get.
`misheard` does that, and says so.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence

import numpy as np
import numpy.typing as npt

FRAME_SEC = 0.02

#: Probability mass on the frame's "true" label: the sung char inside a char's frames, blank elsewhere.
#: The rest is spread evenly over the other labels, so every path is finite and the Viterbi always has a
#: choice to make. Only its RATIO to the remainder matters to the path.
HIT = 0.9

#: The fraction of each char's slot that is sung. The rest is blank, so a doubled letter ("carry") has
#: the blank frame between its two occurrences that CTC's topology requires.
FILL = 0.7

Matrix = npt.NDArray[np.float32]

#: `generate.Decoder`'s shape, as the fakes implement it.
Decode = Callable[[object, Sequence[int]], tuple[list[int], list[float]]]


def alignable(text: str, dictionary: Mapping[str, int]) -> list[int]:
    """The target ids `generate` builds for `text`: every char the dictionary maps to a non-blank id."""
    return [token for word in text.split() for ch in word.lower() if (token := dictionary.get(ch, 0))]


def char_frames(
    phrases: Sequence[tuple[str, float, float]], dictionary: Mapping[str, int], frame_sec: float = FRAME_SEC
) -> list[tuple[int, int, int]]:
    """(first frame, end frame exclusive, token) per sung char, in order, spread evenly over its phrase."""
    out: list[tuple[int, int, int]] = []
    for text, start, end in phrases:
        tokens = alignable(text, dictionary)
        step = (end - start) / max(len(tokens), 1)
        for k, token in enumerate(tokens):
            first = int((start + k * step) / frame_sec)
            last = max(int((start + (k + FILL) * step) / frame_sec), first + 1)
            out.append((first, last, token))
    return out


def sung_matrix(
    phrases: Sequence[tuple[str, float, float]],
    dictionary: Mapping[str, int],
    duration_sec: float,
    frame_sec: float = FRAME_SEC,
) -> Matrix:
    """(frames, vocab) log-probs of a song that sings `phrases`: each char heard on its own frames."""
    vocab = max(dictionary.values()) + 1
    frames = int(duration_sec / frame_sec)
    hit, rest = math.log(HIT), math.log((1.0 - HIT) / (vocab - 1))
    matrix = np.full((frames, vocab), rest, dtype=np.float32)
    matrix[:, 0] = hit
    for first, last, token in char_frames(phrases, dictionary, frame_sec):
        matrix[first:last, :] = rest
        matrix[first:last, token] = hit
    return matrix


def ctc_viterbi(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
    """The best CTC path of `targets` through `log_probs`, as `forced_align_decoder` returns it.

    TIES ARE BROKEN AS TORCHAUDIO'S CPU KERNEL BREAKS THEM, so flat evidence (a window holding nothing
    the text says) takes the same path as production does, not just an equally scored one. A skip is
    taken only if it is strictly best, a step only if it is strictly best, and otherwise the path stays.
    It ends in the trailing blank only if that is strictly better than ending in the last label. The
    kernel's accumulation dtype is kept too: float32 in, float32 sums.

    Raises ValueError when the frames cannot hold the targets (each target needs a frame, and each
    repeated neighbour needs a blank between). torchaudio raises too, and `regenerate` counts either as
    a fault.
    """
    lp = np.asarray(log_probs)
    lp = lp.astype(np.float32 if lp.dtype == np.float32 else np.float64, copy=False)
    if lp.ndim != 2:
        raise ValueError(f"log_probs must be (frames, vocab), got shape {lp.shape}")
    frames = lp.shape[0]
    if not targets:
        return [blank] * frames, [float(v) for v in lp[:, blank]]
    ids = np.asarray(targets, dtype=np.int64)
    if (ids == blank).any():
        raise ValueError("a target equals the blank id")
    need = len(ids) + int((ids[1:] == ids[:-1]).sum())
    if frames < need:
        raise ValueError(f"{frames} frames cannot hold {len(ids)} targets ({need} needed)")

    ext = np.full(2 * len(ids) + 1, blank, dtype=np.int64)
    ext[1::2] = ids
    states = len(ext)
    # A skip over the blank between two labels is allowed only when the labels differ.
    skip = np.zeros(states, dtype=bool)
    skip[3::2] = ext[3::2] != ext[1:-2:2]
    emit = lp[:, ext]
    neg = np.array(-np.inf, dtype=lp.dtype)
    alpha = np.full(states, neg, dtype=lp.dtype)
    alpha[0], alpha[1] = emit[0, 0], emit[0, 1]
    back = np.zeros((frames, states), dtype=np.int8)
    pad = np.full(2, neg, dtype=lp.dtype)
    for t in range(1, frames):
        stay = alpha
        one = np.concatenate((pad[:1], alpha[:-1]))
        two = np.where(skip, np.concatenate((pad, alpha[:-2])), neg)
        choice = np.where((two > one) & (two > stay), 2, np.where((one > stay) & (one > two), 1, 0))
        alpha = np.choose(choice, (stay, one, two)) + emit[t]
        back[t] = choice
    state = states - 1 if alpha[-1] > alpha[-2] else states - 2
    if not np.isfinite(alpha[state]):
        raise ValueError("no CTC path fits these targets in these frames")
    path = np.empty(frames, dtype=np.int64)
    for t in range(frames - 1, -1, -1):
        path[t] = state
        state -= int(back[t, state])
    return [int(v) for v in ext[path]], [float(v) for v in emit[np.arange(frames), path]]


def misheard(heard: Matrix, frames_of_the_song: int) -> Decode:
    """A decoder that runs `ctc_viterbi` over `heard` when given the WHOLE song, and over its slice otherwise.

    The one way to make R3 matter under an exact decoder (see the module docstring). The GLOBAL pass
    decodes different evidence (`heard`: a repeat placed somewhere it was not sung), and every repair
    window decodes the real matrix it is handed.
    """

    def decode(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        if len(np.asarray(log_probs)) == frames_of_the_song:
            return ctc_viterbi(heard, targets)
        return ctc_viterbi(log_probs, targets)

    return decode
