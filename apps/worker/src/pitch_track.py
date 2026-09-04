"""Pitch extraction — per-frame fundamental frequency (f0) from the isolated vocal stem.

This is the first half of SingStar-style scoring: turn a mono audio signal into a time-stamped
pitch track (Hz + MIDI + voiced flag), which the scorer compares against the singer's live mic pitch.

PURE + dependency-light: just numpy + the stdlib `wave` reader — NO torch, NO scipy, NO soundfile —
so the whole tracker unit-tests in-sandbox against a synthesized tone (the pitch.py convention:
pure DSP split from the heavy binaries). It runs on the isolated `vocals.wav` Demucs already emits.

Algorithm: framed **normalized cross-correlation** (NCCF) f0 estimation, the same algorithm the
phone's mic detector runs (`apps/core/src/lib/mic/pitch-detect.ts`) — deliberately, because the two
are the two halves of one comparison. A reference track built by a different estimator than the mic
it is scored against contributes its own bias to every score.

Per frame: take the linear autocorrelation (via FFT), divide each lag by the energy of the two
overlapping windows so the result is a true correlation coefficient, pick the shortest-lag strong
peak inside the vocal-range window [sr/fmax .. sr/fmin], refine it with parabolic interpolation, and
derive f0 = sr / lag. A frame is `voiced` only when it has enough energy AND a strong enough
correlation peak — silence / unpitched noise comes back `voiced=False, f0=0`.
"""
from __future__ import annotations

import wave
from dataclasses import dataclass
from typing import Any

import numpy as np

# Vocal-range defaults. FMIN ≈ C2 (65 Hz, low male), FMAX ≈ D6 (1175 Hz, high female + harmonics
# headroom). A tighter range makes the lag search cheaper and rejects sub-harmonic octave errors.
FMIN_HZ = 65.0
FMAX_HZ = 1175.0

# Analysis framing. A 40 ms frame holds ≥2 full cycles even at FMIN (65 Hz → 15.4 ms/cycle), which
# autocorrelation needs; a 10 ms hop gives a 100 Hz pitch-track rate (smooth enough for scoring).
FRAME_MS = 40.0
HOP_MS = 10.0

# Voicing gates: a frame must clear BOTH to be called voiced.
#  • RMS floor (relative to the clip's peak RMS) rejects silence / breaths.
#  • normalized-autocorrelation floor rejects unpitched noise (no periodicity → low peak).
VOICED_RMS_FLOOR = 0.10
VOICED_CORR_FLOOR = 0.30

# A normalized ACF peaks just as high at a multiple of the true period as at the period itself, so a
# plain argmax can latch onto a subharmonic and report an octave (or two) low. Instead take the
# SHORTEST-lag peak clearing this fraction of the global best — the fundamental, McLeod-style. Mirrors
# the 0.9 the phone's detector uses; both ends of the comparison must make the same octave choice.
PEAK_PICK_RATIO = 0.9

# NCCF divides by the energy of the two overlapping windows, and at a lag approaching the frame length
# those windows are a handful of samples — enough for noise to normalize to ±1 and read as a perfect
# pitch. Never search past half the frame, so at least half of it always contributes. This never binds
# in production framing (a 40 ms frame at 44.1 kHz searches to lag 678 of 1764) — it bounds a caller
# passing a frame too short for the fmin it asked for.
MAX_LAG_FRACTION = 0.5

A4_HZ = 440.0
A4_MIDI = 69  # MIDI note number of A4 (concert A)


@dataclass
class PitchFrame:
    """One analysis frame's pitch estimate. `f0_hz`/`midi` are 0 when `voiced` is False."""

    time_sec: float
    f0_hz: float
    midi: float
    voiced: bool
    confidence: float  # normalized autocorrelation peak height, 0..1


# ── pure conversions ──────────────────────────────────────────────────────────────


def hz_to_midi(hz: float) -> float:
    """Frequency → (fractional) MIDI note number. 440 Hz → 69.0 (A4); an octave up adds 12."""
    if hz <= 0:
        return 0.0
    return A4_MIDI + 12.0 * float(np.log2(hz / A4_HZ))


def midi_to_hz(midi: float) -> float:
    """MIDI note number → frequency. 69 → 440.0 Hz. Inverse of hz_to_midi."""
    return A4_HZ * float(2.0 ** ((midi - A4_MIDI) / 12.0))


# ── single-frame f0 via autocorrelation ────────────────────────────────────────────


