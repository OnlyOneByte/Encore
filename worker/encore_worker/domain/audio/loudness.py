"""Integrated loudness measurement — the `songProfile` level half, per EBU R128 / ITU-R BS.1770-4.

Real integrated LUFS over the INSTRUMENTAL with `pyloudnorm`, TRI-STATE like every analysis half: a level that
cannot be trusted is `None`, never a fabricated default. `docs/arch/05-worker.md` §3 and §3.1.
"""

from __future__ import annotations

import numpy as np

from encore_worker.domain.audio.wav import read_wav_mono

# Seconds in one BS.1770 gating block: a shorter signal cannot be gated at all and the meter raises.
_MIN_GATING_BLOCK_SEC = 0.4

# Peak sample magnitude at or below which a stem is digital silence and so unmeasurable: the 16-bit
# floor on this box (docs/arch/05-worker.md §3.1).
_SILENCE_PEAK = 1.0 / 32768.0  # one 16-bit LSB


def measure_lufs(wav_path: str | None) -> float | None:
    """Integrated loudness of a PCM WAV in LUFS (BS.1770-4), or `None` when it cannot be measured.

    A real measurement is a negative float; `None` is never a default number.
    """
    if not wav_path:
        return None
    try:
        samples, sample_rate = read_wav_mono(wav_path)
    except Exception:  # noqa: BLE001 — an unreadable stem is unmeasurable, never fatal
        return None
    return measure_lufs_samples(samples, sample_rate)


def measure_lufs_samples(samples: np.ndarray | None, sample_rate: int) -> float | None:
    """The measurement itself, over samples a caller has ALREADY decoded.

    Exists so `build_song_profile` can decode the instrumental once and hand the same array to both key
    detection and this meter (docs/arch/05-worker.md §3.1). Same tri-state contract as the path form.
    """
    if samples is None or sample_rate <= 0:
        return None
    try:
        import pyloudnorm as pyln

        if samples.size < int(_MIN_GATING_BLOCK_SEC * sample_rate):
            return None
        if float(np.max(np.abs(samples))) <= _SILENCE_PEAK:
            return None

        meter = pyln.Meter(sample_rate)  # BS.1770-4 meter at the stem's own rate
        loudness = float(meter.integrated_loudness(samples))
        # A gated measurement over near-silence can come back -inf or nan, which is unmeasurable.
        if not np.isfinite(loudness):
            return None
        return loudness
    except Exception:  # noqa: BLE001 — analysis must never fail the process; unmeasurable → None
        return None
