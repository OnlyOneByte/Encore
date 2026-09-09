"""Guide-offset measurement (#766): the guide-alignment half of the guide feature, made observable.

These tests pin the measurement is REAL, not vacuous: they build an instrumental and a vocals stem that
is the SAME signal shifted by a KNOWN number of samples, and assert measure_guide_offset_ms recovers that
shift with the right sign and magnitude. The decisive one is `test_injected_delay_is_recovered`: it fails
if the code ignored the offset and returned 0 (or the wrong sign), which is exactly the misalignment the
guard exists to catch. The rest pin the TRI-STATE contract (a real int for a real shift, 0 for aligned
stems, None for silence / too-short / rate-mismatch / missing / unreadable), asserted against
independently-reasoned expectations, never by re-running the correlator the code uses.
"""

import os
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.analysis import guide_offset  # noqa: E402

SR = 44100


def _write_wav(path, samples, sr=SR):
    path = str(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def _broadband(seconds, seed=0):
    """A seeded broadband (noise-like) signal — a sharp autocorrelation peak, so a lag is unambiguous.
    A pure tone would correlate at every period and make the recovered lag meaningless."""
    rng = np.random.default_rng(seed)
    return rng.standard_normal(int(SR * seconds)) * 0.3


def _shift(sig, samples):
    """Shift `sig` by `samples` (positive = later, zero-padded at the front) keeping the same length."""
    if samples == 0:
        return sig.copy()
    if samples > 0:
        return np.concatenate([np.zeros(samples), sig[:-samples]])
    return np.concatenate([sig[-samples:], np.zeros(-samples)])


# -- the measurement is real: an injected delay is recovered with the right sign --


def test_injected_delay_is_recovered(tmp_path):
    # The vocals arrive 30 ms LATE relative to the instrumental (its content is shifted later in time).
    # measure_guide_offset_ms's convention: positive = the vocals LAG. So we expect ~ +30 ms, NOT 0.
    inst = _broadband(10.0, seed=1)
    delay_ms = 30
    delay_samples = round(delay_ms / 1000 * SR)
    vox = _shift(inst, delay_samples)  # vocals content sits later than the instrumental
    _write_wav(tmp_path / "inst.wav", inst)
    _write_wav(tmp_path / "vox.wav", vox)

    got = guide_offset.measure_guide_offset_ms(str(tmp_path / "vox.wav"), str(tmp_path / "inst.wav"))
    assert got is not None
    # Within one sample-period's rounding of the injected 30 ms — and crucially NOT 0, which is what a
    # measurement blind to the offset (the whole defect this guards) would report.
    assert abs(got - delay_ms) <= 1
    assert got != 0


def test_injected_lead_has_the_opposite_sign(tmp_path):
    # The mirror: vocals arrive EARLY (their content is shifted earlier). Expect a NEGATIVE offset.
    inst = _broadband(10.0, seed=2)
    lead_ms = 25
    lead_samples = round(lead_ms / 1000 * SR)
    vox = _shift(inst, -lead_samples)
    _write_wav(tmp_path / "inst.wav", inst)
    _write_wav(tmp_path / "vox.wav", vox)

    got = guide_offset.measure_guide_offset_ms(str(tmp_path / "vox.wav"), str(tmp_path / "inst.wav"))
    assert got is not None
    assert abs(got - (-lead_ms)) <= 1
    assert got < 0


def test_aligned_stems_measure_zero_not_none(tmp_path):
    # Two copies of one signal — a measured, confident 0 (distinct from an unmeasurable None). This is
    # the freshly-cooked common-FLAC case that must NOT shift the guide.
    sig = _broadband(10.0, seed=3)
    _write_wav(tmp_path / "inst.wav", sig)
    _write_wav(tmp_path / "vox.wav", sig.copy())
    got = guide_offset.measure_guide_offset_ms(str(tmp_path / "vox.wav"), str(tmp_path / "inst.wav"))
    assert got == 0


# -- tri-state: unmeasurable inputs degrade to None, never a fabricated 0 --


def test_missing_path_is_none():
    assert guide_offset.measure_guide_offset_ms(None, "x") is None
    assert guide_offset.measure_guide_offset_ms("x", None) is None


def test_silence_is_none(tmp_path):
    _write_wav(tmp_path / "sil.wav", np.zeros(SR * 3))
    _write_wav(tmp_path / "sig.wav", _broadband(3.0, seed=4))
    assert guide_offset.measure_guide_offset_ms(str(tmp_path / "sil.wav"), str(tmp_path / "sig.wav")) is None
    assert guide_offset.measure_guide_offset_ms(str(tmp_path / "sig.wav"), str(tmp_path / "sil.wav")) is None


def test_too_short_is_none(tmp_path):
    short = _broadband(0.5, seed=5)  # below _MIN_ANALYSIS_SEC
    _write_wav(tmp_path / "a.wav", short)
    _write_wav(tmp_path / "b.wav", short.copy())
    assert guide_offset.measure_guide_offset_ms(str(tmp_path / "a.wav"), str(tmp_path / "b.wav")) is None


def test_rate_mismatch_is_none(tmp_path):
    sig = _broadband(5.0, seed=6)
    _write_wav(tmp_path / "a.wav", sig, sr=44100)
    _write_wav(tmp_path / "b.wav", sig, sr=48000)
    assert guide_offset.measure_guide_offset_ms(str(tmp_path / "a.wav"), str(tmp_path / "b.wav")) is None


def test_unreadable_file_degrades_to_none_never_raises(tmp_path):
    (tmp_path / "not.wav").write_text("not a wav")
    _write_wav(tmp_path / "ok.wav", _broadband(3.0, seed=7))
    assert guide_offset.measure_guide_offset_ms(str(tmp_path / "not.wav"), str(tmp_path / "ok.wav")) is None
