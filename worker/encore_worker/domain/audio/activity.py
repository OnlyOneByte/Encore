"""Where singing actually happens, and what that says about a lyrics sheet's offset.

The sheet's line spans say where singing is expected, the audio's RMS envelope says where it is, and the lag
between the two envelopes is the offset; Pearson `r` at that lag is the gate. Why a forced aligner cannot fix
this itself, the measured pass-through and the two rejected gates are in
`docs/benchmarks/forced-alignment/README.md`, "The fix, and what it measured"; the gate's three tiers are in
`docs/arch/04-alignment.md` §5.2.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

#: Seconds per envelope frame, and so the quantisation floor on any shift this estimates.
HOP_SEC = 0.02

#: Seconds of lag to search either way. Beyond a few seconds a sheet is not offset, it is a different song.
MAX_SHIFT_SEC = 8.0

#: Pearson `r` below which the fit is REFUSED. Calibrated on few points and thin (narrowest margin
#: 0.306 -> 0.476): README, "The fix, and what it measured".
MIN_CORRELATION = 0.40

#: Percentile taken as "this track's loud level". Not the max, which one clipped frame would scale
#: everything else to near zero against.
_LOUD_PERCENTILE = 95


@dataclass(frozen=True, slots=True)
class ShiftFit:
    """A fitted offset and the evidence for it."""

    #: Seconds to ADD to every timing in the sheet. Negative means the sheet is late.
    seconds: float
    #: Pearson correlation of the two envelopes at this lag. The gate; see `MIN_CORRELATION`.
    correlation: float

    @property
    def usable(self) -> bool:
        """Trustworthy enough to move a sheet with? NOT gated on the shift's size, unlike
        `place.MIN_SHIFT_SEC`: `docs/benchmarks/forced-alignment/README.md`, "The fix, and what it
        measured"."""
        return self.correlation >= MIN_CORRELATION


def envelope(signal: np.ndarray, rate: int, hop: float = HOP_SEC) -> np.ndarray:
    """Frame-wise vocal activity in 0..1, from a decoded signal.

    Normalised against the track's own loud level rather than an absolute dBFS threshold: the shape is what
    the fit reads, not the level.
    """
    mono = signal.mean(axis=1) if signal.ndim > 1 else signal
    width = max(1, int(rate * hop))
    frames = len(mono) // width
    if frames == 0:
        return np.zeros(0)
    blocks = mono[: frames * width].reshape(frames, width)
    rms = np.sqrt((blocks**2).mean(axis=1) + 1e-20)
    loud = float(np.percentile(rms, _LOUD_PERCENTILE))
    return np.clip(rms / max(loud, 1e-12), 0.0, 1.0)


def expected_envelope(spans: Sequence[tuple[float, float]], frames: int, hop: float = HOP_SEC) -> np.ndarray:
    """A 0/1 envelope of where a SHEET claims singing happens.

    Each line's full span rather than its start alone: a train of blocks correlates against a continuous
    signal better than a train of impulses does.
    """
    out = np.zeros(max(frames, 0))
    if frames <= 0:
        return out
    for start, end in spans:
        first = max(0, int(float(start) / hop))
        last = min(frames, max(int(float(end) / hop), first + 1))
        if first < frames:
            out[first:last] = 1.0
    return out


def _bounded_correlation(a: np.ndarray, b: np.ndarray, reach: int) -> tuple[np.ndarray, int]:
    """`np.correlate(a, b, "full")` restricted to lags in `[-reach, reach]`, plus the first lag returned.

    Lag `L` means `b` DELAYED by `L` frames, the sense `np.roll(expected, L)` reads; a lag with no overlap is
    not returned. Why the padded VALID correlation is the same sum: README, "L6: bounded-lag correlation, off
    the event loop".
    """
    if len(a) == 0 or len(b) == 0:
        # `fit_shift` refuses an empty envelope first; guarded so the pad width cannot go negative.
        return np.zeros(0), 0
    lag_lo = max(-reach, -(len(b) - 1))
    lag_hi = min(reach, len(a) - 1)
    if lag_hi < lag_lo:
        return np.zeros(0), 0
    head = -lag_lo
    tail = max(0, len(b) + lag_hi - len(a))
    padded = np.concatenate((np.zeros(head, dtype=a.dtype), a, np.zeros(tail, dtype=a.dtype)))
    return np.correlate(padded, b, mode="valid")[: lag_hi - lag_lo + 1], lag_lo


def fit_shift(
    actual: np.ndarray,
    expected: np.ndarray,
    *,
    hop: float = HOP_SEC,
    max_shift: float = MAX_SHIFT_SEC,
) -> ShiftFit:
    """The lag that best aligns a sheet's expected activity onto the audio's real activity.

    Cross-correlated rather than searched, so it can run before EVERY alignment, and bounded to `+-reach`
    lags — a work reduction rather than an approximation. Correlation 0.0, never usable, for an empty or
    constant envelope. README, "L6: bounded-lag correlation, off the event loop".
    """
    if len(actual) == 0 or len(expected) == 0:
        return ShiftFit(seconds=0.0, correlation=0.0)
    if float(actual.std()) == 0.0 or float(expected.std()) == 0.0:
        return ShiftFit(seconds=0.0, correlation=0.0)

    a = actual - actual.mean()
    b = expected - expected.mean()
    reach = max(1, int(max_shift / hop))
    window, first = _bounded_correlation(a, b, reach)
    if len(window) == 0:
        return ShiftFit(seconds=0.0, correlation=0.0)

    lag = int(np.argmax(window)) + first
    # Scored at the CHOSEN lag against the real envelope, not read off the correlation's height.
    rolled = np.roll(expected, lag)
    r = float(np.corrcoef(actual, rolled)[0, 1])
    if not np.isfinite(r):
        return ShiftFit(seconds=0.0, correlation=0.0)
    return ShiftFit(seconds=lag * hop, correlation=r)


def fit_sheet_to_audio(
    signal: np.ndarray,
    rate: int,
    spans: Sequence[tuple[float, float]],
    *,
    hop: float = HOP_SEC,
    max_shift: float = MAX_SHIFT_SEC,
) -> ShiftFit:
    """`fit_shift` over a decoded signal and a sheet's line spans. The call the align step makes.

    PREFER THE VOCALS STEM: residuals are 10-20 ms against it and 140-150 ms against the mix (README, "The
    fix, and what it measured").
    """
    actual = envelope(signal, rate, hop)
    return fit_shift(actual, expected_envelope(spans, len(actual), hop), hop=hop, max_shift=max_shift)
