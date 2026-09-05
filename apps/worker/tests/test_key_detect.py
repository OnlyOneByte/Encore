"""Key detection — pure-numpy Krumhansl-Schmuckler over a synthesized chromagram. No audio files, no
torch: tones are generated in-memory. The bar is coarse on purpose — we assert TONIC+MODE for a clear
harmonic signal and LOW confidence for noise/silence, not exact correlation values, because the
useful contract downstream is exactly "which key, and do we believe it"."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import key_detect  # noqa: E402

SR = 22050


def _tone(midi, dur, sr=SR, *, harmonics=(1.0, 0.5, 0.25)):
    """A note as a MIDI number, with a few harmonics so its spectrum lands cleanly in one pitch class
    (a pure sine is fine too, but harmonics better resemble a real instrument's chord tone)."""
    freq = 440.0 * 2 ** ((midi - 69) / 12.0)
    t = np.arange(int(dur * sr)) / sr
    sig = np.zeros_like(t)
    for i, amp in enumerate(harmonics, start=1):
        sig += amp * np.sin(2 * np.pi * freq * i * t)
    return sig


def _chord(midis, dur, sr=SR):
    """Sum several notes into one sustained chord."""
    return sum(_tone(m, dur, sr) for m in midis)


def test_c_major_triad_progression_detects_c_major():
    # A I–IV–V–I in C major (C-E-G, F-A-C, G-B-D, C-E-G). The chromagram over the whole progression
    # is dominated by the C-major scale's tonal weights → C major.
    prog = np.concatenate([
        _chord([60, 64, 67], 1.0),  # C major
        _chord([65, 69, 72], 1.0),  # F major
        _chord([67, 71, 74], 1.0),  # G major
        _chord([60, 64, 67], 1.0),  # C major
    ])
    tonic, mode, conf = key_detect.detect_key(prog, SR)
    assert tonic == 0  # C
    assert mode == "major"
    assert conf > 0.5


def test_a_minor_triad_progression_detects_a_minor():
    # i–iv–v–i in A minor (A-C-E, D-F-A, E-G-B, A-C-E). Same pitch-class content family as C major but
    # the tonal-hierarchy correlation resolves the RELATIVE-minor tonic via the minor template.
    prog = np.concatenate([
        _chord([57, 60, 64], 1.0),  # A minor
        _chord([62, 65, 69], 1.0),  # D minor
        _chord([64, 67, 71], 1.0),  # E minor
        _chord([57, 60, 64], 1.0),  # A minor
    ])
    tonic, mode, conf = key_detect.detect_key(prog, SR)
    assert tonic == 9  # A
    assert mode == "minor"
    assert conf > 0.4


def test_g_major_scale_detects_g_major():
    # An ascending G-major scale (G A B C D E F# G) — a melodic run whose accumulated chroma still
    # favours G major's scale degrees. Confirms the tonic tracks a transposed key, not just C.
    scale = np.concatenate([_tone(m, 0.4) for m in [67, 69, 71, 72, 74, 76, 78, 79]])
    tonic, mode, conf = key_detect.detect_key(scale, SR)
    assert tonic == 7  # G
    assert mode == "major"


def test_white_noise_has_low_confidence():
    rng = np.random.default_rng(0)
    noise = rng.standard_normal(SR * 3)
    tonic, mode, conf = key_detect.detect_key(noise, SR)
    # Noise spreads energy across all pitch classes → the best key template correlates weakly. A key
    # may still be "picked" (argmax always returns something) but confidence must be low.
    assert conf is not None
    assert conf < 0.5


def test_silence_returns_all_none():
    tonic, mode, conf = key_detect.detect_key(np.zeros(SR * 2), SR)
    assert (tonic, mode, conf) == (None, None, None)


def test_empty_signal_returns_all_none():
    tonic, mode, conf = key_detect.detect_key(np.array([]), SR)
    assert (tonic, mode, conf) == (None, None, None)


def test_confidence_is_normalized_zero_to_one():
    prog = _chord([60, 64, 67], 3.0)  # a sustained C major chord
    _, _, conf = key_detect.detect_key(prog, SR)
    assert 0.0 <= conf <= 1.0


def test_chromagram_of_silence_is_all_zero():
    chroma = key_detect.chromagram(np.zeros(SR), SR)
    assert chroma.shape == (12,)
    assert chroma.sum() == 0.0


def test_key_from_empty_chroma_is_none():
    assert key_detect.key_from_chroma(np.zeros(12)) == (None, None, None)


def test_key_name_labels_and_handles_none():
    assert key_detect.key_name(9, "minor") == "A minor"
    assert key_detect.key_name(0, "major") == "C major"
    assert key_detect.key_name(None, None) is None


def test_single_sustained_pitch_class_is_ambiguous_but_scored():
    # A single held C sounded alone gives energy in exactly one pitch class. Both a C-major and a
    # C-minor (and their relatives) share C, so this is genuinely ambiguous — assert only that it
    # returns a concrete, in-range result rather than crashing or returning None.
    tonic, mode, conf = key_detect.detect_key(_tone(60, 3.0), SR)
    assert tonic is not None and 0 <= tonic <= 11
    assert mode in ("major", "minor")
