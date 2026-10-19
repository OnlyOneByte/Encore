"""Claim priors as decode INPUTS: an onset bonus, and the mix fused in where the stem is mute.

The review's roadmap item 14. The claims act as Huang 2022's boundary detector: each line's first
character gets a Gaussian bonus centred
on its claimed onset and truncated to zero beyond `ONSET_REACH_SEC`, so a claim can tip an ambiguous
placement but can never reach across the song. `fused` is the second half — inside a claim window where the
STEM's envelope hears nothing, the MIX's frames are the only evidence there is.

Both are default-off arms (`host.config.ALIGN_EXPERIMENTS`). The shape, the control arm and the numbers:
docs/arch/04-alignment.md §3.2 and §14; README, "W9: a vendored decoder, and the three arms it unblocks".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

#: Nats added at the claimed onset frame itself — the bonus's peak, and so the cap on what a claim is worth.
#: FITTED over 0-20 in W10; 8.0 is the pool's optimum and this value is inside the safe region, not on it
#: (README, "W10: fitting the claim prior's peak").
ONSET_BONUS_NATS = 4.0

#: The Gaussian's width in seconds. Wider than the ±300 ms the claims are scored at, because what the prior
#: is for is a line the decode put SECONDS away. Still UNFITTED: W10 swept the peak only.
ONSET_SIGMA_SEC = 0.6

#: Where the bonus is truncated to zero. The cap in "capped Gaussian": past it a claim is no evidence at all,
#: which is what keeps a mis-bound repeat from pulling a line across the song. Still UNFITTED, as above.
ONSET_REACH_SEC = 2.0


def onset_bonus(
    first_targets: Mapping[int, int],
    claimed: Mapping[int, float],
    *,
    frames: int,
    frame_sec: float,
    peak: float = ONSET_BONUS_NATS,
    sigma_sec: float = ONSET_SIGMA_SEC,
    reach_sec: float = ONSET_REACH_SEC,
) -> dict[int, np.ndarray]:
    """`{target position: per-frame nats}` for every line with both a first character target and a claim.

    `first_targets` is `generate.char_targets().first_char_target` and `claimed` is the clock-mapped claim
    starts (XA-04) — raw claim times would centre the bonus on a sheet's own offset. Empty where nothing can
    be read, which the caller passes to `viterbi.Graph` as no prior at all.
    """
    if frames <= 0 or frame_sec <= 0 or sigma_sec <= 0 or reach_sec <= 0 or peak == 0:
        return {}
    clock = np.arange(frames, dtype=np.float64) * frame_sec
    out: dict[int, np.ndarray] = {}
    for index, position in sorted(first_targets.items()):
        onset = claimed.get(index)
        if onset is None:
            continue
        offset = clock - float(onset)
        curve = peak * np.exp(-0.5 * (offset / sigma_sec) ** 2)
        curve[np.abs(offset) > reach_sec] = 0.0
        out[position] = curve
    return out


def mute_in_window(
    envelope: Any,
    windows: Sequence[tuple[float, float]],
    *,
    frames: int,
    frame_sec: float,
    hop_sec: float,
    floor: float,
) -> np.ndarray:
    """A per-frame mask: inside one of `windows`, and the stem's `envelope` below `floor` there.

    The envelope's hop is its own and is NOT the matrix's frame, so each emission frame reads the envelope
    bucket it falls in. All-False when there is no envelope to read, which makes `fused` a no-op.
    """
    mask = np.zeros(max(frames, 0), dtype=bool)
    if envelope is None or frames <= 0 or frame_sec <= 0 or hop_sec <= 0:
        return mask
    level = np.asarray(envelope, dtype=np.float64)
    if level.ndim != 1 or level.size == 0:
        return mask
    clock = np.arange(frames, dtype=np.float64) * frame_sec
    inside = np.zeros(frames, dtype=bool)
    for start, end in windows:
        if end > start:
            inside |= (clock >= start) & (clock < end)
    bucket = np.minimum((clock / hop_sec).astype(np.intp), level.size - 1)
    return inside & (level[bucket] < floor)


def fused(stem_log_probs: Any, mix_log_probs: Any, mask: np.ndarray) -> np.ndarray:
    """`stem_log_probs` with the `mask` frames replaced by the mix's own.

    Frames, not columns: a row of one has to BE a row of the other, which holds only while both come from
    one bundle on one clock. All this can check is the WIDTH — the caller owns the vocabulary check, having
    both bundles in hand (`align_steps.fuse_in_the_mix`). A mix shorter than the stem keeps the stem's tail:
    two files of one recording can round to a different last frame, which is not a reason to decline.
    """
    stem = np.array(np.asarray(stem_log_probs), copy=True)
    mix = np.asarray(mix_log_probs)
    if stem.ndim != 2 or mix.ndim != 2 or stem.shape[1] != mix.shape[1]:
        raise ValueError(f"stem {stem.shape} and mix {mix.shape} are not one bundle's matrices")
    if mask.shape != (stem.shape[0],):
        raise ValueError(f"the fuse mask is {mask.shape}, not one flag per {stem.shape[0]} frames")
    rows = np.flatnonzero(mask[: min(stem.shape[0], mix.shape[0])])
    stem[rows] = mix[rows].astype(stem.dtype, copy=False)
    return stem
