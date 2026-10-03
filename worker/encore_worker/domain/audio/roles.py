"""Which of two separated stems is the BACKING TRACK, decided from the audio rather than from a filename.

The discriminator is the fraction of spectral energy below 250 Hz, which a kick and bass carry and an isolated
voice does not; `None` rather than a guess when the margin is thin. Why it is measured at job time, the
populations, the filename inversion this reproduced and the genre limitation: `docs/arch/05-worker.md` §2.2
and `docs/benchmarks/stem-separation/README.md`, "Stem roles, measured from the audio".
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Hz below which a backing track's kick and bass live and a voice does not. Not tuned: roughly the top of
#: the bass register, and the measured margin is wide enough that the exact value does not matter.
BASS_CUTOFF_HZ = 250.0

#: How much more low-frequency energy the instrumental must carry, as a ratio, before the answer is trusted.
#: Almost a factor of four below the smallest margin measured (`docs/benchmarks/stem-separation/README.md`,
#: "Stem roles, measured from the audio"), refusing being the recoverable direction.
MIN_RATIO = 3.0

#: FFT size in samples for the spectral estimate, ~0.74 s at 44.1 kHz: long enough to resolve a 40 Hz bin
#: rather than smear it into DC.
_WINDOW = 1 << 15


@dataclass(frozen=True, slots=True)
class Roles:
    """Which path holds which stem, and the evidence."""

    instrumental_path: str
    vocals_path: str
    #: The two bass fractions, instrumental first — the evidence, so a surprising verdict is diagnosable.
    instrumental_bass: float
    vocals_bass: float

    @property
    def ratio(self) -> float:
        return self.instrumental_bass / max(self.vocals_bass, 1e-9)


def bass_fraction(signal: np.ndarray, rate: int, cutoff: float = BASS_CUTOFF_HZ) -> float:
    """Share of this signal's spectral energy below `cutoff`, in 0..1, as a POWER share.

    Averaged over spaced windows, or one landing on an intro describes that bar instead of the track.
    """
    mono = signal.mean(axis=1) if signal.ndim > 1 else signal
    if len(mono) < _WINDOW:
        # Shorter than one window: pad to one rather than refuse to measure.
        mono = np.pad(mono, (0, _WINDOW - len(mono)))
    window = np.hanning(_WINDOW)
    freqs = np.fft.rfftfreq(_WINDOW, 1.0 / rate)
    low = freqs < cutoff

    bass = 0.0
    total = 0.0
    # Two windows at a stride: a statistic about the track, not a spectrogram.
    for start in range(0, max(1, len(mono) - _WINDOW), _WINDOW * 2):
        segment = mono[start : start + _WINDOW]
        if len(segment) < _WINDOW:
            break
        power = np.abs(np.fft.rfft(segment * window)) ** 2
        bass += float(power[low].sum())
        total += float(power.sum())
    return bass / total if total > 0 else 0.0


def classify(
    first: tuple[str, np.ndarray, int],
    second: tuple[str, np.ndarray, int],
    *,
    min_ratio: float = MIN_RATIO,
) -> Roles | None:
    """Decide which of two `(path, signal, rate)` stems is the backing track. `None` means "cannot tell".

    Too-similar low-frequency content happens for material with no bass and for a model that returned the
    mixture twice.
    """
    a_path, a_signal, a_rate = first
    b_path, b_signal, b_rate = second
    a = bass_fraction(a_signal, a_rate)
    b = bass_fraction(b_signal, b_rate)

    higher, lower = (a, b) if a >= b else (b, a)
    if lower <= 0.0:
        # No low-frequency energy at all is as clear as this measurement gets — but only if the other
        # stem has some.
        if higher <= 0.0:
            return None
    elif higher / lower < min_ratio:
        return None

    if a >= b:
        return Roles(instrumental_path=a_path, vocals_path=b_path, instrumental_bass=a, vocals_bass=b)
    return Roles(instrumental_path=b_path, vocals_path=a_path, instrumental_bass=b, vocals_bass=a)
