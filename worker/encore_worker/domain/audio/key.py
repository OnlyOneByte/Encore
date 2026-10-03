"""Pure-numpy musical key detection (Krumhansl-Schmuckler) — the `songProfile.key*` half of the artifact.

Fold the signal's spectrum into a 12-bin pitch-class profile, then correlate that against all 24 major/minor
key templates. Runs on the INSTRUMENTAL stem, never the vocals (XW-07 for the tri-state). Why correlation and
not a dot product, what the band bounds are for, and why these weights are experimental data rather than
tunables: `docs/arch/05-worker.md` §3.1.
"""

from __future__ import annotations

from typing import cast

import numpy as np

# Krumhansl & Kessler (1982) probe-tone key profiles, index 0 = the tonic. EXPERIMENTAL DATA, not a
# tunable: do not "clean up" the numbers (docs/arch/05-worker.md §3.1).
_KS_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64
)
_KS_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64
)

# The MIDI band the chromagram folds, bounded below the rfft resolution limit at this frame size on
# purpose (docs/arch/05-worker.md §3.1).
_MIN_MIDI = 24  # C1
_MAX_MIDI = 108  # C8


def _build_key_templates() -> np.ndarray:
    """The 24 templates as a (24, 12) matrix — C..B major then C..B minor, each the K-S profile rotated by
    its tonic — precomputed so scoring is one matrix correlation."""
    rows = []
    for tonic in range(12):
        rows.append(np.roll(_KS_MAJOR, tonic))
    for tonic in range(12):
        rows.append(np.roll(_KS_MINOR, tonic))
    return np.vstack(rows)


_TEMPLATES = _build_key_templates()


def chromagram(samples: np.ndarray, sample_rate: int, *, frame: int = 8192, hop: int = 4096) -> np.ndarray:
    """Fold a mono signal into a 12-bin pitch-class energy profile, summed over the whole signal.

    Per frame a Hann-windowed rfft, then every in-band bin added to the pitch class it rounds to. Returns a
    length-12 float64 vector L1-normalised to sum 1, all-zero for a silent signal so the caller can read "no
    tonal content" rather than divide by zero. docs/arch/05-worker.md §3.1.
    """
    x = np.asarray(samples, dtype=np.float64).ravel()
    if x.size == 0:
        return np.zeros(12, dtype=np.float64)

    # The bin -> pitch-class map is the same every frame, so it is built once outside the loop.
    freqs = np.fft.rfftfreq(frame, d=1.0 / sample_rate)
    with np.errstate(divide="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.where(freqs > 0, freqs, np.nan) / 440.0)
    in_band = np.isfinite(midi) & (midi >= _MIN_MIDI) & (midi <= _MAX_MIDI)
    # In-band bins only: rounding and casting the NaN DC bin would raise "invalid value in cast". Out-of-band
    # bins keep the sentinel -1 and are never indexed.
    pitch_class = np.full(freqs.shape, -1, dtype=np.int64)
    pitch_class[in_band] = np.rint(midi[in_band]).astype(np.int64) % 12

    window = np.hanning(frame)
    chroma = np.zeros(12, dtype=np.float64)

    if x.size < frame:
        # Shorter than one frame: zero-pad to one rather than skip it (docs/arch/05-worker.md §3.1).
        x = np.pad(x, (0, frame - x.size))

    for start in range(0, x.size - frame + 1, hop):
        seg = x[start : start + frame] * window
        mag = np.abs(np.fft.rfft(seg))
        # One scatter pass; masked (-1) bins are dropped by only indexing the in-band ones.
        np.add.at(chroma, pitch_class[in_band], mag[in_band])

    total = chroma.sum()
    if total <= 0:
        return np.zeros(12, dtype=np.float64)
    return cast("np.ndarray", chroma / total)


def _pearson_against_templates(chroma: np.ndarray) -> np.ndarray:
    """Pearson correlation of the observed chroma against every one of the 24 templates → (24,).

    Mean-centred and magnitude-normalised rather than a dot product (docs/arch/05-worker.md §3.1). Guards
    the zero-variance case so 0/0 = nan cannot poison the argmax."""
    c = chroma - chroma.mean()
    c_norm = np.linalg.norm(c)
    if c_norm == 0:
        return np.zeros(_TEMPLATES.shape[0], dtype=np.float64)
    t = _TEMPLATES - _TEMPLATES.mean(axis=1, keepdims=True)
    t_norm = np.linalg.norm(t, axis=1)
    t_norm[t_norm == 0] = 1.0  # templates never have zero variance, but never divide by zero
    return cast("np.ndarray", (t @ c) / (t_norm * c_norm))


def key_from_chroma(chroma: np.ndarray) -> tuple[int | None, str | None, float | None]:
    """Best (tonic 0-11, mode, confidence) for a 12-bin chroma, or all-None for an empty one.

    `confidence` is the winning Pearson correlation clamped to 0..1, which is what makes it comparable
    across songs; near 0 means no key the algorithm believes in (docs/arch/05-worker.md §3.1)."""
    if chroma is None or np.asarray(chroma).sum() <= 0:
        return None, None, None
    scores = _pearson_against_templates(np.asarray(chroma, dtype=np.float64))
    best = int(np.argmax(scores))
    tonic = best % 12
    mode = "major" if best < 12 else "minor"
    # A negative correlation means "less like this key than average", and floors at 0.
    confidence = float(max(0.0, scores[best]))
    return tonic, mode, confidence


def detect_key(samples: np.ndarray, sample_rate: int) -> tuple[int | None, str | None, float | None]:
    """End-to-end: mono samples + rate → (tonic, mode, confidence), for a caller holding raw audio."""
    return key_from_chroma(chromagram(samples, sample_rate))


# Diagnostics only; the wire shape is the int.
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def key_name(tonic: int | None, mode: str | None) -> str | None:
    """Human label like 'A minor' for a detected key, or None. Diagnostics only."""
    if tonic is None or mode is None:
        return None
    return f"{PITCH_CLASS_NAMES[tonic % 12]} {mode}"
