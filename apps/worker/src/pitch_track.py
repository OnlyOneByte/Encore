"""Pitch extraction (M8-C1) — per-frame fundamental frequency (f0) from the isolated vocal stem.

This is the first half of SingStar-style scoring: turn a mono audio signal into a time-stamped
pitch track (Hz + MIDI + voiced flag), which M8-C3 compares against the singer's live mic pitch.

PURE + dependency-light: just numpy + the stdlib `wave` reader — NO torch, NO scipy, NO soundfile —
so the whole tracker unit-tests in-sandbox against a synthesized tone (the M7 pitch.py convention:
pure DSP split from the heavy binaries). It runs on the isolated `vocals.wav` Demucs already emits.

Algorithm: framed **autocorrelation** f0 estimation. For each analysis frame we take the linear
autocorrelation (via FFT), find the strongest lag inside the vocal-range lag window
[sr/fmax .. sr/fmin], refine it with parabolic interpolation for sub-sample accuracy, and derive
f0 = sr / lag. A frame is `voiced` only when it has enough energy AND a strong enough normalized
autocorrelation peak — silence / unpitched noise comes back `voiced=False, f0=0`.
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
    """Linear (non-circular) autocorrelation of a frame via FFT, lags 0..len-1.

    Zero-padding to ≥2N before the FFT makes the circular FFT correlation equal the linear one over
    the returned lag range (no wrap-around contamination)."""
    n = frame.size
    size = 1
    while size < 2 * n:
        size *= 2
    spec = np.fft.rfft(frame, size)
    acf = np.fft.irfft(spec * np.conjugate(spec), size)[:n]
    return acf


def estimate_f0(frame: np.ndarray, sample_rate: int, fmin: float = FMIN_HZ,
                fmax: float = FMAX_HZ) -> tuple[float, float]:
    """Estimate one frame's (f0_hz, confidence). Returns (0.0, 0.0) when no periodic peak is found.

    confidence is the autocorrelation peak height normalized by lag-0 energy (1.0 = perfectly
    periodic). The caller applies the voicing gates; this just reports the best periodicity found."""
    frame = frame.astype(np.float64)
    frame = frame - frame.mean()  # remove DC so a silent-with-offset frame doesn't read as periodic
    energy = float(np.dot(frame, frame))
    if energy <= 0.0:
        return 0.0, 0.0

    acf = _autocorrelation(frame)

    # Search only physically meaningful lags for the vocal range.
    min_lag = max(1, int(sample_rate / fmax))
    max_lag = min(frame.size - 1, int(sample_rate / fmin))
    if max_lag <= min_lag:
        return 0.0, 0.0

    window = acf[min_lag : max_lag + 1]
    peak_idx = int(np.argmax(window))
    lag = min_lag + peak_idx

    # Parabolic interpolation around the integer peak for sub-sample lag accuracy (→ accurate f0).
    if 0 < lag < frame.size - 1:
        a, b, c = acf[lag - 1], acf[lag], acf[lag + 1]
        denom = a - 2.0 * b + c
        if denom != 0.0:
            lag = lag + 0.5 * (a - c) / denom

    if lag <= 0:
        return 0.0, 0.0
    f0 = sample_rate / lag
    confidence = float(acf[int(round(lag))] / acf[0]) if acf[0] > 0 else 0.0
    confidence = max(0.0, min(1.0, confidence))
    return float(f0), confidence


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
    """Serialize a pitch track into the REGULAR-GRID JSON artifact the core scorer consumes (M8-C3).

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
