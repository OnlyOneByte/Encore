"""Where singing actually happens, and what that says about a lyrics sheet's offset.

WHY THIS EXISTS. A forced aligner does not search the recording — whisperx crops the audio to each
segment's provisional span and aligns the text inside it. So a sheet whose timings are offset from the
recording is not refined back into place; the offset is passed straight through. Measured over a 0..5 s
sweep on `tfr-flyaway` (docs/benchmarks/forced-alignment):

    bias = 1.005 x offset + 131 ms      (max residual 41 ms, aligning on the mix)
    bias = 1.008 x offset +  59 ms      (max residual 42 ms, aligning on the vocals stem)

A slope of 1.00 means NONE of the offset is recovered — not at five seconds and not at 150 ms. Worse, the
aligner stays internally precise while doing it (jitter of 41-162 ms across the whole sweep), so the result
is a confidently, uniformly misplaced document that passes every self-consistency check in `TimingReport`.

The cost is steep and it starts early: lines within +/-250 ms of truth fall 74.7% -> 42.7% at a 150 ms sheet
offset, and to 20.0% at 250 ms.

WHAT THIS MEASURES INSTEAD. `place.estimate_shift` has always wanted "a REFERENCE series measured on this
audio", and the only one the worker had was the previous attempt's alignment — which carries the same error
it is trying to remove, so a first attempt could not be corrected at all. This provides an INDEPENDENT
reference that needs no model: the sheet's line spans say where singing is expected, the audio says where it
is, and the lag between those two envelopes is the offset.

    correct song, vocals stem   recovered every injected offset to within 10-20 ms (the frame quantum)
    correct song, full mix      to within 140-150 ms
    a DIFFERENT song's sheet    r = -0.10 .. 0.31, refused by `MIN_CORRELATION`

End to end through the real aligner, lines within +/-250 ms: 20.0% -> 68.0% at a 250 ms offset, 0.0% ->
73.3% at 500 ms and beyond, against an uncorrected-sheet ceiling of 74.7%.

PEARSON r IS THE GATE, and two more obvious candidates were measured and rejected. Peak PROMINENCE does not
discriminate (1.03-1.08 for a wrong song against 1.04-1.07 for the right one, and a shuffled sheet scored
HIGHEST at 1.22) because a 75-line envelope is mostly "on", so the correlation is broad rather than peaked.
ONSET AGREEMENT does not discriminate either (40.4-43.2% wrong against 38.7-74.7% right). Only the
correlation at the chosen lag separates the two populations.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

#: Frame size for the activity envelope. 20 ms is the quantisation floor on any shift this estimates, and
#: that is already an order of magnitude finer than the error it corrects.
HOP_SEC = 0.02

#: How far out to look. Beyond a few seconds a sheet is not offset, it is a different song — and searching
#: wider costs accuracy by admitting a spurious peak.
MAX_SHIFT_SEC = 8.0

#: Envelope correlation below which the fit is REFUSED.
#:
#: Calibrated, and on few points: the right song scored 0.590 (vocals stem) and 0.476 (mix), a different
#: song's sheet scored 0.178, 0.306 and -0.100. 0.40 sits between those populations with the narrowest
#: margin being 0.306 -> 0.476. That is thin enough to state rather than bury: widen the calibration before
#: trusting this on material unlike the benchmark's.
#:
#: The asymmetry that makes a conservative threshold right: refusing a good fit costs the offset we already
#: have today, while accepting a bad one MOVES A SHEET THAT WAS CORRECT.
MIN_CORRELATION = 0.40

#: Percentile taken as "this track's loud level", so the envelope is level-independent. Not the max: one
#: clipped frame would scale everything else to near zero.
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
        """Trustworthy enough to move a sheet with?

        NOT gated on the shift's size, unlike `place.MIN_SHIFT_SEC`. That floor exists because applying a
        badly-estimated small shift would jitter a text that was already right — but this estimate is good
        to 10-20 ms, and applying it to an already-correct sheet was measured to cost ONE line out of 75
        (74.7% -> 73.3% within +/-250 ms). The floor was protecting against an estimator this accurate did
        not need protecting against, while excluding the 0-350 ms band that does the most damage.
        """
        return self.correlation >= MIN_CORRELATION


def envelope(signal: np.ndarray, rate: int, hop: float = HOP_SEC) -> np.ndarray:
    """Frame-wise vocal activity in 0..1, from a decoded signal.

    Normalised against the track's own loud level rather than an absolute dBFS threshold, so a quietly
    mastered song and a loud one produce comparable envelopes — the shape is what the fit reads, not the
    level.
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

    Uses each line's full span rather than just its start, because a duration is information the sheet
    already carries and the fit is sharper for having it — a train of impulses correlates worse against a
    continuous signal than a train of blocks does.
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


def fit_shift(
    actual: np.ndarray,
    expected: np.ndarray,
    *,
    hop: float = HOP_SEC,
    max_shift: float = MAX_SHIFT_SEC,
) -> ShiftFit:
    """The lag that best aligns a sheet's expected activity onto the audio's real activity.

    Cross-correlated rather than searched with a scoring loop: one FFT-free `np.correlate` over a ~10k-frame
    envelope costs milliseconds, which is why this can run before EVERY alignment rather than only as a
    retry.

    Returns a fit with correlation 0.0 — never usable — when either envelope is empty or constant. A
    constant envelope carries no lag information at all, and `np.corrcoef` on one returns NaN, which would
    silently compare as False in every direction.
    """
    if len(actual) == 0 or len(expected) == 0:
        return ShiftFit(seconds=0.0, correlation=0.0)
    if float(actual.std()) == 0.0 or float(expected.std()) == 0.0:
        return ShiftFit(seconds=0.0, correlation=0.0)

    a = actual - actual.mean()
    b = expected - expected.mean()
    reach = max(1, int(max_shift / hop))
    correlation = np.correlate(a, b, mode="full")
    centre = len(b) - 1
    lo, hi = max(0, centre - reach), min(len(correlation), centre + reach + 1)
    window = correlation[lo:hi]
    if len(window) == 0:
        return ShiftFit(seconds=0.0, correlation=0.0)

    lag = int(np.argmax(window)) + (lo - centre)
    # Scored at the CHOSEN lag against the real envelope, not read off the correlation's height: a tall dot
    # product says two mostly-on signals overlap, while r says they agree in shape.
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

    PREFER THE VOCALS STEM where one exists: measured residuals are 10-20 ms against it and 140-150 ms
    against the full mix, because an instrumental bed fills the gaps the fit reads. The mix still works and
    still refuses a wrong song (r = -0.10 there), so an align job with no separated stem is corrected too —
    just less precisely.
    """
    actual = envelope(signal, rate, hop)
    return fit_shift(actual, expected_envelope(spans, len(actual), hop), hop=hop, max_shift=max_shift)