def _autocorrelation(frame: np.ndarray) -> np.ndarray:
    """RAW linear (non-circular) autocorrelation of a frame via FFT, lags 0..len-1.

    Zero-padding to ≥2N before the FFT makes the circular FFT correlation equal the linear one over
    the returned lag range (no wrap-around contamination).

    This is the UNNORMALIZED correlation and must not be peak-picked directly: acf[k] sums only the
    (N−k) overlapping products, so it decays with lag purely because fewer samples contribute. See
    `_normalized_correlation` for why that decay used to break low pitches outright."""
    n = frame.size
    size = 1
    while size < 2 * n:
        size *= 2
    spec = np.fft.rfft(frame, size)
    acf = np.fft.irfft(spec * np.conjugate(spec), size)[:n]
    return acf


def _normalized_correlation(frame: np.ndarray, min_lag: int, max_lag: int) -> np.ndarray:
    """Correlation coefficient per lag over [min_lag, max_lag] — NCCF, values in [-1, 1].

    Divides the raw correlation at each lag by `sqrt(E_head · E_tail)`, the energies of the two
    windows that actually overlap at that lag. That cancels the (N−k) triangular bias exactly, so a
    clean tone scores ≈1.0 at its period regardless of how long that period is.

    Why this matters rather than being a refinement: the raw ACF's bias is a *monotonic decay with
    lag*, which systematically favours SHORT lags — i.e. high pitches. On the production framing
    (40 ms at 44.1 kHz, searching to lag 678 of 1764 samples) the decay was steep enough to beat real
    periodicity for any pitch below ~147 Hz: a 110 Hz tone scored 0.818 at the fmax bound against
    0.773 at its true period, so argmax took the bound and reported ~1230 Hz — an octave and a half
    high, at confidence 0.84, which sails through the voicing gate. E2–C3 is the male vocal range, so
    every male singer would have been scored against a nonsense reference curve.

    Computed with prefix sums of squares, so each window energy is O(1) and the whole lag sweep stays
    vectorized."""
    n = frame.size
    acf = _autocorrelation(frame)
    prefix = np.concatenate(([0.0], np.cumsum(frame * frame)))  # prefix[i] = energy of frame[:i]

    lags = np.arange(min_lag, max_lag + 1)
    head = prefix[n - lags]              # energy of frame[0 : n-lag)
    tail = prefix[n] - prefix[lags]      # energy of frame[lag : n)
    scale = np.sqrt(head * tail)

    out = np.zeros(lags.size, dtype=np.float64)
    ok = scale > 0.0
    out[ok] = acf[lags[ok]] / scale[ok]
    return out


def estimate_f0(frame: np.ndarray, sample_rate: int, fmin: float = FMIN_HZ,
                fmax: float = FMAX_HZ) -> tuple[float, float]:
    """Estimate one frame's (f0_hz, confidence). Returns (0.0, …) when no periodic peak is found.

    confidence is the best normalized-correlation value found (1.0 = perfectly periodic), and is
    reported even when no f0 is returned so a caller can tell "unpitched" from "pitched but rejected".
    The voicing gates live in `extract_pitch_track`; this just reports the best periodicity found."""
    frame = frame.astype(np.float64)
    frame = frame - frame.mean()  # remove DC so a silent-with-offset frame doesn't read as periodic
    energy = float(np.dot(frame, frame))
    if energy <= 0.0:
        return 0.0, 0.0

    # Search only physically meaningful lags for the vocal range (see MAX_LAG_FRACTION).
    min_lag = max(1, int(sample_rate / fmax))
    max_lag = min(int(frame.size * MAX_LAG_FRACTION), int(sample_rate / fmin))
    if max_lag <= min_lag + 1:
        return 0.0, 0.0

    nccf = _normalized_correlation(frame, min_lag, max_lag)
    best = float(nccf.max())
    confidence = max(0.0, min(1.0, best))
    if best <= 0.0:
        return 0.0, confidence

    # Shortest-lag local maximum clearing PEAK_PICK_RATIO × best — the fundamental rather than a
    # subharmonic of it. Interior only, so the parabolic step below always has both neighbours.
    interior = nccf[1:-1]
    strong = (interior >= PEAK_PICK_RATIO * best) & (interior >= nccf[:-2]) & (interior >= nccf[2:])
    if not strong.any():
        return 0.0, confidence  # strong correlation but no clean peak (edge-dominated / noise)
    idx = int(np.argmax(strong)) + 1  # argmax finds the FIRST True → the shortest qualifying lag
    lag = float(min_lag + idx)

    # Parabolic interpolation for sub-sample lag accuracy, applied ONLY at a genuine maximum
    # (denom < 0, i.e. concave). A flat or convex neighbourhood makes `0.5*(a-c)/denom` explode; that
    # was previously guarded only against denom EXACTLY zero, which on real audio produced both a
    # nonsense f0 and an outright crash — `IndexError: index 659 is out of bounds for axis 0 with
    # size 640` — when the resulting lag indexed past the end of the array.
    a, b, c = nccf[idx - 1], nccf[idx], nccf[idx + 1]
    denom = a - 2.0 * b + c
    if denom < 0.0:
        shift = 0.5 * (a - c) / denom
        if -1.0 < shift < 1.0:
            lag += shift

    if lag <= 0.0:
        return 0.0, confidence
    return float(sample_rate / lag), confidence


