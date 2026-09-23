"""Pure-numpy musical key detection — the `songProfile.key*` half of the stems artifact.

Runs on the INSTRUMENTAL stem, never the vocals. A lead vocal is monophonic: at any instant it names
one pitch class, so its chromagram is dominated by whatever note is being sung and the tonal-hierarchy
correlation collapses to "which note appears most" — key-ambiguous by construction. The backing track
carries the chords (the actual harmony the key lives in), so the instrumental is the correct signal.

Method (Krumhansl-Schmuckler): fold the whole signal's spectrum into a 12-bin pitch-class profile
(the chromagram), then correlate that observed profile against all 24 major/minor key templates
(each a rotation of Krumhansl's two probe-tone profiles). The best-correlating rotation is the key.
Correlation, not raw dot product, so the score is scale-invariant — a loud song and a quiet song of
the same key score the same, which is what makes `confidence` comparable ACROSS songs.

numpy + stdlib only. No torch, no librosa: the chromagram is a plain rfft with a log-frequency→
pitch-class bin map. This is deliberately not real-time; it runs once per process on a stem already on
disk, so clarity beats speed.
"""

from __future__ import annotations

from typing import cast

import numpy as np

# Krumhansl & Kessler (1982) probe-tone key profiles: the perceived tonal hierarchy of each scale
# degree, index 0 = the tonic. These are THE reference weights the K-S algorithm correlates against;
# do not "clean up" the numbers — they are experimental data, not a tunable.
_KS_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64
)
_KS_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64
)

# MIDI note number of the lowest pitch class bin accumulated (C1≈32.7Hz; above ~C8 there is almost
# no chordal energy). This is deliberately set to BOUND the fold BELOW the rfft resolution limit at
# this frame size: bass fundamentals (~31-65Hz) carry real chordal energy and are kept in on purpose,
# not filtered out as rumble.
_MIN_MIDI = 24  # C1
_MAX_MIDI = 108  # C8


def _build_key_templates() -> np.ndarray:
    """The 24 key templates as a (24, 12) matrix: rows 0..11 are C..B major, 12..23 are C..B minor.
    Each row is the K-S profile ROTATED so index = pitch class (rotation by the tonic). Precomputed
    once so key_from_chroma is a single matrix correlation, not 24 python-loop correlations."""
    rows = []
    for tonic in range(12):
        rows.append(np.roll(_KS_MAJOR, tonic))
    for tonic in range(12):
        rows.append(np.roll(_KS_MINOR, tonic))
    return np.vstack(rows)


_TEMPLATES = _build_key_templates()


