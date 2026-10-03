"""Pure-numpy vocal-range summary — the `songProfile.*Midi`/`histogram` half of the stems artifact.

A per-frame normalised autocorrelation f0 detector with a clarity gate, plus hz->MIDI, deliberately simple
because the VOCALS stem is already isolated. Which two questions the four published numbers answer, and the
band, the clarity knife and the hop's single source of truth: `docs/arch/05-worker.md` §3 and §3.1, XW-07.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from encore_worker.domain.audio.wav import read_wav_mono

# The f0 band in Hz: a padded human singing range, which also bounds the lag search.
_FMIN_HZ = 65.0
_FMAX_HZ = 1100.0

# Normalised-autocorrelation periodicity, 0..1, at or above which a frame counts as voiced.
_CLARITY_THRESHOLD = 0.5

# Samples between analysis frames, and the SINGLE source of truth for the hop: the histogram's seconds
# axis is read off it (docs/arch/05-worker.md §3.1).
_DEFAULT_HOP = 512


def hz_to_midi(freq: float) -> float:
    """Frequency (Hz) → fractional MIDI note number, A4 = 440 Hz = 69, in the standard 12-TET map."""
    return 69.0 + 12.0 * math.log2(freq / 440.0)


@dataclass
class PitchFrame:
    """One analysis frame's pitch estimate. `voiced` gates whether it counts toward the range at all: an
    unvoiced frame has no meaningful pitch and must never widen the range or fill a histogram bucket."""

    time_sec: float
    f0_hz: float
    midi: float
    voiced: bool
    clarity: float = 0.0


def _detect_f0(frame: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """Normalised-autocorrelation f0 for one frame → (f0_hz, clarity 0..1), or (0, 0) when the frame is
    too short or has no periodic peak. Why clarity is loudness-independent: docs/arch/05-worker.md §3.1."""
    n = frame.size
    min_lag = max(1, int(sample_rate / _FMAX_HZ))
    max_lag = min(n - 1, int(sample_rate / _FMIN_HZ))
    if max_lag <= min_lag:
        return 0.0, 0.0

    frame = frame - frame.mean()  # DC removed, or a small offset masquerades as period-0 energy
    energy = float(np.dot(frame, frame))
    if energy <= 0:
        return 0.0, 0.0

    # rfft, NOT `np.correlate(mode="full")`, and zero-padded against circular wrap:
    # docs/arch/05-worker.md §3.1 has the measurement and the reason.
    size = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(frame, size)
    corr = np.fft.irfft(spec * np.conj(spec), size)[:n] / energy

    window = corr[min_lag : max_lag + 1]
    if window.size == 0:
        return 0.0, 0.0
    peak_idx = int(np.argmax(window))
    lag = min_lag + peak_idx
    clarity = float(window[peak_idx])

    # Sub-sample lag, or a 220 Hz tone quantises into a neighbouring semitone.
    if 0 < lag < corr.size - 1:
        a, b, c = corr[lag - 1], corr[lag], corr[lag + 1]
        denom = a - 2.0 * b + c
        if denom != 0:
            lag = lag + 0.5 * (a - c) / denom

    if lag <= 0:
        return 0.0, 0.0
    return sample_rate / lag, clarity


def extract_pitch_track(
    samples: np.ndarray, sample_rate: int, *, frame: int = 2048, hop: int = _DEFAULT_HOP
) -> list[PitchFrame]:
    """Per-frame monophonic pitch track over a mono signal.

    A frame is `voiced` only when its clarity clears `_CLARITY_THRESHOLD` and its f0 lands in the singing
    band. Unvoiced frames are still emitted, so the caller sees the full timeline.
    """
    x = np.asarray(samples, dtype=np.float64).ravel()
    frames: list[PitchFrame] = []
    if x.size < frame:
        return frames
    for start in range(0, x.size - frame + 1, hop):
        seg = x[start : start + frame]
        f0, clarity = _detect_f0(seg, sample_rate)
        voiced = clarity >= _CLARITY_THRESHOLD and _FMIN_HZ <= f0 <= _FMAX_HZ
        midi = hz_to_midi(f0) if f0 > 0 else 0.0
        frames.append(
            PitchFrame(time_sec=start / sample_rate, f0_hz=f0, midi=midi, voiced=voiced, clarity=clarity)
        )
    return frames


def summarize_range(frames: list[PitchFrame], *, hop_sec: float | None = None) -> dict[str, object]:
    """Summarise a pitch track into the vocal-range half of the songProfile, voiced frames only.

    ALL fields None when nothing is voiced — silence, an instrumental, or a tracker that found nothing —
    which is the load-bearing empty case (`docs/arch/05-worker.md` §3). `hop_sec` is seconds per frame and
    is inferred from consecutive timestamps when omitted.
    """
    voiced = [f for f in frames if f.voiced]
    if not voiced:
        return {
            "lowMidi": None,
            "highMidi": None,
            "p05Midi": None,
            "p95Midi": None,
            "histogram": None,
        }

    midis = np.array([f.midi for f in voiced], dtype=np.float64)
    low = float(midis.min())
    high = float(midis.max())
    # Linearly interpolated, so one voiced frame gives p05 == p95: the right degenerate answer.
    p05 = float(np.percentile(midis, 5))
    p95 = float(np.percentile(midis, 95))

    if hop_sec is None:
        hop_sec = _infer_hop_sec(frames)

    # SECONDS per semitone bin, index 0 = round(low), so a frame lands on the semitone a listener names.
    low_semitone = int(round(low))
    high_semitone = int(round(high))
    n_bins = high_semitone - low_semitone + 1
    histogram = [0.0] * n_bins
    for f in voiced:
        idx = int(round(f.midi)) - low_semitone
        if 0 <= idx < n_bins:  # guard rounding at the extremes landing one bin outside
            histogram[idx] += hop_sec

    return {
        "lowMidi": low,
        "highMidi": high,
        "p05Midi": p05,
        "p95Midi": p95,
        "histogram": histogram,
    }


def _infer_hop_sec(frames: list[PitchFrame]) -> float:
    """Seconds per frame from consecutive timestamps: the first POSITIVE gap, so identical timestamps at
    the head cannot collapse it to zero. 0.0 for a single frame."""
    for i in range(1, len(frames)):
        gap = frames[i].time_sec - frames[i - 1].time_sec
        if gap > 0:
            return gap
    return 0.0


def summarize_wav(path: str) -> dict[str, object]:
    """Read a raw stem, track its pitch, and summarise. Raises on an unreadable file, which the caller
    degrades to nulls."""
    samples, sample_rate = read_wav_mono(path)
    frames = extract_pitch_track(samples, sample_rate)
    hop_sec = _DEFAULT_HOP / sample_rate  # SAME constant extract_pitch_track defaults its hop to
    return summarize_range(frames, hop_sec=hop_sec)