# ── framed extraction over a whole signal ───────────────────────────────────────────


def extract_pitch_track(samples: np.ndarray, sample_rate: int, *, frame_ms: float = FRAME_MS,
                        hop_ms: float = HOP_MS, fmin: float = FMIN_HZ,
                        fmax: float = FMAX_HZ) -> list[PitchFrame]:
    """Slide a frame over `samples`, emitting one PitchFrame per hop.

    Voicing: a frame is voiced iff its RMS ≥ VOICED_RMS_FLOOR × (loudest frame RMS) AND its
    autocorrelation confidence ≥ VOICED_CORR_FLOOR. Unvoiced frames report f0/midi = 0 but are still
    emitted (so the track is a regular, gap-free time grid the scorer can align to the mic)."""
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim != 1:
        samples = samples.reshape(-1)
    frame_len = max(1, int(sample_rate * frame_ms / 1000.0))
    hop_len = max(1, int(sample_rate * hop_ms / 1000.0))
    if samples.size < frame_len:
        return []

    starts = range(0, samples.size - frame_len + 1, hop_len)

    # First pass: per-frame RMS so the voicing floor is relative to the loudest frame (robust to
    # overall clip level — a quiet recording still gets voiced frames).
    rms = []
    raw: list[tuple[int, float, float]] = []
    for s in starts:
        frame = samples[s : s + frame_len]
        r = float(np.sqrt(np.mean(frame * frame)))
        f0, conf = estimate_f0(frame, sample_rate, fmin, fmax)
        rms.append(r)
        raw.append((s, f0, conf))

    peak_rms = max(rms) if rms else 0.0
    rms_gate = peak_rms * VOICED_RMS_FLOOR

    track: list[PitchFrame] = []
    for (s, f0, conf), r in zip(raw, rms):
        voiced = r >= rms_gate and conf >= VOICED_CORR_FLOOR and f0 > 0.0
        track.append(
            PitchFrame(
                time_sec=s / sample_rate,
                f0_hz=f0 if voiced else 0.0,
                midi=hz_to_midi(f0) if voiced else 0.0,
                voiced=voiced,
                confidence=conf,
            )
        )
    return track


def median_voiced_f0(track: list[PitchFrame]) -> float:
    """Median f0 over the voiced frames of a track (0.0 if none) — a robust single-number summary
    (e.g. for a sustained-note test or a per-word pitch)."""
    voiced = [f.f0_hz for f in track if f.voiced]
    return float(np.median(voiced)) if voiced else 0.0


def pitch_track_to_artifact(track: list[PitchFrame], *, hop_ms: float = HOP_MS) -> dict[str, Any]:
    """Serialize a pitch track into the REGULAR-GRID JSON artifact the core scorer consumes.

    The grid is implicit: frame i covers time i × hopSec, so the core maps a mic sample at
    positionSec to reference index round(positionSec / hopSec) in O(1). Parallel arrays (not a list
    of objects) keep the payload compact for a whole song. Unvoiced frames carry f0/midi = 0 and
    voiced=False so the scorer can skip scoring silence/rests."""
    return {
        "hopSec": round(hop_ms / 1000.0, 4),
        "frameCount": len(track),
        "f0Hz": [round(f.f0_hz, 2) for f in track],
        "midi": [round(f.midi, 3) for f in track],
        "voiced": [bool(f.voiced) for f in track],
    }


# ── WAV reader (stdlib only — no soundfile) ─────────────────────────────────────────


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a PCM WAV as mono float64 in [-1, 1] using the stdlib `wave` module. Multi-channel audio
    is downmixed by averaging channels. Supports 16- and 32-bit PCM (Demucs writes 16-bit here)."""
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float64) / 2147483648.0
    elif sampwidth == 1:
        # 8-bit PCM is unsigned, centered at 128.
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width: {sampwidth} bytes")

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)
    return data, sample_rate