def chromagram(samples: np.ndarray, sample_rate: int, *, frame: int = 8192, hop: int = 4096) -> np.ndarray:
    """Fold a mono signal into a 12-bin pitch-class energy profile, summed over the whole signal.

    Per frame: a Hann-windowed rfft → magnitude spectrum, then every bin whose centre frequency falls
    in [_MIN_MIDI, _MAX_MIDI] is added to the pitch class it rounds to (freq→MIDI→ % 12). Summing
    magnitudes across frames (not averaging per frame) is fine because the final vector is
    L1-normalized — what matters is the RELATIVE weight of the twelve classes, and a long steady
    chord and a short one contribute in proportion to how long they sound, which is musically right.

    Returns a length-12 float64 vector, L1-normalized to sum 1 (all-zero when the signal is silent, so
    the caller can detect "no tonal content" rather than dividing by zero).
    """
    x = np.asarray(samples, dtype=np.float64).ravel()
    if x.size == 0:
        return np.zeros(12, dtype=np.float64)

    # Same for every frame, so compute the bin->pitch-class map ONCE outside the frame loop.
    freqs = np.fft.rfftfreq(frame, d=1.0 / sample_rate)
    with np.errstate(divide="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.where(freqs > 0, freqs, np.nan) / 440.0)
    in_band = np.isfinite(midi) & (midi >= _MIN_MIDI) & (midi <= _MAX_MIDI)
    # Compute the pitch class ONLY for in-band bins — rounding+casting the NaN DC bin (freq 0) would
    # raise "invalid value in cast". Out-of-band bins keep sentinel -1 and are never indexed.
    pitch_class = np.full(freqs.shape, -1, dtype=np.int64)
    pitch_class[in_band] = np.rint(midi[in_band]).astype(np.int64) % 12

    window = np.hanning(frame)
    chroma = np.zeros(12, dtype=np.float64)

    if x.size < frame:
        # A clip shorter than one frame: zero-pad to a single frame rather than skipping it, so a
        # short synthesized test tone still produces a chromagram.
        x = np.pad(x, (0, frame - x.size))

    for start in range(0, x.size - frame + 1, hop):
        seg = x[start : start + frame] * window
        mag = np.abs(np.fft.rfft(seg))
        # np.add.at scatters each bin's magnitude into its pitch class in one pass; masked (-1) bins
        # are dropped by only indexing the in-band ones.
        np.add.at(chroma, pitch_class[in_band], mag[in_band])

    total = chroma.sum()
    if total <= 0:
        return np.zeros(12, dtype=np.float64)
    return cast("np.ndarray", chroma / total)


def _pearson_against_templates(chroma: np.ndarray) -> np.ndarray:
    """Pearson correlation of the observed chroma against every one of the 24 templates → (24,).

    Pearson (mean-centred, magnitude-normalized) rather than dot product so the score does not reward
    a template merely for having large numbers, and so a flat/atonal chroma scores near zero against
    ALL keys — that near-zero max is exactly what `confidence` reports. Guards the zero-variance case
    (a perfectly flat chroma) to avoid 0/0 = nan poisoning the argmax."""
    c = chroma - chroma.mean()
    c_norm = np.linalg.norm(c)
    if c_norm == 0:
        return np.zeros(_TEMPLATES.shape[0], dtype=np.float64)
    t = _TEMPLATES - _TEMPLATES.mean(axis=1, keepdims=True)
    t_norm = np.linalg.norm(t, axis=1)
    t_norm[t_norm == 0] = 1.0  # templates never have zero variance, but never divide by zero
    return cast("np.ndarray", (t @ c) / (t_norm * c_norm))


def key_from_chroma(chroma: np.ndarray) -> tuple[int | None, str | None, float | None]:
    """Best (tonic 0-11, mode, confidence) for a 12-bin chroma, or (None, None, None) when the chroma
    is empty (silence / no tonal content). `confidence` is the winning Pearson correlation clamped to
    0..1: a normalized measure so it compares across songs — ~0.8+ is a confident tonal read, near 0
    means the algorithm found no key it believes in (noise, drums-only, silence)."""
    if chroma is None or np.asarray(chroma).sum() <= 0:
        return None, None, None
    scores = _pearson_against_templates(np.asarray(chroma, dtype=np.float64))
    best = int(np.argmax(scores))
    tonic = best % 12
    mode = "major" if best < 12 else "minor"
    # A negative correlation means "less like this key than average" — floor at 0 so confidence is a
    # clean 0..1 and a keyless signal reads as 0, not a small negative number.
    confidence = float(max(0.0, scores[best]))
    return tonic, mode, confidence


def detect_key(samples: np.ndarray, sample_rate: int) -> tuple[int | None, str | None, float | None]:
    """End-to-end: mono samples + rate → (tonic, mode, confidence). Convenience wrapper over
    chromagram + key_from_chroma for callers that have raw audio rather than a precomputed chroma."""
    return key_from_chroma(chromagram(samples, sample_rate))


# Pitch-class names for logging/debugging only (never used for the wire shape, which is the int).
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def key_name(tonic: int | None, mode: str | None) -> str | None:
    """Human label like 'A minor' for a detected key, or None. Diagnostics only."""
    if tonic is None or mode is None:
        return None
    return f"{PITCH_CLASS_NAMES[tonic % 12]} {mode}"
