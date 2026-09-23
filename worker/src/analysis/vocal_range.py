"""Pure-numpy vocal-range summary — the `songProfile.*Midi`/`histogram` half of the stems artifact.

Runs on the VOCALS stem: this describes where the ORIGINAL singer actually sang, which is what a
later "shift the key into my range" feature needs. It answers two different questions the phone UI
wants to keep separate:

  - the ABSOLUTE extremes (lowMidi/highMidi): the single lowest and highest voiced notes. Useful for
    "can I even reach this song", but by definition driven by one held note or one grace note, so a
    poor summary of the song's tessitura on its own.
  - where the song LIVES (p05Midi/p95Midi): the 5th and 95th percentiles of voiced pitch. Trimming
    the extreme 5% at each end is what turns "one screamed high note" into "the range you sing for
    four minutes" — the number a singer actually decides on.

The `pitch_track.py` module the task description referred to does not exist in this repo (there is
only `pitch.py`, a pitch-SHIFT ffmpeg helper — a different thing). So the pure-numpy tracker lives
here: a WAV reader, an autocorrelation-based monophonic f0 detector, and hz→MIDI. It is deliberately
simple — a per-frame normalized autocorrelation with a clarity gate — because the vocals stem is
already isolated (monophonic-ish) and we only need per-frame pitch to bucket into semitones, not a
transcription-grade tracker.

numpy + stdlib ONLY (wave is stdlib). No torch, no soundfile: the stem is a plain PCM WAV in scratch
at this point in the process, before it is encoded to m4a.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .wav import read_wav_mono

# Human singing spans roughly the bass low E (~82 Hz) to a soprano high C (~1046 Hz). Clamp the f0
# search to a padded version of that: below ~65 Hz is almost always a separation artifact / rumble,
# above ~1100 Hz the vocals stem is mostly breath and consonant noise, not a sung pitch. The clamp
# also bounds the autocorrelation lag search, which is what keeps this cheap.
_FMIN_HZ = 65.0
_FMAX_HZ = 1100.0

# A frame is unvoiced unless its normalized-autocorrelation peak clears this. Sung vowels are highly
# periodic (peak ~0.9+); breath, sibilants, and separation bleed are not. 0.5 is the classic voiced/
# unvoiced knife — high enough to reject noise, low enough to keep quiet-but-pitched singing.
_CLARITY_THRESHOLD = 0.5

# The single source of truth for the analysis frame hop. `extract_pitch_track`'s `hop` default and
# the seconds-per-frame `summarize_wav` uses MUST be the same number — the histogram's seconds axis
# is (voiced frame count) x (hop / sample_rate), so if the two ever disagree every published duration
# is scaled wrong (halved/doubled) with no other field moving and no test failing. Naming it once and
# deriving hop_sec from the same constant is what makes that desync impossible rather than unenforced.
_DEFAULT_HOP = 512


def hz_to_midi(freq: float) -> float:
    """Frequency (Hz) → fractional MIDI note number. A4=440Hz→69. Matches the standard 12-TET map so
    a detected 440Hz buckets to the same semitone the key detector calls A."""
    return 69.0 + 12.0 * math.log2(freq / 440.0)


@dataclass
class PitchFrame:
    """One analysis frame's pitch estimate. `voiced` gates whether it counts toward the range: an
    unvoiced frame (rest, breath, consonant) has no meaningful pitch and must never widen the range or
    fill a histogram bucket. `midi` is fractional; `time_sec` is the frame's start time (used to turn
    the per-semitone frame COUNT into SECONDS)."""

    time_sec: float
    f0_hz: float
    midi: float
    voiced: bool
    clarity: float = 0.0


def _detect_f0(frame: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """Normalized-autocorrelation f0 for one frame → (f0_hz, clarity 0..1).

    Divides the biased autocorrelation by its zero-lag value so `clarity` is a periodicity measure in
    0..1 that does NOT depend on loudness (a quiet vowel and a loud vowel of the same pitch score the
    same clarity), which is what makes the voiced/unvoiced threshold a fixed constant. Searches only
    lags in [fmax, fmin] period range, then parabolic-interpolates the peak lag for sub-sample
    resolution. Returns (0, 0) when the frame is too short or has no periodic peak."""
    n = frame.size
    min_lag = max(1, int(sample_rate / _FMAX_HZ))
    max_lag = min(n - 1, int(sample_rate / _FMIN_HZ))
    if max_lag <= min_lag:
        return 0.0, 0.0

    frame = frame - frame.mean()  # remove DC so a small offset can't masquerade as period-0 energy
    energy = float(np.dot(frame, frame))
    if energy <= 0:
        return 0.0, 0.0

    # Autocorrelation via rfft, NOT np.correlate(mode="full") (numpy's direct O(n^2) convolution,
    # 17x slower for bit-identical output). Zero-pad to a power of two >= 2n-1 so the CIRCULAR
    # correlation an FFT computes equals the LINEAR one — without padding, lag k wraps and picks up
    # energy from the frame's opposite end.
    size = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(frame, size)
    corr = np.fft.irfft(spec * np.conj(spec), size)[:n] / energy

    window = corr[min_lag : max_lag + 1]
    if window.size == 0:
        return 0.0, 0.0
    peak_idx = int(np.argmax(window))
    lag = min_lag + peak_idx
    clarity = float(window[peak_idx])

    # Parabolic interpolation around the integer peak for a sub-sample lag (finer than the raw bin,
    # so a 220Hz tone doesn't quantize to a neighbouring semitone). Guard the array edges.
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
    """Per-frame monophonic pitch track over a mono signal. Each frame gets a normalized-
    autocorrelation f0 + clarity; a frame is `voiced` only when its clarity clears _CLARITY_THRESHOLD
    AND its f0 lands in the human singing band. Unvoiced frames are still emitted (with voiced=False)
    so the caller sees the full timeline, but they carry no usable pitch."""
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


def summarize_range(frames: list[PitchFrame], *, hop_sec: float | None = None) -> dict:
    """Summarize a pitch track into the vocal-range half of the songProfile.

    Considers ONLY voiced frames — an unvoiced frame has no pitch and must never widen the range.
    Returns lowMidi/highMidi (absolute voiced extremes), p05Midi/p95Midi (5th/95th percentile = the
    lived-in range), and a per-semitone histogram of SECONDS sung, with index 0 = the lowMidi semitone.

    ALL fields None when there are no voiced frames — a stem that is silence, an instrumental, or a
    tracker that found nothing. This is the load-bearing empty case: the caller still publishes the
    profile object with these nulls so core reads "the step ran, found nothing" rather than "still
    processing".

    `hop_sec` is seconds-per-frame; when omitted it is inferred from consecutive frame timestamps
    (falling back to 0 for a single frame, so the histogram then counts a single frame as 0s but the
    range/percentiles are still correct)."""
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
    # np.percentile with linear interpolation — for one voiced frame p05==p95==that note, which is the
    # right degenerate answer (the singer sang exactly one pitch).
    p05 = float(np.percentile(midis, 5))
    p95 = float(np.percentile(midis, 95))

    if hop_sec is None:
        hop_sec = _infer_hop_sec(frames)

    # Histogram is SECONDS per semitone bin, index 0 = round(low). Rounding both the bin count and each
    # frame's midi to the nearest semitone means a frame contributes to exactly the semitone a listener
    # would name it — the histogram is "how long did the singer spend on each note", which the phone can
    # render as a range heat-strip.
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
    """Seconds-per-frame from consecutive timestamps. Uses the first positive gap it finds so a couple
    of identical timestamps at the head don't collapse it to zero; 0.0 for a single frame."""
    for i in range(1, len(frames)):
        gap = frames[i].time_sec - frames[i - 1].time_sec
        if gap > 0:
            return gap
    return 0.0


def summarize_wav(path: str) -> dict:
    """Convenience: read a PCM WAV, track its pitch, and summarize. Used by the processors on the
    vocals stem. Raises on an unreadable file — the caller wraps this in best-effort try/except and
    publishes nulls, so a failure here degrades to an empty profile rather than a failed process."""
    samples, sample_rate = read_wav_mono(path)
    frames = extract_pitch_track(samples, sample_rate)
    hop_sec = _DEFAULT_HOP / sample_rate  # SAME constant extract_pitch_track defaults its hop to
    return summarize_range(frames, hop_sec=hop_sec)
