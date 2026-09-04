"""Pitch extraction — pure autocorrelation f0 tracker. Verified in-sandbox against
SYNTHESIZED known tones (numpy only, no torch): a sine at a known frequency must come back as that
frequency; silence must come back unvoiced. This is the done-when: known tone → expected
pitch track."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import pitch_track as pt  # noqa: E402

SR = 44100


def _sine(freq: float, seconds: float, sr: int = SR, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    return amp * np.sin(2 * np.pi * freq * t)


# ── pure conversions ───────────────────────────────────────────────────────────────


def test_hz_midi_roundtrip_and_anchor():
    assert abs(pt.hz_to_midi(440.0) - 69.0) < 1e-9  # A4
    assert abs(pt.midi_to_hz(69) - 440.0) < 1e-9
    # an octave up is +12 semitones / ×2 Hz
    assert abs(pt.hz_to_midi(880.0) - 81.0) < 1e-9
    assert abs(pt.midi_to_hz(81) - 880.0) < 1e-9
    # roundtrip an arbitrary pitch
    assert abs(pt.midi_to_hz(pt.hz_to_midi(261.63)) - 261.63) < 1e-6


def test_hz_to_midi_nonpositive_is_zero():
    assert pt.hz_to_midi(0.0) == 0.0
    assert pt.hz_to_midi(-5.0) == 0.0


# ── single-frame estimation on known tones ──────────────────────────────────────────


def test_estimate_f0_on_a440():
    frame = _sine(440.0, 0.05)  # 50 ms — several cycles
    f0, conf = pt.estimate_f0(frame, SR)
    assert abs(f0 - 440.0) < 2.0  # within 2 Hz
    assert conf > 0.8  # a pure sine is highly periodic


def test_estimate_f0_tracks_different_pitches():
    for target in (110.0, 220.0, 330.0, 523.25):  # A2, A3, E4, C5
        f0, _ = pt.estimate_f0(_sine(target, 0.06), SR)
        # within a quarter-tone (~3%) — sub-sample parabolic interpolation keeps it tight
        assert abs(f0 - target) / target < 0.03, f"{target} → {f0}"


def test_estimate_f0_on_silence_is_zero():
    f0, conf = pt.estimate_f0(np.zeros(2048), SR)
    assert f0 == 0.0 and conf == 0.0


# ── framed track over a whole signal ─────────────────────────────────────────────────


def test_extract_pitch_track_sustained_note():
    track = pt.extract_pitch_track(_sine(220.0, 0.5), SR)  # sustained A3
    assert len(track) > 10
    voiced = [f for f in track if f.voiced]
    # the vast majority of a clean sustained tone's frames are voiced
    assert len(voiced) / len(track) > 0.8
    # every voiced frame sits on ~220 Hz and reports the matching MIDI (A3 = 57)
    for f in voiced:
        assert abs(f.f0_hz - 220.0) < 3.0
        assert abs(f.midi - 57.0) < 0.5
    assert abs(pt.median_voiced_f0(track) - 220.0) < 1.0


def test_extract_pitch_track_is_regular_time_grid():
    track = pt.extract_pitch_track(_sine(330.0, 0.3), SR, hop_ms=10.0)
    # frames are spaced by the hop (10 ms) and monotonic in time
    times = [f.time_sec for f in track]
    assert all(t2 > t1 for t1, t2 in zip(times, times[1:]))
    for t1, t2 in zip(times, times[1:]):
        assert abs((t2 - t1) - 0.010) < 1e-6


def test_extract_pitch_track_silence_is_unvoiced():
    track = pt.extract_pitch_track(np.zeros(SR // 2), SR)  # 0.5 s of silence
    assert len(track) > 0
    assert all(not f.voiced and f.f0_hz == 0.0 for f in track)


def test_extract_pitch_track_pitch_change():
    # first half A3 (220), second half A4 (440) — the track must follow the jump
    sig = np.concatenate([_sine(220.0, 0.3), _sine(440.0, 0.3)])
    track = pt.extract_pitch_track(sig, SR)
    first = pt.median_voiced_f0(track[: len(track) // 3])
    last = pt.median_voiced_f0(track[-len(track) // 3 :])
    assert abs(first - 220.0) < 3.0
    assert abs(last - 440.0) < 3.0


def test_extract_pitch_track_too_short_returns_empty():
    assert pt.extract_pitch_track(np.zeros(10), SR) == []


# ── WAV reader (stdlib) round-trips a synthesized tone ───────────────────────────────


def test_read_wav_mono_roundtrip(tmp_path):
    import wave

    freq, seconds = 294.0, 0.4  # ~D4
    sig = _sine(freq, seconds)
    pcm = (sig * 32767.0).astype(np.int16)
    wav_path = tmp_path / "tone.wav"
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())

    data, sr = pt.read_wav_mono(str(wav_path))
    assert sr == SR
    assert data.ndim == 1 and data.size == pcm.size
    # the decoded audio extracts back to the known pitch — full path: WAV → samples → f0
    track = pt.extract_pitch_track(data, sr)
    assert abs(pt.median_voiced_f0(track) - freq) < 2.0


def test_read_wav_mono_downmixes_stereo(tmp_path):
    import wave

    freq = 196.0  # G3
    mono = _sine(freq, 0.3)
    stereo = np.repeat((mono * 32767.0).astype(np.int16), 2)  # L=R
    wav_path = tmp_path / "stereo.wav"
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(stereo.tobytes())

    data, sr = pt.read_wav_mono(str(wav_path))
    assert data.ndim == 1 and data.size == mono.size  # channels averaged to mono
    assert abs(pt.median_voiced_f0(pt.extract_pitch_track(data, sr)) - freq) < 2.0


def test_pitch_track_to_artifact_regular_grid():
    # a real extraction serialized to the compact regular-grid artifact the core scorer consumes
    track = pt.extract_pitch_track(_sine(440.0, 0.3), SR)
    doc = pt.pitch_track_to_artifact(track)
    assert doc["hopSec"] == round(pt.HOP_MS / 1000.0, 4)  # implicit time grid: frame i @ i*hopSec
    assert doc["frameCount"] == len(track)
    # parallel arrays, one entry per frame, aligned
    assert len(doc["f0Hz"]) == len(doc["midi"]) == len(doc["voiced"]) == len(track)
    assert all(isinstance(v, bool) for v in doc["voiced"])
    # a 440 Hz tone → at least one voiced frame near 440
    assert any(v and abs(f0 - 440.0) < 10.0 for v, f0 in zip(doc["voiced"], doc["f0Hz"]))


def test_pitch_track_to_artifact_empty():
    doc = pt.pitch_track_to_artifact([])
    assert doc["frameCount"] == 0 and doc["f0Hz"] == [] and doc["voiced"] == []


# ── regression: unbounded parabolic interpolation crashed on real audio ──────────────────────────
#
# Observed on a separated vocals stem: `IndexError: index 659 is out of bounds for axis 0 with size
# 640`. A flat autocorrelation peak drives `denom` near zero, so the sub-sample correction
# `0.5*(a-c)/denom` explodes and the resulting lag indexes past the end of the array. The old guard
# only excluded denom EXACTLY zero. Two consequences, one loud and one silent: the crash, and a
# nonsense f0 feeding the reference pitch track the singer's mic is scored against.

def test_a_flat_autocorrelation_peak_does_not_crash_or_invent_a_pitch():
    import numpy as np
    from src.pitch_track import estimate_f0, extract_pitch_track

    sr = 16000
    # White noise has no periodicity, so its ACF peak is flat and noisy — the degenerate case.
    rng = np.random.default_rng(1234)
    for _ in range(200):
        frame = rng.standard_normal(640).astype(np.float32)
        f0, conf = estimate_f0(frame, sr, 70.0, 1200.0)  # must not raise
        assert 0.0 <= conf <= 1.0
        assert f0 == 0.0 or 70.0 <= f0 <= 1200.0 * 1.5, f"implausible f0 {f0}"


def test_a_real_periodic_tone_still_resolves_accurately():
    # The clamp must not cost accuracy on the case interpolation exists for.
    import numpy as np
    from src.pitch_track import estimate_f0

    sr = 16000
    for target in (196.0, 246.9, 440.0):  # see the KNOWN DEFECT below for why this starts at 196 Hz
        t = np.arange(640) / sr
        frame = np.sin(2 * np.pi * target * t).astype(np.float32)
        f0, conf = estimate_f0(frame, sr, 70.0, 1200.0)
        assert abs(f0 - target) / target < 0.05, f"{f0} vs {target}"
        assert conf > 0.5


def test_low_pitches_resolve_across_the_whole_male_vocal_range():
    """REGRESSION for the bias that made every low pitch report the fmax bound.

    The estimator used to peak-pick the RAW autocorrelation, whose acf[k] sums only the (N−k)
    overlapping products and so decays with lag — a bias that systematically favours short lags, i.e.
    high pitches. On the production framing (40 ms at 44.1 kHz) the decay beat real periodicity below
    ~147 Hz: a 110 Hz tone scored 0.818 at the fmax bound against 0.773 at its true period, so argmax
    took the bound and reported ~1230 Hz — an octave and a half high at confidence 0.84, which sails
    straight through the voicing gate. E2–C3 is the male vocal range, so a male singer was scored
    against a nonsense reference curve.

    Now normalized per lag by the two overlapping windows' energies (NCCF), so a clean tone scores
    ≈1.0 at its period however long that period is. This asserts the ENTIRE vocal range, both framings,
    because the bug's severity depended on max_lag/frame_len — a test at one rate can pass while the
    other is broken."""
    import numpy as np
    from src.pitch_track import FRAME_MS, estimate_f0

    # E2 (lowest note a bass sings) through A5 (soprano). E2–C3 is the band that was broken.
    targets = (82.41, 110.0, 130.81, 146.83, 196.0, 246.94, 440.0, 880.0)
    for sr in (44100, 16000):
        n = int(sr * FRAME_MS / 1000.0)
        for target in targets:
            t = np.arange(n) / sr
            frame = np.sin(2 * np.pi * target * t).astype(np.float32)
            f0, conf = estimate_f0(frame, sr, 70.0, 1200.0)
            assert abs(f0 - target) / target < 0.01, f"{sr} Hz: {target} → {f0}"
            # Confidence must ALSO be pitch-independent. The old estimator's confidence fell with lag,
            # so even a correct low reading would have been under-trusted by the voicing gate.
            assert conf > 0.9, f"{sr} Hz: {target} → conf {conf}"


def test_a_harmonic_rich_tone_does_not_resolve_an_octave_low():
    """A sung vowel is not a sine — it has strong harmonics, and its normalized correlation peaks just
    as high at 2× and 3× the true period as at the period itself. Plain argmax picks whichever wins on
    noise, which is how pitch trackers report octave errors. The shortest-lag-strong-peak pick
    (PEAK_PICK_RATIO) is what makes the choice deterministic and correct."""
    import numpy as np
    from src.pitch_track import estimate_f0

    sr = 44100
    n = 1764
    t = np.arange(n) / sr
    for target in (98.0, 123.47, 164.81, 220.0):  # G2, B2, E3, A3 — where octave-down errors land in range
        frame = sum(np.sin(2 * np.pi * target * k * t) / k for k in range(1, 9)).astype(np.float32)
        f0, conf = estimate_f0(frame, sr, 70.0, 1200.0)
        assert abs(f0 - target) / target < 0.02, f"{target} → {f0} (octave error?)"


def test_a_frame_too_short_for_the_requested_fmin_is_refused_not_guessed():
    """NCCF divides by the overlapping windows' energies, so at a lag near the frame length it is
    normalizing a handful of samples and noise can come back as a perfect pitch. MAX_LAG_FRACTION caps
    the search at half the frame; a caller asking for a pitch the frame cannot hold gets nothing rather
    than a confident fiction."""
    import numpy as np
    from src.pitch_track import estimate_f0

    sr = 44100
    frame = np.sin(2 * np.pi * 70.0 * np.arange(200) / sr).astype(np.float32)  # 4.5 ms — far too short
    f0, _ = estimate_f0(frame, sr, 65.0, 1175.0)
    assert f0 == 0.0 or f0 >= 65.0


def test_noise_does_not_crash_the_whole_track_extractor():
    import numpy as np
    from src.pitch_track import extract_pitch_track

    rng = np.random.default_rng(7)
    samples = rng.standard_normal(16000 * 3).astype(np.float32)
    frames = extract_pitch_track(samples, 16000)  # used to raise IndexError partway through
    assert len(frames) > 0
